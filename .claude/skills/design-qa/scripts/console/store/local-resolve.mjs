/**
 * Engineer-side resolve persistence for the STANDALONE `file://` ARTIFACT only.
 *
 * The artifact is the one surface with no server to write through, so its
 * resolve state lives in LocalStorage (keyed per session id) and is overlaid
 * onto the embedded `session.json` pins at load time so reloads see prior
 * marks. `ArtifactStore` is its sole caller.
 *
 * The SERVED surfaces do NOT use this helper: the live console (`HttpStore`)
 * and the lookback view of an archived sibling (`LookbackStore`) both persist
 * resolves to the real `session.json` via the server.
 *
 * Staleness guard: the saved map records ONLY pins the engineer actually
 * toggled in this artifact (one entry written per `resolvePin` call), never a
 * snapshot of every pin. So a re-exported artifact whose embedded `session.json`
 * already carries a fresher status wins for any pin the engineer never touched
 * here; an explicit engineer toggle still overrides the embedded status both
 * ways (resolve and re-open).
 *
 * The `prefix` parameter is kept for API stability and future namespacing; a
 * store-adapter swap to a sidecar JSON file is just replacing this helper.
 */

/** Build the namespaced LocalStorage key for one session under one prefix. */
export function resolveKey(prefix, sessionId) {
  return `${prefix}_${sessionId || 'session'}`;
}

/** Overlay only the engineer-touched pins from the saved map onto the session;
 *  untouched pins keep their embedded canonical status. */
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

/** Record one engineer-toggled pin into the saved map, merging with any prior
 *  toggles. Only pins explicitly resolved/re-opened here are persisted, so
 *  untouched pins never clobber a fresher embedded status on reload. */
export function saveResolvedPin(session, prefix, pin) {
  const key = resolveKey(prefix, session.id);
  const map = readMap(key) || {};
  map[pin.id] = { status: pin.status, resolvedNote: pin.resolvedNote ?? null };
  writeMap(key, map);
}

function readMap(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); }
  catch { return null; }
}

function writeMap(key, map) {
  try { localStorage.setItem(key, JSON.stringify(map)); } catch {}
}
