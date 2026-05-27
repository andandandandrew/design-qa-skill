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

  // "Save feedback" — the seal half of startNewView WITHOUT opening a new
  // view. The designer is done editing this screen in the browser; it converts
  // to %-at-rest and becomes console-owned. The session stays live; placing
  // another pin on this URL auto-creates a fresh screen (findViewByUrl skips
  // sealed views). Empty unsealed views are dropped, same as on navigation.
  await context.exposeBinding('__designQA_sealCurrentView', async ({ page }, { url }) => {
    const current = store.doc.views.find((v) => v.url === url && !v.sealedAt);
    if (!current) return { ok: false, reason: 'none' };
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
      if (!view) return;
      cancelScreenshot(view.id); // don't capture the navigating page
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
        const page = viewPages.get(view.id);
        if (page && !page.isClosed?.()) {
          await flushScreenshot(view.id);
          await takeScreenshotFor(view.id, page, { fullPage: true });
        }
        await store.sealView(view.id, view.screenshot);
      }
    },
    /** Register a callback for when the user closes the whole browser. */
    onClose(cb) { context.on('close', cb); },
    pageCount() { return context.pages().length; },
    async close() { try { await context.close(); } catch {} },
  };
}
