/**
 * Recording → `recording-steps.md` text emitter (Spike 8, phase 9e).
 *
 * Pure: takes a session doc, returns a Markdown string. No `fs`, no Playwright,
 * no Node-only APIs — the mirror of `emit-spec.mjs` in shape, safe to import
 * from `artifact/build.mjs` (the bundle write) and to unit-test in isolation.
 *
 * The content is the human-readable twin of `recording.spec.ts`: the same
 * precondition + recorded-path split the console "Steps" disclosure and the
 * Preview-spec modal show, rendered as prose for an engineer who'd rather
 * follow the path by hand than run Playwright.
 *
 * Each step's display text reuses the SAME resolution the console popover uses
 * (`step.humanText` override → `describeAction(step)`), so the markdown reads
 * identically to what the reviewer saw on screen. Omitted steps
 * (`step.omitted === true`) are skipped silently — the reviewer's decision to
 * drop a step is honoured, not annotated.
 *
 * Redaction is already applied to `step.code` at capture time; this emitter
 * surfaces the resulting `DESIGN_QA_FIELD_*` env-var list so the engineer
 * knows what to set before running the companion `.spec.ts`.
 */
import { describeAction } from './recorder-format.mjs';

const ENV_VAR_RE = /process\.env\.(DESIGN_QA_FIELD_[A-Z0-9_]+)/g;

/**
 * @param {object} session  A session document (schema v4).
 * @returns {string}  Markdown for `recording-steps.md`.
 */
export function emitRecordingSteps(session) {
  const sessionName = (session && session.name) || 'Untitled session';
  const views = Array.isArray(session?.views) ? session.views : [];
  const preconditionSteps = (session?.preconditionSteps || []).filter((s) => !s.omitted);

  const recordedSegments = views
    .map((v) => ({
      view: v,
      steps: (v.steps || []).filter((s) => !s.omitted),
    }))
    .filter((seg) => seg.steps.length > 0);

  const lines = [];
  lines.push(`# Recording — ${sessionName}`);
  lines.push('');
  lines.push(
    session?.createdAt
      ? `Recorded with the \`/design-qa\` skill · session created ${session.createdAt}.`
      : 'Recorded with the `/design-qa` skill.',
  );
  lines.push('');

  // ---- Credentials note (only if anything was redacted) ------------------
  const envVars = collectEnvVars(preconditionSteps, recordedSegments);
  if (envVars.length > 0) {
    lines.push('> **Credentials were redacted.** The companion `recording.spec.ts`');
    lines.push('> references these environment variables in place of the values you');
    lines.push('> typed — set them before running it:');
    lines.push('>');
    for (const name of envVars) lines.push(`> - \`${name}\``);
    lines.push('');
  }

  // ---- Precondition -------------------------------------------------------
  lines.push('## Precondition');
  lines.push('');
  lines.push('The reviewer was already in some state when they pressed Mark-start.');
  lines.push('These steps are hints — reproduce them however your project handles');
  lines.push('auth and setup.');
  lines.push('');
  if (preconditionSteps.length === 0) {
    lines.push('_No precondition steps were recorded._');
  } else {
    preconditionSteps.forEach((step, i) => lines.push(`${i + 1}. ${humanFor(step)}`));
  }
  lines.push('');

  // ---- Recorded path ------------------------------------------------------
  lines.push('## Recorded path');
  lines.push('');
  if (recordedSegments.length === 0) {
    lines.push('_No recorded steps — press Mark-start in the capture overlay, then interact._');
    lines.push('');
  } else {
    for (const seg of recordedSegments) {
      const viewName = (seg.view && (seg.view.name || seg.view.url)) || '(unnamed view)';
      lines.push(`### ${viewName}`);
      lines.push('');
      seg.steps.forEach((step, i) => lines.push(`${i + 1}. ${humanFor(step)}`));
      lines.push('');
    }
  }

  return lines.join('\n');
}

/** Resolve a step's display text — override wins, else describeAction (the
 *  same resolution the console popover / disclosure uses). */
function humanFor(step) {
  if (typeof step.humanText === 'string' && step.humanText.length > 0) return step.humanText;
  return describeAction({
    name: step.kind,
    selector: step.selector,
    text: step.text,
    url: step.url,
    key: step.key,
    options: step.options,
  });
}

/** Distinct DESIGN_QA_FIELD_* names referenced across all non-omitted steps'
 *  `code`, sorted — same set the `.spec.ts` header lists. */
function collectEnvVars(preconditionSteps, recordedSegments) {
  const set = new Set();
  const scan = (step) => {
    const code = typeof step?.code === 'string' ? step.code : '';
    let m;
    ENV_VAR_RE.lastIndex = 0;
    while ((m = ENV_VAR_RE.exec(code)) !== null) set.add(m[1]);
  };
  preconditionSteps.forEach(scan);
  recordedSegments.forEach((seg) => seg.steps.forEach(scan));
  return [...set].sort();
}
