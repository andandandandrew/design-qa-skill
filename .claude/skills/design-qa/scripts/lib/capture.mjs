/**
 * Browser capture — the optional Playwright "hat" of the session server.
 *
 * `attachCapture(store, opts)` launches a headed Chromium with the annotation
 * overlay injected, wires the browser-callable bindings (px pins on the live
 * DOM), and handles screenshotting + seal-on-navigation. It is the SAME process
 * as the HTTP console server (the store is shared); capture is lazy-attached so
 * review-only / manual-only sessions never boot Chromium.
 *
 * Returns a handle: { finalizeActiveViews, close, onClose, pageCount }.
 * The orchestrator owns lifecycle (IPC end, process exit); capture owns the
 * browser. Browser bindings mutate `store` with px coords; the store converts
 * to %-at-rest at seal time. The console never edits an unsealed browser view.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { newId } from './session.mjs';
import { attachRecorder } from './recorder.mjs';
import { createRedactor } from './redact.mjs';
import { describeAction } from './recorder-format.mjs';

export async function attachCapture(store, {
  sessionDir,
  screenshotsDir,
  browserProfile,
  overlayInjectPath,
  log = () => {},
  // Spike 8: project-configurable redaction patterns from design-qa.config.json.
  // Additive to the built-in defaults in lib/redact.mjs. Empty array → defaults only.
  redactionPatterns = [],
  // Test affordances — production always defaults to headed Chromium with the
  // overlay injected. The e2e test under __tests__/ flips both to drive the
  // routing logic in isolation without a real reviewer in the loop.
  headless = false,
  injectOverlay = true,
}) {
  // Per-page tracked state: the most recently observed main-frame URL.
  const pageUrls = new WeakMap();
  // viewId -> page that last touched the view (used to schedule screenshots).
  const viewPages = new Map();
  // Debounced screenshot queue: viewId -> {timer, page}.
  const screenshotQueue = new Map();

  async function takeScreenshotFor(viewId, page, { fullPage = true } = {}) {
    try {
      if (!page || page.isClosed?.()) return;
      const view = store.findViewById(viewId);
      if (!view || view.sealedAt) return;
      const outPath = path.join(screenshotsDir, `${viewId}.png`);
      // Chrome and pin-layer are both hidden via opacity inside our closed
      // shadow root. Page CSS can't override it; textarea focus is preserved.
      await page.evaluate(() => window.__designQA?.setChromeVisible?.(false)).catch(() => {});
      await page.screenshot({ path: outPath, fullPage });
      await page.evaluate(() => window.__designQA?.setChromeVisible?.(true)).catch(() => {});
      const rel = path.relative(sessionDir, outPath);
      view.screenshot = rel;
      await store.persist();
      log(`screenshot ${rel} (fullPage=${fullPage})`);
    } catch (err) {
      console.warn('capture: screenshot failed:', err.message);
    }
  }

  function scheduleScreenshot(viewId, page) {
    const entry = screenshotQueue.get(viewId);
    if (entry?.timer) clearTimeout(entry.timer);
    const timer = setTimeout(() => {
      screenshotQueue.delete(viewId);
      takeScreenshotFor(viewId, page);
    }, 300);
    screenshotQueue.set(viewId, { timer, page });
  }

  async function flushScreenshot(viewId) {
    const entry = screenshotQueue.get(viewId);
    if (!entry) return;
    clearTimeout(entry.timer);
    screenshotQueue.delete(viewId);
    await takeScreenshotFor(viewId, entry.page);
  }

  // Drop a pending screenshot WITHOUT taking it — used when the page is
  // navigating away, where a capture would grab a blank/unloading frame.
  function cancelScreenshot(viewId) {
    const entry = screenshotQueue.get(viewId);
    if (entry?.timer) clearTimeout(entry.timer);
    screenshotQueue.delete(viewId);
  }

  // Launch Chromium with a per-session persistent profile so logins survive.
  await fsp.mkdir(browserProfile, { recursive: true });
  const context = await chromium.launchPersistentContext(browserProfile, {
    headless,
    viewport: headless ? { width: 1280, height: 800 } : null,
    args: ['--no-first-run', '--no-default-browser-check'],
  });
  log(`chromium launched (headless=${headless})`);

  // ---------- Spike 8 — interaction recorder ----------
  //
  // The recorder is on from the moment Chromium launches. Mark-start only
  // controls the precondition / recorded-path boundary (`doc.recordingStartAt`),
  // not whether events are captured. Redaction is unconditional — every event
  // routes through the redactor before it touches the store, regardless of
  // which side of Mark-start it lands on.
  //
  // Step routing:
  //   - Pre-Mark-start (recordingStartAt == null): event → `doc.preconditionSteps[]`.
  //   - Post-Mark-start, view exists for ev.pageUrl: event → `view.steps[]`.
  //   - Post-Mark-start, no view yet: event → per-URL segment buffer; drained
  //     into the view when one materializes (via __designQA_ensureView).
  //   - View seals (nav / Save / New) with buffered steps and a non-empty pin
  //     list: buffer drains into view.steps[] BEFORE the seal.
  //   - View seals with no pins, OR navigation away with no view ever: buffer
  //     is discarded. Matches the existing "drop empty unsealed views on nav"
  //     semantic — steps only persist for screens the user annotated.
  const redactor = createRedactor({ extraPatterns: redactionPatterns });
  /** Per-URL segment buffer for steps captured before any view exists yet. */
  const segmentBuffer = new Map();
  /** Tracks the most recently emitted step so `actionUpdated` can update it in
   *  place rather than appending a duplicate. The recorder's `actionUpdated`
   *  fires the coalesced final form of a multi-keystroke fill, and we want the
   *  store to hold only the last value, not every progressive prefix. */
  let lastStep = null;

  /** Project a recorder event into the minimal persisted step shape. */
  function recorderEventToStep(ev) {
    const a = (ev && ev.data && ev.data.action) || {};
    const textValue = typeof a.text === 'string' ? a.text
      : typeof a.value === 'string' ? a.value : null;
    return {
      kind: a.name || 'unknown',
      selector: a.selector || null,
      text: textValue,
      url: a.url || null,
      key: a.key || null,
      options: a.options || null,
      code: ev.code || '',
      t: ev.t || Date.now(),
      pageUrl: ev.pageUrl || '',
    };
  }

  /** Drain (and clear) buffered steps for `url` into the target view's steps[]. */
  async function drainBufferIntoView(url, view) {
    if (!view || !url) return;
    const buf = segmentBuffer.get(url);
    if (!buf || buf.length === 0) { segmentBuffer.delete(url); return; }
    segmentBuffer.delete(url);
    for (const step of buf) {
      await store.appendStep({ viewId: view.id, step });
    }
  }

  async function onRecorderEvent(ev) {
    if (ev.kind !== 'action') return; // signals don't become steps
    const step = recorderEventToStep(ev);
    const url = ev.pageUrl || '';

    if (store.doc.recordingStartAt == null) {
      const saved = await store.appendPreconditionStep(step);
      lastStep = { location: 'precondition', id: saved.id };
      return;
    }

    const view = store.findViewByUrl(url);
    if (view) {
      const saved = await store.appendStep({ viewId: view.id, step });
      lastStep = { location: 'view', id: saved.id, viewId: view.id };
      return;
    }

    // Buffer until a view materializes for this URL.
    const persisted = { id: newId('step'), omitted: false, ...step };
    const buf = segmentBuffer.get(url) || [];
    buf.push(persisted);
    segmentBuffer.set(url, buf);
    lastStep = { location: 'buffer', id: persisted.id, url };
  }

  async function onRecorderUpdate(ev /*, prev */) {
    if (ev.kind !== 'action' || !lastStep) return;
    const updates = recorderEventToStep(ev);
    if (lastStep.location === 'buffer') {
      const buf = segmentBuffer.get(lastStep.url);
      if (!buf) return;
      const ix = buf.findIndex((s) => s.id === lastStep.id);
      if (ix >= 0) buf[ix] = { ...buf[ix], ...updates };
      return;
    }
    try {
      await store.replaceStep({ id: lastStep.id, updates });
    } catch (err) {
      // The prior step may have been retroactively trimmed by Mark-start
      // (precondition → view boundary moved). That's fine — emit as new on
      // the next actionAdded; nothing to recover here.
      log(`recorder: replaceStep ${lastStep.id} failed: ${err.message}`);
    }
  }

  // -- Node → shadow recorder-state push (per design doc §6 Binding mechanism)
  //
  // The overlay's verb-bar chip + Recording popover read state via a global
  // setter the overlay registers on `window`. We page.evaluate that setter on
  // every state change (mark/stop/event), coalesced/throttled to ≤5/sec so
  // fast typing doesn't drown the IPC channel. The full step list is NOT
  // pushed — that's pulled on popover open via __designQA_fetchRecorderSteps.
  function currentRecorderState() {
    const startedAtMs = store.doc.recordingStartAt;
    const active = startedAtMs != null;
    let count = 0;
    if (active) {
      for (const v of store.doc.views) count += Array.isArray(v.steps) ? v.steps.length : 0;
    }
    return { active, count, startedAtMs, redactionCount: redactor.count };
  }

  let pendingPush = null;
  function schedulePushRecorderState() {
    if (pendingPush) { pendingPush.state = currentRecorderState(); return; }
    pendingPush = { state: currentRecorderState() };
    setTimeout(async () => {
      const { state } = pendingPush;
      pendingPush = null;
      for (const page of context.pages()) {
        try {
          await page.evaluate((s) => {
            if (typeof window.__designQA_setRecorderState === 'function') {
              window.__designQA_setRecorderState(s);
            }
          }, state);
        } catch { /* page mid-nav or closed — next event re-pushes */ }
      }
    }, 200);
  }

  // Wrap the recorder sinks so EVERY event triggers a state push (count
  // changes, redactionCount may change). Wrapping here keeps onRecorderEvent
  // pure of UI concerns.
  const _origOnEvent = onRecorderEvent;
  const _origOnUpdate = onRecorderUpdate;
  async function onRecorderEventWithPush(ev) {
    await _origOnEvent(ev);
    schedulePushRecorderState();
  }
  async function onRecorderUpdateWithPush(ev, prev) {
    await _origOnUpdate(ev, prev);
    schedulePushRecorderState();
  }

  const recorder = await attachRecorder(context, {
    redactor,
    onEvent: onRecorderEventWithPush,
    onUpdate: onRecorderUpdateWithPush,
    headless,
  });
  log(`recorder attached (redaction defaults + ${redactionPatterns.length} extra pattern(s))`);
  schedulePushRecorderState();    // initial state push to any already-open pages
  // ---------- end Spike 8 setup ----------

  // Inject overlay into every page. addInitScript applies to future
  // navigations; we'll separately inject into already-open pages below.
  // Skipped in headless test mode — tests call the bindings directly via
  // page.evaluate(window.__designQA_*) without the overlay UI.
  let overlayScript = '';
  if (injectOverlay) {
    await context.addInitScript({ path: overlayInjectPath });
    overlayScript = await fsp.readFile(overlayInjectPath, 'utf8');
  }

  // Browser-callable API. exposeBinding gives us the source `page` for free,
  // which we need so screenshots target the right tab.
  await context.exposeBinding('__designQA_loadForUrl', ({ page }, { url }) => {
    const view = store.findViewByUrl(url);
    if (!view) return { view: null };
    viewPages.set(view.id, page);
    return {
      view: {
        id: view.id,
        url: view.url,
        name: view.name,
        pins: view.pins.map((p) => ({ id: p.id, x: p.x, y: p.y, note: p.note })),
      },
    };
  });

  await context.exposeBinding('__designQA_ensureView', async ({ page }, { url, title, viewport }) => {
    let view = store.findViewByUrl(url);
    const isNew = !view;
    if (!view) view = await store.createView({ url, title, viewport });
    viewPages.set(view.id, page);
    // Spike 8: if any recorder steps were buffered for this URL while no view
    // existed, drain them into the freshly-created (or just-found) view.
    await drainBufferIntoView(url, view);
    return { viewId: view.id, isNew };
  });

  // Spike 8: Mark-start. Sets `doc.recordingStartAt`, retroactively trims any
  // pre-ts view steps into `doc.preconditionSteps[]`, and drains in-memory
  // segment buffers (which by definition pre-date the press) into preconditions.
  // Pressing again advances the boundary forward — same semantic.
  await context.exposeBinding('__designQA_markStart', async () => {
    const ts = Date.now();
    // Buffers first — they're un-persisted and would otherwise be lost.
    for (const buf of segmentBuffer.values()) {
      for (const step of buf) await store.appendPreconditionStep(step);
    }
    segmentBuffer.clear();
    await store.setRecordingStartAt(ts);
    log(`mark-start at ${ts}`);
    schedulePushRecorderState();
    return { ok: true, recordingStartAt: ts };
  });

  // Spike 8: Stop recording — turn off the recorded-path emitter without
  // closing the recorder. Moves every existing view.steps[] entry back into
  // preconditionSteps[] (chronological) and clears recordingStartAt. The
  // popover's [Stop recording] button calls this; re-pressing Mark-start
  // begins a fresh boundary.
  await context.exposeBinding('__designQA_stopRecording', async () => {
    await store.stopRecording();
    log('stop-recording');
    schedulePushRecorderState();
    return { ok: true };
  });

  // Spike 8: pulled by the Recording popover on open. Returns the most recent
  // N steps with humanText pre-computed (so the shadow doesn't need a copy of
  // describeAction) plus the preconditionSteps count for the sub-line. The
  // full step list lives in session.json; this is for the live in-page UI.
  const POPOVER_STEP_CAP = 100;
  await context.exposeBinding('__designQA_fetchRecorderSteps', async () => {
    const all = [];
    for (const v of store.doc.views) {
      if (!Array.isArray(v.steps)) continue;
      for (const s of v.steps) all.push(s);
    }
    all.sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
    const recent = all.slice(-POPOVER_STEP_CAP);
    const steps = recent.map((s) => ({
      id: s.id,
      kind: s.kind,
      // describeAction expects an `action`-shaped object; our persisted step
      // already carries the same fields under a different top-level key name
      // (kind → name). Adapt locally so the formatter stays pure.
      humanText: describeAction({
        name: s.kind, selector: s.selector, text: s.text,
        url: s.url, key: s.key, options: s.options,
      }),
    }));
    return {
      steps,
      preconditionCount: (store.doc.preconditionSteps || []).length,
      redactionCount: redactor.count,
    };
  });

  await context.exposeBinding('__designQA_createPin', async ({ page }, { viewId, x, y, note }) => {
    const pin = await store.createPin({ viewId, x, y, note });
    viewPages.set(viewId, page);
    const view = store.findViewById(viewId);
    // Capture a chrome-hidden fullPage of the live (stable) page. Pins are NOT
    // baked in (the pin-layer is hidden too), so a fullPage of the current page
    // is all we need; off-fold pins place correctly against it. The first pin
    // captures immediately so a baseline always exists; later pins debounce to
    // coalesce rapid placement. We never screenshot during navigation (that
    // was the old blank-page + visible-chrome bug).
    if (view && !view.screenshot) await takeScreenshotFor(viewId, page, { fullPage: true });
    else scheduleScreenshot(viewId, page);
    return { pinId: pin.id };
  });

  await context.exposeBinding('__designQA_updatePin', async ({ page }, { pinId, note, x, y }) => {
    const pin = await store.updatePin({ pinId, note, x, y });
    // A drag changes pin coords, not page content — but refresh (debounced) in
    // case the page scrolled. Note edits don't touch the screenshot at all.
    if (typeof x === 'number' || typeof y === 'number') scheduleScreenshot(pin.viewId, page);
    return { ok: true };
  });

  await context.exposeBinding('__designQA_deletePin', async ({ page }, { pinId }) => {
    const { viewId } = await store.deletePin({ pinId });
    scheduleScreenshot(viewId, page);
    return { ok: true };
  });

  await context.exposeBinding('__designQA_renameView', async (_src, { viewId, name }) => {
    const view = await store.renameView({ viewId, name });
    return { name: view.name };
  });

  await context.exposeBinding('__designQA_deleteView', async (_src, { viewId }) => {
    await store.deleteView({ viewId });
    viewPages.delete(viewId);
    const entry = screenshotQueue.get(viewId);
    if (entry?.timer) clearTimeout(entry.timer);
    screenshotQueue.delete(viewId);
    return { ok: true };
  });

  await context.exposeBinding('__designQA_startNewView', async ({ page }, { url }) => {
    const current = store.doc.views.find((v) => v.url === url && !v.sealedAt);
    let sealedId = null;
    let droppedId = null;
    if (current) {
      // Spike 8: drain buffered recorder steps into the current view BEFORE
      // deciding to drop or seal — if the view will be sealed, its steps[] needs
      // to be complete; if dropped, the buffer (which only exists when there
      // were unrouted events) is naturally discarded with the view.
      await drainBufferIntoView(url, current);
      if (current.pins.length === 0) {
        await store.deleteView({ viewId: current.id });
        droppedId = current.id;
      } else {
        await flushScreenshot(current.id);
        // Always take a fresh fullPage at seal time. If a viewport-only
        // screenshot was captured earlier (during placement), this supersedes
        // it so off-fold pins land correctly in the artifact.
        await takeScreenshotFor(current.id, page, { fullPage: true });
        await store.sealView(current.id, current.screenshot);
        sealedId = current.id;
      }
    } else {
      // No view to drain into — discard any buffered steps for this URL.
      segmentBuffer.delete(url);
    }
    // Eagerly create a new unsealed view so the designer has something to name
    // immediately (addresses the "no immediate state change" feedback).
    const viewport = page.viewportSize() || { width: 1440, height: 900 };
    const title = await page.title().catch(() => url);
    const created = await store.createView({ url, title, viewport });
    viewPages.set(created.id, page);
    return { ok: true, sealed: sealedId, dropped: droppedId, newViewId: created.id };
  });

  // "Save feedback" — the seal half of startNewView WITHOUT opening a new
  // view. The designer is done editing this screen in the browser; it converts
  // to %-at-rest and becomes console-owned. The session stays live; placing
  // another pin on this URL auto-creates a fresh screen (findViewByUrl skips
  // sealed views). Empty unsealed views are dropped, same as on navigation.
  await context.exposeBinding('__designQA_sealCurrentView', async ({ page }, { url }) => {
    const current = store.doc.views.find((v) => v.url === url && !v.sealedAt);
    if (!current) {
      // No view to seal — buffered steps for this URL go with the discard.
      segmentBuffer.delete(url);
      return { ok: false, reason: 'none' };
    }
    // Spike 8: drain buffered steps into the view BEFORE deciding drop / seal.
    await drainBufferIntoView(url, current);
    if (current.pins.length === 0) {
      await store.deleteView({ viewId: current.id });
      return { ok: false, reason: 'empty', dropped: current.id };
    }
    await flushScreenshot(current.id);
    // Fresh fullPage at seal time supersedes any viewport-only placement shot,
    // so off-fold pins land correctly in the artifact.
    await takeScreenshotFor(current.id, page, { fullPage: true });
    await store.sealView(current.id, current.screenshot);
    return { ok: true, sealed: current.id };
  });

  await context.exposeBinding('__designQA_navigateTo', async ({ page }, { url }) => {
    await page.goto(url).catch((err) => { console.warn('capture: navigateTo failed:', err.message); });
    return { ok: true };
  });

  await context.exposeBinding('__designQA_listSession', ({ page }) => {
    const url = pageUrls.get(page) || page.url();
    return store.snapshot(url);
  });

  // Attach navigation tracking to every page.
  function attachPage(page) {
    pageUrls.set(page, page.url());

    // Seal-on-navigation. The screenshot was already captured (chrome hidden,
    // page rendered) at pin-placement time, so here we just seal with the last
    // good shot. We deliberately do NOT screenshot during navigation — the old
    // page is unloading, which produced blank frames with visible chrome.
    page.on('framenavigated', async (frame) => {
      if (frame !== page.mainFrame()) return;
      const newUrl = frame.url();
      const oldUrl = pageUrls.get(page);
      pageUrls.set(page, newUrl);
      if (!oldUrl || oldUrl === newUrl) return;
      const view = store.doc.views.find((v) => v.url === oldUrl && !v.sealedAt);
      if (!view) {
        // No view materialized for oldUrl — any buffered recorder steps are
        // for an unannotated screen; discard with the same rule as nav-drop.
        segmentBuffer.delete(oldUrl);
        return;
      }
      cancelScreenshot(view.id); // don't capture the navigating page
      // Spike 8: drain buffered steps BEFORE the drop/seal decision so an
      // annotated view always carries its complete segment.
      await drainBufferIntoView(oldUrl, view);
      if (view.pins.length === 0) {
        // Drop empty unsealed views on navigation so orphans don't accumulate.
        await store.deleteView({ viewId: view.id });
        log(`dropped empty view ${view.id} (${view.url})`);
        return;
      }
      await store.sealView(view.id, view.screenshot);
      log(`sealed view ${view.id} (${view.url})`);
    });
  }

  context.on('page', attachPage);
  for (const page of context.pages()) {
    attachPage(page);
    // Already-open pages (e.g. the default tab from launchPersistentContext)
    // missed addInitScript; inject the overlay directly into them.
    if (injectOverlay) {
      try { await page.addScriptTag({ content: overlayScript }); } catch (err) {
        console.warn('capture: initial overlay inject failed:', err.message);
      }
    }
  }

  if (context.pages().length === 0) {
    await context.newPage();
  }

  return {
    /** Test affordance — production callers never read this. Exposes the live
     *  BrowserContext so the e2e test can drive a page without re-attaching to
     *  the locked browser-profile dir. Harmless in production. */
    contextForTests: context,
    /**
     * Seal every unsealed view that has pins — the `end` flow AND the
     * browser-close flow. Iterates the STORE (not live pages) so it still seals
     * cleanly when the browser is already gone (close event): in that case the
     * page is closed, takeScreenshotFor early-returns, and we seal with the last
     * good shot captured at pin-placement. When a page is still alive (`end`), we
     * take a fresh fullPage first so off-fold pins place correctly.
     */
    async finalizeActiveViews() {
      for (const view of store.doc.views) {
        if (view.sealedAt || view.pins.length === 0) continue;
        // Spike 8: drain any pending segment buffer for this view's URL before
        // the final seal, so the bundle ships a complete steps[].
        if (view.url) await drainBufferIntoView(view.url, view);
        const page = viewPages.get(view.id);
        if (page && !page.isClosed?.()) {
          await flushScreenshot(view.id);
          await takeScreenshotFor(view.id, page, { fullPage: true });
        }
        await store.sealView(view.id, view.screenshot);
      }
      // Any leftover buffers (URLs without an annotated view) are orphans —
      // v1 doesn't ship steps for unannotated screens. Clear to free memory.
      segmentBuffer.clear();
      // Mute the recorder's callbacks; we don't need any more events.
      recorder.stop();
    },
    /** Register a callback for when the user closes the whole browser. */
    onClose(cb) { context.on('close', cb); },
    pageCount() { return context.pages().length; },
    async close() { try { await context.close(); } catch {} },
  };
}
