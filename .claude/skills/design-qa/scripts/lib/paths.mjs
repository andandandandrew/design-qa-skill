import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const scriptsDir = path.resolve(here, '..');
export const overlayInjectPath = path.join(scriptsDir, 'overlay', 'inject.js');
export const artifactBuilderPath = path.join(scriptsDir, 'artifact', 'build.mjs');
// The buildless console assets the session server serves over localhost.
export const consoleDir = path.join(scriptsDir, 'console');

// macOS caps Unix-domain socket paths at ~104 bytes, so we can't put the socket
// inside a deeply-nested session dir. Derive a short, stable name in os.tmpdir()
// from the absolute sessionDir.
function computedSocketPath(sessionDir) {
  const hash = crypto.createHash('sha1').update(path.resolve(sessionDir)).digest('hex').slice(0, 12);
  return path.join(os.tmpdir(), `dqa-${hash}.sock`);
}

// The daemon writes the socket path it actually bound into this pointer file at
// startup. `os.tmpdir()` is not stable across processes — if TMPDIR differs
// between the `start` that spawned the daemon and a later CLI invocation (e.g.
// an agent harness that sets TMPDIR=/tmp/... while the daemon booted with the
// macOS default /var/folders/...), recomputing the path would silently miss the
// live socket and fall back to a degraded rebuild. Reading the pointer keeps the
// CLI and daemon in agreement regardless of either one's tmpdir.
function pointerPathFor(sessionDir) {
  return path.join(sessionDir, 'daemon.sock');
}

function socketPathFor(sessionDir) {
  try {
    const p = fs.readFileSync(pointerPathFor(sessionDir), 'utf8').trim();
    if (p) return p;
  } catch {}
  return computedSocketPath(sessionDir);
}

export function timestampSlug(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear().toString() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    '-' +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

export function sessionSubPaths(sessionDir) {
  return {
    sessionJson: path.join(sessionDir, 'session.json'),
    socket: socketPathFor(sessionDir),
    // The path the daemon binds (computed from *its* tmpdir) and writes to the
    // pointer file, so the CLI can recover it without re-deriving from its own.
    computedSocket: computedSocketPath(sessionDir),
    socketPointer: pointerPathFor(sessionDir),
    pidFile: path.join(sessionDir, 'daemon.pid'),
    logFile: path.join(sessionDir, 'daemon.log'),
    // The live console URL for this session, written by the session server so
    // sibling servers can list it (the session switcher). Removed on exit.
    consoleUrlFile: path.join(sessionDir, 'console.url'),
    browserProfile: path.join(sessionDir, 'browser-profile'),
    screenshotsDir: path.join(sessionDir, 'screenshots'),
    artifact: path.join(sessionDir, 'artifact.html'),
  };
}
