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

let cleanupRan = false;
function cleanup() {
  if (cleanupRan) return;
  cleanupRan = true;
  for (const f of [subs.socket, subs.pidFile, subs.consoleUrlFile]) {
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

  const store = await SessionStore.load(sessionDir);
  log(`loaded session ${store.doc.id} (${store.doc.name})`);

  // Console hat — always on, independent of any browser.
  const httpSrv = await startHttpServer(store, { sessionDir, consoleDir, log });
  fs.writeFileSync(subs.consoleUrlFile, httpSrv.consoleUrl);

  // Capture hat — optional, lazy-attached only for browser capture.
  let capture = null;
  if (opts.capture) {
    capture = await attachCapture(store, {
      sessionDir,
      screenshotsDir: subs.screenshotsDir,
      browserProfile: subs.browserProfile,
      overlayInjectPath,
      log,
    });
    // If the user closes the entire capture browser, seal any active view the
    // same way `end` does (so an abrupt close still commits %-normalized,
    // console-editable screens), then exit cleanly. Skip if `end` is already
    // handling shutdown to avoid double-finalize.
    capture.onClose(async () => {
      if (ending) return;
      log('capture browser closed, sealing active views + exiting');
      try { await capture.finalizeActiveViews(); }
      catch (e) { log(`finalize on close failed: ${e.message}`); }
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
        if (capture) await capture.finalizeActiveViews();
        await store.markEnded();
        await buildArtifact({ sessionDir, session: store.doc, outPath: subs.artifact });
        // Schedule shutdown after we've replied.
        setTimeout(async () => {
          if (capture) await capture.close();
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
