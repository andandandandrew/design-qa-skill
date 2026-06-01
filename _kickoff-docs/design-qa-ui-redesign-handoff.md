# Handoff prompt — Feedback-platform UI redesign (build increment 2: the overlay fixture)

**Type:** HANDOFF PROMPT (2026-06-01). Kicks off a fresh session to **build** the redesign whose
plan is already authored + approved. The planning + decisions are done; this session executes.
**Plan first (plan mode) for the increment, get sign-off on the approach, then build.**

> Verify every current-state claim against live code before relying on it — the plan is a map.

---

## 0. Context — read these first

- Repo: `/Users/andrewfrank/code/design-gen/design-qa-skill`. The approved plan lives on branch
  **`6/feedback-platform-ui-redesign`** (or on `main` if the plan was already merged — check
  `git log`/`git branch`). **Required reading, in order:**
  1. `_kickoff-docs/design-qa-ui-redesign-plan.md` — **the approved plan.** Read it whole. §2 is
     this increment; §5 has the locked decisions (D1–D3); §7 is the outcomes/acceptance; §8 is the
     deferral backlog (do NOT build deferred items).
  2. `_kickoff-docs/design-qa-interface-inventory.md` — the verified current-state map of all three
     surfaces (overlay/console/artifact), each affordance → its symbol/file.
  3. `design-qa-console-architecture.md` — the three surfaces, store-adapter seam, %-at-rest.
- **The authoritative design** is the DesignOS feedback-collection application at
  `/Users/andrewfrank/code/design-gen/DesignOS/src/apps/feedback/`. For THIS increment read
  **`fixture.jsx`** (our overlay) + skim `hub-content.jsx` (`HUB_FIXTURE_SPEC` = the capability
  contract). DesignOS is mocked+standalone (rule FC2) and composes the canonical library (FC3) — we
  adopt the **spec/visual/behavior**, implemented in our buildless/vanilla overlay (NOT the React).
  Launch `Feedback - Collection Fixture.html` to see live behavior.
- **The de-risk (plan §0):** the redesign is almost entirely presentation + interaction. The
  DesignOS "How it connects" note confirms the intended architecture **is our existing daemon /
  `session.json` model** — so **no data-model migration**, no change to the daemon/session contract.
  The fixture's stage-and-flush is only a no-daemon demo artifact.
- Memory: `project_phase_status.md` (the ⚑ UI-REDESIGN entries — current state + the locked
  decisions), `architecture_decisions.md`, `designos_reference.md`, `phase_8_ui_parity.md`,
  `backlog_post_demo.md`.

## 1. This increment — Surface A, the overlay fixture redesign (plan §2)

Rebuild `overlay/inject.js` (closed shadow DOM) to the DesignOS fixture spec. Self-contained; an
overlay edit needs a fresh `/design-qa` session to re-cache (`lib/capture.mjs`).

1. **Vertical right-edge toolbar** (plan §2.1). `FloatingCluster` vertical, default
   `right:16; top:50%` right-center. Order top→bottom: **status-dot totem · | · cursor · comment ·
   draw · inspect · | · record · | · Send**. Selected tool = accent; Send = plain.
   - **Carry over unchanged:** grip drag (`onGripDown/Move/Up`, `setPointerCapture`), Node-side
     `STATE.toolbarPos` persistence (`__designQA_setUiState`/`getUiState`), `clampToViewport`. Change
     axis → vertical, anchor → right-center, add off-screen sanitize-on-load (`fxSanitizePos`
     pattern). Decide: keep our explicit grip or adopt whole-pill drag (design drags the whole pill).
2. **Cursor default tool** (plan §2.2) — NEW 4th mode `cursor|comment|draw|element`; `cursor` is the
   resting default (clicks pass through, no veil). Clicking the active tool toggles back to cursor.
3. **The four inputs** (plan §2.3): comment (click→point pin; **drag→region box, NEW**), draw
   (stroke, red `oklch(.62 .22 25)`/width 3.5), inspect (`element`; our `describeEl`, never reads
   `input.value`). Note required for all. *(The `region` type itself = increment 3; this increment
   can stub the region gesture or land it here — your call in plan mode.)*
4. **Status-dot totem + flyout** (plan §2.4) — folds in + **replaces the standalone recording
   banner.** Totem = always-on accent dot ("Collecting feedback"); click → side flyout with: target
   session row (switch submenu = **non-wired placeholder, switching DEFERS** per §8); and — once a
   path exists — "Flow · N steps" list + **Preview spec** + **Discard recording**. Recording shown
   by the **record button going red**, not the totem. Remove `.rec-indicator`; move its
   `renderRecIndicator`/steps/discard logic into the flyout. The overlay gains a **spec-preview**
   Modal it didn't have (reuse the emit logic).
5. **Send → finalize (D1)** (plan §2.5) — `Send` (upload icon) → confirm Modal → **finalize the
   current screen + reset the overlay to a clean collecting state**, keeping continuous persistence.
   Mechanically ≈ our existing seal/`performDone` + clear. **Nav-seal stays.** **Remove the Done +
   New-screen buttons** (the Send-and-clear loop replaces both).
6. **Composer / bubble parity** (plan §2.6) — `CommentComposer` (note + **category**) + `CommentBubble`
   (author/time/body/category/resolve/close). **Attachments + reactions DEFER (D3, §8)** — category
   only. Toasts on record start/stop + send. Helper hint + "N/M resolved" count.

## 2. Acceptance (plan §7, row 2)

Vertical toolbar with all tools arming/disarming; cursor is the resting default; drag-reposition
persists across reload; record→steps appear in the flyout (no separate banner); Send confirms →
finalizes + clears; spec-preview renders. Suite green incl. a fixture smoke; `node --check` clean on
every edited file. The user runs it in-browser after — state exactly what to verify.

## 3. Explicit non-goals (this increment)

- **Do NOT build anything in the deferral backlog (plan §8):** sessions index/home, cross-session
  *switching* (build the flyout shell + target *display* only), new-*session* creation,
  delete-session, attachments, reactions.
- **Do NOT touch the data model / daemon contract** — D1 keeps continuous persistence. The `region`
  normalize/store work is increment 3 (coordinate if you land the gesture early).
- **Do NOT begin the standalone-app cutover** — the deferrals ride into it later.
- Console (Surface B), empty states, and the comment-parity sweep are later increments (plan §6).

## 4. Workflow + conventions

1. **Plan mode** for the increment: read the live `overlay/inject.js`, pressure-test the approach
   against the spec, `AskUserQuestion` on real forks (grip vs whole-pill drag; whether `region`
   lands here or in increment 3; spec-preview reuse).
2. Branch off `main`: cut a fresh **implementation** branch (e.g. `6a/overlay-fixture`).
   Implementation → **squash-merge**; short-lived, deleted on merge; never commit to `main` directly.
   **Pause for the user's review before merging** (they'll give the merge ask).
3. `node --check` every edited `.mjs`/`.js`; keep the suite green (baseline 70/70).
4. Update memory (`project_phase_status.md`) when the increment lands.

## 5. Values

Safety, security (keep `lib/redact.mjs` capture-time redaction; element/region descriptors never
read `input.value`), accessibility, team-maintainability. Respect the seams (closed shadow DOM,
Node-side UI state, the `type` discriminator, the shared-renderer boundary) so the work rides the
future cutover for free. Bring a real point of view.

## Related
- `_kickoff-docs/design-qa-ui-redesign-plan.md` (the plan — §2 this increment, §5 decisions, §7
  outcomes, §8 deferral backlog) · `design-qa-interface-inventory.md` · `design-qa-console-architecture.md`
- DesignOS: `src/apps/feedback/fixture.jsx` + `hub-content.jsx`; `CLAUDE.md` (FC rules).
