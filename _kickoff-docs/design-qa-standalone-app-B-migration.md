# Proposal B — Migration & sequencing

**Type:** PROPOSAL (2026-05-31). Output of the standalone-app planning ritual. Sibling docs:
**Proposal A** (target architecture & toolchain), **Proposal C** (skill workflow & daemon).
Proposal only — no code, no schedule commitment.

Governing values: **safety, efficiency, security, accessibility, team-maintainability.**

---

## 1. Context

The cut from buildless-skill-served to a Vite + React + TS app (Proposal A) is fundamentally a
**lift-and-shift**: the load-bearing models (`session.json` v4, the uniform store-adapter
interface, `%`-at-rest coords, the feedback `type` discriminator) are stable and portable. The
genuine rewrite is narrow — the vanilla-DOM render layer becomes React components.

Two settled constraints govern the sequencing:

- **The cut rides *after* the feedback-platform features ship** (`design-qa-feedback-platform.md`
  §7; `design-qa-standalone-app.md` sequencing decision, 2026-05-31). Drawing (Spike 11) and
  element-inspector (Spike 12) feedback are POC-validated and reuse the exact seams; building
  them *before* the cut means they **ride the move for free**, and the app is better designed
  once the full feature surface exists.
- **Coexistence, then cutover** (resolved fork): the new React console runs side-by-side with
  the buildless console behind a flag, reading the **same** `session.json`, until parity is
  validated on real sessions.

---

## 2. Current → future map, per surface

| Surface | Today | Future | Classification |
|---|---|---|---|
| **Capture overlay** | `overlay/inject.js`, vanilla, closed shadow DOM, hand-inlined tokens | `src/overlay/inject.ts`, vanilla IIFE, tokens/icons imported from design system at build | **Re-target build** (stays vanilla) |
| **Console render** | `console/core.mjs` + `console/ui/*` vanilla DOM | `@dqa/ui` React components driven by `{store, options}` | **Rewrite** |
| **Session/store/coords** | `lib/session.mjs`, `console/store/*`, `lib/coords.mjs` | `@dqa/core` TS modules | **Port as-is** (typed) |
| **Daemon** | `session-server.mjs` + `lib/{http-server,capture,ipc,paths}.mjs` | Mostly intact; serves built assets (see Proposal C) | **Port, minor change** |
| **Artifact build** | `artifact/build.mjs` hand-rolled inliner | `vite-plugin-singlefile` + bundled viewer/server | **Re-target / replace** |

---

## 3. Lift-and-shift vs genuine rewrite

**PORT as-is (typed, behavior-preserved):**
- `lib/session.mjs` schema v4 + migrations → `@dqa/core/session` (the `type` discriminator
  defaults to `'text'` for back-compat; migrations stay the upgrade path).
- `lib/coords.mjs` (`pagePxToPct`, the px↔% seal path) → `@dqa/core/coords`.
- `console/store/*` four adapters behind the uniform interface → `@dqa/core/store`.
- `lib/redact.mjs` (capture-time secret redaction) → ported **unchanged**; security invariant.
- `lib/capture.mjs`, `lib/recorder.mjs`, `lib/ipc.mjs`, `lib/paths.mjs` → ported; daemon-side,
  framework-agnostic already.

**REWRITE:**
- `console/core.mjs` + `console/ui/*` (canvas, comments, sidebar, steps, menu, toast, resizers,
  preview-spec) → React components in `@dqa/ui` + `@dqa/design-system`. Preserve the `options`
  capability gate exactly.
- `artifact/build.mjs` → `vite.config.ts` single-file target.

**RE-TARGET:**
- `overlay/inject.js` → `src/overlay/inject.ts`, **still vanilla**, built as a separate IIFE that
  inlines the design system's tokens/icons. No React enters the host page.

---

## 4. Phased plan (rides after feedback-platform Spikes 11/12 land)

> Gate: do not begin Phase 1 until the feedback-platform features have shipped on the buildless
> tool, so they ride the lift-and-shift rather than being ported twice.

- **Phase 0 — Scaffold.** Stand up the Vite + React + TS app shell, `@dqa/design-system` (tokens
  + base + first atoms), and `@dqa/core` ported from the stable seams (`session`, `store`,
  `coords`, `feedback`). No behavior change to the live tool. CI gates wired (lint, a11y, audit).
- **Phase 1 — React console behind a flag.** Port `@dqa/ui` render modules to React; serve the
  React console behind a `--react-console` flag. **Coexist**: both consoles read/write the same
  `session.json` via `@dqa/core` store adapters over the unchanged daemon API.
- **Phase 2 — Parity validation.** Replay **real archived sessions** through both consoles; diff
  rendering, pin placement, resolve/move/delete, recorder timeline, manual upload, and export.
  Sign off parity (including a11y pass) before flipping the default.
- **Phase 3 — Console cutover.** Make the React console the default; retire the buildless console
  and its raw-`.mjs` serving. (Rollback = flip the flag back; old console remains until removed.)
- **Phase 4 — Artifact + viewer/server.** Replace `build.mjs` with `vite-plugin-singlefile`;
  ship the **bundled viewer/server** so artifacts open via `localhost` and resolve write-back
  persists to the sidecar `session.json` (closes the `file://` limit). LocalStorage retained as
  the no-server fallback only.
- **Phase 5 — Overlay re-target.** Move `inject.js` into the Vite IIFE build sourcing shared
  tokens/icons. Lowest urgency (overlay works unchanged throughout); doing it last removes the
  last drift source.

Each phase lands and is validated in isolation. Phases 4 and 5 can trail the console cutover.

---

## 5. Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| **Render parity gaps** (React vs vanilla) | Med | Coexistence + real-session replay in Phase 2 before default flip; flag rollback. |
| **Overlay token drift** during the window | Low | Phase 5 makes the design system the single source; until then tokens are frozen, change rarely. |
| **In-flight `session.json` migration** | Low | Schema v4 is forward-compatible; `type` defaults to `'text'`; migrations live in `@dqa/core/session`. No on-disk format change in the cut. |
| **Dependency / supply-chain surface** grows (Vite/React) | Med | **Gate**: committed lockfile + `npm audit` (fail CI on high/critical), pinned versions, periodic dependency review. |
| **A11y regressions** vs the inline-style port | Med | `eslint-plugin-jsx-a11y` + `axe` in CI; a11y sign-off is part of Phase 2 parity. |
| **Daemon least-privilege** | Low | Daemon keeps localhost-only binding, path-traversal guards, single-writer `session.json`. **Reaffirm: no React on QA'd pages** — overlay stays vanilla, closed shadow DOM. |
| **Secret leakage at capture** | Low | `redact.mjs` ported unchanged; capture-time redaction invariant preserved. |

---

## 6. Rollback / coexistence strategy

- **Coexistence is the core safety net.** The `session.json` schema and the store-adapter
  interface are the contract; old and new consoles are two readers of one document. No data fork.
- **Rollback** at any point in Phases 1–3 = flip `--react-console` off; the buildless console is
  not deleted until after Phase 3 sign-off.
- **Artifact coexistence**: existing exported artifacts keep working (LocalStorage fallback);
  new exports gain the viewer/server. No regression for already-shipped bundles.

---

## 7. Open questions

- **Exact parity bar** for Phase 2 sign-off (pixel-diff tolerance, which sessions constitute the
  replay corpus) — define at the start of the React-render-layer ritual.
- **When to delete the buildless console** — immediately after Phase 3, or hold one release as
  insurance.
- **Whether Phases 4/5 block "migration complete"** or ship as fast-follows.

---

## 8. Follow-on ritual this unlocks

**"React render-layer port spec."** Component-by-component mapping of
`canvas` / `comments` / `sidebar` / `steps` (+ menu, toast, resizers, preview-spec) to React,
the `{store, options}` contract and capability-gate semantics, the parity corpus and diff
method for Phase 2, and the flag/coexistence mechanics. This is the spec that turns Phase 1–3
into executable work.
