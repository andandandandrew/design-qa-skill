# Design QA Skill — Research Spikes

This document captures the technical unknowns that should be probed before the `design-qa` skill spec is finalized. Each spike has a question to answer, a rough approach, and what "done" looks like.

These spikes are a precondition to committing to the skill spec. Findings will sharpen — and may reshape — the spec's command surface, file layout, and UI model.

---

## Spike 1 — Playwright as the authoring driver

**Question.** Is Playwright (used as a Node library, headed Chromium) the right tool for driving the designer's QA browser session? Or is a browser extension, Chrome DevTools Protocol directly, or Puppeteer a better fit for this use case?

**Why it matters.** The whole authoring environment hangs off this choice. We need a browser the designer can drive naturally (navigate, log in, click around) that also lets us inject UI, listen for clicks, capture screenshots, and persist state across navigations.

**What to probe.**

- Can we launch headed Chromium from a Node process, hand control of navigation to the designer, and still inject scripts/styles into every page?
- Can injected UI (overlay + inspector panel) persist cleanly across SPA route changes, hard navigations, and authenticated redirects?
- What happens to injected state when the page does a full reload vs. a client-side route push?
- Are there cleaner alternatives (extension, CDP direct) that we'd regret not evaluating?

**Done when.** We have a one-paragraph recommendation with confidence level. If Playwright is the answer, we know how to handle injection across SPA navigations. If it isn't, we know what is and why.

---

## Spike 2 — Overlay + inspector injection model

**Question.** How do we inject the annotation overlay and the session inspector panel into arbitrary pages without breaking the page being QA'd?

**Why it matters.** The designer is QA'ing real apps. Our injected UI cannot interfere with the app's own layout, styles, event handlers, or routing. We also need the inspector to coexist on-screen with the page (not in a separate tab/window) per the agreed UI model.

**What to probe.**

- Shadow DOM for isolation — is the ergonomic overhead worth the isolation guarantee?
- Z-index, pointer-events, and event-bubbling pitfalls when overlaying on top of arbitrary apps
- How the inspector panel should claim screen space — a fixed sidebar that resizes the page (intrusive but visible) or a floating/collapsible panel (less intrusive but easier to lose track of)
- Whether the inspector needs its own document or can live in the same page DOM as the overlay
- How injected scripts re-attach on SPA navigation (mutation observers? Playwright's `addInitScript`?)

**Done when.** We have a working injection prototype that survives navigating between three different sites with different stacks (e.g., a React SPA, a Next.js app, a server-rendered site) and an opinion on shadow DOM vs. plain DOM isolation.

---

## Spike 3 — Pin-to-element capture (lightweight)

**Question.** What's the minimum-viable way to capture which element a pin was placed on, given that we explicitly do not need hyper-specific or durable selectors?

**Why it matters.** Designer confirmed selectors are only for approximate placement, not for engineer-side element identification. We need *something* to anchor a pin to its rough location so that the pin survives minor scroll or re-render between placement and screenshot capture. But we should not invest in resilient-selector logic.

**What to probe.**

- Is capturing `(x, y)` in document coordinates enough, given that the screenshot is the canonical artifact?
- If we do capture a selector, is `document.elementFromPoint(x, y)` plus a shallow descriptor (tag + classes + nearest test id, if any) sufficient?
- Do we need to re-find the element before screenshot to re-anchor the pin position, or is "pin stays where it was dropped in viewport coords" fine?

**Done when.** We have a decision: pure coordinate anchoring vs. coordinate + lightweight selector hint, with rationale. The bar is "good enough for v1, not engineered for durability."

---

## Spike 4 — Screenshot capture mechanics

**Question.** When the designer is done annotating a view, how do we capture a screenshot that includes the pins overlaid on the page?

**Why it matters.** The screenshot is the canonical handoff artifact. Pins must appear baked into the image. The page being QA'd may be longer than the viewport (full-page screenshot) or modal-bound (constrained capture).

**What to probe.**

- Playwright's full-page screenshot vs. viewport screenshot — which is the default for a "view"?
- Does the pin overlay render correctly in screenshots taken via Playwright's screenshot API, or do we need to compose the image (page screenshot + pin layer drawn programmatically)?
- How do we exclude the inspector panel from the screenshot? (Either hide it pre-capture or use a clipping region.)
- What happens with lazy-loaded content below the fold during full-page capture?

**Done when.** We have a working capture path that produces a PNG with all pins for the current view visible and the inspector excluded.

---

## Spike 5 — Voice / LLM annotation placement (phase 2, but scoped now)

**Question.** When the designer speaks a stream-of-consciousness description, how does the LLM convert it into discrete pins placed against the live DOM?

**Why it matters.** This was the POC's strongest UX win and is the most differentiated piece of this skill. Phase 1 ships without it, but the spec should know what it's reserving space for.

**What to probe.**

- What's the right DOM serialization to hand the LLM? Full DOM is too big; accessibility tree is probably the right level (it gives labels, roles, and structure without noise).
- How does the LLM communicate "place a pin at the email input" back to us? A list of `{description, target}` pairs where `target` is something we can resolve to coordinates?
- What's the fallback when the LLM can't resolve a target confidently? Drop the pin at a default location (center of viewport?) with a flag for designer attention?
- Latency — is this an interactive turn or does the designer say their piece, hit submit, and wait?

**Done when.** We have a design sketch for the phase-2 path with one paragraph on each open question. Not a working implementation — just enough to know the spec accommodates it.

---

## Spike 6 — Session resume

**Question.** How does the skill resume a session after the designer closes the laptop and comes back?

**Why it matters.** Designer confirmed resume is in v1. State lives in a session directory. We need to restart the Chromium browser, re-inject overlay + inspector, restore pins and views, and put the designer somewhere reasonable.

**What to probe.**

- What's the canonical session state file format? (JSON, with views, pins, metadata, screenshot file references.)
- On resume, do we re-open the browser to the last view's URL, or land on a session inspector "start screen" and let the designer navigate?
- How do we handle the case where the URL no longer loads (app changed, auth expired) on resume?

**Done when.** We have a resume flow sketched: file format, restoration sequence, edge cases.

---

## Spike 7 — Export format and sidecar state

**Question.** What does the exported HTML artifact look like, and how does engineer-side completion state work?

**Why it matters.** This is the handoff. It needs to be portable (single file or small directory), self-contained (base64'd images, embedded styles), and friendly to a future engineer-side completion-tracking layer.

**What to probe.**

- Single HTML file (base64 images inline) vs. small directory (HTML + `screenshots/` + `state.json`). Designer is open to either; we should pick based on what gives a better engineer experience for completion tracking.
- If sidecar JSON for completion state: how does the engineer-side HTML know to read/write it? (File system access API? Manual export of an updated artifact?)
- Should the exported HTML embed the source data (so it can re-render with state changes) or be a snapshot (frozen markup that gets selectively modified)?

**Done when.** We have a recommended export shape, with the completion-state mechanism specified concretely enough to build.

**Decision (2026-05-27, post-demo).** Export a small **directory**, not just a single file. Contents: `artifact.html` + `session.json` (+ `screenshots/`) + the recorded Playwright script (Spike 8). Opening the directory locally unlocks the **full console-style interactivity** (filter, search categories, resolve/check-off), since the data and assets sit beside the HTML. This supersedes the "single self-contained file is the goal" framing — a single inlined file remains a convenience fallback for quick sharing. Engineer-side resolve persistence can then write to the sidecar JSON in the directory (still bounded by browser file-write limits from `file://`). The in-progress artifact-parity build (Phase 7, shared-renderer) uses **LocalStorage in the interim**; because the artifact reuses the console render modules over a swappable store adapter, moving resolve persistence to a sidecar `session.json` later is a store-adapter change, not a rewrite. How `artifact.html` itself is packaged may change to suit the directory model — deferred to the export build.

**SHIPPED (Phase 7, commit `abad681`, 2026-05-28).** The bundle ships as a **`.zip`** (one save dialog, single artifact to share) rather than an unzipped directory — same contents (`artifact.html` + `session.json` + `screenshots/` + `README.md`). The single-file form ships in parallel as a separate Share option. Both flows present a **native OS save dialog** (`window.showSaveFilePicker` on Chromium, `<a download>` fallback elsewhere); the user picks where the file lands. A silent project archive lives at `<sessionDir>/artifact-YYYYMMDD-vN.html` + `<sessionDir>/exports/<HHMMSS>-vN/` (every Share writes both). The bundle's `README.md` notes the empty Spike-8 Playwright-script slot. **Sidecar-JSON resolve persistence (the "engineer-side completion" question) is still OPEN** — the shipped artifact's `ArtifactStore.resolvePin` keeps writing to LocalStorage; moving to the bundle's `session.json` is the planned store-adapter swap, not yet done.

---

## Spike 8 — Interaction recording & replay *(post-demo, 2026-05-27; design + POC complete 2026-05-28)*

**Status (2026-05-28):** DESIGN + POC COMPLETE; PHASING IS THE NEXT ASK. Full
design at `_kickoff-docs/design-qa-interaction-recording.md`. Mechanism validated
against an Auth0-protected app — Playwright 1.60.0's private `context._enableRecorder`
+ `recorderMode: 'api'` works, no Inspector window, getByRole-quality selectors,
URL segmentation works via per-event `pageUrl`. Throwaway POC at
`.claude/skills/design-qa/scripts/spike8-poc.mjs` (output `spike8-poc-out/`,
gitignored). Headless mechanism smoke at `spike8-smoke.mjs`; headless redaction
smoke at `spike8-redaction-smoke.mjs` (planned to port under `scripts/lib/__tests__/`
as a permanent regression when 9a lands).

**🚨 The POC surfaced an unanticipated security finding:** the recorder serializes
raw fill values into `action.text`, the `.ts` `code` snippet, AND the `ariaSnapshot`
ARIA-tree string (which lists every visible input's current value — so a password
typed at step 3 keeps appearing in every subsequent action's snapshot). The
original design treated auth as "the engineer's problem" (no `storageState`
shipping); that handled tokens but missed the more immediate credential-leak
vector while the reviewer types into the live form. A capture-time redaction
layer was added to the design doc and validated by smoke. **Redaction is a
security boundary — must land in the same phase as the recorder adapter (9a),
not later.** Full algorithm + tradeoffs in the design doc §"POC results" + §4.

**Question.** When capturing from the browser, can we also record the series of interactions the QA person took to reach the annotated state, and emit it both as (a) an executable Playwright script and (b) a human-followable step list? *(Decision: emit BOTH forms.)*

**Why it matters.** Today the feedback is prescriptive (screenshot + pins), but an engineer can't easily reproduce the **conditions** that produced the state — a form-validation error, a specific filter, a particular logged-in view. Recording the path makes the handoff reproducible: the engineer can either *run* the script to land on the exact state, or *follow* the written steps.

**What to probe.**

- Can we record interactions from the same headed Chromium we already drive (CDP, Playwright tracing, or codegen-style action capture) without disrupting the designer's natural navigation?
- Granularity: which events to record (navigations, clicks, inputs, scroll, explicit waits) and how to keep the emitted script robust rather than brittle.
- The **auth / preconditions problem**: the persistent browser-profile carries the QA person's cookies, but a script handed to an engineer won't. How do we represent login/preconditions — a manual "log in first" step, env-injected creds, or left to the engineer?
- Mapping a recorded path to a **screen**: each sealed screen should carry the script segment that produced it.
- Output format that round-trips cleanly into the export directory (Spike 7).

**Done when.** A prototype records a multi-step path on a real app and produces *both* an executable Playwright spec that replays to the same state *and* a readable step list, with a clear position on the auth/preconditions problem.

---

## Spike 9 — Post-change regression diff *(post-demo, 2026-05-27) — RESEARCH ONLY*

**Question.** Once a screen has a recorded path (Spike 8) plus resolved/open comments, can we re-run the path after code changes and produce a useful **diff** of what changed against what was commented and resolved? This is explicitly a research spike — assess what is actually feasible before committing to any approach; do not assume.

**Why it matters.** Closes the loop. A designer's comment plus the ability to return to the same state means we could verify whether feedback was actually addressed after the code changed — regression-testing the *design*, not just the code.

**What to probe (compare candidate approaches; do not pre-commit).**

- **Visual diff at pinned regions** — re-run, re-screenshot, pixel/region-compare against the original at each pin.
- **Element / state assertions** — capture DOM/selector state at each pin and re-assert after changes; precise but brittle to markup churn.
- **LLM-judged validity** — an LLM compares the old screenshot + comment against the new render and judges whether each comment is addressed or stale; flexible but fuzzy.
- Hybrids; robustness to layout churn; how to present results (per-pin status: changed / unchanged / likely-resolved).
- Hard dependency on Spike 8 (need a replayable path first).

**Done when.** A written recommendation comparing the approaches with confidence levels and a proposed first implementation — **not** an implementation.

---

## Spike 10 — Compare-to-Figma (LLM-driven) *(post-demo, 2026-05-27)*

**Question.** For reviewers who sense something is "off" but can't articulate the feedback, can we drive an LLM comparison between the live/screenshotted state and its Figma source, and have it suggest or generate pin descriptions?

**Why it matters.** Lowers the articulation bar. Many reviewers spot wrongness without knowing the design vocabulary; an LLM diff against the design source can name it for them.

**What to probe.**

- **Linkage (decided): the QA person manually provides a Figma node URL per screen.** Where is that captured in the session / UI, and how does it attach to a screen?
- Mechanism: **Figma Console MCP + the desktop bridge** to pull the Figma frame representation; combine it with our screenshot + URL + recorded path (Spike 8) as the "current state" reference.
- LLM output modes: (a) add descriptions to already-placed pins; (b) generate pins *and* descriptions; (c) produce a non-binding "things to consider" list the reviewer uses to place their own pins.
- Where this runs: in the capture flow (back in the browser frame) vs. the console; how results are written back to `session.json`.
- Guardrails: keep LLM output as **suggestions a human accepts**, not silent auto-pinning.

**Done when.** A design sketch of the flow (manual Figma link → MCP fetch → LLM compare → suggested/generated pins) with the three output modes scoped and the MCP dependency confirmed.

---

## Spike 11 — Drawing / markup feedback *(post-DesignOS, 2026-05-31) — RESEARCH ONLY*

**Framing.** Part of the **"feedback platform, not commenting platform"** reframe (see
`design-qa-feedback-platform.md`). A pinned text note is one *kind* of feedback; a drawn
markup is another. Both are first-class, unified by a `type` discriminator on the feedback
record. This spike assesses feasibility before any implementation — do not pre-commit.

**Question.** Can the overlay let a reviewer grab a pen tool and freely draw on the page —
circling/marking the region they mean — optionally attaching a text note via (a variant of)
the existing comment input, and have that drawing persist alongside pins, bake into the
same screenshot review, and render identically in the console and the exported artifact?

**Why it matters.** Many reviewers point before they can phrase. A drawn shape captures
"look *here* / *this* relationship" with zero articulation cost, and the optional note then
carries the message. It's the lowest-articulation-bar feedback we can offer, and it
composes with everything else on the screen.

**What to probe.**

- **Capture surface.** A transparent draw layer inside the closed shadow DOM, taking
  pointer events while the tool is active — modeled on the existing **placement-mode**
  pattern (`inject.js` `setPlacementMode` / `.placement-cursor`, the full-screen capture
  veil). Must respect the `chrome` event boundary (the overlay already stops events at the
  shadow host so the page underneath doesn't react). How does a draw stroke coexist with
  the page's own scroll/selection?
- **Shape model.** Freehand path (array of points) vs. primitives (rectangle / ellipse /
  arrow). Freehand is most expressive; primitives are cleaner to render and lighter at
  rest. Lean: support freehand path first; primitives are a later affordance. Decide the
  at-rest representation.
- **Coordinate normalization.** Strokes are captured in page-px (like live pins). Reuse the
  px→% normalization (`lib/coords.mjs` `pagePxToPct`, the same DPR-aware seal path pins
  use) so a drawing is stored as **%-at-rest** and renders responsively over the
  screenshot at any scale — matching the pin model exactly.
- **Screenshot composition.** Critical: pins are **NOT baked into the PNG** — they overlay
  from `session.json` at render time (`canvas.mjs` `buildMarker`, `%`-positioned; chrome is
  hidden during capture via `capture-mode`). A drawing must follow the *same* rule: store
  the shape, render it as an SVG/overlay layer over the screenshot in the shared canvas
  module, NOT rasterize it into the PNG. Confirm an SVG overlay scales cleanly with the
  `%`-positioned wrapper.
- **Comment input reuse.** The composer (`inject.js` `.cmt-*`, `renderPopover` composer
  branch) already does auto-grow textarea + category chip + send. For a drawing, the same
  input laid out differently (anchored to the shape's bounds rather than a pin tail). The
  note is *optional* for a drawing (a bare circle with no text is valid feedback).
- **Save / exit gesture.** "Save to exit the mode." Define what seals a drawing: explicit
  save, or tool-toggle-off. One drawing per activation, or multiple strokes grouped into
  one feedback record?
- **Data model.** Smallest change: `type: 'drawing'` on the feedback record with a `shape`
  payload (`{ kind, points[]|bounds, strokeWidth, color }`) plus the shared fields (note,
  category, author, status). Existing records default to `type: 'text'`.
- **Render in review.** Heterogeneous cards in the sidebar (`comments.mjs` `buildCard`) — a
  drawing's card shows a thumbnail/summary instead of a pin number. The marker loop in
  `canvas.mjs` branches on `type`.

**Done when.** A written feasibility verdict (confidence level), a recommended at-rest
shape representation, the concrete integration points (capture layer, normalization,
screenshot-overlay render, composer reuse, `type` model), and the open questions — written
to also serve as a **design requirement for Claude Design**. Not an implementation.

**POC RESULT (2026-05-31): FEASIBLE — high confidence on all four mechanics.** Throwaway
POC validated against the real overlay/capture harness (`scripts/spike11-poc.mjs`,
gitignored). The risky parts reuse the exact seams pins already ride on — nothing new
invented.

- **Stroke capture in shadow DOM ✓** — a transparent veil cloning `.placement-cursor`
  (`pointer-events:auto`, `cursor:crosshair`, `touch-action:none`) captured 24/24 pointer
  points; the page's own pointer handler fired **0 times** (the `chrome` `stopPropagation`
  boundary holds); deactivating removes the veil and fully restores page scroll/interaction.
- **Coordinate round-trip ✓ — 0.00 px error, and DPR-invariant** (re-validated at DPR=2:
  `maxPctDelta = 0`). Reuses `lib/coords.mjs pagePxToPct` unchanged; `yPct` correctly uses
  `docHeightCss = shotHeight/dpr` so off-fold strokes land right.
- **Overlay-not-baked ✓** — screenshot sampled under a stroke returned the page's own pixel
  (no ink baked in). Renders as `<svg viewBox="0 0 100 100" preserveAspectRatio="none">` +
  `<path>` in `%`-coords + `vector-effect="non-scaling-stroke"`; %-bbox identical to 4
  decimals across 1280/640/320 px. **SVG decisively over canvas** (vector, responsive, no
  re-rasterize, hit-testable).
- **Shape model ✓ — recommend freehand path first.** At-rest weight: freehand 402 B/24 pts,
  RDP-simplified (ε=0.4%) 214 B/12 pts, rect 81 B. Recommend freehand stored
  **RDP-simplified on seal**; primitives (rect/ellipse/arrow) later, sharing a `bounds`
  render path.

Recommended at-rest shape (`type:'drawing'`): `shape:{ kind:'path', paths:[[[xPct,yPct],…],
…], bounds:{xPct,yPct,wPct,hPct}, strokeWidth /* css px, non-scaling */, color }` + shared
fields; `note` **optional** (bare circle is valid); `xPct,yPct` = centroid so existing
pin-keyed code (focus/scroll) still works; `paths[][]` makes multi-stroke = one record free.

Integration points (all existing seams): `inject.js` draw mode beside `setPlacementMode` +
a `.draw-layer` under `pinLayer` (hidden by `capture-mode`) + composer anchored to
`shape.bounds`; `lib/capture.mjs` new `__designQA_createDrawing` binding (px → % at seal);
`lib/coords.mjs` **no change**; `console/ui/canvas.mjs` `buildMarker` branches on `type` →
SVG (artifact gets it free via the shared renderer); `console/ui/comments.mjs` `buildCard`
shape thumbnail.

Open questions: scroll-during-stroke is impossible by design (veil capture +
`touch-action:none`) — off-fold strokes need a product decision (pre-scroll / pause-resume),
not a blocker; explicit Save vs. tool-toggle-off as the seal gesture; confirm N pen cycles =
one `paths[][]` record (the lean).

---

## Spike 12 — DOM-element inspector feedback *(post-DesignOS, 2026-05-31) — RESEARCH ONLY*

**Framing.** The third feedback kind in the platform reframe: instead of a free pin or a
free drawing, the reviewer **selects a specific DOM element** and attaches feedback to it.
Shares the `type` discriminator and the comment input with the other kinds.

**Question.** Can the overlay let a reviewer hover/select a live DOM element — drawing a
precise outline rectangle around it and capturing a short, human element name — then attach
a comment via the same input, persisting and rendering like other feedback?

**Why it matters.** "This *button*," "this *card*," "this *input*" is often the most precise
thing a reviewer can say. Anchoring feedback to an element (not a free coordinate) makes the
engineer's "which thing?" unambiguous, and the captured element name is a breadcrumb the
engineer recognizes.

**What to probe.**

- **Pick mode.** Hover highlight + click-to-select, modeled on placement mode:
  `document.elementFromPoint(x, y)` under the cursor, draw a highlight rectangle from the
  element's `getBoundingClientRect()`, click to lock. Must skip the overlay's own shadow UI
  (the existing click-outside / `e.target === host` boundary logic applies).
- **What to store — deliberately lightweight.** Per the existing **Spike 3** decision, we do
  NOT invest in durable/resilient selectors. Store: the **bounding box as %** (so the
  outline renders over the screenshot at rest, like a drawing's bounds) + a **shallow
  descriptor** for the human name (tag + nearest test-id/aria-label/visible-text + maybe a
  short class hint). The screenshot is canonical; the descriptor is a label, not a
  re-find key. Decide whether to keep *any* selector at all or just box + name.
- **Outline render in review.** The stored bounding box renders as an outline rectangle
  over the screenshot (`canvas.mjs`, `%`-positioned wrapper) — same overlay-not-baked rule
  as pins and drawings. The element name shows on the card and/or a small label on the box.
- **Comment input reuse.** Same composer as a pin, anchored to the element box. Note is
  expected here (the element selection is the *target*; the note is the *feedback*) — but
  decide if a bare element selection with no note is valid.
- **Relationship to drawing.** An element selection is essentially "a rectangle the system
  drew for you from a real element," vs. a drawing being "a shape you drew freehand." Worth
  deciding if they share a `bounds`-based render path with different provenance, or stay
  distinct `type`s. Lean: distinct `type` (`'element'` vs `'drawing'`) so review can label
  them differently, even if they share rendering primitives.
- **Data model.** `type: 'element'` with an `element` payload (`{ bounds: {xPct,yPct,wPct,
  hPct}, name, descriptor? }`) plus shared fields.
- **Edge cases.** Elements larger than the viewport / scrolled partly off; overlapping
  candidates under the cursor (depth selection?); SPA re-render between pick and screenshot
  (the box is stored at-rest from the capture moment — acceptable, screenshot is canonical).

**Done when.** A feasibility verdict + the recommended lightweight at-rest representation
(box + name, selector decision) + integration points (pick mode, highlight, box render,
composer reuse, `type` model) + open questions — written to double as a **Claude Design
requirement**. Not an implementation. Hard reuse of Spike 3's "no durable selectors" stance.

**POC RESULT (2026-05-31): FEASIBLE — high confidence on all four mechanics.** Throwaway
POC validated against the real harness (`scripts/spike12-poc.mjs`, gitignored).

- **Pick the element under the overlay ✓ — the crux risk is real and trivially solved.**
  With the veil's `pointer-events:auto`, naive `elementFromPoint` hit the **veil 6/6 times**.
  Fix (100% reliable): **toggle the veil's `pointer-events:none` for the single synchronous
  hit-test, then restore.** Resolved the true element on every target. Works through the
  closed shadow host; `elementsFromPoint` gives the full z-stack for optional depth-select.
- **Bounding-box capture + normalization ✓ — ~2.3e-13 px error (float noise), DPR=2 exact.**
  `getBoundingClientRect()` + scroll offset → normalize **both corners** through the existing
  `pagePxToPct`, derive `wPct/hPct` as corner deltas (shares pin denominators). Box is
  **scroll-invariant**; oversized/off-fold elements captured whole (full-page screenshot is
  canonical).
- **Overlay-not-baked ✓** — stored `%`-box renders as a positioned outline rect in the
  responsive `.screenshot-wrapper`; `left%` identical across 420/720/1024 px, pixel size
  grows proportionally. Same rule as pins; nothing rasterized into the PNG.
- **Lightweight descriptor ✓** — priority `aria-label → visible-text → placeholder → testId
  → nearest-testId → tag` produced recognizable names ("Create new project", "Email
  address", "signup-card"). Gotcha: an unlabeled input surfaced its **placeholder** ("Jane
  Doe") as the name — fine as a breadcrumb, but rank placeholder below testId or flag it.

Recommended at-rest shape (`type:'element'`): `element:{ bounds:{xPct,yPct,wPct,hPct}, name,
descriptor?:{tag,testId,text} }` + shared fields. **Selector decision: keep NO selector**
(hard reuse of Spike 3) — `bounds` is the only render input, screenshot is canonical; `name`
required, `descriptor` an optional shallow breadcrumb (drop aria/class/nearest-testId from
the *persisted* form — they only help *compute* `name` at capture).

Integration points: `inject.js` pick mode modeled on `setPlacementMode` + the
`pointer-events:none`-then-restore hit-test + highlight rect (existing `e.target===host`
boundary already skips our own UI); `lib/coords.mjs` thin `boxToPct` helper (⚠ note the
intentional `lib/` vs `console/lib/` duplicate — change both); composer/card reuse anchored
to the box; store threads `type` + payload (`createPin` / `__designQA_createPin`),
default `type:'text'`.

**Cross-spike synergy:** a `type:'element'` box and a rect-kind `drawing` are the *same*
`%`-positioned rectangle render — recommend a shared `buildBoundsBox(pct)` helper that both
call, keeping them **distinct `type`s** (so review can label provenance) while sharing the
rendering code.

Open questions: depth selection (topmost-real-element is reliable for v1; `elementsFromPoint`
enables dig-deeper later); placeholder-as-name ranking; SPA re-render between pick and
screenshot is fine (box stored %-at-rest, no re-find by design); bare element selection with
no note — recommend **allow** (mirror the temp-pin deferred-create/discard); container picks
may want an "expand to parent" affordance via the z-stack.

---

## Out of scope for spikes

The following are deferred per the planning conversation and should not be probed in this round:

- Responsive / multi-viewport capture flows
- Persistent multi-session history (a QA repository)
- Jira / Storybook integration depth (Figma compare is now **in scope** as Spike 10)
- Threaded replies on annotations
- Summary page contents in the artifact
- Commit gates between pin drop and pin persistence
