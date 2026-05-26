---
name: design-qa
description: "Authoring environment for visual QA feedback on running web apps. Designers place pin annotations against a live browser; the skill exports a portable HTML artifact engineers consume."
allowed-tools: Read, Write, Edit, Bash
---

# /design-qa

Visual QA authoring skill. Designers QA running web apps by navigating to pages, examining what's there, and placing pin annotations against the live DOM. The skill drives a headed Chromium browser, injects an annotation overlay, captures screenshots on navigation, and exports a self-contained HTML artifact for engineers.

**Usage:** `/design-qa <command> [args]`

If no subcommand is provided, read and follow `.claude/skills/design-qa/help.md`.

Based on the subcommand, read the corresponding workflow file and follow it completely:

### Lifecycle
- `start <session-name>` → read `.claude/skills/design-qa/start.md`
- `end` → read `.claude/skills/design-qa/end.md`
- `resume <session-name>` → not implemented in v1 slice. Tell the user this and stop.

### Phase 2 (reserved, not in v1)
- `annotate <natural-language>` — LLM-assisted pin placement. Not implemented.

### Utility
- `help` → read `.claude/skills/design-qa/help.md`

---

## Architecture (one-time read)

The skill drives a long-lived **session server** — a detached Node process that is the sole writer of `session.json`. It wears two hats: it always serves the buildless review/authoring **console** over `127.0.0.1` (static assets + `/api/session` + `/api/sessions` + `/screenshots/...` + `POST /api/mutate` + `/api/events` SSE), and it lazy-attaches a headed Chromium browser via Playwright for live capture (suppressible with `--no-capture`). Each `/design-qa <cmd>` invocation is a short-lived CLI that talks to the server over a Unix socket for lifecycle (ping/status/end).

- **State of record:** `<session-dir>/session.json`. The server owns all writes — browser-overlay pins (px, via `window.__designQA.*` bindings) and console edits (`%`, via `POST /api/mutate`) both funnel through one `SessionStore`. Live-screen ownership: an unsealed browser screen is browser-owned (overlay-edited, locked in the console); everything sealed + every manual screen is console-editable.
- **Implicit capture:** views are created on first pin placement (auto-named from `document.title`); screenshots are taken on navigation-away or on `end`.
- **No per-pin commands:** all pin authoring (place, edit, drag, delete) happens in the browser overlay. The inspector panel inside the browser handles view-level operations.
- **Browser ↔ pin disambiguation:** the designer clicks an "Add pin" button in the overlay to enter pin-placement mode; the next click on the page becomes a pin and mode exits.

### Files

```
.claude/skills/design-qa/
  SKILL.md, start.md, end.md, help.md   # workflow files
  scripts/
    package.json
    cli.mjs                              # invoked by skill steps
    session-server.mjs                   # spawned detached by `start` (console + capture)
    lib/{session,ipc,paths,capture,http-server,coords}.mjs
    console/                             # buildless review/authoring console (served over localhost)
    overlay/inject.js                    # injected into every page
    artifact/build.mjs                   # builds artifact.html on `end`
```

### Session dir layout

```
<cwd>/design-qa-sessions/<timestamp>-<session-name>/
  session.json          # source of truth
  daemon.pid            # server PID (removed on clean exit)
  daemon.log            # server stdout+stderr
  console.url           # this session's live console URL (removed on clean exit)
  browser-profile/      # Playwright persistentContext userDataDir
  screenshots/<view-id>.png
  artifact.html         # produced on `end`
```

The lifecycle Unix socket lives in `os.tmpdir()` (derived from the session dir hash), not the session dir, because macOS caps socket path length.

The session server is the only writer of `session.json`. Neither the browser overlay nor the console writes to disk directly; both round-trip through the server.
