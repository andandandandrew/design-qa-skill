# Design QA — Feedback-capture POCs: implementation plan (Spikes 11 & 12)

**Status:** PLAN (2026-05-31). Forks settled with the user; ready to build. Turns the
POC-validated-feasible verdicts in `design-qa-spikes.md` (Spikes 11 & 12) and the reframe in
`design-qa-feedback-platform.md` into **working prototypes wired end-to-end through the real
seams**, with **minimal / undesigned UI**, so the forthcoming Claude Design UX lands on a
prototype that already works. **Mechanics first; visual design later.** Build order: **drawing
first, then element.**

> This is a curated reference, not a transient TODO. It records *what* we're building, *the
> seams it threads*, and *the decisions that govern it* — verify current-state claims against
> live code before relying on them.

---

## 1. What we're adding

`/design-qa` is a **feedback platform, not a commenting platform**. A pinned text note is one
*kind* of feedback. Two more kinds, unified by a **`type` discriminator** on the feedback
record (default `'text'`), each carrying a type-specific payload alongside today's shared
fields (`note`, `category`, `author`, `status`, `createdAt`, `xPct`, `yPct`):

- **Spike 11 — drawing/markup** (`type:'drawing'`): freehand-draw on the live page to direct
  attention; attach a **required** note; persists + renders like a pin.
- **Spike 12 — element inspector** (`type:'element'`): pick a live DOM element; capture its
  outline box + a human element name; attach a **required** note.

Records continue to live in `view.pins[]`. Everything rides the seams pins already ride —
no new persistence model, no new render pipeline, no separate artifact scaffolding.

## 2. Decisions settled with the user (2026-05-31)

1. **Drawing first, then element.** The first method builds all the shared scaffolding (the
   `type` field + `'text'` default, the seal-time normalization branch, the `buildMarker` /
   `buildCard` `type`-branches, the new-binding + new-store-method pattern). Element reuses all
   of it plus a shared `buildBoundsBox` primitive.
2. **A note is REQUIRED for both new kinds.** Submitting the composer with a non-empty note is
   what seals the record and stops stroke/selection collection; an empty or cancelled draft is
   discarded (no record, no view). **This OVERRIDES the spikes' "optional note / a bare circle
   is valid feedback" lean** (`design-qa-spikes.md` §Spike 11, §Spike 12, and
   `design-qa-feedback-platform.md` §2/§9). Net effect: one commit rule across all three types
   — *non-empty note == commit* — matching today's temp-pin behavior exactly.
3. **Render-correct, label-light.** Each type renders correctly in review (numbered bubble /
   SVG path / outline box) and cards show the element name or a "drawing" summary, but **no
   bespoke icon/color/legend system** — the forthcoming Claude Design pass owns real visual
   differentiation (`design-qa-feedback-platform.md` §5, §9).

## 3. Verified seam map (ground truth)

- **Records array:** `view.pins[]`. The `SessionStore` mutators are pin-centric but operate
  **generically by id** for edit-note / resolve / delete (`editPin`, `resolvePin`, `deletePin`
  in `lib/session.mjs`), so those affordances work on any `type` for free.
- **px-at-capture → %-at-seal — THE critical path.** Browser pins store page-px `x/y`;
  `normalizeViewPins` (`lib/session.mjs:69`) converts them to canonical `xPct/yPct` **only at
  `sealView`**, against the final full-page screenshot. **Drawings (px point arrays) and
  element boxes (px rect from `getBoundingClientRect`) must thread the SAME seal-time
  normalization** — `normalizeViewPins` gains a `type`-branch. The throwaway POCs normalized
  inline; this is the main *new* integration work and the thing most likely to break.
- **Shared render, two surfaces for free.** `console/ui/canvas.mjs buildMarker` (`:88`) and
  `console/ui/comments.mjs buildCard` (`:45`) run over a swappable store adapter, so a
  `type`-branch in those two functions propagates to **the console AND the exported artifact**
  with no artifact-specific work. The artifact's `ArtifactStore` already no-ops non-resolve
  mutations.
- **Capture bindings:** `lib/capture.mjs` `context.exposeBinding(...)` — model on
  `__designQA_createPin` (`:484`): create record → set `viewPages` → screenshot-if-first else
  `scheduleScreenshot`.
- **Overlay (closed shadow, vanilla, self-inlined tokens):** `overlay/inject.js` —
  `setPlacementMode` + `.placement-cursor` full-screen veil (`:1233`) is the capture-mode
  model; toolbar cluster (`:503`); deferred-create composer + commit (`commitTempPin` `:914`,
  `renderPopover` composer branch); live pin render (`renderPins` `:629`). The `.chrome`
  subtree `stopPropagation` boundary already prevents the page underneath from reacting.
- **Server allowlist:** `lib/http-server.mjs CONSOLE_OPS` (`:41`) gates **console** edits only;
  browser capture writes through the bindings above, not this map. Console edit/resolve/delete
  of a drawing/element work through the existing generic ops.
- **Coords:** `lib/coords.mjs pagePxToPct` is reused unchanged. ⚠ There is an **intentional
  `lib/coords.mjs` vs `console/lib/coords.mjs` duplicate** (buildless, no shared bundle) — any
  new coord helper (element's `boxToPct`) must be added to **both**.

### Findings that shaped the plan

- **Capture-surface asymmetry.** A drawing can *also* be authored later on a console-frozen
  screenshot (%-of-image via `canvas.mjs pointToPct`, like manual-upload pins). **Element
  picking needs a live DOM**, so it is **browser-only.** POC scope for *both* is **live-browser
  capture**; console-side drawing authoring is a flagged stretch, not in these POCs.
- **Security.** The element descriptor reads `aria-label` / visible text / `placeholder` /
  `data-testid` for the human name but **must never read `input.value`** — that would leak
  typed secrets into `session.json` and the artifact. This keeps the capture-time redaction
  boundary intact (`lib/redact.mjs` handles recorder fill-values and is untouched here). The
  drawing's only new text surface is the note, which the reviewer types deliberately.
- **Move/drag is geometry-specific.** Dragging repositions a pin's `xPct/yPct`; it doesn't move
  a path or a box. **POC marks drawing/element markers `movable:false`** (select-to-read only).
  Edit-note / resolve / delete remain available and generic.

## 4. At-rest data model (additive to schema v4, NO version bump)

`migrateDoc` (`lib/session.mjs:115`) defaults `p.type = 'text'` for every existing record —
folded into v4 additively, exactly as `recordingDoneAt` was. Existing render/store paths ignore
`type`, so legacy data is unaffected.

```
feedback record (in view.pins[]):
  { id, viewId, type, note, category, author, status, resolvedNote, createdAt, xPct, yPct }
                      ^^^^ new; default 'text'

type:'drawing' adds:
  shape: { kind:'path',
           paths: [ [[xPct,yPct], …], … ],     // multi-stroke = one record
           bounds: { xPct, yPct, wPct, hPct },
           strokeWidth,                          // css px, rendered non-scaling
           color }
  xPct/yPct = stroke CENTROID  → existing pin-keyed focus/scroll/selection just works
  note required · category optional · RDP-simplified on seal (ε ≈ 0.4%)

type:'element' adds (POC 2):
  element: { bounds: { xPct, yPct, wPct, hPct },
             name,                               // human breadcrumb
             descriptor?: { tag, testId, text } } // optional; NEVER input.value
  NO selector (hard reuse of Spike 3) · note required
```

A `type:'element'` box and a future rect-kind drawing are the same %-positioned rectangle —
both render through a shared **`buildBoundsBox(pctBounds)`** helper while staying distinct
`type`s (so review can label provenance).

## 5. Build — POC 1: drawing (branch `6/poc-drawing`, off fresh `main`)

**Capture — `overlay/inject.js`:**
- New toolbar button in the comment `.tb-cluster` (`:503`), reusing `.tb-ibtn` styling
  (placeholder pen glyph).
- `setDrawMode(on)` modeled on `setPlacementMode`: a `.draw-veil` (clone of `.placement-cursor`
  + `pointer-events:auto; cursor:crosshair; touch-action:none`) and a live SVG `.draw-ink`
  preview, appended to `chrome`. Pointer down/move/up accumulate strokes in **page-px doc
  coords** into a local buffer; multiple pen-down/up cycles append more sub-paths (one record).
- After the first stroke, open the **reused composer** (`renderPopover` composer branch)
  anchored near the strokes' bbox, with a **required** note. Submit → `commitDrawing` (lazy
  `ensureView`, mirroring `commitTempPin`) → `__designQA_createDrawing({viewId, pathsPx, note,
  category})` → exit draw mode. Escape / cancel / empty note discards the draft.
- Extend `renderPins` to branch on `type` and draw committed drawings as an SVG path (px) so
  they're visible during capture; hidden by `capture-mode` like pins.

**Store + binding:**
- `lib/session.mjs`: `createDrawing({viewId, pathsPx, note, category, author})` — stores
  `type:'drawing'`, px paths in a working `pathsPx` field, required note. Extend
  `normalizeViewPins` with a `type`-branch: drawing → run each px point through `pagePxToPct`,
  RDP-simplify, populate `shape.paths` + `shape.bounds`, set `xPct/yPct` = centroid, drop
  `pathsPx`. Same single normalization point (`sealView`) as pins.
- `lib/capture.mjs`: `__designQA_createDrawing` binding mirroring `__designQA_createPin`.

**Render (console + artifact, both for free):**
- `console/ui/canvas.mjs buildMarker`: branch on `p.type`. `drawing` → `<svg viewBox="0 0 100
  100" preserveAspectRatio="none">` + `<path>` from `shape.paths` (%) + `vector-effect=
  "non-scaling-stroke"`, plus the numbered bubble at the centroid for select/focus. Add the
  shared `buildBoundsBox(pctBounds)` helper now. Drawing markers are `movable:false`.
- `console/ui/comments.mjs buildCard`: drawing card shows a "Drawing" summary in place of the
  pin number; note / category / resolve / ⋯ unchanged.

**Verify:**
- Unit (`lib/__tests__/`): `createDrawing` + seal normalization round-trips (px→% within
  0..100; RDP reduces point count; centroid + bounds correct); `migrateDoc` defaults
  `type:'text'`.
- e2e (`lib/__tests__/capture-e2e.test.mjs` harness — headless, bindings driven directly):
  `__designQA_createDrawing` → seal → assert `shape.paths` are %, **screenshot has no ink baked
  in** (sample a pixel under a stroke), required-note enforced.
- Manual: `/design-qa` → draw on a live page → required note → Submit → SVG overlay over the
  screenshot in the console canvas → resolve / delete → Share → artifact renders it.
- Whole suite stays green (currently 53).

**Squash-merge** `6/poc-drawing` → `main`; delete the branch.

## 6. Build — POC 2: element (branch `7/poc-element`, off fresh `main` after POC 1 merges)

Reuses every piece of scaffolding + `buildBoundsBox`. Adds:
- `inject.js` `setPickMode`: hover highlight + click-to-lock via `document.elementFromPoint`
  with the **POC-proven crux fix** — toggle the veil's `pointer-events:none` for the single
  synchronous hit-test, then restore. The existing `e.target===host` boundary skips our own UI.
- `describe(el)` → human `name` from `aria-label` → visible text → `placeholder` → `testId` →
  nearest-testId → tag. **Never reads `input.value`.**
- `__designQA_createElement` binding + `createElement` store method (px box → `normalizeViewPins`
  element-branch → `element.bounds`). A thin `boxToPct` helper in **both** `coords.mjs` copies.
- `buildMarker` element branch → `buildBoundsBox` outline + name label + centroid bubble;
  `buildCard` shows `element.name`. Note required. `movable:false`.

Same unit + e2e + manual verification shape. **Squash-merge**; delete the branch.

## 7. Out of scope here

- Browser-fixture toolbar realign (→ vertical) + recording-banner reposition (→ top) — these
  stay **LAST** per `design-qa-feedback-platform.md` §6/§7, after the capture methods land.
- Console-side drawing authoring on frozen screenshots (the flagged stretch).
- Primitives (rect / ellipse / arrow) — freehand path first; primitives share the `bounds`
  render path later.
- Sidecar-JSON engineer-side resolve persistence (unrelated open Spike-7 item).

## 8. Workflow / git conventions

- **This branch `5/feedback-capture-poc`:** this doc only → commit → PR → `main` → **real merge
  commit** (curated docs don't squash).
- **Implementation branches** (`6/poc-drawing`, then `7/poc-element`) off fresh `main`, one
  method at a time, tested in isolation → **squash-merge**, delete on merge.
- Never commit to `main` directly. The daemon caches `inject.js` + `capture.mjs` at session
  spawn — overlay/daemon edits require a **fresh `/design-qa` session** to test.

## Related

- `design-qa-feedback-platform.md` — the reframe, the `type` discriminator, the
  overlay-not-baked invariant, the LAST-step UI realign.
- `design-qa-spikes.md` — Spikes 11 & 12 feasibility verdicts, measured numbers, recommended
  shapes (note: their "optional note" lean is overridden here per §2.2).
- `design-qa-console-architecture.md` — store-adapter pattern, shared renderer, %-at-rest.
- `design-qa-standalone-app-{A,B,C}.md` — the future Vite+React+TS cutover these features ride
  ahead of; respecting the seams keeps that lift-and-shift clean.
