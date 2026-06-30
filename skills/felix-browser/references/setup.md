# Felix Browser setup

Use a separate Chrome profile so remote debugging does not affect the user's normal browser session.

## 1. Launch Chrome

macOS:

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-debug
```

Linux:

```bash
google-chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-debug
```

Windows:

```powershell
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="$env:TEMP\chrome-debug"
```

## 2. Expose port 9222

ngrok:

```bash
ngrok http 9222 --host-header="localhost:9222"
```

cloudflared:

```bash
cloudflared tunnel --http-host-header localhost:9222 --url http://localhost:9222
```

The host-header option is required for reliable CDP WebSocket routing.

## 3. Connect

Ask the user to send:

```text
felix-browser connect to https://<tunnel-host>
```

Anyone holding this URL can control the exposed Chrome profile. The user should keep the URL private and stop the tunnel when finished.
