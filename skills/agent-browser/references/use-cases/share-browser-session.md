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
- Browser must be in headed mode (Xvfb running)

Optional:
- None. The URL is disposable and accessible from anywhere.

## Pre-flight checks

Before sharing, verify all dependencies are available:

```bash
# Check required tools
for cmd in x11vnc websockify bore; do
    if ! command -v "$cmd" &>/dev/null; then
        echo "Required tool not found: $cmd"
        echo "Install with: install $cmd"
        exit 1
    fi
done
```

## Workflow

### Start share
1. Run pre-flight checks for required tools
2. Verify headed mode is running (check `$THREAD_DIR/xvfb.state`)
3. If not headed, attempt to start Xvfb automatically
4. Check if already sharing (check `$THREAD_DIR/share.state`)
5. If already sharing, return existing URL from state file
6. Kill any stale share processes from previous sessions
7. Start x11vnc (VNC server on existing DISPLAY)
8. Start websockify + noVNC (WebSocket proxy on port 6080)
9. Start bore tunnel (expose port 6080 externally)
10. Wait for bore to be ready and capture URL
11. Save state to `$THREAD_DIR/share.state`
12. Verify the share is working (optional health check)
13. Return URL to user

### Stop share
1. Read state from `$THREAD_DIR/share.state`
2. Kill VNC, websockify, bore processes
3. Remove state file
4. Confirm to user

## Commands

### Start share

```bash
# 1. Pre-flight checks
for cmd in x11vnc websockify bore; do
    if ! command -v "$cmd" &>/dev/null; then
        echo "Required tool not found: $cmd. Run: install $cmd"
        exit 1
    fi
done

# 2. Verify headed mode is running, try to start if not
if [ ! -f "$THREAD_DIR/xvfb.state" ]; then
    # Try to start Xvfb
    mkdir -p /tmp/.X11-unix 2>/dev/null || true
    chmod 1777 /tmp/.X11-unix 2>/dev/null || true
    
    DISPLAY_NUM=$(shuf -i 10-99 -n 1)
    while [ -e "/tmp/.X11-unix/X${DISPLAY_NUM}" ]; do
        DISPLAY_NUM=$(shuf -i 10-99 -n 1)
    done
    
    nohup Xvfb ":${DISPLAY_NUM}" -screen 0 1920x1080x24 -ac > /tmp/xvfb_${DISPLAY_NUM}.log 2>&1 &
    XVFB_PID=$!
    
    # Wait for Xvfb to be ready
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
    
    echo "$XVFB_PID :${DISPLAY_NUM}" > "$THREAD_DIR/xvfb.state"
fi

# 3. Check if already sharing
if [ -f "$THREAD_DIR/share.state" ]; then
    read _ _ _ SHARE_URL < "$THREAD_DIR/share.state"
    # Verify the share is still active
    if curl -s -o /dev/null -w "%{http_code}" "$SHARE_URL" | grep -q "200\|101"; then
        echo "$SHARE_URL"
        exit 0
    fi
    # Stale share, clean up
    rm -f "$THREAD_DIR/share.state"
fi

# 4. Clean up any stale share processes
pkill -f "x11vnc.*$(grep -oP ':\d+' "$THREAD_DIR/xvfb.state")" 2>/dev/null || true
pkill -f "websockify.*6080" 2>/dev/null || true

# 5. Read DISPLAY from xvfb.state
read _ DISPLAY < "$THREAD_DIR/xvfb.state"
export DISPLAY

# 6. Start x11vnc (no password, share existing display)
x11vnc -display "$DISPLAY" -forever -nopw -shared -bg -o "$THREAD_DIR/vnc.log"
VNC_PID=$!

# 7. Start websockify + noVNC (WebSocket proxy on port 6080 → VNC on 5900)
websockify --web=/usr/share/novnc 6080 localhost:5900 &
WEBSOCKIFY_PID=$!

# 8. Start bore tunnel (expose port 6080 externally)
bore local 6080 --to bore.pub > "$THREAD_DIR/bore.log" 2>&1 &
BORE_PID=$!

# 9. Wait for bore to output URL with timeout
TIMEOUT=10
ELAPSED=0
BORE_URL=""
while [ $ELAPSED -lt $TIMEOUT ]; do
    sleep 1
    ELAPSED=$((ELAPSED + 1))
    BORE_URL=$(grep -oP 'https?://[^ ]+' "$THREAD_DIR/bore.log" | head -1)
    if [ -n "$BORE_URL" ]; then
        break
    fi
done

if [ -z "$BORE_URL" ]; then
    echo "Failed to start bore tunnel. Check logs: $THREAD_DIR/bore.log"
    kill "$VNC_PID" "$WEBSOCKIFY_PID" "$BORE_PID" 2>/dev/null
    exit 1
fi

# 10. Save share state
cat > "$THREAD_DIR/share.state" << EOF
$VNC_PID $WEBSOCKIFY_PID $BORE_PID $BORE_URL
EOF

# 11. Return URL to user
echo "$BORE_URL"
```

### Stop share

```bash
# Stop sharing but keep browser alive
if [ -f "$THREAD_DIR/share.state" ]; then
    read VNC_PID WEBSOCKIFY_PID BORE_PID _ < "$THREAD_DIR/share.state"
    kill "$VNC_PID" "$WEBSOCKIFY_PID" "$BORE_PID" 2>/dev/null
    rm -f "$THREAD_DIR/share.state" "$THREAD_DIR/bore.log"
    echo "Browser sharing stopped. The browser session is still active."
else
    echo "No active share session."
fi
```

## State tracking

**File:** `$THREAD_DIR/share.state`

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

**URL:** http://bore.pub:9090

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
   agent-browser --session "$SESSION" --headed open <url>
   ```
3. Restart the share

### bore connection issues
If bore fails to connect:
1. Check if bore.pub is accessible: `curl -s https://bore.pub | head -1`
2. Try a different port: `bore local 6080 --to bore.pub --port <custom-port>`
3. Check bore logs: `cat $THREAD_DIR/bore.log`

### VNC port conflicts
If you get "port already in use" errors:
1. Kill any stale VNC processes: `pkill -f x11vnc`
2. Kill any stale websockify processes: `pkill -f websockify`
3. Retry the share

## Failure modes
- Browser not in headed mode: attempt to start Xvfb automatically, or inform user to start headed session first
- bore not installed: suggest `install bore`
- Already sharing: return existing URL if still active, otherwise restart
- bore.pub down: report error, suggest retry
- VNC port in use: kill stale processes and retry
- Blank screen: browser may be in headless mode, restart in headed mode
