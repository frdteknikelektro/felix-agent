---
id: felix-browser
name: Felix Browser
description: Remote browser automation via CDP. Connect to the user's existing Chrome instance over the internet and automate it. Felix never launches a browser — the user provides a CDP endpoint exposed through a tunnel. Only activates when the user says "felix-browser".
version: 1
enabled: true
kind: operational
permissions:
  - felix-browser.navigate
  - felix-browser.submit
env:
  - key: TUNNEL_URL
    description: CDP tunnel endpoint (e.g., https://your-tunnel.example.com)
    required: true
match:
  - felix-browser
  - felix browser
---

# Felix Browser

## Purpose
Connect to a user-provided remote Chrome instance via Chrome DevTools Protocol (CDP) and automate it. Felix never launches or manages a browser — the user runs Chrome on their machine, exposes its debugging port through a tunnel, and provides the tunnel URL. Felix auto-resolves the CDP WebSocket endpoint and `agent-browser` CLI connects to it.

Only triggers when the user explicitly mentions `felix-browser`.

## When to use
- User says "felix-browser connect to https://abc.ngrok-free.app"
- User says "felix-browser open example.com"
- User says "help me set up felix-browser" or "how do I expose my Chrome"
- User provides a tunnel URL and asks to browse, screenshot, scrape, or fill/submit a form
- This skill is **manual trigger only** — do NOT auto-activate on generic words like "browse", "go to", "search", "look up", "open website", "web", "url", or "scrape".

## Out of scope
- Launching or installing Chrome — the user manages their own browser
- Automatic web browsing without explicit `felix-browser` invocation
- Headed mode, VNC sharing, or remote desktop control
- CAPTCHA solving

## Permissions

Two permission levels:

| Permission | Normalized | Covers |
|---|---|---|
| `felix-browser.navigate` | `felix-browser:felix-browser.navigate` | Open URLs, read content (snapshot, get text, get html), click links, fill text fields, select dropdowns, check/uncheck, scroll, hover, focus, type, take screenshots, wait for elements/load, navigate back/forward/reload |
| `felix-browser.submit` | `felix-browser:felix-browser.submit` | Click submit/login/signup/pay/delete/confirm buttons, upload files — any action that POSTs data to a server or changes server state |

**Rule of thumb:** If the action changes state on the remote server, it needs `felix-browser.submit`. If it only reads or fills locally, `felix-browser.navigate` is sufficient.

## Prerequisites

`agent-browser` CLI must be installed. Check at the start of every turn:

```bash
if ! command -v agent-browser &>/dev/null; then
  echo "agent-browser is not installed. Run: install agent-browser@0.28.0"
  exit 1
fi
```

## User onboarding — exposing Chrome via tunnel

When the user asks how to set up felix-browser (but hasn't provided a CDP URL yet), walk them through these steps:

### Step 1: Launch Chrome with remote debugging

The user runs Chrome with remote debugging enabled. Always use a separate profile so existing Chrome sessions are not affected.

**macOS:**
```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug
```

**Linux (Ubuntu/Debian):**
```bash
google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug
```

**Windows:**
```bash
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir=%TEMP%\chrome-debug
```

`--user-data-dir` uses a separate profile so Chrome can be running normally at the same time. If the directory does not exist, Chrome creates it.

### Step 2: Expose the port via tunnel

Choose one of these approaches:

**ngrok:**
```bash
ngrok http 9222 --host-header="localhost:9222"
```
- `--host-header` flag is required for WebSocket to work

**cloudflared:**
```bash
cloudflared tunnel --http-host-header localhost:9222 --url http://localhost:9222
```
- `--http-host-header` flag helps with WebSocket support

The user will see a public URL like `https://abc123.ngrok-free.app` or `https://abc123.trycloudflare.com`.

### Step 3: Send the tunnel URL to felix

The user just sends the tunnel URL. Felix auto-resolves the CDP WebSocket endpoint by fetching `/json/version` from the tunnel.

```
felix-browser connect to https://abc123.ngrok-free.app
```

Felix will:
1. Fetch `$TUNNEL_URL/json/version` to discover the CDP WebSocket URL
2. Convert it to `wss://` using the tunnel host
3. Connect via `agent-browser --cdp`

The URL is sensitive — anyone with it can control the user's browser. Felix does not store or log it.

## Connection — establishing the CDP link

When the user provides a tunnel URL (e.g., `https://abc.ngrok-free.app`), auto-resolve the CDP WebSocket endpoint:

```bash
TUNNEL_URL="https://abc.ngrok-free.app"

# Fetch CDP WebSocket URL from the tunnel
CDP_WS=$(curl -s "$TUNNEL_URL/json/version" | jq -r '.webSocketDebuggerUrl')
# Output: ws://localhost:9222/devtools/browser/<uuid>

# Convert to wss:// with the tunnel host
TUNNEL_HOST=$(echo "$TUNNEL_URL" | sed 's|https://||' | sed 's|http://||')
CDP_URL="wss://${TUNNEL_HOST}${CDP_WS#*://}"
# Result: wss://abc.ngrok-free.app/devtools/browser/<uuid>
```

If the user provides a full `wss://` URL directly, use it as-is.

### First connection test

Verify the CDP endpoint is reachable before doing any work:

```bash
agent-browser --cdp "$CDP_URL" --session "$SESSION" open about:blank
```

If this fails, the CDP URL may be wrong, the tunnel may be down, or Chrome may have been closed. Ask the user to re-check.

### Using the CDP URL

The `--cdp` flag must be on every command:

```bash
agent-browser --cdp "$CDP_URL" --session "$SESSION" <command>
```

## Environment

Resolve workspace and thread context from the turn contract:

```bash
# The session contract provides these — use them, do not redefine:
#   THREAD_KEY — e.g. mattermost:abc123:xyz789
#   THREAD_DIR — path to the thread directory

# Sanitize thread key for agent-browser session name
SESSION=$(printf '%s' "$THREAD_KEY" | tr ':' '-')
```

## Core workflow

All commands include `--cdp "$CDP_URL"`. The `--session "$SESSION"` flag ensures thread-isolated browsing within the same Chrome instance.

### 1. Open a page and take a snapshot

```bash
agent-browser --cdp "$CDP_URL" --session "$SESSION" open "$URL"
agent-browser --cdp "$CDP_URL" --session "$SESSION" wait --load networkidle
agent-browser --cdp "$CDP_URL" --session "$SESSION" snapshot -i -c -d 5
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
agent-browser --cdp "$CDP_URL" --session "$SESSION" click @e2
agent-browser --cdp "$CDP_URL" --session "$SESSION" fill @e3 "user@example.com"
agent-browser --cdp "$CDP_URL" --session "$SESSION" select @e5 "Option B"
agent-browser --cdp "$CDP_URL" --session "$SESSION" type @e6 "search query"
agent-browser --cdp "$CDP_URL" --session "$SESSION" check @e7
agent-browser --cdp "$CDP_URL" --session "$SESSION" scroll down --selector "#main"
```

Refs are valid only for the snapshot they came from. After any action that changes the page, take a fresh snapshot.

### 3. Read content

```bash
agent-browser --cdp "$CDP_URL" --session "$SESSION" get text @e1
agent-browser --cdp "$CDP_URL" --session "$SESSION" get html @e2
agent-browser --cdp "$CDP_URL" --session "$SESSION" get title
agent-browser --cdp "$CDP_URL" --session "$SESSION" get url
agent-browser --cdp "$CDP_URL" --session "$SESSION" get value @e3
agent-browser --cdp "$CDP_URL" --session "$SESSION" snapshot -c
```

### 4. Submit forms (requires `felix-browser.submit` permission)

If the user asks to submit a form, check your granted permissions first. If `felix-browser.submit` is under `need=`, emit PERMISSION_REQUIRED before proceeding.

```bash
agent-browser --cdp "$CDP_URL" --session "$SESSION" click @e_submit
agent-browser --cdp "$CDP_URL" --session "$SESSION" wait --load networkidle
agent-browser --cdp "$CDP_URL" --session "$SESSION" snapshot -i
```

### 5. Take a screenshot

```bash
mkdir -p "$THREAD_DIR/attachments"
agent-browser --cdp "$CDP_URL" --session "$SESSION" screenshot "$THREAD_DIR/attachments/screenshot.png"
```

Return the path in your reply: `Screenshot saved: attachments/screenshot.png`

For annotated screenshots:

```bash
mkdir -p "$THREAD_DIR/attachments"
agent-browser --cdp "$CDP_URL" --session "$SESSION" screenshot --annotate "$THREAD_DIR/attachments/annotated.png"
```

### 6. Close the session (only on user request)

```bash
agent-browser --cdp "$CDP_URL" --session "$SESSION" close
```

This closes felix's session within the browser — it does NOT close the user's Chrome.

## Wait strategies

Always wait for the page to settle before taking a snapshot or interacting:

```bash
agent-browser --cdp "$CDP_URL" --session "$SESSION" wait "@e3"
agent-browser --cdp "$CDP_URL" --session "$SESSION" wait --text "Welcome"
agent-browser --cdp "$CDP_URL" --session "$SESSION" wait --url "**/dashboard"
agent-browser --cdp "$CDP_URL" --session "$SESSION" wait --load networkidle
agent-browser --cdp "$CDP_URL" --session "$SESSION" wait --load domcontentloaded
agent-browser --cdp "$CDP_URL" --session "$SESSION" wait --fn "document.querySelector('.content') !== null"
agent-browser --cdp "$CDP_URL" --session "$SESSION" wait 2000
```

After navigation (click, fill+submit, reload, back, forward), always wait before snapshotting.

## Batch commands

```bash
agent-browser --cdp "$CDP_URL" --session "$SESSION" batch \
  "open $URL" \
  "wait --load networkidle" \
  "snapshot -i"
```

## Find elements (semantic locators)

```bash
agent-browser --cdp "$CDP_URL" --session "$SESSION" find role button click --name "Submit"
agent-browser --cdp "$CDP_URL" --session "$SESSION" find text "Contact Us" click
agent-browser --cdp "$CDP_URL" --session "$SESSION" find label "Email" fill "user@example.com"
agent-browser --cdp "$CDP_URL" --session "$SESSION" find first ".post" text
```

## JavaScript evaluation

```bash
agent-browser --cdp "$CDP_URL" --session "$SESSION" eval "document.title"
agent-browser --cdp "$CDP_URL" --session "$SESSION" eval -b "$(echo 'JSON.stringify(window.__INITIAL_STATE__)' | base64)"
echo 'document.querySelectorAll("a").map(a => a.href)' | agent-browser --cdp "$CDP_URL" --session "$SESSION" eval --stdin
```

## Error handling

| Symptom | Action |
|---|---|
| No CDP URL provided | Reply: "I need a tunnel URL to connect to. Run Chrome with `--remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug`, expose it via ngrok or cloudflared, and send me the tunnel URL." |
| `command not found: agent-browser` | CLI is not installed. Reply: "agent-browser is not installed. Run `install agent-browser@0.28.0` first." |
| Connection refused / timeout | The CDP endpoint is unreachable. Ask the user: "Is Chrome still running with `--remote-debugging-port=9222`? Is the tunnel still up? Can you re-share the tunnel URL?" |
| HTTP 530 with ngrok/cloudflared | Tunnel is blocking WebSocket connections. Try: 1) Use `--host-header="localhost:9222"` for ngrok, 2) Use `--http-host-header localhost:9222` for cloudflared, 3) Ask user to re-check tunnel setup |
| `/json/version` fetch fails | The tunnel is up but Chrome's CDP is not reachable through it. Ask the user to verify Chrome is running with `--remote-debugging-port=9222`. |
| Element not found | Re-snapshot and check for consent banners, modals, or page errors. Dismiss overlays first. |
| Page shows captcha or anti-bot page | Report to user. The user sees the same page in their Chrome and can solve it manually. |
| Snapshot returns empty | Wait for network idle and retry. The page may not have finished rendering. |
| Navigation stalls | Use `wait --load networkidle` with a timeout. Retry once. |
| `open` fails with DNS, timeout, or HTTP error | DNS failure: "That domain doesn't exist." Timeout: "The site is unreachable." HTTP 4xx/5xx: "The page returned a XXX error." Do not retry more than once. |
| IPv6 unreachable | Container may lack IPv6 routing. User needs to enable IPv6 on server, or use a tunnel that handles IPv4 only. |

## Output format

Return content through FELIX_REPLY:

**Setup guide (first time):**
```
## Setting up felix-browser

1. Launch Chrome with remote debugging:
   macOS:   /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug
   Linux:   google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug
   Windows: "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir=%TEMP%\chrome-debug

2. Expose the port via tunnel:
   ngrok:       ngrok http 9222 --host-header="localhost:9222"
   cloudflared: cloudflared tunnel --http-host-header localhost:9222 --url http://localhost:9222

3. Send me the tunnel URL:
   felix-browser connect to https://abc.ngrok-free.app
```

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
Cannot connect to the browser. Is Chrome still running with --remote-debugging-port=9222 and is the tunnel active?
```

Do not expose internal session names, daemon paths, or the raw CDP URL in replies after the initial connection.

## Checks
- Always use `--cdp "$CDP_URL"` on every `agent-browser` command — without it there is no browser to control
- Always use `--session "$SESSION"` — never run agent-browser without a session flag
- Sanitize `$THREAD_KEY` by replacing `:` with `-`
- Always wait after navigation before snapshotting or interacting
- Re-snapshot after any action that changes the page
- Check your granted permissions before attempting a form submit — if `felix-browser.submit` is `need=`, emit PERMISSION_REQUIRED
- Do not close the browser session unless the user explicitly asks
- `close` only ends felix's session — it does NOT close the user's Chrome
- If the CDP URL changes (tunnel restarted), ask the user for the new URL
- Ensure `$THREAD_DIR/attachments/` exists (`mkdir -p`) before saving screenshots
- Save screenshots to `$THREAD_DIR/attachments/` — never to system temp directories
- Check that `agent-browser` is installed before any command
- Report clear, conversational results — not raw agent-browser command output
- For login flows, set cookies on `about:blank` before navigating to the target domain
