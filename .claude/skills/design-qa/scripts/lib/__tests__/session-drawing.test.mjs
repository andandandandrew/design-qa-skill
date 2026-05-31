/**
 * Spike 11 — drawing feedback record: creation guards + seal-time px→% shape
 * normalization. Exercises the SAME seal path pins ride (SessionStore.sealView
 * → normalizeViewPins), so a drawing is canonical %-at-rest after seal.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionStore, emptySession, writeSession } from '../session.mjs';

/** Smallest buffer pngDimensions() can read: PNG sig + IHDR with width@16,
 *  height@20 (big-endian u32). Enough for normalizeViewPins' dimension read. */
function fakePng(w, h) {
  const buf = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(w, 16);
  buf.writeUInt32BE(h, 20);
  return buf;
}

async function freshStore() {
  const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dqa-draw-'));
  await fs.mkdir(path.join(sessionDir, 'screenshots'), { recursive: true });
  const doc = emptySession({ id: 'sess_d', name: 'drawing', sessionDir });
  await writeSession(sessionDir, doc);
  const store = await SessionStore.load(sessionDir);
  return { store, sessionDir };
}

test('createDrawing requires a note and at least one non-empty stroke', async () => {
  const { store } = await freshStore();
  const view = await store.createView({ url: 'https://x/', title: 'X', viewport: { width: 1280, height: 800 } });
  await assert.rejects(
    () => store.createDrawing({ viewId: view.id, pathsPx: [[[10, 10]]], note: '   ' }),
    /requires a note/);
  await assert.rejects(
    () => store.createDrawing({ viewId: view.id, pathsPx: [], note: 'hi' }),
    /at least one non-empty stroke/);
  await assert.rejects(
    () => store.createDrawing({ viewId: view.id, pathsPx: [[]], note: 'hi' }),
    /at least one non-empty stroke/);
});

test('createDrawing stamps type:drawing and trims the note', async () => {
  const { store } = await freshStore();
  const view = await store.createView({ url: 'https://x/', title: 'X', viewport: { width: 1280, height: 800 } });
  const d = await store.createDrawing({ viewId: view.id, pathsPx: [[[10, 10], [20, 20]]], note: '  look here  ' });
  assert.equal(d.type, 'drawing');
  assert.equal(d.note, 'look here');
  assert.equal(d.status, 'open');
  assert.ok(Array.isArray(d.pathsPx), 'pathsPx held until seal');
  assert.equal(d.xPct, undefined, 'no %-coords before seal');
});

test('sealView normalizes pathsPx → %-shape (centroid, bounds, RDP, drop pathsPx)', async () => {
  const { store, sessionDir } = await freshStore();
  const view = await store.createView({ url: 'https://x/', title: 'X', viewport: { width: 1280, height: 800 } });
  // One stroke with 3 collinear interior points (RDP should drop them) running
  // (100,100) → (300,300) in page-px doc coords. dpr=1 against a 1280×800 shot.
  await store.createDrawing({
    viewId: view.id,
    pathsPx: [[[100, 100], [150, 150], [200, 200], [250, 250], [300, 300]]],
    note: 'mark this region',
  });
  await fs.writeFile(path.join(sessionDir, 'screenshots', `${view.id}.png`), fakePng(1280, 800));
  await store.sealView(view.id, path.join('screenshots', `${view.id}.png`));

  const sealed = store.findViewById(view.id);
  const rec = sealed.pins[0];
  assert.equal(rec.type, 'drawing');
  assert.equal(rec.pathsPx, undefined, 'working px coords dropped after seal');
  assert.equal(rec.shape.kind, 'path');
  assert.equal(rec.shape.paths.length, 1);
  // RDP collapses the collinear run to the two endpoints.
  assert.equal(rec.shape.paths[0].length, 2, 'collinear interior points simplified away');

  // dpr=1 → xPct = x/1280*100, yPct = y/800*100.
  const [p0, p1] = rec.shape.paths[0];
  assert.ok(Math.abs(p0[0] - (100 / 1280) * 100) < 0.01);
  assert.ok(Math.abs(p0[1] - (100 / 800) * 100) < 0.01);
  assert.ok(Math.abs(p1[0] - (300 / 1280) * 100) < 0.01);
  assert.ok(Math.abs(p1[1] - (300 / 800) * 100) < 0.01);

  // bounds + centroid (bbox centre) drive marker focus/selection.
  assert.ok(Math.abs(rec.shape.bounds.xPct - (100 / 1280) * 100) < 0.01);
  assert.ok(Math.abs(rec.shape.bounds.wPct - (200 / 1280) * 100) < 0.01);
  assert.ok(Math.abs(rec.xPct - (200 / 1280) * 100) < 0.01, 'xPct = bbox centre');
  assert.ok(Math.abs(rec.yPct - (200 / 800) * 100) < 0.01, 'yPct = bbox centre');

  // Every coordinate normalizes within the canonical 0..100 range.
  for (const [x, y] of rec.shape.paths[0]) {
    assert.ok(x >= 0 && x <= 100 && y >= 0 && y <= 100);
  }
});

test('a text pin still seals to a point (drawing branch does not interfere)', async () => {
  const { store, sessionDir } = await freshStore();
  const view = await store.createView({ url: 'https://x/', title: 'X', viewport: { width: 1280, height: 800 } });
  await store.createPin({ viewId: view.id, x: 640, y: 400, note: 'a point' });
  await fs.writeFile(path.join(sessionDir, 'screenshots', `${view.id}.png`), fakePng(1280, 800));
  await store.sealView(view.id, path.join('screenshots', `${view.id}.png`));
  const rec = store.findViewById(view.id).pins[0];
  assert.equal(rec.type, 'text');
  assert.equal(rec.shape, undefined);
  assert.ok(Math.abs(rec.xPct - 50) < 0.01 && Math.abs(rec.yPct - 50) < 0.01);
});
