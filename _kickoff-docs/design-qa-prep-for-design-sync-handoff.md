# Handoff prompt — Prep for the design↔implementation sync (interface inventory + test hardening)

**Type:** HANDOFF PROMPT (2026-05-31). Kicks off a session that does **two design-independent
workstreams** while the user finishes the Claude Design pass. Neither is invalidated by the
design; both make the upcoming design↔implementation sync faster and safer. **Plan first
(plan mode), get sign-off, then build.**

> Verify every current-state claim against live code before relying on it — this brief is a
> map, not the territory.

---

## 0. Context

- Repo: `/Users/andrewfrank/code/design-gen/design-qa-skill`. Branch at pickup: `main` (sole
  branch). Cut fresh branches off `main`.
- The **feedback-platform capture-method phase is COMPLETE + in-browser verified**: a `type`
  discriminator on every `view.pins[]` record (default `'text'`), plus **drawing** (Spike 11)
  and **element-inspector** (Spike 12) capture — shipped across PRs #5/#6/#7, and a fix PR #8
  (squash `7b4ce76`) that added the overlay card-anchor fix, **console-side drawing
  authoring**, a DesignOS icon-only console toolbar, composer z-order + fixture-parity fixes,
  and modal-on-top. Suite **68/68**. The user has clicked it all through in-browser — "looking
  good and functioning as intended."
- **The next BUILD milestone is design-gated:** the browser-fixture UI update
  (`design-qa-feedback-platform.md` §6 — toolbar realign → vertical, permanent homes for the
  draw + element actions, recording banner → top) + the broader design↔implementation sync.
  The user is finishing design now. **This session does NOT start §6** — it prepares for it.

## 1. Required reading (read first; verify against live code)

In `_kickoff-docs/`:
- `design-qa-feedback-platform.md` — esp. **§5 review surfaces, §6 the LAST UI update, §7
  phasing**. §6 is what the inventory must feed.
- `design-qa-console-architecture.md` — the three surfaces (overlay / console / artifact), the
  store-adapter pattern, the shared render pipeline (`core.mjs` + `ui/*`), %-at-rest.
- `design-qa-spikes.md` — Spikes 11 & 12 (the shipped capture methods) + Spike 7 (engineer-side
  resolve persistence — **still open, intentionally deferred**, do not touch).
- `design-qa-standalone-app.md` (+ `-A/-B/-C`) — the future Vite+React+TS cutover, sequenced
  AFTER feature expansion. **Read it so the inventory + tests respect the seams and ride the
  lift-and-shift for free** — do NOT start the cutover.

Memory: `project_phase_status.md` (current state + what's next), `architecture_decisions.md`,
`designos_reference.md`, `phase_8_ui_parity.md`.

## 2. Workstream #2 — Interface + workflow inventory (prep the design sync)

**Goal.** Turn the design↔implementation sync from a discovery exercise into a **diff**.
Produce a curated reference doc cataloguing every current UI surface, its affordances/gestures,
the workflow each drives, and the seam/file where it lives — so the design pass can be mapped
onto concrete elements and §6 (toolbar realign + new action homes + banner move) has a precise
starting point.

**Cover all three surfaces:**
- **Overlay** (`overlay/inject.js`, closed shadow DOM): the draggable top-center mini-toolbar
  (grip · comment · **draw** · **inspect** · new-screen · record ▾ · Done), placement/draw/pick
  modes + their veils, the deferred-create composer (FxPinComposer), read/edit comment cards,
  the recording indicator (pill + step count + steps timeline), confirm modal, toasts.
- **Console** (`console/index.html`, `app.mjs`, `core.mjs`, `ui/*`): left Screens sidebar
  (brand tile, file menu, search, rows, ⋯ delete), center dot-grid canvas + the DesignOS
  **icon-only floating toolbar** (Comment + Draw tools), right `Comments | Steps` pill-tab pane
  (flat comment cards, resolve check, ⋯ menu, category tag; steps timeline), Share flow,
  session switcher / lookback, manual upload, resizers.
- **Artifact** (`artifact/build.mjs` over the shared renderer): which affordances are gated on
  (`canResolve` only) vs off.

**For each entry capture:** the element/workflow, current behavior + gesture, the file + symbol
it lives in, the `type`s it handles (text/drawing/element), and — where relevant — the §6
implication (what the design pass is expected to change). Flag the cross-surface duplications
the cutover will care about (e.g. overlay `.cmt-*` vs console `.cc-*` composer/card vocab; the
`coords.mjs` `lib/` vs `console/lib/` duplicate; the inlined-vs-`<link>` token story).

**Done when:** a reviewer (and the next design session) can read the doc and know every surface,
gesture, and where to change it — without re-deriving it from the code. Propose a doc name
(e.g. `design-qa-interface-inventory.md`).

## 3. Workstream #3 — Permanent test hardening of the new feedback-type seams

**Goal.** The drawing/element work is currently covered by unit tests (`session-drawing`,
`session-element`, the two `capture-*-e2e`) + **throwaway** headless smokes that were deleted.
Add **permanent** coverage so design-era churn can't silently break the capture/feedback-type
plumbing.

- **Server-level `createDrawing` mutate op.** The console drawing path
  (`HttpStore.createDrawing` → `/api/mutate` op `createDrawing` → `SessionStore.createDrawingPct`)
  has no permanent server test — only the unit test on `createDrawingPct` and a removed smoke.
  Add a kept test through the HTTP boundary (mirror the existing mutate/allowlist coverage if
  present; otherwise add one), asserting the op is allowlisted, routes through the
  ownership guard correctly (sealed/manual views editable; unsealed-browser blocked), and
  produces a `type:'drawing'` record with a %-shape.
- **Draw/element capture UI smoke (kept).** Port a headless smoke for the console draw tool +
  toolbar (the pattern proven this session: serve `console/` via `_serve.mjs` → MemoryStore
  fixture → drive a stroke → required note → assert one drawing rendered, mode clears, no page
  errors) into a permanent test, and/or an overlay-level smoke. Decide the right home + how to
  keep it from being flaky (coordinate staleness from `focusMarker` scroll bit the throwaway —
  re-read the live element box before dragging; deselect/reset between sub-cases).

**Done when:** `node --test "lib/__tests__/*.test.mjs"` (currently 68) covers the console
drawing op + a kept capture-UI smoke, all green, and the suite count is updated in memory.

## 4. Workflow for this conversation

1. **Plan mode.** Explore the seams above; pressure-test both workstreams; `AskUserQuestion`
   on any genuine forks (e.g. inventory doc granularity; where the kept UI smoke lives; whether
   to split #2 and #3 into separate PRs).
2. Write the inventory doc (curated) — and the tests on a separate branch.
3. **Branch + merge conventions (in force):** curated docs → real **merge commit**;
   implementation/test branches → **squash-merge**; short-lived branches, deleted on merge;
   never commit to `main` directly. **Pause for the user's review before merging** (the new
   process rule — they'll say when to merge).
4. Keep `node --check` clean on every edited `.mjs`/`.js`; keep the suite green.

## 5. Explicit non-goals (this session)

- **Do NOT start §6** (toolbar realign / banner move) — it's design-gated; this session only
  prepares for it.
- **Do NOT touch engineer-side resolve persistence** — the durable fix is routed into the
  standalone viewer/server (`design-qa-standalone-app.md` §4), not a standalone task.
- **Do NOT begin the standalone-app cutover** — sequenced after the design sync + §6.
- No new capture modalities, no Spike 9/10 work (separate research, not this).

## 6. Values

Safety, efficiency, security (keep capture-time secret redaction — `lib/redact.mjs`; the
element descriptor must never read `input.value`), accessibility, team-maintainability. Respect
the seams (store adapters `console/store/*`, shared render `core.mjs`+`ui/*`, binding layer
`lib/capture.mjs`, the `type` discriminator) so both workstreams ride the future cutover for
free. Bring a real point of view.

## Related
- `_kickoff-docs/design-qa-feedback-platform.md` (§6/§7) · `design-qa-console-architecture.md` ·
  `design-qa-spikes.md` (11/12/7) · `design-qa-standalone-app.md` (+ A/B/C)
- The shipped capture work: PRs #5/#6/#7 + fix PR #8 (`7b4ce76`).
