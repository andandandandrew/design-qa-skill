#!/usr/bin/env node
/**
 * /design-qa CLI — invoked by skill workflow steps.
 *
 * Subcommands:
 *   start --name <slug> --root <path>          spawn detached daemon
 *   end   --root <path> [--session <name|path>] end the active session
 *   status --root <path>                        list live sessions (debug)
 *
 * Prints a single JSON line on success. Exits non-zero with stderr on failure.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scriptsDir, timestampSlug, sessionSubPaths } from './lib/paths.mjs';
import { emptySession, newId, writeSession, readSession } from './lib/session.mjs';
import { request } from './lib/ipc.mjs';
import { readConfig, writeConfig, configPathFor, normalizeConfig } from './lib/config.mjs';

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = { _cmd: cmd };
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i];
    if (k.startsWith('--')) {
      const v = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true;
      opts[k.slice(2)] = v;
    }
  }
  return opts;
}

function die(msg, code = 1) {
  process.stderr.write(msg.endsWith('\n') ? msg : msg + '\n');
  process.exit(code);
}

async function ensureDir(p) {
  await fsp.mkdir(p, { recursive: true });
}

async function pollExists(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await fsp.stat(filePath); return true; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function cmdStart(opts) {
  const name = opts.name;
  if (!name || typeof name !== 'string') die('--name required');
  if (!NAME_RE.test(name)) die(`invalid name "${name}" (must match ${NAME_RE})`);
  const root = opts.root;
  if (!root) die('--root required');
  await ensureDir(root);

  // Phase 6: config-driven session identity. Init (`check-config` +
  // `write-config`) is the agent's responsibility in start.md; here we just
  // read the result. A missing config is a hard error pointing the user back
  // to the init step (sessions without an author muddy the audit trail).
  const config = await readConfig(root);
  if (!config) {
    die(
      `no design-qa.config.json at ${configPathFor(root)}\n` +
      `run \`/design-qa start\` again — the init step is responsible for creating it.`,
    );
  }

  const sessionDirName = `${timestampSlug()}-${name}`;
  const sessionDir = path.join(root, sessionDirName);
  await ensureDir(sessionDir);
  await ensureDir(path.join(sessionDir, 'screenshots'));

  const subs = sessionSubPaths(sessionDir);
  const session = emptySession({
    id: newId('sess'),
    name,
    sessionDir,
    author: config.author,
    project: config.project,
    stack: config.stack,
    captureMode: config.captureMode,
  });
  await writeSession(sessionDir, session);

  const logFd = fs.openSync(subs.logFile, 'a');
  const serverPath = path.join(scriptsDir, 'session-server.mjs');
  // `--no-capture` is a hidden flag for smoke tests / manual-only projects —
  // forwards to session-server so it serves the console without booting
  // Playwright/Chromium.
  const serverArgs = [serverPath, '--session-dir', sessionDir];
  if (opts['no-capture']) serverArgs.push('--no-capture');
  const child = spawn(process.execPath, serverArgs, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  child.unref();
  fs.closeSync(logFd);

  const socketReady = await pollExists(subs.socket, 30_000);
  if (!socketReady) {
    let logTail = '';
    try { logTail = (await fsp.readFile(subs.logFile, 'utf8')).slice(-2000); } catch {}
    die(`session server failed to start within 30s\n--- daemon.log tail ---\n${logTail}`);
  }

  let consoleUrl = null;
  try {
    const ping = await request(sessionDir, { type: 'ping' }, { timeoutMs: 5_000 });
    if (!ping.ready) die(`session server not ready: ${JSON.stringify(ping)}`);
    consoleUrl = ping.consoleUrl || null;
  } catch (err) {
    die(`session server ping failed: ${err.message}`);
  }

  process.stdout.write(JSON.stringify({ sessionDir, pid: child.pid, consoleUrl }) + '\n');
}

async function listLiveSessions(root) {
  let entries;
  try { entries = await fsp.readdir(root, { withFileTypes: true }); }
  catch { return []; }
  const live = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const sessionDir = path.join(root, ent.name);
    const subs = sessionSubPaths(sessionDir);
    try {
      const pidStr = await fsp.readFile(subs.pidFile, 'utf8');
      const pid = parseInt(pidStr.trim(), 10);
      if (!pid) continue;
      try { process.kill(pid, 0); } catch { continue; }
      const stat = await fsp.stat(sessionDir);
      live.push({ sessionDir, pid, ctimeMs: stat.ctimeMs });
    } catch {}
  }
  live.sort((a, b) => b.ctimeMs - a.ctimeMs);
  return live;
}

async function cmdEnd(opts) {
  const root = opts.root;
  if (!root) die('--root required');

  let sessionDir;
  if (opts.session) {
    if (typeof opts.session !== 'string') die('--session needs a value');
    sessionDir = path.isAbsolute(opts.session)
      ? opts.session
      : path.join(root, opts.session);
  } else {
    const live = await listLiveSessions(root);
    if (live.length === 0) die(`no live sessions under ${root}`);
    if (live.length > 1) {
      const names = live.map((s) => path.basename(s.sessionDir)).join('\n  ');
      die(`multiple live sessions, pass --session <name|path>:\n  ${names}`);
    }
    sessionDir = live[0].sessionDir;
  }

  let reply;
  try {
    reply = await request(sessionDir, { type: 'end' }, { timeoutMs: 30_000 });
  } catch (err) {
    const session = await readSession(sessionDir).catch(() => null);
    if (!session) die(`could not reach daemon and no session.json: ${err.message}`);
    const { buildArtifact } = await import('./artifact/build.mjs');
    const subs = sessionSubPaths(sessionDir);
    await buildArtifact({ sessionDir, session, outPath: subs.artifact });
    const viewCount = session.views.length;
    const pinCount = session.views.reduce((a, v) => a + v.pins.length, 0);
    process.stdout.write(
      JSON.stringify({
        sessionDir,
        artifact: subs.artifact,
        viewCount,
        pinCount,
        fallback: true,
        ipcError: err.message,
      }) + '\n',
    );
    return;
  }

  process.stdout.write(JSON.stringify({ sessionDir, ...reply }) + '\n');
}

async function cmdStatus(opts) {
  const root = opts.root;
  if (!root) die('--root required');
  const live = await listLiveSessions(root);
  process.stdout.write(JSON.stringify({ live }) + '\n');
}

async function cmdCheckConfig(opts) {
  const root = opts.root;
  if (!root) die('--root required');
  const configPath = configPathFor(root);
  const config = await readConfig(root);
  process.stdout.write(JSON.stringify({ exists: !!config, configPath, config }) + '\n');
}

async function cmdWriteConfig(opts) {
  const root = opts.root;
  if (!root) die('--root required');
  if (!opts.json || typeof opts.json !== 'string') die('--json required (serialized config object)');
  let parsed;
  try { parsed = JSON.parse(opts.json); }
  catch (err) { die(`--json is not valid JSON: ${err.message}`); }
  let normalized;
  try { normalized = normalizeConfig(parsed); }
  catch (err) { die(`invalid config: ${err.message}`); }
  const { configPath, config } = await writeConfig(root, normalized);
  process.stdout.write(JSON.stringify({ ok: true, configPath, config }) + '\n');
}

const opts = parseArgs(process.argv.slice(2));
const handlers = {
  start: cmdStart,
  end: cmdEnd,
  status: cmdStatus,
  'check-config': cmdCheckConfig,
  'write-config': cmdWriteConfig,
};
const handler = handlers[opts._cmd];
if (!handler) die(`unknown subcommand "${opts._cmd}". expected: start | end | status | check-config | write-config`);
handler(opts).catch((err) => die(err.stack || String(err)));
