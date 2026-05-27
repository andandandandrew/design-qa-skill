import { createEmitter } from '../lib/events.mjs';

/**
 * The exported artifact's persistence seam — same interface as MemoryStore /
 * HttpStore, but over an embedded session document with screenshots already
 * inlined as `data:` URLs (so it works from `file://` with no server).
 *
 * The artifact is read-mostly: an engineer can view, filter, sort, and
 * RESOLVE (with an optional completion note). Resolve is the one mutation that
 * persists — to LocalStorage, keyed by session id, so it survives a reload
 * (the designer-side resolve in session.json stays separate; see the
 * architecture doc's "two layers of resolve"). All other mutations are inert:
 * the UI gates them off, and these no-ops are a belt-and-suspenders backstop.
 */
export class ArtifactStore {
  constructor(session) {
    this.session = session;
    this._emitter = createEmitter();
    this._key = `dqa_artifact_resolve_${session.id || 'session'}`;
    this._applySavedResolves();
  }

  subscribe(fn) { return this._emitter.subscribe(fn); }
  _changed(kind, detail) { this._emitter.emit({ kind, detail }); }

  /** Screenshots are inlined as data URLs at build time — return as-is. */
  screenshotUrl(view) { return view?.screenshot || null; }

  getView(viewId) { return this.session.views.find((v) => v.id === viewId) || null; }

  _findPin(pinId) {
    for (const view of this.session.views) {
      const pin = view.pins.find((p) => p.id === pinId);
      if (pin) return { view, pin };
    }
    return { view: null, pin: null };
  }

  // Inert mutations — the read-only UI never calls these; kept for interface
  // parity so the shared modules need no special-casing.
  async createPin() { return null; }
  async updatePin() { return null; }
  async movePin() { return null; }
  async deletePin() { return { ok: false }; }

  async resolvePin({ pinId, resolved, resolvedNote = null }) {
    const { pin } = this._findPin(pinId);
    if (!pin) throw new Error(`pin ${pinId} not found`);
    pin.status = resolved ? 'resolved' : 'open';
    pin.resolvedNote = resolved ? resolvedNote : null;
    this._save();
    this._changed('pin:resolve', { pinId });
    return pin;
  }

  /** Overlay LocalStorage resolves onto the embedded pins at load. */
  _applySavedResolves() {
    const saved = this._read();
    if (!saved) return;
    for (const view of this.session.views) {
      for (const pin of view.pins) {
        const entry = saved[pin.id];
        if (!entry) continue;
        pin.status = entry.status;
        pin.resolvedNote = entry.resolvedNote ?? null;
      }
    }
  }

  /** Persist every pin's current resolve state as a {pinId: {...}} map. */
  _save() {
    const map = {};
    for (const view of this.session.views) {
      for (const pin of view.pins) {
        map[pin.id] = { status: pin.status, resolvedNote: pin.resolvedNote ?? null };
      }
    }
    try { localStorage.setItem(this._key, JSON.stringify(map)); } catch {}
  }

  _read() {
    try { return JSON.parse(localStorage.getItem(this._key) || 'null'); } catch { return null; }
  }
}
