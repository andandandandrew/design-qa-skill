# Design QA — Skill-orchestrated standalone app (architecture spike)

**Status:** ARCHITECTURE SPIKE, **NOT SCHEDULED** (2026-05-31). Captured so we don't lose
the idea. Sequenced **after** the feedback-platform feature expansion
(`design-qa-feedback-platform.md`). When we pick this up, it begins as a research spike
against the then-current codebase, not an implementation.

---

## 1. The idea

Today the skill **embeds** the app: the console (review UI), the overlay (`inject.js`), the
Node server, and the artifact builder all live inside `.claude/skills/design-qa/scripts/`
and run only when the skill is invoked. The proposal: on first init, the skill **installs a
self-managed app** into its own directory — independently runnable, version-managed — and
the skill becomes a thin **orchestration layer** over it. This aligns with the stated north
star: *"build the skill in orchestration layers to better work with that tool,"* with the UI
increasingly delivered from the Claude Design pipeline.

## 2. Is the current embedded approach "unsafe"? No.

Important framing, so we don't pick this up for the wrong reason. Serving the app from the
skill dir is **not a security problem** — it's static JS modules served over `localhost` by
our own Node process, and the artifact build inlines those same modules as base64 into one
HTML file. Nothing evals untrusted/remote code. This is the same pattern Vite/Storybook use.

What the embedded approach actually costs is **coupling**, not safety:

- The app can't run **without invoking the skill** — there's no "just open the Design QA
  app" independent of the orchestration daemon.
- The skill directory carries **two concerns at once** — orchestration logic *and* a full
  app codebase.

## 3. Embedded vs. installed — the real tradeoffs

| | **Embedded (today)** | **Installed self-managed app (proposal)** |
|---|---|---|
| Source of truth | One copy in the skill | Two copies (skill source + installed) → sync/drift to manage |
| Runs without skill? | No | Yes — independently startable |
| Update story | Update skill = update app (simple) | Skill must install / migrate / version the copy |
| Customizable by user | Not meant to be | Could be owned/customized |
| Best when | App is a runtime surface | The app is a product the user runs/owns |

**Key correction to a tempting assumption:** installing the app **relocates the runtime, it
does not remove the server dependency.** The console *needs* a Node server to read/write
`session.json` and drive Playwright; moving it elsewhere just moves where that server lives.
So installation, by itself, does **not** fix the `file://` artifact write-back limit (below).

## 4. Why this dissolves the `file://` write-back limit (the real payoff)

The standalone exported `artifact.html`, opened by double-clicking (`file://`), **cannot
write back to disk** (browser security) — which is why engineer-side resolves in the
standalone artifact are stuck in LocalStorage (the one surface still on it; the served
console + lookback already persist resolves to `session.json`). The clean fix is **not** a
`file://` hack — it's shipping a **tiny local viewer/server with the bundle**, so the
engineer opens the artifact *through that viewer* (a real `http://localhost` origin) instead
of `file://`. Then resolve write-back, fluid read/write across capture + review, and
sidecar-JSON persistence all become trivial — the same way the live console already works.

**Therefore: standalone-artifact resolve portability lives in THIS spike, not in the
resolve-cleanup item.** The resolve-cleanup work (done separately) only tidies the existing
LocalStorage fallback + fixes a staleness bug; the durable answer is the viewer/server here.

## 5. Sequencing — after feature expansion, not before

Decided 2026-05-31. Expand the feedback-platform features first; cut over after. Rationale:

- The cutover is a **lift-and-shift** (it moves/repackages the tree; it does not rewrite
  per-feature logic), so features built before it **ride the move for free** — no per-feature
  porting tax.
- The standalone app is **better designed once its full feature surface exists** (we're
  about to add two whole feedback modalities); designing packaging against a moving target
  is wasteful.
- The cutover is an **unscoped refactor** and must not block visible value.

**Insurance policy while expanding:** respect the existing seams — the swappable store
adapter (`console/store/*`), the shared render modules (`canvas.mjs` / `comments.mjs` /
`steps.mjs` / `core.mjs`), the binding layer (`lib/capture.mjs` `exposeBinding`), and the
`type` discriminator. These are exactly what keep *both* the features and this cutover clean.

## 6. Open questions (preserved, not resolved)

1. **Install target.** `~/.design-qa/app/`? Project-local `.design-qa/`? npm-style?
2. **Sync/version model.** How does the skill keep the installed copy current without drift?
   Is the installed copy user-editable, or managed/replaced on update?
3. **The viewer/server shape.** A minimal static server bundled with each export? A single
   shared local "Design QA viewer" the user installs once and opens any bundle through?
4. **What stays in the skill.** Orchestration only? Or does the overlay (`inject.js`) — which
   is injected into Chromium regardless — stay skill-side while the console moves?
5. **Relationship to Claude Design.** If UI/workflows are increasingly authored in the
   Claude Design pipeline, does the installed app become the delivery target for that output?
6. **Migration of in-flight sessions** when the runtime relocates.

## 7. When we pick this up

1. Confirm the feedback-platform features have shipped and the seams held.
2. Research spike against the then-current codebase: what actually has to move, and what the
   viewer/server needs to do.
3. Decide install target + sync/version model + viewer shape.
4. Re-read this doc against reality; revise.
5. **Then** cut over (lift-and-shift) and fold standalone-artifact resolve portability into
   the viewer.

## Related

- `_kickoff-docs/design-qa-feedback-platform.md` — the feature expansion this sequences after.
- `_kickoff-docs/design-qa-spikes.md` §Spike 7 — the export/bundle decisions + the
  `file://` constraint history.
- `console/store/local-resolve.mjs`, `artifact-store.mjs` — the LocalStorage fallback the
  viewer/server would replace for the standalone artifact.
