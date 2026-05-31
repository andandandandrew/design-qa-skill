/**
 * Spike 11 — console draw-tool capture-UI smoke (headless Chromium).
 *
 * The existing capture-*-e2e tests drive the overlay's __designQA_* bindings via
 * page.evaluate; nothing exercises the CONSOLE canvas draw tool as a real user
 * gesture. This serves the buildless console statically (→ MemoryStore fixture,
 * no live server), toggles the Draw tool (#drawBtn), drags a stroke on the
 * .draw-capture layer, types the required note, submits, and asserts exactly one
 * `drawing` rendered, draw mode cleared, and no page errors.
 *
 * Anti-flake notes (lessons from the throwaway smoke): the .draw-capture box is
 * re-read live right before the drag (renders/scroll can move it), and the
 * fixture's first view is sealed (createApp auto-selects views[0]) so the canvas
 * isn't live-locked and .screenshot-wrapper renders.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONSOLE_DIR = path.join(__dirname, '..', '..', 'console');

const MIME = {
  '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
};

/** Minimal static server for console/ on an ephemeral port (mirrors _serve.mjs
 *  but binds :0 to avoid fixed-port flakiness). Path-traversal guarded. */
function startStatic(root) {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    const rel = url === '/' ? 'index.html' : url.replace(/^\/+/, '');
    const file = path.join(root, rel);
    if (!file.startsWith(root + path.sep) && file !== root) { res.writeHead(403).end('forbidden'); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(buf);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

test('console draw tool — stroke + required note renders one drawing', async () => {
  const { server, port } = await startStatic(CONSOLE_DIR);
  const browser = await chromium.launch({ headless: true });
  const pageErrors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    // Uncaught JS exceptions are always a real fault. Resource-load 404s are
    // expected here — createStore() probes /api/session (absent under the static
    // server) and falls back to the MemoryStore fixture — so they're filtered.
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !/Failed to load resource.*\b404\b/.test(msg.text())) {
        pageErrors.push(msg.text());
      }
    });

    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });

    // MemoryStore fixture loaded; first view auto-selected + sealed → drawable.
    await page.waitForSelector('.view-item');
    await page.waitForSelector('.screenshot-wrapper');
    // No drawings in the fixture (all text pins).
    assert.equal(await page.locator('.comment-crumb-kind', { hasText: 'Drawing' }).count(), 0);

    // Enter draw mode; the capture layer mounts over the screenshot.
    await page.click('#drawBtn');
    const capture = page.locator('.draw-capture');
    await capture.waitFor({ state: 'visible' });

    // Re-read the live box right before dragging (anti-staleness), then draw a
    // multi-point stroke (≥2 points so it's kept, not dropped as a click).
    const box = await capture.boundingBox();
    assert.ok(box, '.draw-capture has a box');
    const x0 = box.x + box.width * 0.3, y0 = box.y + box.height * 0.3;
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    await page.mouse.move(x0 + 60, y0 + 40, { steps: 6 });
    await page.mouse.move(x0 + 120, y0 + 90, { steps: 6 });
    await page.mouse.up();

    // Composer opens anchored to the stroke bbox; note is required to commit.
    const field = page.locator('.cmt-card.composer textarea.cmt-field');
    await field.waitFor({ state: 'visible' });
    await field.fill('circle this header');
    await field.press('Enter');

    // Exactly one drawing now renders (sidebar card kindLabel = "Drawing"), and
    // draw mode cleared (.draw-capture removed).
    await page.waitForSelector('.draw-capture', { state: 'detached' });
    await page.locator('.comment-crumb-kind', { hasText: 'Drawing' }).first().waitFor();
    assert.equal(await page.locator('.comment-crumb-kind', { hasText: 'Drawing' }).count(), 1, 'one drawing card');
    // And the on-canvas SVG overlay for the drawing exists.
    assert.ok(await page.locator('.screenshot-wrapper svg path').count() >= 1, 'drawing SVG path rendered on canvas');

    assert.deepEqual(pageErrors, [], 'no page errors during the draw flow');
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
});
