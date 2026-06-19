# Share Browser Session

## When to use
Use this recipe when the user asks to:
- Share the browser session with someone else
- Get a shareable URL for the browser
- Allow someone else to take control of the browser
- "share browser", "share session", "get share URL", "get shareable link"

## Permission
Required permission: `agent-browser:agent-browser.share`.

## Inputs
Required:
- Browser must be running and accessible to the requesting thread (the requesting thread does NOT need a separate browser session — it connects to the existing session via VNC)

Optional:
- None. The URL is disposable and accessible from anywhere.

## Pre-flight checks

### 1. Check browser availability

```bash
BROWSER_STATUS=$(ensure_browser_available)
if [ $? -ne 0 ]; then
    ACTIVE_THREAD="${BROWSER_STATUS#in-use:}"
    echo "Browser sedang digunakan oleh thread: $ACTIVE_THREAD"
    echo "Tutup browser di thread tersebut terlebih dahulu."
    exit 0
fi
```

### 2. Check required tools

```bash
for cmd in x11vnc websockify bore; do
    if ! command -v "$cmd" &>/dev/null; then
        echo "Required tool not found: $cmd"
        echo "Install with: install $cmd"
        exit 1
    fi
done
```

### 3. Set memory optimization flags

```bash
export AGENT_BROWSER_CHROME_FLAGS="--single-process --disable-gpu --no-sandbox --disable-dev-shm-usage --disable-extensions --disable-background-networking --disable-default-apps --disable-sync --disable-translate --metrics-recording-only --no-first-run --js-flags=--max-old-space-size=256"
```

## Workflow

### Start share
1. Run pre-flight checks (browser available, tools, memory flags)
2. Verify headed mode is running (check `$WORKSPACE_DIR/xvfb.state`)
3. If not headed, start Xvfb with lower resolution (1280x720x16)
4. Check if already sharing (check `$WORKSPACE_DIR/share.state`)
5. If already sharing, return existing URL from state file
6. Kill any stale share processes from previous sessions
7. Start x11vnc (VNC server on existing DISPLAY)
8. Start websockify + noVNC (WebSocket proxy on port 6080)
9. Start bore tunnel (expose port 6080 externally)
10. Wait for bore to be ready and capture URL
11. Save state to `$WORKSPACE_DIR/share.state`
12. Return URL to user

### Stop share
1. Read state from `$WORKSPACE_DIR/share.state`
2. Kill VNC, websockify, bore processes
3. Remove state file
4. Confirm to user

## Commands

### Start share

```bash
# 1. Pre-flight: check browser availability
BROWSER_STATUS=$(ensure_browser_available)
if [ $? -ne 0 ]; then
    ACTIVE_THREAD="${BROWSER_STATUS#in-use:}"
    echo "Browser sedang digunakan oleh thread: $ACTIVE_THREAD"
    exit 0
fi

# 2. Pre-flight: check required tools
for cmd in x11vnc websockify bore; do
    if ! command -v "$cmd" &>/dev/null; then
        echo "Required tool not found: $cmd. Run: install $cmd"
        exit 1
    fi
done

# 3. Pre-flight: set memory flags
export AGENT_BROWSER_CHROME_FLAGS="--single-process --disable-gpu --no-sandbox --disable-dev-shm-usage --disable-extensions --disable-background-networking --disable-default-apps --disable-sync --disable-translate --metrics-recording-only --no-first-run --js-flags=--max-old-space-size=256"

# 4. Verify headed mode is running, start Xvfb if not
XVFB_STATE="$WORKSPACE_DIR/xvfb.state"
if [ ! -f "$XVFB_STATE" ]; then
    mkdir -p /tmp/.X11-unix 2>/dev/null || true
    chmod 1777 /tmp/.X11-unix 2>/dev/null || true
    
    DISPLAY_NUM=$(shuf -i 10-99 -n 1)
    while [ -e "/tmp/.X11-unix/X${DISPLAY_NUM}" ]; do
        DISPLAY_NUM=$(shuf -i 10-99 -n 1)
    done
    
    # Use 1280x720x16 for memory-constrained environments
    nohup Xvfb ":${DISPLAY_NUM}" -screen 0 1280x720x16 -ac > /tmp/xvfb_${DISPLAY_NUM}.log 2>&1 &
    XVFB_PID=$!
    
    RETRIES=10
    while [ $RETRIES -gt 0 ]; do
        if [ -e "/tmp/.X11-unix/X${DISPLAY_NUM}" ]; then
            break
        fi
        sleep 0.5
        RETRIES=$((RETRIES - 1))
    done
    
    if ! kill -0 "$XVFB_PID" 2>/dev/null; then
        echo "Failed to start Xvfb for sharing"
        exit 1
    fi
    
    echo "$XVFB_PID :${DISPLAY_NUM}" > "$XVFB_STATE"
fi

# 5. Check if already sharing
SHARE_STATE="$WORKSPACE_DIR/share.state"
if [ -f "$SHARE_STATE" ]; then
    read _ _ _ SHARE_URL < "$SHARE_STATE"
    if curl -s -o /dev/null -w "%{http_code}" "$SHARE_URL" | grep -q "200\|101"; then
        echo "$SHARE_URL"
        exit 0
    fi
    rm -f "$SHARE_STATE"
fi

# 6. Clean up stale share processes
pkill -f "x11vnc.*$(grep -oP ':\d+' "$XVFB_STATE")" 2>/dev/null || true
pkill -f "websockify.*6080" 2>/dev/null || true

# 7. Read DISPLAY from xvfb.state
read _ DISPLAY < "$XVFB_STATE"
export DISPLAY

# 8. Start x11vnc
x11vnc -display "$DISPLAY" -forever -nopw -shared -bg -o "$WORKSPACE_DIR/vnc.log"
VNC_PID=$!

# 9. Start websockify + noVNC
websockify --web=/usr/share/novnc 6080 localhost:5900 &
WEBSOCKIFY_PID=$!

# 10. Start bore tunnel
bore local 6080 --to bore.pub > "$WORKSPACE_DIR/bore.log" 2>&1 &
BORE_PID=$!

# 11. Wait for bore URL
TIMEOUT=10
ELAPSED=0
BORE_RAW_URL=""
while [ $ELAPSED -lt $TIMEOUT ]; do
    sleep 1
    ELAPSED=$((ELAPSED + 1))
    BORE_RAW_URL=$(grep -oP 'https?://[^ ]+' "$WORKSPACE_DIR/bore.log" | head -1)
    if [ -n "$BORE_RAW_URL" ]; then
        break
    fi
done

if [ -z "$BORE_RAW_URL" ]; then
    echo "Failed to start bore tunnel. Check logs: $WORKSPACE_DIR/bore.log"
    kill "$VNC_PID" "$WEBSOCKIFY_PID" "$BORE_PID" 2>/dev/null
    exit 1
fi

# 12. Add noVNC path
BORE_URL="${BORE_RAW_URL}/vnc.html"

# 13. Save share state
cat > "$SHARE_STATE" << EOF
$VNC_PID $WEBSOCKIFY_PID $BORE_PID $BORE_URL
EOF

# 14. Return URL
echo "$BORE_URL"
```

### Stop share

```bash
# Stop sharing but keep browser alive
SHARE_STATE="$WORKSPACE_DIR/share.state"
if [ -f "$SHARE_STATE" ]; then
    read VNC_PID WEBSOCKIFY_PID BORE_PID _ < "$SHARE_STATE"
    kill "$VNC_PID" "$WEBSOCKIFY_PID" "$BORE_PID" 2>/dev/null
    rm -f "$SHARE_STATE" "$WORKSPACE_DIR/bore.log"
    echo "Browser sharing stopped. The browser session is still active."
else
    echo "No active share session."
fi
```

## State tracking

**File:** `$WORKSPACE_DIR/share.state`

**Format:**
```
VNC_PID WEBSOCKIFY_PID BORE_PID BORE_URL
```

**Lifecycle:**
- Created on `share` command
- Read on `stop-share` and `close` commands
- Deleted on `stop-share` and `close` commands

## Output

**Share:**
```
## Browser shared!

**URL:** http://bore.pub:9090/vnc.html

Open this URL in your browser to take control of the session. Click "Connect" in the noVNC interface.

This URL is disposable and closes when you close the browser.
```

**Stop share:**
```
Browser sharing stopped. The browser session is still active.
```

## Troubleshooting

### Blank screen in noVNC
If the noVNC interface shows a blank/black screen:
1. The browser might be running in headless mode
2. Close the browser and reopen in headed mode:
   ```bash
   agent-browser --session "$SESSION" close
   ensure_xvfb
   agent-browser --session "$SESSION" --headed open <url>
   ```
3. Restart the share

### Browser in use by another thread
If you see "Browser sedang digunakan oleh thread...":
1. Inform the user which thread has the browser
2. Ask the user to close the browser in the other thread first, or wait until the other thread finishes its turn (the browser will be closed automatically when the user's session ends or times out)

### bore connection issues
If bore fails to connect:
1. Check if bore.pub is accessible: `curl -s https://bore.pub | head -1`
2. Try a different port: `bore local 6080 --to bore.pub --port <custom-port>`
3. Check bore logs: `cat $WORKSPACE_DIR/bore.log`

### VNC port conflicts
If you get "port already in use" errors:
1. Kill any stale VNC processes: `pkill -f x11vnc`
2. Kill any stale websockify processes: `pkill -f websockify`
3. Retry the share

## Failure modes
- Browser in use by another thread: inform user which thread has it, do not force-close
- Browser in headless mode: close and restart in headed mode
- bore not installed: suggest `install bore`
- Already sharing: return existing URL if still active, otherwise restart
- bore.pub down: report error, suggest retry
- VNC port in use: kill stale processes and retry
- Blank screen: browser may be in headless mode, restart in headed mode
