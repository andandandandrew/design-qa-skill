/**
 * design-qa.config.json — per-working-directory configuration.
 *
 * Holds project identity, stack, derived captureMode, and author. The session
 * server reads this once at `start` and stamps the resulting session.json so
 * every pin (browser-overlay or console) carries the configured author and the
 * doc carries project context for the artifact handoff.
 *
 * Lives at `<workingDir>/design-qa.config.json` (the working dir is the parent
 * of `<root>` = `<cwd>/design-qa-sessions/`), so it survives across sessions
 * and isn't entangled with any one session's data.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const CONFIG_BASENAME = 'design-qa.config.json';
const CONFIG_VERSION = 1;

/** Absolute config path for a given `--root` (the design-qa-sessions/ dir). */
export function configPathFor(root) {
  return path.join(path.dirname(path.resolve(root)), CONFIG_BASENAME);
}

/**
 * Map a free-form stack string to a functional captureMode. The free-form
 * value is preserved on disk; this derivation is recomputed at write time so
 * the captureMode field stays in sync with the stack the user typed.
 *
 * Anything that looks like a native/mobile/non-browser environment → 'manual';
 * everything else defaults to 'browser' (web). Conservative on purpose — a
 * mismatched derivation just means starting in the wrong mode, which the user
 * can correct by editing the JSON.
 */
export function deriveCaptureMode(stack) {
  if (!stack || typeof stack !== 'string') return 'browser';
  return /react native|\bnative\b|mobile|ios|android|expo|manual/i.test(stack)
    ? 'manual'
    : 'browser';
}

/** Parse the config at `<workingDir>/design-qa.config.json`. Returns null if absent. */
export async function readConfig(root) {
  const p = configPathFor(root);
  let raw;
  try { raw = await fs.readFile(p, 'utf8'); }
  catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  try { return JSON.parse(raw); }
  catch (err) { throw new Error(`design-qa.config.json is not valid JSON: ${err.message}`); }
}

/**
 * Atomically write a normalized config. Accepts a partial object; fills in
 * version + derived captureMode + author shape. Validates that a project
 * name and author name are present (the two values the agent-driven init
 * always collects).
 */
export async function writeConfig(root, cfg) {
  const normalized = normalizeConfig(cfg);
  const p = configPathFor(root);
  const tmp = p + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(normalized, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, p);
  return { configPath: p, config: normalized };
}

export function normalizeConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') throw new Error('config must be an object');
  const project = (cfg.project || '').trim();
  if (!project) throw new Error('config.project is required');
  const stack = (cfg.stack || '').trim();
  const captureMode = cfg.captureMode === 'browser' || cfg.captureMode === 'manual'
    ? cfg.captureMode
    : deriveCaptureMode(stack);
  const authorIn = cfg.author && typeof cfg.author === 'object' ? cfg.author : {};
  const name = (authorIn.name || '').trim();
  if (!name) throw new Error('config.author.name is required');
  const email = authorIn.email ? String(authorIn.email).trim() || null : null;
  const redactionPatterns = normalizeRedactionPatterns(cfg.redactionPatterns);
  return {
    version: CONFIG_VERSION,
    project,
    stack,
    captureMode,
    author: { name, email },
    // Spike 8 — optional additive regex patterns layered on top of the built-in
    // defaults in lib/redact.mjs. Stored as strings (JSON-friendly); compiled
    // case-insensitive at recorder-attach time. Empty array = use defaults only.
    redactionPatterns,
  };
}

/**
 * Coerce arbitrary user input into an array of non-empty pattern strings.
 * Forgiving: accepts a single string, an array of strings, or nothing. Drops
 * empty/non-string entries. Does NOT compile the patterns — that happens at
 * use site (lib/redact.mjs), so a malformed regex surfaces with a useful
 * error at recorder start rather than at config save.
 */
function normalizeRedactionPatterns(input) {
  if (input == null) return [];
  const arr = Array.isArray(input) ? input : [input];
  const out = [];
  for (const v of arr) {
    if (typeof v !== 'string') continue;
    const trimmed = v.trim();
    if (trimmed) out.push(trimmed);
  }
  return out;
}
