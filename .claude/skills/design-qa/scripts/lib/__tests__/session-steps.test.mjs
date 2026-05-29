/**
 * Tests for Spike 8 step mutations on SessionStore:
 *   - appendStep, appendPreconditionStep, replaceStep
 *   - setRecordingStartAt + retroactive trim
 *
 * Uses a real temp sessionDir so SessionStore.persist() round-trips through
 * disk (catches JSON-serialization regressions on the new fields).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionStore, emptySession, writeSession } from '../session.mjs';

/** Stand up a temp session dir with a fresh v4 doc and load it. */
async function newStore({ withView = false } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dqa-step-test-'));
  await fs.mkdir(path.join(dir, 'screenshots'), { recursive: true });
  const doc = emptySession({
    id: 'sess_test', name: 'test', sessionDir: dir,
    author: { name: 'Tester', email: null },
    project: 'Proj', stack: 'Web', captureMode: 'browser',
  });
  if (withView) {
    doc.views.push({
      id: 'view_a', source: 'browser', url: 'https://x/a',
      title: 'A', name: 'A', viewport: { width: 1280, height: 800 },
      screenshot: null, createdAt: new Date().toISOString(), sealedAt: null,
      pins: [], steps: [],
    });
  }
  await writeSession(dir, doc);
  const store = await SessionStore.load(dir);
  return { store, dir };
}

async function cleanup(dir) {
  try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* noop */ }
}

test('appendStep adds to view.steps[] with id + omitted default', async () => {
  const { store, dir } = await newStore({ withView: true });
  try {
    const saved = await store.appendStep({
      viewId: 'view_a',
      step: { kind: 'click', selector: 'internal:role=button[name="X"]', t: 100,
              pageUrl: 'https://x/a', code: 'await page.click()' },
    });
    assert.match(saved.id, /^step_[0-9a-f]+$/);
    assert.equal(saved.omitted, false);
    assert.equal(saved.kind, 'click');
    // Persisted to disk
    const fresh = await SessionStore.load(dir);
    assert.equal(fresh.doc.views[0].steps.length, 1);
    assert.equal(fresh.doc.views[0].steps[0].id, saved.id);
  } finally { await cleanup(dir); }
});

test('appendStep accepts a caller-supplied id (preserved)', async () => {
  const { store, dir } = await newStore({ withView: true });
  try {
    const supplied = 'step_custom_abc123';
    const saved = await store.appendStep({
      viewId: 'view_a',
      step: { id: supplied, kind: 'fill', selector: 's', text: 'v', t: 1, pageUrl: '', code: '' },
    });
    assert.equal(saved.id, supplied);
  } finally { await cleanup(dir); }
});

test('appendPreconditionStep adds to doc.preconditionSteps[]', async () => {
  const { store, dir } = await newStore();
  try {
    const s = await store.appendPreconditionStep({
      kind: 'click', selector: 'sel', t: 10, pageUrl: 'u', code: 'c',
    });
    assert.equal(store.doc.preconditionSteps.length, 1);
    assert.equal(store.doc.preconditionSteps[0].id, s.id);
    assert.equal(store.doc.preconditionSteps[0].omitted, false);
  } finally { await cleanup(dir); }
});

test('replaceStep finds in preconditions and applies updates', async () => {
  const { store, dir } = await newStore();
  try {
    const s = await store.appendPreconditionStep({ kind: 'click', t: 1, code: 'a' });
    await store.replaceStep({ id: s.id, updates: { code: 'b', text: 'hi' } });
    assert.equal(store.doc.preconditionSteps[0].code, 'b');
    assert.equal(store.doc.preconditionSteps[0].text, 'hi');
    assert.equal(store.doc.preconditionSteps[0].id, s.id); // id preserved
  } finally { await cleanup(dir); }
});

test('replaceStep finds in view.steps[] and applies updates', async () => {
  const { store, dir } = await newStore({ withView: true });
  try {
    const s = await store.appendStep({
      viewId: 'view_a',
      step: { kind: 'fill', selector: 's', text: 'A', t: 1, pageUrl: '', code: "fill('A')" },
    });
    await store.replaceStep({ id: s.id, updates: { text: 'AB', code: "fill('AB')" } });
    assert.equal(store.doc.views[0].steps[0].text, 'AB');
    assert.equal(store.doc.views[0].steps[0].code, "fill('AB')");
  } finally { await cleanup(dir); }
});

test('replaceStep throws when id is unknown', async () => {
  const { store, dir } = await newStore();
  try {
    await assert.rejects(
      () => store.replaceStep({ id: 'step_nope', updates: { code: '' } }),
      /step .* not found/,
    );
  } finally { await cleanup(dir); }
});

test('setRecordingStartAt: sets timestamp and trims view steps with t < ts', async () => {
  const { store, dir } = await newStore({ withView: true });
  try {
    // Two pre-ts and one post-ts step in the view.
    await store.appendStep({ viewId: 'view_a',
      step: { kind: 'click', t: 100, pageUrl: 'u', code: 'pre1' } });
    await store.appendStep({ viewId: 'view_a',
      step: { kind: 'click', t: 200, pageUrl: 'u', code: 'pre2' } });
    await store.appendStep({ viewId: 'view_a',
      step: { kind: 'click', t: 400, pageUrl: 'u', code: 'post' } });

    await store.setRecordingStartAt(300);

    assert.equal(store.doc.recordingStartAt, 300);
    // pre1 + pre2 moved to preconditionSteps; post stayed in the view.
    assert.equal(store.doc.views[0].steps.length, 1);
    assert.equal(store.doc.views[0].steps[0].code, 'post');
    assert.equal(store.doc.preconditionSteps.length, 2);
    // Time-sorted in preconditionSteps.
    assert.equal(store.doc.preconditionSteps[0].code, 'pre1');
    assert.equal(store.doc.preconditionSteps[1].code, 'pre2');
  } finally { await cleanup(dir); }
});

test('setRecordingStartAt: re-press with later ts advances boundary', async () => {
  const { store, dir } = await newStore({ withView: true });
  try {
    await store.appendStep({ viewId: 'view_a',
      step: { kind: 'click', t: 100, code: 'a' } });
    await store.appendStep({ viewId: 'view_a',
      step: { kind: 'click', t: 250, code: 'b' } });
    await store.appendStep({ viewId: 'view_a',
      step: { kind: 'click', t: 500, code: 'c' } });

    await store.setRecordingStartAt(150);
    assert.equal(store.doc.preconditionSteps.length, 1); // 'a'
    assert.equal(store.doc.views[0].steps.length, 2); // b, c

    // Advance.
    await store.setRecordingStartAt(400);
    assert.equal(store.doc.preconditionSteps.length, 2); // a, b
    assert.equal(store.doc.views[0].steps.length, 1); // c
    // a and b remain time-sorted.
    assert.equal(store.doc.preconditionSteps[0].code, 'a');
    assert.equal(store.doc.preconditionSteps[1].code, 'b');
  } finally { await cleanup(dir); }
});

test('setRecordingStartAt: preconditionSteps stays sorted across multiple views', async () => {
  const { store, dir } = await newStore();
  try {
    // Two views, interleaved timestamps.
    store.doc.views.push({
      id: 'v1', source: 'browser', url: 'u1', title: 'V1', name: 'V1',
      viewport: { width: 1280, height: 800 }, screenshot: null,
      createdAt: '2026-01-01T00:00:00Z', sealedAt: null, pins: [], steps: [],
    });
    store.doc.views.push({
      id: 'v2', source: 'browser', url: 'u2', title: 'V2', name: 'V2',
      viewport: { width: 1280, height: 800 }, screenshot: null,
      createdAt: '2026-01-01T00:00:00Z', sealedAt: null, pins: [], steps: [],
    });
    await store.appendStep({ viewId: 'v1', step: { kind: 'c', t: 100, code: 'v1@100' } });
    await store.appendStep({ viewId: 'v2', step: { kind: 'c', t: 50,  code: 'v2@50' } });
    await store.appendStep({ viewId: 'v1', step: { kind: 'c', t: 75,  code: 'v1@75' } });
    await store.appendStep({ viewId: 'v2', step: { kind: 'c', t: 150, code: 'v2@150' } });

    await store.setRecordingStartAt(200); // all four are pre-ts

    assert.equal(store.doc.preconditionSteps.length, 4);
    const ts = store.doc.preconditionSteps.map((s) => s.t);
    assert.deepEqual(ts, [50, 75, 100, 150]);
    assert.equal(store.doc.views[0].steps.length, 0);
    assert.equal(store.doc.views[1].steps.length, 0);
  } finally { await cleanup(dir); }
});

test('setRecordingStartAt: empty case is a no-op (no steps anywhere)', async () => {
  const { store, dir } = await newStore({ withView: true });
  try {
    await store.setRecordingStartAt(1000);
    assert.equal(store.doc.recordingStartAt, 1000);
    assert.deepEqual(store.doc.preconditionSteps, []);
    assert.equal(store.doc.views[0].steps.length, 0);
  } finally { await cleanup(dir); }
});

test('persist(): concurrent writes serialize (no ENOENT on shared tmp)', async () => {
  // Regression: pre-fix, 9b's recorder could fire N rapid persist() calls; two
  // overlapping writes raced on `session.json.tmp` and the loser ENOENT'd on
  // its own (already-renamed-away) tmp file. Fix is a serial write chain.
  // This test schedules 50 appendPreconditionStep calls concurrently and
  // asserts every one lands on disk in order.
  const { store, dir } = await newStore();
  try {
    const N = 50;
    const promises = [];
    for (let i = 0; i < N; i++) {
      promises.push(store.appendPreconditionStep({
        kind: 'click', selector: 'sel', t: i, pageUrl: 'u',
        code: `// step ${i}`,
      }));
    }
    const results = await Promise.all(promises);
    assert.equal(results.length, N);
    assert.equal(store.doc.preconditionSteps.length, N);
    // On-disk content matches in-memory.
    const fresh = await SessionStore.load(dir);
    assert.equal(fresh.doc.preconditionSteps.length, N);
    // Insertion order preserved (each persist's _doPersist saw a complete
    // doc snapshot — the chain serializes between mutations as well).
    for (let i = 0; i < N; i++) {
      assert.equal(fresh.doc.preconditionSteps[i].t, i);
    }
  } finally { await cleanup(dir); }
});
