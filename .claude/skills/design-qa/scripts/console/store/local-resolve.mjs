/**
 * Engineer-side resolve persistence — shared between two read-only surfaces:
 *
 *   - The exported artifact (origin `file://`), via `ArtifactStore`.
 *   - The console's read-only lookback view of a sibling session
 *     (origin `http://127.0.0.1:<port>/?session=...`), via `LookbackStore`.
 *
 * Both surfaces let the reader check pins resolved without touching
 * `session.json` (the writer-only document). The resolve state lives in
 * LocalStorage, keyed per session id, and is overlaid onto the embedded pins
 * at load time so reloads see prior marks. The two surfaces pass DIFFERENT
 * key prefixes so an archive viewed in both places (artifact + lookback)
 * doesn't bleed state between them — and a future store-adapter swap to a
 * sidecar JSON file is just replacing this helper.
 */

/** Build the namespaced LocalStorage key for one session under one prefix. */
export function resolveKey(prefix, sessionId) {
  return `${prefix}_${sessionId || 'session'}`;
}

/** Mutate `session.views[].pins[].status/resolvedNote` from any saved map. */
export function applySavedResolves(session, prefix) {
  const saved = readMap(resolveKey(prefix, session.id));
  if (!saved) return;
  for (const view of session.views) {
    for (const pin of view.pins) {
      const entry = saved[pin.id];
      if (!entry) continue;
      pin.status = entry.status;
      pin.resolvedNote = entry.resolvedNote ?? null;
    }
  }
}

/** Snapshot every pin's current status into a {pinId: {...}} map and save. */
export function saveResolvesFromSession(session, prefix) {
  const map = {};
  for (const view of session.views) {
    for (const pin of view.pins) {
      map[pin.id] = { status: pin.status, resolvedNote: pin.resolvedNote ?? null };
    }
  }
  writeMap(resolveKey(prefix, session.id), map);
}

function readMap(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); }
  catch { return null; }
}

function writeMap(key, map) {
  try { localStorage.setItem(key, JSON.stringify(map)); } catch {}
}
