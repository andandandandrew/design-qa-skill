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

export async function attachCapture(store, {
  sessionDir,
  screenshotsDir,
  browserProfile,
  overlayInjectPath,
  log = () => {},
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

  // Launch Chromium with a per-session persistent profile so logins survive.
  await fsp.mkdir(browserProfile, { recursive: true });
  const context = await chromium.launchPersistentContext(browserProfile, {
    headless: false,
    viewport: null, // use window size
    args: ['--no-first-run', '--no-default-browser-check'],
  });
  log('chromium launched');

  // Inject overlay into every page. addInitScript applies to future
  // navigations; we'll separately inject into already-open pages below.
  await context.addInitScript({ path: overlayInjectPath });
  const overlayScript = await fsp.readFile(overlayInjectPath, 'utf8');

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
    return { viewId: view.id, isNew };
  });

  await context.exposeBinding('__designQA_createPin', async ({ page }, { viewId, x, y, note }) => {
    const pin = await store.createPin({ viewId, x, y, note });
    viewPages.set(viewId, page);
    const entry = screenshotQueue.get(viewId);
    if (entry?.timer) { clearTimeout(entry.timer); screenshotQueue.delete(viewId); }
    // Viewport-only here so Playwright doesn't perform the (visible) fullPage
    // scroll while the user is in the middle of placing a comment. A fullPage
    // capture happens later, at seal time (navigation/end/startNewView).
    await takeScreenshotFor(viewId, page, { fullPage: false });
    return { pinId: pin.id };
  });

  await context.exposeBinding('__designQA_updatePin', async ({ page }, { pinId, note, x, y }) => {
    const pin = await store.updatePin({ pinId, note, x, y });
    if (typeof x === 'number' || typeof y === 'number') {
      // Drag — viewport-only for the same reason as createPin.
      await takeScreenshotFor(pin.viewId, page, { fullPage: false });
    }
    return { ok: true };
  });

  await context.exposeBinding('__designQA_deletePin', async ({ page }, { pinId }) => {
    const { viewId } = await store.deletePin({ pinId });
    // The page is expected to have optimistically removed the pin element
    // from the DOM before calling this binding, so the screenshot now
    // reflects the post-delete pin set.
    await takeScreenshotFor(viewId, page);
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
    }
    // Eagerly create a new unsealed view so the designer has something to name
    // immediately (addresses the "no immediate state change" feedback).
    const viewport = page.viewportSize() || { width: 1440, height: 900 };
    const title = await page.title().catch(() => url);
    const created = await store.createView({ url, title, viewport });
    viewPages.set(created.id, page);
    return { ok: true, sealed: sealedId, dropped: droppedId, newViewId: created.id };
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

    // Pre-navigation fullPage screenshot. `request` fires when the new
    // navigation starts but the old page is still alive, so we can capture
    // the canonical fullPage screenshot then. After framenavigated, the old
    // page is gone and only the in-session viewport-only screenshot remains.
    page.on('request', async (request) => {
      try {
        if (request.frame() !== page.mainFrame()) return;
        if (!request.isNavigationRequest()) return;
        const targetUrl = request.url();
        const oldUrl = pageUrls.get(page);
        if (!oldUrl || oldUrl === targetUrl) return;
        const view = store.doc.views.find((v) => v.url === oldUrl && !v.sealedAt && v.pins.length > 0);
        if (!view) return;
        await takeScreenshotFor(view.id, page, { fullPage: true });
      } catch (err) {
        // Page may tear down mid-capture; that's fine, we already have the
        // viewport-only screenshot as a fallback.
      }
    });

    page.on('framenavigated', async (frame) => {
      if (frame !== page.mainFrame()) return;
      const newUrl = frame.url();
      const oldUrl = pageUrls.get(page);
      pageUrls.set(page, newUrl);
      if (!oldUrl || oldUrl === newUrl) return;
      const view = store.doc.views.find((v) => v.url === oldUrl && !v.sealedAt);
      if (!view) return;
      await flushScreenshot(view.id);
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
    try { await page.addScriptTag({ content: overlayScript }); } catch (err) {
      console.warn('capture: initial overlay inject failed:', err.message);
    }
  }

  if (context.pages().length === 0) {
    await context.newPage();
  }

  return {
    /**
     * Finalize any unsealed view on the active page(s) — the `end` flow.
     * Always takes a fresh fullPage screenshot so off-fold pins place correctly.
     */
    async finalizeActiveViews() {
      for (const page of context.pages()) {
        const url = pageUrls.get(page) || page.url();
        const view = store.doc.views.find((v) => v.url === url && !v.sealedAt && v.pins.length > 0);
        if (!view) continue;
        await flushScreenshot(view.id);
        await takeScreenshotFor(view.id, page, { fullPage: true });
        await store.sealView(view.id, view.screenshot);
      }
    },
    /** Register a callback for when the user closes the whole browser. */
    onClose(cb) { context.on('close', cb); },
    pageCount() { return context.pages().length; },
    async close() { try { await context.close(); } catch {} },
  };
}
