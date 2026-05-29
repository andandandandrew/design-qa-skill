/**
 * `▸ Steps (N)` disclosure for the active screen (Spike 8, phase 9d).
 *
 * Mounted by `renderComments()` at the top of the comments pane — above the
 * per-pin cards. The disclosure shows the steps the recorder captured for
 * THIS view (sealed views) or the running buffer (live views), each with
 * inline `[edit]` for the human label and `[×]` to omit (struck-through with
 * a Figma-style Undo toast, same pattern as resolve).
 *
 * The recorder's `code` field stays authoritative — `[edit]` only overrides
 * the human-readable label (persisted as `step.humanText`); absent → fall
 * back to `describeAction(step)` which the capture-side popover uses too.
 *
 * Feature-detects on the store: if `store.editStepText` isn't a function
 * (MemoryStore fixture path), the disclosure renders read-only.
 *
 * `[Preview spec]` is inline with the disclosure row per design doc §7.
 * The modal it opens scopes to THIS screen's checkpoint test (9g) — the
 * cumulative path that reaches the feedback on this view, not the whole file.
 */
import { el } from '../lib/dom.mjs';
import { showToast } from './toast.mjs';
import { describeAction } from './recorder-format.mjs';
import { openPreviewSpec } from './preview-spec.mjs';

/** Build the disclosure node for the active view, or null if nothing to show. */
export function renderStepsDisclosure(ctx) {
  const view = ctx.activeView();
  if (!view) return null;
  const steps = Array.isArray(view.steps) ? view.steps : [];
  // Hide entirely when there are no captured steps AND no preview to offer.
  // Lookback / live with no recording is the common case for older sessions.
  const previewAvailable = typeof ctx.store.fetchRecordingPreview === 'function';
  if (steps.length === 0 && !previewAvailable) return null;

  const stepsOpen = ensureStepsOpenMap(ctx);
  const open = stepsOpen.get(view.id) === true;
  const canEdit = typeof ctx.store.editStepText === 'function'
    && typeof ctx.store.omitStep === 'function';

  const toggle = el('button', {
    class: 'steps-toggle',
    'aria-expanded': String(open),
    title: open ? 'Hide steps' : 'Show steps',
    onclick: (e) => {
      e.stopPropagation();
      stepsOpen.set(view.id, !open);
      ctx.render();
    },
  }, `${open ? '▾' : '▸'} Steps (${steps.length})`);

  const previewBtn = previewAvailable
    ? el('button', {
        class: 'steps-preview-btn',
        title: 'Preview the checkpoint test that reaches this screen in recording.spec.ts',
        onclick: (e) => { e.stopPropagation(); openPreviewSpec(ctx, view); },
      }, 'Preview spec')
    : null;

  const header = el('div', { class: 'steps-disclosure' }, [toggle, previewBtn].filter(Boolean));

  const children = [header];
  if (open && steps.length > 0) {
    children.push(el('ol', { class: 'steps-list' },
      steps.map((step, i) => buildStepRow(ctx, step, i + 1, canEdit))));
  } else if (open && steps.length === 0) {
    children.push(el('div', { class: 'steps-empty' },
      'No steps yet — press Mark-start in the capture overlay, then interact.'));
  }
  return el('div', { class: 'steps-block' }, children);
}

/** One numbered row. Renders struck-through when omitted, with [edit]/[×]
 *  affordances when the store supports it. */
function buildStepRow(ctx, step, n, canEdit) {
  const omitted = step.omitted === true;
  const human = humanFor(step);

  const num = el('span', { class: 'step-num' }, `${n}.`);
  const textNode = el('span', {
    class: `step-text${omitted ? ' step-omitted' : ''}`,
    title: step.code || '',
  }, human);
  if (canEdit) {
    textNode.addEventListener('click', (e) => {
      e.stopPropagation();
      if (omitted) return; // omitted rows are read-only until unomitted
      startStepEdit(ctx, textNode, step);
    });
  }

  const actions = canEdit
    ? el('span', { class: 'step-actions' }, [
        el('button', {
          class: 'step-act-btn',
          title: 'Edit human label',
          onclick: (e) => {
            e.stopPropagation();
            if (omitted) return;
            startStepEdit(ctx, textNode, step);
          },
        }, 'edit'),
        el('button', {
          class: 'step-act-btn step-act-omit',
          title: omitted ? 'Restore step' : 'Omit from emitted spec',
          onclick: (e) => { e.stopPropagation(); toggleOmit(ctx, step); },
        }, omitted ? 'undo' : '×'),
      ])
    : null;

  return el('li', { class: `step-row${omitted ? ' is-omitted' : ''}`, dataset: { id: step.id } },
    [num, textNode, actions].filter(Boolean));
}

/** Inline-edit the human label only. Cmd/Ctrl+Enter or blur commit, Esc cancel. */
function startStepEdit(ctx, textNode, step) {
  const current = humanFor(step);
  const input = el('input', { class: 'step-text-edit', type: 'text' });
  input.value = current;
  input.addEventListener('click', (e) => e.stopPropagation());
  let done = false;
  const commit = async () => {
    if (done) return; done = true;
    const next = input.value;
    try {
      await ctx.store.editStepText({ stepId: step.id, humanText: next });
      ctx.render();
    } catch (err) {
      showToast(`Edit failed: ${err?.message || err}`);
      ctx.render();
    }
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); input.blur(); }
    else if (e.key === 'Escape') { done = true; ctx.render(); }
  });
  textNode.replaceWith(input);
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

/** Omit or restore. Omit shows a toast with Undo (matches resolve UX);
 *  restore is silent (it's already the user's explicit intent). */
async function toggleOmit(ctx, step) {
  const wasOmitted = step.omitted === true;
  try {
    if (wasOmitted) {
      await ctx.store.unomitStep({ stepId: step.id });
      ctx.render();
    } else {
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

/** Lazily attach a per-view open/closed map onto ctx.state so re-renders don't
 *  lose disclosure state. Default closed: stepping into a screen with N steps
 *  shouldn't immediately push pins below the fold. */
function ensureStepsOpenMap(ctx) {
  if (!ctx.state.stepsOpen) ctx.state.stepsOpen = new Map();
  return ctx.state.stepsOpen;
}

/** Resolve a step's display text. Override wins; otherwise we ask the same
 *  describeAction the capture popover uses (lib/recorder-format.mjs). */
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
