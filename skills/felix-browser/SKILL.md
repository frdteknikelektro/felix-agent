---
id: felix-browser
name: Felix Browser
description: Remote-control a user-supplied Chrome session over CDP. Use only when the user explicitly says "felix-browser"; never trigger for generic browsing, search, scraping, or URL requests.
version: 1
enabled: true
kind: operational
permissions:
  - felix-browser.navigate
  - felix-browser.submit
match:
  - felix-browser
  - felix browser
---

# Felix Browser

Felix controls an existing Chrome process; it never launches or installs Chrome. Treat the tunnel URL as a bearer credential: do not persist it, log it, or repeat the resolved WebSocket URL.

## Branches

- **First-time setup:** Read [setup](references/setup.md) and stop when the user has OS-specific Chrome and tunnel commands plus the security warning.
- **Connect or operate:** Follow the execution loop below. Read [command reference](references/commands.md) only for the requested operation.
- **Failure:** Read [troubleshooting](references/troubleshooting.md) for the observed symptom. Retry at most once unless that reference says otherwise.

CAPTCHA solving, browser installation, headed/VNC control, and remote desktop control are out of scope.

## Permissions

- `felix-browser.navigate` — Open/read pages; click links; fill, select, check, type, scroll, wait, and capture screenshots.
- `felix-browser.submit` — Submit, login, signup, pay, delete, confirm, upload, or any action that changes remote server state.

Filling a field is navigation; committing it to a server is submit. Before a submit action, require `submit` through the standard flow and stop until granted.

## Execution loop

1. Check the CLI:

   ```bash
   command -v agent-browser >/dev/null
   ```

   If absent, stop and tell the user: `agent-browser is not installed. Run: install agent-browser@0.28.0`.
2. Resolve the connection without exposing it:
   - Accept a full `wss://` CDP URL as-is.
   - For an HTTPS tunnel URL, fetch `/json/version`, require a nonempty `webSocketDebuggerUrl`, and replace its scheme and host with the tunnel's `wss://` host. Use the exact resolver in [commands](references/commands.md).
   - If no URL was supplied in this thread, ask for one and stop.
3. Derive the thread-isolated session:

   ```bash
   SESSION=$(printf '%s' "$THREAD_KEY" | tr ':' '-')
   ```

   Every command must include both `--cdp "$CDP_URL"` and `--session "$SESSION"`.
4. Prove the connection by opening `about:blank`. Continue only on exit code 0.
5. Run a tight snapshot loop:
   - Take a fresh interactive snapshot.
   - Select a ref from that snapshot and perform one requested action.
   - After page-changing actions, wait for an observable condition, then snapshot again.
   - Never reuse refs after the page changes.
6. Stop when the requested page state or extracted value is observed. Report the result conversationally, not as raw CLI output.

Save screenshots only under `$THREAD_DIR/attachments/` after creating the directory. Close the session only when the user explicitly asks; closing the session does not close Chrome.
