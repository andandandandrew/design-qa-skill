# /design-qa start &lt;session-name&gt;

Start a new design QA session. Spawns a detached Node **session server** that (1) serves the buildless review/authoring console over `127.0.0.1`, and (2) attaches a headed Chromium browser with the annotation overlay injected for live capture. Creates a session directory under `<cwd>/design-qa-sessions/`.

## Steps

```
[ ] Step 0 — [SCRIPT] Verify Node + Playwright installation
[ ] Step 1 — [SCRIPT] Validate session name
[ ] Step 2 — [SCRIPT] Spawn detached daemon and wait for ready
[ ] Step 3 — [LLM]    Report session info to the designer
```

## Step 0 — [SCRIPT] Verify Node + Playwright

Run:

```bash
node --version
test -d .claude/skills/design-qa/scripts/node_modules/playwright || echo "MISSING_PLAYWRIGHT"
```

If `MISSING_PLAYWRIGHT` is printed, install:

```bash
(cd .claude/skills/design-qa/scripts && npm install && npx playwright install chromium)
```

Stop on failure with the install command output.

## Step 1 — [SCRIPT] Validate session name

Session name from `$ARGUMENTS`. Must match `^[a-z0-9][a-z0-9-]{0,63}$`. If invalid, stop and explain.

## Step 2 — [SCRIPT] Spawn daemon

Run:

```bash
node .claude/skills/design-qa/scripts/cli.mjs start --name <session-name> --root "$(pwd)/design-qa-sessions"
```

The CLI:
- Creates the session directory (`<root>/<timestamp>-<name>/`).
- Spawns `session-server.mjs` detached, with stdout/stderr redirected to `<session-dir>/daemon.log`.
- Waits up to 30s for the server to bind its Unix socket and report `ready`.
- Prints a single JSON line to stdout: `{"sessionDir": "...", "pid": N, "consoleUrl": "http://127.0.0.1:PORT/"}`.
- Exits non-zero with stderr on failure (server crashed, socket never appeared, etc.).

Capture the JSON. If the command exits non-zero, surface `daemon.log` contents and stop.

## Step 3 — [LLM] Report

Tell the designer (concise — they're about to switch to the browser):

- Session directory: `<sessionDir>` (one line, full path)
- The review **console** opened automatically at `<consoleUrl>` in your browser
- A separate Chromium window is open at about:blank — navigate to the app, then click **"Add pin"** in the overlay to place pins; they appear live in the console
- Run `/design-qa end` when done

Do not narrate architecture. They just need the paths and the next action.
