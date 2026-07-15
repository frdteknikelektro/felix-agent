# First-Time Setup Guide

Complete walkthrough for setting up Google Workspace integration in Felix.

## Prerequisites

- A Google account (personal gmail.com or Workspace)
- Access to the Google Cloud Console
- Felix running with the `google-workspace` skill available

## Step 1: Create a Google Cloud project

1. Go to [Google Cloud Console](https://console.cloud.google.com/projectcreate).
2. Create a new project (e.g., "Felix Google Workspace").
3. Note the project ID.

## Step 2: Enable APIs

Go to [API Library](https://console.cloud.google.com/apis/library) and enable the APIs you need:

**Recommended (covers most use cases):**
- Gmail API
- Google Calendar API
- Google Drive API
- Google Docs API
- Google Sheets API
- Google Slides API
- Google Forms API
- Google People API (Contacts)
- Google Tasks API

**Optional (Workspace features):**
- Google Chat API
- Google Classroom API
- Admin SDK API (user/org management — requires domain-wide delegation)
- Google Keep API
- Google Meet API
- YouTube Data API
- Google Maps APIs (Geocoding, Directions, Places)

## Step 3: Configure OAuth consent screen

1. Go to [OAuth consent screen](https://console.cloud.google.com/auth/branding).
2. Select "External" user type (sufficient for personal use).
3. Fill in app name (e.g., "Felix Google Workspace") and your email.
4. Add the scopes for the APIs you enabled above.
5. Add your email as a test user.

**Important:** To avoid weekly re-authorization, go to [Audience](https://console.cloud.google.com/auth/audience), click **Publish app**, then **Confirm**. This changes the app to "In production" without submitting for verification.

## Step 4: Create OAuth client credentials

1. Go to [Credentials](https://console.cloud.google.com/auth/clients).
2. Click **Create Credentials** → **OAuth client ID**.
3. Select **Desktop app** as the application type.
4. Name it (e.g., "Felix CLI").
5. Download the JSON file.

## Step 5: Store credentials in Felix

### Option A: Environment variables (recommended)

Set in `.env`:

```
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
```

Create a credential template file that references these variables:

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

Do not store this template in the persistent Felix workspace. Have Felix run
the bundled helper; it creates a mode-0600 template in `/tmp`, imports it, and
deletes it:

```bash
node /app/skills/google-workspace/scripts/import-credentials.mjs
```

### Credential-file handling

Felix does not import credential files from the persistent Workspace volume.
If a provider supplies a downloaded client file, keep it outside the container
and convert the required client values into the environment variables, then
use the ephemeral helper above.

## Step 6: Authorize a Google account

Tell Felix: "Set up Google Workspace auth for my@email.com"

Felix will run:

```bash
gog auth add your@email.com --manual --services gmail,calendar,drive,docs,sheets,slides,forms,contacts,tasks,people --json
```

Felix sends you an authorization URL. Open it in your browser, sign in with Google, grant access, and paste the redirect URL back to Felix.

Completion check:

```bash
gog auth list --check --json
```

Should show your account as authorized with valid tokens.

## Step 7: Grant permissions to contacts

In the owner console, assign permissions to contacts who should use Google Workspace:

- `google-workspace:read.*` — read-only access to all services
- `google-workspace:write.*` — full read/write access to all services
- `google-workspace:read.gmail` — read-only access to Gmail only
- `google-workspace:write.drive` — read/write access to Drive only

## Docker environment variables

Add to `.env` for the Felix container:

```
GOG_HOME=/home/node/.config/gogcli
GOG_KEYRING_BACKEND=file
GOG_KEYRING_PASSWORD=a-secure-random-password
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
```

## Troubleshooting

**"Token expired" errors:**
- Felix will automatically initiate re-auth via the manual flow.
- Make sure the OAuth app is published (not in "Testing" mode).

**"Access denied" for Admin/Groups/Keep:**
- These require Workspace domain-wide delegation.
- Set up a service account: `gog auth service-account set admin@example.com --key /path/to/service-account.json`

**"Invalid client" errors:**
- Check that `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` match the downloaded JSON.
- Re-run `gog auth credentials set` with the correct file.

**Weekly re-authorization:**
- Publish the OAuth app to production (Step 3 above).
- Re-run `gog auth add --force-consent` after publishing.
