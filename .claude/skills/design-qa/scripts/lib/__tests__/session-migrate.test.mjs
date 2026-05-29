/**
 * Tests v3→v4 schema migration in lib/session.mjs.
 *
 * Same idempotent additive pattern as v2→v3, scoped to the Spike-8 fields:
 *   - top-level `recordingStartAt: null` and `preconditionSteps: []`
 *   - per-view `steps: []`
 *
 * Pre-Spike-8 docs end up with empty arrays, which is correct: "no recording
 * was captured."
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrateDoc } from '../session.mjs';

/** Synthetic v3 doc with no screenshot dependence (pins already have pct so
 *  normalizeViewPins is a no-op — keeps the test off the filesystem). */
function v3Doc() {
  return {
    version: 3,
    id: 'sess_test',
    name: 'test',
    sessionDir: '/tmp/does-not-exist',
    project: 'Proj',
    stack: 'React',
    captureMode: 'browser',
    author: { name: 'A', email: null },
    createdAt: '2026-05-28T00:00:00.000Z',
    endedAt: null,
    views: [
      {
        id: 'view_a',
        source: 'browser',
        url: 'https://x/a',
        title: 'A',
        name: 'A',
        viewport: { width: 1280, height: 800 },
        screenshot: null,
        createdAt: '2026-05-28T00:00:00.000Z',
        sealedAt: null,
        pins: [
          { id: 'pin_1', viewId: 'view_a', xPct: 0.5, yPct: 0.5, note: 'n',
            category: null, author: 'A', status: 'open', resolvedNote: null,
            createdAt: '2026-05-28T00:00:00.000Z' },
        ],
      },
    ],
  };
}

test('v3 doc gains v4 fields (top-level + per-view) on migrate', async () => {
  const doc = v3Doc();
  const changed = await migrateDoc('/tmp/does-not-exist', doc);
  assert.equal(changed, true);
  assert.equal(doc.version, 4);
  assert.equal(doc.recordingStartAt, null);
  assert.deepEqual(doc.preconditionSteps, []);
  assert.deepEqual(doc.views[0].steps, []);
});

test('migration is idempotent — second call reports no change', async () => {
  const doc = v3Doc();
  await migrateDoc('/tmp/does-not-exist', doc);
  const changed = await migrateDoc('/tmp/does-not-exist', doc);
  assert.equal(changed, false, 'second migrateDoc should be a no-op');
  assert.equal(doc.version, 4);
});

test('migration preserves existing v4 data without clobbering it', async () => {
  const doc = v3Doc();
  doc.version = 4;
  doc.recordingStartAt = '2026-05-28T00:01:23.000Z';
  doc.recordingDoneAt = null; // present so this is a complete current v4 doc
  doc.preconditionSteps = [{ kind: 'action', code: '// existing' }];
  doc.views[0].steps = [{ kind: 'action', code: 'await page.click(...)' }];
  const changed = await migrateDoc('/tmp/does-not-exist', doc);
  // Some of the v3-introduced fields above may already be present in this
  // synthesized doc, so `changed` may be false. The contract is "do not lose data."
  assert.equal(doc.recordingStartAt, '2026-05-28T00:01:23.000Z');
  assert.equal(doc.preconditionSteps.length, 1);
  assert.equal(doc.views[0].steps.length, 1);
  assert.equal(changed, false);
});

test('v1-ish doc (no v2/v3/v4 fields) migrates all the way up', async () => {
  // Deliberately stripped — no author, project, stack, captureMode,
  // recordingStartAt, preconditionSteps; views miss source + steps.
  const doc = {
    version: 1,
    id: 'sess_legacy',
    name: 'legacy',
    sessionDir: '/tmp/does-not-exist',
    createdAt: '2026-01-01T00:00:00.000Z',
    endedAt: null,
    views: [
      {
        id: 'v',
        url: 'https://x/',
        title: 'X', name: 'X',
        viewport: { width: 1280, height: 800 },
        screenshot: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        sealedAt: null,
        pins: [
          { id: 'p', viewId: 'v', xPct: 0.5, yPct: 0.5, note: '',
            createdAt: '2026-01-01T00:00:00.000Z' },
        ],
      },
    ],
  };
  const changed = await migrateDoc('/tmp/does-not-exist', doc);
  assert.equal(changed, true);
  assert.equal(doc.version, 4);
  // v2 fields
  assert.equal(doc.views[0].source, 'browser');
  assert.equal(doc.views[0].pins[0].status, 'open');
  // v3 fields
  assert.equal(doc.author, null);
  assert.equal(doc.project, null);
  // v4 fields
  assert.equal(doc.recordingStartAt, null);
  assert.deepEqual(doc.preconditionSteps, []);
  assert.deepEqual(doc.views[0].steps, []);
});
