# Auth Flow

Headless OAuth flow for `gog` in Felix's Docker environment.

## Credential setup

OAuth client credentials are stored via environment variables. The credential JSON file references them with `--expand-env`:

```json
{
  "installed": {
    "client_id": "${GOOGLE_CLIENT_ID}",
    "client_secret": "${GOOGLE_CLIENT_SECRET}",
    "auth_uri": "https://accounts.google.com/o/oauth2/auth",
    "token_uri": "https://oauth2.googleapis.com/token",
    "redirect_uris": ["http://localhost"]
  }
}
```

Generate the credential template only in `/tmp`, import it, and delete it in
the same operation. Set `GOG_HOME` to the persistent Workspace-backed state
directory; authorized accounts and the file keyring live there.

```bash
# The bundled helper creates a mode-0600 template under /tmp, imports it, and
# removes the temporary directory even when gog fails.
node /app/skills/google-workspace/scripts/import-credentials.mjs
```

### Security

- Never log or echo `GOOGLE_CLIENT_ID` or `GOOGLE_CLIENT_SECRET` values.
- Never store the credential template in the Workspace volume or commit it.
- Use `--expand-env` so secrets stay in environment variables, not in files.
- The `GOG_KEYRING_PASSWORD` should be a strong random value in `.env`.
- Tokens are stored in `gog`'s keyring (file backend in containers) — never expose them.

## Authorize an account (manual flow)

```bash
# Step 1: gog prints an authorization URL
gog auth add user@gmail.com --manual --services gmail,calendar,drive,docs,sheets,slides,forms,contacts,tasks,people --json
```

The JSON output contains the URL. Send it to the user:

> "Open this URL in your browser, sign in with Google, and paste the redirect URL back here."

```json
{
  "url": "https://accounts.google.com/o/oauth2/auth?...",
  "instructions": "Open the URL, grant access, paste the redirect URL"
}
```

Step 2: User pastes the redirect URL. Complete the auth:

```bash
gog auth add user@gmail.com --manual --auth-url "<pasted-redirect-url>" --json
```

Completion: `gog auth list --check --json` shows the account as authorized with valid tokens.

## Re-authorization (token expired)

When a `gog` command fails with auth error:

1. Run `gog auth list --check --json` to confirm which account has expired tokens.
2. Re-run the manual auth flow for that account: `gog auth add <email> --manual --services <services> --json`.
3. Send the URL to the user and complete as above.

## Multi-account management

```bash
# List all authorized accounts
gog auth list --json

# Set default account
gog auth alias set default user@gmail.com

# Use specific account for a command
gog --account user@gmail.com gmail search 'is:unread' --json
```

When the user has multiple accounts and doesn't specify which to use, ask which account they mean. If only one account exists, use it implicitly.

## Environment variables

| Variable | Description |
|---|---|
| `GOG_HOME` | Root directory for gog config/data/state/cache |
| `GOG_KEYRING_BACKEND` | Keyring backend (`file` for containers without system keyring) |
| `GOG_KEYRING_PASSWORD` | Password for file keyring backend |
| `GOG_CLIENT` | OAuth client name (default: `default`) |
| `GOG_ACCOUNT` | Default account email |
| `GOOGLE_CLIENT_ID` | OAuth client ID (referenced in credentials.json via `--expand-env`) |
| `GOOGLE_CLIENT_SECRET` | OAuth client secret (referenced in credentials.json via `--expand-env`) |
