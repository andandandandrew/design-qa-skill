# Design QA Skill — Console Architecture (v2)

This document consolidates a planning conversation that significantly re-centers the
`design-qa` skill. It **supersedes specific decisions** in `design-qa-skill-spec.md`
(noted inline) and adds new research workstreams to `design-qa-spikes.md`.

It is the primary input for a phased implementation plan, which will be authored
separately before any code is pushed. Nothing here has been built yet except the
live-browser capture overlay (Phases 1–2 of the original plan).

---

## What changed, in one paragraph

The original design put everything on **one surface**: an overlay + inspector injected
into the live page, with the exported HTML artifact produced at `end`. Two realizations
moved the center of gravity:

1. A "screen" is not identified by URL — it's `URL + app state + scroll/viewport`.
   Pins anchor to a **captured screenshot**, not live DOM. So re-attaching pins to a
   live page to re-edit them is fundamentally unreliable (you can't reliably reproduce a
   form-validation error state by reloading the URL).
2. Therefore editing-after-capture must happen against the **frozen screenshot**, which
   is exactly what a review surface does. And annotating an *uploaded* screenshot (for
   React Native, or as a universal fallback) needs the same screenshot-based pin editor.

The result: a **localhost console** becomes the primary authoring + review surface, and
the live-browser overlay becomes an **optional capture accelerator** for browsable web
apps. Manual screenshot upload is the **universal path** that works for any medium.

---

## The reframing (load-bearing)

> **The console is the primary authoring + review surface. The live-browser overlay is
> an optional capture accelerator for browsable web apps. Manual screenshot upload is the
> universal path that works for any environment.**

Everything — captured or uploaded — converges in the console as "an image with pins on
it." The console's pin-on-image editor is built **once** and serves review,
screenshot-side edits (resolve / move / delete / reorder), and manual-screen authoring.

**Supersedes** the original spec's "One UI surface — overlay + inspector coexist in the
browser window. No second window, no separate dashboard tab." There is now deliberately a
second surface (the console), served over localhost.

---

## Lifecycle of a screen

- **Create / edit pins: live-only, current-state-only** (browser path). You add or edit
  pins on the page as you're looking at it; pins anchor to *that* visual state.
- **A screen freezes when you leave it or click "Done."** Two distinct events that nearly
  collapse in practice:
  - **Freeze the screenshot** — must happen the instant the live view changes
    (navigation), or the visual is lost forever.
  - **Mark "Done"** — the designer's editorial "I'm finished with this one," preparing it
    for the artifact. An explicit button.
- **After freezing, no live editing.** All post-freeze operations (resolve, move pin,
  delete, reorder, and *adding* pins to a manual/uploaded screen) happen **in the console,
  against the frozen screenshot.**

This dissolves the old "navigate back to the URL to re-edit" path entirely — there is no
revisit-URL behavior to fix, because re-access is always via the console.

**Supersedes** the original "Capture model" insofar as capture is no longer the only way a
screen comes into being (manual upload also creates screens), and sealing is now tied to
explicit Done + view-change freeze rather than only navigation/`capture` transitions.

### "Save feedback" / Done — the explicit seal (BUILT 2026-05-27)

The "Done" button above got a concrete shape, so a designer never has to navigate away
just to seal a screen:

- **A "Save" button in the overlay toolbar, alongside "+ New screen."** It seals the
  current screen (fresh full-page screenshot + `sealView` + %-at-rest normalization) and
  pushes it to the console as an editable screen — reusing the seal half of the existing
  `startNewView` machinery (the console live-refreshes via SSE on persist). Shipped as the
  `__designQA_sealCurrentView` binding (`capture.mjs`) — the seal half *without* opening a
  new view.
- **It does NOT end the session.** The browser stays live; the designer keeps working
  (navigate elsewhere, start new screens). It is per-screen, not per-session.
- **A confirmation makes the one-way nature explicit.** Worth knowing: **native
  `window.confirm`/`alert`/`prompt` are auto-dismissed by Playwright** (no dialog handler),
  so they're unusable inside the capture overlay. The confirm is therefore an **inline
  confirm bar rendered in the overlay's shadow DOM** ("Lock this screen? You won't be able
  to add or edit it here — finish in the console."), dismissable via Cancel / Esc / another
  action. (Native dialogs *do* work in the console — it's the user's normal browser — which
  is why manual-upload naming below can use `window.prompt`.)
- **Closing the browser seals too (sibling fix, shipped).** An abrupt browser close used to
  preserve pins but leave the active screen *unsealed* (locked/read-only in the console).
  Now `capture.onClose` awaits `finalizeActiveViews()` (rewritten to seal from the *store*,
  not live pages, so it works after the browser is gone) before exiting, so a close commits
  cleanly. Build-check held: `findViewByUrl` skips sealed views (`session.mjs:135`), so the
  next pin after a Save starts a fresh screen rather than reattaching.
- **Overlay UI rework (user-driven, same change):** the resting toolbar is now an
  always-visible labeled **verb bar** (Comment / Save / New + a chevron); the chevron now
  only expands/collapses the Screens/Pins *lists*. Previously the Save/New actions were
  buried inside the expanded panel.

---

## The two surfaces

### 1. Capture overlay (live browser) — accelerator, optional

The existing injected overlay (closed Shadow DOM, pin layer + chrome, deferred-create
composer). Used only for **browsable web apps** to place pins quickly against the real
page. Freezes a screenshot per screen. This is the work already done in Phases 1–2 and
survives the pivot. Its job narrows to: capture screens + place initial pins, then hand
off to the console.

### 2. Console (localhost) — primary authoring + review

A **buildless vanilla** web app (structured render modules / web components, zero build
step) served by the daemon over a localhost URL, opened in the user's normal browser.

Decided as buildless because the barrier to entry must be low for *all* personas — not
just designers who boot localhost servers comfortably, but also non-technical PMs who
just need to view and check off comments. Upgradeable to a framework later if interactivity
demands it; the `session.json` format stays portable so a standalone/hosted app remains a
future option.

The console:

- Renders **live** from `session.json` + screenshots (the daemon owns and serves them).
  Updates as screens freeze and as edits happen — no artifact recompile needed during the
  session.
- Is the home of the **pin-on-image editor** (place/move/delete pins on a frozen
  screenshot), **resolve / check-off**, reorder, and **manual screenshot upload → new
  screen**.
- Lists **all sessions in the working directory**, not just the active one → historical
  lookback for free.

**Serving mechanism:** the daemon (already a Node process owning `session.json` and a Unix
socket) runs a small localhost HTTP server: static console assets + a session/data
endpoint + screenshot files, with SSE or polling for live updates. (See new Spike C.)

**Why two surfaces and not one app-frame embedding the target site (rejected).** The
tempting "single frame" — load the QA target inside our own app shell (iframe) and put
everything in one window — is blocked in the general case: real apps send
`X-Frame-Options: DENY` / CSP `frame-ancestors 'self'`, and cross-origin embedding also
severs our ability to inject the overlay, read pin coordinates, and screenshot the page.
For a tool meant to QA arbitrary running apps (often behind auth/SSO), framing the target
is unreliable. So capture stays as injected chrome *in the live page* (what we have), and
review/authoring lives in a *separate* localhost console. Two surfaces is a constraint, not
a preference — do not re-litigate as "just iframe it."

---

## Capture modes

Config carries both a free-form `stack` (for the record + future code-side handoff) and a
functional `captureMode`:

- `browser` — drive a headed Chromium, place pins on the live page (web apps).
- `manual` — bypass the browser entirely; create screens by **uploading a screenshot** and
  annotating it in the console.

`manual` is **always available as a fallback** regardless of stack — for React Native,
non-browsable environments, or when the browser path is unavailable (e.g., out of tokens).
React Native defaults to `manual`; web defaults to `browser` with manual on standby.

**Manual upload — BUILT (Phase 5, 2026-05-27).** The console's sidebar **+ Add screen**
(enabled only when served by the live session server) picks an image, asks for a name via
`window.prompt`, reads the image's intrinsic dimensions client-side, and POSTs the raw
bytes to `POST /api/upload`. The server's sole writer (`SessionStore.addManualView`) writes
the file into the session's `screenshots/` dir and creates a `source:'manual'` view
(`url:null`, sealed at birth, viewport from the client dims), which is immediately
console-editable (never browser-locked). Because the canvas's placement math is already
`%`-of-rendered-image (Spike B `imagePxToPct`), a manual screen reuses the exact
sealed-screen pin path (`createPin` → `createPinPct`) with **no canvas changes** — proving
the "%-at-rest unifies both paths" decision in practice.

---

## Data model

`session.json` remains the **source of truth**. Console renders live from it; edits mutate
it directly; the artifact is a frozen export of it.

**Pin coordinates: percentage-of-screenshot at rest.** Captured screens currently store
page-pixel `x/y` and convert to `%` only at export; manual uploads have no page, only an
image. Normalizing **everything** to `%`-of-screenshot unifies the two paths and makes the
resizable-sidebar rescale concern fall out for free. (To be validated in practice; chosen
as the default.)

**Pin gains fields:**

- `author` — stamped at creation from config identity. Forward-compatible with a
  git-shared, multi-author future without building any of it now.
- `category` — already reserved in the schema (fixed taxonomy from v1 spec).

**Screen gains:** `source: 'browser' | 'manual'`, and for manual screens the uploaded image
becomes its screenshot.

---

## Comment-card layout & resolve UX *(BUILT 2026-05-28)*

The console's right pane (and, by inheritance, the exported artifact's right pane) was
reshaped to mirror Figma's comment-card pattern. Reference screenshots live in
`_qa/figma-comment-ui/Screenshot 2026-05-28 at 9.13.57 AM.png` (card) and
`9.14.15 AM.png` (toast).

**Card layout** (`scripts/console/ui/comments.mjs`):

- **Top-left:** deterministic-color circle with the author's initial (`A`, `J`, `?` for
  null author). Color derives from a djb2-ish hash of the name so a given author looks
  the same across sessions.
- **Top-right:** small category dropdown (the `⋯`-overflow slot Figma uses for an
  ellipsis menu — repurposed here as the most useful overflow) followed by a circular
  **Mark as resolved** check button. The category control fades in on hover (or stays
  visible when a category is set) so unset cards read clean.
- **Breadcrumb line:** `#<index> · <screen name>`.
- **Byline line:** `<author> · <relative time>` (`5m ago` / `2h ago` / `3d ago` /
  `May 3` falling back to a localized short date).
- **Note body:** click to edit (in-place textarea, commit on blur or Cmd/Ctrl+Enter,
  Esc cancels — unchanged from before).

**Resolve UX** (`scripts/console/ui/toast.mjs`):

- Clicking the check button flips the pin to `status: 'resolved'` and shows a
  **bottom-centered toast** "Comment resolved" with an **Undo** button and a close
  `×`. Auto-dismisses in 6s; paused while hovered.
- **No completion-note prompt** (originally there as a `window.prompt`; removed per
  user feedback because the friction outweighed the value). The `pin.resolvedNote`
  field stays in the schema as a back-compat tombstone but is never set anymore.
- Clicking the filled check on a resolved comment silently unresolves (no toast —
  the user's intent is unambiguous when they click an already-on affordance).

**Cross-session editing — lookback is fully writable.** The original Phase-6 design
had `?session=<basename>` open archived sessions read-only with a LocalStorage resolve
layer; user feedback (2026-05-28) reshaped this so an archived session opened from the
switcher exposes the **same** affordances as the live session (add pin, edit note,
move, delete, resolve, manual upload). The capture-overlay-locks-the-active-view rule
only applies to the live owned session's currently-capturing screen — archived
sessions have no unsealed views, so all are console-editable. Server-side, the same
`/api/mutate` and `/api/upload` endpoints accept `?id=<basename>` and route to a
lazily-loaded `SessionStore` cached per basename. **The writer rule was generalized**:
"one writer per session AT A TIME" replaces the original "one writer per session." An
ended session has no other writer, so the current live server safely authors edits
into it. Two concurrent editors of the same archived session would last-write-wins —
called out as a v1 limitation; the realistic scenario (two live session-servers in the
same dir both editing the same third archived session) is rare. See
[[architecture-decisions]].

The only visual cue distinguishing live from lookback in the topbar is the badge: a
pulsing `● Live` while a capture browser owns an unsealed screen vs. a static
`⌛ Archived` when the open session is sealed. Everything else — switcher, panes,
gestures — is identical.

---

## Configuration & initialization

The expected usage: **one working directory per client/project**, kept local and
historical on the user's machine. Whether they version-control it with git is their choice
(the config is plain JSON, no secrets; committing author name is the user's call).

**First run in a new directory triggers an agent-driven init** — prompts in the terminal
(simple, no UI dependency; works for every persona since everyone is already in Claude
Code). The console can later expose a settings editor for changing these.

A local config file (e.g. `design-qa.config.json` at the directory root) holds:

- **Project / client name**
- **Stack** (free-form: "React web", "React Native", …) + derived **`captureMode`**
- **Author identity** (name; email optional) — flows into every comment's `author` field

Sessions accumulate under the working directory (as today, `design-qa-sessions/`), and the
console reads all of them for historical lookback. Distinguish clearly:

- **Where the app code lives:** inside the skill (served by the daemon). No clone/install.
- **Where session data accumulates:** the working directory the user chose.

**Supersedes** nothing in the v1 spec directly, but adds the init/config workflow the v1
spec did not contemplate.

---

## Export

- **Live view = the console**, rendered from `session.json`. No proactive recompile of
  `artifact.html` during the session.
- **`artifact.html` = an explicit, versioned export** — a frozen, self-contained,
  portable snapshot (e.g. `artifact-20260526-v1.html`) handed to engineers. The user can
  keep iterating and re-export later.

**Supersedes** the v1 behavior of building the artifact automatically at `end`. Export is
now a deliberate, versioned action triggered from the console (and/or terminal).

**Directory export (decided 2026-05-27, post-demo).** Export a small **directory**, not
just a single `artifact.html`: the HTML + `session.json` (+ `screenshots/`) + the recorded
Playwright script (see Spike 8). Opening the directory locally unlocks the **full
console-style interactivity** — filter, search categories, resolve/check-off — because the
data and assets live beside the HTML. A single inlined file stays a convenience fallback.
The in-progress artifact-parity build (shared-renderer, LocalStorage resolve) is
forward-compatible: swapping resolve persistence to the directory's sidecar JSON later is a
store-adapter change. See `design-qa-spikes.md` Spike 7 (revised) for detail.

**Phase 7 BUILT (commit `abad681`, 2026-05-28).** Versioned export ships as a user-facing
**Share** action (button relabeled from "Export" at user request — same underlying file
names). Two pieces:

1. **User-facing "Share" flow.** Clicking Share opens a two-option chooser modal:
   - *Share as single file* → one self-contained `artifact-YYYYMMDD-vN.html`.
   - *Share as bundle (zip)* → `artifact-YYYYMMDD-vN.zip` containing `artifact.html` +
     `session.json` + `screenshots/` + a one-line `README.md` noting the empty
     Playwright-script slot (Spike 8).

   Cancel | Next; Next is focused so Enter confirms. On Next the console fetches
   `POST /api/export?kind=single|bundle` (which returns BYTES with `Content-Disposition`,
   not paths) and hands the blob to **`window.showSaveFilePicker`** on Chromium — a real
   native OS save dialog with a kind-appropriate type filter. Safari/Firefox fall back to
   `<a download>` (browser default folder). Picker cancellation (`AbortError`) is silent.
   Toast on success.

   **Load-bearing UX decision (do not regress):** export-style actions present an OS save
   dialog, not raw paths. The original Phase-7 cut showed two `<sessionDir>/...` paths in
   a modal with Copy buttons; the user rejected it as engineer-think ("I don't understand
   how to use the copy function"). Any future Share/Export/Download surface must follow
   the same pattern. The pivot is recorded in
   `~/.claude/projects/.../memory/architecture_decisions.md`.

2. **Silent project archive.** `exportSession({ sessionDir, session })` in
   `artifact/build.mjs` continues to write a local copy on EVERY share action regardless
   of the chosen kind:
   - `<sessionDir>/artifact-YYYYMMDD-vN.html` — versioned self-contained file. `vN` scans
     same-date `artifact-*-v*.html` siblings and takes max+1.
   - `<sessionDir>/exports/<YYYYMMDD-HHMMSS>-vN/` — the directory bundle (artifact.html +
     session.json + screenshots/ + README.md). `vN` matches the versioned file.

   The bundle's `README.md` is intentionally minimal ("a future Playwright-script slot
   (Spike 8) not yet written") so the shape is documented before the script lands.

   For the user, this archive is invisible — only the save-dialog destination is surfaced.
   The local copies exist for project record and to make the Spike 8 / sidecar-JSON
   store-adapter swap a small change later.

   The bundle ZIP is built on-the-fly with the OS `zip` command (`spawn('zip',
   ['-r','-X','-q','-','.'], { cwd: bundleDir })`, stdout streamed to a buffer). No
   project dependency added; relies on Info-ZIP being present on macOS/Linux.

**Gated to the owned-live session this pass.** Lookback (`?session=<basename>`) keeps the
Share button disabled with the tooltip "Switch to the live session to share." Sibling
export from lookback is a TODO — would route through the same `archivedStores` cache
pattern that cross-session mutate already uses (see writer-rule generalization).

**Two layers of "resolve":**

- **Designer-side** resolve/check-off in the console → persists to `session.json`.
- **Engineer-side** resolve in the distributed artifact → persists separately (the
  unresolved Spike 7 question: sidecar JSON vs. LocalStorage + re-export). Still open.

**Shared-renderer artifact parity — BUILT (2026-05-27).** The exported `artifact.html` no
longer has its own diverging renderer: it reuses the console's render modules
(`console/core.mjs` + `ui/*` + `lib/*`). `core.mjs`'s `createApp({store, mounts, options})`
owns state/render/filter-sort/selection; affordances are gated by `options`
(`canPlacePins` / `canEditNotes` / `canResolve` / `canDelete`). The console enables all of
them; the artifact enables `{ canResolve: true }` only — engineers view + filter + sort +
see categories + resolve (with an optional completion note), but cannot add/move/delete/
edit-note (those stay designer-side). `build.mjs` inlines the module sources via an import
map of `@dqa/*` → base64 `data:` URLs (so the graph loads from `file://`), embeds the
session with screenshots as `data:` URLs, and backs it with an `ArtifactStore` whose
`resolvePin` persists to **LocalStorage keyed by session id** (the still-open engineer-side
layer above). That choice is forward-compatible with directory export: LocalStorage →
sidecar JSON is a store-adapter swap.

---

## What stands from the v1 spec

- Percentage-based pin positioning (now generalized to all screens, see Data model).
- Designer judgment over inference — the skill does not auto-detect state changes or group
  screens; the designer demarcates ("+ New screen", Done, manual upload).
- The screenshot is the canonical artifact; selectors/DOM hints are placement convenience.
- Disposable but resumable — sessions ship an artifact; the skill is not a database. (The
  console adds *historical lookback* over the local sessions directory, which softens this
  slightly but does not make the skill a server.)
- Minimal terminal command surface — lifecycle + init in the terminal; authoring/review in
  the surfaces.

---

## Open research workstreams (new / evolved spikes)

These extend `design-qa-spikes.md`. To be probed during planning.

### Spike A — Console UI workflows & affordances *(the big new one)*

Now that the console is a primary **authoring** surface, not just review, what UI does it
actually need? To enumerate during planning:

- Pin-on-image editor: place, move, delete, edit note, set category — on a frozen image.
- Navigation between sessions and between screens within a session.
- Manual screenshot upload → new screen → name it → annotate.
- Resolve / check-off + optional completion note; visual state on both the sidebar card and
  the on-image marker.
- Reorder screens / pins; sort & filter (by status, category, author, screen).
- Resizable layout (the original Phase-5 ask) — trivial under %-positioning.
- The toolbar / affordance vocabulary that makes this legible to a non-technical PM.
- How the console reflects the *live* session while the designer is still capturing in the
  browser (real-time additions appearing).

**Done when:** we have a sketch of the console's screens, primary affordances, and the
minimum toolbar set, enough to phase the build.

### Spike B — Manual upload & coordinate model

How uploads create screens; how pins are placed as `%`-of-image; how this reconciles with
browser-captured screens so both are uniform in `session.json`. Validate the
"%-at-rest" decision.

### Spike C — Localhost serving mechanics

How the daemon serves the buildless console + data + screenshots; live-update transport
(SSE vs. polling); port selection; opening the user's browser; lifecycle (per-session,
disposable). Security: bind to localhost only.

### Spike 7 (evolved) — Engineer-side completion persistence

**Directory export SHIPPED (Phase 7, commit `abad681`, 2026-05-28)** as a `.zip` bundle —
`artifact.html` + `session.json` + `screenshots/` + a README noting the empty
Playwright-script slot (Spike 8). The sidecar-JSON resolve question is still **open**: the
shipped artifact's `ArtifactStore.resolvePin` still writes to **LocalStorage** keyed by
session id. Moving engineer-side resolve to the bundle's sidecar `session.json` is the
store-adapter change the design was built to allow — not yet done.

### Further spikes (post-demo, 2026-05-27) — backlog, not scheduled

Captured after a principal-engineer demo; full write-ups in `design-qa-spikes.md`. Not to
be built now — recorded so the build can pick them up later.

- **Spike 8 — Interaction recording & replay.** Record the path the QA person took to reach
  a state and emit it *both* as an executable Playwright script *and* a human-followable
  step list, so an engineer can run it or follow it. Hard part: auth/preconditions in a
  portable script. **Has a reserved slot in the Phase-7 bundle** (the README explicitly
  notes "a future Playwright-script slot (Spike 8) not yet written") — when this lands,
  the script lives alongside `artifact.html` in the zip. Still requires research + UX
  design; see `design-qa-spikes.md` §Spike 8 for the open questions.
- **Spike 9 — Post-change regression diff (research only).** Given a recorded path + the
  resolved/open comments, re-run after code changes and diff what changed vs. what was
  commented/resolved. Explicitly assess approaches (visual / structural / LLM-judged) before
  committing. Depends on Spike 8.
- **Spike 10 — Compare-to-Figma (LLM-driven).** For reviewers who sense something's off but
  can't name it: link a Figma node URL per screen (manual), pull the frame via Figma Console
  MCP + desktop bridge, and have an LLM compare it to the screenshot/state to suggest or
  generate pin descriptions (human-accepted, never silent auto-pinning).

---

## Phase 8 — UI consistency & Figma-parity *(deferred, 2026-05-28)*

Captured after the comment-card and toast/Undo redesign (which were folded into Phase 6
as in-flight feedback). Phase 8 is the **dedicated UI consistency phase** that runs
**after the functional phases finish** (Phase 7 export remainder, any further functional
work), so aesthetic changes don't muddy diffs that should read as functional. Reference
screenshots live in `_qa/figma-comment-ui/`. Nothing in this phase is built yet.

**Goals**

1. **Sidebar parity with Figma.** The right comments pane was reshaped to match Figma's
   comment-card layout (avatar / breadcrumb / byline / note + circular resolve button +
   bottom toast w/ Undo); the rest of the chrome still feels generic. Phase 8 brings the
   left (Screens) sidebar and the right (Comments) sidebar into the same family — see
   `_qa/figma-comment-ui/Screenshot 2026-05-28 at 9.21.01 AM.png` (left open),
   `Screenshot 2026-05-28 at 9.21.06 AM.png` (left collapsed pill), and `9.21.17 AM.png`
   (right pane).
   - **Collapsible panes** (both sides). When collapsed, the left side becomes a small
     pill anchored top-left with the project name and an expand chevron, giving the canvas
     full width. The right side likewise collapses to a thin gutter.
   - **Section-headed left sidebar.** Project name + dropdown at the top with a small
     collapse-toggle button on the same row; "Pages" / "Layers" section headers; flat
     hierarchical list of screens with visual grouping (no hard borders between adjacent
     screens — only between section groups). The Phase-2 sidebar today renders one bordered
     card per screen, which reads heavier than Figma's flat list.
   - **Search + filter + overflow in the right sidebar.** Add a comment-search box, a
     filter glyph button, and an overflow `⋯` menu (sort / status filter live here) at the
     top of the comments pane. The current filter selects move into that menu.
   - **Flatter comment list.** Drop the per-card border + background; let the avatar +
     metadata + note stack stand on its own; rely on hover for subtle highlight and the
     active state for the selected pin.

2. **Capture overlay (browser inspector) ↔ console visual parity.** The in-page overlay
   (`overlay/inject.js`) and the console currently have their own visual languages built
   from the same tokens but applied differently. Phase 8 unifies them so a designer
   switching between the live capture browser and the console doesn't feel two products.
   - Share a token file across both surfaces (the overlay can't `<link>` the console's CSS
     because it lives in shadow-DOM inside the captured page, but it can copy the same
     custom-property set into its shadow root).
   - Align the verb bar, composer pill, marker, and inspector list to the console's
     Figma-style language: same avatar/initial circles, same byline format, same
     resolve-button shape.

**Why now (i.e., why not before Phase 7)**

Phase 7 (versioned + directory export) only needs the existing comment renderer — the
shared modules already power the artifact, so any Phase-8 visual change to those modules
flows into the export for free. Doing visual parity AFTER Phase 7 lets us ship the export
artifact at the new visual baseline in one go rather than re-exporting after polish.

**Out of scope for Phase 8 itself**

The capture-overlay rewrite, if it's larger than restyling, can split into its own
follow-on. Functional changes (new gestures, new authoring affordances) don't belong here —
this phase is *pure visual + interaction-shape parity*. If something starts to require new
data fields or new endpoints, it belongs in a different phase.

---

## Disposition of current code under this pivot

- **Bugs #1 (canvas pin loss) and #3 (composer pill):** already fixed; capture-overlay
  fixes that survive untouched.
- **Bug #2 (revisit sealed URL):** *not* fixed and *not* to be fixed — the console replaces
  the need; the revisit-URL path is being removed from the model.
- **Auto-seal-on-navigation, auto-build-at-end:** to be reworked into freeze-on-view-change
  + explicit Done + explicit versioned export.
