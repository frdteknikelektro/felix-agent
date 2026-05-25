# Felix Agent Docker

Universal thread/session manager around Codex.

Mattermost is the first source adapter. The intended model is:

```text
source thread -> one Codex session -> skills from disk -> response or permission bridge
```

Development:

```bash
npm install
npm run dev
```
