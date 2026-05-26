import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { sessionSubPaths } from './paths.mjs';

const SCHEMA_VERSION = 1;

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
    return new SessionStore(sessionDir, doc);
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

  async createView({ url, title, viewport }) {
    const view = {
      id: newId('view'),
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

  async createPin({ viewId, x, y, note }) {
    const view = this.findViewById(viewId);
    if (!view) throw new Error(`view ${viewId} not found`);
    if (view.sealedAt) throw new Error(`view ${viewId} is sealed`);
    const pin = {
      id: newId('pin'),
      viewId,
      x,
      y,
      note: note || '',
      category: null,
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
