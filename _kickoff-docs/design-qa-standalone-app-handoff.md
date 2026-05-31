# Handoff prompt — Standalone-app architecture planning ritual

**Type:** HANDOFF PROMPT (2026-05-31). This is not a plan — it is the brief that kicks off a
**planning ritual** to produce the *first proposal documents* for migrating `/design-qa` from
its current embedded, buildless, skill-served form to a **standalone, bootable application**.
Pick this up when ready. **Do NOT implement anything during the ritual** — the goal is to
uncover the larger shifts and stage the follow-on planning rituals.

> Paste/observe this as the kickoff for the next session. Verify every current-state claim
> against live code before relying on it — this brief is a map, not the territory.

---

## 0. Your role for the ritual

You are the software architect for `/design-qa`. Produce proposal documents that move the
tool toward a standard, team-maintainable application. The requester (Andrew) has deferred
technical decisions to you and named the values that must govern them: **safety, efficiency,
security, accessibility, maintainability-by-more-team-members.** Bring a real point of view;
use `AskUserQuestion` only for genuine forks (listed in §6).

## 1. Why this change (the requester's intent)

- Move to a **standard application structure** so maintenance is approachable for more team
  members (not a bespoke buildless skill internals).
- Preferred stack: **React + a small Vite app** — unless there's a strong reason otherwise
  (you decide; justify).
- **Build the design system *inside* the app**: anything that must stay consistent across
  features is sourced from components, not re-implemented per surface.
- This mirrors **DesignOS** (the design-system context this project is built against), which
  is itself structured as a standard app with a component-sourced design system.
- The app should be **bootable as a standalone** thing the skill orchestrates — not code that
  only runs when the skill is invoked.

## 2. Required reading (read before proposing; verify against code)

In this repo (`/Users/andrewfrank/code/design-gen/design-qa-skill`):
- `_kickoff-docs/design-qa-standalone-app.md` — the architecture spike this ritual expands.
  It already records: embedded-vs-installed tradeoffs, "installing relocates the runtime but
  doesn't remove the server dependency," the **after-feature-expansion sequencing**, and the
  **bundled viewer/server** insight (the thing that dissolves the `file://` resolve
  write-back limit). Honor its open questions.
- `_kickoff-docs/design-qa-feedback-platform.md` — the in-flight feature expansion (drawing +
  element-inspector feedback, the `type` discriminator). The new app must accommodate these.
- `_kickoff-docs/design-qa-spikes.md` — the spike catalog incl. Spikes 11/12 (POC-validated)
  and Spike 7 (export/bundle + the `file://` history).
- `_kickoff-docs/design-qa-console-architecture.md` — the current console architecture.
- The code seams (these are the migration surface):
  - **Overlay (injected):** `.claude/skills/design-qa/scripts/overlay/inject.js` — closed
    shadow DOM, inlined tokens, vanilla JS, injected into arbitrary pages via Playwright.
  - **Console + shared renderer:** `scripts/console/core.mjs`, `scripts/console/ui/*`
    (`canvas.mjs`, `comments.mjs`, `sidebar.mjs`, `steps.mjs`), `scripts/console/store/*`
    (the swappable store adapter: `memory-store`, `http-store`, `lookback-store`,
    `artifact-store`), `scripts/console/lib/coords.mjs`.
  - **Daemon / capture / lifecycle:** `scripts/lib/*` (`session.mjs`, `capture.mjs`,
    `http-server.mjs`).
  - **Artifact build:** `scripts/console/scripts/artifact/build.mjs` — currently inlines ES
    modules + screenshots as base64 `data:` URLs to produce a buildless self-contained HTML.
  - **Skill commands:** `.claude/skills/design-qa/SKILL.md`, `start.md`, `end.md`, `help.md`.
- The DesignOS repo for the design-system structure to mirror:
  `/Users/andrewfrank/code/design-gen/DesignOS` (study how it organizes tokens → atoms →
  components; note the `context/` pack only has tokens+atoms — the full component set is in
  `src/`). Memory `designos_reference.md` has the source-file→pattern map.
- Memory `architecture_decisions.md` — the load-bearing WHYs you are allowed to revisit but
  must do so **explicitly** (see §3).

## 3. Current state (summary — verify, don't trust)

Three runtime surfaces, today all buildless and skill-served:
1. **Capture environment** — headed Chromium + injected overlay, driven by the Node daemon.
2. **Console** — review UI served over `localhost` by the skill's Node server; full
   read/write to `session.json`.
3. **Exported artifact** — a single self-contained HTML (modules + screenshots base64-inlined)
   opened via `file://` with no server → the one surface that can't write back (resolves fall
   to LocalStorage).

Load-bearing decisions this migration **touches and must address head-on** (do not silently
reverse):
- **"Buildless"** — there is currently no build step. React + Vite *introduces one*. This is a
  deliberate reversal; the proposal must justify it and show the portable-artifact *goal*
  survives (Vite single-file build, e.g. `vite-plugin-singlefile`, replaces the hand-rolled
  base64 inliner — same outcome, standard tooling).
- **"No iframe"** for capture; **overlay UI state Node-side**; **closed shadow DOM isolation**
  for the injected overlay.
- **%-at-rest** coordinate model; **versioned export**; **secrets redacted at capture time**.

## 4. Starting technical positions (validate — do not assume)

Your recommendations to pressure-test in the ritual, not foregone conclusions:

1. **Stack: Vite + React + TypeScript.** TS earns its keep here (correctness, a11y contracts,
   refactor safety, team onboarding). Justify the buildless reversal via the artifact-build
   argument above.
2. **Overlay stays OUT of the React cutover (probably).** Injecting React into arbitrary
   third-party pages is a footprint/security/isolation risk and breaks the closed-shadow-DOM
   guarantee. Options to weigh: (a) overlay remains vanilla-injected as today; (b) overlay is
   built as a *separate* self-contained bundle (Vite library/IIFE mode, possibly Preact or
   vanilla — **no React on the host page**) that still mounts into the closed shadow root and
   reuses tokens from the design-system package. **This is the ritual's first hard call.**
3. **Structure: a small workspace/monorepo** (weigh against single-app-with-folders if the
   overhead isn't earned). Candidate packages:
   - `@dqa/design-system` — React components mirroring DesignOS atoms/components; the token
     source of truth; a11y baked in.
   - `@dqa/core` — framework-agnostic session model, store adapters, coords, type model
     (incl. the feedback `type` discriminator). Portable to overlay + app + artifact.
   - `@dqa/console` — the React + Vite app.
   - `@dqa/artifact` — single-file build target reusing console components over the
     `ArtifactStore` adapter.
   - overlay bundle — per §4.2.
   - The **skill** (`.claude/skills/design-qa/`) becomes the **orchestration + daemon** layer
     that installs/boots/serves the built app and drives Playwright.
4. **Boot & install model.** First init builds/installs the app to a managed location; the
   daemon serves it (Vite preview or a tiny static server) and runs capture. The **bundled
   viewer/server** is what finally lets the standalone artifact persist resolves to its
   sidecar `session.json` (closing the `file://` limit). Decide install target (`~/.design-qa`
   vs project-local) and the sync/version/drift model.
5. **Design system sourced from DesignOS, a11y enforced.** Components are the single
   consistency source; tokens flow from the DesignOS context pack; semantic HTML + ARIA +
   focus management in components; lint + `axe` in CI.
6. **Security & supply chain.** Lockfile + `npm audit`/dependency hygiene as a gate;
   least-privilege daemon; keep capture-time secret redaction; reaffirm no-React-on-QA'd-pages.
7. **Migrate as lift-and-shift where the seams already allow it.** The shared render modules
   and store adapters are cleanly seamed and the `session.json` model is stable — port them to
   TS modules / React components incrementally rather than rewriting.

## 5. Deliverables — the proposal documents to produce

Write these to `_kickoff-docs/` (propose names). Each is a *proposal*, surfacing options +
your recommendation + tradeoffs, not an implementation.

- **Proposal A — Target architecture & toolchain.** Stack decision (+ buildless reversal
  justification), workspace/monorepo vs single-app, the package breakdown, the overlay
  boundary (§4.2), the design-system-in-app plan (sourcing from DesignOS, a11y standard), and
  the artifact build under the new toolchain.
- **Proposal B — Migration & sequencing.** Current→future mapping per surface; what's
  lift-and-shift vs. genuine rewrite; a phased plan that **rides after the feedback-platform
  feature expansion** (respect the seams meanwhile); risk register; rollback/coexistence
  strategy (can old and new run side by side during migration?).
- **Proposal C — Skill workflow & daemon changes.** How `start`/`end`/`help` + the daemon +
  lifecycle change; how the app is installed/booted/updated/served; the orchestration layer's
  new shape; an explicit list of **every file/command touched** and what breaks for existing
  sessions; the migration of in-flight `session.json` data.
- (Optional **Proposal D — Design system & a11y plan**, if A gets too large.)

Each proposal: Context → Options considered → Recommendation → Tradeoffs/risks →
Open questions → What follow-on planning ritual it unlocks.

## 6. Genuine forks to resolve with the requester (use AskUserQuestion)

1. **Overlay boundary** — vanilla-stays vs. separate non-React bundle (§4.2).
2. **Monorepo vs single app** — if the package overhead isn't clearly earned.
3. **Install target & ownership** — `~/.design-qa` (global) vs project-local `.design-qa`; is
   the installed app user-editable or managed/replaced on update?
4. **Buildless reversal sign-off** — confirm the requester accepts introducing a build step
   (it's a documented load-bearing decision).
5. **Coexistence** — must the current buildless console keep working during migration, or is a
   clean cutover acceptable?

## 7. Explicit non-goals (for this ritual)

- **No implementation.** No scaffolding, no `package.json`, no moving code. Proposals only.
- No commitment to a schedule — this is sequenced **after** the feedback-platform features
  ship (`design-qa-feedback-platform.md` §7). This ritual prepares; it does not start the cut.
- Don't re-litigate settled product decisions (the feedback-platform reframe, the `type`
  model, %-at-rest) — design *toward* them.

## 8. Ritual shape (suggested)

1. Enter plan mode. Explore the current architecture (the §2 seams) + skim DesignOS structure.
2. Draft the three proposals' skeletons; identify the §6 forks.
3. `AskUserQuestion` on the forks; fold answers in.
4. Write Proposals A/B/C to `_kickoff-docs/`; update memory (`backlog_post_demo.md`,
   `architecture_decisions.md` if any decision is revised, `MEMORY.md` index).
5. Name the follow-on rituals each proposal unlocks (e.g. "design-system component inventory,"
   "daemon boot-protocol spec"). Do not start them.

## Related
- `_kickoff-docs/design-qa-standalone-app.md` (the spike) ·
  `_kickoff-docs/design-qa-feedback-platform.md` · `_kickoff-docs/design-qa-spikes.md` ·
  `_kickoff-docs/design-qa-console-architecture.md`
- DesignOS repo: `/Users/andrewfrank/code/design-gen/DesignOS`
- Memory: `architecture_decisions.md`, `designos_reference.md`, `backlog_post_demo.md`
