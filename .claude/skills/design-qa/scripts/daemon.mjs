#!/usr/bin/env node
/**
 * Session daemon. Owns the Playwright persistent context, the overlay,
 * and the canonical session.json. Exits on `end` or SIGTERM.
 *
 * Args: --session-dir <abs path>
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { scriptsDir, sessionSubPaths, overlayInjectPath } from './lib/paths.mjs';
import { SessionStore } from './lib/session.mjs';
import { server as ipcServer } from './lib/ipc.mjs';
import { buildArtifact } from './artifact/build.mjs';

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--session-dir') opts.sessionDir = argv[++i];
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
if (!opts.sessionDir) {
  console.error('daemon: --session-dir required');
  process.exit(2);
}
const sessionDir = path.resolve(opts.sessionDir);
const subs = sessionSubPaths(sessionDir);

let cleanupRan = false;
function cleanup() {
  if (cleanupRan) return;
  cleanupRan = true;
  for (const f of [subs.socket, subs.pidFile]) {
    try { fs.unlinkSync(f); } catch {}
  }
}
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { cleanup(); process.exit(0); });
}
process.on('uncaughtException', (err) => {
  console.error('daemon uncaught:', err);
  cleanup();
  process.exit(1);
});

async function main() {
  fs.writeFileSync(subs.pidFile, String(process.pid));

  const store = await SessionStore.load(sessionDir);
  console.log(`daemon: loaded session ${store.doc.id} (${store.doc.name})`);

  // Per-page tracked state: the most recently observed main-frame URL.
  const pageUrls = new WeakMap();

  // Debounced screenshot queue: viewId -> {timer, pending}.
  // We screenshot the *current* page when called, since the live page is what
  // holds the pins that should be baked in. Sealing on navigation reuses the
  // most recent screenshot (the live page is gone by the time we hear about it).
  const screenshotQueue = new Map();

  async function takeScreenshotFor(viewId, page, { fullPage = true } = {}) {
    try {
      if (!page || page.isClosed?.()) return;
      const view = store.findViewById(viewId);
      if (!view || view.sealedAt) return;
      const outPath = path.join(subs.screenshotsDir, `${viewId}.png`);
      // Chrome and pin-layer are both hidden via opacity inside our closed
      // shadow root. Page CSS can't override it; textarea focus is preserved.
      await page.evaluate(() => window.__designQA?.setChromeVisible?.(false)).catch(() => {});
      await page.screenshot({ path: outPath, fullPage });
      await page.evaluate(() => window.__designQA?.setChromeVisible?.(true)).catch(() => {});
      const rel = path.relative(sessionDir, outPath);
      view.screenshot = rel;
      await store.persist();
      console.log(`daemon: screenshot ${rel} (fullPage=${fullPage})`);
    } catch (err) {
      console.warn('daemon: screenshot failed:', err.message);
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
  await fsp.mkdir(subs.browserProfile, { recursive: true });
  const context = await chromium.launchPersistentContext(subs.browserProfile, {
    headless: false,
    viewport: null, // use window size
    args: ['--no-first-run', '--no-default-browser-check'],
  });
  console.log('daemon: chromium launched');

  // Inject overlay into every page. addInitScript applies to future
  // navigations; we'll separately inject into already-open pages below.
  await context.addInitScript({ path: overlayInjectPath });
  const overlayScript = await fsp.readFile(overlayInjectPath, 'utf8');

  // viewId -> page that last touched the view (used to schedule screenshots).
  const viewPages = new Map();

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
    // capture happens later, at seal time (navigation/end/startNewView), via
    // the request-event pre-navigation hook below.
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
    await page.goto(url).catch((err) => { console.warn('daemon: navigateTo failed:', err.message); });
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
        console.log(`daemon: dropped empty view ${view.id} (${view.url})`);
        return;
      }
      await store.sealView(view.id, view.screenshot);
      console.log(`daemon: sealed view ${view.id} (${view.url})`);
    });
  }

  context.on('page', attachPage);
  for (const page of context.pages()) {
    attachPage(page);
    // Already-open pages (e.g. the default tab from launchPersistentContext)
    // missed addInitScript; inject the overlay directly into them.
    try { await page.addScriptTag({ content: overlayScript }); } catch (err) {
      console.warn('daemon: initial overlay inject failed:', err.message);
    }
  }

  if (context.pages().length === 0) {
    await context.newPage();
  }

  // IPC: ping/status/end.
  let ending = false;
  const srv = await ipcServer({
    sessionDir,
    handle: async (msg) => {
      if (ending) return { ready: false, ending: true };
      if (msg.type === 'ping') return { ready: true };
      if (msg.type === 'status') {
        return {
          session: {
            id: store.doc.id,
            name: store.doc.name,
            viewCount: store.doc.views.length,
            pinCount: store.pinCount(),
          },
        };
      }
      if (msg.type === 'end') {
        ending = true;
        // Finalize any unsealed view on the active page(s). Always take a
        // fresh fullPage screenshot here so off-fold pins place correctly,
        // even if only a viewport-only screenshot was captured during the session.
        for (const page of context.pages()) {
          const url = pageUrls.get(page) || page.url();
          const view = store.doc.views.find((v) => v.url === url && !v.sealedAt && v.pins.length > 0);
          if (!view) continue;
          await flushScreenshot(view.id);
          await takeScreenshotFor(view.id, page, { fullPage: true });
          await store.sealView(view.id, view.screenshot);
        }
        await store.markEnded();
        await buildArtifact({ sessionDir, session: store.doc, outPath: subs.artifact });
        // Schedule shutdown after we've replied.
        setTimeout(async () => {
          try { await context.close(); } catch {}
          try { srv.close(); } catch {}
          cleanup();
          process.exit(0);
        }, 100);
        return {
          artifact: subs.artifact,
          viewCount: store.doc.views.length,
          pinCount: store.pinCount(),
        };
      }
      return { error: `unknown type ${msg.type}` };
    },
  });
  console.log(`daemon: listening on ${subs.socket}`);

  // If the user closes the entire browser, exit cleanly.
  context.on('close', () => {
    console.log('daemon: browser context closed, exiting');
    try { srv.close(); } catch {}
    cleanup();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('daemon: fatal', err);
  cleanup();
  process.exit(1);
});
