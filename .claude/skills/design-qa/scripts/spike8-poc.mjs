#!/usr/bin/env node
/**
 * SPIKE 8 — Interaction-recording POC (throwaway).
 *
 * Validates the mechanism choice in _kickoff-docs/design-qa-interaction-recording.md:
 *   - Playwright's programmatic Recorder (context._enableRecorder + recorderMode:'api')
 *     is reachable inside our launchPersistentContext setup, with NO Inspector window.
 *   - Each captured action carries BOTH structured ActionInContext JSON AND a .ts
 *     snippet — the dual-output the doc relies on for view #1 (raw script) and
 *     view #2 (linear "user did X → Y → Z").
 *
 * NOT shipped to users. Run directly with `node spike8-poc.mjs`. Standalone — does
 * not touch the production capture path (lib/capture.mjs, session-server.mjs).
 *
 * Lifecycle:
 *   1. Launch headed Chromium with the same launchPersistentContext args as
 *      lib/capture.mjs (per-spike profile dir; cookies persist across runs).
 *   2. Always-on recording from the moment Chromium launches.
 *   3. stdin commands while running:
 *        m + Enter   → "Mark start of feedback" (boundary between preconditions
 *                      and the recorded path). Re-marking moves it forward.
 *        q + Enter   → Stop recording, write outputs, close browser.
 *        s + Enter   → Print current capture status to terminal (debug).
 *      Ctrl-C / browser-close also writes outputs cleanly.
 *   4. On stop, writes ./spike8-poc-out/<timestamp>/:
 *        recording.spec.ts      — concatenated .ts code (engineer-runnable)
 *        recording.json         — full structured stream (mark boundary, segments)
 *        steps.md               — rendered "user did X → Y → Z" with URL dividers
 *        index.html             — two-pane viewer (raw .ts | linear steps)
 *        replay-result.txt      — outcome of automatic replay round-trip
 *
 * "What else" beyond capture (per approved POC scope):
 *   - Replay round-trip: re-runs the captured actions against a FRESH context
 *     and reports whether they reproduce the final URL.
 *   - Selector-quality counter: tallies getByRole/getByLabel/getByText vs CSS.
 *   - URL-segmentation markers: linear view groups steps by frameNavigated.
 *   - Mark-start toggle: preconditions[] vs path[] split.
 */
import { chromium } from 'playwright';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POC_ROOT = path.join(__dirname, 'spike8-poc-out');
const PROFILE_DIR = path.join(POC_ROOT, '.profile');
const STARTING_URL = process.argv[2] || 'about:blank';

// ---------- recording state ----------

/** @type {Array<{ kind:'action'|'signal', t:number, data:any, code:string, pageUrl:string }>} */
const events = [];
let markIndex = -1;  // index in `events` of the first post-Mark-start event; -1 = unmarked
let startedAt = null;

// ---------- secrets redaction ----------
//
// The recorder's structured action data carries raw filled values in THREE
// places: action.text (the typed value), the .ts `code` snippet, and the
// `ariaSnapshot` ARIA-tree string (which lists every visible input's CURRENT
// value, so a password typed in step 3 still appears in every snapshot from
// step 4 onward). All three need scrubbing.
//
// Approach: on every fill, if the selector's `name="…"` matches the secrets
// pattern below, treat the typed value as a secret. Maintain a redaction map
// keyed by the raw value (so collisions across actions converge), record the
// human-readable field name for env-var emission, and run a forward+retroactive
// `replaceAll` across stored events any time a new secret is added. Cheap,
// catches the common cases, doesn't surprise reviewers on normal fills.
const SECRET_NAME_RE = /password|pwd|secret|token|api[ _-]?key|otp|2fa|cvv|ssn|credit[ _-]?card/i;
/** Map<rawValue, envVarName> — one entry per distinct secret encountered. */
const redactionMap = new Map();

function nameFromSelector(selector) {
  const m = /\[name="((?:[^"\\]|\\.)*)"/i.exec(selector || '');
  return m ? m[1] : '';
}
function envVarFor(fieldName) {
  const slug = String(fieldName || 'FIELD').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'FIELD';
  let base = `DESIGN_QA_FIELD_${slug}`;
  let i = 2;
  let candidate = base;
  // Ensure uniqueness across different fields that share a normalized name.
  const taken = new Set(redactionMap.values());
  while (taken.has(candidate)) candidate = `${base}_${i++}`;
  return candidate;
}

/** Walk an arbitrary value (deep) and string-replace every known secret. */
function scrubValue(v) {
  if (v == null) return v;
  if (typeof v === 'string') {
    let out = v;
    for (const [raw, envVar] of redactionMap) {
      if (!raw) continue;
      // In the emitted .ts, the value is quoted: '…'. Replace the quoted form
      // with process.env.<…> ?? '' so the script stays syntactically valid.
      out = out.split(`'${raw}'`).join(`process.env.${envVar} ?? ''`);
      out = out.split(`"${raw}"`).join(`process.env.${envVar} ?? ''`);
      // Also scrub bare occurrences (ariaSnapshot, action.text, step text).
      out = out.split(raw).join(`[REDACTED ${envVar}]`);
    }
    return out;
  }
  if (Array.isArray(v)) return v.map(scrubValue);
  if (typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) out[k] = scrubValue(v[k]);
    return out;
  }
  return v;
}

/** Scrub every previously-captured event (in-place) after a new secret lands. */
function scrubAllEvents() {
  for (const e of events) {
    e.code = scrubValue(e.code);
    e.data = scrubValue(e.data);
  }
}

/**
 * Inspect a fill event and, if the field name matches the secrets pattern,
 * register the value in the redaction map. Returns true if a new secret was
 * added (caller can decide whether to retroactively scrub).
 *
 * The recorder fires progressive actionUpdated events as the user types
 * ("S" → "SE" → "SEC" → …), so we'd otherwise register a separate entry per
 * keystroke and then `split('S').join(REDACTED)` would explode string length
 * by replacing every "S" in selectors/snapshots. Two mitigations:
 *   1. Minimum length (>= 4 chars) — single characters collide with normal text.
 *   2. Prefix-collapse — when a new value K extends an existing prefix K',
 *      drop K' and keep K. The map converges on the final full value only.
 */
const MIN_SECRET_LEN = 4;
function maybeRegisterSecret(action) {
  if (!action || action.name !== 'fill') return false;
  const fieldName = nameFromSelector(action.selector);
  if (!fieldName || !SECRET_NAME_RE.test(fieldName)) return false;
  const raw = action.text ?? action.value ?? '';
  if (!raw || raw.length < MIN_SECRET_LEN) return false;
  if (redactionMap.has(raw)) return false;
  // Collapse: drop any existing key that is a prefix of `raw` (= in-progress
  // typing of the same secret) AND any existing key for which `raw` is a prefix
  // (= an actionUpdated arriving out of order — shouldn't happen but cheap).
  for (const existing of [...redactionMap.keys()]) {
    if (raw.startsWith(existing) || existing.startsWith(raw)) redactionMap.delete(existing);
  }
  redactionMap.set(raw, envVarFor(fieldName));
  console.log(`[poc] secret detected in field "${fieldName}" → redacting (env var: ${redactionMap.get(raw)})`);
  return true;
}

function status() {
  const total = events.length;
  const post = markIndex >= 0 ? total - markIndex : 0;
  const pre = markIndex >= 0 ? markIndex : total;
  return { total, pre, post, marked: markIndex >= 0 };
}

// ---------- main ----------

async function main() {
  await fsp.mkdir(PROFILE_DIR, { recursive: true });
  console.log(`[poc] launching Chromium with profile ${PROFILE_DIR}`);
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: null,
    args: ['--no-first-run', '--no-default-browser-check'],
  });

  startedAt = Date.now();

  // The critical call: programmatic recorder, no Inspector window, structured events.
  // `recorderMode: 'api'` routes through ProgrammaticRecorderApp; the eventSink
  // receives every action as it lands.
  await context._enableRecorder(
    {
      language: 'playwright-test',
      launchOptions: { headless: false },
      contextOptions: {},
      mode: 'recording',
      recorderMode: 'api',
      testIdAttributeName: 'data-testid',
      handleSIGINT: false,
    },
    {
      actionAdded(page, data, code) {
        const added = maybeRegisterSecret(data?.action);
        const ev = { kind: 'action', t: Date.now() - startedAt, data, code, pageUrl: safeUrl(page) };
        events.push(ev);
        if (added) scrubAllEvents();
        else {
          ev.code = scrubValue(ev.code);
          ev.data = scrubValue(ev.data);
        }
      },
      actionUpdated(page, data, code) {
        // The recorder merges actions (e.g. consecutive fills into one). When that
        // happens we get an "actionUpdated" carrying the merged form, AFTER an
        // earlier "actionAdded" for the first keystroke. Replace the most recent
        // action event so the final stream reflects the coalesced form. Run
        // secret detection again because the merged value is the full string.
        const added = maybeRegisterSecret(data?.action);
        const ev = { kind: 'action', t: Date.now() - startedAt, data, code, pageUrl: safeUrl(page) };
        for (let i = events.length - 1; i >= 0; i--) {
          if (events[i].kind === 'action') { events[i] = ev; break; }
        }
        if (added) scrubAllEvents();
        else {
          ev.code = scrubValue(ev.code);
          ev.data = scrubValue(ev.data);
        }
      },
      signalAdded(page, data) {
        // Navigation/popup/download signals — record but don't emit code.
        const ev = { kind: 'signal', t: Date.now() - startedAt, data: scrubValue(data), code: '', pageUrl: safeUrl(page) };
        events.push(ev);
      },
    },
  );

  console.log(`[poc] recorder active (mode=api). No Inspector window should appear.`);
  console.log(`[poc] commands: m=mark-start  q=quit+write  s=status  (or Ctrl-C, or close the browser)`);

  // Open the starting page so the reviewer has somewhere to begin.
  if (context.pages().length === 0) await context.newPage();
  const firstPage = context.pages()[0];
  if (STARTING_URL !== 'about:blank') await firstPage.goto(STARTING_URL).catch(() => {});

  // Browser-close → finalize cleanly.
  let finalizing = false;
  const finalize = async (reason) => {
    if (finalizing) return;
    finalizing = true;
    console.log(`[poc] finalizing (${reason})`);
    try { await writeOutputs(); } catch (err) { console.error('[poc] write failed:', err); }
    try { await context.close(); } catch {}
    process.exit(0);
  };
  context.on('close', () => finalize('browser-closed'));
  process.on('SIGINT', () => finalize('SIGINT'));

  // stdin loop for mark-start / status / quit.
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const cmd = line.trim().toLowerCase();
    if (cmd === 'm') {
      markIndex = events.length;
      console.log(`[poc] mark-start set at event #${markIndex} (${status().pre} preconditions, recording starts now)`);
    } else if (cmd === 'q') {
      finalize('q-command');
    } else if (cmd === 's') {
      const s = status();
      console.log(`[poc] status — ${s.total} events captured (${s.pre} pre-mark, ${s.post} post-mark, marked=${s.marked})`);
    }
  });
}

function safeUrl(page) {
  try { return page?.url() || ''; } catch { return ''; }
}

// ---------- outputs ----------

async function writeOutputs() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(POC_ROOT, stamp);
  await fsp.mkdir(outDir, { recursive: true });

  const actions = events.filter((e) => e.kind === 'action');
  const preconditions = markIndex >= 0 ? actions.filter((_, i) => events.indexOf(actions[i]) < markIndex) : [];
  const pathActions = markIndex >= 0
    ? actions.filter((_, i) => events.indexOf(actions[i]) >= markIndex)
    : actions; // unmarked → treat everything as the path

  console.log(`[poc] writing outputs to ${outDir}`);
  console.log(`[poc]   ${actions.length} actions total · ${preconditions.length} preconditions · ${pathActions.length} on path`);

  // recording.spec.ts — playwright-test format the engineer can run.
  const spec = buildSpec(pathActions, preconditions);
  await fsp.writeFile(path.join(outDir, 'recording.spec.ts'), spec, 'utf8');

  // recording.json — the structured stream + mark boundary, lossless.
  const json = {
    capturedAt: new Date().toISOString(),
    startingUrl: STARTING_URL,
    markIndex,
    events,
    selectorQuality: tallySelectorQuality(pathActions),
  };
  await fsp.writeFile(path.join(outDir, 'recording.json'), JSON.stringify(json, null, 2), 'utf8');

  // steps.md — the "user did X → Y → Z" linear view with URL segment dividers.
  const md = buildStepsMd(pathActions, preconditions);
  await fsp.writeFile(path.join(outDir, 'steps.md'), md, 'utf8');

  // index.html — two-pane viewer (raw .ts | linear steps) + selector-quality stats.
  const html = buildViewerHtml({ spec, md, json });
  await fsp.writeFile(path.join(outDir, 'index.html'), html, 'utf8');

  // Replay round-trip. Skip if no path actions (unmarked + zero capture).
  if (pathActions.length > 0) {
    const result = await replayPath(pathActions);
    await fsp.writeFile(path.join(outDir, 'replay-result.txt'), result.text, 'utf8');
    console.log(`[poc] replay: ${result.headline}`);
  } else {
    await fsp.writeFile(path.join(outDir, 'replay-result.txt'), 'SKIPPED — no path actions captured.\n', 'utf8');
  }

  console.log(`[poc] open ./${path.relative(process.cwd(), path.join(outDir, 'index.html'))}`);
}

// ---------- view #1: recording.spec.ts ----------

function buildSpec(pathActions, preconditions) {
  const head = [
    `// Generated by spike8-poc.mjs at ${new Date().toISOString()}.`,
    `// Reproduces the state the QA reviewer reached when they pressed Mark-start.`,
    ``,
  ];
  if (redactionMap.size > 0) {
    head.push(
      `// REDACTED VALUES — set these env vars before running the spec.`,
      `// The recorder captured values in fields whose names matched secrets/PII`,
      `// patterns (password, token, api_key, …). They've been replaced with`,
      `// \`process.env.<NAME> ?? ''\` so this file is safe to share/commit.`,
    );
    const seenVars = new Set();
    for (const envVar of redactionMap.values()) {
      if (seenVars.has(envVar)) continue;
      seenVars.add(envVar);
      head.push(`//   ${envVar}`);
    }
    head.push(``);
  }
  head.push(
    `import { test, expect } from '@playwright/test';`,
    ``,
    `test('Reproduce: design-QA recording', async ({ page }) => {`,
    `  // === PRECONDITIONS ===`,
    `  // The reviewer was already logged in / set up when they pressed Mark-start.`,
    `  // Replace this block with your own login fixture, storageState, or env-driven`,
    `  // setup. The recorded preconditions below are SUGGESTIONS, not portable as-is:`,
  );
  if (preconditions.length === 0) {
    head.push(`  //   (none captured before Mark-start)`);
  } else {
    for (const a of preconditions) head.push(...indentCode(a.code, '  // '));
  }
  head.push(``, `  // === RECORDED PATH ===`);

  let lastUrl = null;
  for (const a of pathActions) {
    if (a.pageUrl && a.pageUrl !== lastUrl) {
      head.push(``, `  // --- ${a.pageUrl} ---`);
      lastUrl = a.pageUrl;
    }
    head.push(...indentCode(a.code, '  '));
  }
  head.push(`});`, ``);
  return head.join('\n');
}

function indentCode(code, prefix) {
  return String(code).split('\n').map((l) => prefix + l);
}

// ---------- view #2: steps.md ----------

function buildStepsMd(pathActions, preconditions) {
  const out = [
    `# Recorded steps`,
    ``,
    `**Captured:** ${new Date().toISOString()}`,
    `**Total actions on path:** ${pathActions.length}`,
    ``,
    `## Preconditions`,
    ``,
    `> Set this up however your project handles auth/state — the reviewer was`,
    `> already logged in when they pressed Mark-start. The actions below were`,
    `> captured *before* the mark and serve as hints only.`,
    ``,
  ];
  if (preconditions.length === 0) out.push(`_None captured before Mark-start._`, ``);
  else preconditions.forEach((a, i) => out.push(`${i + 1}. ${describeAction(a.data)}  \`${oneLine(a.code)}\``));

  out.push(``, `## Steps`, ``);

  let lastUrl = null;
  let n = 0;
  for (const a of pathActions) {
    if (a.pageUrl && a.pageUrl !== lastUrl) {
      out.push(``, `**On \`${a.pageUrl}\`:**`, ``);
      lastUrl = a.pageUrl;
    }
    n += 1;
    out.push(`${n}. ${describeAction(a.data)}`);
  }
  out.push(``);
  return out.join('\n');
}

/**
 * Render one structured ActionInContext into a human sentence. Falls back to
 * a JSON dump for kinds we haven't named — exposes coverage gaps in the POC.
 */
function describeAction(data) {
  // ActionInContext shape: { frame, action: { name, selector, url?, value?, ... }, ... }
  const a = data?.action || {};
  const name = a.name;
  const label = a.selector ? selectorLabel(a.selector) : '';
  switch (name) {
    case 'openPage':
    case 'navigate':
      return `Go to \`${a.url || ''}\``;
    case 'click':
      return `Click ${label || 'an element'}`;
    case 'dblclick':
      return `Double-click ${label || 'an element'}`;
    case 'fill':
      return `Type \`${a.text ?? a.value ?? ''}\` into ${label || 'an input'}`;
    case 'press':
      return `Press \`${a.key || ''}\``;
    case 'select':
      return `Pick \`${(a.options || a.value || []).toString()}\` from ${label || 'a dropdown'}`;
    case 'check':
      return `Check ${label || 'the box'}`;
    case 'uncheck':
      return `Uncheck ${label || 'the box'}`;
    case 'closesPage':
      return `Close the page`;
    case 'setInputFiles':
      return `Upload file(s) into ${label || 'an input'}`;
    default:
      return `_(${name || 'unknown action'})_ \`${JSON.stringify(a).slice(0, 200)}\``;
  }
}

/**
 * Extract a human label from a Playwright locator string. Recognizes the
 * common semantic forms — getByRole / getByLabel / getByText / getByPlaceholder
 * / getByTestId — and falls back to the raw selector for CSS/XPath.
 */
function selectorLabel(sel) {
  if (!sel) return '';
  // Playwright internal selector forms — quoted-content regex is intentionally
  // permissive (escaped backslashes inside the captured string are fine for our
  // human-readable rendering; we're not trying to parse them perfectly).
  let m;
  m = /internal:role=([a-z]+)\[name="((?:[^"\\]|\\.)*)"/i.exec(sel);
  if (m) return `the **${m[2]}** ${m[1]}`;
  m = /internal:role=([a-z]+)/i.exec(sel);
  if (m) return `a **${m[1]}**`;
  m = /internal:label="((?:[^"\\]|\\.)*)"/i.exec(sel);
  if (m) return `the **${m[1]}** field`;
  m = /internal:text="((?:[^"\\]|\\.)*)"/i.exec(sel);
  if (m) return `**${m[1]}**`;
  m = /internal:testid=\[data-testid=["']?([^\]"']+)/i.exec(sel);
  if (m) return `the **${m[1]}** element`;
  m = /internal:attr=\[placeholder=["']?([^\]"']+)/i.exec(sel);
  if (m) return `the **${m[1]}** field`;
  return `\`${sel.length > 60 ? sel.slice(0, 57) + '…' : sel}\``;
}

function tallySelectorQuality(actions) {
  const counts = { getByRole: 0, getByLabel: 0, getByText: 0, getByTestId: 0, getByPlaceholder: 0, css: 0, noSelector: 0 };
  for (const a of actions) {
    const sel = a.data?.action?.selector || '';
    if (!sel) counts.noSelector += 1;
    else if (sel.includes('internal:role=')) counts.getByRole += 1;
    else if (sel.includes('internal:label=')) counts.getByLabel += 1;
    else if (sel.includes('internal:text=')) counts.getByText += 1;
    else if (sel.includes('internal:testid=')) counts.getByTestId += 1;
    else if (sel.includes('internal:attr=[placeholder=')) counts.getByPlaceholder += 1;
    else counts.css += 1;
  }
  return counts;
}

function oneLine(s) { return String(s).replace(/\s+/g, ' ').trim(); }

// ---------- view: index.html (two-pane) ----------

function buildViewerHtml({ spec, md, json }) {
  const q = json.selectorQuality;
  const total = Object.values(q).reduce((a, b) => a + b, 0);
  const pct = (n) => total ? `${Math.round((n / total) * 100)}%` : '0%';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Spike 8 POC — recording viewer</title>
<style>
  :root {
    --bg: #1e1e1e; --bg-2: #2c2c2c; --bg-3: #383838; --border: #3d3d3d;
    --text: #eee; --text-2: #a0a0a0; --accent: #0d99ff;
  }
  html, body { background: var(--bg); color: var(--text); margin: 0; height: 100%;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 13px; }
  .topbar { padding: 10px 16px; border-bottom: 1px solid var(--border); display: flex; gap: 16px; align-items: center; }
  .topbar h1 { font-size: 14px; margin: 0; font-weight: 600; }
  .topbar .stat { color: var(--text-2); font-size: 12px; }
  .topbar .stat b { color: var(--text); }
  .panes { display: grid; grid-template-columns: 1fr 1fr; height: calc(100vh - 49px); }
  .pane { overflow: auto; }
  .pane + .pane { border-left: 1px solid var(--border); }
  .pane-header {
    position: sticky; top: 0; background: var(--bg-2); border-bottom: 1px solid var(--border);
    padding: 8px 16px; font-size: 12px; color: var(--text-2); font-weight: 600;
  }
  .pane pre { margin: 0; padding: 16px; font-family: 'JetBrains Mono', 'SF Mono', Menlo, monospace;
    font-size: 12px; line-height: 1.55; white-space: pre-wrap; }
  .md { padding: 16px 24px; }
  .md h1 { font-size: 18px; }
  .md h2 { font-size: 14px; margin-top: 28px; color: var(--text-2); }
  .md code { background: var(--bg-3); padding: 1px 5px; border-radius: 3px; font-size: 12px; }
  .md ol, .md ul { padding-left: 24px; }
  .md li { margin-bottom: 6px; }
  .md blockquote { border-left: 3px solid var(--accent); padding-left: 12px; color: var(--text-2); margin: 12px 0; }
</style>
</head>
<body>
<div class="topbar">
  <h1>Spike 8 POC — recording</h1>
  <div class="stat">Captured <b>${total}</b> action${total === 1 ? '' : 's'}</div>
  <div class="stat">getByRole <b>${q.getByRole}</b> (${pct(q.getByRole)})</div>
  <div class="stat">getByLabel/Text/Placeholder <b>${q.getByLabel + q.getByText + q.getByPlaceholder}</b></div>
  <div class="stat">getByTestId <b>${q.getByTestId}</b></div>
  <div class="stat">CSS/other <b>${q.css}</b> (${pct(q.css)})</div>
  <div class="stat">no-selector <b>${q.noSelector}</b></div>
</div>
<div class="panes">
  <div class="pane">
    <div class="pane-header">recording.spec.ts  &middot;  view #1</div>
    <pre>${escapeHtml(spec)}</pre>
  </div>
  <div class="pane">
    <div class="pane-header">linear steps  &middot;  view #2</div>
    <div class="md">${renderMarkdown(md)}</div>
  </div>
</div>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Tiny markdown renderer — just enough for the POC viewer. Not a full parser. */
function renderMarkdown(md) {
  const lines = md.split('\n');
  const out = [];
  let inList = false;
  const inline = (s) => escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/_([^_]+)_/g, '<em>$1</em>');
  for (const line of lines) {
    if (/^# /.test(line)) { closeList(); out.push(`<h1>${inline(line.slice(2))}</h1>`); }
    else if (/^## /.test(line)) { closeList(); out.push(`<h2>${inline(line.slice(3))}</h2>`); }
    else if (/^> /.test(line)) { closeList(); out.push(`<blockquote>${inline(line.slice(2))}</blockquote>`); }
    else if (/^\d+\. /.test(line)) {
      if (!inList) { out.push('<ol>'); inList = 'ol'; }
      out.push(`<li>${inline(line.replace(/^\d+\. /, ''))}</li>`);
    } else if (/^- /.test(line)) {
      if (inList !== 'ul') { closeList(); out.push('<ul>'); inList = 'ul'; }
      out.push(`<li>${inline(line.slice(2))}</li>`);
    } else if (line.trim() === '') { closeList(); out.push(''); }
    else { closeList(); out.push(`<p>${inline(line)}</p>`); }
  }
  closeList();
  return out.join('\n');
  function closeList() { if (inList) { out.push(inList === 'ol' ? '</ol>' : '</ul>'); inList = false; } }
}

// ---------- replay round-trip ----------

/**
 * Re-run the captured path against a fresh context (NO profile reuse — proves
 * the actions are portable). Reports per-step success and whether the final URL
 * matches the captured tail. This is "did our emission actually work" in the
 * cheapest form — no @playwright/test required, no spawned process.
 */
async function replayPath(pathActions) {
  const lines = [`# Replay round-trip`, ``];
  lines.push(`Replaying ${pathActions.length} captured action(s) against a fresh context.`, ``);
  let context;
  try {
    context = await chromium.launchPersistentContext(path.join(POC_ROOT, '.replay-profile'), {
      headless: true,
      viewport: { width: 1280, height: 800 },
      args: ['--no-first-run', '--no-default-browser-check'],
    });
    const page = context.pages()[0] || await context.newPage();
    const expectedTailUrl = pathActions[pathActions.length - 1]?.pageUrl || '';

    // If the reviewer was already on a page when they pressed Mark-start, the
    // first recorded action is a click/fill — not a `openPage`/`navigate` — so
    // replay starts at about:blank with no URL loaded. Synthesize an implicit
    // goto to the first action's captured pageUrl so the locator has a chance.
    const firstAction = pathActions[0]?.data?.action;
    const firstUrl = pathActions[0]?.pageUrl;
    const needsImplicitGoto = firstAction && firstAction.name !== 'openPage' && firstAction.name !== 'navigate' && firstUrl;
    if (needsImplicitGoto) {
      try {
        await page.goto(firstUrl, { timeout: 8000, waitUntil: 'domcontentloaded' });
        lines.push(`OK   0. (implicit) Go to ${firstUrl}`);
      } catch (err) {
        lines.push(`FAIL 0. (implicit goto) — ${err.message?.split('\n')[0]}`);
        const headline = `❌ replay failed before any recorded step (implicit goto)`;
        lines.unshift(headline, ``);
        return { text: lines.join('\n'), headline };
      }
    }

    let ok = 0, fail = 0;
    for (const [i, a] of pathActions.entries()) {
      const action = a.data?.action || {};
      const label = `${i + 1}. ${action.name || '?'}`;
      try {
        await dispatchAction(page, action);
        lines.push(`OK   ${label}`);
        ok += 1;
      } catch (err) {
        lines.push(`FAIL ${label} — ${err.message?.split('\n')[0]}`);
        fail += 1;
        break; // bail on first failure; remaining steps depend on this one
      }
    }
    const finalUrl = page.url();
    lines.push(``, `Final URL: ${finalUrl}`, `Expected: ${expectedTailUrl}`);
    const urlMatch = finalUrl === expectedTailUrl;
    lines.push(``, `Steps OK: ${ok}/${pathActions.length}  ·  URL match: ${urlMatch}`);

    const headline = fail === 0 && urlMatch
      ? `✅ replay reproduced final URL`
      : fail === 0
      ? `⚠️  all steps ran but final URL differs`
      : `❌ replay failed after ${ok} step(s)`;
    lines.unshift(headline, ``);
    return { text: lines.join('\n'), headline };
  } catch (err) {
    return { text: `replay setup failed: ${err.stack || err}\n`, headline: `❌ replay setup failed` };
  } finally {
    if (context) try { await context.close(); } catch {}
  }
}

/** Dispatch one ActionInContext against the page. Handles the common kinds; */
/* throws on anything we don't model so failures surface, not silently skip.   */
async function dispatchAction(page, a) {
  const timeout = 8000;
  switch (a.name) {
    case 'openPage':
    case 'navigate': {
      await page.goto(a.url, { timeout, waitUntil: 'domcontentloaded' });
      return;
    }
    case 'click': {
      await page.locator(a.selector).first().click({ timeout });
      return;
    }
    case 'dblclick': {
      await page.locator(a.selector).first().dblclick({ timeout });
      return;
    }
    case 'fill': {
      await page.locator(a.selector).first().fill(a.text ?? a.value ?? '', { timeout });
      return;
    }
    case 'press': {
      if (a.selector) await page.locator(a.selector).first().press(a.key, { timeout });
      else await page.keyboard.press(a.key);
      return;
    }
    case 'select': {
      await page.locator(a.selector).first().selectOption(a.options || a.value, { timeout });
      return;
    }
    case 'check': {
      await page.locator(a.selector).first().check({ timeout });
      return;
    }
    case 'uncheck': {
      await page.locator(a.selector).first().uncheck({ timeout });
      return;
    }
    case 'closesPage': {
      await page.close();
      return;
    }
    default:
      throw new Error(`replay: action kind ${a.name} not modeled`);
  }
}

// ---------- go ----------

main().catch((err) => {
  console.error('[poc] fatal:', err);
  process.exit(1);
});
