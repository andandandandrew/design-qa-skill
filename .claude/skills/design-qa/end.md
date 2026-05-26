# /design-qa end

Finalize the active design QA session. Captures any pending screenshot for the current view, builds the HTML artifact, shuts down the daemon, and prints the artifact path.

## Steps

```
[ ] Step 0 — [SCRIPT] Locate the active session
[ ] Step 1 — [SCRIPT] Send `end` to the daemon
[ ] Step 2 — [LLM]    Report artifact path
```

## Step 0 — [SCRIPT] Locate the active session

The CLI infers the active session by scanning `<cwd>/design-qa-sessions/` for the most recently created session directory with a live `daemon.pid`. If multiple live sessions exist, fail with a list and ask the designer to pass `--session <name-or-path>`.

```bash
node .claude/skills/design-qa/scripts/cli.mjs end --root "$(pwd)/design-qa-sessions"
```

If `$ARGUMENTS` contained a session name or path, pass it as `--session <value>`.

## Step 1 — [SCRIPT] End the session

The CLI:
- Connects to `<session-dir>/daemon.sock`.
- Sends `{type: "end"}`.
- The daemon screenshots the current page (if a view is active with pins but no screenshot), writes `screenshots/<view-id>.png`, builds `artifact.html`, removes the socket + PID file, and exits.
- The CLI prints a JSON line: `{"sessionDir": "...", "artifact": "...", "viewCount": N, "pinCount": N}`.

If the daemon is unreachable (socket missing, no response in 30s), the CLI tries a fallback: read `session.json` directly and build the artifact from whatever screenshots exist. Report this fallback in the result so the designer knows the live capture didn't happen.

## Step 2 — [LLM] Report

Print one line: `Artifact: <artifact path>` plus the view + pin counts. That's it.
