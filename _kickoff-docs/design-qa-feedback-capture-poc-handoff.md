# Handoff prompt — Feedback-capture input methods: planning + POC

**Type:** HANDOFF PROMPT (2026-05-31). Kicks off a session that **plans** /design-qa's two new
feedback-capture input methods (Spikes 11 & 12) and then moves into building **working
proof-of-concept prototypes**. This is planning + POC — not the final, designed feature.

> Verify every current-state claim against live code before relying on it — this brief is a
> map, not the territory.

---

## 0. Context

- Repo: `/Users/andrewfrank/code/design-gen/design-qa-skill`
- Branch at pickup: **`5/feedback-capture-poc`** — already created off `main` and checked out;
  this is your starting branch (don't re-branch for the planning docs). All prior planning docs
  (standalone-app proposals + this handoff) are already merged to `main` (PR #3, merge commit
  `beb6989`; PR #4 `961469a`).

`/design-qa` is reframing from a *commenting* tool to a **feedback platform**: a pinned text
note is just ONE kind of feedback. We're adding two more capture methods, unified by a `type`
discriminator:

- **Spike 11 — Drawing / markup feedback** (`type:'drawing'`): freehand draw on the page to
  direct attention; **optional** text note (a bare circle with no words is valid feedback).
- **Spike 12 — DOM-element inspector feedback** (`type:'element'`): hover/select a live
  element; capture its outline rectangle + a human element name; attach a note.

Both are already **POC-validated FEASIBLE** — throwaway feasibility POCs proved the hard
mechanics. The job NOW is to build a **working prototype** of each, wired end-to-end through the
real seams (overlay capture → `session.json` → console/artifact render), with **minimal /
undesigned UI**, so that the **forthcoming Claude Design UX can be applied on top of a prototype
that already works.** Mechanics first; visual design lands later.

## 1. Required reading (read first; verify against live code)

In `_kickoff-docs/`:
- `design-qa-feedback-platform.md` — the reframe, the `type` discriminator, the "never bake
  feedback into the screenshot PNG" invariant, §7 phasing.
- `design-qa-spikes.md` — Spikes 11 & 12: POC verdicts, measured numbers, and the **recommended
  at-rest data shapes** (use these as the strong default).
- `design-qa-console-architecture.md` — store-adapter pattern, shared render pipeline, the three
  surfaces (overlay / console / artifact), the %-at-rest invariant.
- `design-qa-standalone-app-{A-architecture,B-migration,C-skill-daemon}.md` — the (future)
  Vite + React + TS migration. **NOT now**, but it is sequenced **after** these features ship:
  build them respecting the seams so they ride the lift-and-shift for free.

Memory: `architecture_decisions.md`, `backlog_post_demo.md`, `designos_reference.md`.

## 2. Seams these POCs must reuse (do not invent new ones)

- **Overlay:** `.claude/skills/design-qa/scripts/overlay/inject.js` — CLOSED shadow DOM, vanilla
  JS, no imports.
- **Capture / binding:** `scripts/lib/capture.mjs` — `window.__designQA_*` bindings
  (`exposeBinding`).
- **Coords:** `scripts/lib/coords.mjs` (`pagePxToPct`) — everything normalizes to **%-at-rest**
  on seal.
- **Session model:** `scripts/lib/session.mjs` — schema v4; `type` is additive, defaults
  `'text'`.
- **Render:** `scripts/console/ui/canvas.mjs` (`buildMarker`) — feedback renders as an
  **overlay** (SVG path / positioned box) over the screenshot, **never rasterized into the PNG.**
- **Store:** `scripts/console/store/*` — uniform adapter interface across all four stores.

**Recommended at-rest shapes** (from the POCs — confirm, then treat as default):
- drawing: `type:'drawing'`, `shape:{ kind:'path', paths:[[[xPct,yPct],…]], bounds:{…}, strokeWidth, color }`
- element: `type:'element'`, `element:{ bounds:{xPct,yPct,wPct,hPct}, name, descriptor?:{tag,testId,text} }`
- Shared `buildBoundsBox(pct)` helper renders both the element box and rect-kind drawings.

## 3. Open design questions to settle while planning (AskUserQuestion for genuine forks)

- Which method to prototype first (drawing vs element), or both in parallel.
- Save/exit gesture for drawing (explicit Save vs tool-toggle-off).
- Whether a bare element selection with no note is kept.
- Whether review visually differentiates feedback kinds (or defer to the forthcoming design).
- How much placeholder UI the prototype needs vs. waiting for the Claude Design pass.

## 4. Workflow for this conversation

1. Enter plan mode; explore the seams above; pressure-test the POC approach.
2. Use `AskUserQuestion` on the genuine forks.
3. The branch **`5/feedback-capture-poc` is already created off `main` and is your starting
   branch** — do NOT branch again for planning. Write the planning document(s) into
   `_kickoff-docs/` (propose names) and commit them here.
4. **Open a PR for `5/feedback-capture-poc` → `main` and merge it as a real merge commit** (the
   docs are distinct reference artifacts — don't squash).
5. Start the actual POC implementation in a **new short-lived branch per capture method** off the
   freshly-merged `main` (e.g. `6/poc-drawing`, then `7/poc-element` — one method at a time, each
   tested in isolation per the feedback-platform §7 plan). **Squash-merge** these implementation
   branches so each lands on `main` as one clean, revertable commit.

> Merge-strategy rule for this project: **curated branches (docs/planning) → real merge;
> implementation branches → squash-merge.** Keep branches short-lived; delete on merge.

## 5. Values that govern every call

Safety, efficiency, security (**keep capture-time secret redaction** — `scripts/lib/redact.mjs`),
accessibility, team-maintainability. Bring a real point of view.

## Related
- `_kickoff-docs/design-qa-feedback-platform.md` · `design-qa-spikes.md` ·
  `design-qa-console-architecture.md`
- The standalone-app proposals (future migration this rides ahead of):
  `design-qa-standalone-app-{A-architecture,B-migration,C-skill-daemon}.md`
