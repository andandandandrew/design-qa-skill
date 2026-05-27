import { createEmitter } from '../lib/events.mjs';

/**
 * The runtime persistence seam (Phase 4): identical interface to MemoryStore,
 * backed by the session server. Mutations POST to /api/mutate (the server
 * applies them through the sole-writer SessionStore and returns the fresh doc);
 * an EventSource on /api/events live-refreshes when ANY source mutates the
 * session — including pins placed in the capture browser.
 *
 * The UI is unaware which store it has; it only sees this interface.
 */
export class HttpStore {
  constructor(session, { base = '' } = {}) {
    this.session = session;
    this.base = base; // same-origin by default
    this._emitter = createEmitter();
  }

  subscribe(fn) { return this._emitter.subscribe(fn); }
  _changed(kind, detail) { this._emitter.emit({ kind, detail }); }

  /** Screenshots are served at /screenshots/... ; view.screenshot is relative. */
  screenshotUrl(view) {
    return view?.screenshot ? `${this.base}/${view.screenshot}` : null;
  }

  getView(viewId) { return this.session.views.find((v) => v.id === viewId) || null; }

  async _mutate(op, args) {
    const res = await fetch(`${this.base}/api/mutate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op, args }),
    });
    let data;
    try { data = await res.json(); } catch { data = {}; }
    if (!res.ok || !data.ok) throw new Error(data.error || `${op} failed (${res.status})`);
    this.session = data.session;       // adopt the authoritative doc
    this._changed(op, args);
    return data.result;
  }

  /**
   * Manual screen upload (Phase 5): POST the raw image to /api/upload, which
   * writes it into the session and creates a source:'manual' screen. Returns
   * the new view id; adopts the authoritative doc and emits a change so the UI
   * re-renders and can select the new screen.
   */
  async addManualScreen({ name, file, width, height }) {
    const qs = new URLSearchParams({ name: name || 'Uploaded screenshot' });
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

  createPin(args) { return this._mutate('createPin', args); }
  updatePin(args) { return this._mutate('updatePin', args); }
  movePin(args) { return this._mutate('movePin', args); }
  resolvePin(args) { return this._mutate('resolvePin', args); }
  deletePin(args) { return this._mutate('deletePin', args); }

  /** Re-pull the authoritative doc (used on SSE change + manual refresh). */
  async refresh() {
    const res = await fetch(`${this.base}/api/session`, { cache: 'no-store' });
    if (!res.ok) return;
    this.session = await res.json();
    this._changed('sync');
  }

  /** List every session in the working dir (read-only; powers the switcher). */
  async listSessions() {
    const res = await fetch(`${this.base}/api/sessions`, { cache: 'no-store' });
    return res.ok ? res.json() : [];
  }

  _connectSse() {
    if (typeof EventSource === 'undefined') return;
    const es = new EventSource(`${this.base}/api/events`);
    // Any change (browser capture, another tab) → re-pull + re-render.
    es.addEventListener('change', () => { this.refresh().catch(() => {}); });
    es.onerror = () => {}; // EventSource auto-reconnects
    this._es = es;
  }
}

/** Construct an HttpStore from an already-fetched session doc, then connect SSE. */
export function loadHttpStore(session, opts = {}) {
  const store = new HttpStore(session, opts);
  store._connectSse();
  return store;
}
