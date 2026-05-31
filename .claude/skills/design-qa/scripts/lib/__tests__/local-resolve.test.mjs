/**
 * Tests the standalone file:// artifact's LocalStorage-backed resolve overlay
 * (console/store/local-resolve.mjs + ArtifactStore).
 *
 * The staleness guard is the load-bearing case: the saved map records ONLY
 * pins the engineer actually toggled in this artifact, so a re-exported
 * artifact whose embedded session.json carries a fresher status wins for any
 * pin the engineer never touched here. An explicit engineer toggle still
 * overrides the embedded status both ways (resolve and re-open).
 *
 * These are Node tests; we install a minimal in-memory `globalThis.localStorage`
 * shim (the helper only uses getItem/setItem) since no browser is present.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { applySavedResolves } from '../../console/store/local-resolve.mjs';
import { ArtifactStore } from '../../console/store/artifact-store.mjs';

// Minimal in-memory localStorage shim — getItem/setItem only.
function installLocalStorage() {
  const map = new Map();
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    clear: () => { map.clear(); },
  };
}

const RESOLVE_PREFIX = 'dqa_artifact_resolve';

/** Synthetic embedded session doc with two pins; statuses are caller-supplied
 *  so a test can simulate a re-exported artifact carrying a `resolved` pin. */
function makeSession({ p1Status = 'open', p2Status = 'open' } = {}) {
  return {
    id: 'sess_artifact',
    views: [
      {
        id: 'view_a',
        pins: [
          { id: 'pin_1', viewId: 'view_a', status: p1Status, resolvedNote: null },
          { id: 'pin_2', viewId: 'view_a', status: p2Status, resolvedNote: null },
        ],
      },
    ],
  };
}

function pinById(session, id) {
  for (const view of session.views) {
    const pin = view.pins.find((p) => p.id === id);
    if (pin) return pin;
  }
  return null;
}

beforeEach(() => { installLocalStorage(); });

test('embedded resolved pin shows resolved on load with no LocalStorage entry', () => {
  const session = makeSession({ p1Status: 'resolved' });
  // Construct the store (its ctor calls applySavedResolves). No prior toggles.
  const store = new ArtifactStore(session);
  assert.equal(pinById(store.session, 'pin_1').status, 'resolved',
    'embedded resolved status must survive load');
  assert.equal(pinById(store.session, 'pin_2').status, 'open');
  // Nothing was written to LocalStorage just by loading.
  assert.equal(localStorage.getItem(`${RESOLVE_PREFIX}_sess_artifact`), null);
});

test('an engineer toggle persists across a reload', async () => {
  const session = makeSession();
  const store = new ArtifactStore(session);
  await store.resolvePin({ pinId: 'pin_1', resolved: true, resolvedNote: 'fixed' });

  // Simulate a reload: a fresh embedded copy + a fresh applySavedResolves pass
  // against the same (persistent) LocalStorage.
  const reloaded = makeSession();
  applySavedResolves(reloaded, RESOLVE_PREFIX);
  assert.equal(pinById(reloaded, 'pin_1').status, 'resolved');
  assert.equal(pinById(reloaded, 'pin_1').resolvedNote, 'fixed');
  // The untouched pin stays as the embedded doc shipped it.
  assert.equal(pinById(reloaded, 'pin_2').status, 'open');
});

test('an engineer re-open overrides an embedded resolved status', async () => {
  // Artifact ships pin_1 resolved; engineer explicitly re-opens it.
  const session = makeSession({ p1Status: 'resolved' });
  const store = new ArtifactStore(session);
  await store.resolvePin({ pinId: 'pin_1', resolved: false });

  const reloaded = makeSession({ p1Status: 'resolved' });
  applySavedResolves(reloaded, RESOLVE_PREFIX);
  assert.equal(pinById(reloaded, 'pin_1').status, 'open',
    'explicit re-open must override the embedded resolved status');
  assert.equal(pinById(reloaded, 'pin_1').resolvedNote, null);
});

test('staleness guard: a stale entry for an UNTOUCHED pin does not clobber a fresher embedded status', () => {
  // Scenario: a prior artifact run snapshotted pin_1 as `open` into LocalStorage
  // via the OLD whole-session-snapshot behavior. The engineer never toggled
  // pin_1 in THIS artifact. The artifact was then re-exported with pin_1 now
  // `resolved` in the embedded session.json. On reload the fresh embedded
  // `resolved` must win — the stale `open` must NOT clobber it.
  //
  // With the per-pin guard, an untouched pin is simply never in the saved map,
  // so we assert that loading a re-exported `resolved` doc leaves it resolved
  // even though no engineer toggle of pin_1 was recorded here.
  const reExported = makeSession({ p1Status: 'resolved' });
  const store = new ArtifactStore(reExported);
  assert.equal(pinById(store.session, 'pin_1').status, 'resolved',
    'untouched embedded resolved pin must stay resolved on reload');

  // Belt-and-suspenders: even if a stale map for OTHER pins exists, it must not
  // touch pin_1 (which the engineer never toggled).
  const staleKey = `${RESOLVE_PREFIX}_sess_artifact`;
  localStorage.setItem(staleKey, JSON.stringify({
    pin_2: { status: 'resolved', resolvedNote: null }, // a real prior toggle
  }));
  const reloaded = makeSession({ p1Status: 'resolved' });
  applySavedResolves(reloaded, RESOLVE_PREFIX);
  assert.equal(pinById(reloaded, 'pin_1').status, 'resolved',
    'pin_1 (never toggled) keeps its fresher embedded status');
  assert.equal(pinById(reloaded, 'pin_2').status, 'resolved',
    'pin_2 (a recorded toggle) is still overlaid');
});
