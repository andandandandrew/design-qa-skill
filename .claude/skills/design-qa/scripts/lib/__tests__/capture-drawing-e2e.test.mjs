/**
 * Spike 11 — drawing capture, end-to-end through the production wiring.
 *
 * Drives `attachCapture` against a real headless Chromium (no overlay UI), calls
 * the `__designQA_ensureView` + `__designQA_createDrawing` bindings as the
 * overlay would, then seals via `__designQA_sealCurrentView`. Asserts on the
 * live store that the px strokes normalized to a canonical %-`shape` against the
 * captured screenshot, and that a screenshot file was written.
 *
 * (Overlay-not-baked is proven by the throwaway spike11-poc and the capture-mode
 * `.draw-ink` hide rule; this test exercises the binding → store → seal vertical.)
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
const TALL_FIXTURE = path.join(__dirname, '_fixtures', 'tall.html');

test('drawing capture — e2e: createDrawing binding → seal → %-shape', async () => {
  await fs.mkdir(path.dirname(TALL_FIXTURE), { recursive: true });
  await fs.writeFile(TALL_FIXTURE,
    '<!doctype html><html><body style="margin:0;height:1600px;background:#eef">' +
    '<h1>Tall fixture</h1></body></html>', 'utf8');

  const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dqa-draw-e2e-'));
  const screenshotsDir = path.join(sessionDir, 'screenshots');
  const browserProfile = path.join(sessionDir, 'browser-profile');
  await fs.mkdir(screenshotsDir, { recursive: true });
  await fs.mkdir(browserProfile, { recursive: true });
  const doc = emptySession({ id: 'sess_draw_e2e', name: 'draw-e2e', sessionDir, author: { name: 'Tester', email: null } });
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
    await page.goto(`file://${TALL_FIXTURE}`);
    await page.waitForSelector('h1');
    const url = page.url();

    // Overlay flow: ensureView, then createDrawing with two strokes in page-px
    // doc coords. Second stroke includes a collinear interior point RDP drops.
    const ensured = await page.evaluate((u) => window.__designQA_ensureView({
      url: u, title: 'Tall', viewport: { width: 1280, height: 800 },
    }), url);
    assert.ok(ensured.viewId);

    const created = await page.evaluate((args) => window.__designQA_createDrawing(args), {
      viewId: ensured.viewId,
      pathsPx: [[[100, 120], [200, 240]], [[300, 360], [350, 410], [400, 460]]],
      note: 'circle this header',
    });
    assert.ok(created.pinId, 'createDrawing returns a record id');

    // Pre-seal: record holds working px + no %-shape yet; a baseline screenshot
    // exists (first feedback captures immediately).
    let view = store.findViewById(ensured.viewId);
    assert.equal(view.pins.length, 1);
    assert.equal(view.pins[0].type, 'drawing');
    assert.ok(Array.isArray(view.pins[0].pathsPx));
    assert.equal(view.pins[0].shape, undefined);

    // Seal the view (the overlay's Done / Save path) → normalize to %-shape.
    await page.evaluate((u) => window.__designQA_sealCurrentView({ url: u }), url);
    await new Promise((r) => setTimeout(r, 100));

    view = store.findViewById(ensured.viewId);
    assert.ok(view.sealedAt, 'view sealed');
    assert.ok(view.screenshot, 'screenshot recorded on the view');
    await fs.access(path.join(sessionDir, view.screenshot)); // file exists

    const rec = view.pins[0];
    assert.equal(rec.pathsPx, undefined, 'working px dropped at seal');
    assert.equal(rec.shape.kind, 'path');
    assert.equal(rec.shape.paths.length, 2, 'both strokes preserved as sub-paths');
    assert.equal(rec.shape.paths[1].length, 2, 'collinear interior point simplified away');
    for (const stroke of rec.shape.paths) {
      for (const [x, y] of stroke) {
        assert.ok(x >= 0 && x <= 100 && y >= 0 && y <= 100, `coord ${x},${y} within 0..100`);
      }
    }
    assert.ok(typeof rec.xPct === 'number' && typeof rec.yPct === 'number', 'centroid set');
  } finally {
    if (capture) {
      try { await capture.finalizeActiveViews(); } catch { /* noop */ }
      try { await capture.close(); } catch { /* noop */ }
    }
    try { await fs.rm(sessionDir, { recursive: true, force: true }); } catch { /* noop */ }
  }
});
