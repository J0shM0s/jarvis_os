# Connect Gmail, Calendar & Tasks to JARVIS — 5-minute setup

Google requires an OAuth "client" so JARVIS can log in as **you**, with your
consent, using your own Google Cloud project (not a third party's server).
You do this once. Everything after that is voice.

## 1. Create the client (~4 minutes)

1. Go to <https://console.cloud.google.com> and sign in with the Google
   account whose mail/calendar you want JARVIS to see.
2. Top bar → project dropdown → **New project** → name it `jarvis` → Create.
3. Search "**Google Calendar API**" → Enable. Repeat for "**Gmail API**" and
   "**Google Tasks API**".
4. Left menu → **APIs & Services → OAuth consent screen**:
   - User type **External** → Create
   - App name: `JARVIS`, your email as support email → Save
   - Scopes step: you can skip adding scopes manually (the server requests
     them dynamically)
   - **Test users → Add users → your own Gmail address** ← this step is
     mandatory for a personal account
5. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Desktop app**
   - Name: `jarvis-bridge`
   - Create → copy the **Client ID** and **Client Secret**

## 2. Give the credentials to the bridge

In the `jarvis` folder, copy `google-oauth.env.example` to `google-oauth.env`,
open it in Notepad, paste your two values, save.

## 3. Register the server with Claude Code

Double-click **`register-google-mcp.bat`**. It registers the server at user
scope, so every JARVIS session gets it.

## 4. Restart JARVIS

Close the two minimized "JARVIS bridge" / "JARVIS face" windows, then
double-click `start.bat` (oder `start.bat --show` fuer Debug). Dann probiere:

> "Hey Jarvis — what does my day look like? Read me my meetings in order,
> tell me which one I haven't prepared for, and tell me if anything in my
> inbox this morning relates to any of them."

The first time, a Google sign-in window opens in Chrome. Approve it
(while your Google account is signed in to Chrome, it's two clicks).
Tokens are cached on disk afterwards.

## If something fails

- **`google-oauth.env` not found** → you skipped step 2.
- **Google shows "unverified app" warning** → click Advanced → Go to JARVIS
  (unsafe). Normal for personal projects; it's your own app.
- **"Access blocked: app has not completed verification"** → you didn't add
  yourself as a test user in step 1.4.
- **Jarvis says he has no calendar access** → check
  `jarvis/workspace-mcp.out.log` for the actual error, and confirm the API
  is enabled in your Cloud project.
- **Ports**: the bridge uses 8787, the face uses 5173. If either is held by
  something else, close that app first.
