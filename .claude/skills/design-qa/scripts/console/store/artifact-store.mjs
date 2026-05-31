import { createEmitter } from '../lib/events.mjs';
import { applySavedResolves, saveResolvedPin } from './local-resolve.mjs';

/**
 * The exported artifact's persistence seam — same interface as MemoryStore /
 * HttpStore, but over an embedded session document with screenshots already
 * inlined as `data:` URLs (so it works from `file://` with no server).
 *
 * The artifact is read-mostly: an engineer can view, filter, sort, and
 * RESOLVE (with an optional completion note). Resolve persists to LocalStorage
 * via the `local-resolve` helper — the artifact is the one surface with no
 * server to write through (the live console and lookback views persist to the
 * real session.json instead). Only pins the engineer actually toggles here are
 * recorded, so a re-exported artifact's fresher embedded status wins for any
 * pin left untouched. The designer-side resolve in session.json stays separate;
 * see the architecture doc's "two layers of resolve". All non-resolve mutations
 * are inert: the UI gates them off, and these no-ops are a belt-and-suspenders
 * backstop.
 */
const RESOLVE_PREFIX = 'dqa_artifact_resolve';

export class ArtifactStore {
  constructor(session) {
    this.session = session;
    this._emitter = createEmitter();
    applySavedResolves(this.session, RESOLVE_PREFIX);
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
  async createDrawing() { return null; }
  async updatePin() { return null; }
  async movePin() { return null; }
  async deletePin() { return { ok: false }; }

  async resolvePin({ pinId, resolved, resolvedNote = null }) {
    const { pin } = this._findPin(pinId);
    if (!pin) throw new Error(`pin ${pinId} not found`);
    pin.status = resolved ? 'resolved' : 'open';
    pin.resolvedNote = resolved ? resolvedNote : null;
    saveResolvedPin(this.session, RESOLVE_PREFIX, pin);
    this._changed('pin:resolve', { pinId });
    return pin;
  }
}
