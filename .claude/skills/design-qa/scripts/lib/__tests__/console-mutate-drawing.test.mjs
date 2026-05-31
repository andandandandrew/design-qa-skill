/**
 * Spike 11 — console `createDrawing` mutate op, through the HTTP boundary.
 *
 * The console drawing path is HttpStore.createDrawing → POST /api/mutate
 * {op:'createDrawing'} → (allowlist CONSOLE_OPS) → ownership guard
 * (_assertConsoleEditable, since createDrawing ∈ VIEW_ID_OPS) →
 * SessionStore.createDrawingPct. Until now only createDrawingPct had a unit
 * test (session-drawing.test.mjs); the server seam — the allowlist, the
 * ownership guard, and the %-shape that comes back over the wire — had no
 * permanent coverage (only throwaway smokes, since deleted). This is also the
 * first test to exercise startHttpServer at all.
 *
 * Asserts the op is allowlisted, routes through the ownership guard correctly
 * (sealed + manual views editable; an unsealed browser view blocked), produces
 * a `type:'drawing'` record with a canonical %-shape, and that an unknown op is
 * rejected at the allowlist.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionStore, emptySession, writeSession } from '../session.mjs';
import { startHttpServer } from '../http-server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONSOLE_DIR = path.join(__dirname, '..', '..', 'console');

/** Smallest buffer pngDimensions() can read — PNG sig + IHDR with width@16,
 *  height@20 (big-endian u32). Enough for sealView's normalizeViewPins. */
function fakePng(w, h) {
  const buf = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(w, 16);
  buf.writeUInt32BE(h, 20);
  return buf;
}

test('console createDrawing mutate op — allowlist, ownership guard, %-shape', async () => {
  const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dqa-mutate-draw-'));
  const screenshotsDir = path.join(sessionDir, 'screenshots');
  await fs.mkdir(screenshotsDir, { recursive: true });
  const doc = emptySession({ id: 'sess_mut', name: 'mutate-draw', sessionDir, author: { name: 'Tester', email: null } });
  await writeSession(sessionDir, doc);
  const store = await SessionStore.load(sessionDir);

  // Three views exercising the ownership guard's branches:
  //  - sealed BROWSER view → editable (the normal console drawing target)
  //  - MANUAL view         → editable (manual screens are never browser-locked)
  //  - unsealed BROWSER view → live, browser-owned → console-blocked
  const sealed = await store.createView({ url: 'https://x/a', title: 'A', viewport: { width: 1280, height: 800 } });
  await fs.writeFile(path.join(screenshotsDir, `${sealed.id}.png`), fakePng(1280, 800));
  await store.sealView(sealed.id, path.join('screenshots', `${sealed.id}.png`));

  const manual = await store.addManualView({ name: 'Uploaded', width: 1024, height: 768, imageBuffer: fakePng(1024, 768) });

  const live = await store.createView({ url: 'https://x/b', title: 'B', viewport: { width: 1280, height: 800 } });

  let server;
  try {
    server = await startHttpServer(store, { sessionDir, consoleDir: CONSOLE_DIR, log: () => {} });
    const mutate = async (op, args) => {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/mutate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op, args }),
      });
      return { status: res.status, body: await res.json() };
    };
    // One stroke in %-of-image coords with a collinear interior point RDP drops.
    const paths = [[[10, 10], [20, 20], [30, 30]]];

    // 1) Allowlisted + happy path on a SEALED view.
    const ok = await mutate('createDrawing', { viewId: sealed.id, paths, note: '  circle this  ' });
    assert.equal(ok.status, 200, 'createDrawing is allowlisted and succeeds on a sealed view');
    assert.equal(ok.body.ok, true);
    assert.equal(ok.body.result.type, 'drawing', 'record is type:drawing');
    assert.equal(ok.body.result.note, 'circle this', 'note trimmed');
    assert.equal(ok.body.result.shape.kind, 'path');
    assert.equal(ok.body.result.shape.paths[0].length, 2, 'RDP collapses the collinear run');
    for (const stroke of ok.body.result.shape.paths) {
      for (const [x, y] of stroke) {
        assert.ok(x >= 0 && x <= 100 && y >= 0 && y <= 100, `coord ${x},${y} within 0..100`);
      }
    }
    // Persisted into the live store doc (not just echoed in the response).
    assert.equal(store.findViewById(sealed.id).pins.length, 1);
    assert.equal(store.findViewById(sealed.id).pins[0].type, 'drawing');

    // 2) MANUAL view is editable too.
    const onManual = await mutate('createDrawing', { viewId: manual.id, paths, note: 'mark here' });
    assert.equal(onManual.status, 200, 'manual screens are console-editable');
    assert.equal(onManual.body.result.type, 'drawing');

    // 3) UNSEALED BROWSER view is blocked by the ownership guard.
    const onLive = await mutate('createDrawing', { viewId: live.id, paths, note: 'should fail' });
    assert.equal(onLive.status, 409, 'live browser-owned view is not console-editable');
    assert.match(onLive.body.error, /live \(browser-owned\)/);
    assert.equal(store.findViewById(live.id).pins.length, 0, 'nothing written to the live view');

    // 4) Missing/blank note is rejected (createDrawingPct requires a note).
    const noNote = await mutate('createDrawing', { viewId: sealed.id, paths, note: '   ' });
    assert.equal(noNote.status, 409);
    assert.match(noNote.body.error, /requires a note/);

    // 5) Allowlist negative: an unknown op is rejected before any dispatch.
    const bogus = await mutate('frobnicate', { viewId: sealed.id });
    assert.equal(bogus.status, 400);
    assert.match(bogus.body.error, /unknown op/);
  } finally {
    if (server) try { server.close(); } catch { /* noop */ }
    try { await fs.rm(sessionDir, { recursive: true, force: true }); } catch { /* noop */ }
  }
});
