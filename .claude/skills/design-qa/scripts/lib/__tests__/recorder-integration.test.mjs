/**
 * Integration test — recorder + redaction end-to-end against a real Playwright
 * context (no session/HTTP/UI involvement).
 *
 * What this proves:
 *   1. attachRecorder() against launchPersistentContext sees real human-style
 *      mouse/keyboard events and produces structured events.
 *   2. Filling a labeled password field registers the value in the redactor
 *      and DOES NOT leak the plaintext into ANY emitted event (action.text,
 *      code, or ariaSnapshot).
 *   3. Emitted `.ts` `code` substitutes to `process.env.DESIGN_QA_FIELD_PASSWORD`.
 *
 * Run: `node --test scripts/lib/__tests__/recorder-integration.test.mjs`
 * (Has Playwright as a peer; tests are skipped if it can't import.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachRecorder } from '../recorder.mjs';
import { createRedactor } from '../redact.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FAKE_PASSWORD = 'INTEG_SECRET_pw_DO_NOT_LEAK_99x';

/** Try to import Playwright. Returns null if unavailable so the suite can skip
 *  rather than fail in environments without playwright installed. */
async function loadChromium() {
  try {
    const pw = await import('playwright');
    return pw.chromium;
  } catch {
    return null;
  }
}

/** Click a center-anchored point on an element selected by CSS. Uses CDP-level
 *  mouse events so the recorder's in-page script sees real input, not a
 *  Playwright API call (which it ignores). */
async function clickCenter(page, css) {
  const handle = await page.$(css);
  if (!handle) throw new Error(`element not found: ${css}`);
  const box = await handle.boundingBox();
  if (!box) throw new Error(`no bounding box for ${css}`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

test('recorder + redaction: fake login form does not leak password', async (t) => {
  const chromium = await loadChromium();
  if (!chromium) {
    t.skip('playwright not installed');
    return;
  }

  // Per-test profile so reruns don't inherit recorder state from a prior run.
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'dqa-recorder-test-'));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      headless: true,
      viewport: { width: 1280, height: 800 },
      args: ['--no-first-run', '--no-default-browser-check'],
    });

    const redactor = createRedactor();
    const recorder = await attachRecorder(context, { redactor, headless: true });

    const page = context.pages()[0] || await context.newPage();

    // Minimal login form. The labels give the recorder semantic `name`s that
    // surface in its internal selectors as `[name="…"]` — exactly the shape
    // the redactor's regex looks for. The password field also has an explicit
    // `name="password"` attribute as a belt-and-suspenders.
    await page.setContent(`
      <!doctype html><html><body>
        <h1>Sign in</h1>
        <label>Email address <input id="email" name="email" type="email" aria-label="Email address"></label>
        <br>
        <label>Password <input id="pw" name="password" type="password" aria-label="Password"></label>
        <br>
        <button id="submit">Sign in</button>
      </body></html>
    `);

    // Drive the form with CDP-level events so the recorder picks them up.
    await clickCenter(page, '#email');
    await page.keyboard.type('andrew@example.com');
    await page.waitForTimeout(120);

    await clickCenter(page, '#pw');
    await page.keyboard.type(FAKE_PASSWORD);
    await page.waitForTimeout(120);

    await clickCenter(page, '#submit');
    await page.waitForTimeout(300);

    recorder.stop();

    // --- Assertions ---

    // (a) Events captured at all.
    assert.ok(recorder.events.length > 0,
      `expected events captured, got ${recorder.events.length}`);

    // (b) Redactor registered the password.
    assert.ok(redactor.count >= 1,
      `expected at least one secret registered, got ${redactor.count}`);
    assert.ok(redactor.getEnvVars().includes('DESIGN_QA_FIELD_PASSWORD'),
      `expected DESIGN_QA_FIELD_PASSWORD in env vars, got ${redactor.getEnvVars().join(', ')}`);

    // (c) Emitted .ts `code` substitutes the env var. (Concatenate every code
    // snippet captured — that's the shape 9e's emitter will produce.)
    const emittedCode = recorder.events.map((e) => e.code || '').join('\n');
    assert.ok(emittedCode.includes("process.env.DESIGN_QA_FIELD_PASSWORD ?? ''"),
      `expected code to contain process.env.DESIGN_QA_FIELD_PASSWORD substitution:\n${emittedCode}`);

    // (d) ZERO occurrences of the password value anywhere in the event log.
    // This is the bar that justifies redaction landing with the recorder.
    const fullDump = JSON.stringify(recorder.events);
    const leakCount = fullDump.split(FAKE_PASSWORD).length - 1;
    assert.equal(leakCount, 0,
      `password value leaked ${leakCount} time(s) in event JSON`);
  } finally {
    if (context) try { await context.close(); } catch { /* noop */ }
    try { await fs.rm(profile, { recursive: true, force: true }); } catch { /* noop */ }
  }
});
