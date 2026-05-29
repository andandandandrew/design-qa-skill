/**
 * Integration test — `end` shutdown is hang-proof (Bug B).
 *
 * Spawns the REAL session-server (via --no-capture, so no Chromium) with the
 * TEST_SEAL_HANG_MS seam set, then drives the lifecycle `end` over IPC and
 * proves the two safety layers actually fire end-to-end:
 *
 *   A. Seal-timeout layer: a seal that hangs longer than DESIGNQA_SEAL_TIMEOUT_MS
 *      is abandoned, the artifact is still built, `end` replies ok, and the
 *      daemon exits — no manual kill needed.
 *   B. Watchdog layer: if the hang outlasts even the seal timeout but the
 *      watchdog is shorter, the watchdog force-exits the daemon. (Models the
 *      thurs-3 zombie: a wedged seal that would otherwise latch `ending`
 *      forever and require `kill`.)
 *
 * Run: `node --test scripts/lib/__tests__/end-shutdown.test.mjs`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptySession, newId, writeSession } from '../session.mjs';
import { sessionSubPaths } from '../paths.mjs';
import { request } from '../ipc.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptsDir = path.resolve(__dirname, '../..');
const serverPath = path.join(scriptsDir, 'session-server.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Create a minimal session dir on disk (no daemon yet). */
async function makeSessionDir(name) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dqa-endshut-'));
  const sessionDir = path.join(root, `${name}`);
  await fsp.mkdir(path.join(sessionDir, 'screenshots'), { recursive: true });
  await writeSession(
    sessionDir,
    emptySession({ id: newId('sess'), name, sessionDir }),
  );
  return { root, sessionDir };
}

/** Spawn the real session-server detached-ish, returning the child + log path. */
function spawnDaemon(sessionDir, env) {
  const subs = sessionSubPaths(sessionDir);
  const logFd = fs.openSync(subs.logFile, 'a');
  const child = spawn(process.execPath, [serverPath, '--session-dir', sessionDir, '--no-capture'], {
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, NODE_NO_WARNINGS: '1', DESIGNQA_NO_OPEN: '1', ...env },
  });
  fs.closeSync(logFd);
  return child;
}

/** Poll the lifecycle socket with `ping` until the daemon answers ready. */
async function waitForReady(sessionDir, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const reply = await request(sessionDir, { type: 'ping' }, { timeoutMs: 1_000 });
      if (reply.ready) return;
    } catch {}
    await sleep(100);
  }
  throw new Error('daemon never became ready');
}

/** Resolve when the child process exits, or reject on timeout. */
function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(child.exitCode);
    const t = setTimeout(() => reject(new Error(`process still alive after ${timeoutMs}ms`)), timeoutMs);
    child.once('exit', (code) => { clearTimeout(t); resolve(code); });
  });
}

async function cleanupDir(root) {
  await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
}

test('end completes despite a seal that outlasts the seal timeout (timeout layer)', async (t) => {
  const { root, sessionDir } = await makeSessionDir('seal-timeout');
  const subs = sessionSubPaths(sessionDir);
  // Seal hangs 4s; seal timeout is 300ms; watchdog left huge so it can't be the
  // thing that ends us — the seal-timeout must carry the shutdown.
  const child = spawnDaemon(sessionDir, {
    DESIGNQA_TEST_SEAL_HANG_MS: '4000',
    DESIGNQA_SEAL_TIMEOUT_MS: '300',
    DESIGNQA_END_WATCHDOG_MS: '60000',
  });
  t.after(async () => { try { child.kill('SIGKILL'); } catch {} await cleanupDir(root); });

  await waitForReady(sessionDir);
  const startedAt = Date.now();
  // end replies AFTER seal+build; with the 300ms seal timeout it returns fast.
  const reply = await request(sessionDir, { type: 'end' }, { timeoutMs: 10_000 });
  const elapsed = Date.now() - startedAt;

  assert.equal(reply.ok, true, 'end replied ok');
  assert.equal(reply.artifact, subs.artifact, 'reply carries the artifact path');
  assert.ok(elapsed < 3_000, `end returned before the 4s hang would have (took ${elapsed}ms)`);

  await waitForExit(child, 10_000);
  assert.ok(fs.existsSync(subs.artifact), 'artifact.html was built');

  const logTxt = await fsp.readFile(subs.logFile, 'utf8');
  assert.match(logTxt, /finalizeActiveViews timed out after 300ms/, 'seal timeout logged');
  assert.doesNotMatch(logTxt, /watchdog fired/, 'watchdog did NOT fire (timeout layer handled it)');
});

test('watchdog force-exits when a hang outlasts even the seal timeout (watchdog layer)', async (t) => {
  const { root, sessionDir } = await makeSessionDir('watchdog');
  const subs = sessionSubPaths(sessionDir);
  // Seal hangs 30s; seal timeout 8s; watchdog 600ms => the watchdog is the
  // shortest fuse and must force-exit before the seal timeout would resolve.
  const child = spawnDaemon(sessionDir, {
    DESIGNQA_TEST_SEAL_HANG_MS: '30000',
    DESIGNQA_SEAL_TIMEOUT_MS: '8000',
    DESIGNQA_END_WATCHDOG_MS: '600',
  });
  t.after(async () => { try { child.kill('SIGKILL'); } catch {} await cleanupDir(root); });

  await waitForReady(sessionDir);
  // The daemon force-exits without replying, so the request closes without a
  // reply — that's expected; the real assertions are "process died fast" + log.
  await request(sessionDir, { type: 'end' }, { timeoutMs: 10_000 }).catch(() => {});

  const exitedWithin = await waitForExit(child, 5_000)
    .then(() => true)
    .catch(() => false);
  assert.ok(exitedWithin, 'daemon exited via watchdog, well before the 30s hang');

  const logTxt = await fsp.readFile(subs.logFile, 'utf8');
  assert.match(logTxt, /end watchdog fired — forcing exit/, 'watchdog fired and logged');

  // And the zombie symptom is gone: lifecycle files cleaned up on exit.
  assert.ok(!fs.existsSync(subs.pidFile), 'daemon.pid removed');
  assert.ok(!fs.existsSync(subs.socketPointer), 'daemon.sock pointer removed');
});
