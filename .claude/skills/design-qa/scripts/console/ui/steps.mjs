/**
 * Steps tab (Phase 8) — the recorded Playwright steps for the active screen,
 * styled as the DesignOS "Sidebar Steps" composite (src/app/steps-panel.jsx):
 * a left dot/line **timeline rail** + per-step `NN · <action>` stamp, a bold
 * target line, and a quiet selector/meta line. Console-authored steps keep the
 * edit-label / omit affordances (hover); the read-only artifact shows them flat.
 *
 * `code` stays authoritative; `[edit]` overrides only the human label
 * (persisted as `step.humanText`). Mapping from our recorder fields to the
 * tile's (action / target / meta) lives in `tileParts`.
 */
import { el } from '../lib/dom.mjs';
import { showToast } from './toast.mjs';
import { selectorLabel } from './recorder-format.mjs';
import { openPreviewSpec } from './preview-spec.mjs';

/** Steps TAB body — returns an array of nodes (head + timeline, or empty). */
export function renderStepsTab(ctx, view) {
  const steps = Array.isArray(view.steps) ? view.steps : [];
  const previewAvailable = typeof ctx.store.fetchRecordingPreview === 'function';
  const canEdit = typeof ctx.store.editStepText === 'function'
    && typeof ctx.store.omitStep === 'function';

  const headKids = [el('span', { class: 'steps-tab-count' },
    `${steps.length} ${steps.length === 1 ? 'step' : 'steps'}`)];
  if (previewAvailable) {
    headKids.push(el('button', {
      class: 'steps-preview-btn',
      title: 'Preview the checkpoint test that reaches this screen in recording.spec.ts',
      onclick: (e) => { e.stopPropagation(); openPreviewSpec(ctx, view); },
    }, 'Preview spec'));
  }
  const out = [el('div', { class: 'steps-tab-head' }, headKids)];

  if (steps.length === 0) {
    out.push(el('div', { class: 'steps-empty' },
      previewAvailable
        ? 'No steps captured. Press Record in the capture overlay, then interact.'
        : 'No steps captured.'));
    return out;
  }
  out.push(el('div', { class: 'steps-rail-list' },
    steps.map((step, i) => buildStepTile(ctx, step, i + 1, i === steps.length - 1, canEdit))));
  return out;
}

/* ─── Timeline tile — rail + stamp / target / meta ─────────────── */
function buildStepTile(ctx, step, n, isLast, canEdit) {
  const omitted = step.omitted === true;
  const { action, target, meta } = tileParts(step);

  const rail = el('div', { class: 'step-rail' },
    [el('span', { class: 'step-dot' }), isLast ? null : el('span', { class: 'step-line' })].filter(Boolean));

  const stamp = el('div', { class: 'step-stamp' }, [
    el('span', { class: 'step-stamp-num' }, String(n).padStart(2, '0')),
    el('span', { class: 'step-stamp-div' }, '·'),
    el('span', { class: 'step-stamp-action' }, action),
  ]);

  const targetEl = el('div', { class: `step-target${omitted ? ' step-omitted' : ''}`, title: step.code || '' },
    target || '—');
  if (canEdit && !omitted) {
    targetEl.addEventListener('click', (e) => { e.stopPropagation(); startStepEdit(ctx, targetEl, step, target); });
  }

  const bodyKids = [stamp, targetEl];
  if (meta) bodyKids.push(el('div', { class: 'step-meta' }, meta));
  const body = el('div', { class: 'step-tile-body' }, bodyKids);

  const tileKids = [rail, body];
  if (canEdit) {
    tileKids.push(el('div', { class: 'step-tile-actions' }, [
      el('button', { class: 'step-act-btn', title: 'Edit label',
        onclick: (e) => { e.stopPropagation(); if (!omitted) startStepEdit(ctx, targetEl, step, target); } }, 'edit'),
      el('button', { class: 'step-act-btn', title: omitted ? 'Restore step' : 'Omit from emitted spec',
        onclick: (e) => { e.stopPropagation(); toggleOmit(ctx, step); } }, omitted ? 'undo' : '×'),
    ]));
  }

  return el('div', { class: `step-tile${omitted ? ' is-omitted' : ''}`, dataset: { id: step.id } }, tileKids);
}

/** Map a recorder step to the timeline tile's (action verb / target / meta). */
const VERB = {
  openPage: 'Go to', navigate: 'Go to', click: 'Click', dblclick: 'Double-click',
  fill: 'Type', press: 'Press', select: 'Pick', check: 'Check', uncheck: 'Uncheck',
  closesPage: 'Close', setInputFiles: 'Upload',
};
const stripMd = (s) => String(s || '').replace(/\*\*/g, '').replace(/`/g, '');
function cleanSelector(sel) {
  if (!sel || sel.startsWith('internal:')) return ''; // hide noisy Playwright internal selectors
  return sel.length > 64 ? `${sel.slice(0, 61)}…` : sel;
}
function tileParts(step) {
  const verb = VERB[step.kind] || (step.kind ? step.kind[0].toUpperCase() + step.kind.slice(1) : 'Action');
  // A user-edited label IS the target line.
  if (step.humanText && step.humanText.trim()) {
    const meta = cleanSelector(step.selector);
    return { action: verb, target: stripMd(step.humanText.trim()), meta };
  }
  switch (step.kind) {
    case 'openPage': case 'navigate': return { action: 'Go to', target: step.url || '', meta: '' };
    case 'press': return { action: 'Press', target: step.key || '', meta: '' };
    case 'closesPage': return { action: 'Close', target: 'the page', meta: '' };
    default: {
      const target = stripMd(selectorLabel(step.selector)) || 'an element';
      let meta = cleanSelector(step.selector);
      if (meta === target) meta = '';
      return { action: verb, target, meta };
    }
  }
}

/** Inline-edit the human label. Cmd/Ctrl+Enter or blur commit, Esc cancel. */
function startStepEdit(ctx, node, step, initial) {
  const input = el('input', { class: 'step-text-edit', type: 'text' });
  input.value = initial != null ? initial : (step.humanText || '');
  input.addEventListener('click', (e) => e.stopPropagation());
  let done = false;
  const commit = async () => {
    if (done) return; done = true;
    try { await ctx.store.editStepText({ stepId: step.id, humanText: input.value }); ctx.render(); }
    catch (err) { showToast(`Edit failed: ${err?.message || err}`); ctx.render(); }
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); input.blur(); }
    else if (e.key === 'Escape') { done = true; ctx.render(); }
  });
  node.replaceWith(input);
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

/** Omit or restore. Omit shows a toast with Undo; restore is silent. */
async function toggleOmit(ctx, step) {
  const wasOmitted = step.omitted === true;
  try {
    if (wasOmitted) { await ctx.store.unomitStep({ stepId: step.id }); ctx.render(); }
    else {
      await ctx.store.omitStep({ stepId: step.id });
      ctx.render();
      showToast('Step omitted from spec', {
        undo: async () => {
          try { await ctx.store.unomitStep({ stepId: step.id }); ctx.render(); }
          catch (err) { showToast(`Undo failed: ${err?.message || err}`); }
        },
      });
    }
  } catch (err) {
    showToast(`${wasOmitted ? 'Restore' : 'Omit'} failed: ${err?.message || err}`);
  }
}
