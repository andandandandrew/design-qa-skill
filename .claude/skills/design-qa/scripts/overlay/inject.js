/**
 * design-qa overlay. Injected via Playwright addInitScript into every frame.
 * Only activates in the top frame.
 *
 * Phase-8 form-factor rebuild (DesignOS `src/browser-live.jsx`): the authoring
 * chrome is a single draggable bottom-center MINI-TOOLBAR pill —
 *   grip ┃ comment  ＋ ┃ ● record ▾ · Done
 * — plus a separate top-center RECORDING INDICATOR (pulse + "Recording" + N
 * steps) that expands into a steps timeline. The old top-right collapsible
 * inspector (screens + pins lists) is gone: review happens in the console now.
 * Pins themselves stay fully interactive on the page (click → edit / drag /
 * delete in place).
 *
 * Shadow DOM layout:
 *   .pin-layer    — pin markers in document coordinates. Hidden during
 *                   screenshots (pins are overlaid programmatically in the
 *                   artifact, not baked into the PNG).
 *   .chrome       — UI surface (toolbar, menus, indicator, composer, modals,
 *                   toasts). Hidden during screenshots via opacity:0; isolated
 *                   by a closed shadow root.
 *
 * Visual style = DesignOS v2 dark tokens, inlined (a closed shadow root can't
 * <link> the console stylesheet). Provenance in designos.lock.json.
 *
 * Daemon bindings on window (all preserved from Spike 8):
 *   __designQA_loadForUrl, __designQA_ensureView, __designQA_createPin,
 *   __designQA_updatePin (note OR x/y), __designQA_deletePin,
 *   __designQA_startNewView, __designQA_sealCurrentView,
 *   __designQA_markStart, __designQA_stopRecording (= finalize-keep),
 *   __designQA_discardRecording, __designQA_fetchRecorderSteps,
 *   __designQA_getUiState / __designQA_setUiState (toolbarPos +
 *   recIndicatorExpanded). The daemon also still exposes renameView/deleteView/
 *   navigateTo/listSession for the console; the overlay no longer calls them.
 *
 * Node → shadow push: window.__designQA_setRecorderState({active,count,…}).
 * Daemon-callable: window.__designQA.setChromeVisible(bool).
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
    // Spike 8: recorder state pushed from Node via __designQA_setRecorderState.
    // `active` flips at Mark-start; `count` is total post-Mark-start steps
    // across all views; `startedAtMs` is the Node wall clock at Mark-start;
    // `redactionCount` surfaces how many captured field values were redacted.
    recorder: { active: false, count: 0, startedAtMs: null, redactionCount: 0 },
    // Toolbar drag position (viewport coords) — null = default bottom-center.
    toolbarPos: null,
    dragging: false,
    // record ▾ menu open + top-indicator expanded (the latter persists Node-side
    // so it survives navigation; render reads it whenever recording is active).
    recMenuOpen: false,
    recIndicatorExpanded: false,
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
      /* DesignOS v2 tokens (dark · cool · default), inlined as static OKLCH.
         The closed shadow root can't <link>/@import the console stylesheet, so
         the browser fixture carries a self-contained copy of the token set it
         uses; the overlay is always dark. Provenance in designos.lock.json. */
      --surface-0: oklch(0.20 0.002 250); --surface-1: oklch(0.24 0.002 250);
      --surface-2: oklch(0.28 0.002 250); --surface-3: oklch(0.32 0.002 250);
      --surface-4: oklch(0.38 0.002 250); --surface-5: oklch(0.46 0.002 250);
      --surface-overlay: oklch(0.27 0.002 250 / 0.98);
      --ink-hi: oklch(0.97 0.001 250); --ink: oklch(0.86 0.002 250);
      --ink-mid: oklch(0.66 0.003 250); --ink-lo: oklch(0.52 0.004 250);
      --stroke-soft: oklch(1 0 0 / 0.06); --stroke: oklch(1 0 0 / 0.10); --stroke-hi: oklch(1 0 0 / 0.16);
      --recess: oklch(0.16 0.002 250);
      --accent-h: 240;
      --accent: oklch(0.66 0.18 240); --accent-hi: oklch(0.74 0.16 240);
      --accent-ink: oklch(0.99 0.01 240); --accent-tint: oklch(0.66 0.18 240 / 0.16); --accent-glow: oklch(0.66 0.18 240 / 0.35);
      --danger: oklch(0.65 0.20 25); --danger-hi: oklch(0.70 0.20 25); --danger-tint: oklch(0.65 0.20 25 / 0.16);
      --success: oklch(0.72 0.16 152);
      --shadow-1: 0 1px 2px oklch(0 0 0 / 0.40);
      --shadow-2: 0 2px 6px oklch(0 0 0 / 0.35), 0 1px 2px oklch(0 0 0 / 0.40);
      --shadow-3: 0 8px 24px oklch(0 0 0 / 0.45), 0 2px 6px oklch(0 0 0 / 0.40);
      --shadow-4: 0 20px 50px oklch(0 0 0 / 0.55), 0 6px 14px oklch(0 0 0 / 0.40);
      --r-1: 2px; --r-2: 4px; --r-control: 5px; --r-3: 6px; --r-4: 8px; --r-float: 10px; --r-5: 12px; --r-pill: 999px;
      --font-sans: "Inter", ui-sans-serif, system-ui, -apple-system, sans-serif;
      --font-mono: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace;
      font-family: var(--font-sans);
      font-size: 12px; line-height: 1.4; color: var(--ink);
    }

    /* Pin layer */
    .pin-layer { position: absolute; top: 0; left: 0; pointer-events: none; }
    .pin {
      position: absolute; width: 24px; height: 24px;
      background: var(--accent); color: var(--accent-ink);
      border-radius: 50% 50% 50% 2px;            /* tail at bottom-left */
      font-family: var(--font-sans);
      font-size: 10px; font-weight: 700;
      display: flex; align-items: center; justify-content: center;
      box-shadow: var(--shadow-2), 0 0 0 1.5px var(--accent-ink);
      pointer-events: auto; cursor: pointer; user-select: none;
      transition: transform 0.1s, box-shadow 0.1s;
      touch-action: none;                          /* enable pointer drag */
    }
    .pin > span { transform: translate(1px, -1px); }   /* nudge number into the bubble center */
    .pin:hover { background: var(--accent-hi); transform: translate(0, -1px); }
    .pin.active { background: var(--accent-hi); box-shadow: var(--shadow-2), 0 0 0 1.5px var(--accent-ink), 0 0 0 4px var(--accent-glow); }
    .pin.dragging { transition: none; cursor: grabbing; }

    /* Chrome — hidden during screenshots (opacity preserves focus) */
    .chrome { pointer-events: none; }
    .root.capture-mode .chrome,
    .root.capture-mode .pin-layer { opacity: 0; pointer-events: none !important; }
    .root.capture-mode .chrome *,
    .root.capture-mode .pin-layer * {
      transition: none !important; animation: none !important; pointer-events: none !important;
    }

    /* Placement / comment mode: a full-screen catch layer that doubles as the
       focus-dimming veil (DesignOS browser-live dims while in a mode). */
    .placement-cursor {
      position: fixed; inset: 0; pointer-events: auto; cursor: crosshair;
      background: oklch(0.15 0.01 250 / 0.18);
    }

    /* ── Mini-toolbar pill (top-center by default, draggable) ─────────── */
    .toolbar {
      position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
      display: inline-flex; align-items: center; height: 40px; padding: 6px; gap: 4px;
      background: var(--surface-1); color: var(--ink-hi);
      border-radius: var(--r-float);
      box-shadow: var(--shadow-3), inset 0 0 0 1px var(--stroke-soft);
      pointer-events: auto; user-select: none; white-space: nowrap;
      width: max-content; z-index: 50; font-family: var(--font-sans);
    }
    .tb-grip {
      width: 16px; height: 28px; flex-shrink: 0;
      display: inline-flex; align-items: center; justify-content: center;
      color: var(--ink-lo); cursor: grab; touch-action: none;
    }
    .toolbar.dragging, .toolbar.dragging .tb-grip { cursor: grabbing; }
    .tb-grip svg { width: 14px; height: 18px; display: block; }
    .tb-divider { width: 1px; height: 18px; background: var(--stroke-soft); margin: 0 4px; flex-shrink: 0; }
    .tb-cluster { display: inline-flex; align-items: center; gap: 2px; }
    .tb-rec-wrap { position: relative; display: inline-flex; align-items: center; }

    .tb-ibtn {
      width: 28px; height: 28px;
      display: inline-flex; align-items: center; justify-content: center;
      color: var(--ink-mid); border-radius: var(--r-control); cursor: pointer;
      transition: background 0.09s, color 0.09s;
    }
    .tb-ibtn:hover { background: var(--surface-3); color: var(--ink-hi); }
    .tb-ibtn.active { background: var(--accent); color: var(--accent-ink); }
    .tb-ibtn svg { width: 16px; height: 16px; display: block; }

    /* Record button — NEW visual states (idle = hollow ring, recording =
       filled dot with a pulsing halo), not DesignOS's plain dot↔square. */
    .tb-rec {
      width: 30px; height: 28px;
      display: inline-flex; align-items: center; justify-content: center;
      background: var(--danger-tint); color: var(--danger);
      border-radius: var(--r-control); cursor: pointer; transition: background 0.09s;
    }
    .tb-rec:hover { background: oklch(0.65 0.20 25 / 0.26); }
    .rec-glyph { display: block; box-sizing: border-box; }
    .rec-glyph.idle { width: 11px; height: 11px; border-radius: 50%; border: 2px solid var(--danger); }
    .rec-glyph.live {
      width: 10px; height: 10px; border-radius: 50%; background: var(--danger);
      animation: rec-halo 1.4s ease-in-out infinite;
    }
    @keyframes rec-halo {
      0%, 100% { box-shadow: 0 0 0 0 oklch(0.65 0.20 25 / 0.5); }
      50% { box-shadow: 0 0 0 5px oklch(0.65 0.20 25 / 0); }
    }
    .tb-rec-chev {
      width: 14px; height: 28px; margin-left: 1px;
      display: inline-flex; align-items: center; justify-content: center;
      color: var(--ink-mid); border-radius: var(--r-2); cursor: pointer;
      transition: background 0.09s, color 0.09s;
    }
    .tb-rec-chev:hover, .tb-rec-chev.active { background: var(--surface-3); color: var(--ink-hi); }
    .tb-rec-chev svg { width: 10px; height: 10px; display: block; }

    .tb-done {
      all: unset; cursor: pointer; height: 28px; padding: 0 12px;
      display: inline-flex; align-items: center;
      background: var(--accent); color: var(--accent-ink);
      font-size: 12px; font-weight: 600; border-radius: var(--r-control);
    }
    .tb-done:hover { background: var(--accent-hi); }

    /* ── DesignOS floating Menu (record ▾) ────────────────────────────── */
    .menu {
      position: absolute; bottom: calc(100% + 8px); right: 0;
      min-width: 206px; padding: 4px;
      background: var(--surface-overlay); color: var(--ink-hi);
      border-radius: var(--r-4);
      box-shadow: var(--shadow-3), inset 0 0 0 1px var(--stroke-soft);
      backdrop-filter: blur(8px);
      display: flex; flex-direction: column; gap: 1px; z-index: 60;
    }
    .menu-header {
      font-size: 10px; color: var(--ink-lo); text-transform: uppercase;
      letter-spacing: 0.06em; padding: 6px 8px 2px;
    }
    .menu-item {
      display: flex; align-items: center; gap: 8px; height: 28px; padding: 0 8px;
      border-radius: var(--r-control); cursor: pointer; color: var(--ink-hi); font-size: 12px;
    }
    .menu-item:hover { background: var(--surface-3); }
    .menu-item.danger { color: var(--danger); }
    .menu-item.danger:hover { background: var(--danger-tint); }
    .menu-item .mi-ic { width: 16px; display: inline-flex; justify-content: center; color: var(--ink-mid); }
    .menu-item.danger .mi-ic { color: var(--danger); }
    .menu-item .mi-label { flex: 1; }
    .menu-item svg { width: 14px; height: 14px; display: block; }
    .menu-sep { height: 1px; background: var(--stroke-soft); margin: 3px 4px; }

    /* ── Top recording indicator (collapsed pill + expandable step list) ─ */
    /* Sits below the default top-center toolbar (top:16px + 40px tall) so the
       two don't collide when the toolbar is left in its default spot. */
    .rec-indicator {
      position: fixed; top: 64px; left: 50%; transform: translateX(-50%);
      pointer-events: auto; z-index: 55;
      display: flex; flex-direction: column; align-items: center;
      font-family: var(--font-sans);
    }
    .rec-ind-pill {
      display: inline-flex; align-items: center; gap: 9px; height: 32px; padding: 0 10px 0 12px;
      background: var(--surface-1); color: var(--ink-hi);
      border-radius: var(--r-pill);
      box-shadow: var(--shadow-3), inset 0 0 0 1px var(--stroke-soft);
      cursor: pointer;
    }
    .rec-ind-dot {
      width: 8px; height: 8px; border-radius: 50%; background: var(--danger);
      box-shadow: 0 0 0 4px oklch(0.65 0.20 25 / 0.20);
      animation: rec-pulse 1.4s ease-in-out infinite; flex-shrink: 0;
    }
    @keyframes rec-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
    .rec-ind-label { font-size: 12px; font-weight: 600; color: var(--ink-hi); }
    .rec-ind-count { font-size: 11px; color: var(--ink-mid); }
    .rec-ind-chev { display: inline-flex; align-items: center; color: var(--ink-mid); }
    .rec-ind-chev svg { width: 12px; height: 12px; display: block; transition: transform 0.14s; }
    .rec-indicator.expanded .rec-ind-chev svg { transform: rotate(180deg); }

    .rec-ind-panel {
      margin-top: 6px; width: 324px; max-height: 52vh;
      display: flex; flex-direction: column;
      background: var(--surface-1); color: var(--ink);
      border-radius: var(--r-4);
      box-shadow: var(--shadow-3), inset 0 0 0 1px var(--stroke-soft);
      overflow: hidden;
    }
    .rec-ind-panel-head {
      display: flex; align-items: center; gap: 8px; padding: 10px 12px;
      border-bottom: 1px solid var(--stroke-soft);
    }
    .rec-ind-panel-title { font-size: 12px; font-weight: 600; color: var(--ink-hi); }
    .rec-redact-chip {
      margin-left: auto; padding: 1px 7px; border-radius: var(--r-pill);
      font-size: 10px; background: var(--accent-tint); color: var(--accent-hi); font-weight: 600;
    }
    .rec-ind-list { overflow-y: auto; padding: 2px 12px 12px; }
    .rec-ind-empty { padding: 30px 12px; text-align: center; color: var(--ink-lo); font-size: 12px; }

    /* Steps timeline — DesignOS "Sidebar Steps" composite (steps-panel.jsx). */
    .step-tile { display: flex; gap: 10px; padding: 0 4px; position: relative; }
    .step-rail { flex-shrink: 0; width: 10px; display: flex; flex-direction: column; align-items: center; position: relative; }
    .step-dot {
      width: 8px; height: 8px; border-radius: 50%; background: var(--surface-4);
      box-shadow: inset 0 0 0 1px var(--stroke); margin-top: 10px; z-index: 1; position: relative;
    }
    .step-line { position: absolute; top: 18px; bottom: -2px; left: 50%; width: 1px; transform: translateX(-50%); background: var(--stroke-soft); }
    .step-body { flex: 1; min-width: 0; padding: 8px 0 6px; display: flex; flex-direction: column; gap: 3px; }
    .step-stamp { display: flex; align-items: baseline; gap: 6px; font-size: 11px; color: var(--ink-lo); line-height: 1.2; }
    .step-stamp-num { color: var(--ink-mid); font-weight: 500; font-variant-numeric: tabular-nums; }
    .step-stamp-div { color: var(--ink-lo); opacity: 0.6; }
    .step-stamp-action { color: var(--ink-mid); }
    .step-target { font-size: 13px; color: var(--ink-hi); font-weight: 600; line-height: 1.35; word-break: break-word; }
    .step-target strong { font-weight: 700; }
    .step-target code { font-family: var(--font-mono); font-size: 11px; background: var(--surface-2); padding: 0 4px; border-radius: var(--r-1); }

    /* ── Popover / composer (pin comment editing — unchanged behavior) ──── */
    .popover-layer { position: absolute; top: 0; left: 0; pointer-events: none; }
    .popover {
      position: absolute; width: 340px;
      background: var(--surface-2); border: 1px solid var(--stroke); border-radius: var(--r-5);
      pointer-events: auto; overflow: hidden;
      box-shadow: var(--shadow-4);
      transform: translate(-50%, 24px);
    }
    .popover textarea {
      all: unset; box-sizing: border-box;
      display: block; width: 100%; min-height: 44px; max-height: 200px;
      font-family: inherit; font-size: 13px; line-height: 1.5; color: var(--ink);
      background: transparent; padding: 12px 16px; resize: none;
    }
    .popover textarea::placeholder { color: var(--ink-lo); }
    .popover .actions {
      display: flex; justify-content: space-between; align-items: center;
      padding: 6px 8px;
      border-top: 1px solid var(--stroke);
    }
    .popover .actions-left { display: flex; gap: 2px; }
    .popover button.text-btn {
      all: unset; cursor: pointer; font-size: 12px;
      color: var(--ink-mid); padding: 6px 10px; border-radius: var(--r-2);
    }
    .popover button.text-btn:hover { color: var(--ink); background: var(--surface-3); }
    .popover button.text-btn.danger { color: var(--ink-mid); }
    .popover button.text-btn.danger:hover { color: var(--danger); background: var(--danger-tint); }
    button.send-btn {
      all: unset; cursor: pointer;
      width: 28px; height: 28px; border-radius: var(--r-pill);
      display: inline-flex; align-items: center; justify-content: center;
      background: var(--surface-3); color: var(--ink-lo);
      transition: background 0.1s, color 0.1s;
    }
    button.send-btn:hover:not([aria-disabled="true"]) { background: var(--accent-hi); }
    button.send-btn.active { background: var(--accent); color: var(--accent-ink); }
    button.send-btn.active:hover { background: var(--accent-hi); }
    button.send-btn[aria-disabled="true"] { cursor: not-allowed; }
    button.send-btn svg { width: 14px; height: 14px; display: block; }

    .composer-pill {
      position: absolute; width: 320px;
      display: flex; align-items: center; gap: 6px;
      background: var(--surface-3); border: 1px solid var(--stroke); border-radius: var(--r-pill);
      padding: 4px 4px 4px 16px;
      pointer-events: auto;
      box-shadow: var(--shadow-3);
      transform: translate(16px, -50%);
    }
    .composer-pill .pill-input {
      all: unset; box-sizing: border-box; flex: 1; min-width: 0;
      font-family: inherit; font-size: 13px; line-height: 1.4; color: var(--ink);
      background: transparent; padding: 6px 0;
    }
    .composer-pill .pill-input::placeholder { color: var(--ink-lo); }

    /* Modal (Done / Discard confirms — native confirm() is auto-dismissed by
       Playwright, so we use a shadow-DOM modal). */
    .modal-layer { position: fixed; inset: 0; pointer-events: none; }
    .modal-backdrop {
      position: fixed; inset: 0; background: oklch(0 0 0 / 0.5);
      pointer-events: auto; display: flex; align-items: center; justify-content: center;
      padding: 24px;
    }
    .modal {
      background: var(--surface-2); border: 1px solid var(--stroke); border-radius: var(--r-4);
      box-shadow: var(--shadow-4);
      min-width: 320px; max-width: 440px; padding: 20px;
    }
    .modal-title { font-size: 14px; font-weight: 600; color: var(--ink); margin-bottom: 6px; }
    .modal-body { font-size: 12px; color: var(--ink-mid); line-height: 1.5; margin-bottom: 18px; }
    .modal-actions { display: flex; justify-content: flex-end; gap: 6px; }
    .modal button {
      all: unset; cursor: pointer; padding: 6px 14px;
      border-radius: var(--r-2); font-size: 12px; font-weight: 500;
    }
    .modal button.ghost { color: var(--ink-mid); }
    .modal button.ghost:hover { color: var(--ink); background: var(--surface-3); }
    .modal button.danger { background: var(--danger); color: var(--accent-ink); font-weight: 600; }
    .modal button.danger:hover { background: var(--danger-hi); }
    .modal button.primary { background: var(--accent); color: var(--accent-ink); font-weight: 600; }
    .modal button.primary:hover { background: var(--accent-hi); }

    /* Toast (bottom-center, above the toolbar) */
    .toast-layer {
      position: fixed; bottom: 76px; left: 50%; transform: translateX(-50%);
      display: flex; flex-direction: column; gap: 6px;
      pointer-events: none; align-items: center;
    }
    .toast {
      background: var(--surface-1); border: 1px solid var(--stroke); border-radius: var(--r-3);
      padding: 6px 14px; font-size: 11px; color: var(--ink);
      box-shadow: var(--shadow-3);
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

  // ------- Icons (lucide path data, matching console/ui/icons.mjs) -------

  const ic = (inner, sw = 1.8) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

  const ICON_COMMENT = ic('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>');
  const ICON_PLUS = ic('<path d="M5 12h14"/><path d="M12 5v14"/>', 2.2);
  const ICON_X = ic('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>', 2.2);
  const ICON_CHEV_DOWN = ic('<path d="m6 9 6 6 6-6"/>', 2.2);
  const ICON_ARROW_UP = ic('<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>', 2.2);
  // Filled-dot grip (lucide grip-vertical, filled for a crisper drag handle).
  const ICON_GRIP =
    '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><circle cx="9" cy="5" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="9" cy="19" r="1.4"/><circle cx="15" cy="5" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="15" cy="19" r="1.4"/></svg>';
  // Menu glyphs
  const ICON_RECORD = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><circle cx="12" cy="12" r="5"/></svg>';
  const ICON_SQUARE = ic('<rect width="13" height="13" x="5.5" y="5.5" rx="2"/>', 2);
  const ICON_ROTATE = ic('<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>');
  const ICON_TRASH = ic('<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>');

  // ------- Toolbar ------------------------------------------------------

  const toolbar = document.createElement('div');
  toolbar.className = 'toolbar';
  toolbar.innerHTML = `
    <span class="tb-grip" id="gripBtn" title="Drag to move">${ICON_GRIP}</span>
    <span class="tb-divider"></span>
    <span class="tb-cluster">
      <span class="tb-ibtn" id="commentBtn" title="Comment — click, then click on the page">${ICON_COMMENT}</span>
      <span class="tb-ibtn" id="newScreenBtn" title="Save this screen and start a fresh one on this URL">${ICON_PLUS}</span>
    </span>
    <span class="tb-divider"></span>
    <span class="tb-cluster">
      <span class="tb-rec-wrap" id="recWrap">
        <span class="tb-rec" id="recBtn" title="Start recording the path the engineer will replay"><span class="rec-glyph idle"></span></span>
        <span class="tb-rec-chev" id="recChevBtn" title="Recording options">${ICON_CHEV_DOWN}</span>
      </span>
      <button class="tb-done" id="doneBtn" title="Finish the review — seal this screen, lock the recorded path; continue in the console">Done</button>
    </span>
  `;
  chrome.appendChild(toolbar);

  // Top recording indicator (created lazily; only present while recording).
  let recIndicatorEl = null;

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
      // is (x, y - 24); the bubble has its tail at bottom-left.
      el.style.left = pin.x + 'px';
      el.style.top = (pin.y - 24) + 'px';
      el.dataset.id = pin.id;
      el.innerHTML = `<span>${i + 1}</span>`;
      attachPinHandlers(el, pin);
      pinLayer.appendChild(el);
    });
    logPins('renderPins');
  }

  function attachPinHandlers(el, pin) {
    let dragState = null;

    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
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
        if (STATE.activePinId === pin.id) popoverLayer.innerHTML = '';
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
      pop.className = 'composer-pill';
      pop.innerHTML = `
        <input type="text" class="pill-input" placeholder="Add a comment" />
        <button class="send-btn" data-act="send" aria-disabled="true" title="Send">${ICON_ARROW_UP}</button>
      `;
    } else {
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
    };

    const commit = async () => {
      const text = ta.value.trim();
      if (!text) return;
      if (isTemp) {
        const tempIdVal = pin.id;
        // Lazy-create the view so dismissed temp pins don't leave empty screens.
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
          // Promote the captured temp pin object in place (robust to STATE.pins
          // being mutated during the await).
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
      // Reconcile canvas against the daemon's authoritative pin set.
      await reloadActiveViewPins();
    };

    const discardOrClose = () => {
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      if (isTemp) {
        STATE.pins = STATE.pins.filter((p) => p.id !== pin.id);
      } else if (ta.value !== (pin.note || '')) {
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
    });
  }

  function closePopoverIfOpen() {
    if (!STATE.activePinId) return;
    const activeId = STATE.activePinId;
    const isTemp = String(activeId).startsWith(TEMP_PREFIX);
    if (isTemp) {
      STATE.pins = STATE.pins.filter((p) => p.id !== activeId);
      logPins('closePopover-discard-temp');
    }
    STATE.activePinId = null;
    renderPins();
    renderPopover();
  }

  // Click outside the popover (and outside any pin) closes it. composedPath so
  // we can see into our shadow DOM.
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

  // ------- New screen (＋) ----------------------------------------------

  async function startNewScreenHere() {
    let result;
    try { result = await window.__designQA_startNewView({ url: location.href }); }
    catch (e) { console.warn('design-qa: startNewView failed', e); return; }
    STATE.viewId = result.newViewId;
    STATE.pins = [];
    STATE.activePinId = null;
    renderPins();
    renderPopover();
    toast('New screen — name it in the console');
  }

  // ------- Done (session-level finalize-keep, 9f) -----------------------
  // Seals the current screen AND finalize-keeps the recording (locks view.steps,
  // stops the recorder appending). Available whenever there's something to
  // finish — pins on THIS screen OR an active recording. Does NOT close the
  // browser; the session stays live so the user can keep editing in the console.

  async function requestDone() {
    const realPins = STATE.pins.filter((p) => !String(p.id).startsWith(TEMP_PREFIX));
    const hasCurrentPins = STATE.viewId && realPins.length > 0;
    if (!hasCurrentPins && !STATE.recorder.active) {
      toast('Add a comment or start recording before finishing');
      return;
    }
    const ok = await confirmModal({
      title: 'Finish this review?',
      body: 'This seals the current screen and locks the recorded path the engineer replays. You can keep editing in the console.',
      confirmLabel: 'Done',
    });
    if (!ok) return;
    await performDone();
  }

  async function performDone() {
    // 1. Seal the current screen (preserves a steps-only segment for a
    //    pass-through screen — the recording is still active here).
    try { await window.__designQA_sealCurrentView({ url: location.href }); }
    catch (e) { console.warn('design-qa: sealCurrentView failed', e); }
    // 2. Finalize-keep the recording: locks view.steps, stops appending, rests
    //    the record button. (__designQA_stopRecording's 9f meaning — NOT discard.)
    try { await window.__designQA_stopRecording(); }
    catch (e) { console.warn('design-qa: finalize recording failed', e); }
    STATE.viewId = null;
    STATE.pins = [];
    STATE.activePinId = null;
    renderPins();
    renderPopover();
    toast('Done — recording locked; continue any edits in the console');
  }

  // ------- Record button + ▾ menu ---------------------------------------

  function renderRecButton() {
    const btn = $('recBtn');
    if (!btn) return;
    const live = STATE.recorder.active;
    btn.innerHTML = `<span class="rec-glyph ${live ? 'live' : 'idle'}"></span>`;
    btn.title = live ? 'Stop recording — keep the recorded path' : 'Start recording the path the engineer will replay';
  }

  async function onRecToggle() {
    closeRecMenu();
    if (STATE.recorder.active) {
      try { await window.__designQA_stopRecording(); }
      catch (err) { console.warn('design-qa: finalize recording failed', err); }
    } else {
      try { await window.__designQA_markStart(); }
      catch (err) { console.warn('design-qa: markStart failed', err); }
    }
    // The state push from Node flips the visuals; no manual update needed.
  }

  function closeRecMenu() {
    if (!STATE.recMenuOpen) return;
    STATE.recMenuOpen = false;
    const existing = $('recMenu');
    if (existing) existing.remove();
    $('recChevBtn')?.classList.remove('active');
  }

  function toggleRecMenu() {
    if (STATE.recMenuOpen) { closeRecMenu(); return; }
    STATE.recMenuOpen = true;
    $('recChevBtn')?.classList.add('active');
    const wrap = $('recWrap');
    if (!wrap) return;
    const menu = document.createElement('div');
    menu.className = 'menu';
    menu.id = 'recMenu';
    if (STATE.recorder.active) {
      menu.innerHTML = `
        <div class="menu-header">Recording</div>
        <div class="menu-item" data-act="reset"><span class="mi-ic">${ICON_ROTATE}</span><span class="mi-label">Reset start here</span></div>
        <div class="menu-item" data-act="stop"><span class="mi-ic">${ICON_SQUARE}</span><span class="mi-label">Stop recording</span></div>
        <div class="menu-sep"></div>
        <div class="menu-item danger" data-act="discard"><span class="mi-ic">${ICON_TRASH}</span><span class="mi-label">Discard recording</span></div>
      `;
    } else {
      menu.innerHTML = `
        <div class="menu-header">Record</div>
        <div class="menu-item" data-act="start"><span class="mi-ic">${ICON_RECORD}</span><span class="mi-label">Start recording</span></div>
      `;
    }
    wrap.appendChild(menu);
  }

  async function onRecMenuItem(act) {
    closeRecMenu();
    if (act === 'start') {
      try { await window.__designQA_markStart(); }
      catch (err) { console.warn('design-qa: markStart failed', err); }
      return;
    }
    if (act === 'reset') {
      try { await window.__designQA_markStart(); }
      catch (err) { console.warn('design-qa: markStart (reset) failed', err); }
      toast('Recording start moved to here');
      return;
    }
    if (act === 'stop') {
      try { await window.__designQA_stopRecording(); }
      catch (err) { console.warn('design-qa: finalize recording failed', err); }
      return;
    }
    if (act === 'discard') {
      const ok = await confirmModal({
        title: 'Discard recording?',
        body: 'The recorded path will be cleared. Captured steps move to preconditions as hints. This can’t be undone here.',
        confirmLabel: 'Discard',
        danger: true,
      });
      if (!ok) return;
      try { await window.__designQA_discardRecording(); }
      catch (err) { console.warn('design-qa: discardRecording failed', err); }
    }
  }

  // ------- Top recording indicator --------------------------------------

  /** Strip the markdown bold + backtick from describeAction output so the inline
   *  timeline renders without a markdown parser. */
  function renderInlineMd(text) {
    return escapeHtml(text)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  }

  // kind → timeline stamp verb + a regex that strips the leading verb phrase
  // from describeAction's humanText so the target line doesn't repeat it.
  const ACTION_LABEL = {
    click: 'Click', dblclick: 'Double-click', fill: 'Type', press: 'Press',
    navigate: 'Go to', select: 'Select', check: 'Check', uncheck: 'Uncheck',
    setInputFiles: 'Upload', closePage: 'Close',
  };
  const STRIP_PREFIX = {
    click: /^Click\s+/, dblclick: /^Double-click\s+/, fill: /^Type\s+/,
    press: /^Press\s+/, navigate: /^Go to\s+/, select: /^Pick\s+/,
    check: /^Check\s+/, uncheck: /^Uncheck\s+/, setInputFiles: /^Upload file\(s\) into\s+/,
  };

  function stepTilesHTML(steps) {
    const startNum = Math.max(1, steps.length - 99);
    return steps.map((s, i) => {
      const action = ACTION_LABEL[s.kind] || 'Step';
      const human = s.humanText || '';
      const strip = STRIP_PREFIX[s.kind];
      const targetRaw = strip ? human.replace(strip, '') : human;
      const target = renderInlineMd(targetRaw || human);
      const isLast = i === steps.length - 1;
      return `<div class="step-tile">
        <div class="step-rail"><span class="step-dot"></span>${isLast ? '' : '<span class="step-line"></span>'}</div>
        <div class="step-body">
          <div class="step-stamp"><span class="step-stamp-num">${String(startNum + i).padStart(2, '0')}</span><span class="step-stamp-div">·</span><span class="step-stamp-action">${escapeHtml(action)}</span></div>
          <div class="step-target">${target}</div>
        </div>
      </div>`;
    }).join('');
  }

  function renderRecIndicator() {
    const live = STATE.recorder.active;
    if (!live) {
      if (recIndicatorEl) { recIndicatorEl.remove(); recIndicatorEl = null; }
      return;
    }
    const expanded = STATE.recIndicatorExpanded;
    if (!recIndicatorEl) {
      recIndicatorEl = document.createElement('div');
      recIndicatorEl.className = 'rec-indicator';
      chrome.appendChild(recIndicatorEl);
    }
    recIndicatorEl.classList.toggle('expanded', expanded);
    const count = STATE.recorder.count;
    const countLabel = `${count} step${count === 1 ? '' : 's'}`;
    const redactChip = STATE.recorder.redactionCount > 0
      ? `<span class="rec-redact-chip" title="${STATE.recorder.redactionCount} value(s) redacted from captured fields">${STATE.recorder.redactionCount} redacted</span>`
      : '';
    recIndicatorEl.innerHTML = `
      <div class="rec-ind-pill" id="recIndPill">
        <span class="rec-ind-dot"></span>
        <span class="rec-ind-label">Recording</span>
        <span class="rec-ind-count">${countLabel}</span>
        <span class="rec-ind-chev">${ICON_CHEV_DOWN}</span>
      </div>
      ${expanded ? `
      <div class="rec-ind-panel">
        <div class="rec-ind-panel-head">
          <span class="rec-ind-panel-title">Recorded path</span>
          ${redactChip}
        </div>
        <div class="rec-ind-list" id="recIndList"><div class="rec-ind-empty">Loading…</div></div>
      </div>` : ''}
    `;
    if (expanded) refreshIndicatorSteps();
  }

  async function refreshIndicatorSteps() {
    const list = recIndicatorEl && recIndicatorEl.querySelector('#recIndList');
    if (!list) return;
    try {
      const payload = await window.__designQA_fetchRecorderSteps();
      const steps = payload && Array.isArray(payload.steps) ? payload.steps : [];
      if (steps.length === 0) {
        list.innerHTML = '<div class="rec-ind-empty">No steps yet on the recorded path.</div>';
      } else {
        list.innerHTML = stepTilesHTML(steps);
        list.scrollTop = list.scrollHeight;
      }
    } catch (err) {
      console.warn('design-qa: fetchRecorderSteps failed', err);
    }
  }

  function toggleRecIndicator() {
    STATE.recIndicatorExpanded = !STATE.recIndicatorExpanded;
    if (typeof window.__designQA_setUiState === 'function') {
      window.__designQA_setUiState({ recIndicatorExpanded: STATE.recIndicatorExpanded }).catch(() => {});
    }
    renderRecIndicator();
  }

  // Node → shadow push setter, called via page.evaluate from capture.mjs.
  window.__designQA_setRecorderState = (state) => {
    if (!state || typeof state !== 'object') return;
    const wasActive = STATE.recorder.active;
    STATE.recorder = {
      active: !!state.active,
      count: Number.isFinite(state.count) ? state.count : 0,
      startedAtMs: typeof state.startedAtMs === 'number' ? state.startedAtMs : null,
      redactionCount: Number.isFinite(state.redactionCount) ? state.redactionCount : 0,
    };
    renderRecButton();
    // Recording stopped → tidy up the record menu so it doesn't show stale items.
    if (wasActive && !STATE.recorder.active && STATE.recMenuOpen) closeRecMenu();
    renderRecIndicator();
  };

  // ------- Placement mode -----------------------------------------------

  function setPlacementMode(on) {
    STATE.placementMode = on;
    const btn = $('commentBtn');
    if (btn) {
      btn.classList.toggle('active', on);
      btn.title = on ? 'Cancel comment placement' : 'Comment — click, then click on the page';
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
    // pin is created server-side until the user sends non-empty text.
    const tId = tempId();
    STATE.pins.push({ id: tId, x, y, note: '' });
    STATE.activePinId = tId;
    renderPins();
    renderPopover();
  }

  // ------- Toolbar drag -------------------------------------------------

  let dragRef = null;

  function clampToViewport(x, y, w, h) {
    return {
      x: Math.max(8, Math.min(x, window.innerWidth - w - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - h - 8)),
    };
  }

  function applyToolbarPos(pos) {
    if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
      const r = toolbar.getBoundingClientRect();
      const c = clampToViewport(pos.x, pos.y, r.width || 320, r.height || 40);
      STATE.toolbarPos = c;
      toolbar.style.left = c.x + 'px';
      toolbar.style.top = c.y + 'px';
      toolbar.style.bottom = 'auto';
      toolbar.style.transform = 'none';
    } else {
      STATE.toolbarPos = null;
      toolbar.style.left = '50%';
      toolbar.style.top = '16px';
      toolbar.style.bottom = 'auto';
      toolbar.style.transform = 'translateX(-50%)';
    }
  }

  function onGripDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    closeRecMenu();
    const grip = e.currentTarget;
    const r = toolbar.getBoundingClientRect();
    dragRef = { dx: e.clientX - r.left, dy: e.clientY - r.top, w: r.width, h: r.height, grip, pointerId: e.pointerId };
    STATE.dragging = true;
    toolbar.classList.add('dragging');
    // Switch to explicit positioning at the current spot.
    applyToolbarPos({ x: r.left, y: r.top });
    // Capture the pointer so move/up route back to the grip even when the
    // toolbar slides out from under the cursor or the page would swallow them.
    grip.setPointerCapture?.(e.pointerId);
    grip.addEventListener('pointermove', onGripMove);
    grip.addEventListener('pointerup', onGripUp);
    grip.addEventListener('pointercancel', onGripUp);
  }

  function onGripMove(e) {
    if (!dragRef) return;
    const c = clampToViewport(e.clientX - dragRef.dx, e.clientY - dragRef.dy, dragRef.w, dragRef.h);
    STATE.toolbarPos = c;
    toolbar.style.left = c.x + 'px';
    toolbar.style.top = c.y + 'px';
    toolbar.style.bottom = 'auto';
    toolbar.style.transform = 'none';
  }

  function onGripUp() {
    if (!dragRef) return;
    const { grip, pointerId } = dragRef;
    STATE.dragging = false;
    dragRef = null;
    toolbar.classList.remove('dragging');
    grip.releasePointerCapture?.(pointerId);
    grip.removeEventListener('pointermove', onGripMove);
    grip.removeEventListener('pointerup', onGripUp);
    grip.removeEventListener('pointercancel', onGripUp);
    if (typeof window.__designQA_setUiState === 'function' && STATE.toolbarPos) {
      window.__designQA_setUiState({ toolbarPos: STATE.toolbarPos }).catch(() => {});
    }
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

  function waitForBindings() {
    return new Promise((resolve) => {
      const need = [
        '__designQA_loadForUrl', '__designQA_ensureView', '__designQA_createPin',
        '__designQA_updatePin', '__designQA_deletePin', '__designQA_startNewView',
        '__designQA_sealCurrentView', '__designQA_markStart', '__designQA_stopRecording',
        '__designQA_discardRecording', '__designQA_fetchRecorderSteps',
        '__designQA_getUiState', '__designQA_setUiState',
      ];
      const check = () => {
        if (need.every((n) => typeof window[n] === 'function')) resolve();
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
      // from session.json coords; we don't bake them into the PNG too.
      root.classList.toggle('capture-mode', !visible);
    },
  };

  // ------- Event wiring -------------------------------------------------

  $('gripBtn').addEventListener('pointerdown', onGripDown);

  toolbar.addEventListener('click', (e) => {
    const id = e.target?.closest?.('[id]')?.id;
    if (id === 'commentBtn') { closeRecMenu(); setPlacementMode(!STATE.placementMode); return; }
    if (id === 'newScreenBtn') { closeRecMenu(); startNewScreenHere(); return; }
    if (id === 'recBtn') { onRecToggle(); return; }
    if (id === 'recChevBtn') { toggleRecMenu(); return; }
    if (id === 'doneBtn') { closeRecMenu(); requestDone(); return; }
  });

  // Record-menu item clicks (the menu lives inside the toolbar, so delegate here).
  toolbar.addEventListener('click', (e) => {
    const item = e.target?.closest?.('.menu-item');
    if (item && item.dataset.act) onRecMenuItem(item.dataset.act);
  });

  // Indicator clicks live in `chrome` (sibling of toolbar) — wire separately.
  chrome.addEventListener('click', (e) => {
    if (recIndicatorEl && e.target?.closest?.('#recIndPill')) toggleRecIndicator();
  });

  // Click outside the record menu closes it (composedPath sees into shadow DOM).
  document.addEventListener('click', (e) => {
    if (!STATE.recMenuOpen) return;
    const path = e.composedPath?.() || [];
    for (const node of path) {
      if (!node || !node.classList) continue;
      if (node.classList.contains('menu') || node.id === 'recChevBtn') return;
    }
    closeRecMenu();
  }, true);

  // Esc closes the record menu / collapses the indicator (when not in a deeper mode).
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (STATE.recMenuOpen) { closeRecMenu(); return; }
  }, false);

  // Keep an explicitly-positioned toolbar on-screen across viewport resizes.
  window.addEventListener('resize', () => {
    if (STATE.toolbarPos && !STATE.dragging) applyToolbarPos(STATE.toolbarPos);
  });

  // ------- Boot ---------------------------------------------------------

  (async () => {
    attachHost();
    await waitForBindings();
    // Pull the UI state Node has held across navigation: toolbar position +
    // recording-indicator expanded flag. Defaults on the first page of a
    // session; survives cross-origin nav (where localStorage wouldn't).
    let ui = { toolbarPos: null, recIndicatorExpanded: false };
    try { ui = await window.__designQA_getUiState(); } catch {}
    STATE.recIndicatorExpanded = !!ui.recIndicatorExpanded;
    // Defer position restore one frame so the toolbar has laid out (clamp reads
    // its measured width/height).
    requestAnimationFrame(() => applyToolbarPos(ui.toolbarPos));
    renderRecButton();
    renderRecIndicator();
    await loadExistingPins();

    // Re-attach the host if the page rips out / replaces the body subtree.
    // Guarded: a transient null root would otherwise throw at observe().
    try {
      const target = document.documentElement || document.body;
      if (target) {
        const obs = new MutationObserver(() => attachHost());
        obs.observe(target, { childList: true, subtree: false });
      }
    } catch (e) {
      console.warn('design-qa: host observer setup failed', e);
    }
  })();
})();
