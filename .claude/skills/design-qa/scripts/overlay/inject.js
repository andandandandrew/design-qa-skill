/**
 * design-qa overlay. Injected via Playwright addInitScript into every frame.
 * Only activates in the top frame.
 *
 * Shadow DOM layout:
 *   .pin-layer    — pin markers in document coordinates. Hidden during
 *                   screenshots (pins are overlaid programmatically in the
 *                   artifact, not baked into the PNG).
 *   .chrome       — UI surface (panel, popovers, modals, toasts). Hidden
 *                   during screenshots via opacity:0; isolated by closed
 *                   shadow root.
 *
 * Visual style matches Figma dark mode: neutral grays, blue accent, comment-
 * bubble pin shape.
 *
 * Daemon bindings on window:
 *   __designQA_loadForUrl, __designQA_ensureView, __designQA_createPin,
 *   __designQA_updatePin (note OR x/y), __designQA_deletePin,
 *   __designQA_renameView, __designQA_deleteView, __designQA_startNewView,
 *   __designQA_sealCurrentView, __designQA_navigateTo, __designQA_listSession
 *
 * Daemon-callable: window.__designQA.setChromeVisible(bool)
 *
 * Terminology: internal data uses "view". UI says "Screen".
 */
(() => {
  if (window !== window.top) return;
  if (window.__designQA_installed) return;
  window.__designQA_installed = true;

  const STATE = {
    viewId: null,
    pins: [],
    activePinId: null,
    placementMode: false,
    inspectorExpanded: false,
    selectedInspectorViewId: null,
    session: { sessionName: '', activeViewId: null, views: [] },
    // Spike 8: recorder state pushed from Node via window.__designQA_setRecorderState.
    // `active` flips when Mark-start fires; `count` is total post-Mark-start steps
    // across all views; `startedAtMs` is the Node-side wall clock at Mark-start
    // (popover computes elapsed from it).
    recorder: { active: false, count: 0, startedAtMs: null, redactionCount: 0 },
  };

  const TEMP_PREFIX = '__temp_';
  const tempId = () => TEMP_PREFIX + Math.random().toString(36).slice(2, 10);

  // ------- DOM setup ----------------------------------------------------

  const host = document.createElement('div');
  host.id = '__design_qa_host';
  host.style.cssText =
    'all: initial; position: absolute; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647; pointer-events: none;';
  const shadow = host.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = `
    :host, * { box-sizing: border-box; }
    .root {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 12px; line-height: 1.4; color: #eeeeee;
      --bg: #1e1e1e; --bg-2: #2c2c2c; --bg-3: #383838; --bg-4: #444444;
      --border: #3d3d3d; --border-strong: #555555;
      --text: #eeeeee; --text-2: #a0a0a0; --text-3: #757575;
      --accent: #0d99ff; --accent-hover: #1fa9ff; --accent-dim: rgba(13,153,255,0.16);
      --danger: #f24822;
    }
    .mono { font-family: 'JetBrains Mono', 'SF Mono', Menlo, monospace; font-feature-settings: 'tnum'; }

    /* Pin layer */
    .pin-layer { position: absolute; top: 0; left: 0; pointer-events: none; }
    .pin {
      position: absolute; width: 24px; height: 24px;
      background: var(--accent); color: #ffffff;
      border-radius: 100% 100% 100% 0;            /* tail at bottom-left */
      font-family: 'Inter', -apple-system, sans-serif;
      font-size: 10px; font-weight: 700;
      display: flex; align-items: center; justify-content: center;
      box-shadow: 0 1px 3px rgba(0,0,0,0.4), 0 0 0 1.5px #ffffff;
      pointer-events: auto; cursor: pointer; user-select: none;
      transition: transform 0.1s, box-shadow 0.1s;
      touch-action: none;                          /* enable pointer drag */
    }
    .pin > span { transform: translate(1px, -1px); }   /* nudge number into the bubble center */
    .pin:hover { background: var(--accent-hover); transform: translate(0, -1px); }
    .pin.active { background: var(--accent-hover); box-shadow: 0 2px 6px rgba(0,0,0,0.5), 0 0 0 1.5px #ffffff, 0 0 0 4px rgba(13,153,255,0.35); }
    .pin.dragging { transition: none; cursor: grabbing; }

    /* Chrome — hidden during screenshots (opacity preserves focus) */
    .chrome { pointer-events: none; }
    .root.capture-mode .chrome,
    .root.capture-mode .pin-layer { opacity: 0; pointer-events: none !important; }
    .root.capture-mode .chrome *,
    .root.capture-mode .pin-layer * {
      transition: none !important; animation: none !important; pointer-events: none !important;
    }

    .placement-cursor { position: fixed; inset: 0; pointer-events: auto; cursor: crosshair; background: transparent; }

    /* Toolbar (collapsed state — minimal Figma-style) */
    .panel {
      position: fixed; top: 12px; right: 12px;
      background: var(--bg-2); border: 1px solid var(--border); border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      pointer-events: auto; overflow: hidden;
      max-height: calc(100vh - 24px); display: flex; flex-direction: column;
      min-width: 0;
    }
    .panel.collapsed { width: auto; }
    /* Bumped from 280→360 in 9c so the Mark-start / Recording chip + chevron
       both fit in the verb bar without overflow:hidden clipping the chevron.
       The body (screens + pins lists) still reads well at this width. */
    .panel:not(.collapsed) { width: 360px; }
    .panel.collapsed .panel-body { display: none; }
    .panel.collapsed .panel-header { border-bottom: none; }

    .panel-header {
      display: flex; gap: 2px; align-items: center;
      padding: 4px; border-bottom: 1px solid var(--border);
    }
    /* Chevron is the always-clickable affordance — never let it shrink or wrap
       out of view when the verb bar grows (e.g. when Mark-start becomes the
       wider Recording · N chip). */
    .panel-header .icon-btn { flex-shrink: 0; }
    /* Always-visible labeled verbs (Comment / Save / New). */
    .tool-btn {
      all: unset; cursor: pointer;
      display: inline-flex; align-items: center; gap: 5px;
      padding: 5px 9px; border-radius: 4px;
      color: var(--text-2); font-size: 11px; font-weight: 500;
      transition: background 0.08s, color 0.08s;
    }
    .tool-btn:hover { background: var(--bg-3); color: var(--text); }
    .tool-btn.active { background: var(--accent); color: #ffffff; }
    .tool-btn.active:hover { background: var(--accent-hover); }
    .tool-btn .tb-ic { display: inline-flex; }
    .tool-btn svg { width: 13px; height: 13px; display: block; }
    .icon-btn {
      all: unset; cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center;
      width: 28px; height: 28px; border-radius: 4px;
      color: var(--text-2); transition: background 0.08s, color 0.08s;
    }
    /* Toggle sits at the far right of the verb bar. */
    .panel-header .icon-btn { margin-left: auto; }
    .icon-btn:hover { background: var(--bg-3); color: var(--text); }
    .icon-btn.active { background: var(--accent); color: #ffffff; }
    .icon-btn.active:hover { background: var(--accent-hover); }
    .icon-btn svg { width: 14px; height: 14px; display: block; }

    /* Inline confirm for the one-way Save (native confirm() can't be used —
       Playwright auto-dismisses it). Shows below the verb bar in either state. */
    .confirm-bar { padding: 9px 11px; border-bottom: 1px solid var(--border); background: var(--bg); }
    .confirm-bar[hidden] { display: none; }
    .confirm-msg { color: var(--text); font-size: 11px; line-height: 1.45; margin-bottom: 8px; max-width: 230px; }
    .confirm-actions { display: flex; gap: 6px; justify-content: flex-end; }
    .confirm-cancel, .confirm-ok {
      all: unset; cursor: pointer; font-size: 11px; font-weight: 500;
      padding: 4px 11px; border-radius: 4px;
    }
    .confirm-cancel { color: var(--text-2); }
    .confirm-cancel:hover { background: var(--bg-3); color: var(--text); }
    .confirm-ok { background: var(--accent); color: #ffffff; }
    .confirm-ok:hover { background: var(--accent-hover); }

    .panel-body { overflow-y: auto; }

    .section { padding: 8px 0; border-bottom: 1px solid var(--border); }
    .section:last-child { border-bottom: none; }
    .section-header {
      display: flex; justify-content: space-between; align-items: center;
      padding: 4px 12px 6px;
    }
    .section-title {
      font-size: 11px; font-weight: 600; color: var(--text-2);
      letter-spacing: 0.02em;
    }

    .empty { padding: 8px 12px; color: var(--text-3); font-size: 11px; }

    /* Screens list */
    .view-list .view-item {
      padding: 6px 12px; cursor: pointer; position: relative;
      transition: background 0.08s;
    }
    .view-list .view-item:hover { background: var(--bg-3); }
    .view-list .view-item.selected { background: var(--accent-dim); }

    .view-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .view-name {
      font-size: 12px; color: var(--text); font-weight: 500;
      flex: 1; min-width: 0;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .view-pins {
      flex-shrink: 0;
      font-size: 10px; font-weight: 600; color: var(--text-2);
      background: var(--bg-3); border: 1px solid var(--border);
      padding: 1px 6px; border-radius: 999px;
      font-family: 'JetBrains Mono', monospace;
    }
    .view-item.active .view-pins { background: var(--accent); color: #ffffff; border-color: transparent; }
    .view-url {
      font-size: 10px; color: var(--text-3); margin-top: 2px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .view-actions {
      display: flex; gap: 4px; margin-top: 6px;
      opacity: 0; transition: opacity 0.08s;
    }
    .view-item:hover .view-actions, .view-item:focus-within .view-actions { opacity: 1; }
    .view-actions button {
      all: unset; cursor: pointer; font-size: 10px;
      padding: 2px 6px; border-radius: 3px;
      color: var(--text-2);
    }
    .view-actions button:hover { color: var(--text); background: var(--bg-4); }
    .view-actions button.danger { color: var(--text-2); }
    .view-actions button.danger:hover { color: var(--danger); background: rgba(242,72,34,0.1); }

    .view-rename-input {
      all: unset; flex: 1; min-width: 0;
      font-size: 12px; color: var(--text); font-weight: 500;
      background: var(--bg); border: 1px solid var(--accent); border-radius: 3px;
      padding: 2px 6px;
    }

    /* Pins list */
    .pin-list .pin-row {
      padding: 6px 12px; display: flex; gap: 8px; align-items: flex-start;
      cursor: pointer; transition: background 0.08s;
    }
    .pin-list .pin-row:hover { background: var(--bg-3); }
    .pin-list .pin-row.active { background: var(--accent-dim); }
    .pin-num {
      width: 16px; height: 16px; flex-shrink: 0;
      background: var(--accent); color: #ffffff;
      border-radius: 100% 100% 100% 0;
      font-family: 'JetBrains Mono', monospace;
      font-size: 9px; font-weight: 700;
      display: flex; align-items: center; justify-content: center;
      margin-top: 1px;
    }
    .pin-note {
      font-size: 12px; color: var(--text); line-height: 1.4;
      white-space: pre-wrap; word-break: break-word;
    }
    .pin-note.empty { color: var(--text-3); font-style: italic; }

    /* Popover (Figma comment composer) */
    .popover-layer { position: absolute; top: 0; left: 0; pointer-events: none; }
    .popover {
      position: absolute; width: 340px;
      background: var(--bg-2); border: 1px solid var(--border); border-radius: 12px;
      pointer-events: auto; overflow: hidden;
      box-shadow: 0 12px 32px rgba(0,0,0,0.55);
      transform: translate(-50%, 24px);
    }
    .popover textarea {
      all: unset; box-sizing: border-box;
      display: block; width: 100%; min-height: 44px; max-height: 200px;
      font-family: inherit; font-size: 13px; line-height: 1.5; color: var(--text);
      background: transparent; padding: 12px 16px; resize: none;
    }
    .popover textarea::placeholder { color: var(--text-3); }
    .popover .actions {
      display: flex; justify-content: space-between; align-items: center;
      padding: 6px 8px 6px 8px;
      border-top: 1px solid var(--border);
    }
    .popover .actions-left { display: flex; gap: 2px; }
    .popover button.text-btn {
      all: unset; cursor: pointer; font-size: 12px;
      color: var(--text-2); padding: 6px 10px; border-radius: 4px;
    }
    .popover button.text-btn:hover { color: var(--text); background: var(--bg-3); }
    .popover button.text-btn.danger { color: var(--text-2); }
    .popover button.text-btn.danger:hover { color: var(--danger); background: rgba(242,72,34,0.1); }
    button.send-btn {
      all: unset; cursor: pointer;
      width: 28px; height: 28px; border-radius: 50%;
      display: inline-flex; align-items: center; justify-content: center;
      background: var(--bg-3); color: var(--text-3);
      transition: background 0.1s, color 0.1s;
    }
    button.send-btn:hover:not([aria-disabled="true"]) { background: var(--accent-hover); }
    button.send-btn.active { background: var(--accent); color: #ffffff; }
    button.send-btn.active:hover { background: var(--accent-hover); }
    button.send-btn[aria-disabled="true"] { cursor: not-allowed; }
    button.send-btn svg { width: 14px; height: 14px; display: block; }

    /* New-comment composer pill (single-line) */
    .composer-pill {
      position: absolute; width: 320px;
      display: flex; align-items: center; gap: 6px;
      background: var(--bg-3); border: 1px solid var(--border); border-radius: 999px;
      padding: 4px 4px 4px 16px;
      pointer-events: auto;
      box-shadow: 0 8px 24px rgba(0,0,0,0.5);
      transform: translate(16px, -50%);
    }
    .composer-pill .pill-input {
      all: unset; box-sizing: border-box; flex: 1; min-width: 0;
      font-family: inherit; font-size: 13px; line-height: 1.4; color: var(--text);
      background: transparent; padding: 6px 0;
    }
    .composer-pill .pill-input::placeholder { color: var(--text-3); }

    /* Modal */
    .modal-layer { position: fixed; inset: 0; pointer-events: none; }
    .modal-backdrop {
      position: fixed; inset: 0; background: rgba(0,0,0,0.5);
      pointer-events: auto; display: flex; align-items: center; justify-content: center;
      padding: 24px;
    }
    .modal {
      background: var(--bg-2); border: 1px solid var(--border); border-radius: 8px;
      box-shadow: 0 12px 48px rgba(0,0,0,0.6);
      min-width: 320px; max-width: 440px;
      padding: 20px;
    }
    .modal-title { font-size: 14px; font-weight: 600; color: var(--text); margin-bottom: 6px; }
    .modal-body { font-size: 12px; color: var(--text-2); line-height: 1.5; margin-bottom: 18px; }
    .modal-actions { display: flex; justify-content: flex-end; gap: 6px; }
    .modal button {
      all: unset; cursor: pointer; padding: 6px 14px;
      border-radius: 4px; font-size: 12px; font-weight: 500;
    }
    .modal button.ghost { color: var(--text-2); }
    .modal button.ghost:hover { color: var(--text); background: var(--bg-3); }
    .modal button.danger { background: var(--danger); color: #ffffff; font-weight: 600; }
    .modal button.danger:hover { background: #d63d1e; }
    .modal button.primary { background: var(--accent); color: #ffffff; font-weight: 600; }
    .modal button.primary:hover { background: var(--accent-hover); }

    /* Spike 8 — Recording chip + popover */
    .tool-btn.recorder-chip.active {
      background: rgba(242, 72, 34, 0.16);
      color: #ff4f33;
    }
    .tool-btn.recorder-chip.active:hover {
      background: rgba(242, 72, 34, 0.25);
    }
    .tool-btn.recorder-chip .rec-dot {
      width: 8px; height: 8px; border-radius: 999px; background: #ff4f33;
      flex-shrink: 0; display: inline-block;
      animation: rec-pulse 1.4s ease-in-out infinite;
    }
    @keyframes rec-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.45; }
    }
    .rec-popover {
      position: fixed; right: 12px; width: 320px;
      background: var(--bg-2); border: 1px solid var(--border); border-radius: 8px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.5);
      pointer-events: auto; overflow: hidden;
      font-size: 12px;
    }
    .rec-popover-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 10px 12px; border-bottom: 1px solid var(--border);
    }
    .rec-popover-title { font-weight: 600; color: var(--text); font-size: 12px; }
    .rec-popover-close {
      all: unset; cursor: pointer; color: var(--text-2);
      width: 22px; height: 22px; border-radius: 4px;
      display: inline-flex; align-items: center; justify-content: center;
    }
    .rec-popover-close:hover { background: var(--bg-3); color: var(--text); }
    .rec-popover-close svg { width: 12px; height: 12px; }
    .rec-popover-meta {
      padding: 8px 12px; color: var(--text-2); font-size: 11px;
      border-bottom: 1px solid var(--border); line-height: 1.5;
    }
    .rec-popover-meta b { color: var(--text); font-weight: 600; }
    .rec-redact-chip {
      display: inline-block; margin-left: 6px;
      padding: 1px 6px; border-radius: 999px; font-size: 10px;
      background: rgba(13, 153, 255, 0.16); color: var(--accent);
      font-family: 'JetBrains Mono', monospace; font-weight: 600;
    }
    .rec-popover-list {
      max-height: 240px; overflow-y: auto;
      padding: 6px 0;
    }
    .rec-popover-list-empty {
      padding: 14px; text-align: center; color: var(--text-3); font-size: 11px;
    }
    .rec-step {
      padding: 5px 12px; color: var(--text); font-size: 11px;
      display: flex; gap: 8px; line-height: 1.45;
    }
    .rec-step + .rec-step { border-top: 1px solid rgba(255,255,255,0.04); }
    .rec-step:hover { background: var(--bg-3); }
    .rec-step .rec-step-n {
      flex-shrink: 0; color: var(--text-3);
      font-family: 'JetBrains Mono', 'SF Mono', Menlo, monospace;
      font-size: 10px; width: 22px; text-align: right;
    }
    .rec-step .rec-step-text { flex: 1; word-break: break-word; }
    .rec-step .rec-step-text code {
      background: var(--bg-3); padding: 0 4px; border-radius: 3px;
      font-family: 'JetBrains Mono', 'SF Mono', Menlo, monospace; font-size: 10px;
    }
    .rec-step .rec-step-text strong { color: var(--text); font-weight: 600; }
    .rec-popover-actions {
      display: flex; justify-content: space-between; gap: 6px;
      padding: 8px 12px; border-top: 1px solid var(--border);
      background: var(--bg);
    }
    .rec-popover-actions button {
      all: unset; cursor: pointer; font-size: 11px; font-weight: 500;
      padding: 5px 10px; border-radius: 4px;
    }
    .rec-popover-actions button.ghost { color: var(--text-2); }
    .rec-popover-actions button.ghost:hover { color: var(--text); background: var(--bg-3); }
    .rec-popover-actions button.danger { color: var(--danger); }
    .rec-popover-actions button.danger:hover { background: rgba(242,72,34,0.1); }

    /* Toast */
    .toast-layer {
      position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%);
      display: flex; flex-direction: column; gap: 6px;
      pointer-events: none; align-items: center;
    }
    .toast {
      background: var(--bg-2); border: 1px solid var(--border); border-radius: 6px;
      padding: 6px 14px; font-size: 11px; color: var(--text);
      box-shadow: 0 4px 16px rgba(0,0,0,0.5);
      transition: opacity 0.2s, transform 0.2s;
      pointer-events: auto;
    }
    .toast.out { opacity: 0; transform: translateY(6px); }
  `;
  shadow.appendChild(style);

  const root = document.createElement('div');
  root.className = 'root';
  shadow.appendChild(root);

  // Pin layer
  const pinLayer = document.createElement('div');
  pinLayer.className = 'pin-layer';
  root.appendChild(pinLayer);

  // Chrome subtree
  const chrome = document.createElement('div');
  chrome.className = 'chrome';

  // SVG icons
  const ICON_COMMENT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>`;
  const ICON_X = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
  const ICON_CHEVRON_DOWN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;
  const ICON_CHEVRON_UP = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>`;
  const ICON_CHECK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
  const ICON_PLUS = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
  const ICON_REC = `<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="5"/></svg>`;

  // addBtn label content (icon + word); swapped to a Cancel state in placement mode.
  const ADD_LABEL = `<span class="tb-ic">${ICON_COMMENT}</span><span class="tb-label">Comment</span>`;
  const CANCEL_LABEL = `<span class="tb-ic">${ICON_X}</span><span class="tb-label">Cancel</span>`;

  const panel = document.createElement('div');
  panel.className = 'panel collapsed';
  panel.innerHTML = `
    <div class="panel-header">
      <button class="tool-btn" id="addBtn" title="Click, then click on the page to drop a comment">${ADD_LABEL}</button>
      <button class="tool-btn" id="saveViewBtn" title="Save this screen — lock it here; finish edits in the console"><span class="tb-ic">${ICON_CHECK}</span><span class="tb-label">Save</span></button>
      <button class="tool-btn" id="newViewBtn" title="Save this screen and start a fresh one on this URL"><span class="tb-ic">${ICON_PLUS}</span><span class="tb-label">New</span></button>
      <button class="tool-btn recorder-chip" id="recBtn" title="Mark the start of the recording the engineer will replay"><span class="tb-ic">${ICON_REC}</span><span class="tb-label">Mark start</span></button>
      <button class="icon-btn" id="toggleBtn" title="Show screens & pins">${ICON_CHEVRON_DOWN}</button>
    </div>
    <div class="confirm-bar" id="confirmBar" hidden>
      <div class="confirm-msg">Lock this screen? You won't be able to add or edit it here — finish in the console.</div>
      <div class="confirm-actions">
        <button class="confirm-cancel" id="saveCancelBtn">Cancel</button>
        <button class="confirm-ok" id="saveConfirmBtn">Save</button>
      </div>
    </div>
    <div class="panel-body" id="panelBody">
      <div class="section">
        <div class="section-header">
          <span class="section-title" id="viewsHeader">Screens</span>
        </div>
        <div class="view-list" id="viewList"></div>
      </div>
      <div class="section">
        <div class="section-header">
          <span class="section-title" id="pinsHeader">Pins</span>
        </div>
        <div class="pin-list" id="pinList"></div>
      </div>
    </div>
  `;
  chrome.appendChild(panel);

  const popoverLayer = document.createElement('div');
  popoverLayer.className = 'popover-layer';
  chrome.appendChild(popoverLayer);

  const modalLayer = document.createElement('div');
  modalLayer.className = 'modal-layer';
  chrome.appendChild(modalLayer);

  const toastLayer = document.createElement('div');
  toastLayer.className = 'toast-layer';
  chrome.appendChild(toastLayer);

  root.appendChild(chrome);

  let placementOverlay = null;

  // ------- Utility -------------------------------------------------------

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
    );
  }
  function $(id) { return shadow.getElementById(id); }
  function stop(e) { e.stopPropagation(); }
  function truncate(s, n) { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  // Trace helper for STATE.pins divergence (bug #1). Toggle via window flag.
  function logPins(tag) {
    if (!window.__designQA_debug) return;
    console.log(
      `[design-qa] pins@${tag} view=${STATE.viewId} active=${STATE.activePinId}`,
      STATE.pins.map((p) => `${p.id}:${JSON.stringify((p.note || '').slice(0, 12))}`),
    );
  }

  // Authoritative re-sync: rebuild STATE.pins for the current view from the
  // daemon (the only writer). Fixes canvas/daemon divergence + numbering.
  // Safe to call only when no temp/composer pin is pending (it would be dropped).
  async function reloadActiveViewPins() {
    if (!STATE.viewId) return;
    try {
      const { view } = await window.__designQA_loadForUrl({ url: location.href });
      if (view && view.id === STATE.viewId) {
        STATE.pins = view.pins.map((p) => ({ id: p.id, x: p.x, y: p.y, note: p.note }));
        logPins('reload');
        renderPins();
      }
    } catch (e) {
      console.warn('design-qa: reloadActiveViewPins failed', e);
    }
  }

  // Insulate the page from clicks/keys aimed at our UI.
  // Bubble phase (false) — let events reach our buttons first, then stop here.
  for (const evt of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'keydown', 'keypress', 'keyup']) {
    chrome.addEventListener(evt, stop, false);
  }

  // ------- Toast --------------------------------------------------------

  function toast(message, { duration = 2400 } = {}) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = message;
    toastLayer.appendChild(el);
    setTimeout(() => el.classList.add('out'), duration);
    setTimeout(() => el.remove(), duration + 250);
  }

  // ------- Modal --------------------------------------------------------

  function confirmModal({ title, body, confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false }) {
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop';
      const dlg = document.createElement('div');
      dlg.className = 'modal';
      dlg.innerHTML = `
        <div class="modal-title">${escapeHtml(title)}</div>
        <div class="modal-body">${escapeHtml(body)}</div>
        <div class="modal-actions">
          <button class="ghost" data-act="cancel">${escapeHtml(cancelLabel)}</button>
          <button class="${danger ? 'danger' : 'primary'}" data-act="confirm">${escapeHtml(confirmLabel)}</button>
        </div>
      `;
      backdrop.appendChild(dlg);
      modalLayer.appendChild(backdrop);
      const finish = (result) => {
        backdrop.remove();
        window.removeEventListener('keydown', onKey, { capture: true });
        resolve(result);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); finish(false); }
        else if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      };
      window.addEventListener('keydown', onKey, { capture: true });
      dlg.querySelector('[data-act="cancel"]').addEventListener('click', () => finish(false));
      dlg.querySelector('[data-act="confirm"]').addEventListener('click', () => finish(true));
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) finish(false); });
      requestAnimationFrame(() => dlg.querySelector('[data-act="confirm"]').focus?.());
    });
  }

  // ------- Render: pins -------------------------------------------------

  function renderPins() {
    pinLayer.innerHTML = '';
    STATE.pins.forEach((pin, i) => {
      const el = document.createElement('div');
      el.className = 'pin' + (pin.id === STATE.activePinId ? ' active' : '');
      // Anchor: pin's bottom-left tail tip at (x, y). Element's box top-left
      // is (x, y - 24); since the bubble has its tail at bottom-left.
      el.style.left = pin.x + 'px';
      el.style.top = (pin.y - 24) + 'px';
      el.dataset.id = pin.id;
      el.innerHTML = `<span>${i + 1}</span>`;
      attachPinHandlers(el, pin);
      pinLayer.appendChild(el);
    });
    logPins('renderPins');
    updateCount();
  }

  function attachPinHandlers(el, pin) {
    let dragState = null; // { startX, startY, startPinX, startPinY, moved, popoverWasOpen }

    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      // Don't allow drag while the pin is still being created server-side.
      // Click-to-toggle-popover still works via the pointerup-no-move path.
      e.preventDefault();
      el.setPointerCapture?.(e.pointerId);
      dragState = {
        startX: e.clientX, startY: e.clientY,
        startPinX: pin.x, startPinY: pin.y,
        moved: false,
        popoverWasOpen: STATE.activePinId === pin.id,
        canDrag: !String(pin.id).startsWith(TEMP_PREFIX),
      };
    });

    el.addEventListener('pointermove', (e) => {
      if (!dragState || !dragState.canDrag) return;
      const dx = e.clientX - dragState.startX;
      const dy = e.clientY - dragState.startY;
      if (!dragState.moved && Math.hypot(dx, dy) > 3) {
        dragState.moved = true;
        el.classList.add('dragging');
        if (STATE.activePinId === pin.id) {
          popoverLayer.innerHTML = '';
        }
      }
      if (dragState.moved) {
        pin.x = dragState.startPinX + dx;
        pin.y = dragState.startPinY + dy;
        el.style.left = pin.x + 'px';
        el.style.top = (pin.y - 24) + 'px';
      }
    });

    el.addEventListener('pointerup', async (e) => {
      if (!dragState) return;
      const wasDrag = dragState.moved;
      const popoverWasOpen = dragState.popoverWasOpen;
      el.classList.remove('dragging');
      el.releasePointerCapture?.(e.pointerId);
      dragState = null;
      if (wasDrag) {
        if (!String(pin.id).startsWith(TEMP_PREFIX)) {
          try { await window.__designQA_updatePin({ pinId: pin.id, x: pin.x, y: pin.y }); }
          catch (err) { console.warn('design-qa: drag persist failed', err); }
        }
        refreshSession();
        // Re-open popover if it was open before the drag started.
        if (popoverWasOpen) {
          STATE.activePinId = pin.id;
          renderPopover();
        }
      } else {
        // Click — toggle popover.
        STATE.activePinId = pin.id === STATE.activePinId ? null : pin.id;
        renderPins();
        renderPopover();
      }
    });

    el.addEventListener('pointercancel', () => {
      if (!dragState) return;
      el.classList.remove('dragging');
      dragState = null;
    });
  }

  function updateCount() {
    // No-op: count is shown in the inspector's section header.
  }

  const ICON_ARROW_UP = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>`;

  function renderPopover() {
    popoverLayer.innerHTML = '';
    if (!STATE.activePinId) return;
    const pin = STATE.pins.find((p) => p.id === STATE.activePinId);
    if (!pin) return;
    const isTemp = String(pin.id).startsWith(TEMP_PREFIX);

    const pop = document.createElement('div');
    pop.style.left = pin.x + 'px';
    pop.style.top = pin.y + 'px';
    if (isTemp) {
      // New comment: compact single-line pill (input + inline send button).
      pop.className = 'composer-pill';
      pop.innerHTML = `
        <input type="text" class="pill-input" placeholder="Add a comment" />
        <button class="send-btn" data-act="send" aria-disabled="true" title="Send">${ICON_ARROW_UP}</button>
      `;
    } else {
      // Existing comment: multi-line card with delete affordance.
      pop.className = 'popover';
      pop.innerHTML = `
        <textarea placeholder="Add a comment" rows="2"></textarea>
        <div class="actions">
          <div class="actions-left">
            <button class="text-btn danger" data-act="delete">Delete</button>
          </div>
          <button class="send-btn" data-act="send" aria-disabled="true" title="Send">${ICON_ARROW_UP}</button>
        </div>
      `;
    }
    popoverLayer.appendChild(pop);
    // Field is a <textarea> (card) or <input> (pill); both share the value /
    // focus / selection / event APIs the handlers below rely on.
    const ta = pop.querySelector('textarea') || pop.querySelector('.pill-input');
    const sendBtn = pop.querySelector('.send-btn');
    ta.value = pin.note || '';
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);

    function updateSendState() {
      const hasText = ta.value.trim().length > 0;
      sendBtn.classList.toggle('active', hasText);
      sendBtn.setAttribute('aria-disabled', hasText ? 'false' : 'true');
    }
    updateSendState();

    let saveTimer = null;
    const persistExisting = async () => {
      pin.note = ta.value;
      try { await window.__designQA_updatePin({ pinId: pin.id, note: pin.note }); }
      catch (e) { console.warn('design-qa: updatePin failed', e); }
      refreshSession();
    };

    const commit = async () => {
      const text = ta.value.trim();
      if (!text) return; // nothing to send
      if (isTemp) {
        const tempIdVal = pin.id;
        // Lazy-create the view here too, so dismissed temp pins don't leave
        // empty screens behind.
        let createdNewView = false;
        if (!STATE.viewId) {
          try {
            const result = await window.__designQA_ensureView({
              url: location.href,
              title: document.title || location.href,
              viewport: { width: window.innerWidth, height: window.innerHeight },
            });
            STATE.viewId = result.viewId;
            createdNewView = !!result.isNew;
          } catch (e) {
            console.warn('design-qa: ensureView failed', e);
            STATE.pins = STATE.pins.filter((p) => p.id !== tempIdVal);
            STATE.activePinId = null;
            renderPins();
            renderPopover();
            return;
          }
        }
        try {
          const { pinId } = await window.__designQA_createPin({
            viewId: STATE.viewId, x: pin.x, y: pin.y, note: ta.value,
          });
          // Promote the captured temp pin object in place (no findIndex —
          // robust to STATE.pins being mutated during the await). If a
          // click-outside discarded it mid-flight, re-add it so the canvas
          // never loses a pin the daemon already persisted (bug #1).
          pin.id = pinId;
          pin.note = ta.value;
          if (!STATE.pins.includes(pin)) STATE.pins.push(pin);
          logPins('commit-swap');
          if (createdNewView) {
            toast(`Started screen for ${truncate(document.title || location.href, 48)}`);
          }
        } catch (e) {
          console.warn('design-qa: createPin failed', e);
          STATE.pins = STATE.pins.filter((p) => p.id !== tempIdVal);
        }
      } else {
        if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
        await persistExisting();
      }
      STATE.activePinId = null;
      renderPins();
      renderPopover();
      // Reconcile canvas against the daemon's authoritative pin set so ids,
      // ordering and numbering always match session.json.
      await reloadActiveViewPins();
      refreshSession();
    };

    const discardOrClose = () => {
      // For a temp pin: discard (do not call createPin). For existing: just close.
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      if (isTemp) {
        STATE.pins = STATE.pins.filter((p) => p.id !== pin.id);
      } else if (ta.value !== (pin.note || '')) {
        // Existing pin: save any in-flight edits before closing.
        persistExisting();
      }
      STATE.activePinId = null;
      renderPins();
      renderPopover();
    };

    ta.addEventListener('input', () => {
      updateSendState();
      if (isTemp) return; // don't auto-save until user explicitly Sends
      pin.note = ta.value;
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(persistExisting, 600);
    });

    ta.addEventListener('keydown', (e) => {
      const isCommit = (e.key === 'Enter' && !e.shiftKey) || ((e.metaKey || e.ctrlKey) && e.key === 'Enter');
      if (isCommit) { e.preventDefault(); commit(); return; }
      if (e.key === 'Escape') { e.preventDefault(); discardOrClose(); }
    });

    sendBtn.addEventListener('click', () => {
      if (sendBtn.getAttribute('aria-disabled') === 'true') return;
      commit();
    });

    pop.querySelector('[data-act="delete"]')?.addEventListener('click', async () => {
      const pinIdToDelete = pin.id;
      STATE.pins = STATE.pins.filter((p) => p.id !== pinIdToDelete);
      STATE.activePinId = null;
      renderPins();
      renderPopover();
      try {
        await window.__designQA_deletePin({ pinId: pinIdToDelete });
        toast('Comment deleted');
      } catch (e) {
        console.warn('design-qa: deletePin failed', e);
        STATE.pins.push({ ...pin });
        renderPins();
      }
      refreshSession();
    });
  }

  function closePopoverIfOpen() {
    if (!STATE.activePinId) return;
    const activeId = STATE.activePinId;
    const isTemp = String(activeId).startsWith(TEMP_PREFIX);
    if (isTemp) {
      // Discard the un-sent temp pin entirely. Only temp pins are dropped —
      // a real pin must never be removed here (bug #1).
      STATE.pins = STATE.pins.filter((p) => p.id !== activeId);
      logPins('closePopover-discard-temp');
    }
    STATE.activePinId = null;
    renderPins();
    renderPopover();
  }

  // Click outside the popover (and outside any pin) closes it.
  // Uses composedPath so we can see into our shadow DOM.
  document.addEventListener('click', (e) => {
    if (!STATE.activePinId) return;
    const path = e.composedPath?.() || [];
    for (const node of path) {
      if (!node || !node.classList) continue;
      if (node.classList.contains('pin') || node.classList.contains('popover') || node.classList.contains('composer-pill')) return;
    }
    logPins('click-outside-close');
    closePopoverIfOpen();
  }, true);

  // ------- Render: inspector --------------------------------------------

  function renderInspector() {
    const { views, activeViewId } = STATE.session;
    if (!STATE.selectedInspectorViewId && activeViewId) {
      STATE.selectedInspectorViewId = activeViewId;
    }
    if (STATE.selectedInspectorViewId && !views.find((v) => v.id === STATE.selectedInspectorViewId)) {
      STATE.selectedInspectorViewId = activeViewId || null;
    }

    const viewsHeader = $('viewsHeader');
    if (viewsHeader) viewsHeader.textContent = `Screens · ${views.length}`;

    const viewList = $('viewList');
    if (views.length === 0) {
      viewList.innerHTML = '<div class="empty">No screens yet. Click the comment button, then click anywhere on the page.</div>';
    } else {
      viewList.innerHTML = views.map((v) => `
        <div class="view-item ${v.id === activeViewId ? 'active' : ''} ${v.id === STATE.selectedInspectorViewId ? 'selected' : ''}" data-id="${v.id}">
          <div class="view-row">
            <span class="view-name">${escapeHtml(v.name)}</span>
            <span class="view-pins">${v.pinCount}</span>
          </div>
          <div class="view-url" title="${escapeHtml(v.url)}">${escapeHtml(v.url)}</div>
          <div class="view-actions">
            ${v.id === activeViewId ? '' : '<button data-act="jump" title="Navigate the browser to this URL">Jump</button>'}
            <button data-act="rename">Rename</button>
            <button class="danger" data-act="delete">Delete</button>
          </div>
        </div>
      `).join('');
      viewList.querySelectorAll('.view-item').forEach((el) => {
        const id = el.dataset.id;
        el.addEventListener('click', (e) => {
          if (e.target.closest('.view-actions')) return;
          STATE.selectedInspectorViewId = id;
          renderInspector();
        });
        el.querySelector('[data-act="jump"]')?.addEventListener('click', () => jumpToView(id));
        el.querySelector('[data-act="rename"]')?.addEventListener('click', () => beginRename(el, id));
        el.querySelector('[data-act="delete"]')?.addEventListener('click', () => confirmDeleteView(id));
      });
    }

    const selectedView = views.find((v) => v.id === STATE.selectedInspectorViewId);
    const pinsHeader = $('pinsHeader');
    if (pinsHeader) pinsHeader.textContent = selectedView ? `Pins · ${selectedView.pinCount}` : 'Pins';

    const pinList = $('pinList');
    if (!selectedView || selectedView.pinCount === 0) {
      pinList.innerHTML = '<div class="empty">No pins on this screen.</div>';
    } else {
      pinList.innerHTML = selectedView.pins.map((p, i) => `
        <div class="pin-row ${p.id === STATE.activePinId ? 'active' : ''}" data-id="${p.id}">
          <span class="pin-num">${i + 1}</span>
          <span class="pin-note ${p.note ? '' : 'empty'}">${p.note ? escapeHtml(p.note) : '(no comment)'}</span>
        </div>
      `).join('');
      pinList.querySelectorAll('.pin-row').forEach((el) => {
        el.addEventListener('click', () => focusPinFromInspector(el.dataset.id, selectedView.id));
      });
    }
  }

  // ------- Inspector actions --------------------------------------------

  async function jumpToView(viewId) {
    const v = STATE.session.views.find((x) => x.id === viewId);
    if (!v) return;
    try { await window.__designQA_navigateTo({ url: v.url }); }
    catch (e) { console.warn('design-qa: navigateTo failed', e); }
  }

  function beginRename(viewItemEl, viewId) {
    const v = STATE.session.views.find((x) => x.id === viewId);
    if (!v) return;
    const nameEl = viewItemEl.querySelector('.view-name');
    if (!nameEl) return;
    const input = document.createElement('input');
    input.className = 'view-rename-input';
    input.value = v.name;
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      if (save) {
        const name = input.value.trim();
        if (name && name !== v.name) {
          try { await window.__designQA_renameView({ viewId, name }); }
          catch (e) { console.warn('design-qa: renameView failed', e); }
        }
      }
      refreshSession();
    };
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
  }

  async function confirmDeleteView(viewId) {
    const v = STATE.session.views.find((x) => x.id === viewId);
    if (!v) return;
    const ok = await confirmModal({
      title: 'Delete screen?',
      body: v.pinCount > 0
        ? `"${v.name}" has ${v.pinCount} pin${v.pinCount === 1 ? '' : 's'}. Deleting this screen will remove its pins and screenshot. This can't be undone.`
        : `Delete empty screen "${v.name}"?`,
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!ok) return;
    try { await window.__designQA_deleteView({ viewId }); }
    catch (e) { console.warn('design-qa: deleteView failed', e); return; }
    if (STATE.viewId === viewId) {
      STATE.viewId = null;
      STATE.pins = [];
      STATE.activePinId = null;
      renderPins();
      renderPopover();
    }
    toast('Screen deleted');
    refreshSession();
  }

  async function startNewScreenHere() {
    let result;
    try { result = await window.__designQA_startNewView({ url: location.href }); }
    catch (e) { console.warn('design-qa: startNewView failed', e); return; }
    STATE.viewId = result.newViewId;
    STATE.pins = [];
    STATE.activePinId = null;
    renderPins();
    renderPopover();
    if (!STATE.inspectorExpanded) setInspectorExpanded(true);
    await refreshSession();
    if (result.newViewId) {
      requestAnimationFrame(() => {
        const row = shadow.querySelector(`.view-item[data-id="${result.newViewId}"]`);
        if (row) {
          STATE.selectedInspectorViewId = result.newViewId;
          beginRename(row, result.newViewId);
        }
      });
    }
    toast('New screen — give it a name');
  }

  // "Save": seal the current screen so it becomes console-owned. Does NOT end
  // the session — the browser stays live; placing a pin on this URL afterward
  // auto-creates a fresh screen. The one-way nature is made explicit via an
  // INLINE confirm in the toolbar (native confirm() is auto-dismissed by
  // Playwright, so it can't be used here). See console-architecture lifecycle
  // "Save feedback / Done".

  function setSaveConfirm(open) {
    const bar = $('confirmBar');
    const btn = $('saveViewBtn');
    if (bar) bar.hidden = !open;
    if (btn) btn.classList.toggle('active', open);
    if (open) window.addEventListener('keydown', confirmEsc, { capture: true });
    else window.removeEventListener('keydown', confirmEsc, { capture: true });
  }

  function confirmEsc(e) {
    if (e.key === 'Escape') { e.preventDefault(); setSaveConfirm(false); }
  }

  // Gate before showing the confirm: nothing committed on this screen → toast.
  function requestSaveCurrentScreen() {
    const realPins = STATE.pins.filter((p) => !String(p.id).startsWith(TEMP_PREFIX));
    if (!STATE.viewId || realPins.length === 0) {
      toast('Add a comment before saving this screen');
      return;
    }
    setSaveConfirm(true);
  }

  async function performSaveCurrentScreen() {
    setSaveConfirm(false);
    let result;
    try { result = await window.__designQA_sealCurrentView({ url: location.href }); }
    catch (e) { console.warn('design-qa: sealCurrentView failed', e); return; }
    // Reset local state: there's no editable view for this URL anymore. The next
    // pin's commit calls ensureView, which creates a fresh screen.
    STATE.viewId = null;
    STATE.pins = [];
    STATE.activePinId = null;
    renderPins();
    renderPopover();
    await refreshSession();
    if (result.ok) toast('Feedback saved — make further changes in the console');
    else if (result.reason === 'empty') toast('Add a comment before saving this screen');
    else toast('Nothing to save on this screen');
  }

  // ------- Spike 8 — Recording chip + popover --------------------------

  // Re-render the verb-bar chip from STATE.recorder. Called whenever the
  // Node-side setter pushes new state; cheap, ~constant time.
  function renderRecorderChip() {
    const btn = $('recBtn');
    if (!btn) return;
    const r = STATE.recorder;
    if (r.active) {
      btn.classList.add('active');
      btn.innerHTML = `<span class="rec-dot"></span><span class="tb-label">Recording · ${r.count}</span>`;
      btn.title = 'Open recording details';
    } else {
      btn.classList.remove('active');
      btn.innerHTML = `<span class="tb-ic">${ICON_REC}</span><span class="tb-label">Mark start</span>`;
      btn.title = 'Mark the start of the recording the engineer will replay';
    }
  }

  // Popover state: a single transient element in `chrome`; null when closed.
  let recPopoverEl = null;
  let recStopwatchTimer = null;

  function formatElapsed(ms) {
    if (!ms || ms < 0) return '0:00';
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')}`;
  }

  /** Strip the markdown bold + backtick used in describeAction so the inline
   *  popover renders without a markdown parser. Code spans become <code>,
   *  bold becomes <strong>. */
  function renderInlineMd(text) {
    const escaped = escapeHtml(text);
    return escaped
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  }

  function renderRecPopoverMeta() {
    if (!recPopoverEl) return;
    const r = STATE.recorder;
    const meta = recPopoverEl.querySelector('.rec-popover-meta');
    if (!meta) return;
    const elapsedText = r.startedAtMs
      ? `Started ${formatElapsed(Date.now() - r.startedAtMs)} ago`
      : 'Not recording';
    const redactChip = r.redactionCount > 0
      ? ` <span class="rec-redact-chip" title="${r.redactionCount} value(s) redacted from captured fields">${r.redactionCount} redacted</span>`
      : '';
    meta.innerHTML =
      `${elapsedText} · <b>${r.count}</b> step${r.count === 1 ? '' : 's'} captured${redactChip}`;
  }

  function renderRecPopoverList(payload) {
    if (!recPopoverEl) return;
    const list = recPopoverEl.querySelector('.rec-popover-list');
    if (!list) return;
    if (!payload || !payload.steps || payload.steps.length === 0) {
      list.innerHTML = '<div class="rec-popover-list-empty">No steps yet on the recorded path.</div>';
      return;
    }
    const startNum = Math.max(1, payload.steps.length - 99);
    list.innerHTML = payload.steps
      .map((s, i) => `<div class="rec-step"><span class="rec-step-n">${startNum + i}.</span><span class="rec-step-text">${renderInlineMd(s.humanText || '')}</span></div>`)
      .join('');
    // Scroll to the latest step.
    list.scrollTop = list.scrollHeight;
  }

  async function refreshRecPopoverList() {
    if (!recPopoverEl) return;
    try {
      const payload = await window.__designQA_fetchRecorderSteps();
      renderRecPopoverList(payload);
    } catch (err) {
      console.warn('design-qa: fetchRecorderSteps failed', err);
    }
  }

  function positionRecPopover() {
    if (!recPopoverEl) return;
    const top = panel.getBoundingClientRect().bottom + 6;
    recPopoverEl.style.top = `${top}px`;
  }

  function openRecordingPopover() {
    if (recPopoverEl) return;
    recPopoverEl = document.createElement('div');
    recPopoverEl.className = 'rec-popover';
    recPopoverEl.innerHTML = `
      <div class="rec-popover-header">
        <div class="rec-popover-title">Recording</div>
        <button class="rec-popover-close" id="recPopoverCloseBtn" title="Close">${ICON_X}</button>
      </div>
      <div class="rec-popover-meta">Loading…</div>
      <div class="rec-popover-list"><div class="rec-popover-list-empty">Loading…</div></div>
      <div class="rec-popover-actions">
        <button class="ghost" id="recResetBtn" title="Move the start of recording to now">Reset start here</button>
        <button class="danger" id="recStopBtn" title="Turn recording off; existing steps move to preconditions">Stop recording</button>
      </div>
    `;
    chrome.appendChild(recPopoverEl);
    positionRecPopover();
    renderRecPopoverMeta();
    refreshRecPopoverList();

    // Stopwatch tick — only while popover is open AND active.
    if (recStopwatchTimer) clearInterval(recStopwatchTimer);
    recStopwatchTimer = setInterval(() => {
      if (!recPopoverEl) return;
      if (!STATE.recorder.active) return;
      renderRecPopoverMeta();
    }, 1000);
  }

  function closeRecordingPopover() {
    if (!recPopoverEl) return;
    recPopoverEl.remove();
    recPopoverEl = null;
    if (recStopwatchTimer) { clearInterval(recStopwatchTimer); recStopwatchTimer = null; }
  }

  // Node → shadow push setter, called via page.evaluate from capture.mjs.
  // Defensive: state may be partial; merge into the current STATE.recorder.
  window.__designQA_setRecorderState = (state) => {
    if (!state || typeof state !== 'object') return;
    STATE.recorder = {
      active: !!state.active,
      count: Number.isFinite(state.count) ? state.count : 0,
      startedAtMs: typeof state.startedAtMs === 'number' ? state.startedAtMs : null,
      redactionCount: Number.isFinite(state.redactionCount) ? state.redactionCount : 0,
    };
    renderRecorderChip();
    if (recPopoverEl) {
      renderRecPopoverMeta();
      // Re-fetch list — count changed means a new step may have landed.
      refreshRecPopoverList();
      // Active flipped to false? Close the popover (nothing to show).
      if (!STATE.recorder.active) closeRecordingPopover();
    }
  };

  // Chip click: resting → call Mark-start binding; active → toggle popover.
  async function onRecChipClick() {
    if (STATE.recorder.active) {
      if (recPopoverEl) closeRecordingPopover();
      else openRecordingPopover();
      return;
    }
    try { await window.__designQA_markStart(); }
    catch (err) { console.warn('design-qa: markStart failed', err); }
    // The state push from Node will flip the chip; no manual update needed.
  }

  async function onRecPopoverClick(e) {
    const btn = e.target?.closest?.('button');
    if (!btn) return;
    const id = btn.id;
    if (id === 'recPopoverCloseBtn') { closeRecordingPopover(); return; }
    if (id === 'recResetBtn') {
      try { await window.__designQA_markStart(); }
      catch (err) { console.warn('design-qa: markStart (reset) failed', err); }
      return;
    }
    if (id === 'recStopBtn') {
      try { await window.__designQA_stopRecording(); }
      catch (err) { console.warn('design-qa: stopRecording failed', err); }
      // The push handler closes the popover when active flips false.
      return;
    }
  }

  // Keep the popover anchored to the panel as the panel resizes/expands.
  const recReposObs = new ResizeObserver(() => positionRecPopover());
  recReposObs.observe(panel);

  // ------- end Spike 8 popover ----------------------------------------

  function focusPinFromInspector(pinId, viewId) {
    if (viewId === STATE.viewId) {
      const pin = STATE.pins.find((p) => p.id === pinId);
      if (pin) {
        STATE.activePinId = pinId;
        renderPins();
        renderPopover();
        window.scrollTo({ left: pin.x - window.innerWidth / 2, top: pin.y - window.innerHeight / 2, behavior: 'smooth' });
      }
    }
    renderInspector();
  }

  // ------- Placement mode ----------------------------------------------

  function setPlacementMode(on) {
    STATE.placementMode = on;
    const btn = $('addBtn');
    if (btn) {
      btn.innerHTML = on ? CANCEL_LABEL : ADD_LABEL;
      btn.classList.toggle('active', on);
      btn.title = on ? 'Cancel comment placement' : 'Click, then click on the page to drop a comment';
    }
    if (on) {
      placementOverlay = document.createElement('div');
      placementOverlay.className = 'placement-cursor';
      placementOverlay.addEventListener('click', onPlacementClick, { capture: true });
      placementOverlay.addEventListener('contextmenu', (e) => { e.preventDefault(); setPlacementMode(false); });
      window.addEventListener('keydown', escCancel, { capture: true });
      chrome.appendChild(placementOverlay);
    } else if (placementOverlay) {
      placementOverlay.remove();
      placementOverlay = null;
      window.removeEventListener('keydown', escCancel, { capture: true });
    }
  }

  function escCancel(e) {
    if (e.key === 'Escape') { e.preventDefault(); setPlacementMode(false); }
  }

  async function onPlacementClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const x = e.clientX + window.scrollX;
    const y = e.clientY + window.scrollY;
    setPlacementMode(false);

    // Render a temp pin locally + open the composer. Neither the view nor the
    // pin is created server-side until the user clicks Send with non-empty
    // text. Dismissal (Esc, click-outside, Cancel) discards both.
    const tId = tempId();
    STATE.pins.push({ id: tId, x, y, note: '' });
    STATE.activePinId = tId;
    renderPins();
    renderPopover();
  }

  // ------- Panel toggle -------------------------------------------------

  function setInspectorExpanded(expanded) {
    STATE.inspectorExpanded = expanded;
    panel.classList.toggle('collapsed', !expanded);
    const btn = $('toggleBtn');
    if (btn) {
      btn.innerHTML = expanded ? ICON_CHEVRON_UP : ICON_CHEVRON_DOWN;
      btn.title = expanded ? 'Hide screens & pins' : 'Show screens & pins';
    }
    try { localStorage.setItem('__design_qa_inspector_expanded', expanded ? '1' : '0'); } catch {}
  }

  function readInspectorPref() {
    try {
      const v = localStorage.getItem('__design_qa_inspector_expanded');
      if (v === '1') return true;
      if (v === '0') return false;
    } catch {}
    return false;
  }

  // ------- Bootstrap / sync --------------------------------------------

  async function loadExistingPins() {
    try {
      const { view } = await window.__designQA_loadForUrl({ url: location.href });
      if (view) {
        STATE.viewId = view.id;
        STATE.pins = view.pins;
      } else {
        STATE.viewId = null;
        STATE.pins = [];
      }
      renderPins();
    } catch (err) {
      console.warn('design-qa: load failed', err);
    }
  }

  async function refreshSession() {
    try {
      STATE.session = await window.__designQA_listSession({});
      renderInspector();
    } catch (err) {
      console.warn('design-qa: list failed', err);
    }
  }

  function waitForBindings() {
    return new Promise((resolve) => {
      const check = () => {
        if (
          typeof window.__designQA_loadForUrl === 'function' &&
          typeof window.__designQA_ensureView === 'function' &&
          typeof window.__designQA_createPin === 'function' &&
          typeof window.__designQA_updatePin === 'function' &&
          typeof window.__designQA_deletePin === 'function' &&
          typeof window.__designQA_renameView === 'function' &&
          typeof window.__designQA_deleteView === 'function' &&
          typeof window.__designQA_startNewView === 'function' &&
          typeof window.__designQA_sealCurrentView === 'function' &&
          typeof window.__designQA_navigateTo === 'function' &&
          typeof window.__designQA_listSession === 'function'
        ) resolve();
        else setTimeout(check, 50);
      };
      check();
    });
  }

  function attachHost() {
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', attachHost, { once: true });
      return;
    }
    if (!document.body.contains(host)) document.body.appendChild(host);
  }

  // ------- Daemon-callable API -----------------------------------------

  window.__designQA = {
    setChromeVisible(visible) {
      // Hides both chrome AND pin-layer. Pins are overlaid in the artifact
      // from session.json coords; we don't want them baked into the PNG too.
      root.classList.toggle('capture-mode', !visible);
    },
  };

  // ------- Event wiring -------------------------------------------------

  panel.addEventListener('click', (e) => {
    const btn = e.target?.closest?.('button');
    if (!btn) return;
    const id = btn.id;
    if (id === 'addBtn') { setSaveConfirm(false); setPlacementMode(!STATE.placementMode); return; }
    if (id === 'toggleBtn') { setInspectorExpanded(!STATE.inspectorExpanded); return; }
    if (id === 'saveViewBtn') { requestSaveCurrentScreen(); return; }
    if (id === 'saveCancelBtn') { setSaveConfirm(false); return; }
    if (id === 'saveConfirmBtn') { performSaveCurrentScreen(); return; }
    if (id === 'newViewBtn') { setSaveConfirm(false); startNewScreenHere(); return; }
    if (id === 'recBtn') { onRecChipClick(); return; }
  });

  // The recording popover sits in `chrome` (sibling of panel), so panel's
  // delegation doesn't reach it. Wire its own listener.
  chrome.addEventListener('click', (e) => {
    if (recPopoverEl && recPopoverEl.contains(e.target)) onRecPopoverClick(e);
  });

  // ------- Boot ---------------------------------------------------------

  (async () => {
    attachHost();
    setInspectorExpanded(readInspectorPref());
    await waitForBindings();
    await loadExistingPins();
    await refreshSession();
    const obs = new MutationObserver(() => attachHost());
    obs.observe(document.documentElement, { childList: true, subtree: false });
  })();
})();
