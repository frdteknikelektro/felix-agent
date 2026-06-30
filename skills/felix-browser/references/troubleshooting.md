# Felix Browser troubleshooting

Apply the first matching row. Report the observed failure; do not expose the tunnel or CDP URL.

| Symptom | Action and completion criterion |
|---|---|
| Missing tunnel URL | Ask for the HTTPS tunnel URL. Complete when the user supplies it. |
| `agent-browser` missing | Stop and direct the user to `install agent-browser@0.28.0`. |
| `/json/version` fails or lacks WebSocket URL | Ask the user to verify Chrome's debugging port and tunnel; require a successful JSON response before retrying. |
| Connection refused or timeout | Ask whether Chrome and the tunnel are still running. A restarted tunnel requires a new URL. |
| HTTP 530 / WebSocket blocked | Require ngrok `--host-header="localhost:9222"` or cloudflared `--http-host-header localhost:9222`. |
| Element not found | Snapshot again and inspect for a modal, consent banner, iframe, or page error before one retry. |
| Empty snapshot | Wait for DOM content or a known element, then retry once. |
| Navigation stalls | Wait for a concrete URL, text, or element instead of network idle; retry once. |
| CAPTCHA / anti-bot page | Stop automation and ask the user to solve it in Chrome. |
| DNS failure | Report that the domain did not resolve; do not retry. |
| HTTP 4xx/5xx | Report the status code; do not present page content as successful. |
| IPv6 unreachable | Ask the user to use an IPv4-capable tunnel or enable IPv6 routing. |
