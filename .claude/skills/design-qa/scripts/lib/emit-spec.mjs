/**
 * Recording → `recording.spec.ts` text emitter (Spike 8, phases 9d + 9g).
 *
 * Pure: takes a session doc, returns `{ text, envVars }`. No `fs`, no
 * Playwright, no Node-only APIs — safe to import from `http-server.mjs`
 * (live preview route), `artifact/build.mjs` (bundle write), and to
 * unit-test in isolation.
 *
 * FORENSIC, PER-SCREEN (9g — supersedes the original "one test() per session").
 * The spec exists to get an engineer back to the exact point where a piece of
 * feedback was laid in. The recorded path is CUMULATIVE and each ANNOTATED
 * screen (≥1 pin) is a CHECKPOINT on it. So we emit:
 *
 *   - ONE `test('Reach feedback on: <screen>')` per annotated screen, each
 *     replaying the cumulative path from the start truncated at THAT screen's
 *     segment. The checkpoints are nested, not independent:
 *       Login     → steps to reach Login
 *       Dashboard → Login steps + Dashboard steps
 *       Settings  → Login + Dashboard + Settings steps   (== whole-session path)
 *   - Pass-through / steps-only screens (no pins) are NOT their own test — they
 *     remain intermediate `// --- view: … ---` segments inside each cumulative
 *     path (no feedback to land on).
 *   - The last annotated screen's test IS the full path, so the monolithic
 *     view isn't lost; no separate session-level test is emitted.
 *   - Fallback: a recording with NO annotated screens (all pass-through) still
 *     emits a single `test('Reproduce: <session>')` over the whole path so the
 *     recorded data isn't dropped.
 *
 * Each test repeats the PRECONDITION block (the tests are independent — each
 * gets a fresh `page`), then its cumulative RECORDED PATH. Omitted steps
 * (`step.omitted === true`) are skipped. An implicit `await page.goto(...)` is
 * prepended per test when that test's first recorded action isn't a navigation.
 *
 * Redaction substitutions in `step.code` (e.g. `process.env.DESIGN_QA_FIELD_…`)
 * are already in place; this emitter never re-runs the redactor. `envVars`
 * is the UNION across every emitted test, extracted by scanning the text.
 *
 * Scoping: pass `{ viewId }` to emit only that one screen's checkpoint test
 * (the console's per-screen [Preview spec] modal uses this). Omit it for the
 * full multi-test file (the export bundle).
 */

const ENV_VAR_RE = /process\.env\.(DESIGN_QA_FIELD_[A-Z0-9_]+)/g;

/**
 * @param {object} session  A session document (schema v4).
 * @param {{ viewId?: string|null }} [opts]  Scope to a single screen's checkpoint.
 * @returns {{ text: string, envVars: string[] }}
 */
export function emitRecordingSpec(session, opts = {}) {
  const { viewId = null } = opts;
  const sessionName = (session && session.name) || 'Untitled session';
  const views = Array.isArray(session?.views) ? session.views : [];
  const preconditionSteps = (session?.preconditionSteps || []).filter((s) => !s.omitted);

  // Per-view non-omitted steps, in view order. Keep EVERY view (even stepless or
  // pinless ones) so cumulative truncation indexes and segment dividers line up.
  const viewSteps = views.map((v) => ({
    view: v,
    steps: (v.steps || []).filter((s) => !s.omitted),
    annotated: Array.isArray(v.pins) && v.pins.length > 0,
  }));

  // Which views become checkpoint tests.
  const checkpoints = computeCheckpoints(viewSteps, { viewId, sessionName });

  const lines = [];
  lines.push("import { test, expect } from '@playwright/test';");
  lines.push('');
  lines.push('/**');
  lines.push(` * Reproduce: ${sessionName}`);
  lines.push(' *');
  lines.push(' * Recorded with the /design-qa skill. One test() per screen the reviewer');
  lines.push(' * annotated — each replays the cumulative path up to that screen\'s feedback,');
  lines.push(' * so the last test is the whole-session path.');
  if (session?.createdAt) lines.push(` * Session created: ${session.createdAt}`);
  lines.push(' *');
  lines.push(' * Redactions: every credential the recorder saw was substituted to a');
  lines.push(' *   process.env.DESIGN_QA_FIELD_<NAME> ?? \'\' reference. Set those in your');
  lines.push(' *   shell or .env before running. The full list is below.');
  lines.push(' */');
  lines.push('');

  if (checkpoints.length === 0) {
    // No views and/or no recorded steps at all — emit a single empty scenario
    // so the file is still valid TS and documents the empty state.
    emitTestBlock(lines, {
      testName: `Reproduce: ${sessionName}`,
      preconditionSteps,
      segments: [],
    });
  } else {
    checkpoints.forEach((cp, i) => {
      if (i > 0) lines.push('');
      // Cumulative path: every view's steps from the start through this
      // checkpoint's index, dropping segments that contributed no steps.
      const segments = viewSteps
        .slice(0, cp.idx + 1)
        .filter((seg) => seg.steps.length > 0);
      emitTestBlock(lines, {
        testName: cp.testName,
        preconditionSteps,
        segments,
      });
    });
  }

  const text = lines.join('\n');
  const envVars = extractEnvVars(text);
  return { text, envVars };
}

/**
 * Decide which views get a `test()` and what each test is named.
 *  - Default: every annotated view (≥1 pin) → 'Reach feedback on: <name>'.
 *  - `viewId` scope: just that view (named as a checkpoint regardless of pins,
 *    so the per-screen Preview modal always renders something).
 *  - No annotated views: a single fallback checkpoint at the last view →
 *    'Reproduce: <session>', covering the whole recorded path.
 * Returns `[{ idx, testName }]` in view order.
 */
function computeCheckpoints(viewSteps, { viewId, sessionName }) {
  if (viewId != null) {
    const idx = viewSteps.findIndex((vs) => vs.view && vs.view.id === viewId);
    if (idx < 0) return [];
    return [{ idx, testName: `Reach feedback on: ${screenName(viewSteps[idx].view)}` }];
  }

  const annotated = viewSteps
    .map((vs, idx) => ({ vs, idx }))
    .filter(({ vs }) => vs.annotated);

  if (annotated.length > 0) {
    return annotated.map(({ vs, idx }) => ({
      idx,
      testName: `Reach feedback on: ${screenName(vs.view)}`,
    }));
  }

  // Nothing annotated: keep the whole recorded path under one fallback test so
  // captured data isn't lost. Anchor it at the last view (cumulative = all).
  if (viewSteps.length === 0) return [];
  return [{ idx: viewSteps.length - 1, testName: `Reproduce: ${sessionName}` }];
}

/** Append one `test(...)` block: header comment + PRECONDITION + cumulative
 *  RECORDED PATH (with per-view dividers + implicit goto). */
function emitTestBlock(lines, { testName, preconditionSteps, segments }) {
  lines.push(`test('${escapeSingleQuotes(testName)}', async ({ page }) => {`);

  // ---- PRECONDITION block (repeated per independent test) ----------------
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

  // ---- RECORDED PATH block (cumulative, truncated at this checkpoint) -----
  lines.push('  // === RECORDED PATH (cumulative — replays to this screen\'s feedback) ===');
  if (segments.length === 0) {
    lines.push('  // (no recorded steps — press Mark-start in the capture overlay)');
  } else {
    const flat = segments.flatMap((s) => s.steps);
    const first = flat[0] || null;
    const needsImplicitGoto = first
      && first.kind !== 'openPage'
      && first.kind !== 'navigate'
      && first.pageUrl;
    if (needsImplicitGoto) {
      lines.push('  // Implicit goto — first recorded action wasn\'t a navigation.');
      lines.push(`  await page.goto(${JSON.stringify(first.pageUrl)});`);
    }
    for (const seg of segments) {
      lines.push(`  // --- view: ${screenName(seg.view)} ---`);
      for (const step of seg.steps) {
        for (const codeLine of codeLinesFor(step)) lines.push(`  ${codeLine}`);
      }
    }
  }

  lines.push('});');
}

/** Display name for a screen — view name, else its url, else a placeholder. */
function screenName(view) {
  return (view && (view.name || view.url)) || '(unnamed view)';
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

/** Distinct DESIGN_QA_FIELD_* names referenced by the emitted text (union
 *  across every test). */
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
