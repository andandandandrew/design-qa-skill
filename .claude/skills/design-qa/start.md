# /design-qa start &lt;session-name&gt;

Start a new design QA session. Spawns a detached Node **session server** that (1) serves the buildless review/authoring console over `127.0.0.1`, and (2) attaches a headed Chromium browser with the annotation overlay injected for live capture. Creates a session directory under `<cwd>/design-qa-sessions/`.

## Steps

```
[ ] Step 0   — [SCRIPT] Verify Node + Playwright installation
[ ] Step 1   — [SCRIPT] Validate session name
[ ] Step 1.5 — [LLM]    First-run config init (only if config is missing)
[ ] Step 2   — [SCRIPT] Spawn detached daemon and wait for ready
[ ] Step 3   — [LLM]    Report session info to the designer
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

## Step 1.5 — [LLM] First-run config init

Each working directory keeps a `design-qa.config.json` (sibling of `design-qa-sessions/`) holding project name, stack, derived `captureMode`, and author identity. The session server stamps every new pin with this author. Check whether it already exists:

```bash
node .claude/skills/design-qa/scripts/cli.mjs check-config --root "$(pwd)/design-qa-sessions"
```

The CLI prints a single JSON line: `{"exists": <bool>, "configPath": "...", "config": {...}|null}`.

**If `exists: true`** — skip this step silently and proceed to Step 2.

**If `exists: false`** — ask the designer the following in this conversation (use `AskUserQuestion` with the exact headers below; the chip values listed are the four options to offer per question, with "Other" automatically appended by the tool):

1. *Project / client name* (free-text via "Other") — header `"Project"`.
2. *Stack* — header `"Stack"`. Offer chips: `"React web"`, `"React Native"`, `"Other web"`, `"Other"`. The string the user picks goes verbatim into the config.
3. *Author name* (free-text via "Other") — header `"Your name"`.
4. *Email* (optional; free-text via "Other"; user can pick "Skip") — header `"Email"`. Treat "Skip" as null.

Then write the config, passing the collected values as a single JSON object:

```bash
node .claude/skills/design-qa/scripts/cli.mjs write-config \
  --root "$(pwd)/design-qa-sessions" \
  --json '{"project":"<project>","stack":"<stack>","author":{"name":"<name>","email":<null-or-"...">}}'
```

The CLI derives `captureMode` from `stack` and prints `{"ok":true,"configPath":"...","config":{...}}`. If it errors, surface the message and stop.

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
