import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const scriptsDir = path.resolve(here, '..');
export const overlayInjectPath = path.join(scriptsDir, 'overlay', 'inject.js');
export const artifactBuilderPath = path.join(scriptsDir, 'artifact', 'build.mjs');

// macOS caps Unix-domain socket paths at ~104 bytes, so we can't put the socket
// inside a deeply-nested session dir. Derive a short, stable name in os.tmpdir()
// from the absolute sessionDir so the daemon and CLI agree without coordination.
function socketPathFor(sessionDir) {
  const hash = crypto.createHash('sha1').update(path.resolve(sessionDir)).digest('hex').slice(0, 12);
  return path.join(os.tmpdir(), `dqa-${hash}.sock`);
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
    pidFile: path.join(sessionDir, 'daemon.pid'),
    logFile: path.join(sessionDir, 'daemon.log'),
    browserProfile: path.join(sessionDir, 'browser-profile'),
    screenshotsDir: path.join(sessionDir, 'screenshots'),
    artifact: path.join(sessionDir, 'artifact.html'),
  };
}
