/**
 * Spike 12 — element-selection feedback record: creation guards + seal-time
 * px-box → %-bounds normalization (boxToPct, the same transform pins ride).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionStore, emptySession, writeSession } from '../session.mjs';

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
  const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dqa-el-'));
  await fs.mkdir(path.join(sessionDir, 'screenshots'), { recursive: true });
  const doc = emptySession({ id: 'sess_e', name: 'element', sessionDir });
  await writeSession(sessionDir, doc);
  return { store: await SessionStore.load(sessionDir), sessionDir };
}

test('createElement requires a note and a bounding box', async () => {
  const { store } = await freshStore();
  const view = await store.createView({ url: 'https://x/', title: 'X', viewport: { width: 1280, height: 800 } });
  await assert.rejects(
    () => store.createElement({ viewId: view.id, boxPx: { x: 10, y: 10, w: 50, h: 20 }, name: 'btn', note: '  ' }),
    /requires a note/);
  await assert.rejects(
    () => store.createElement({ viewId: view.id, boxPx: null, name: 'btn', note: 'hi' }),
    /requires a bounding box/);
});

test('createElement stores type:element + name/descriptor, holds boxPx until seal', async () => {
  const { store } = await freshStore();
  const view = await store.createView({ url: 'https://x/', title: 'X', viewport: { width: 1280, height: 800 } });
  const rec = await store.createElement({
    viewId: view.id, boxPx: { x: 128, y: 80, w: 256, h: 40 },
    name: 'Email address', descriptor: { tag: 'input', testId: null, text: null }, note: '  fix label  ',
  });
  assert.equal(rec.type, 'element');
  assert.equal(rec.note, 'fix label');
  assert.equal(rec.element.name, 'Email address');
  assert.equal(rec.element.descriptor.tag, 'input');
  assert.ok(rec.boxPx, 'boxPx held until seal');
  assert.equal(rec.element.bounds, undefined, 'no %-bounds before seal');
});

test('sealView normalizes boxPx → element.bounds (%), centroid, drops boxPx', async () => {
  const { store, sessionDir } = await freshStore();
  const view = await store.createView({ url: 'https://x/', title: 'X', viewport: { width: 1280, height: 800 } });
  // Box at page-px (128,80) size 256×40. dpr=1 against a 1280×800 shot.
  await store.createElement({
    viewId: view.id, boxPx: { x: 128, y: 80, w: 256, h: 40 }, name: 'CTA',
    descriptor: { tag: 'button', testId: 'cta', text: 'Go' }, note: 'use secondary style',
  });
  await fs.writeFile(path.join(sessionDir, 'screenshots', `${view.id}.png`), fakePng(1280, 800));
  await store.sealView(view.id, path.join('screenshots', `${view.id}.png`));

  const rec = store.findViewById(view.id).pins[0];
  assert.equal(rec.boxPx, undefined, 'working px box dropped at seal');
  const b = rec.element.bounds;
  // xPct = 128/1280*100 = 10 ; yPct = 80/800*100 = 10
  assert.ok(Math.abs(b.xPct - 10) < 0.01);
  assert.ok(Math.abs(b.yPct - 10) < 0.01);
  // wPct = 256/1280*100 = 20 ; hPct = 40/800*100 = 5
  assert.ok(Math.abs(b.wPct - 20) < 0.01);
  assert.ok(Math.abs(b.hPct - 5) < 0.01);
  // centroid = box centre
  assert.ok(Math.abs(rec.xPct - 20) < 0.01, 'xPct = box centre');
  assert.ok(Math.abs(rec.yPct - 12.5) < 0.01, 'yPct = box centre');
  assert.equal(rec.element.name, 'CTA'); // name/descriptor survive untouched
});
