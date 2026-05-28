/**
 * Recording → `recording.spec.ts` text emitter (Spike 8, phase 9d).
 *
 * Pure: takes a session doc, returns `{ text, envVars }`. No `fs`, no
 * Playwright, no Node-only APIs — safe to import from `http-server.mjs`
 * (live preview route), `artifact/build.mjs` (9e bundle write), and to
 * unit-test in isolation.
 *
 * What it emits:
 *   - One `test(name, async ({ page }) => {...})` block per session — the
 *     whole reviewer path is one reproducible scenario, not one per view.
 *   - `// === PRECONDITION ===` block: each `doc.preconditionSteps[]` entry
 *     rendered as a commented-out `code` line. Engineers replace this block
 *     with their own auth/setup fixture — the recorded steps are hints, not
 *     instructions (see design-qa-interaction-recording.md §4 layer 2).
 *   - `// === RECORDED PATH ===` block: a `// --- view: <name> ---` divider
 *     per view, then each `view.steps[]` entry's `code` (already redacted at
 *     capture time). Omitted steps (`step.omitted === true`) are skipped.
 *   - Implicit `await page.goto(firstAction.pageUrl)` prepended to the
 *     recorded path if the first non-omitted step isn't itself a navigation
 *     (POC finding — replay against a fresh context starts at about:blank).
 *
 * Redaction substitutions in `step.code` (e.g. `process.env.DESIGN_QA_FIELD_…`)
 * are already in place; this emitter never re-runs the redactor. `envVars`
 * is extracted by scanning the emitted text for those substitution forms so
 * the Preview modal's chip and any header comment surface the exact set.
 */

const ENV_VAR_RE = /process\.env\.(DESIGN_QA_FIELD_[A-Z0-9_]+)/g;

/**
 * @param {object} session  A session document (schema v4).
 * @returns {{ text: string, envVars: string[] }}
 */
export function emitRecordingSpec(session) {
  const sessionName = (session && session.name) || 'Untitled session';
  const views = Array.isArray(session?.views) ? session.views : [];
  const preconditionSteps = (session?.preconditionSteps || []).filter((s) => !s.omitted);

  // Recorded steps, in view order. Each view contributes its non-omitted
  // steps in their stored order (the recorder appends chronologically per
  // view; cross-view ordering is the order views were created/sealed).
  const recordedSegments = views
    .map((v) => ({
      view: v,
      steps: (v.steps || []).filter((s) => !s.omitted),
    }))
    .filter((seg) => seg.steps.length > 0);

  const flatRecorded = recordedSegments.flatMap((s) => s.steps);
  const firstRecorded = flatRecorded[0] || null;
  const needsImplicitGoto = firstRecorded
    && firstRecorded.kind !== 'openPage'
    && firstRecorded.kind !== 'navigate'
    && firstRecorded.pageUrl;

  const lines = [];
  lines.push("import { test, expect } from '@playwright/test';");
  lines.push('');
  lines.push(`/**`);
  lines.push(` * Reproduce: ${sessionName}`);
  lines.push(' *');
  lines.push(' * Recorded with the /design-qa skill.');
  if (session?.createdAt) lines.push(` * Session created: ${session.createdAt}`);
  lines.push(' *');
  lines.push(' * Redactions: every credential the recorder saw was substituted to a');
  lines.push(' *   process.env.DESIGN_QA_FIELD_<NAME> ?? \'\' reference. Set those in your');
  lines.push(' *   shell or .env before running. The full list is below.');
  lines.push(' */');
  lines.push('');
  lines.push(`test('Reproduce: ${escapeSingleQuotes(sessionName)}', async ({ page }) => {`);

  // ---- PRECONDITION block -------------------------------------------------
  lines.push('  // === PRECONDITION (set this up however your project handles auth) ===');
  lines.push('  // The reviewer was in some state when they pressed Mark-start; the');
  lines.push('  // lines below are recorded hints. Replace with your project\'s login,');
  lines.push('  // fixture, or storageState handling.');
  if (preconditionSteps.length === 0) {
    lines.push('  // (no precondition steps were recorded)');
  } else {
    for (const step of preconditionSteps) {
      for (const codeLine of codeLinesFor(step)) lines.push(`  // ${codeLine}`);
    }
  }
  lines.push('');

  // ---- RECORDED PATH block ------------------------------------------------
  lines.push('  // === RECORDED PATH (everything below was captured) ===');
  if (recordedSegments.length === 0) {
    lines.push('  // (no recorded steps — press Mark-start in the capture overlay)');
  } else {
    if (needsImplicitGoto) {
      lines.push(`  // Implicit goto — first recorded action wasn't a navigation.`);
      lines.push(`  await page.goto(${JSON.stringify(firstRecorded.pageUrl)});`);
    }
    for (const seg of recordedSegments) {
      const viewName = (seg.view && (seg.view.name || seg.view.url)) || '(unnamed view)';
      lines.push(`  // --- view: ${viewName} ---`);
      for (const step of seg.steps) {
        for (const codeLine of codeLinesFor(step)) lines.push(`  ${codeLine}`);
      }
    }
  }

  lines.push('});');
  lines.push('');

  const text = lines.join('\n');
  const envVars = extractEnvVars(text);

  return { text, envVars };
}

/**
 * Split a step's `code` field into emit-ready lines. Recorder snippets are
 * usually single-line awaits but may include trailing newlines or comments.
 * Falls back to a `// <kind>` placeholder if no code is present (e.g. older
 * pre-9b steps in test fixtures).
 */
function codeLinesFor(step) {
  const code = typeof step?.code === 'string' ? step.code.trimEnd() : '';
  if (code) return code.split('\n');
  return [`// ${step?.kind || 'unknown'} — no code captured`];
}

/** Distinct DESIGN_QA_FIELD_* names referenced by the emitted text. */
function extractEnvVars(text) {
  const set = new Set();
  let m;
  ENV_VAR_RE.lastIndex = 0;
  while ((m = ENV_VAR_RE.exec(text)) !== null) set.add(m[1]);
  return [...set].sort();
}

/** Escape single quotes for the `test('…', …)` name string. */
function escapeSingleQuotes(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
