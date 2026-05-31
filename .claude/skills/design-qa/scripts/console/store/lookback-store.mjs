import { createEmitter } from '../lib/events.mjs';

/**
 * Phase 6 cross-session store. Used when the URL carries `?session=<basename>`
 * — i.e. the topbar switcher has opened an archived (non-current, non-live)
 * sibling session. Same interface as MemoryStore / HttpStore so the shared
 * engine (core.mjs + ui/*) is unaware.
 *
 * Originally read-only; reshaped per design feedback (2026-05-28) to be
 * FULLY WRITABLE. Once a session ends it has no other writer, so the current
 * server safely authors edits into it. Every mutation appends `?id=<basename>`
 * to the same endpoints the live HttpStore uses; the server caches a
 * SessionStore per basename and persists through it. The resolve state writes
 * to the real `session.json` — no more LocalStorage layer here (that
 * stays only on the file:// artifact, which has no server to write through).
 *
 * Screenshots are served via the sibling-screenshots route
 * `/sessions/<basename>/screenshots/<file>`.
 *
 * SSE: the current server's SSE channel broadcasts only OWNED-session
 * changes. Cross-session mutations skip the broadcast (rare edge case); the
 * mutate response adopts the authoritative doc, which is enough for the
 * editing tab. Two concurrent editors of the same archived session would
 * fall back to last-write-wins — acceptable for v1.
 */
export class LookbackStore {
  /** Caller hands us a freshly-fetched session doc + the sibling basename. */
  constructor(session, basename, { base = '' } = {}) {
    this.session = session;
    this.basename = basename;
    this.base = base;
    this._emitter = createEmitter();
    this.isLookback = true; // feature-detect tag for app-level chrome cues
  }

  subscribe(fn) { return this._emitter.subscribe(fn); }
  _changed(kind, detail) { this._emitter.emit({ kind, detail }); }

  /** Sibling screenshots route — basename is in the path, file is the relative
   *  `screenshots/<id>.ext` already stored in `view.screenshot`. */
  screenshotUrl(view) {
    if (!view?.screenshot) return null;
    return `${this.base}/sessions/${encodeURIComponent(this.basename)}/${view.screenshot}`;
  }

  getView(viewId) { return this.session.views.find((v) => v.id === viewId) || null; }

  async _mutate(op, args) {
    const url = `${this.base}/api/mutate?id=${encodeURIComponent(this.basename)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op, args }),
    });
    let data;
    try { data = await res.json(); } catch { data = {}; }
    if (!res.ok || !data.ok) throw new Error(data.error || `${op} failed (${res.status})`);
    this.session = data.session;
    this._changed(op, args);
    return data.result;
  }

  createPin(args) { return this._mutate('createPin', args); }
  createDrawing(args) { return this._mutate('createDrawing', args); }
  updatePin(args) { return this._mutate('updatePin', args); }
  movePin(args) { return this._mutate('movePin', args); }
  resolvePin(args) { return this._mutate('resolvePin', args); }
  deletePin(args) { return this._mutate('deletePin', args); }
  deleteView(args) { return this._mutate('deleteView', args); }

  // Spike 8 / 9d — same step-authoring ops the live HttpStore exposes; each
  // hits /api/mutate?id=<basename>. Lookback editing is fully writable per
  // the Phase-6 redesign — no new gates here.
  editStepText(args) { return this._mutate('editStepText', args); }
  omitStep(args) { return this._mutate('omitStep', args); }
  unomitStep(args) { return this._mutate('unomitStep', args); }

  /** Preview the sibling's recording.spec.ts via the server's pure emitter.
   *  Returns the same shape as HttpStore.fetchRecordingPreview(); `viewId` (9g)
   *  scopes to that screen's checkpoint test. */
  async fetchRecordingPreview(viewId = null) {
    const params = new URLSearchParams({ id: this.basename });
    if (viewId) params.set('view', viewId);
    const res = await fetch(
      `${this.base}/api/recording-preview?${params.toString()}`,
      { cache: 'no-store' },
    );
    if (!res.ok) throw new Error(`preview failed (${res.status})`);
    return res.json();
  }

  /** Manual screen upload — identical to HttpStore.addManualScreen, just
   *  targeted at the archived sibling via `?id=`. */
  async addManualScreen({ name, file, width, height }) {
    const qs = new URLSearchParams({ name: name || 'Uploaded screenshot', id: this.basename });
    if (width) qs.set('w', String(width));
    if (height) qs.set('h', String(height));
    const res = await fetch(`${this.base}/api/upload?${qs}`, {
      method: 'POST',
      headers: { 'content-type': file.type || 'application/octet-stream' },
      body: file,
    });
    let data;
    try { data = await res.json(); } catch { data = {}; }
    if (!res.ok || !data.ok) throw new Error(data.error || `upload failed (${res.status})`);
    this.session = data.session;
    this._changed('addManualScreen', { viewId: data.result.viewId });
    return data.result.viewId;
  }

  /** Re-pull the authoritative doc (used after mutations + manual refresh). */
  async refresh() {
    const res = await fetch(
      `${this.base}/api/session?id=${encodeURIComponent(this.basename)}`,
      { cache: 'no-store' },
    );
    if (!res.ok) return;
    this.session = await res.json();
    this._changed('sync');
  }

  /** List every session in the working dir — powers the switcher in both modes. */
  async listSessions() {
    const res = await fetch(`${this.base}/api/sessions`, { cache: 'no-store' });
    return res.ok ? res.json() : [];
  }
}

/** Fetch the sibling doc by basename and return a ready-to-use LookbackStore. */
export async function loadLookbackStore(basename, opts = {}) {
  const base = opts.base ?? '';
  const res = await fetch(
    `${base}/api/session?id=${encodeURIComponent(basename)}`,
    { cache: 'no-store' },
  );
  if (!res.ok) throw new Error(`lookback: GET /api/session?id=${basename} failed (${res.status})`);
  const session = await res.json();
  return new LookbackStore(session, basename, { base });
}
