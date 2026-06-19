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

## Workflow

### Start share
1. Verify headed mode is running (check `$THREAD_DIR/xvfb.state`)
2. If not headed, inform user: "Browser must be in headed mode to share. Start with `agent-browser --headed open <url>`"
3. Check if already sharing (check `$THREAD_DIR/share.state`)
4. If already sharing, return existing URL from state file
5. Ensure bore is installed (`command -v bore` or suggest `install bore`)
6. Read DISPLAY from `$THREAD_DIR/xvfb.state`
7. Start x11vnc (VNC server on existing DISPLAY)
8. Start websockify + noVNC (WebSocket proxy on port 6080)
9. Start bore tunnel (expose port 6080 externally)
10. Capture bore URL from output
11. Save state to `$THREAD_DIR/share.state`
12. Return URL to user

### Stop share
1. Read state from `$THREAD_DIR/share.state`
2. Kill VNC, websockify, bore processes
3. Remove state file
4. Confirm to user

## Commands

### Start share

```bash
# 1. Verify headed mode is running
if [ ! -f "$THREAD_DIR/xvfb.state" ]; then
    echo "Browser must be in headed mode to share. Start with: agent-browser --headed open <url>"
    exit 1
fi

# 2. Check if already sharing
if [ -f "$THREAD_DIR/share.state" ]; then
    read _ _ _ SHARE_URL < "$THREAD_DIR/share.state"
    echo "$SHARE_URL"
    exit 0
fi

# 3. Ensure bore is installed
if ! command -v bore &>/dev/null; then
    echo "bore is not installed. Run: install bore"
    exit 1
fi

# 4. Read DISPLAY from xvfb.state
read _ DISPLAY < "$THREAD_DIR/xvfb.state"
export DISPLAY

# 5. Start x11vnc (no password, share existing display)
x11vnc -display "$DISPLAY" -forever -nopw -shared -bg -o "$THREAD_DIR/vnc.log"
VNC_PID=$!

# 6. Start websockify + noVNC (WebSocket proxy on port 6080 → VNC on 5900)
websockify --web=/usr/share/novnc 6080 localhost:5900 &
WEBSOCKIFY_PID=$!

# 7. Start bore tunnel (expose port 6080 externally)
bore local 6080 --to bore.pub 2>&1 | tee "$THREAD_DIR/bore.log" &
BORE_PID=$!

# 8. Wait for bore to output URL
sleep 2
BORE_URL=$(grep -oP 'https?://[^ ]+' "$THREAD_DIR/bore.log" | head -1)

# 9. Save share state
cat > "$THREAD_DIR/share.state" << EOF
$VNC_PID $WEBSOCKIFY_PID $BORE_PID $BORE_URL
EOF

# 10. Return URL to user
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

**URL:** https://abc123.bore.pub

Open this URL to take control of the browser session. This URL is disposable and closes when you close the browser.
```

**Stop share:**
```
Browser sharing stopped. The browser session is still active.
```

## Failure modes
- Browser not in headed mode: inform user to start headed session first
- bore not installed: suggest `install bore`
- Already sharing: return existing URL
- bore.pub down: report error, suggest retry
- VNC port in use: another share may be active, run `stop-share` first
