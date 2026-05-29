/**
 * `[Preview spec]` modal (Spike 8, phases 9d + 9g).
 *
 * Read-only preview of the would-be-shipped `recording.spec.ts`. Fetched
 * server-side via `store.fetchRecordingPreview(viewId)` so the live console and
 * the bundle write use the SAME emitter (`lib/emit-spec.mjs`). When opened from
 * a screen's Steps disclosure it scopes to THAT screen's checkpoint test (9g);
 * with no view it shows the whole multi-test file. No edits in here — edits
 * happen per-step in the disclosure (`ui/steps.mjs`).
 *
 * Surfaces a clickable **redaction-count chip** ("🛡 N values redacted") that
 * expands to the list of `DESIGN_QA_FIELD_*` env-var names referenced in the
 * emitted text. This is the safety check the reviewer does before sharing,
 * per design doc §11.6 ("modal should show 'X values redacted'").
 *
 * Modal pattern mirrors the Export chooser in `app.mjs` — same backdrop, same
 * Esc-to-dismiss behavior, same Figma-dark visual tokens.
 */
import { el } from '../lib/dom.mjs';
import { showToast } from './toast.mjs';

const BACKDROP_ID = 'dqa-preview-backdrop';

export async function openPreviewSpec(ctx, view = null) {
  closePreviewSpec();

  const viewId = view?.id || null;
  const screenLabel = view ? (view.name || view.url || 'this screen') : null;
  const title = screenLabel
    ? `Preview — reach feedback on ${screenLabel}`
    : 'Preview recording.spec.ts';

  // Optimistic open — show a "Loading…" body, then fill once the emitter
  // responds. Keeps the click feeling immediate; the emitter is cheap but the
  // round-trip can stall on slow loopback.
  const body = el('div', { class: 'preview-body preview-loading' }, 'Loading preview…');
  const closeBtn = el('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: closePreviewSpec }, '×');
  const dialog = el('div', { class: 'preview-dialog', role: 'dialog', 'aria-label': 'Preview recording.spec.ts' }, [
    el('div', { class: 'preview-head' }, [
      el('div', { class: 'preview-title' }, title),
      closeBtn,
    ]),
    body,
  ]);
  const backdrop = el('div', {
    class: 'preview-backdrop', id: BACKDROP_ID,
    onclick: (e) => { if (e.target === backdrop) closePreviewSpec(); },
  }, [dialog]);

  document.body.appendChild(backdrop);
  document.addEventListener('keydown', previewKeydown);

  try {
    const { text, envVars } = await ctx.store.fetchRecordingPreview(viewId);
    body.classList.remove('preview-loading');
    body.replaceChildren(...buildBody(text, envVars, screenLabel));
  } catch (err) {
    body.classList.remove('preview-loading');
    body.replaceChildren(el('div', { class: 'preview-error' },
      `Failed to load preview: ${err?.message || err}`));
  }
}

function buildBody(text, envVars, screenLabel = null) {
  const chip = buildRedactionChip(envVars);
  const copyBtn = el('button', {
    class: 'btn',
    onclick: async () => {
      try {
        await navigator.clipboard.writeText(text);
        showToast('Copied recording.spec.ts to clipboard');
      } catch (err) {
        showToast(`Copy failed: ${err?.message || err}`);
      }
    },
  }, 'Copy');

  const codeBlock = el('pre', { class: 'preview-code' },
    [renderTypescript(text)]);

  return [
    el('div', { class: 'preview-meta' }, [chip, el('span', { class: 'preview-spacer' }), copyBtn]),
    codeBlock,
    el('div', { class: 'preview-foot' }, [
      el('span', { class: 'preview-foot-hint' },
        screenLabel
          ? `This checkpoint test reaches the feedback on “${screenLabel}”. The export bundle ships one test per annotated screen. Edits happen in the Steps list above.`
          : 'This is what ships in the export bundle. Edits happen in the Steps list above.'),
    ]),
  ];
}

/** Clickable "🛡 N values redacted" chip — expands to the env-var list. When
 *  N === 0, renders an informational non-interactive variant. */
function buildRedactionChip(envVars) {
  const count = Array.isArray(envVars) ? envVars.length : 0;
  if (count === 0) {
    return el('span', { class: 'preview-redact-chip is-empty', title: 'No credentials seen by the recorder' },
      '🛡 No redactions');
  }
  const label = `🛡 ${count} value${count === 1 ? '' : 's'} redacted`;
  let expanded = false;
  const list = el('ul', { class: 'preview-redact-list', hidden: true },
    envVars.map((name) => el('li', null, name)));
  const chip = el('button', {
    class: 'preview-redact-chip',
    title: 'Click to show the env vars these substitutions reference',
    'aria-expanded': 'false',
    onclick: (e) => {
      e.stopPropagation();
      expanded = !expanded;
      chip.setAttribute('aria-expanded', String(expanded));
      list.hidden = !expanded;
      chip.classList.toggle('is-open', expanded);
    },
  }, label);
  return el('span', { class: 'preview-redact-wrap' }, [chip, list]);
}

/**
 * Minimal in-place TypeScript syntax highlighter. Tokens: strings (single,
 * double, backtick), line comments, block comments, keywords. Returns a
 * DocumentFragment so the caller can drop it into a `<pre><code>` parent.
 *
 * Buildless + no dependency: regex-based and deliberately small. Good enough
 * for `recording.spec.ts`, which is ~15 distinct token shapes total.
 */
function renderTypescript(text) {
  // Order matters: comments first so a comment containing `'…'` doesn't get
  // re-split into a string, then strings, then keywords on the leftover spans.
  const tokens = [];
  const re = /(\/\/.*$|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:import|from|const|let|var|async|await|function|return|if|else|test|expect|true|false|null|undefined|new|throw|try|catch|finally|for|of|in|page)\b)/gm;
  let last = 0; let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) tokens.push({ kind: 'plain', text: text.slice(last, m.index) });
    const s = m[0];
    let kind = 'plain';
    if (s.startsWith('//') || s.startsWith('/*')) kind = 'comment';
    else if (s.startsWith('"') || s.startsWith("'") || s.startsWith('`')) kind = 'string';
    else kind = 'keyword';
    tokens.push({ kind, text: s });
    last = m.index + s.length;
  }
  if (last < text.length) tokens.push({ kind: 'plain', text: text.slice(last) });

  const code = document.createElement('code');
  code.className = 'preview-code-inner';
  for (const tok of tokens) {
    if (tok.kind === 'plain') code.appendChild(document.createTextNode(tok.text));
    else {
      const span = document.createElement('span');
      span.className = `tok-${tok.kind}`;
      span.textContent = tok.text;
      code.appendChild(span);
    }
  }
  return code;
}

function previewKeydown(e) { if (e.key === 'Escape') closePreviewSpec(); }

function closePreviewSpec() {
  const node = document.getElementById(BACKDROP_ID);
  if (node) node.remove();
  document.removeEventListener('keydown', previewKeydown);
}
