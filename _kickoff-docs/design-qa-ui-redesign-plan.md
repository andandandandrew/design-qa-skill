# Design QA — Feedback-platform UI redesign (expanded §6) — ENRICHED PLAN

**Status:** ENRICHED FROM THE DESIGNOS SPEC (2026-06-01). The DesignOS feedback-collection
**application** is now fully built + documented + prototyped; this plan is enriched directly from
it. It supersedes the earlier scaffold and **expands/supersedes** `design-qa-feedback-platform.md`
§6 (which scoped only overlay position).

**Authoritative source (read these in DesignOS — `/Users/andrewfrank/code/design-gen/DesignOS`):**
- `src/apps/feedback/fixture.jsx` — the **Collection Fixture** (our overlay), fully built.
- `src/apps/feedback/preview-app.jsx` — the **Preview App** (our console), fully built.
- `src/apps/feedback/sessions-index.jsx` — `PaSessionsIndex`, the **home page** (DEFERRED, see §1.1).
- `src/apps/feedback/hub-content.jsx` — the **capability spec table** (`HUB_FIXTURE_SPEC` /
  `HUB_PREVIEW_SPEC`) + the "How it connects" daemon note + composed-from inventory. The cleanest
  functional contract; cite it.
- Standalone runnables: `Feedback - Collection Fixture.html`, `Feedback - Preview App.html`,
  `Feedback Collection.html` (the hub). Launch them to see live behavior.
- The design is **mocked + standalone** (DesignOS rule FC2) and **composes the canonical DesignOS
  library** (FC3) — so it shows *intended visuals + behavior*, not our data wiring. We adopt the
  **spec**, implemented against our buildless/vanilla + overlay code (as we did for the token re-skin).

Branch: `6/feedback-platform-ui-redesign`. Verify each current-state claim against
`design-qa-interface-inventory.md` + live code before cutting.

---

## 0. The architecture confirmation that de-risks everything

The hub's **"How it connects"** note (`hub-content.jsx` `HubConnects`):

> *"The two surfaces never talk directly. The fixture writes a feedback bundle — comments, the
> recorded path, the screenshot — and a small local daemon streams it into the preview app's
> session."* — with the literal bridge `…/design-qa -session "Northwind review" -screen "Pricing"`.

**This is exactly our existing architecture** (daemon + per-session server + `session.json`, see
`design-qa-console-architecture.md`). The DesignOS prototype only *stages-and-flushes* in the
fixture because each surface runs standalone in the demo (no daemon). **So this redesign is almost
entirely presentation + interaction** — toolbars, modes, cards, flyout, empty states. It does **not**
require a new data model. The one genuine behavioral question is what "Send to preview" *means* in
our continuously-persisting world — see §5 (Decision D1).

---

## 1. Scope summary

| Area | What | New vs change | Build-now? |
|---|---|---|---|
| **A. Collection fixture (overlay)** | Vertical right-dock toolbar; cursor default tool; status-dot "totem" + flyout (recording controls fold in, banner gone); Send-to-preview (modal→flush→clear); comment **region** drag; element-inspect; CommentComposer/Bubble parity | Mostly change + a few new | **BUILD-NOW** |
| **B. Preview app (console)** | Bottom toolbar cursor/comment/draw; comment **region** drag + draw on canvas; empty states (empty screen → upload OR daemon prompt); screen ⋯ menu (duplicate + delete); add-screen name modal; resolve-all; sidebar collapse | New + change | **BUILD-NOW** (minus deferred bits) |
| **C. Comment components** | category + **attachments** + **reactions** on bubbles; composer/bubble parity across surfaces | Change/audit | **BUILD-NOW** |
| **Home page / sessions index** | `PaSessionsIndex` table; cross-session switch; new-*session* flow | New surface | **DEFER → cutover** |

### 1.1 The deferral lens (DECISION 2026-06-01) + what it defers

**Principle (user):** a spec feature does not automatically belong in this phase. If it (a) leans on
buildless-expensive capabilities (routing, multi-view nav, cross-session state) and (b) the
standalone Vite/React/TS cutover would naturally provide it, **defer it to the cutover** — building
it twice is the waste. Triage each feature `BUILD-NOW` vs `DEFER-TO-CUTOVER`; surface new deferral
candidates for a quick call rather than silently building them.

**DEFERRED to the cutover (built in the new app, not the buildless console):**
- **Sessions index / home page** (`sessions-index.jsx` `PaSessionsIndex`; the preview's
  `view === "index"` branch, the index⇄session page transition, the `assets`→`goToIndex` nav).
- **Cross-session switching** — the fixture totem flyout's "Switch session" submenu *action*; the
  preview's home navigation; session-name dropdown switching.
- **New-*session* creation** — the totem "New session…" and the home "Create"/name-session modal.
  *(Creating a SCREEN inside the current session stays — see §3.)*

**Built anyway despite deferral (the design reuses their space):** the fixture's **status-dot totem
+ flyout shell** — because the flyout is also where the recording controls live. We build the totem,
the flyout container, and the idle "Collecting feedback" + target-session *display*; the
session-switch list inside it is a non-wired placeholder until the cutover.

---

## 2. Surface A — Collection fixture (`overlay/inject.js`)

Source: `fixture.jsx`. Current state: `design-qa-interface-inventory.md` §2.

### 2.1 Toolbar — vertical, RIGHT-edge dock
- **As designed** (`FxToolbar`): `FloatingCluster orientation="vertical"`, default
  `position:fixed; right:16; top:50%; translateY(-50%)` (right-center). Draggable anywhere;
  position persists; off-screen positions sanitized back to the default (`fxSanitizePos`).
- **Order, top→bottom:** `status-dot (totem)` · divider · `cursor` · `comment` · `draw`(edit icon) ·
  `inspect`(origin icon) · divider · `RecordButton` · divider · `Send`(upload icon).
- **Maps to our** `.toolbar` (today horizontal top-center). Carry over unchanged: grip drag
  (`onGripDown/Move/Up`, `setPointerCapture`), Node-side `STATE.toolbarPos` persistence
  (`__designQA_setUiState`/`getUiState`), `clampToViewport`. Change: axis → vertical, default anchor
  → right-center, add sanitize-on-load. **Note:** the design drags the *whole pill* (no separate
  grip handle — `onBarDown` ignores clicks on `button,[data-fx-control]`); decide whether to keep
  our explicit grip or adopt whole-pill drag.
- **Selected-tool state:** `IconBtn selected` = accent fill. Send = plain `IconBtn` (not accented).

### 2.2 Cursor default tool — NEW (4th mode)
- `mode` initial = **`cursor`** ("Browse · no feedback" — clicks pass through to the page).
- Mode model becomes `cursor | comment | draw | element`. Clicking the active tool toggles back to
  cursor (`onTool`: `m === t ? "cursor" : t`). Esc exits any tool → cursor.
- **Maps to:** today the overlay has no idle/default tool (modes are mutually exclusive toggles).
  Add `cursor` as a first-class, highlight-able default; it's the "no veil, no capture" state.

### 2.3 The four capture inputs (every input ends as a comment)
| Tool | Gesture | Produces | Our mapping |
|---|---|---|---|
| **Comment** | click → **point pin**; **drag → region box** | point pin OR `type:"region"` rect, both → composer | point = existing `text`; **region = NEW type** (§4) |
| **Draw** | drag to sketch | freehand red stroke (one color `oklch(.62 .22 25)`, width 3.5) + composer | existing `drawing` (align color/width) |
| **Inspect** | hover `[data-cap]` → accent outline + selector/dims chip; click → composer | `element` outline + selector chip + comment | existing `element` (our `describeEl`; never reads `input.value`) |
| **(all)** | composer requires a note | post → pin/outline persists | note-required already our rule |

- Veil: comment + draw dim the page (`oklch(.15 .01 250/.18)`); element shows hover outline only.
- Drag-vs-click disambiguation uses a `suppressClick` guard (trailing click after a drag must not
  drop a stray pin / dismiss the composer) — port the pattern.

### 2.4 Status-dot "totem" + flyout — folds in the recording banner
- **Totem** (`FxStatusDot`): an always-present accent ring + slow-blinking accent core = "Collecting
  feedback". Sits at the top of the toolbar. Click → flyout (`FxStatusFlyout`) opens to the side
  (left when docked right, right when docked left).
- **Recording is NOT shown on the totem** — it's shown by the **RecordButton going red**
  (`RecordButton recording`). (The fixture source comments mention a red-core variant but the
  shipped `FxStatusDot` stays idle-accent; treat the record button as the recording indicator.)
- **Flyout contents:**
  1. "Collecting feedback" header.
  2. **Target session row** → hover reveals "Switch session" submenu (session list + "New
     session…"). **Switching DEFERS (§1.1)** — build the row + target display; list is a
     non-wired placeholder.
  3. **When a recorded path exists:** "Flow · N steps" + numbered step list (action verb + label)
     + **"Preview spec"** (accent) + **"Discard recording"** (danger).
- **This replaces the standalone recording banner.** Our current `.rec-indicator` (fixed `top:64px`
  pill + steps timeline + discard, inventory §2d) is **removed**; its contents (`renderRecIndicator`
  logic, steps list, discard, preview-spec) move into the flyout panel. Supersedes old §6
  "banner → top." **The overlay gains a spec-preview** it didn't have (was console-only) — reuse the
  emit/preview logic; render in a Modal (`variant="informational"`).

### 2.5 Send to preview — replaces Done + New-screen
- **`Send`** (upload icon, bottom of toolbar) → **confirm Modal** ("Send to the preview app?",
  message: *"Sends this page's screenshot[ and N comments][ + the recorded path] to the preview app,
  then clears the page so you can start fresh."*) → on confirm: flush + **clear the page** (pins,
  steps, recording all reset).
- **Done and New-screen buttons are GONE** (resolves the prior ⛳ gate). The design has no New-screen
  button and no Done — the Send-and-clear loop replaces both: you collect on a page, Send, the page
  clears, you move to the next page/screen.
- **Reconciliation needed (Decision D1, §5):** in our world the daemon persists continuously and
  seals screens on navigation. "Send" must map onto seal/finalize + reset-overlay rather than a
  literal local flush. See §5.

### 2.6 Composer / read bubble / chrome (canonical components)
- **Composer** = `CommentComposer state="authoring"` — note (required) + **category** + **attachments**.
- **Read bubble** = `CommentBubble` — author, time, body, **category**, **attachments**, **reactions**
  (e.g. 👍), resolve toggle, close. Anchored beside the pin (`anchorCard` clamp).
- **Helper hint** bottom-left (mono, per-mode text). **Resolved count** bottom-right ("N/M resolved").
- **Toasts** = `Toast`+`ToastShelf` (center, `offsetBottom:84`); record start/stop + send confirmations.
- See §4 for the comment-component deltas (attachments, reactions) we don't have yet.

---

## 3. Surface B — Preview app (`console/*`)

Source: `preview-app.jsx`. Current state: `design-qa-interface-inventory.md` §3. The design has two
views — **`index`** (home, DEFERRED) and **`session`** (the three-pane, BUILD-NOW). We build the
session view; we **skip the index** and open straight into a session (as today).

### 3.1 Canvas bottom toolbar — cursor / comment / draw — NEW
- `BottomToolbar tools={["cursor","comment","draw"]}` floating bottom-center; cursor default,
  `cursorChev={false}`, `showPicker={false}`; active tool = accent.
- **Comment** mode: click screenshot → point pin; **drag → region box** (NEW). **Draw** mode: stroke
  (`%`-coords, `vectorEffect="non-scaling-stroke"`). No element/inspect tool here (element is
  overlay-only; consistent with our model).
- **Maps to:** today's console canvas has `#addPinBtn` + `#drawBtn` but no cursor default and no
  region. Add the cursor default + the region drag; adopt the DesignOS BottomToolbar styling
  (we already restyled the toolbar once — `bottom-toolbar.jsx` lineage).

### 3.2 Empty states — NEW (in-session, NOT home-gated → BUILD-NOW)
- **Empty screen** (screen exists, no image): *"Add an image to «title»"* → **"Add a screenshot"**
  button (file picker) · **or** divider · *"Paste this into Claude Code, then boot the daemon:"* +
  a code block `…/design-qa -session "«name»" -screen "«title»"` + *"It streams captured feedback
  straight into this screen."* — this is the boot-the-daemon path the user described.
- **Empty session** (no screens): *"Start collecting feedback"* / *"Add a screen to this session —
  then upload an image or boot the capture daemon."* + "Add a screen" button.
- **Maps to:** new — our console currently has no empty-screen/empty-session states. The daemon-boot
  prompt copy should match our real CLI invocation (confirm the exact `cli.mjs` syntax).

### 3.3 Screens list + session header
- **Screen row** (`PaScreenRow`): thumbnail + title + url; `n/m` resolved badge (green when all done);
  hover/selected → **⋯ menu: Duplicate screen** (optionally bring comments, via a confirm) **·
  Delete screen** (destructive confirm). Duplicate is NEW; delete we have (gated on `canDelete`).
- **Add screen:** `+` in the "Screens" section header + an "Add a screen" button → **name-prompt
  Modal** (`variant="form"`) → creates a named empty screen → drops into the empty-screen state.
  This is in-session screen creation — **BUILD-NOW** (distinct from new-*session*, which defers).
- **Session header:** `assets` icon (→ home, **DEFER** — drop or repurpose) · session name +
  chevron → **session-actions Menu: Resolve all comments · Delete session**. Resolve-all/delete-
  session are session-level — see Decision D2 (§5).
- **Sidebar collapse:** collapse → floating left pill + detached right panel. (Note: our console
  previously *removed* collapse; the design brings it back. Optional — flag in D2.)

### 3.4 Right pane + canvas comments
- **`RightSteps`** panel = Comments / Steps tabs (canonical), Share button (accent), search,
  Preview-spec when steps exist. Comment cards = `CommentCard` (select ↔ pin both ways, resolve
  rolls `n/m` + toast).
- **Canvas comment authoring** = `CommentComposer`; **read** = `CommentBubble` anchored on canvas
  (augments the right-panel card). Region/element comments render as `%` outline rects
  (`PaElementRegion`); draw as `%` polylines. **All of this already propagates via our shared
  renderer** (`core.mjs` + `ui/*`) — the artifact inherits it for free.
- **Share** = Modal (link + access level) — we already have Share/export; reconcile the UI.

---

## 4. Surface C — Comment-component audit + the new `region` type

The "couple of minor changes" = the comment composer/bubble gained **attachments** and **reactions**,
and a new **region** anchor type:

- **Attachments** — `CommentComposer`/`CommentBubble` carry an `attachments[]` array. NEW for us
  (we have category only). Decide scope: full attach-image support vs display-only. Likely defer
  actual file attachment to the cutover; flag.
- **Reactions** — `CommentBubble` shows reactions (👍 count, `mine`). NEW. Low-value for a
  single-author QA loop; likely **DEFER** or drop. Flag.
- **`region` feedback type** — comment-tool **drag** → a freeform rectangle comment (`type:"region"`,
  `rect:{xPct,yPct,wPct,hPct}`), distinct from `element` (inspector click → rect **+ selector**).
  This is a **NEW capture type** (4th, alongside text/drawing/element). It renders with the **same
  `buildBoundsBox` path** as `element` (inventory §5 "shared primitive") — so render is nearly free;
  the new work is the comment-tool drag gesture + the `type` branch in `normalizeViewPins` and the
  stores. **BUILD-NOW** (small, high-fidelity-to-design).
- **Apply across all surfaces** — overlay `.cmt-*`, console `.cc-*`/`.comment-*`, and the shared
  renderer/artifact. Keep `coords.mjs` (both copies) + category metadata in lockstep (inventory §7).

---

## 5. Decisions — LOCKED 2026-06-01 (user approved)

- **D1 — "Send to preview" semantics. DECIDED:** Send = **finalize the current screen + reset the
  overlay to a clean collecting state**, keeping our **continuous daemon persistence** (NOT a
  staging-layer rewrite). Mechanically Send ≈ our existing seal/`performDone` + clear, dressed in
  the design's confirm modal + "sent, page cleared" framing. **Nav-seal stays** — navigating still
  auto-seals screens within a session as today; Send is the explicit "I'm done with this page"
  finalize. Matches the daemon-streams-the-bundle architecture (§0).
- **D2 — session-level ops. DECIDED:** **keep resolve-all + sidebar collapse** (cheap, no home
  needed); **defer delete-session** to the cutover (destructive cross-session management belongs
  with the home). → deferral backlog (§8).
- **D3 — comment attachments + reactions. DECIDED:** **defer both** to the cutover (low value for
  the single-author QA loop; attachments need real upload plumbing). Build **category-only**
  composer/bubble parity now. → deferral backlog (§8).

Everything else is specified by the DesignOS source.

---

## 6. Phasing (build increments)

Branch-per-increment; docs→merge-commit, impl→squash; pause for review before merge; suite green +
`node --check` per edit.

1. **This plan** *(docs → merge-commit; D1–D3 locked §5).*
2. **Overlay fixture redesign (A)** — vertical right-dock toolbar + cursor default + reorder +
   status-dot totem & flyout (banner folded in, switching deferred) + Send→modal→finalize/clear +
   composer/bubble parity. Mostly `overlay/inject.js` (+ a binding if Send needs one). First & largest.
3. **`region` capture type (C)** — comment-tool drag in both surfaces + `normalizeViewPins`/store
   `type` branch + shared `buildBoundsBox` render. Small, threads the existing seal path.
4. **Console canvas toolbar (B §3.1)** — `cursor/comment/draw` BottomToolbar + region drag.
5. **Console empty states (B §3.2)** — empty-screen (upload / daemon prompt) + empty-session +
   add-screen name modal. In-session screen creation.
6. **Console session-level ops (B §3.3, per D2)** — resolve-all + collapse (+ screen ⋯ duplicate).
7. **Comment-component parity sweep (C)** — category parity overlay↔console↔artifact; attachments/
   reactions only if D3 says build.
8. **Test hardening per increment** — extend the kept suite (70/70 baseline) for the new `region`
   op, the Send/finalize path, and a console empty-state/toolbar smoke.

**DEFERRED to the standalone cutover (§1.1):** sessions index/home (`sessions-index.jsx`),
cross-session switching, new-*session* flow, delete-session (D2), attachments/reactions (D3 if
deferred). Mine `sessions-index.jsx` + the preview's `index` branch when the cutover builds the home.

---

## 7. Expected outcomes & acceptance (the full body of work)

What "done" looks like per increment — the observable result + how we verify it. The end state: the
fixture and console match the DesignOS feedback-collection prototype's *spec* (visuals + interaction)
while keeping our daemon/session/artifact architecture intact.

| # | Increment | Observable outcome (what you'll see) | Acceptance |
|---|---|---|---|
| 2 | **Overlay fixture redesign** | A vertical right-edge toolbar (totem · cursor · comment · draw · inspect · record · Send); cursor is the resting default; clicking a tool veils + arms it; the status-dot opens a flyout that shows the target session and — once recording — the step list + Preview-spec + Discard; **no separate recording banner**; Send raises a confirm modal then clears the page. | In-browser: every tool arms/disarms; drag-reposition persists across reload; record→steps appear in flyout; Send confirms→clears; suite green incl. a fixture smoke. |
| 3 | **`region` capture type** | Comment tool: a click drops a point pin, a **drag boxes a region**; the region renders as a `%` outline rect in overlay, console, and the exported artifact. | Unit: `normalizeViewPins` produces a `type:"region"` `%`-rect; server `createRegion` (or extended op) allowlisted + ownership-guarded; render smoke shows the box in all three surfaces. |
| 4 | **Console canvas toolbar** | A bottom-center cursor/comment/draw toolbar; cursor default lets you click pins; comment = point+region; draw = stroke. | In-browser + headless smoke: tools toggle, region drag authors a region comment, draw authors a stroke, mode clears, no JS faults. |
| 5 | **Console empty states** | A freshly added screen shows "Add a screenshot **or** paste this into Claude Code" with the real `/design-qa …` boot prompt; an empty session prompts "Add a screen." | In-browser: empty-screen + empty-session render; "Add a screenshot" uploads; the boot prompt matches the live `cli.mjs` syntax. |
| 6 | **Console session-level ops** | Screen-row ⋯ → Duplicate (optionally bring comments) / Delete; session chevron → Resolve all; sidebar collapse → floating pill. (Delete-session deferred.) | In-browser: duplicate/delete/resolve-all behave + toast; collapse round-trips; `canDelete`/ownership gates respected. |
| 7 | **Comment-component parity** | Category chip + composer/bubble shape match the prototype across overlay, console, and artifact (one vocabulary, two codebases until cutover). | Visual parity pass; category set stays the DesignOS 5; `coords.mjs`/category metadata in lockstep across copies. |
| 8 | **Test hardening** | The 70/70 baseline grows to cover the `region` op, the Send/finalize path, and a console toolbar/empty-state smoke. | `node --test "lib/__tests__/*.test.mjs"` green at the new count; memory count updated. |

**Net at the end:** the live-capture overlay and the review console both present the redesigned
feedback-platform UI; a 4th feedback type (`region`) ships; the recording experience consolidates
into the toolbar totem; the artifact inherits all render changes for free; and the deferred surfaces
(§8) are queued — not lost — for the standalone-app cutover. No data-model migration, no change to
the daemon/session contract.

---

## 8. Deferral backlog (living — batched for the standalone-app cutover)

Everything this phase intentionally pushes out, with the batch/epic it rolls into. **Primary
destination = the standalone Vite+React+TS cutover** (`design-qa-standalone-app.md` + A/B/C), which
dissolves the buildless/routing/`file://` constraints that make these expensive today. Keep this
list current as new deferrals surface (the deferral-lens discipline, §1.1). When the cutover plan is
next opened, fold these in as named scope.

| Deferred item | Source (DesignOS) | Why deferred | Batch / epic |
|---|---|---|---|
| **Sessions index / home page** (table, sortable name/screens/comments/modified) | `sessions-index.jsx` `PaSessionsIndex`; preview `view==="index"` | New navigable surface; routing + multi-session state the buildless console makes expensive; cutover provides it natively | **Cutover — "Home & navigation" epic** |
| **Cross-session switching** | fixture totem "Switch session" submenu; preview index nav + session-name dropdown | Multi-session routing/state; pairs with the home page | **Cutover — "Home & navigation" epic** |
| **New-*session* creation** (totem "New session…"; home Create + name-session modal) | `fixture.jsx` `onNewSession`; `preview-app.jsx` `newSession`/`promptNewSession` | Belongs with the home; today sessions are daemon-spawned | **Cutover — "Home & navigation" epic** |
| **Delete-session** (D2) | preview session-actions Menu `confirmDeleteSession` | Destructive cross-session management; safer alongside the home | **Cutover — "Home & navigation" epic** |
| **Comment attachments** (D3) | `CommentComposer`/`CommentBubble` `attachments[]` | Needs real file-upload plumbing; low value for single-author QA | **Cutover — "Rich comments" epic** (or earlier if a user asks) |
| **Comment reactions** (D3) | `CommentBubble` reactions (👍) | Multi-reviewer affordance; low value for the current loop | **Cutover — "Rich comments" epic** (candidate to drop entirely) |

**Coexisting backlog (already tracked — these batch naturally with the above):** engineer-side
**resolve persistence** (Spike 7 — routed into the standalone viewer/server, not a standalone task);
**Spike 9 regression diff** + **Spike 10 Figma compare** + **flow capture**
(`design-qa-flow-capture.md`); the **standalone-app cutover** itself (`design-qa-standalone-app.md`
+ A/B/C proposals). See memory `backlog_post_demo.md` for the canonical post-demo backlog ordering —
**this section should be reconciled into it (and into the cutover scope) when either is next touched.**

---

## 9. Carry-over invariants (must not regress)

- Feedback **never baked into the PNG** — `%`-overlay at review; `%`-at-rest via `lib/coords.mjs`
  (⚠ change both `lib/` + `console/lib/` copies).
- Capture-time **secret redaction** (`lib/redact.mjs`); element/region descriptors **never read
  `input.value`**.
- The **store-adapter seam** + **shared renderer** (`core.mjs`+`ui/*`) — keep the UI store-agnostic
  so the cutover rides for free; new `region` type flows through the same seal path as the others.
- The **`type` discriminator** (now text/drawing/element/**region**).
- Overlay UI state held **Node-side** (`toolbarPos` etc.) to survive cross-origin auth redirects.
- Suite green + `node --check` per edited `.mjs`/`.js`.

---

## 10. Component map — DesignOS canonical → our implementation

We are buildless/vanilla + a separate shadow-DOM overlay (until the cutover), so we adopt the
**spec/visual/behavior** of these, not the React components:

| DesignOS component | Used for | Our surface |
|---|---|---|
| `FloatingCluster`/`ClusterDivider` (vertical) | overlay toolbar shell | `overlay/inject.js` `.toolbar` |
| `IconBtn` (`selected`) | tool buttons | both |
| `RecordButton` | record toggle + recording indicator | overlay |
| `Pin` | numbered marker | both (`buildMarker`) |
| `CommentComposer` (authoring) | note + category + attachments | both composers |
| `CommentBubble`/`CommentCard` | read/edit + reactions + resolve | both |
| `BottomToolbar` (cursor/comment/draw) | console canvas tools | `console` (`bottom-toolbar.jsx` lineage) |
| `RightSteps`/`StepsTabs`/sidebar-panels | Comments/Steps pane | `console/ui/comments.mjs`+`steps.mjs` |
| `Modal` (confirm/informational/form) | Send confirm, spec preview, name prompt, delete/resolve-all | both |
| `Toast`/`ToastShelf` | confirmations | both (`ui/toast.mjs`) |
| `Menu`, `SectionHeader`, `Button`, `Checkbox`, `ResizeHandle`, `Icon` | chrome | console |

---

## Related
- DesignOS: `src/apps/feedback/{fixture,preview-app,sessions-index,hub-content}.jsx`; `CLAUDE.md`
  (FC rules FC1–FC4); `planning/archive/feedback-collection-plan.md`.
- `design-qa-interface-inventory.md` (current-state map) · `design-qa-feedback-platform.md` (§6
  superseded) · `design-qa-console-architecture.md` · `design-qa-standalone-app.md` (+A/B/C, the
  cutover the deferrals ride into).
