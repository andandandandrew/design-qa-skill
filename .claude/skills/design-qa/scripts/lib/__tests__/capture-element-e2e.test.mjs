/**
 * Spike 12 — element capture, end-to-end through the production wiring.
 *
 * Drives `attachCapture` (real headless Chromium, no overlay UI), calls the
 * `__designQA_ensureView` + `__designQA_createElement` bindings as the overlay
 * would (with a page-px box captured from a real element), seals via
 * `__designQA_sealCurrentView`, and asserts the box normalized to a canonical
 * %-`element.bounds` against the screenshot.
 *
 * (The pick-under-veil hit-test + descriptor are proven by the throwaway
 * spike12-poc; this test exercises the binding → store → seal vertical.)
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
const FIXTURE = path.join(__dirname, '_fixtures', 'element.html');

test('element capture — e2e: createElement binding → seal → %-bounds', async () => {
  await fs.mkdir(path.dirname(FIXTURE), { recursive: true });
  await fs.writeFile(FIXTURE,
    '<!doctype html><html><body style="margin:0;height:1200px;background:#f4f5f7">' +
    '<button data-testid="cta" aria-label="Create new project" ' +
    'style="position:absolute;left:120px;top:80px;width:200px;height:40px">New</button>' +
    '</body></html>', 'utf8');

  const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dqa-el-e2e-'));
  const screenshotsDir = path.join(sessionDir, 'screenshots');
  const browserProfile = path.join(sessionDir, 'browser-profile');
  await fs.mkdir(screenshotsDir, { recursive: true });
  await fs.mkdir(browserProfile, { recursive: true });
  const doc = emptySession({ id: 'sess_el_e2e', name: 'el-e2e', sessionDir, author: { name: 'Tester', email: null } });
  await writeSession(sessionDir, doc);
  const store = await SessionStore.load(sessionDir);

  let capture;
  try {
    capture = await attachCapture(store, {
      sessionDir, screenshotsDir, browserProfile,
      overlayInjectPath: null, log: () => {}, headless: true, injectOverlay: false,
    });
    await new Promise((r) => setTimeout(r, 100));
    const ctx = capture.contextForTests;
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto(`file://${FIXTURE}`);
    await page.waitForSelector('[data-testid="cta"]');
    const url = page.url();

    const ensured = await page.evaluate((u) => window.__designQA_ensureView({
      url: u, title: 'El', viewport: { width: 1280, height: 800 },
    }), url);

    // The overlay would compute this box from getBoundingClientRect + scroll;
    // here we read it the same way and hand it to the binding.
    const boxPx = await page.evaluate(() => {
      const r = document.querySelector('[data-testid="cta"]').getBoundingClientRect();
      return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height };
    });
    const created = await page.evaluate((args) => window.__designQA_createElement(args), {
      viewId: ensured.viewId, boxPx,
      name: 'Create new project', descriptor: { tag: 'button', testId: 'cta', text: 'New' },
      note: 'use the secondary style here',
    });
    assert.ok(created.pinId);

    let view = store.findViewById(ensured.viewId);
    assert.equal(view.pins[0].type, 'element');
    assert.ok(view.pins[0].boxPx, 'boxPx held pre-seal');
    assert.equal(view.pins[0].element.bounds, undefined);

    await page.evaluate((u) => window.__designQA_sealCurrentView({ url: u }), url);
    await new Promise((r) => setTimeout(r, 100));

    view = store.findViewById(ensured.viewId);
    assert.ok(view.sealedAt && view.screenshot);
    await fs.access(path.join(sessionDir, view.screenshot));

    const rec = view.pins[0];
    assert.equal(rec.boxPx, undefined, 'working box dropped at seal');
    const b = rec.element.bounds;
    // x/w use the known viewportWidth denominator → assert exactly. y/h use the
    // full-page docHeightCss (a fullPage screenshot taller than the viewport),
    // so only range-check here; the exact y math is covered by session-element.
    assert.ok(Math.abs(b.xPct - (120 / 1280) * 100) < 0.1, `xPct=${b.xPct}`);
    assert.ok(Math.abs(b.wPct - (200 / 1280) * 100) < 0.1, `wPct=${b.wPct}`);
    assert.ok(b.yPct > 0 && b.yPct < 50, `yPct in (0,50): ${b.yPct}`);
    assert.ok(b.hPct > 0 && b.hPct < 50, `hPct in (0,50): ${b.hPct}`);
    for (const k of ['xPct', 'yPct', 'wPct', 'hPct']) assert.ok(b[k] >= 0 && b[k] <= 100);
    assert.equal(rec.element.name, 'Create new project');
    assert.ok(typeof rec.xPct === 'number' && typeof rec.yPct === 'number');
  } finally {
    if (capture) {
      try { await capture.finalizeActiveViews(); } catch { /* noop */ }
      try { await capture.close(); } catch { /* noop */ }
    }
    try { await fs.rm(sessionDir, { recursive: true, force: true }); } catch { /* noop */ }
  }
});
