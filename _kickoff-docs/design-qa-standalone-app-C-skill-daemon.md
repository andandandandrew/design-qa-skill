# Proposal C — Skill workflow & daemon changes

**Type:** PROPOSAL (2026-05-31). Output of the standalone-app planning ritual. Sibling docs:
**Proposal A** (target architecture & toolchain), **Proposal B** (migration & sequencing).
Proposal only — no code, no schedule commitment.

Governing values: **safety, efficiency, security, accessibility, team-maintainability.**

---

## 1. Context

Today the skill (`.claude/skills/design-qa/`) *is* the runtime: `start` spawns
`session-server.mjs` detached, which serves the raw-`.mjs` console over localhost and drives
Playwright; `end` finalizes via Unix-socket IPC and builds the artifact. There is no separate
"app" — the code only runs when the skill is invoked.

The migration's load-bearing insight (from `design-qa-standalone-app.md`): **relocating the app
does not remove the Node-server dependency.** The console always needs a server to read/write
`session.json` and drive Playwright. So "standalone app" does *not* mean "no daemon" — it means
the skill **builds, installs, and serves a real app** instead of serving loose modules, and the
daemon serves **built assets**.

Resolved fork: the app is **installed project-local (`.design-qa/`), managed/replaced on update,
not hand-editable** — drift-free.

---

## 2. What stays vs. what changes

**The skill becomes the orchestration + daemon layer.** Internals are largely intact:

| Component | Change |
|---|---|
| `session-server.mjs` (daemon entry) | **Minor** — serve built app assets instead of raw `.mjs`; otherwise wires the same pieces. |
| `lib/http-server.mjs` | **Minor** — static-asset routes serve the **built** bundle (`dist/`); `/api/*` routes (`/api/session`, `/api/sessions`, `POST /api/mutate`, `POST /api/upload`, SSE `/api/events`, screenshots) unchanged. |
| `lib/capture.mjs`, `lib/recorder.mjs` | **Unchanged** — Playwright capture + overlay injection identical (overlay stays vanilla per Proposal A). |
| `lib/ipc.mjs`, `lib/paths.mjs` | **Unchanged** — socket/PID/pointer-file lifecycle + watchdog preserved. |
| `lib/session.mjs`, `lib/redact.mjs`, `lib/coords.mjs` | **Ported** into `@dqa/core` (shared with the app); daemon imports the same modules. |
| `cli.mjs` | **Changed** — gains the build/install/version-check step before spawning the daemon. |
| `artifact/build.mjs` | **Replaced** by the Vite single-file target + viewer/server packaging. |

**New responsibility: install/boot/update/serve.** The skill builds the app from its bundled
source into the project-local managed location on first boot and keeps it current.

---

## 3. Install / boot / update / serve model

- **Install target:** project-local `.design-qa/` (gitignored), **managed** — built from the
  skill's bundled app source, replaced on update, not hand-editable.
- **First `start`:**
  1. Resolve `.design-qa/`; if absent or stale, **build** the app from skill source into it.
  2. Stamp the install with the **skill version** (`.design-qa/.version`).
  3. Spawn the daemon (`session-server.mjs`) detached; serve `dist/` over localhost.
  4. Poll the lifecycle socket for `ready` (existing 30s timeout); open console + headed Chromium.
- **Version/drift check:** on every `start`, compare skill version ↔ `.design-qa/.version`.
  Mismatch ⇒ rebuild (managed install means no user edits to preserve). This is the entire
  drift story — there is no two-way sync because the install is never hand-edited.
- **Build cost:** first boot pays a one-time Vite build; subsequent boots reuse `dist/` unless
  the version stamp changed. (Open question §6: ship prebuilt `dist/` in the skill to skip even
  the first-boot build.)
- **Serve:** the daemon serves the built console; capture is unchanged. The artifact's
  **bundled viewer/server** is the same idea at export scope (below).

---

## 4. `start` / `end` / `help` changes

- **`start.md`** — add, before daemon spawn: verify Node, **build/install the app to
  `.design-qa/` if missing/stale**, version-stamp. Everything after (spawn, poll socket, open
  browser) is unchanged. The Playwright check stays.
- **`end.md`** — finalize unchanged through IPC, but the artifact step now invokes the **Vite
  single-file build** and **emits the viewer/server into the bundle** (so engineers open via
  `localhost` and resolves persist to the sidecar `session.json`). The watchdog fallback
  (read `session.json` + build artifact if the daemon is unreachable) is preserved.
- **`help.md`** — document the new boot model (project-local managed install, version stamp,
  build-on-first-boot) and the viewer/server-based artifact.
- **`SKILL.md`** — update the architecture overview to describe the built app + the
  orchestration/daemon split.

---

## 5. Every file/command touched + what breaks

**Touched (skill + scripts):**
- `SKILL.md`, `start.md`, `end.md`, `help.md` — boot model + artifact docs.
- `cli.mjs` — build/install/version-check step.
- `session-server.mjs`, `lib/http-server.mjs` — serve built `dist/` instead of raw `.mjs`.
- `artifact/build.mjs` — replaced by Vite single-file + viewer/server packaging.
- New: the app source tree (Proposal A) bundled with the skill; `.design-qa/` install dir;
  `.design-qa/.version` stamp.

**What breaks / what doesn't:**
- **Existing live sessions** (mid-flight daemons): unaffected during coexistence — the React
  console reads the same `session.json` (Proposal B); the buildless console stays available
  behind the flag until Phase 3.
- **In-flight `session.json` data:** **no on-disk migration needed.** Schema stays v4; the
  feedback `type` discriminator defaults to `'text'`; `lib/session.mjs` migrations (now in
  `@dqa/core/session`) remain the upgrade path. Old sessions open in the new console as-is.
- **Already-exported artifacts:** keep working via the LocalStorage fallback; only **new**
  exports gain the viewer/server. No regression.
- **First-boot latency:** new — the one-time build. Mitigable by shipping prebuilt `dist/`.

---

## 6. Open questions

- **Viewer/server shape** (spike open-Q #3): is it a tiny static server **bundled per export**,
  or **one shared "Design QA viewer"** installed once that opens any bundle? Leaning shared
  installed viewer (less duplication per export, single thing to harden), but unresolved.
- **Ship prebuilt `dist/` with the skill?** Avoids first-boot build cost at the price of a
  larger skill payload and a build-artifact in version control. Trade to decide.
- **`.design-qa/` location** when multiple repos/sessions share a machine — confirm project-
  local is right vs. a per-user cache keyed by project path.
- **Migration of a daemon that is live at cutover** — graceful handoff vs. require restart.

---

## 7. Follow-on ritual this unlocks

**"Daemon boot-protocol + install/version spec."** Nail the build-on-first-boot contract, the
version-stamp/drift check, the viewer/server packaging (per-export vs shared installed), the
prebuilt-`dist` decision, and the exact `start`/`end`/`cli` diffs. This is the spec that makes
Proposal B's Phase 0 (scaffold) and Phase 4 (artifact + viewer/server) executable on the skill
side.
