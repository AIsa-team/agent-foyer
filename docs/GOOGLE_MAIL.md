# Gmail drafts (Google Workspace)

> [中文](GOOGLE_MAIL.zh-CN.md)

Apps on the hub can prepare an email for the person using them, such as a confirmation to a client with colleagues
in cc, and save it as a **draft in that person's mailbox**. The person checks it and sends it themselves; the hub
never sends mail. If your company's mail is on Google Workspace, drafts go to Gmail. With Lark Mail and no Google
setup, they go to Lark Mail instead (`MAIL_DRAFTS`).

An admin sets this up once for the whole company. Everyone else only clicks "Connect Google" the first time an app
needs it.

## 1. Create the OAuth client (once, about 10 minutes)

In the [Google Cloud console](https://console.cloud.google.com/), signed in with a Workspace admin account:

1. Create a project (e.g. "Agent Foyer") or pick an existing one.
2. **APIs & Services → Library**: enable the **Gmail API**.
3. **APIs & Services → OAuth consent screen** (Google Auth Platform → Branding / Audience):
   - User type **Internal**: only accounts in your Workspace can use it, and Google does not need to review the app.
   - App name: your hub's name; support email: yours.
   - Scopes (Data access): add `.../auth/gmail.compose`, plus `openid` and `email`.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type **Web application**.
   - Authorized redirect URI: `https://hub.example.com/auth/google/callback`.
5. Copy the client ID and secret into the server's `.env` and restart the hub:

   ```
   GOOGLE_CLIENT_ID=1234567890-xxxx.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=GOCSPX-xxxx
   ```

With `GOOGLE_CLIENT_ID` set, `MAIL_DRAFTS` defaults to `google`.

## 2. What people see

- The first time an app wants to save a draft for someone, the hub's consent page lists "save email drafts in your
  Gmail (never sends them)". After "Allow", Google asks them to grant draft access, and they are back in the app.
- The "Me" page shows the Google connection and lets them disconnect it.
- The hub only accepts a Google account on the same email domain as the person's hub account, so drafts land in the
  work mailbox.

## Notes

- `gmail.compose` lets an app create drafts and send mail; the hub only ever calls "create draft".
- Tokens are stored encrypted (like Lark tokens) and refreshed automatically. If someone removes the hub's access in
  their Google account, the next draft asks them to connect again.
