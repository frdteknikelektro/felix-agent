# Felix Browser commands

Load only the section needed for the requested operation. Every `agent-browser` command requires:

```bash
agent-browser --cdp "$CDP_URL" --session "$SESSION" <command>
```

## Resolve an HTTPS tunnel

```bash
TUNNEL_URL="${TUNNEL_URL%/}"
CDP_WS=$(curl -fsS "$TUNNEL_URL/json/version" | jq -er '.webSocketDebuggerUrl')
TUNNEL_HOST=$(printf '%s' "$TUNNEL_URL" | sed -E 's#^https?://##; s#/.*$##')
CDP_PATH=$(printf '%s' "$CDP_WS" | sed -E 's#^wss?://[^/]+##')
CDP_URL="wss://${TUNNEL_HOST}${CDP_PATH}"
```

Require an HTTPS tunnel and a CDP path beginning with `/devtools/browser/`. Do not print `CDP_URL`.

Connection test:

```bash
agent-browser --cdp "$CDP_URL" --session "$SESSION" open about:blank
```

## Navigate and inspect

```bash
agent-browser --cdp "$CDP_URL" --session "$SESSION" open "$URL"
agent-browser --cdp "$CDP_URL" --session "$SESSION" wait --load networkidle
agent-browser --cdp "$CDP_URL" --session "$SESSION" snapshot -i -c -d 5
```

Prefer observable waits over fixed delays:

```bash
agent-browser --cdp "$CDP_URL" --session "$SESSION" wait "@e3"
agent-browser --cdp "$CDP_URL" --session "$SESSION" wait --text "Welcome"
agent-browser --cdp "$CDP_URL" --session "$SESSION" wait --url "**/dashboard"
agent-browser --cdp "$CDP_URL" --session "$SESSION" wait --load domcontentloaded
agent-browser --cdp "$CDP_URL" --session "$SESSION" wait --fn "document.querySelector('.content') !== null"
```

## Interact

```bash
agent-browser --cdp "$CDP_URL" --session "$SESSION" click @e2
agent-browser --cdp "$CDP_URL" --session "$SESSION" fill @e3 "user@example.com"
agent-browser --cdp "$CDP_URL" --session "$SESSION" select @e5 "Option B"
agent-browser --cdp "$CDP_URL" --session "$SESSION" type @e6 "search query"
agent-browser --cdp "$CDP_URL" --session "$SESSION" check @e7
agent-browser --cdp "$CDP_URL" --session "$SESSION" scroll down --selector "#main"
```

Semantic locators are useful when the snapshot has no stable ref:

```bash
agent-browser --cdp "$CDP_URL" --session "$SESSION" find role button click --name "Submit"
agent-browser --cdp "$CDP_URL" --session "$SESSION" find text "Contact Us" click
agent-browser --cdp "$CDP_URL" --session "$SESSION" find label "Email" fill "user@example.com"
```

## Read

```bash
agent-browser --cdp "$CDP_URL" --session "$SESSION" get text @e1
agent-browser --cdp "$CDP_URL" --session "$SESSION" get html @e2
agent-browser --cdp "$CDP_URL" --session "$SESSION" get title
agent-browser --cdp "$CDP_URL" --session "$SESSION" get url
agent-browser --cdp "$CDP_URL" --session "$SESSION" get value @e3
```

## Screenshot

```bash
SCREENSHOT_PATH="{thread_dir}/attachments/screenshot.png"
agent-browser --cdp "$CDP_URL" --session "$SESSION" screenshot "$SCREENSHOT_PATH"
```

Replace `{thread_dir}` with the exact current turn value and apply the Session-attachment rules in `WORKSPACE_FOLDER_STRUCTURE.md` before writing. Add `--annotate` before the path for an annotated screenshot. Return the path relative to the thread.

## JavaScript

Use JavaScript only when snapshots and semantic locators cannot obtain the value:

```bash
agent-browser --cdp "$CDP_URL" --session "$SESSION" eval "document.title"
printf '%s\n' 'JSON.stringify(window.__INITIAL_STATE__)' \
  | agent-browser --cdp "$CDP_URL" --session "$SESSION" eval --stdin
```

## Close

```bash
agent-browser --cdp "$CDP_URL" --session "$SESSION" close
```
