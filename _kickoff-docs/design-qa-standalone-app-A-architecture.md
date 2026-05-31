# Proposal A — Target architecture & toolchain

**Type:** PROPOSAL (2026-05-31). Output of the standalone-app planning ritual
(`design-qa-standalone-app-handoff.md`). Sibling docs: **Proposal B** (migration & sequencing),
**Proposal C** (skill workflow & daemon). This is a proposal — it surfaces options, a
recommendation, and tradeoffs. It is **not** an implementation and commits no code.

Governing values: **safety, efficiency, security, accessibility, team-maintainability.**

---

## 1. Context

`/design-qa` today is three buildless, skill-served runtime surfaces:

1. **Capture overlay** — headed Chromium + a 1,455-line self-contained vanilla `inject.js` in a
   **closed** shadow DOM, driven by the Node daemon over `window.__designQA_*` bindings.
2. **Console** — review/authoring UI served over `localhost` as raw `.mjs` modules; full
   read/write to `session.json`.
3. **Exported artifact** — a single self-contained HTML produced by a hand-rolled base64
   inliner (`artifact/build.mjs`), opened via `file://` with no server → the one surface that
   can't write back (resolves fall to LocalStorage).

The intent of the migration: move to a **standard, bootable Vite + React + TypeScript app**
with an **in-app design system** so the codebase is maintainable by more of the team, mirroring
how **DesignOS** is organized.

Two facts uncovered during exploration reshape the problem and de-risk it:

- **`artifact/build.mjs` is already a hand-rolled bundler.** It rewrites relative imports to
  `@dqa/*` bare specifiers, base64-inlines every shared module + screenshot, and emits an import
  map into one HTML. The "buildless reversal" is therefore **replacing a bespoke build with a
  standard one**, not introducing a build where none existed.
- **DesignOS is not a Vite/React/TS app.** It is React-via-in-browser-Babel, inline style
  objects referencing OKLCH **CSS-variable tokens**, components published to `window`, hover via
  React state — **no TS, no CSS modules, no Tailwind, no tests, no axe.** "Mirror DesignOS"
  means mirror its **organization** (tokens → atoms → clusters → app → layouts) and its **token
  vocabulary**, not its (absent) toolchain. The new app is the **first** place this design
  language gets a real build, types, and accessibility rigor.

---

## 2. Options considered

### 2.1 Stack & build step

| Option | Verdict |
|---|---|
| **Stay buildless** (raw `.mjs` + hand-rolled inliner) | Rejected — it is the status quo this ritual exists to leave; offers no path to the team-maintainability goal. |
| **Vite + React, no TS** | Considered — lighter onboarding, but forfeits compile-time contracts on exactly the seams most worth typing (session schema, store interface, coords). |
| **Vite + React + TypeScript** | **Recommended & signed off.** TS earns its keep on the session/store model, a11y props, and coordinate math; standard tooling is the whole point of the move. |

The buildless reversal is a documented load-bearing decision; it is reversed **explicitly** and
recorded in memory (`architecture_decisions.md`). The portable-artifact *goal* survives intact:
`vite-plugin-singlefile` emits the same self-contained HTML the inliner does today.

### 2.2 Repo structure — workspace vs single app

| Option | Verdict |
|---|---|
| **Full `@dqa/*` pnpm/npm workspace** (published packages) | Considered, **not adopted now.** Real overhead (workspace tooling, versioning, inter-package publishing) not clearly earned at ~10k lines with clean *internal* seams. DesignOS itself is a single non-workspace repo. |
| **Single Vite app + TS path-aliases + a 2nd build target for the overlay** | **Recommended.** Logical boundaries (`@dqa/core`, `@dqa/ui`, `@dqa/design-system`) expressed as folders + `tsconfig` path aliases — the seam clarity of a workspace without its ceremony. Promotable to a real workspace later if team scale demands it. |

### 2.3 Overlay boundary (the ritual's first hard call)

| Option | Verdict |
|---|---|
| **Keep `inject.js` exactly as-is** | Zero churn, but leaves OKLCH tokens + lucide icons hand-duplicated, free to drift from the design system. |
| **Rebuild overlay as a Preact IIFE** | Component-style authoring without React weight, but a larger rewrite and adds a runtime to every QA'd page. |
| **Overlay stays vanilla, sources tokens/icons from the design system at build time, ships as a separate Vite IIFE/library target** | **Recommended & signed off.** No React on third-party (often auth-gated) pages — preserves the closed-shadow-DOM isolation and minimal footprint — while killing token drift by making the design system the single source the overlay's inlined CSS string is generated from. |

---

## 3. Recommendation

### 3.1 Toolchain
**Vite + React 18 + TypeScript.** Single Vite app, multiple build targets (console app, artifact
single-file, overlay IIFE). `vite-plugin-singlefile` for the artifact. ESLint + `eslint-plugin-
jsx-a11y` + `axe` in CI for the accessibility gate. Lockfile + `npm audit` as a supply-chain
gate (detailed in Proposal B).

### 3.2 Repo shape — single app, aliased internal boundaries

```
design-qa-app/                 # built from skill source; see Proposal C for install
├── package.json               # vite, react, typescript, vite-plugin-singlefile
├── tsconfig.json              # path aliases: @dqa/core, @dqa/ui, @dqa/design-system
├── vite.config.ts             # console build + artifact (singlefile) + overlay (IIFE) targets
└── src/
    ├── core/                  # @dqa/core — framework-agnostic TS
    │   ├── session/           #   session model + schema TYPES (ported from lib/session.mjs v4)
    │   ├── store/             #   store adapters: memory | http | lookback | artifact
    │   ├── coords.ts          #   pagePxToPct etc. (ported from lib/coords.mjs)
    │   └── feedback.ts        #   the `type` discriminator: text | drawing | element
    ├── design-system/         # @dqa/design-system — React mirror of DesignOS
    │   ├── tokens.css         #   OKLCH token vocabulary (source of truth; from DesignOS pack)
    │   ├── base.css           #   reset + :focus-visible + scrollbars
    │   ├── atoms/             #   Button, IconButton, Tag, Toggle, … (typed, a11y baked in)
    │   ├── clusters/          #   FloatingCluster, Menu, ShareButton, …
    │   └── icons.tsx          #   lucide set (also exported as a string for the overlay build)
    ├── ui/                    # @dqa/ui — shared renderer ported from console/core.mjs + ui/*
    │   ├── Canvas.tsx         #   ← canvas.mjs   (pins/markers, popovers, comment cards)
    │   ├── Comments.tsx       #   ← comments.mjs (filtered/sorted feedback list)
    │   ├── Sidebar.tsx        #   ← sidebar.mjs  (screen list, search)
    │   ├── Steps.tsx          #   ← steps.mjs    (recorder timeline)
    │   └── render-options.ts  #   capability gate: canPlacePins/canEditNotes/canResolve/canDelete
    ├── console/               # the React app entry — live store over the daemon
    ├── artifact/              # single-file build target — @dqa/ui over ArtifactStore
    └── overlay/               # separate Vite IIFE build — VANILLA, no React
        └── inject.ts          #   ← inject.js, vanilla; tokens/icons imported at build time
```

`@dqa/core` is the portable spine: it carries the `session.json` model (schema v4, unchanged),
the four store adapters behind their **uniform interface** (`subscribe`, `screenshotUrl`,
`getView`, `createPin`, `updatePin`, `movePin`, `resolvePin`, `deletePin`, + Spike-8 step ops),
the coordinate math, and the feedback `type` discriminator. It imports nothing from React and is
consumed by app, artifact, and overlay alike.

### 3.3 The shared renderer (`@dqa/ui`)

Today's `console/core.mjs` (192 ln) + `console/ui/*` (1,192 ln) is **framework-free vanilla DOM**
decoupled from the store via `store.subscribe()`. This is the genuine rewrite of the migration:
each render module becomes a React component driven by `{ store, options }`. The **capability
gate** is preserved exactly — `options` (`canPlacePins` / `canEditNotes` / `canResolve` /
`canDelete`) is how one renderer serves both the full-access console and the resolve-only
artifact today, and the React port keeps that contract. The feedback `type` discriminator is the
extension point Spikes 11/12 (drawing, element) plug into; a shared `buildBoundsBox(pct)` helper
serves both the element box and rect-kind drawings (per spike cross-synergy note).

### 3.4 Design-system-in-app plan

- **Mirror DesignOS organization**, not its toolchain: tokens → atoms → clusters → app/layout,
  one component per file, co-located variants.
- **Tokens**: lift `styles/tokens.css` (OKLCH CSS variables, theme/density/surface/shadow axes)
  as the in-app source of truth; the design system, console, artifact, and overlay all consume
  the same vocabulary. DesignOS's inline `var(--token)` style pattern ports to React with
  near-zero translation — keeping the port cheap.
- **Accessibility is net-new, not inherited.** DesignOS has no axe, no tests, no focus traps, no
  live regions. The app must *add*: semantic HTML, ARIA where implicit semantics fall short,
  focus management for menus/modals, `:focus-visible` rings (DesignOS has these globally —
  keep), and `aria-live` regions for toasts. Enforced by `eslint-plugin-jsx-a11y` + `axe` in CI.
  This is the single biggest "more than a port" item in the design-system track.

### 3.5 Artifact build under the new toolchain

- `vite-plugin-singlefile` replaces `artifact/build.mjs` — the same self-contained HTML outcome,
  standard tooling, no hand-maintained base64/import-map rewriting.
- **Resolve persistence**: the durable answer (from the standalone-app spike) is the **bundled
  viewer/server** — engineers open the bundle via `http://localhost` instead of `file://`, so
  resolve write-back to the sidecar `session.json` becomes trivial. The existing LocalStorage
  path (`console/store/local-resolve.mjs` → `ArtifactStore`) is retained **only** as the
  no-server `file://` fallback. (Bundle packaging detailed in Proposal C.)

---

## 4. Tradeoffs & risks

- **Build step introduced** (accepted): adds Vite/React/TS to the dependency surface and a build
  to first-boot. Mitigated by the fact that a bespoke build already exists, and by project-local
  managed install (Proposal C).
- **Two render implementations exist during coexistence** (vanilla + React) — real
  dual-maintenance for the migration window. Mitigated by the stable `session.json` seam and the
  flag-gated cutover (Proposal B).
- **Overlay/design-system coupling at build time** — the overlay must rebuild when tokens
  change. This is the point (no drift), but it makes the overlay build depend on the design-
  system package. Acceptable; documented.
- **A11y is additive work**, not a free port — scoped explicitly above so it isn't mistaken for
  lift-and-shift.
- **Inline-style pattern inherited from DesignOS** has known perf/maintainability limits at
  scale (no shared style objects, hover-in-JS). Acceptable for parity now; a CSS-strategy review
  is a candidate later-ritual, not a blocker.

---

## 5. Open questions

- **Relationship to the Claude Design pipeline** (spike open-Q #5): if UI/workflows are
  increasingly authored in Claude Design, does the installed app become the delivery target for
  that output? Carried, not resolved here.
- **Final feedback-record schema sign-off** (drawing/element payloads) — owned by the feedback-
  platform track; the app designs *toward* the POC-validated shapes.
- **Whether the artifact viewer/server is per-bundle or one shared installed viewer** — a
  packaging decision resolved in Proposal C.

---

## 6. Follow-on ritual this unlocks

**"Design-system component inventory + token-parity spec."** Map every DesignOS atom/cluster the
console actually uses to a typed React component with an explicit accessibility contract
(roles, focus order, keyboard map), and pin the token vocabulary the in-app `tokens.css` must
carry. This is the prerequisite for the design-system track of the cut and should run in tandem
with the feedback-platform UX work in Claude Design.
