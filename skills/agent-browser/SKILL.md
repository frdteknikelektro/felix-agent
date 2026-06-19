---
id: agent-browser
name: Agent Browser
description: Explicit browser automation. Use agent-browser to navigate web pages, extract content, fill forms, take screenshots, and interact with sites. Only activates when the user says "agent-browser".
version: 1
enabled: true
kind: operational
permissions:
  - agent-browser.navigate
  - agent-browser.submit
  - agent-browser.share
match:
  - agent-browser
  - agent browser
  - share browser
  - share session
  - get share url
  - stop sharing
---

# Agent Browser

## Purpose
Navigate web pages, extract content, fill forms, take screenshots, and interact with sites using headless Chrome automation via `agent-browser` CLI. Only triggers when the user explicitly mentions `agent-browser`.

## When to use
- User starts a message with `agent-browser` followed by an instruction
- User asks to navigate to a URL, take a screenshot, scrape content, or fill/submit a form on their behalf
- User says "use agent-browser to ..."
- User says "share browser", "share session", "get share URL", "get shareable link"
- User says "stop sharing"
- This skill is **manual trigger only** — do NOT auto-activate on generic words like "browse", "go to", "search", "look up", "open website", "web", "url", or "scrape". If the user did not say `agent-browser`, fall through to the general skill or reply "I don't have the skill to do that."

## Out of scope
- Automatic web browsing without explicit `agent-browser` invocation
- CAPTCHA solving (requires agent-browser plugin)
- Running a persistent always-on browser
- Automated scheduled scraping

## Permissions

Three permission levels, following the `<service>.<level>` convention:

| Permission | Normalized | Covers |
|---|---|---|
| `agent-browser.navigate` | `agent-browser:agent-browser.navigate` | Open URLs, read content (snapshot, get text, get html), click links, fill text fields, select dropdowns, check/uncheck, scroll, hover, focus, type, take screenshots, wait for elements/load, navigate back/forward/reload |
| `agent-browser.submit` | `agent-browser:agent-browser.submit` | Click submit/login/signup/pay/delete/confirm buttons, upload files — any action that POSTs data to a server or changes server state |
| `agent-browser.share` | `agent-browser:agent-browser.share` | Share browser session externally via VNC + noVNC + bore tunnel, stop sharing |

**Rule of thumb:** If the action changes state on the remote server, it needs `agent-browser.submit`. If it only reads or fills locally, `agent-browser.navigate` is sufficient. Sharing requires `agent-browser.share`.

## Browser lifecycle

**Critical: the browser persists between turns on the same thread. Do not close it unless the user explicitly asks.**

```
Turn 1 (user: "agent-browser open example.com"):
  agent-browser --session "$SESSION" open example.com
  agent-browser --session "$SESSION" snapshot -i
  → daemon + Chrome stay alive after turn ends

Turn 2 (user: "click the contact link"):
  agent-browser --session "$SESSION" click @e3
  → instantly reconnects to same daemon (no cold start)

Turn 3 (user: "close the browser"):
  agent-browser --session "$SESSION" close
  → immediate shutdown

5+ minutes idle between turns:
  → daemon auto-shuts down via AGENT_BROWSER_IDLE_TIMEOUT_MS
  → next cold start takes ~2-5 seconds
```

Lifecycle rules:
1. **Open on first use** — `agent-browser open <url>` auto-starts the daemon + Chrome. No separate start command needed.
2. **Keep alive** — after your work is done, leave the browser running. The next turn on this thread will reconnect instantly.
3. **Close only when asked** — if the user says "close", "stop", "done browsing", "exit", run `agent-browser --session "$SESSION" close`.
4. **Clean up on error** — if Chrome crashes mid-session, run `agent-browser --session "$SESSION" close` then restart.
5. **Don't close for a new URL** — just `open` the new URL. The daemon navigates in-place.

## Environment

Required tools (always available in the runtime image): `agent-browser`, `agent-browser doctor`, `xvfb-run`.

Resolve workspace and thread context from the turn contract:

```bash
# The session contract provides these — use them, do not redefine:
#   THREAD_KEY — e.g. mattermost:abc123:xyz789
#   THREAD_DIR — path to the thread directory

# Sanitize thread key for agent-browser session name
SESSION=$(printf '%s' "$THREAD_KEY" | tr ':' '-')
```

All `agent-browser` commands must use `--session "$SESSION"` for thread-isolated browser instances. This ensures each Felix thread has its own daemon + Chrome with independent cookies/storage/history.

## Core workflow

### 1. Open a page and take a snapshot

```bash
agent-browser --session "$SESSION" open "$URL"
agent-browser --session "$SESSION" snapshot -i -c -d 5
```

Flags:
- `-i` — interactive elements only (buttons, inputs, links)
- `-c` — compact mode (remove empty structural elements)
- `-d 5` — limit tree depth to 5 levels

Output example:
```
- link "Pricing" [ref=e1]
- link "Docs" [ref=e2]
- textbox "Email" [ref=e3]
- button "Sign Up" [ref=e4]
```

### 2. Interact using refs

```bash
agent-browser --session "$SESSION" click @e2
agent-browser --session "$SESSION" fill @e3 "user@example.com"
agent-browser --session "$SESSION" select @e5 "Option B"
agent-browser --session "$SESSION" type @e6 "search query"
agent-browser --session "$SESSION" check @e7
agent-browser --session "$SESSION" scroll down --selector "#main"
```

Refs are valid only for the snapshot they came from. After any action that changes the page, take a fresh snapshot.

### 3. Read content

```bash
agent-browser --session "$SESSION" get text @e1
agent-browser --session "$SESSION" get html @e2
agent-browser --session "$SESSION" get title
agent-browser --session "$SESSION" get url
agent-browser --session "$SESSION" get value @e3
agent-browser --session "$SESSION" snapshot -c
```

### 4. Submit forms (requires `agent-browser.submit` permission)

If the user asks to submit a form, check your granted permissions first. If `agent-browser.submit` is under `need=`, emit PERMISSION_REQUIRED before proceeding.

```bash
# After filling form fields, click the submit button:
agent-browser --session "$SESSION" click @e_submit
agent-browser --session "$SESSION" wait --load networkidle
agent-browser --session "$SESSION" snapshot -i
```

### 5. Take a screenshot

```bash
mkdir -p "$THREAD_DIR/attachments"
agent-browser --session "$SESSION" screenshot "$THREAD_DIR/attachments/screenshot.png"
```

Return the path in your reply: `Screenshot saved: attachments/screenshot.png`

For annotated screenshots (numbered labels matching refs):

```bash
mkdir -p "$THREAD_DIR/attachments"
agent-browser --session "$SESSION" screenshot --annotate "$THREAD_DIR/attachments/annotated.png"
```

### 6. Close (only on user request)

```bash
# Kill share processes if present
if [ -f "$THREAD_DIR/share.state" ]; then
    read VNC_PID WEBSOCKIFY_PID BORE_PID _ < "$THREAD_DIR/share.state"
    kill "$VNC_PID" "$WEBSOCKIFY_PID" "$BORE_PID" 2>/dev/null
    rm -f "$THREAD_DIR/share.state" "$THREAD_DIR/bore.log"
fi

read XVFB_PID _ < "$THREAD_DIR/xvfb.state" 2>/dev/null
agent-browser --session "$SESSION" close
[ -n "$XVFB_PID" ] && kill "$XVFB_PID" 2>/dev/null
rm -f "$THREAD_DIR/xvfb.state"
```

## Wait strategies

Always wait for the page to settle before taking a snapshot or interacting:

```bash
# Wait for a specific element to appear
agent-browser --session "$SESSION" wait "@e3"

# Wait for text content
agent-browser --session "$SESSION" wait --text "Welcome"

# Wait for URL pattern
agent-browser --session "$SESSION" wait --url "**/dashboard"

# Wait for network idle (best for SPA navigation)
agent-browser --session "$SESSION" wait --load networkidle

# Wait for DOM content loaded (faster, for static pages)
agent-browser --session "$SESSION" wait --load domcontentloaded

# Wait for a JavaScript condition
agent-browser --session "$SESSION" wait --fn "document.querySelector('.content') !== null"

# Fixed delay (milliseconds — use sparingly)
agent-browser --session "$SESSION" wait 2000
```

After navigation (click, fill+submit, reload, back, forward), always wait before snapshotting.

## Batch commands

For multi-step workflows, use `batch` to avoid per-command daemon overhead:

```bash
agent-browser --session "$SESSION" batch \
  "open $URL" \
  "wait --load networkidle" \
  "snapshot -i"
```

## Find elements (semantic locators)

When you don't have a ref, use semantic find commands:

```bash
agent-browser --session "$SESSION" find role button click --name "Submit"
agent-browser --session "$SESSION" find text "Contact Us" click
agent-browser --session "$SESSION" find label "Email" fill "user@example.com"
agent-browser --session "$SESSION" find first ".post" text
```

## Headed mode

Use headed mode when:
- The user explicitly requests it (e.g. "use headed mode", "show the browser", "share the screen")
- A site detects and blocks headless Chrome (captcha, blank page, unexpected errors) — **close the current session first**, then reopen in headed mode
- You need to share the browser session (required for VNC/noVNC)

Headed mode renders Chromium through a persistent Xvfb virtual display. Track it per session via `$THREAD_DIR/xvfb.state`.

### Xvfb helper function

Use this helper to ensure Xvfb is running reliably:

```bash
ensure_xvfb() {
    local THREAD_DIR="$1"
    
    # Check if Xvfb is already running
    if [ -f "$THREAD_DIR/xvfb.state" ]; then
        read XVFB_PID _ < "$THREAD_DIR/xvfb.state"
        if kill -0 "$XVFB_PID" 2>/dev/null; then
            read _ DISPLAY < "$THREAD_DIR/xvfb.state"
            export DISPLAY
            return 0
        fi
        # Stale state file, clean up
        rm -f "$THREAD_DIR/xvfb.state"
    fi
    
    # Ensure /tmp/.X11-unix exists with proper permissions
    mkdir -p /tmp/.X11-unix 2>/dev/null || true
    chmod 1777 /tmp/.X11-unix 2>/dev/null || true
    
    # Pick a free display number
    local DISPLAY_NUM
    for DISPLAY_NUM in $(shuf -i 10-99 -n 20); do
        if [ ! -e "/tmp/.X11-unix/X${DISPLAY_NUM}" ]; then
            break
        fi
    done
    
    export DISPLAY=":${DISPLAY_NUM}"
    
    # Start Xvfb with proper cleanup on exit
    nohup Xvfb "$DISPLAY" -screen 0 1920x1080x24 -ac > /tmp/xvfb_${DISPLAY_NUM}.log 2>&1 &
    local XVFB_PID=$!
    
    # Wait for Xvfb to be ready
    local RETRIES=10
    while [ $RETRIES -gt 0 ]; do
        if [ -e "/tmp/.X11-unix/X${DISPLAY_NUM}" ]; then
            break
        fi
        sleep 0.5
        RETRIES=$((RETRIES - 1))
    done
    
    # Verify Xvfb is running
    if ! kill -0 "$XVFB_PID" 2>/dev/null; then
        echo "Failed to start Xvfb" >&2
        return 1
    fi
    
    echo "$XVFB_PID $DISPLAY" > "$THREAD_DIR/xvfb.state"
    return 0
}
```

**Start** (first headed open, or after switching from headless):

```bash
# Kill any stale Xvfb from a previous session
if [ -f "$THREAD_DIR/xvfb.state" ]; then
    read OLD_PID _ < "$THREAD_DIR/xvfb.state"
    kill "$OLD_PID" 2>/dev/null
    rm -f "$THREAD_DIR/xvfb.state"
fi

# Start Xvfb using the helper
ensure_xvfb "$THREAD_DIR"

agent-browser --session "$SESSION" --headed open "$URL"
agent-browser --session "$SESSION" wait --load networkidle
agent-browser --session "$SESSION" --headed snapshot -i
```

**Resume** (subsequent turns — restore DISPLAY before any headed command):

```bash
[ -f "$THREAD_DIR/xvfb.state" ] && { read _ DISPLAY < "$THREAD_DIR/xvfb.state"; export DISPLAY; }
agent-browser --session "$SESSION" --headed snapshot -i
```

**Switch from headless to headed** (close first, then start):

```bash
agent-browser --session "$SESSION" close
# Then follow "Start" above
```

> Once a session is started in headed mode, ALL subsequent commands for that session must include `--headed` and must restore `DISPLAY` from `xvfb.state`. Do not mix headed and headless commands on the same session.

## Session modes

### Thread session (default)
Each Felix thread gets its own isolated browser session. This is the default and recommended mode:
- Cookies, storage, and history are isolated per thread
- Multiple threads can browse independently
- Sessions persist between turns on the same thread

### Owner session (optional)
For cases where the owner wants to share a single browser across multiple threads or have a persistent browsing session:
- Use a fixed session name like `owner-browser` instead of the thread-derived session
- The owner can access the same browser from different threads
- Useful for tasks like "browse with me" or shared research

To use owner session, set `SESSION="owner-browser"` instead of deriving from `THREAD_KEY`.

## Use Cases
Use cases are repeatable operating recipes. Load the relevant reference only when the user's request matches it.

- **Share browser session** — [read reference](references/use-cases/share-browser-session.md) when the user asks to share the browser, get a shareable URL, or allow someone else to take control.

## JavaScript evaluation

For content that the snapshot cannot capture:

```bash
# Simple expression
agent-browser --session "$SESSION" eval "document.title"

# Complex script (use base64 for reliability)
agent-browser --session "$SESSION" eval -b "$(echo 'JSON.stringify(window.__INITIAL_STATE__)' | base64)"

# Or pipe from stdin
echo 'document.querySelectorAll("a").map(a => a.href)' | agent-browser --session "$SESSION" eval --stdin
```

## Error handling

| Symptom | Action |
|---|---|
| `command not found: agent-browser` | Browser tool is not available. Reply: "agent-browser is not installed in this environment." |
| Chrome fails to launch | Run `agent-browser --session "$SESSION" doctor --offline --quick` to diagnose. |
| `Connection refused` / daemon stale | Run `agent-browser --session "$SESSION" close` then retry. |
| Element not found | Re-snapshot and check for consent banners, modals, or page errors. Dismiss overlays first. |
| Page shows captcha or anti-bot page | Close the session first, then reopen in headed mode (see Headed mode section). |
| Snapshot returns empty | Wait for network idle and retry. The page may not have finished rendering. |
| Navigation stalls | Use `wait --load networkidle` with a timeout. If it hangs, close and reopen. |
| `open` fails with DNS, timeout, or HTTP error | Report clearly. DNS failure: "That domain doesn't exist." Timeout: "The site is unreachable." HTTP 4xx/5xx: "The page returned a XXX error." Do not retry more than once. |
| `bore: command not found` | bore is not installed. Run `install bore` first. |
| `x11vnc: command not found` | x11vnc is not installed. Report as runtime error. |
| `websockify: command not found` | websockify is not installed. Report as runtime error. |
| `bore: connection refused` | bore.pub may be down. Retry once. |
| VNC port already in use | Another share may be active. Run `stop-share` first. |
| Share fails in headless mode | Browser must be in headed mode to share. Start with `agent-browser --headed open <url>`. |

## Output format

Return content to the user through FELIX_REPLY:

**Page content:**
```
## Page content from example.com

**Title:** Example Domain

The page contains a heading "Example Domain" and a link to "More information..."
```

**Screenshot:**
```
Screenshot saved: attachments/example-page.png
The page shows a login form with email and password fields.
```

**Error:**
```
agent-browser could not load that page. The connection timed out — the site may be down or blocked.
```

**Share:**
```
## Browser shared!

**URL:** https://abc123.bore.pub

Open this URL to take control of the browser session. This URL is disposable and closes when you close the browser.
```

**Stop share:**
```
Browser sharing stopped. The browser session is still active.
```

Do not expose internal session names, daemon paths, or agent-browser configuration in replies.

## Checks
- Always use `--session "$SESSION"` — never run agent-browser without a session flag
- Sanitize `$THREAD_KEY` by replacing `:` with `-` — colons in thread keys break session names
- Always wait after navigation before snapshotting or interacting
- Re-snapshot after any action that changes the page (clicks, form fills, scrolls)
- Check your granted permissions before attempting a form submit — if `agent-browser.submit` is `need=`, emit PERMISSION_REQUIRED
- Check your granted permissions before attempting to share — if `agent-browser.share` is `need=`, emit PERMISSION_REQUIRED
- Do not close the browser unless the user explicitly asks
- Ensure `$THREAD_DIR/attachments/` exists (`mkdir -p`) before saving screenshots
- Save screenshots to `$THREAD_DIR/attachments/` — never to system temp directories
- For headed sessions: restore `DISPLAY` from `$THREAD_DIR/xvfb.state` before every headed command
- For headed sessions: always use `--headed` on all commands — mixing headed and headless on the same session breaks it
- Clean up Xvfb when closing: `kill` the PID from `$THREAD_DIR/xvfb.state`, then `rm` the file
- Clean up share processes when closing: kill VNC, websockify, bore PIDs from `$THREAD_DIR/share.state`, then `rm` the file
- Always check if headed mode is running before attempting to share
- Ensure `$THREAD_DIR/share.state` is cleaned up on `close`
- Do not start duplicate share sessions — return existing URL if already sharing
- Verify bore is installed before attempting to share (`command -v bore`)
- Report clear, conversational results — not raw agent-browser command output
- If a navigation receives a non-HTTP response (PDF, image, binary), save it to attachments and report the path
- For login flows, set cookies on `about:blank` before navigating to the target domain (pre-navigation setup)
