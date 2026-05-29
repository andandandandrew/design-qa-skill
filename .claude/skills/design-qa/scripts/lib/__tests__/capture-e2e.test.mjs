/**
 * End-to-end test of the Spike-8 capture pipeline.
 *
 * Drives the production `attachCapture` against a real Chromium (headless +
 * no overlay UI), simulates a reviewer typing into a labeled-password login
 * form, then triggers the Mark-start / ensureView / createPin bindings as if
 * the overlay had called them. Asserts on the on-disk `session.json` that:
 *
 *   1. Pre-Mark-start fills route to `doc.preconditionSteps[]`.
 *   2. The canary password value appears in ZERO places anywhere in the doc.
 *   3. The redaction substitution (`process.env.DESIGN_QA_FIELD_PASSWORD`) is
 *      present in the persisted code snippets.
 *   4. Post-Mark-start events on a URL with a created view route to
 *      `view.steps[]`.
 *   5. `framenavigated` seals the view and the buffer drains cleanly.
 *
 * Closes the gap between the 9a unit/integration coverage (recorder + redactor
 * in isolation) and the 9b store mutations (also in isolation) — this exercises
 * the wiring in `lib/capture.mjs` itself.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionStore, emptySession, writeSession } from '../session.mjs';
import { attachCapture } from '../capture.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CANARY_PASSWORD = 'E2E_LEAK_CANARY_xyz_99';
const FIXTURE_PATH = path.join(__dirname, '_fixtures', 'login.html');
const NAV_TARGET = path.join(__dirname, '_fixtures', 'second.html');

/** Click the geometric center of an element by CSS selector via CDP-level
 *  mouse events — the recorder's in-page script needs real input, not API. */
async function clickCenter(page, css) {
  const handle = await page.$(css);
  if (!handle) throw new Error(`element not found: ${css}`);
  const box = await handle.boundingBox();
  if (!box) throw new Error(`no bounding box for ${css}`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function ensureFixtures() {
  await fs.mkdir(path.dirname(FIXTURE_PATH), { recursive: true });
  await fs.writeFile(FIXTURE_PATH, `
<!doctype html><html><body>
<h1>Test login</h1>
<label>Email <input id="email" name="email" type="email" aria-label="Email address"></label><br>
<label>Password <input id="pw" name="password" type="password" aria-label="Password"></label><br>
<button id="submit">Sign in</button>
</body></html>`, 'utf8');
  await fs.writeFile(NAV_TARGET, `
<!doctype html><html><body>
<h1>Second page</h1>
<input id="q" name="query" aria-label="Search query">
</body></html>`, 'utf8');
}

test('capture pipeline — e2e: redaction + routing + seal-on-nav', async () => {
  await ensureFixtures();

  // Temp sessionDir with the standard subdir layout.
  const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dqa-cap-e2e-'));
  const screenshotsDir = path.join(sessionDir, 'screenshots');
  const browserProfile = path.join(sessionDir, 'browser-profile');
  await fs.mkdir(screenshotsDir, { recursive: true });
  await fs.mkdir(browserProfile, { recursive: true });

  // Empty v4 session.
  const doc = emptySession({
    id: 'sess_e2e', name: 'e2e', sessionDir,
    author: { name: 'Tester', email: null },
    project: 'E2E', stack: 'Web', captureMode: 'browser',
  });
  await writeSession(sessionDir, doc);
  const store = await SessionStore.load(sessionDir);

  let capture;
  try {
    capture = await attachCapture(store, {
      sessionDir,
      screenshotsDir,
      browserProfile,
      overlayInjectPath: null, // unused when injectOverlay:false
      log: () => {},
      headless: true,
      injectOverlay: false,
    });

    // Get the launched context's first page (launchPersistentContext starts
    // with one). attachCapture exposes neither the context nor pages directly;
    // we reach in via the same `context.on('page')` path — but for the test
    // we drive the about:blank page already there.
    // Simplest: use `store.subscribe` is overkill; instead use a small helper
    // — the capture handle is opaque, so we need to reach the context.
    // Add a 1-frame delay so the recorder's init binding lands.
    await new Promise((r) => setTimeout(r, 100));

    // Reach into the launched context. attachCapture doesn't expose it directly
    // (production doesn't need to), but we can ask the recorder's redactor — no,
    // that's also opaque. Workable path: re-launch isn't an option (would race
    // the browser-profile lock). So extend attachCapture's return surface in the
    // test by reading it via a temporary global. Cleaner alternative: have
    // `capture` expose `__contextForTests` only when injectOverlay:false. For
    // now: open a new page via the manual approach below.
    //
    // Actually the simplest viable path is to use Playwright directly to attach
    // to the SAME profile, but launchPersistentContext locks the profile —
    // can't open twice.
    //
    // Solution: pages() are accessible via capture.pageCount() only. The
    // simplest fix is to add a `pages()` accessor (or `firstPage()`) to the
    // capture handle. Below, we expect that accessor to exist.

    const ctx = capture.contextForTests;
    if (!ctx) throw new Error('test affordance contextForTests missing on capture handle');

    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto(`file://${FIXTURE_PATH}`);
    await page.waitForSelector('#email');

    // Install a spy for Node→shadow recorder-state pushes. The production
    // overlay would register `window.__designQA_setRecorderState`; here we
    // register a test stand-in that records every state object pushed.
    await page.evaluate(() => {
      window.__pushes = [];
      window.__designQA_setRecorderState = (s) => { window.__pushes.push(s); };
    });

    // --- 1. Pre-Mark-start: type email + canary password + click submit ---
    await clickCenter(page, '#email');
    await page.keyboard.type('andrew@example.com');
    await page.waitForTimeout(120);

    await clickCenter(page, '#pw');
    await page.keyboard.type(CANARY_PASSWORD);
    await page.waitForTimeout(120);

    await clickCenter(page, '#submit');
    await page.waitForTimeout(200);

    // Pre-Mark-start: every fill landed in preconditionSteps.
    const fills = (store.doc.preconditionSteps || []).filter((s) => s.kind === 'fill');
    assert.ok(fills.length >= 2, `expected ≥2 fills in preconditions, got ${fills.length}`);
    // Canary nowhere.
    let dump = JSON.stringify(store.doc);
    assert.equal(dump.split(CANARY_PASSWORD).length - 1, 0,
      'canary password leaked into session doc');
    // Substitution present.
    assert.ok(dump.includes('process.env.DESIGN_QA_FIELD_PASSWORD'),
      'expected DESIGN_QA_FIELD_PASSWORD substitution in persisted code');
    // No view yet — we haven't pinned.
    assert.equal(store.doc.views.length, 0, 'no view should exist pre-pin');

    // --- 2. Mark-start, create a view, pin, type more ---
    const mark = await page.evaluate(() => window.__designQA_markStart());
    assert.equal(mark.ok, true);
    assert.equal(typeof mark.recordingStartAt, 'number');
    assert.equal(store.doc.recordingStartAt, mark.recordingStartAt);

    // Simulate the overlay's "user dropped a pin" flow.
    const fileUrl = page.url();
    const ensured = await page.evaluate(([url, title]) => window.__designQA_ensureView({
      url, title, viewport: { width: 1280, height: 800 },
    }), [fileUrl, 'Login']);
    assert.ok(ensured.viewId);
    assert.equal(ensured.isNew, true);

    await page.evaluate((viewId) => window.__designQA_createPin({
      viewId, x: 100, y: 100, note: 'test pin',
    }), ensured.viewId);

    // Type a benign thing post-Mark-start, post-pin.
    await clickCenter(page, '#email');
    await page.keyboard.press('End');
    await page.keyboard.type(' (post-mark)');
    await page.waitForTimeout(200);

    // View should now hold post-Mark-start steps.
    const view = store.doc.views.find((v) => v.id === ensured.viewId);
    assert.ok(view, 'view should exist after ensureView');
    assert.equal(view.pins.length, 1);
    assert.ok(view.steps.length >= 1, `expected ≥1 post-mark step in view, got ${view.steps.length}`);
    // Every view step's t is ≥ recordingStartAt (retroactive trim invariant).
    for (const s of view.steps) {
      assert.ok(typeof s.t !== 'number' || s.t >= store.doc.recordingStartAt,
        `view step t=${s.t} is < recordingStartAt=${store.doc.recordingStartAt}`);
    }

    // --- 2b. Node→shadow push delivered with active=true + a count ---
    // The push is throttled (200ms); give it a beat to land.
    await page.waitForTimeout(350);
    const pushes = await page.evaluate(() => window.__pushes || []);
    assert.ok(pushes.length >= 1, `expected ≥1 push, got ${pushes.length}`);
    const lastPush = pushes[pushes.length - 1];
    assert.equal(lastPush.active, true);
    assert.equal(typeof lastPush.startedAtMs, 'number');
    assert.ok(lastPush.count >= 1, `expected count ≥ 1 in last push, got ${lastPush.count}`);
    // redactionCount comes from the redactor — at least 1 (the canary password
    // was a labeled secret).
    assert.ok(lastPush.redactionCount >= 1,
      `expected redactionCount ≥ 1 in push, got ${lastPush.redactionCount}`);

    // --- 2c. __designQA_fetchRecorderSteps returns the expected shape ---
    const fetched = await page.evaluate(() => window.__designQA_fetchRecorderSteps());
    assert.ok(Array.isArray(fetched.steps));
    assert.ok(fetched.steps.length >= 1, 'expected ≥1 step from fetch');
    assert.equal(typeof fetched.preconditionCount, 'number');
    assert.equal(typeof fetched.redactionCount, 'number');
    for (const s of fetched.steps) {
      assert.equal(typeof s.id, 'string');
      assert.equal(typeof s.kind, 'string');
      assert.equal(typeof s.humanText, 'string');
      assert.ok(s.humanText.length > 0, 'humanText should not be empty');
    }
    // Each humanText must not contain the canary value either.
    const fetchedDump = JSON.stringify(fetched);
    assert.equal(fetchedDump.split(CANARY_PASSWORD).length - 1, 0,
      'fetchRecorderSteps response leaked the canary password');

    // --- 2d. __designQA_stopRecording = FINALIZE-KEEP (9f) ------------------
    // Reconciled meaning: lock the recorded path, KEEP view.steps where they
    // are, stamp recordingDoneAt, leave recordingStartAt intact. The chip rests
    // but the engineer-facing path survives. (NOT the old dump-to-preconditions.)
    const preCountBefore = (store.doc.preconditionSteps || []).length;
    const keptStepCount = view.steps.length;
    const startAtBefore = store.doc.recordingStartAt;
    const fin = await page.evaluate(() => window.__designQA_stopRecording());
    assert.equal(fin.ok, true);
    assert.equal(store.doc.recordingStartAt, startAtBefore,
      'finalize must keep recordingStartAt (the precondition boundary survives)');
    assert.equal(typeof store.doc.recordingDoneAt, 'number',
      'finalize must stamp recordingDoneAt');
    assert.equal(view.steps.length, keptStepCount,
      'finalize must KEEP view.steps (the recorded path), not dump them');
    assert.equal((store.doc.preconditionSteps || []).length, preCountBefore,
      'finalize must not move steps into preconditions');
    // Push should have delivered active=false (chip rests though steps survive).
    await page.waitForTimeout(350);
    let pushesNow = await page.evaluate(() => window.__pushes || []);
    assert.equal(pushesNow[pushesNow.length - 1].active, false,
      'finalize should push active=false');

    // --- 2d-bis. __designQA_discardRecording = throw-away (9f) --------------
    // The explicit dump: view.steps move back to preconditions as hints, BOTH
    // recording markers clear. This is the old stopRecording behavior, now its
    // own action.
    const dis = await page.evaluate(() => window.__designQA_discardRecording());
    assert.equal(dis.ok, true);
    assert.equal(store.doc.recordingStartAt, null, 'discard clears recordingStartAt');
    assert.equal(store.doc.recordingDoneAt, null, 'discard clears recordingDoneAt');
    assert.equal((store.doc.preconditionSteps || []).length,
      preCountBefore + keptStepCount,
      'discard should move the kept view.steps into preconditions');
    assert.equal(view.steps.length, 0, 'view.steps should be empty after discard');
    await page.waitForTimeout(350);
    pushesNow = await page.evaluate(() => window.__pushes || []);
    assert.equal(pushesNow[pushesNow.length - 1].active, false,
      'discard should push active=false');

    // --- 3. Navigate to second fixture → triggers framenavigated → seal ---
    await page.goto(`file://${NAV_TARGET}`);
    await page.waitForSelector('#q');
    // framenavigated handler is async; give it a tick.
    await page.waitForTimeout(300);
    const sealedView = store.doc.views.find((v) => v.id === ensured.viewId);
    assert.ok(sealedView.sealedAt, 'view should be sealed after navigation');

    // --- 3b. Bug regression (2026-05-28): nav-without-pin during active
    // recording must NOT lose the captured segment. Earlier code discarded
    // the per-URL segmentBuffer on framenavigated when no view existed for
    // the old URL — meaning the user could press Mark-start, do work, and
    // navigate to find every step had vanished. Fix: materialize a sealed
    // steps-only view so the .ts emitter still sees the segment.
    {
      // Re-arm recording for this case. (discardRecording above cleared it.)
      const mark2 = await page.evaluate(() => window.__designQA_markStart());
      assert.equal(mark2.ok, true);

      // We're already on NAV_TARGET (the second fixture). Do some recordable
      // input WITHOUT calling ensureView / createPin so no view materializes
      // for this URL.
      await clickCenter(page, '#q');
      await page.keyboard.type('hello');
      await page.waitForTimeout(120);

      // Confirm no view exists yet for NAV_TARGET (the seal-on-nav from the
      // first part sealed Login; the second page has nothing pinned).
      const navUrl = page.url();
      const beforeNav = store.doc.views.filter((v) => v.url === navUrl);
      assert.equal(beforeNav.length, 0,
        'precondition: NAV_TARGET should have no view yet');

      // Navigate back to LOGIN — framenavigated on the second page fires.
      await page.goto(`file://${FIXTURE_PATH}`);
      await page.waitForSelector('#email');
      await page.waitForTimeout(300);

      // The segment we captured on NAV_TARGET must now live in a sealed
      // steps-only view, not be discarded.
      const afterNav = store.doc.views.filter((v) => v.url === navUrl);
      assert.equal(afterNav.length, 1,
        `expected 1 sealed steps-only view for ${navUrl} after nav, got ${afterNav.length}`);
      const stepsOnlyView = afterNav[0];
      assert.ok(stepsOnlyView.sealedAt, 'steps-only view should be sealed at birth');
      assert.equal(stepsOnlyView.pins.length, 0, 'steps-only view should have no pins');
      assert.ok(Array.isArray(stepsOnlyView.steps) && stepsOnlyView.steps.length > 0,
        `steps-only view should preserve captured steps, got ${stepsOnlyView.steps?.length} steps`);
      // The "hello" fill should be reachable — it's why we kept the segment.
      const dump2 = JSON.stringify(stepsOnlyView.steps);
      assert.ok(dump2.includes('hello'),
        `expected captured 'hello' fill to be preserved in steps-only view, got steps: ${dump2.slice(0, 400)}`);
    }

    // --- 4. Final canary sweep on disk ---
    const onDisk = await fs.readFile(path.join(sessionDir, 'session.json'), 'utf8');
    assert.equal(onDisk.split(CANARY_PASSWORD).length - 1, 0,
      'on-disk session.json contains the canary password');
    assert.ok(onDisk.includes('DESIGN_QA_FIELD_PASSWORD'),
      'on-disk session.json missing DESIGN_QA_FIELD_PASSWORD');
  } finally {
    if (capture) {
      try { await capture.finalizeActiveViews(); } catch { /* noop */ }
      try { await capture.close(); } catch { /* noop */ }
    }
    try { await fs.rm(sessionDir, { recursive: true, force: true }); } catch { /* noop */ }
  }
});
