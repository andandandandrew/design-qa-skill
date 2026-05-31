# Design QA — Interface + Workflow Inventory

**Status:** CURATED REFERENCE (2026-05-31). Authored to turn the upcoming
design↔implementation sync from a *discovery* exercise into a *diff*. It catalogues every UI
surface, affordance, gesture, the workflow each drives, the seam/file it lives in, the feedback
`type`s it handles, and — where relevant — the **§6 implication** (what the design pass is
expected to change). Verified against live code on 2026-05-31; treat it as a map, re-check the
symbol before you cut.

All code lives under `.claude/skills/design-qa/scripts/` (paths below are relative to that root).

> **How to read this.** §1 orients you on the architecture. §2–§4 are the three surfaces
> (overlay / console / artifact), each an affordance table: *element · gesture · symbol/file ·
> `type`(s) · §6 note*. §5 is the feedback-`type` render matrix. §6 is the precise §6 starting
> point. §7 is the cross-surface duplication the standalone-app cutover will care about.

---

## 1. Orientation — the three surfaces + the shared engine

The reframe (`design-qa-console-architecture.md`): the **console** is the primary authoring +
review surface; the **overlay** is an optional capture accelerator for browsable web apps; the
**artifact** is a frozen, portable export. The newer reframe
(`design-qa-feedback-platform.md`): it's a **feedback platform** — a pinned text note is just
*one* `type` of feedback alongside `drawing` and `element`, all unified by a `type` discriminator
on the feedback record (the thing the code still calls a "pin").

**The shared render engine.** The console and the artifact run the **same** modules:
`console/core.mjs` `createApp({ store, mounts, options })` owns state + render + filter-sort +
selection; the `console/ui/*` modules paint; a swappable **store adapter** (`console/store/*` for
the console; `ArtifactStore` for the export) is the only thing that differs. The overlay is a
*separate* codebase (`overlay/inject.js`, a self-contained closed shadow DOM injected into the
live page) that shares only token *values*, not code.

**The render entry point** (`core.mjs` `render()`):
`renderSidebar` → `renderCanvas` → `renderComments` → `updateChrome` → `mounts.onRender?.(ctx)`.

**Options gate the surface's powers** (`core.mjs` `DEFAULT_OPTIONS`): `canPlacePins`,
`canEditNotes`, `canResolve`, `canDelete`, `liveCapture`, `author`. Console enables all;
the archived/lookback console enables all but `liveCapture`; the artifact enables `canResolve`
only.

**Three feedback `type`s** (`session.json` `view.pins[]`, discriminated by `pin.type`, default
`'text'`):
- `text` — point pin + note (today's classic behavior).
- `drawing` — freehand SVG path(s) + optional note. Shape at rest:
  `shape:{ kind:'path', paths:[[[xPct,yPct],…]], bounds:{xPct,yPct,wPct,hPct}, strokeWidth, color }`.
- `element` — a selected DOM element's outline box + human name + note. At rest:
  `element:{ bounds:{xPct,yPct,wPct,hPct}, name, descriptor? }`.

**The invariant every kind honors:** feedback is **never baked into the screenshot PNG** — it
renders as a `%`-positioned overlay over the frozen image at review time. All kinds normalize to
**`%`-at-rest** via the px→% seal path (`lib/coords.mjs`).

**Category is orthogonal to type.** `core.mjs` `CATEGORY_META` (Visual / Copy / Spec / Question /
Bug) is a triage tag with a color dot; any `type` can carry any category.

---

## 2. Overlay surface — live-browser capture accelerator

**Files:** `overlay/inject.js` (the whole UI, a closed shadow DOM; self-contained — inlines its
own DesignOS token block + lucide glyph paths because a closed shadow root can't `<link>` the
console CSS). Daemon-side wiring: `lib/capture.mjs` (exposes the `window.__designQA_*` bindings,
caches `inject.js` at session spawn — **overlay edits need a fresh `/design-qa` session**).

Three **mutually exclusive** capture modes (placement / draw / pick), each modeled on the same
full-screen veil pattern.

### 2a. The toolbar (draggable mini-toolbar)

Currently a **horizontal, top-center** pill: `.toolbar`, `position:fixed; top:16px; left:50%;
transform:translateX(-50%)`.

| Element | Gesture | Symbol / class (`inject.js`) | `type` | §6 implication |
|---|---|---|---|---|
| Grip | drag to move toolbar | `#gripBtn` `.tb-grip`; `onGripDown/Move/Up`, `setPointerCapture`; persists `STATE.toolbarPos` via `__designQA_setUiState` | — | **Mechanism carries over unchanged.** Only the default anchor + axis change. |
| Comment | click → placement mode | `#commentBtn` `.tb-ibtn`; `setPlacementMode` | `text` | New vertical slot |
| Draw | click → draw mode | `#drawBtn` `.tb-ibtn`; `setDrawMode` | `drawing` | **Gets a permanent home** in the realigned toolbar |
| Inspect | click → pick mode | `#pickBtn` `.tb-ibtn`; `setPickMode` | `element` | **Gets a permanent home** in the realigned toolbar |
| New screen | click → confirm → seal + fresh view | `#newScreenBtn`; `requestNewScreen` → `startNewScreenHere` → `__designQA_startNewView` | — | New vertical slot |
| Record ▾ | click → toggle start/stop | `#recBtn` `.tb-rec`; `onRecToggle`; idle/live glyph states (`.rec-glyph.idle/.live`, `rec-halo` keyframe) | — | New vertical slot |
| Done | click → confirm → seal + finalize recording | `#doneBtn` `.tb-done`; `requestDone` → `performDone` | — | New vertical slot |

### 2b. Capture modes

| Mode | Veil / gesture | Symbols (`inject.js`) | `type` | Notes |
|---|---|---|---|---|
| **Placement** | full-screen `.placement-cursor` veil; click drops a temp pin → composer | `setPlacementMode`, `onPlacementClick`; doc coords `clientX+scrollX` | `text` | Esc cancels; right-click suppressed |
| **Draw** | `.draw-veil` (`touch-action:none`) captures pointer strokes into `.draw-ink` SVG (page-px doc coords) | `setDrawMode`, `onDrawDown/Move/Up`, `renderInk`; first stroke opens `openDrawComposer`; commit → `commitDrawing` → `__designQA_createDrawing({ pathsPx })` | `drawing` | Strokes kept as `pathsPx`; px→% at seal. Note **required** (placeholder says so). Multiple strokes = one record. Scroll-during-stroke is impossible by design. |
| **Pick** | `.pick-veil`; hover → `.pick-highlight` rect + `.pick-label`; click locks | `setPickMode`, `onPickMove`, `onPickClick`, `moveHighlight`; `hitTestUnderVeil` toggles veil `pointer-events:none` for the synchronous `elementFromPoint`, then restores; `describeEl` builds the name (aria-label → visible text → placeholder → testId → nearest-testId → tag; **never reads `.value`** — security boundary); `boxPagePx` captures the rect; commit → `commitElement` → `__designQA_createElement({ boxPx, name, descriptor })` | `element` | Locked box renders as `.el-box` in the pin layer. Note **required**. |

### 2c. Pins, cards, composer (overlay's own `.cmt-*` vocab)

| Element | Gesture | Symbol / class | `type` |
|---|---|---|---|
| Pin marker | click → toggle popover; drag → move (text only) | `.pin`, `.pin-layer`; `renderPins`, `attachPinHandlers`; `pinAnchorPx` resolves drawing/element bbox centers | all (drag = text) |
| Composer (new) | auto-grow textarea, category chip, send | `.cmt-card.composer` `.cmt-field` `.cmt-bar` `.send-btn`; `renderComposer`; `buildCategoryControl` | all |
| Read card | view note; ⋯ → Edit / Delete | `.cmt-card.read` `.cmt-menu`; `renderReadCard`, `openReadMenu` | all |
| Edit card | edit note + category; Save / Cancel / Delete | `.cmt-card.edit`; `renderEditCard` → `__designQA_updatePin` | all |
| Category control | chip + picker dropdown | `.cat-control` `.cat-chip` `.cat-picker`; `COMMENT_CATEGORIES` (mirror of `CATEGORY_META`) | all |

### 2d. Recording indicator + chrome

| Element | Gesture | Symbol / class | §6 implication |
|---|---|---|---|
| Recording indicator | click pill → expand steps timeline | `.rec-indicator` `.rec-ind-pill` `.rec-ind-panel` `.rec-ind-list`; `position:fixed; top:64px; left:50%`; `renderRecIndicator`, `toggleRecIndicator`; **step COUNT, not a timer**; pushed from Node via `window.__designQA_setRecorderState` | **Banner moves toward top** (position only; expand/collapse + inner controls unchanged) |
| Steps timeline tile | (display; discard via header) | `.step-tile` `.step-rail` `.step-dot` `.step-line` `.step-stamp` `.step-target`; `.rec-ind-discard` → `discardRecording` | — |
| Confirm modal | inline shadow-DOM confirm bar (native `confirm` is auto-dismissed by Playwright) | `.modal-backdrop` `.modal`; `confirmModal()` | — |
| Toast | auto-dismiss notice | `.toast-layer` `.toast`; `toast()` | — |

**Daemon bindings** (`lib/capture.mjs`, `window.__designQA_*`): `loadForUrl`, `ensureView`,
`createPin`, **`createDrawing`**, **`createElement`**, `updatePin`, `deletePin`, `startNewView`,
`sealCurrentView`, `markStart`, `stopRecording`, `discardRecording`, `fetchRecorderSteps`,
`getUiState`, `setUiState`. Node→shadow push: `__designQA_setRecorderState`. UI state
(`toolbarPos`, `recIndicatorExpanded`) is held **Node-side** (survives cross-origin auth
redirects where LocalStorage would clear).

---

## 3. Console surface — primary authoring + review

**Files:** `console/index.html` (App Frame DOM + mount points), `console/app.mjs` (bootstrap +
live chrome), `console/core.mjs` (shared engine), `console/ui/*`. Served by the daemon
(`lib/http-server.mjs`, 127.0.0.1 only). Store chosen at boot by `console/store/index.mjs`
`createStore()`: `?session=<basename>` → `LookbackStore`; `/api/session` responds → `HttpStore`;
neither → `MemoryStore` fixture (the `_serve.mjs` dev path).

### 3a. Left — Screens sidebar (`ui/sidebar.mjs`)

Mount `#viewList`. `renderSidebar(ctx, root)`.

| Element | Gesture | Symbol / class | Notes |
|---|---|---|---|
| Screen row | click → select screen | `.view-item` `.view-name` `.view-sub` `.view-meta`; sets `activeViewId`, clears selection/modes | manual screens show "Uploaded screenshot" vs `url` |
| ⋯ row action | hover → menu → Delete screen | `.view-action`; `openMenu` → `deleteScreen` → `store.deleteView` | gated on `canDelete` |
| Brand tile + session menu | FileTrigger chevron → session switcher | `#sessionName`; `setupSwitcher` (in `app.mjs`) | live vs `⌛ Archived` badge |
| Search | filter screens by name/url | `#screenSearch` → `state.screenQuery` | — |

### 3b. Center — dot-grid canvas (`ui/canvas.mjs`)

Mount `#canvas`. `renderCanvas(ctx, root)`; `.screenshot-wrapper` holds the frozen image +
`%`-positioned overlays.

| Element | Gesture | Symbol / class | `type` |
|---|---|---|---|
| Marker | click → select (read card); drag → move (text only) | `buildMarker`; `.marker` (`.active`/`.resolved`/`.dragging`/`.no-move`) | all |
| Shape overlay | (render) branches on type | `buildShapeOverlay` → `buildDrawingSvg` (SVG `viewBox 0 0 100 100`, `non-scaling-stroke`) for `drawing`; `buildBoundsBox` (outline rect + name label) for `element` | drawing / element |
| Add-pin tool | toggle place mode | `#addPinBtn` (in `app.mjs`); `state.placeMode`; click image → composer at `pointToPct` | `text` |
| Draw tool | toggle draw mode → stroke on `.draw-capture` → composer | `#drawBtn` (in `app.mjs`); `installDrawLayer` (`.draw-capture` + inline SVG ink) → `store.createDrawing({ paths, note })` | `drawing` |
| Authoring composer | textarea + category + send (shared pin+drawing) | `buildAuthoringComposer`; `.cmt-card.composer` `.cmt-field` `.cmt-bar` `.send-btn` | text / drawing |
| Read / Edit card | view / edit note + category; resolve; delete | `buildReadCard` / `buildEditCard`; `.cc-card.cc-read`/`.cc-edit`, `.cc-chip`, `buildCatControl` | all |
| Locked-screen veil | (blocks edit on a live unsealed browser screen) | `.locked-screen`; `ctx.isLocked(view)` | — |

> **Note:** the console canvas exposes **draw** (`#drawBtn`) but **not** an element/inspect tool —
> `element` feedback is authored only from the overlay (against a live DOM). The console renders
> `element` records (via `buildBoundsBox`) but doesn't create them.

### 3c. Right — Comments | Steps pane (`ui/comments.mjs`, `ui/steps.mjs`)

Mount `#commentsList`. Pill tabs `#tabComments` / `#tabSteps` (`state.rightTab`).

| Element | Gesture | Symbol / class | `type` |
|---|---|---|---|
| Comment card | click → select pin; flat DesignOS card | `buildCard`; `.comment` `.comment-avatar` `.comment-crumb` `.comment-byline` `.comment-note` `.comment-tag`; `avatarColor` (djb2 hash), `initialOf`, `formatRelative` | all |
| Kind label | (display) | `.comment-crumb-kind`; `kindLabel` = "Drawing" / `element.name`‖"Element" / (none for text) | drawing / element |
| Resolve check | click → resolve + toast w/ Undo (silent unresolve) | `.resolve-btn`; `toggleResolve`; `ui/toast.mjs` `showToast` | all |
| ⋯ card action | hover → Delete | `.comment-act`; `openMenu` | all (gated) |
| Category tag | (display + set via card) | `buildCategoryTag`; `CATEGORY_META` | all |
| Steps tab | timeline; inline-edit human label; omit/undo; Preview spec | `renderStepsTab`, `buildStepTile`; `.step-*`; `startStepEdit` → `store.editStepText`; `toggleOmit` → `store.omitStep`/`unomitStep`; `.steps-preview-btn` → `openPreviewSpec` (`ui/preview-spec.mjs`) | — |

### 3d. Top-level chrome (`app.mjs`)

| Element | Gesture | Symbol | Notes |
|---|---|---|---|
| Share | click → single-file ‖ bundle-zip chooser → native save dialog | `#exportBtn`; `openExportChooser` → `POST /api/export?kind=single\|bundle` | gated on `store.listSessions` (live/lookback only) |
| Manual upload | click → pick image → name → POST | `#addScreenBtn`; `pickAndUploadScreen` → `store.addManualScreen` → `POST /api/upload` | gated on `store.addManualScreen` |
| Session switcher | switch live / archived siblings | `setupSwitcher`; `?session=<basename>` | — |
| Filter / sort / search | overflow popover + comment search | `#overflowBtn`/`#overflowMenu`, `#filterStatus`, `#filterCategory`, `#sortBy`, `#commentSearch`; `wireControls` | drives `visiblePins` |
| Resizers | drag pane boundaries | `setupResizers` (`ui/resizers.mjs`); persists `--col-left`/`--col-right` to LocalStorage | — |
| Live badge | (display) | `renderConsoleChrome` (`onRender`); `● Live` vs `⌛ Archived` | — |

**Server routes** (`lib/http-server.mjs`): `GET /api/session[?id=]`, `GET /api/sessions`,
`POST /api/mutate[?id=]` (allowlist `CONSOLE_OPS`; ownership guard `_assertConsoleEditable` for
`VIEW_ID_OPS`/pin ops), `POST /api/upload[?id=]`, `POST /api/export?kind=`,
`GET /api/recording-preview`, `GET /api/events` (SSE), screenshots (owned + sibling). The
`?id=<basename>` sibling path makes lookback fully writable ("one writer per session **at a
time**").

### 3e. Store adapters (`console/store/*`)

`createStore` (`store/index.mjs`) → `HttpStore` (`http-store.mjs`, live; mutations POST to
`/api/mutate`, SSE-driven re-render), `LookbackStore` (`lookback-store.mjs`, archived sibling via
`?id=`), `MemoryStore` (`memory-store.mjs`, in-memory fixture — has client-side `createPin` /
`createDrawing`). All expose one interface so the UI is store-agnostic.

---

## 4. Artifact surface — frozen, portable export

**File:** `artifact/build.mjs` (`buildArtifact` / `exportSession`). It reuses the **shared
renderer** — no separate artifact UI. `SHARED_MODULES` (`core.mjs` + `ui/*` + `lib/*` +
`store/local-resolve.mjs` + `store/artifact-store.mjs`) are inlined via an import map of
`@dqa/*` → base64 `data:text/javascript` URLs (`inlineModules`), so the module graph loads from
`file://`. The session + screenshots embed as `data:` URLs (`buildEmbeddedSession`); CSS
(`tokens.css` + `base.css` + `styles.css`) inlines into one `<style>` (`renderHtml`).

Backed by `ArtifactStore` (`store/artifact-store.mjs`) with **`options: { canResolve: true }`
only**.

| Affordance | Artifact | Mechanism |
|---|---|---|
| Resolve / check-off | **ON** | `ArtifactStore.resolvePin` → LocalStorage keyed by session id (`store/local-resolve.mjs` `applySavedResolves`/`saveResolvedPin`) — the **still-open Spike 7** engineer-side layer; sidecar-JSON swap deferred |
| Filter / sort / search / categories | ON | shared `core.mjs` `visiblePins` |
| Place / move / delete / edit-note / draw / manual-upload | **OFF** | gated off by `options`; the corresponding store methods are no-ops |
| Steps timeline + Preview spec | render-only | shared `ui/steps.mjs` / `ui/preview-spec.mjs` |

Because the renderer is shared, **type-aware rendering propagates into the artifact for free** —
`drawing` SVGs and `element` boxes show in the export with no extra scaffolding.

---

## 5. Feedback-`type` render matrix

| | `text` | `drawing` | `element` |
|---|---|---|---|
| **Overlay create** | placement mode → pin | draw mode → strokes (`pathsPx`) | pick mode → box + name |
| **Overlay marker** | `.pin` numbered bubble (movable) | `.pin` anchored at stroke bbox centre + `.draw-ink` | `.pin` + `.el-box` outline |
| **Console create** | `#addPinBtn` | `#drawBtn` (`installDrawLayer`) | — *(render-only)* |
| **Console overlay** | `.marker` bubble (movable) | `buildDrawingSvg` (`%` SVG path, `non-scaling-stroke`) | `buildBoundsBox` (`%` outline rect + name label) |
| **Card kindLabel** | (none) | "Drawing" | `element.name` ‖ "Element" |
| **At-rest payload** | `xPct,yPct` | `shape:{kind:'path',paths,bounds,strokeWidth,color}` | `element:{bounds,name,descriptor?}` |
| **Note** | optional | optional (POC lean) / **required** in current overlay+console composer | required |
| **Movable** | yes | no (`.no-move`) | no (`.no-move`) |

**Shared primitive:** an `element` box and a (future) rect-kind `drawing` are the same
`%`-positioned rectangle. `buildBoundsBox` (`ui/canvas.mjs`) is the shared render path; the two
stay **distinct `type`s** so review can label provenance.

**Open (UX call, §5 of the platform doc):** whether review *visually differentiates* the kinds
(icons / card shapes) or treats everything as "just feedback." Currently low differentiation
(only the `kindLabel` crumb).

---

## 6. §6 starting point — the design-gated UI update

§6 of `design-qa-feedback-platform.md` is the **last** build step, gated on the Claude Design
pass. Three changes, all in `overlay/inject.js`, with precise anchors:

1. **Toolbar realign → vertical + new default anchor.**
   - Today: `.toolbar { position:fixed; top:16px; left:50%; transform:translateX(-50%);
     display:inline-flex; }` (horizontal top-center).
   - Change: vertical axis (`flex-direction:column`) + a new default anchor (likely an edge dock —
     **design decides the exact anchor**).
   - **Carries over unchanged in mechanism:** the grip drag (`onGripDown/Move/Up`,
     `setPointerCapture`), the Node-side position persistence (`STATE.toolbarPos`,
     `__designQA_setUiState`/`getUiState`), `applyToolbarPos`, and `clampToViewport`. Only the
     **default anchor + axis** change. Audit `applyToolbarPos`'s centering fallback and
     `clampToViewport` for the new orientation.

2. **New action homes.** The draw (`#drawBtn`/`setDrawMode`) and inspect (`#pickBtn`/`setPickMode`)
   buttons **already exist** in the toolbar — §6 gives them their permanent visual slots in the
   realigned layout alongside comment / new-screen / record / Done. Treat icon/gesture finalization
   as design-owned.

3. **Recording banner → toward top.** `.rec-indicator { position:fixed; top:64px; left:50%; }` →
   move toward the top. **Expand/collapse mechanics + the controls inside (`renderRecIndicator`,
   `toggleRecIndicator`, the steps list, discard) stay the same** — position only. Note it's
   coupled to the toolbar's position today (`top:64px` = below the `top:16px` toolbar); re-derive
   the offset once the toolbar moves.

Nothing in §6 touches the data model, the bindings, or the console/artifact renderer — it is pure
overlay position + layout.

---

## 7. Cross-surface duplications the cutover will care about

The standalone-app cutover (`design-qa-standalone-app.md`, Vite+React+TS) will want these
consolidated. Flagged here so they're visible going in:

| Duplication | Where | Why it exists | Cutover note |
|---|---|---|---|
| **Composer/card class vocab** | overlay `.cmt-*` / `.composer` / `.cat-*` / `.pin` vs console `.cc-*` / `.comment-*` / `.marker` | two codebases (shadow-DOM overlay can't share console CSS) built from the same tokens | unify the component vocabulary when both become React components |
| **`coords.mjs`** | `lib/coords.mjs` (Node, seal/build time) ⟷ `console/lib/coords.mjs` (browser) — **identical** | buildless console can't import outside its static dir | ⚠ **change both** when touching `pagePxToPct`/`boxToPct`/`imagePxToPct`/`clampPct`/`pngDimensions` |
| **`recorder-format.mjs`** | `lib/recorder-format.mjs` ⟷ `console/ui/recorder-format.mjs` | same buildless reason | same — keep `selectorLabel` in sync |
| **Category metadata** | `core.mjs` `CATEGORY_META` ⟷ `inject.js` `COMMENT_CATEGORIES` | overlay is a separate codebase | one source post-cutover |
| **Tokens: inlined vs `<link>`** | overlay inlines a token block in `inject.js`; artifact inlines `tokens.css` into `<style>`; console `<link>`s `tokens.css` | shadow-DOM + `file://` portability constraints | the bundler resolves all three to one token source |
| **Lucide glyphs** | overlay inlines glyph paths in `inject.js`; console uses `ui/icons.mjs` | shadow DOM | one icon module post-cutover |
| **Store adapters** | `console/store/{http,lookback,memory}-store.mjs` + `artifact-store.mjs` | one interface, four backends | already the right seam — the cutover swaps the network/persistence layer behind it without touching the renderer |

These seams are deliberate (buildless + shadow-DOM constraints), not accidental — the cutover
plan (`design-qa-standalone-app.md`) reverses the buildless decision, at which point the `lib/`↔
`console/lib/` duplicates and the inlined-vs-link token story collapse into single sources.

---

## Related
- `design-qa-feedback-platform.md` (§5 review surfaces, §6 the last UI update, §7 phasing)
- `design-qa-console-architecture.md` (the three surfaces, store-adapter pattern, %-at-rest)
- `design-qa-spikes.md` (Spikes 11 drawing / 12 element / 7 resolve-persistence, deferred)
- `design-qa-standalone-app.md` (+ A/B/C) — the cutover the seams above ride into
