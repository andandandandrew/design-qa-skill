import { createEmitter } from '../lib/events.mjs';
import { clampPct } from '../lib/coords.mjs';

/**
 * The console's persistence seam (Phase 2: in-memory).
 *
 * Every editor mutation goes through these async methods; none touches the DOM
 * or disk directly. Phase 4 supplies a `HttpStore` with the *same interface*
 * backed by the daemon, and the UI is none the wiser. Mutations emit a change
 * event so the panes re-render — the same `emit` the Phase-4 SSE transport will
 * drive for live updates from the capture browser.
 *
 * Methods are async on purpose: the in-memory versions resolve immediately, but
 * the HTTP versions will await the network, and callers already `await`.
 */
export class MemoryStore {
  constructor(session, { screenshotBase = './fixtures/' } = {}) {
    this.session = session;
    this.screenshotBase = screenshotBase;
    this._emitter = createEmitter();
    this._seq = 0;
  }

  subscribe(fn) { return this._emitter.subscribe(fn); }
  _changed(kind, detail) { this._emitter.emit({ kind, detail }); }

  /** Resolve a screen's screenshot relative path to a loadable URL. */
  screenshotUrl(view) {
    return view?.screenshot ? this.screenshotBase + view.screenshot : null;
  }

  getView(viewId) { return this.session.views.find((v) => v.id === viewId) || null; }

  _findPin(pinId) {
    for (const view of this.session.views) {
      const pin = view.pins.find((p) => p.id === pinId);
      if (pin) return { view, pin };
    }
    return { view: null, pin: null };
  }

  _newId(prefix) {
    const rand = Math.random().toString(16).slice(2, 14).padEnd(12, '0');
    return `${prefix}_${rand}`;
  }

  async createPin({ viewId, xPct, yPct, note = '', category = null, author = null }) {
    const view = this.getView(viewId);
    if (!view) throw new Error(`view ${viewId} not found`);
    const pin = {
      id: this._newId('pin'),
      viewId,
      xPct: clampPct(xPct),
      yPct: clampPct(yPct),
      note,
      category,
      author,
      status: 'open',
      resolvedNote: null,
      createdAt: new Date().toISOString(),
    };
    view.pins.push(pin);
    this._changed('pin:create', { pinId: pin.id, viewId });
    return pin;
  }

  // Console drawing authoring (fixture/dev path). Paths arrive in %; build the
  // shape directly (no RDP here — the fixture store is dev-only). Mirrors the
  // server's createDrawingPct shape so the renderer is identical.
  async createDrawing({ viewId, paths, note = '', category = null, author = null }) {
    const view = this.getView(viewId);
    if (!view) throw new Error(`view ${viewId} not found`);
    const clean = (paths || [])
      .filter((s) => Array.isArray(s) && s.length)
      .map((s) => s.map(([x, y]) => [clampPct(x), clampPct(y)]));
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of clean) for (const [x, y] of s) {
      if (x < minX) minX = x; if (y < minY) minY = y;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y;
    }
    const bounds = Number.isFinite(minX)
      ? { xPct: minX, yPct: minY, wPct: maxX - minX, hPct: maxY - minY }
      : { xPct: 0, yPct: 0, wPct: 0, hPct: 0 };
    const pin = {
      id: this._newId('pin'),
      viewId,
      type: 'drawing',
      shape: { kind: 'path', paths: clean, bounds, strokeWidth: 3, color: '#e5484d' },
      xPct: clampPct(bounds.xPct + bounds.wPct / 2),
      yPct: clampPct(bounds.yPct + bounds.hPct / 2),
      note, category, author,
      status: 'open', resolvedNote: null, createdAt: new Date().toISOString(),
    };
    view.pins.push(pin);
    this._changed('pin:create', { pinId: pin.id, viewId });
    return pin;
  }

  async updatePin({ pinId, note, category }) {
    const { pin } = this._findPin(pinId);
    if (!pin) throw new Error(`pin ${pinId} not found`);
    if (typeof note === 'string') pin.note = note;
    if (category !== undefined) pin.category = category;
    this._changed('pin:update', { pinId });
    return pin;
  }

  async movePin({ pinId, xPct, yPct }) {
    const { pin } = this._findPin(pinId);
    if (!pin) throw new Error(`pin ${pinId} not found`);
    pin.xPct = clampPct(xPct);
    pin.yPct = clampPct(yPct);
    this._changed('pin:move', { pinId });
    return pin;
  }

  async resolvePin({ pinId, resolved, resolvedNote = null }) {
    const { pin } = this._findPin(pinId);
    if (!pin) throw new Error(`pin ${pinId} not found`);
    pin.status = resolved ? 'resolved' : 'open';
    pin.resolvedNote = resolved ? resolvedNote : null;
    this._changed('pin:resolve', { pinId });
    return pin;
  }

  async deletePin({ pinId }) {
    const { view, pin } = this._findPin(pinId);
    if (!pin) throw new Error(`pin ${pinId} not found`);
    view.pins = view.pins.filter((p) => p.id !== pinId);
    this._changed('pin:delete', { pinId, viewId: view.id });
    return { ok: true };
  }
}

/** Load a fixture session.json and wrap it in a MemoryStore. */
export async function loadMemoryStore(url = './fixtures/session.json') {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not load ${url}: ${res.status}`);
  const session = await res.json();
  return new MemoryStore(session, { screenshotBase: './fixtures/' });
}
