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
match:
  - felix-browser
  - felix browser
---

# Felix Browser

## Purpose
Connect to a user-provided remote Chrome instance via Chrome DevTools Protocol (CDP) and automate it. Felix never launches or manages a browser — the user runs Chrome on their machine, exposes its debugging port through a tunnel, and provides the CDP endpoint. `agent-browser` CLI connects to that endpoint and drives the browser.

Only triggers when the user explicitly mentions `felix-browser`.

## When to use
- User says "felix-browser connect to wss://abc.bore.pub/devtools/..."
- User says "felix-browser open example.com"
- User says "help me set up felix-browser" or "how do I expose my Chrome"
- User provides a CDP URL and asks to browse, screenshot, scrape, or fill/submit a form
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

The user runs Chrome with remote debugging enabled. This opens a CDP endpoint.

**macOS:**
```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-address=0.0.0.0 --remote-debugging-port=9222
```

**Linux:**
```bash
google-chrome --remote-debugging-address=0.0.0.0 --remote-debugging-port=9222
```

**Windows:**
```bash
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-address=0.0.0.0 --remote-debugging-port=9222
```

`--remote-debugging-address=0.0.0.0` makes Chrome listen on all interfaces — required for Docker's `host.docker.internal` to reach it. If Chrome is already running, close it first or use a separate profile:
```bash
google-chrome --remote-debugging-address=0.0.0.0 --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug
```

### Step 2: Make the port reachable

Choose one of these approaches:

#### Option A — tunnel (Chrome on any machine, universal)

The debugging port (`localhost:9222`) must be reachable from the internet. The user can use any tunneling tool.

**bore (recommended — simplest):**
```bash
# Install: https://github.com/ekzhang/bore
bore local 9222 --to bore.pub
```
Output: `listening at bore.pub:12345` → tunneled to `bore.pub:12345`

**ngrok:**
```bash
ngrok http 9222
```

**cloudflared:**
```bash
cloudflared tunnel --url http://localhost:9222
```

#### Option B — same machine (Chrome and Docker on the same host)

If Chrome and the felix container run on the same machine, no tunnel is needed. The container can reach the host at `host.docker.internal`:

```bash
# Already done in Step 1: Chrome listens on 0.0.0.0:9222
# Get the CDP URL:
curl -s http://localhost:9222/json/version | grep -o '"webSocketDebuggerUrl": "[^"]*"' | cut -d'"' -f4
```

Replace `localhost` with `host.docker.internal`:
```
ws://host.docker.internal:9222/devtools/browser/<uuid>
```

This requires `extra_hosts` in docker-compose or `--add-host` in docker run (both already configured in the project).

### Step 3: Get the CDP WebSocket URL

**With a tunnel:**

Once the tunnel is up, get the CDP endpoint:

Once the tunnel is up, get the CDP endpoint:

```bash
curl -s http://localhost:9222/json/version | grep -o '"webSocketDebuggerUrl": "[^"]*"' | cut -d'"' -f4
```

Output: `ws://localhost:9222/devtools/browser/<uuid>`

Replace `localhost:9222` with the tunnel address. For example, if bore gives `bore.pub:12345`:
```
ws://bore.pub:12345/devtools/browser/<uuid>
```

Some tunnels (bore) use TCP tunneling, so `ws://` works. For HTTPS-based tunnels (ngrok, cloudflared), use `wss://`.

### Step 4: Provide the URL to felix

```
felix-browser connect to wss://abc123.ngrok-free.app/devtools/browser/abc123-def456
```

The URL is sensitive — anyone with it can control the user's browser. Felix does not store or log it.

## Connection — establishing the CDP link

Once the user provides a CDP URL, use it with every `agent-browser` command via the `--cdp` flag:

```bash
CDP_URL="wss://abc123.bore.pub/devtools/browser/uuid"
```

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
| No CDP URL provided | Reply: "I need a CDP endpoint to connect to. See the setup guide — run Chrome with `--remote-debugging-address=0.0.0.0 --remote-debugging-port=9222`, expose it via tunnel or host.docker.internal, and give me the URL." |
| `command not found: agent-browser` | CLI is not installed. Reply: "agent-browser is not installed. Run `install agent-browser@0.28.0` first." |
| Connection refused / timeout | The CDP endpoint is unreachable. Ask the user: "Is Chrome still running with `--remote-debugging-address=0.0.0.0 --remote-debugging-port=9222`? Is the tunnel still up? Can you re-share the CDP URL?" |
| Element not found | Re-snapshot and check for consent banners, modals, or page errors. Dismiss overlays first. |
| Page shows captcha or anti-bot page | Report to user. The user sees the same page in their Chrome and can solve it manually. |
| Snapshot returns empty | Wait for network idle and retry. The page may not have finished rendering. |
| Navigation stalls | Use `wait --load networkidle` with a timeout. Retry once. |
| `open` fails with DNS, timeout, or HTTP error | DNS failure: "That domain doesn't exist." Timeout: "The site is unreachable." HTTP 4xx/5xx: "The page returned a XXX error." Do not retry more than once. |

## Output format

Return content through FELIX_REPLY:

**Setup guide (first time):**
```
## Setting up felix-browser

1. Launch Chrome with remote debugging:
   google-chrome --remote-debugging-address=0.0.0.0 --remote-debugging-port=9222

2. Expose the port via bore:
   bore local 9222 --to bore.pub

3. Get your CDP URL:
   curl http://localhost:9222/json/version | grep webSocketDebuggerUrl

4. Replace `localhost:9222` with your bore address and send me the URL:
   felix-browser connect to ws://bore.pub:12345/devtools/browser/<uuid>
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
Cannot connect to the browser. Is Chrome still running with --remote-debugging-address=0.0.0.0 --remote-debugging-port=9222 and is the tunnel active?
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
