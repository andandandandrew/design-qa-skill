#!/usr/bin/env node
/**
 * Session server. One per session; the SOLE writer of that session's
 * session.json. Wears two hats:
 *   1. console (always)  — serves the buildless console over 127.0.0.1 + SSE.
 *   2. capture (optional) — lazy-attaches Playwright for live browser capture.
 *
 * Folds the former capture daemon into the console server: both browser pins
 * and console edits funnel through one SessionStore. Exits on `end` or SIGTERM,
 * or when the capture browser is closed.
 *
 * Args: --session-dir <abs path>  [--no-capture]
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { sessionSubPaths, overlayInjectPath, consoleDir } from './lib/paths.mjs';
import { SessionStore } from './lib/session.mjs';
import { server as ipcServer } from './lib/ipc.mjs';
import { buildArtifact } from './artifact/build.mjs';
import { attachCapture } from './lib/capture.mjs';
import { startHttpServer } from './lib/http-server.mjs';
import { readConfig } from './lib/config.mjs';

function parseArgs(argv) {
  const opts = { capture: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--session-dir') opts.sessionDir = argv[++i];
    else if (argv[i] === '--no-capture') opts.capture = false;
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
if (!opts.sessionDir) {
  console.error('session-server: --session-dir required');
  process.exit(2);
}
const sessionDir = path.resolve(opts.sessionDir);
const subs = sessionSubPaths(sessionDir);
const log = (msg) => console.log(`session-server: ${msg}`);

// Shutdown timing. Overridable via env so the seal-timeout and watchdog paths
// can be exercised end-to-end quickly; the defaults are the production values.
const envInt = (name, def) => {
  const v = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isInteger(v) && v >= 0 ? v : def;
};
const SEAL_TIMEOUT_MS = envInt('DESIGNQA_SEAL_TIMEOUT_MS', 8_000);
const END_WATCHDOG_MS = envInt('DESIGNQA_END_WATCHDOG_MS', 20_000);
const CLOSE_WATCHDOG_MS = envInt('DESIGNQA_CLOSE_WATCHDOG_MS', 15_000);
const CAPTURE_CLOSE_TIMEOUT_MS = envInt('DESIGNQA_CAPTURE_CLOSE_TIMEOUT_MS', 5_000);
// TEST-ONLY seam: inject an artificial stall into the seal path so a true hang
// (not just an error) can be reproduced, proving the seal-timeout and watchdog
// fire. Never set in production.
const TEST_SEAL_HANG_MS = envInt('DESIGNQA_TEST_SEAL_HANG_MS', 0);

let cleanupRan = false;
function cleanup() {
  if (cleanupRan) return;
  cleanupRan = true;
  for (const f of [subs.computedSocket, subs.socketPointer, subs.pidFile, subs.consoleUrlFile]) {
    try { fs.unlinkSync(f); } catch {}
  }
}
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { cleanup(); process.exit(0); });
}
process.on('uncaughtException', (err) => {
  console.error('session-server uncaught:', err);
  cleanup();
  process.exit(1);
});

/**
 * Race a promise against a timeout. On timeout (or rejection) it logs and
 * RESOLVES rather than rejecting, so a wedged step (e.g. a full-page screenshot
 * of an unresponsive page) can never block shutdown. The underlying op is left
 * to settle on its own; closing the browser later unblocks most stuck captures.
 */
function withTimeout(promise, ms, label) {
  return new Promise((resolve) => {
    let done = false;
    const settle = (fn, v) => { if (!done) { done = true; clearTimeout(t); fn(v); } };
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      log(`${label} timed out after ${ms}ms, continuing`);
      resolve();
    }, ms);
    t.unref();
    Promise.resolve(promise).then(
      (v) => settle(resolve, v),
      (e) => { log(`${label} failed: ${e?.message || e}`); settle(resolve); },
    );
  });
}

/** Open a URL in the user's normal browser (suppressible for tests). */
function openInBrowser(url) {
  if (process.env.DESIGNQA_NO_OPEN) return;
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref(); } catch {}
}

async function main() {
  fs.writeFileSync(subs.pidFile, String(process.pid));
  // Record the socket path we will bind, derived from *this* process's tmpdir,
  // so a later CLI call can reach us even if its own tmpdir differs. See
  // lib/paths.mjs (socketPathFor) for why recomputing on the CLI side is unsafe.
  fs.writeFileSync(subs.socketPointer, subs.computedSocket);

  const store = await SessionStore.load(sessionDir);
  log(`loaded session ${store.doc.id} (${store.doc.name})`);

  // Console hat — always on, independent of any browser.
  const httpSrv = await startHttpServer(store, { sessionDir, consoleDir, log });
  fs.writeFileSync(subs.consoleUrlFile, httpSrv.consoleUrl);

  // Spike 8: read project-level redaction patterns (additive to the built-in
  // defaults in lib/redact.mjs). Failure to read here is non-fatal — capture
  // still has safe defaults. cli.mjs guarantees the config file exists by the
  // time we boot, so the ENOENT path is only hit by test harnesses.
  let redactionPatterns = [];
  try {
    const root = path.dirname(sessionDir);
    const cfg = await readConfig(root);
    if (cfg && Array.isArray(cfg.redactionPatterns)) redactionPatterns = cfg.redactionPatterns;
  } catch (err) {
    log(`config read failed, proceeding with default redaction only: ${err.message}`);
  }

  // Seal the active view(s) ahead of shutdown. The optional stall is the
  // TEST_SEAL_HANG_MS test seam — it runs regardless of capture so the
  // timeout/watchdog paths can be tested under --no-capture (no Chromium).
  async function sealActiveViews() {
    if (TEST_SEAL_HANG_MS > 0) await new Promise((r) => setTimeout(r, TEST_SEAL_HANG_MS));
    if (capture) await capture.finalizeActiveViews();
  }

  // Capture hat — optional, lazy-attached only for browser capture.
  let capture = null;
  if (opts.capture) {
    capture = await attachCapture(store, {
      sessionDir,
      screenshotsDir: subs.screenshotsDir,
      browserProfile: subs.browserProfile,
      overlayInjectPath,
      log,
      redactionPatterns,
    });
    // If the user closes the entire capture browser, seal any active view the
    // same way `end` does (so an abrupt close still commits %-normalized,
    // console-editable screens), then exit cleanly. Skip if `end` is already
    // handling shutdown to avoid double-finalize.
    capture.onClose(async () => {
      if (ending) return;
      ending = true; // claim shutdown so a racing `end` doesn't double-finalize
      log('capture browser closed, sealing active views + exiting');
      const watchdog = setTimeout(() => {
        log('close watchdog fired — forcing exit');
        cleanup();
        process.exit(0);
      }, CLOSE_WATCHDOG_MS);
      watchdog.unref();
      await withTimeout(sealActiveViews(), SEAL_TIMEOUT_MS, 'finalizeActiveViews (close)');
      clearTimeout(watchdog);
      httpSrv.close();
      try { srv.close(); } catch {}
      cleanup();
      process.exit(0);
    });
  } else {
    log('capture disabled (--no-capture); serving console only');
  }

  openInBrowser(httpSrv.consoleUrl);

  // IPC: ping/status/end (lifecycle, talked to by cli.mjs).
  let ending = false;
  const srv = await ipcServer({
    sessionDir,
    socketPath: subs.computedSocket,
    handle: async (msg) => {
      if (ending) return { ready: false, ending: true };
      if (msg.type === 'ping') return { ready: true, consoleUrl: httpSrv.consoleUrl };
      if (msg.type === 'status') {
        return {
          consoleUrl: httpSrv.consoleUrl,
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
        // Watchdog: even if seal or artifact build wedges, force-exit so the
        // daemon can never become an un-endable zombie holding a headed
        // browser. Once `ending` latches, the guard above rejects every future
        // `end`, so without this the only recovery would be `kill`.
        const watchdog = setTimeout(() => {
          log('end watchdog fired — forcing exit');
          cleanup();
          process.exit(0);
        }, END_WATCHDOG_MS);
        watchdog.unref();
        await withTimeout(sealActiveViews(), SEAL_TIMEOUT_MS, 'finalizeActiveViews');
        await store.markEnded();
        await withTimeout(
          buildArtifact({ sessionDir, session: store.doc, outPath: subs.artifact }),
          SEAL_TIMEOUT_MS,
          'buildArtifact',
        );
        // Schedule shutdown after we've replied.
        setTimeout(async () => {
          clearTimeout(watchdog);
          if (capture) await withTimeout(capture.close(), CAPTURE_CLOSE_TIMEOUT_MS, 'capture.close');
          httpSrv.close();
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
  log(`listening on ${subs.socket}`);
  log(`console: ${httpSrv.consoleUrl}`);
}

main().catch((err) => {
  console.error('session-server: fatal', err);
  cleanup();
  process.exit(1);
});
