import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { sessionSubPaths } from './paths.mjs';
import { pagePxToPct, pngDimensions, clampPct } from './coords.mjs';

const SCHEMA_VERSION = 4;

export function newId(prefix) {
  return `${prefix}_${randomBytes(6).toString('hex')}`;
}

/**
 * Build an empty session document. `author/project/stack/captureMode` come
 * from `design-qa.config.json` (read by the CLI before spawning the server);
 * all four are optional here so test fixtures and ad-hoc loads still work.
 */
export function emptySession({
  id,
  name,
  sessionDir,
  author = null,
  project = null,
  stack = null,
  captureMode = null,
}) {
  return {
    version: SCHEMA_VERSION,
    id,
    name,
    sessionDir,
    project,
    stack,
    captureMode,
    author,           // { name, email } | null
    createdAt: new Date().toISOString(),
    endedAt: null,
    // Spike 8: timestamp of the most recent "Mark start" press. Until it's
    // set, every captured recorder step is treated as a precondition (not
    // part of the engineer-facing recorded path). `null` after migration of
    // pre-Spike-8 docs is correct — they have no recording.
    recordingStartAt: null,
    // Spike 8 / 9f: timestamp of the "Done" / "Stop recording" press that
    // FINALIZED the recorded path. Non-null means the recording is locked —
    // `view.steps[]` are frozen and the recorder stops appending. `recordingStartAt`
    // stays set (the precondition boundary survives) so the forensic per-screen
    // `.spec.ts` still emits. `null` = either still recording, never recorded,
    // or discarded. See finalizeRecording() vs discardRecording().
    recordingDoneAt: null,
    // Spike 8: recorder steps captured BEFORE Mark-start. Emitted into the
    // `.spec.ts` `// === PRECONDITION ===` block (commented out, as hints).
    preconditionSteps: [],
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
 * In-place upgrade through every schema version. Additive and idempotent:
 *  v1→v2: adds `view.source` and pin `author/status/resolvedNote/category`,
 *         computes `xPct/yPct` for sealed views that lack them.
 *  v2→v3: adds top-level `author/project/stack/captureMode` (all null for
 *         pre-config sessions; new sessions stamp these from config at start).
 *  v3→v4: Spike 8. Adds top-level `recordingStartAt: null` +
 *         `recordingDoneAt: null` (9f) + `preconditionSteps: []`, and
 *         `view.steps: []` per view. Pre-Spike-8 docs end up with empty arrays
 *         / null markers — they're treated as "no recording was captured,"
 *         which is the correct outcome for legacy data. `recordingDoneAt` is
 *         folded into v4 additively (no version bump): an undefined marker on
 *         an existing v4 doc backfills to null below.
 * Returns true if anything changed.
 */
export async function migrateDoc(sessionDir, doc) {
  let changed = false;
  if (doc.version !== SCHEMA_VERSION) { doc.version = SCHEMA_VERSION; changed = true; }
  if (doc.author === undefined) { doc.author = null; changed = true; }
  if (doc.project === undefined) { doc.project = null; changed = true; }
  if (doc.stack === undefined) { doc.stack = null; changed = true; }
  if (doc.captureMode === undefined) { doc.captureMode = null; changed = true; }
  if (doc.recordingStartAt === undefined) { doc.recordingStartAt = null; changed = true; }
  if (doc.recordingDoneAt === undefined) { doc.recordingDoneAt = null; changed = true; }
  if (!Array.isArray(doc.preconditionSteps)) { doc.preconditionSteps = []; changed = true; }
  for (const view of doc.views) {
    if (view.source == null) { view.source = 'browser'; changed = true; }
    if (!Array.isArray(view.steps)) { view.steps = []; changed = true; }
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
    // Single broadcast point. Both browser-binding mutations (px) and HTTP
    // console mutations (%) flow through persist(), so every listener (the
    // SSE transport in Phase 4) sees all changes regardless of source.
    this._listeners = new Set();
    this._seq = 0;
    // Serial write chain. Concurrent persist() calls queue here so we never
    // race two writers on the same `session.json.tmp` — atomic temp+rename
    // is only atomic per-write, not across overlapping writes. Pre-Spike-8
    // the mutation rate was low (one per pin drop), so the race never fired;
    // 9b's recorder can produce N writes per keystroke and exposes the bug.
    this._writeChain = Promise.resolve();
  }

  static async load(sessionDir) {
    const doc = await readSession(sessionDir);
    const store = new SessionStore(sessionDir, doc);
    if (await migrateDoc(sessionDir, doc)) await store.persist();
    return store;
  }

  /** subscribe(fn) → unsubscribe(). fn receives a monotonic seq. */
  subscribe(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  async persist() {
    // Enqueue this write after any in-flight one. Each caller awaits its OWN
    // write's outcome; a failure in a prior link doesn't poison the chain
    // (later writes still run) but DOES still surface to that caller's awaiter.
    const prior = this._writeChain;
    const myWrite = prior.then(() => this._doPersist(), () => this._doPersist());
    this._writeChain = myWrite.catch(() => {});
    return myWrite;
  }

  async _doPersist() {
    await writeSession(this.sessionDir, this.doc);
    const seq = ++this._seq;
    for (const fn of [...this._listeners]) {
      try { fn(seq); } catch (err) { console.warn('session listener error:', err.message); }
    }
  }

  /**
   * Live-screen ownership guard (UX §6). The currently-live unsealed browser
   * screen is browser-owned (px pins edited in the overlay); the console must
   * not mutate it. Everything sealed, and every manual screen, is editable.
   */
  _assertConsoleEditable(view) {
    if (view.source === 'browser' && !view.sealedAt) {
      throw new Error(`view ${view.id} is live (browser-owned); not console-editable`);
    }
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
      // Spike 8: recorder steps captured while this view was the live URL.
      // Populated by 9b's segment-on-seal wiring; empty here in 9a.
      steps: [],
    };
    this.doc.views.push(view);
    await this.persist();
    return view;
  }

  /**
   * Create a screen from an uploaded image (manual capture mode, Phase 5). The
   * bytes are written into the session's screenshots dir; the view is
   * source:'manual' with %-born pins (no page-px) and is immediately
   * console-editable (manual screens are never browser-locked). Sealed at birth
   * because the image is frozen the moment it's uploaded.
   */
  async addManualView({ name, ext = 'png', width = null, height = null, imageBuffer }) {
    const id = newId('view');
    const safeExt = String(ext).toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
    const { screenshotsDir } = sessionSubPaths(this.sessionDir);
    await fs.mkdir(screenshotsDir, { recursive: true });
    const abs = path.join(screenshotsDir, `${id}.${safeExt}`);
    await fs.writeFile(abs, imageBuffer);
    const now = new Date().toISOString();
    const view = {
      id,
      source: 'manual',
      url: null,
      title: name || 'Uploaded screenshot',
      name: name || 'Uploaded screenshot',
      viewport: width && height ? { width, height } : null,
      screenshot: path.relative(this.sessionDir, abs),
      createdAt: now,
      sealedAt: now,
      pins: [],
      // Manual screens carry no recorded steps (no live browser captured them);
      // the field exists so all views share a uniform shape.
      steps: [],
    };
    this.doc.views.push(view);
    await this.persist();
    return view;
  }

  async createPin({ viewId, x, y, note, category = null, author }) {
    const view = this.findViewById(viewId);
    if (!view) throw new Error(`view ${viewId} not found`);
    if (view.sealedAt) throw new Error(`view ${viewId} is sealed`);
    // Default author from the session's configured identity (Phase 6) so the
    // browser-overlay binding — which doesn't know about config — still stamps
    // every pin without changing its own call signature.
    const stampedAuthor = author ?? this.doc.author?.name ?? null;
    const pin = {
      id: newId('pin'),
      viewId,
      x,
      y,
      note: note || '',
      category,
      author: stampedAuthor,
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

  /** Locate a pin and its owning view. Used by the console mutation layer. */
  findPin(pinId) {
    for (const view of this.doc.views) {
      const pin = view.pins.find((p) => p.id === pinId);
      if (pin) return { view, pin };
    }
    return { view: null, pin: null };
  }

  // --- Console-facing mutations (%-at-rest) -------------------------------
  // These operate on sealed/manual screens only; ownership is enforced at the
  // HTTP boundary via _assertConsoleEditable before dispatch. Console pins are
  // born with xPct/yPct and carry no page-px x/y (unlike live browser pins).

  async createPinPct({ viewId, xPct, yPct, note = '', category = null, author }) {
    const view = this.findViewById(viewId);
    if (!view) throw new Error(`view ${viewId} not found`);
    // Same default as createPin — console mutations also fall through to the
    // session-level identity when the caller didn't pass an explicit author.
    const stampedAuthor = author ?? this.doc.author?.name ?? null;
    const pin = {
      id: newId('pin'),
      viewId,
      xPct: clampPct(xPct),
      yPct: clampPct(yPct),
      note: note || '',
      category,
      author: stampedAuthor,
      status: 'open',
      resolvedNote: null,
      createdAt: new Date().toISOString(),
    };
    view.pins.push(pin);
    await this.persist();
    return pin;
  }

  async movePinPct({ pinId, xPct, yPct }) {
    const { pin } = this.findPin(pinId);
    if (!pin) throw new Error(`pin ${pinId} not found`);
    pin.xPct = clampPct(xPct);
    pin.yPct = clampPct(yPct);
    await this.persist();
    return pin;
  }

  async editPin({ pinId, note, category }) {
    const { pin } = this.findPin(pinId);
    if (!pin) throw new Error(`pin ${pinId} not found`);
    if (typeof note === 'string') pin.note = note;
    if (category !== undefined) pin.category = category;
    await this.persist();
    return pin;
  }

  async resolvePin({ pinId, resolved, resolvedNote = null }) {
    const { pin } = this.findPin(pinId);
    if (!pin) throw new Error(`pin ${pinId} not found`);
    pin.status = resolved ? 'resolved' : 'open';
    pin.resolvedNote = resolved ? resolvedNote : null;
    await this.persist();
    return pin;
  }

  // --- Spike 8: recorded-step mutations -----------------------------------
  // Steps are written by the capture layer's recorder adapter (one writer:
  // the active capture). Each step is a minimal recorder-event projection:
  //   { id, kind, selector, text, url, key, options, code, t, pageUrl, omitted }
  // The store owns id assignment (`step_<hex>`) and the omitted default.

  async appendStep({ viewId, step }) {
    const view = this.findViewById(viewId);
    if (!view) throw new Error(`view ${viewId} not found`);
    if (!Array.isArray(view.steps)) view.steps = [];
    const persisted = { id: newId('step'), omitted: false, ...step };
    view.steps.push(persisted);
    await this.persist();
    return persisted;
  }

  async appendPreconditionStep(step) {
    if (!Array.isArray(this.doc.preconditionSteps)) this.doc.preconditionSteps = [];
    const persisted = { id: newId('step'), omitted: false, ...step };
    this.doc.preconditionSteps.push(persisted);
    await this.persist();
    return persisted;
  }

  /**
   * In-place replace of a previously-appended step. Used by the recorder's
   * `actionUpdated` coalesce path — typing "hello" lands as one `actionAdded`
   * + N `actionUpdated`s, each carrying the merged form; we keep the latest
   * persisted version. Searches preconditions first, then every view's steps.
   */
  async replaceStep({ id, updates }) {
    for (const s of this.doc.preconditionSteps || []) {
      if (s.id === id) { Object.assign(s, updates, { id }); await this.persist(); return s; }
    }
    for (const view of this.doc.views) {
      if (!Array.isArray(view.steps)) continue;
      for (const s of view.steps) {
        if (s.id === id) { Object.assign(s, updates, { id }); await this.persist(); return s; }
      }
    }
    throw new Error(`step ${id} not found`);
  }

  /**
   * Set the Mark-start timestamp AND retroactively trim. Every step in any
   * `view.steps[]` with `step.t < ts` is moved into `preconditionSteps[]`;
   * preconditionSteps is kept time-sorted. This is what makes Mark-start
   * forgiving: the reviewer can pin first and press Mark-start later.
   *
   * Idempotent on re-press: pressing again with a later `ts` advances the
   * boundary (extra steps drop into preconditionSteps); pressing with an
   * earlier `ts` is a no-op because all post-press steps already have
   * `t >= existing ts`. Pre-mark steps already in preconditionSteps stay there.
   *
   * NOTE: this does NOT touch any in-flight per-URL segment buffer the capture
   * layer holds (those aren't persisted). The capture layer drains buffers
   * itself when Mark-start fires.
   */
  async setRecordingStartAt(ts) {
    this.doc.recordingStartAt = ts;
    // Pressing Mark-start (or "Reset start here") after a finalize re-arms an
    // active recording — clear the done marker so isRecordingActive() flips
    // back on and the chip leaves the resting state. See finalizeRecording().
    this.doc.recordingDoneAt = null;
    if (!Array.isArray(this.doc.preconditionSteps)) this.doc.preconditionSteps = [];
    for (const view of this.doc.views) {
      if (!Array.isArray(view.steps) || view.steps.length === 0) continue;
      const keep = [];
      for (const step of view.steps) {
        if (typeof step.t === 'number' && step.t < ts) this.doc.preconditionSteps.push(step);
        else keep.push(step);
      }
      view.steps = keep;
    }
    this.doc.preconditionSteps.sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
    await this.persist();
    return ts;
  }

  /**
   * Locate a step by id across precondition + every view's steps[]. Returns
   * `{ list, step }` so callers can mutate in place and persist. `list` is the
   * actual array reference (preconditionSteps or one view's steps); `step` is
   * the matching entry. Used by the console-facing step mutations below.
   */
  findStep(stepId) {
    const pre = this.doc.preconditionSteps;
    if (Array.isArray(pre)) {
      const step = pre.find((s) => s.id === stepId);
      if (step) return { list: pre, step };
    }
    for (const view of this.doc.views) {
      if (!Array.isArray(view.steps)) continue;
      const step = view.steps.find((s) => s.id === stepId);
      if (step) return { list: view.steps, step };
    }
    return { list: null, step: null };
  }

  /**
   * Console-side override of a step's human-readable label (9d). The underlying
   * recorder `code` stays authoritative — humanText is just what the step list
   * and emitted `recording-steps.md` render. Empty / falsy clears the override
   * (falls back to describeAction at render time).
   */
  async editStepText({ stepId, humanText }) {
    const { step } = this.findStep(stepId);
    if (!step) throw new Error(`step ${stepId} not found`);
    const next = typeof humanText === 'string' ? humanText.trim() : '';
    step.humanText = next || null;
    await this.persist();
    return step;
  }

  /**
   * Console-side omit (9d). `step.omitted = true` removes the step from the
   * emitted spec + step list. We DON'T splice it out of the array so a future
   * unomit + emit round-trip is lossless. The UI renders omitted rows
   * struck-through with an Undo toast — same pattern as resolve.
   */
  async omitStep({ stepId }) {
    const { step } = this.findStep(stepId);
    if (!step) throw new Error(`step ${stepId} not found`);
    step.omitted = true;
    await this.persist();
    return step;
  }

  async unomitStep({ stepId }) {
    const { step } = this.findStep(stepId);
    if (!step) throw new Error(`step ${stepId} not found`);
    step.omitted = false;
    await this.persist();
    return step;
  }

  /**
   * Finalize the recorded path — the "I'm done recording" gesture (9f). KEEPS
   * every `view.steps[]` entry exactly where it is (the engineer-facing
   * RECORDED PATH survives), and stamps `recordingDoneAt` to LOCK the path and
   * stop the recorder appending. `recordingStartAt` is deliberately left in
   * place so the precondition boundary — and the forensic per-screen `.spec.ts`
   * — still emit. This is what the overlay's "Done" and the popover's
   * "Stop recording" both mean. ("I stopped recording" ≠ "throw away what I
   * recorded" — that's discardRecording().) Idempotent. See design doc §15.2.
   */
  async finalizeRecording(ts = Date.now()) {
    this.doc.recordingDoneAt = ts;
    await this.persist();
    return ts;
  }

  /**
   * Discard the recorded path — the EXPLICIT throw-away (9f, "Discard
   * recording" in the popover). Moves every `view.steps[]` entry back into
   * `preconditionSteps[]` (chronological) as hints, then clears BOTH recording
   * markers so the chip rests and the recorder routes future events to
   * preconditions again. The recorder itself keeps running, so a fresh
   * Mark-start can start over. This is the old `stopRecording` behavior,
   * renamed once "stop" was reconciled to mean finalize-keep (design doc §15.2).
   */
  async discardRecording() {
    if (!Array.isArray(this.doc.preconditionSteps)) this.doc.preconditionSteps = [];
    for (const view of this.doc.views) {
      if (!Array.isArray(view.steps) || view.steps.length === 0) continue;
      for (const step of view.steps) this.doc.preconditionSteps.push(step);
      view.steps = [];
    }
    this.doc.preconditionSteps.sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
    this.doc.recordingStartAt = null;
    this.doc.recordingDoneAt = null;
    await this.persist();
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
