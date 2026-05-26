import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { sessionSubPaths } from './paths.mjs';
import { pagePxToPct, pngDimensions } from './coords.mjs';

const SCHEMA_VERSION = 2;

export function newId(prefix) {
  return `${prefix}_${randomBytes(6).toString('hex')}`;
}

export function emptySession({ id, name, sessionDir }) {
  return {
    version: SCHEMA_VERSION,
    id,
    name,
    sessionDir,
    createdAt: new Date().toISOString(),
    endedAt: null,
    views: [],
  };
}

export async function readSession(sessionDir) {
  const { sessionJson } = sessionSubPaths(sessionDir);
  const raw = await fs.readFile(sessionJson, 'utf8');
  return JSON.parse(raw);
}

/**
 * Compute %-of-image coords for a view's pins from its (final) screenshot.
 * Additive: leaves px x/y in place as the live overlay's working coords and
 * sets xPct/yPct as the canonical at-rest position. Browser pins only — manual
 * pins are born with xPct/yPct and have no px to convert.
 */
async function normalizeViewPins(sessionDir, view) {
  if (!view.screenshot || view.source === 'manual') return;
  let shotWidth, shotHeight;
  try {
    const buf = await fs.readFile(path.join(sessionDir, view.screenshot));
    ({ width: shotWidth, height: shotHeight } = pngDimensions(buf));
  } catch { return; }
  const vp = view.viewport || { width: shotWidth, height: shotHeight };
  for (const p of view.pins) {
    if (typeof p.x !== 'number' || typeof p.y !== 'number') continue;
    const { xPct, yPct } = pagePxToPct({
      x: p.x, y: p.y, viewportWidth: vp.width, shotWidth, shotHeight,
    });
    p.xPct = xPct;
    p.yPct = yPct;
  }
}

/**
 * In-place v1→v2 upgrade. Additive and idempotent: adds source on views and
 * author/status/resolvedNote/category on pins, and computes xPct/yPct for any
 * sealed view that lacks them. Returns true if anything changed.
 */
export async function migrateDoc(sessionDir, doc) {
  let changed = false;
  if (doc.version !== SCHEMA_VERSION) { doc.version = SCHEMA_VERSION; changed = true; }
  for (const view of doc.views) {
    if (view.source == null) { view.source = 'browser'; changed = true; }
    for (const p of view.pins) {
      if (p.author === undefined) { p.author = null; changed = true; }
      if (p.status == null) { p.status = 'open'; changed = true; }
      if (p.resolvedNote === undefined) { p.resolvedNote = null; changed = true; }
      if (p.category === undefined) { p.category = null; changed = true; }
    }
    const needsPct = view.pins.some((p) => p.xPct == null && typeof p.x === 'number');
    if (needsPct && (view.sealedAt || view.screenshot)) {
      await normalizeViewPins(sessionDir, view);
      changed = true;
    }
  }
  return changed;
}

export async function writeSession(sessionDir, session) {
  const { sessionJson } = sessionSubPaths(sessionDir);
  const tmp = sessionJson + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(session, null, 2), 'utf8');
  await fs.rename(tmp, sessionJson);
}

/**
 * In-memory session manager. Owns the canonical session document, persists
 * to disk on every mutation, and exposes mutation primitives the daemon uses.
 */
export class SessionStore {
  constructor(sessionDir, doc) {
    this.sessionDir = sessionDir;
    this.doc = doc;
  }

  static async load(sessionDir) {
    const doc = await readSession(sessionDir);
    const store = new SessionStore(sessionDir, doc);
    if (await migrateDoc(sessionDir, doc)) await store.persist();
    return store;
  }

  async persist() {
    await writeSession(this.sessionDir, this.doc);
  }

  findViewByUrl(url) {
    return this.doc.views.find((v) => v.url === url && !v.sealedAt) || null;
  }

  findViewById(id) {
    return this.doc.views.find((v) => v.id === id) || null;
  }

  async createView({ url, title, viewport, source = 'browser' }) {
    const view = {
      id: newId('view'),
      source,
      url,
      title: title || url,
      name: title || url,
      viewport,
      screenshot: null,
      createdAt: new Date().toISOString(),
      sealedAt: null,
      pins: [],
    };
    this.doc.views.push(view);
    await this.persist();
    return view;
  }

  async createPin({ viewId, x, y, note, category = null, author = null }) {
    const view = this.findViewById(viewId);
    if (!view) throw new Error(`view ${viewId} not found`);
    if (view.sealedAt) throw new Error(`view ${viewId} is sealed`);
    const pin = {
      id: newId('pin'),
      viewId,
      x,
      y,
      note: note || '',
      category,
      author,
      status: 'open',
      resolvedNote: null,
      createdAt: new Date().toISOString(),
    };
    view.pins.push(pin);
    await this.persist();
    return pin;
  }

  async updatePin({ pinId, note, x, y }) {
    for (const view of this.doc.views) {
      const pin = view.pins.find((p) => p.id === pinId);
      if (pin) {
        if (typeof note === 'string') pin.note = note;
        if (typeof x === 'number') pin.x = x;
        if (typeof y === 'number') pin.y = y;
        await this.persist();
        return pin;
      }
    }
    throw new Error(`pin ${pinId} not found`);
  }

  async sealView(viewId, screenshotPath) {
    const view = this.findViewById(viewId);
    if (!view) throw new Error(`view ${viewId} not found`);
    view.sealedAt = new Date().toISOString();
    view.screenshot = screenshotPath;
    // Freeze coords to %-of-image against the final screenshot. This is the
    // single point where browser pins become canonical %-at-rest (Spike B).
    await normalizeViewPins(this.sessionDir, view);
    await this.persist();
    return view;
  }

  async renameView({ viewId, name }) {
    const view = this.findViewById(viewId);
    if (!view) throw new Error(`view ${viewId} not found`);
    view.name = String(name || '').trim() || view.url;
    await this.persist();
    return view;
  }

  async deleteView({ viewId }) {
    const idx = this.doc.views.findIndex((v) => v.id === viewId);
    if (idx === -1) throw new Error(`view ${viewId} not found`);
    const [removed] = this.doc.views.splice(idx, 1);
    if (removed.screenshot) {
      const abs = path.join(this.sessionDir, removed.screenshot);
      try { await fs.unlink(abs); } catch {}
    }
    await this.persist();
    return removed;
  }

  async deletePin({ pinId }) {
    for (const view of this.doc.views) {
      const idx = view.pins.findIndex((p) => p.id === pinId);
      if (idx !== -1) {
        const [removed] = view.pins.splice(idx, 1);
        await this.persist();
        return { removed, viewId: view.id };
      }
    }
    throw new Error(`pin ${pinId} not found`);
  }

  /**
   * Returns a serializable summary suitable for the in-browser inspector.
   * Active = unsealed view for the given url (if any).
   */
  snapshot(currentUrl) {
    return {
      sessionName: this.doc.name,
      activeViewId:
        this.doc.views.find((v) => v.url === currentUrl && !v.sealedAt)?.id || null,
      views: this.doc.views.map((v) => ({
        id: v.id,
        name: v.name,
        url: v.url,
        sealedAt: v.sealedAt,
        pinCount: v.pins.length,
        pins: v.pins.map((p) => ({ id: p.id, note: p.note, createdAt: p.createdAt })),
      })),
    };
  }

  async markEnded() {
    this.doc.endedAt = new Date().toISOString();
    await this.persist();
  }

  pinCount() {
    return this.doc.views.reduce((acc, v) => acc + v.pins.length, 0);
  }
}
