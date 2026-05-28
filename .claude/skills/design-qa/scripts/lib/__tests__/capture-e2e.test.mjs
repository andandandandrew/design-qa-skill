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

    // --- 3. Navigate to second fixture → triggers framenavigated → seal ---
    await page.goto(`file://${NAV_TARGET}`);
    await page.waitForSelector('#q');
    // framenavigated handler is async; give it a tick.
    await page.waitForTimeout(300);
    const sealedView = store.doc.views.find((v) => v.id === ensured.viewId);
    assert.ok(sealedView.sealedAt, 'view should be sealed after navigation');

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
