# Plugins: authentication and requirements

For each plugin: how it signs in, whose app or key it uses, what the vault stores, and what's needed before wide or commercial use.

**Last reviewed:** 2026-09-27. Update this file whenever a plugin's authentication changes, or a plugin is added or removed.

## Summary

| Plugin | Sign-in method | Whose app or key | Approval needed from the provider | Open problems |
|---|---|---|---|---|
| gmail, gdrive, gdocs, gsheets, gslides, gcal, gtasks, gchat, gscript | OAuth 2.0, browser, `localhost` callback | **agentio's shared Google app** | **Yes, above 100 users:** Google verification, plus a yearly CASA security assessment for restricted scopes | Secret in the public code. 100-user lifetime cap. |
| github | OAuth 2.0, browser, `localhost` callback | **agentio's shared GitHub app** | No | Secret in the public code ([#95](https://github.com/plosson/agentio/issues/95)) |
| jira, confluence | OAuth 2.0 (Atlassian "3LO"), browser, `localhost` callback | **agentio's shared Atlassian app** (one app for both) | No review. Sharing must be on. | Secret in the public code, needed for every refresh ([#96](https://github.com/plosson/agentio/issues/96)). Personal data reporting duty. |
| dropbox | OAuth 2.0 with PKCE; the user pastes the code shown by Dropbox | **The user's own Dropbox app** | No | None |
| spotify | OAuth 2.0 with PKCE, browser, `127.0.0.1` callback | **The user's own Spotify app** | No | 5-user Development Mode limit. Sign-in expires after 6 months. |
| revolut | OAuth 2.0 with a signed JWT (private key); the user pastes the redirect URL | **The user's own Business API certificate** | No | None |
| slack | Incoming webhook URL (send only) | **The user's own Slack app** | No | None |
| discourse | Admin API key | **Created by the user on their forum** | No | None |
| falco | The user's own Horus email and password, plus optional 2FA; the vault keeps only the refresh token | **The user's own account**, no app | No | Check that Horus's terms allow a third-party tool |
| sql | Database connection URL (PostgreSQL, MySQL, SQLite) | **The user's own database** | No | None |
| rss | None (public feed URL) | — | No | None |

A plugin that uses **agentio's shared app** depends on agentio's standing with the provider: its secret, its quota, its user limits and its approval. A plugin that uses **the user's own app or key** has none of these dependencies.

The redirect URIs below are what the code sends. Each provider must have them registered on agentio's app.

The **"Create your own app"** steps below were checked against each provider's official documentation on 2026-09-27, with the source linked. Details the documentation doesn't state are marked **not confirmed**. Providers change their consoles, so check the labels again if a step doesn't match.

---

## Google (gmail, gdrive, gdocs, gsheets, gslides, gcal, gtasks, gchat, gscript)

**Code:** `src/plugins/google/oauth.ts`, `src/config/credentials.ts` (`GOOGLE_OAUTH_CONFIG`)

**Sign-in**
- OAuth 2.0 in the system browser, with a `localhost` callback on a free port.
- The code is exchanged for tokens with the client secret.
- The daemon refreshes access tokens.

**agentio's Google app**
- **Project number:** `931954287794`
- **Settings:** user type External, "In production", **not verified**
- **For users, this means:**
  - tokens don't expire after 7 days;
  - users see an "unverified app" warning;
  - the app is capped at **100 users over its lifetime**. The cap covers everyone who uses agentio's client, self-hosted users included, and it can't be reset.

**What the vault stores:** access token, refresh token, expiry, account email.

**Scopes per plugin.** Class: **R** restricted, **S** sensitive, **NS** non-sensitive.

| Plugin | Scopes |
|---|---|
| gmail | gmail.readonly **R**, gmail.compose **R**, gmail.modify **R**, gmail.settings.basic **R**, gmail.send **S**, userinfo.email NS |
| gdrive (read-only) | drive.readonly **R**, userinfo.email NS |
| gdrive (full) | drive **R**, userinfo.email NS |
| gdocs | documents **S**, drive.file NS, drive.readonly **R**, userinfo.email NS |
| gsheets | spreadsheets **S**, drive.file NS, drive.readonly **R**, userinfo.email NS |
| gslides | presentations **S**, drive.file NS, drive.readonly **R**, userinfo.email NS |
| gcal | calendar **S**, userinfo.email NS |
| gtasks | tasks **S**, userinfo.email NS |
| gchat | chat.messages.create **S**, chat.messages.readonly **R**, chat.spaces.readonly **S**, chat.memberships.readonly **S**, directory.readonly, userinfo.email NS |
| gscript | script.projects **S**, drive **R**, userinfo.email NS |

The Gmail, Drive and Chat classes are confirmed from Google's documentation. For calendar, tasks, documents, spreadsheets, presentations, script.projects and directory.readonly, confirm the class in the Google Cloud console.

**What's needed for more than 100 users.** Two options:
1. **Get agentio's app verified by Google:**
   - reduce the scopes;
   - a website, a privacy policy with Google's Limited Use wording, terms of use, a demo video, and a test account for reviewers;
   - a yearly CASA security assessment for restricted scopes, about $675 to $9,000 a year;
   - agents stop receiving raw tokens from agentio's own app, and the vault calls Google for them instead;
   - Google's July 2026 rules for agents: user confirmation of agent actions, prompt-injection protection, and token encryption with managed keys.
2. **Or each user brings their own Google app.**
   - The vault stores the user's client ID and secret.
   - A setup wizard helps create the app; it can be automated with gclientid, or guided.
   - No Google review is needed.

**Known problems**
- The client secret is in the public code, obfuscated. Google's API terms (4b) forbid embedding credentials in open-source projects. Anyone who copies it uses up the 100-user cap.
- No option lets users bring their own Google app yet.
- **gchat** only works with a Business or Enterprise Google Workspace account. Google lists this as a prerequisite of the Chat API.

### Create your own Google app

agentio can't use your own Google app yet: it always uses its shared app. These steps are for when that option is added.

1. In the Google Cloud console, create or select a project.
2. **Enable the APIs** you need: **Menu > APIs & Services > Library > Google Workspace**, click the API, then **Enable**. One API per plugin:

   | Plugin | API to enable |
   |---|---|
   | gmail | Gmail API |
   | gdrive | Drive API |
   | gdocs | Docs API |
   | gsheets | Sheets API |
   | gslides | Slides API |
   | gcal | Calendar API |
   | gtasks | Tasks API |
   | gchat | Chat API, and People API for `directory.readonly` |
   | gscript | Apps Script API |

3. **Set up the consent screen:** **Menu > Google Auth platform > Branding**. If it says "Google Auth platform not configured yet", click **Get Started**.
   1. **App Information:** fill in **App name** and **User support email**, then click **Next**.
   2. **Audience:** choose **Internal** if your account is part of a Google Workspace or Cloud Identity organisation, which means no warning screen and no user limit. Otherwise choose **External**, which is the only option for personal Gmail accounts. Click **Next**.
   3. **Contact Information:** enter an email address, then click **Next**.
   4. **Finish:** tick **I agree to the Google API Services: User Data Policy**, then click **Continue**, then **Create**.
4. **External apps only: publish the app.** Go to **Audience** and click **Publish app**. Without this, the app stays in Testing, and **every sign-in expires after 7 days**.
   - Google then shows an "unverified app" warning when you sign in. It lets personal-use apps (fewer than 100 users) click through it.
5. **Create the client:** **Menu > Google Auth platform > Clients > Create Client**. Set **Application type** to **Desktop app**, enter a **Name**, click **Create**, then download the JSON file.
   - A Desktop client has no redirect URI field. Google expects a loopback listener on a random port.
   - agentio's code uses `http://localhost:<port>/callback`. Google recommends `127.0.0.1` over `localhost`, and doesn't confirm that a path like `/callback` works on a loopback redirect **(not confirmed)**.
6. **gscript only:** switch on **Google Apps Script API** at https://script.google.com/home/usersettings. Without it, the API can't reach your script projects.
7. **gchat only, to send messages:** go to **Chat API > Configuration**.
   - Under **Application info**, fill in **App name** (up to 25 characters), **Avatar URL** (an HTTPS link to a square PNG or JPEG) and **Description** (up to 40 characters).
   - Switch off **Enable interactive features**, then click **Save**.
   - Reading needs only the enabled API.

Sources: [enable APIs](https://developers.google.com/workspace/guides/enable-apis), [consent screen](https://developers.google.com/workspace/guides/configure-oauth-consent), [credentials](https://developers.google.com/workspace/guides/create-credentials), [loopback redirect](https://developers.google.com/identity/protocols/oauth2/native-app), [publishing status](https://support.google.com/cloud/answer/15549945), [unverified apps](https://support.google.com/cloud/answer/13464323), [Chat configuration](https://developers.google.com/workspace/chat/configure-chat-api), [Apps Script API](https://developers.google.com/apps-script/api/how-tos/enable), [clasp README](https://github.com/google/clasp).

---

## GitHub

**Code:** `src/plugins/github/oauth.ts`, `src/config/credentials.ts` (`GITHUB_OAUTH_CONFIG`)

**Sign-in**
- OAuth 2.0 in the browser, with a `localhost` callback.
- The code is exchanged with the client secret.
- The `state` value comes from `Math.random()`.

**What the vault stores:** access token (non-expiring), username, email.

**Scope:** `repo`, full access to public and private repositories.

**What's needed:** nothing from GitHub. OAuth apps have no review and no user limit.

**Known problems**
- The client secret is in the public code, and GitHub treats it as confidential. The fix is to switch to GitHub's device flow, which needs no secret: [#95](https://github.com/plosson/agentio/issues/95).
- `repo` is broad. A GitHub App with per-repository permissions would be narrower. That's for later.
- **Expiring tokens.** GitHub's docs say **Expire user access tokens** is on by default for OAuth apps, with 8-hour access tokens and 6-month refresh tokens. agentio stores no GitHub refresh token and doesn't refresh, so an app with this setting would stop working after 8 hours. #95 must handle this.
- agentio's callback uses `localhost`. GitHub recommends `127.0.0.1`.

### Create your own GitHub OAuth app

agentio can't use your own GitHub app yet. These steps are for when that option is added, and for setting up the device flow.

1. On github.com, click your profile picture, then **Settings > Developer settings > OAuth apps > New OAuth App**. If you have none yet, the button says **Register a new application**.
2. Fill in:
   - **Application name** and **Homepage URL**;
   - **Application description** (optional);
   - **Authorization callback URL**, which is required. For a local callback, use a loopback address such as `http://127.0.0.1/callback`. GitHub then accepts any port: "The `redirect_uri` does not need to match the port specified in the callback URL for the app."
3. Tick **Enable Device Flow** if agentio uses the device flow (#95). The device flow needs no client secret.
4. **Expire user access tokens** is on by default. Leave it off until agentio can refresh GitHub tokens (see Known problems). This is our advice, not GitHub's.
5. Click **Register application**.
6. For the browser flow only, generate a client secret on the app's page. The exact button label is **not confirmed**.

Notes:
- **Callback matching.** GitHub has a new wildcard setting for callbacks. It's on for apps that had a single callback before 2026-08-03. When it's off, the redirect must match the callback URL exactly.
- **Device flow.** GitHub suggests the device flow only for constrained environments such as command-line tools. Otherwise it prefers PKCE.

Sources: [creating an OAuth app](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app), [authorizing OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps), [best practices](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/best-practices-for-creating-an-oauth-app).

---

## JIRA and Confluence (Atlassian)

**Code:** `src/plugins/jira/oauth.ts`, `src/plugins/confluence/oauth.ts`, `src/config/credentials.ts` (`JIRA_OAUTH_CONFIG`, shared by both)

**Sign-in**
- OAuth 2.0 (3LO) in the browser, with a `localhost` callback on a fixed port.
- The client secret is used for the code exchange **and for every token refresh**.

**What the vault stores:** access token, refresh token, expiry, cloud ID, site URL.

**Scopes**
- **JIRA:** `read:jira-work`, `write:jira-work`, `read:me`, `offline_access`
- **Confluence:** `read:page:confluence`, `write:page:confluence`, `read:space:confluence`, `read:comment:confluence`, `write:comment:confluence`, `search:confluence`, `read:me`, `offline_access`
- `search:confluence` is a **classic** scope; the other Confluence scopes are **granular**. `read:me` comes from the **User Identity API**. `offline_access` is requested in the authorization URL, not set in the console.

**What's needed**
- No review. Users see "not reviewed by Atlassian"; a Marketplace listing is optional.
- **Sharing** must be on in agentio's app's distribution settings. A 3LO app is private by default: only its creator can use it.
- **The personal data reporting API:** apps that store personal data must report stored accounts every 7 days and delete the data of closed accounts. ([guide](https://developer.atlassian.com/cloud/jira/platform/user-privacy-developer-guide/))

**Known problems**
- The client secret is in the public code. Atlassian's guidance says never to distribute it.
- Atlassian has no device flow and no sign-in method without a secret: PKCE for public apps is still a feature request, [ECO-283](https://jira.atlassian.com/browse/ECO-283).
- **Fix options:**
  - hosted vaults hold the secret on the server and do the exchange and refreshes there;
  - self-hosted users bring their own Atlassian app, which is free and needs no review. No option for that exists yet. Tracked in [#96](https://github.com/plosson/agentio/issues/96).
- **Atlassian's policy may forbid that second option.** Its docs say: "Apps that collect API tokens or instruct customers to create individual 3LO apps don't comply with our Security requirements for cloud apps and Acceptable use policy." It's unclear whether a self-hosted tool whose users each create a private app for themselves counts. Resolve this before building it.

### Create your own Atlassian app

agentio can't use your own Atlassian app yet. See the policy warning above.

1. On developer.atlassian.com, click your profile icon, then **Developer console > Create > OAuth 2.0 integration**.
2. Enter a name and choose the grant type: **Account-level grant**, or **Resource-level grant** (limited to the sites you select).
3. **Permissions:** click **Add** next to **Jira API**, **Confluence API** and **User Identity API** (for `read:me`).
4. For each API, click **Configure** and add the scopes listed above. The console's tab names are **not confirmed**.
5. **Authorization:** click **Configure** next to **OAuth 2.0 (3LO)**, set the **Callback URL** to `http://localhost:9999/callback` (the fixed port in agentio's code), then click **Save changes**. Whether Atlassian accepts a `localhost` callback is **not confirmed**.
6. **Settings:** copy the **Client ID** and **Secret**.
7. **Sharing:** leave it off if only you use the app. "When you create an OAuth 2.0 (3LO) app, it's private by default. This means that only you can install and use it."

Sources: [3LO apps](https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/), [enabling 3LO](https://developer.atlassian.com/cloud/oauth/getting-started/enabling-oauth-3lo/), [Jira scopes](https://developer.atlassian.com/cloud/jira/platform/scopes-for-oauth-2-3LO-and-forge-apps/), [Confluence scopes](https://developer.atlassian.com/cloud/confluence/scopes-for-oauth-2-3LO-and-forge-apps/), [managing apps](https://developer.atlassian.com/cloud/oauth/getting-started/managing-oauth-apps/).

---

## Dropbox

**Code:** `src/plugins/dropbox/`

**Sign-in**
- OAuth 2.0 with PKCE, with `token_access_type=offline` to get a refresh token.
- Dropbox shows the code in the browser, and the user pastes it.
- No secret and no redirect URI are used.

**What the vault stores:** app key, access token, refresh token, expiry, account ID, email, name.

**Scopes:** `account_info.read`, `files.metadata.read`, `files.content.read`, `files.content.write`, `sharing.read`, `sharing.write`

### Create your own Dropbox app (required)

1. Go to the [App Console](https://www.dropbox.com/developers/apps) and click **Create app**.
2. Choose scoped access, then the access type **Full Dropbox**, not **App folder**.
   - The access type **can't be changed later**. To change it, you must delete the app and create a new one.
   - The exact wizard label "Scoped access" is **not confirmed**.
3. Enter a name and click **Create app**.
4. On the **Permissions** tab, enable `account_info.read`, `files.metadata.read`, `files.content.read`, `files.content.write`, `sharing.read` and `sharing.write`, then save. Saving through a **Submit** button is shown in Dropbox's screenshots but **not confirmed** in its text.
5. On the **Settings** tab, copy the **App key**. agentio doesn't need the app secret.

Notes:
- **No redirect URI needed:** "if unspecified, the authorization code is displayed on dropbox.com for the user to copy and paste to your app."
- **The app stays in development status.** It works for your own account. Other users can be added with **Enable additional users**.
- **Scope changes:** if you change the scopes later, sign in again with `agentio dropbox profile add`.

Sources: [OAuth guide](https://docs.dropboxapi.com/dropbox-api/docs/oauth), [developer guide](https://www.dropbox.com/developers/reference/developer-guide), [App Console tutorial](https://docs.dropboxapi.com/dropbox-api/docs/get-started/tutorial/app-console).

**What's needed:** nothing from agentio. A single shared agentio app would need Dropbox production approval once it passes 50 users (the development limit is 500).

---

## Spotify

**Code:** `src/plugins/spotify/`

**Sign-in**
- OAuth 2.0 with PKCE, browser, callback on `http://127.0.0.1:3010/callback` (fixed port). Spotify rejects `localhost`.
- With `--no-browser`, the user pastes the redirect URL or the code.
- No secret is used.

**What the vault stores:** client ID, access token, refresh token, expiry, sign-in date (`authorizedAt`), granted scopes, user ID, display name, read-only flag.

**Scopes**
- Read: `user-read-private`, `user-library-read`, `user-follow-read`, `playlist-read-private`, `playlist-read-collaborative`, `user-top-read`, `user-read-recently-played`, `user-read-playback-state`, `user-read-currently-playing`, `user-read-playback-position`
- Write: `user-library-modify`, `user-follow-modify`, `playlist-modify-public`, `playlist-modify-private`, `ugc-image-upload`, `user-modify-playback-state`
- `--read-only` requests the read scopes only. Write and playback commands then fail with `READ_ONLY_PROFILE` before any request is sent.

### Create your own Spotify app (required)

Every agentio user runs a Development Mode app.

1. Go to the [Developer Dashboard](https://developer.spotify.com/dashboard) and click **Create app**. You need Spotify Premium, and the app owner must keep it.
2. Under **Redirect URIs**, add `http://127.0.0.1:3010/callback` exactly as written.
3. Under **Which API/SDKs are you planning to use**, select **Web API**.
4. Copy the **Client ID**. agentio doesn't need the client secret.
5. To let another person use the app, add their Spotify email under **User Management**. The limit is 5 people.

Then run `agentio spotify profile add --client-id <id>`. Without `--client-id`, the command prints these steps and asks for the ID.

Notes:
- **Sign-in lasts 6 months.** Since June 2026, Spotify refresh tokens expire 6 months after the first sign-in, and refreshing doesn't extend that. `agentio status` and `agentio doctor` warn when fewer than 14 days remain. Sign in again with `agentio profile reauth spotify`.
- **Library search is local.** The API can't search your own library or playlists, so `spotify library search` and `spotify playlist find` fetch every page on each run and filter locally. This uses many requests from the Development Mode quota.
- **Playback** needs Spotify Premium and an active device (desktop, phone, web player, or a daemon such as spotifyd). The API doesn't play audio itself.
- **Developer Terms** (v10 and later) forbid using Spotify content to train ML or AI models. Sending metadata to an LLM for a user-facing task is allowed; don't use exports or command output as training data.

**What's needed:** nothing from agentio. Each user's app stays in Development Mode, limited to 5 users.

---

## Revolut Business

**Code:** `src/plugins/revolut/`

**Sign-in**
- OAuth 2.0, authenticated with a JWT signed by the user's private key (client assertion).
- The user approves in the browser, then pastes the redirect URL or the code.
- Works with production or sandbox.

**What the vault stores:** environment, client ID, private key (PEM), redirect URI, access token, refresh token, expiry.

### Create your Revolut Business API access (required)

**Before you start**
- An active Revolut Business account on the **Grow** plan or above. This comes from Revolut's Help Centre and may vary by region.
- Your user must have the **Manage Integrations**, **Manage API** and **View Business** permissions.

**Steps**
1. **Create a private key and certificate:**
   ```
   openssl genrsa -out privatecert.pem 2048
   openssl req -new -x509 -key privatecert.pem -out publiccert.cer -days 1825
   ```
   Fill in at least one field when `openssl` asks, for example Country Name.
2. In the Revolut Business web app, click the gear icon (top right), then **APIs > Business API**.
3. Under **API Certificates**, click **Add API certificate**.
   1. Paste the whole content of `publiccert.cer`, including the BEGIN and END lines, into **X509 public key**.
   2. Set the **OAuth redirect URI**. For testing, Revolut says "you can use any URL", for example `https://example.com`. Whether `http://localhost` works is **not confirmed**.
   3. Give it a title and click **Continue**.
4. Copy the **ClientID**.
5. Run `agentio revolut profile add`. Give it the client ID, the path to `privatecert.pem` and the redirect URI.
6. agentio opens Revolut's consent page. Click **Authorise** and complete the 2-step check.
7. Revolut redirects to your redirect URI with a `code`. Paste the whole URL into agentio **within 2 minutes**, the code's lifetime.

Notes:
- **agentio signs its requests with your private key.** The key's issuer is taken from the redirect URI's domain, so that domain must match what you registered.
- **Sandbox:** a separate account at `sandbox-business.revolut.com`. Choose `sandbox` in agentio.
- **Token lifetimes:** access tokens last 40 minutes, and the refresh token doesn't expire.

Sources: [make your first API request](https://developer.revolut.com/docs/guides/manage-accounts/get-started/make-your-first-api-request), [sandbox](https://developer.revolut.com/docs/guides/manage-accounts/get-started/prepare-sandbox-environment), [Help Centre](https://help.revolut.com/en-IS/business/help/integrating-with-external-apps/revolut-business-api/question-using-revolut-business-api/).

**What's needed:** nothing from agentio. A single shared agentio app would need Revolut's Open Banking API, which is only for regulated providers (an AISP licence), so it isn't an option.

---

## Slack

**Code:** `src/plugins/slack/`

**Sign-in:** an incoming webhook URL. It can only **send** messages to one channel.

**What the vault stores:** webhook URL, channel name.

### Create your Slack webhook (required)

1. Open https://api.slack.com/apps?new_app=1, click **Create an app**, then **Blank app**, then **Continue**.
2. Enter the **App Name**, select the **Workspace**, then click **Create**.
3. In the left sidebar, click **Incoming Webhooks** and switch **Activate Incoming Webhooks** on.
4. Click **Add New Webhook to Workspace**, choose a channel, and confirm. For a private channel, you must be a member first.
5. Copy the URL from **Webhook URLs for Your Workspace**. It starts with `https://hooks.slack.com/services/`.

Notes:
- **Admin approval.** If your workspace requires admin approval for apps, step 4 becomes a request that an Owner or app manager must approve.
- **What a webhook can't do:** it posts only to its own channel, and can't change the sender's name or icon, or delete messages.
- **agentio's own setup text is outdated.** It says "create a new app"; Slack's current flow is "Create an app" then "Blank app".

Sources: [incoming webhooks](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks), [app quickstart](https://docs.slack.dev/app-management/quickstart-app-settings), [app approval](https://slack.com/help/articles/222386767).

**What's needed:** nothing. If Slack is ever used to **read** messages through a shared OAuth app, apps outside the Slack Marketplace are limited to 1 request per minute and 15 messages on `conversations.history` and `conversations.replies`. That would need a Marketplace listing, which means Slack's review.

---

## Discourse

**Code:** `src/plugins/discourse/`

**Sign-in:** an admin API key, sent in the `Api-Key` header with a username.

**What the vault stores:** forum URL, API key, username.

### Create your Discourse API key (required)

You need to be an admin of the forum.

1. Go to **Admin > Advanced > API Keys** (`<forum>/admin/api/keys`) and click **Add API key**.
2. Fill in **Description**.
3. Choose **User Level**:
   - **Single User**: the key acts as one user, and a username field appears.
   - **All Users**: the key acts as whichever user is named in each request.
4. Choose **Scope**:
   - **Global**: anything that user may do.
   - **Read-only**: reading only.
   - **Granular**: you pick the allowed actions.
   Which granular scopes agentio's commands need is **not confirmed**. **Global** works.
5. Click **Save** and copy the key. **It's shown only once.**
6. Run `agentio discourse profile add` with the forum URL, the key and the username.

Notes:
- **A key can't do more than its user can.**
- **Discourse revokes keys that go unused for 180 days,** by default (the site setting `revoke_api_keys_unused_days`).
- **agentio's own setup text is outdated.** It says "New API Key"; the button is now **Add API key**.

Source: [create and configure an API key](https://meta.discourse.org/t/create-and-configure-an-api-key/230124).

**What's needed:** nothing.

---

## Falco (Horus Software)

**Code:** `src/plugins/falco/`

**Sign-in**
- Email and password on Horus's sign-in service (`accounts.horus-software.be`), plus an optional second factor.
- The password isn't stored.
- The profile is tied to one organisation.

**What the vault stores:** refresh token and its expiry, access token, organisation, user ID and email.

**Scopes:** `myhorus`, `billing`, `falco`, `oclaf` at sign-in. Refreshes return only 3 of the 4.

**What's needed:** no app registration. **To check:** that Horus's terms allow a third-party tool to sign in on the user's behalf.

---

## SQL

**Code:** `src/plugins/sql/`

**Sign-in:** a database connection URL. PostgreSQL, MySQL and SQLite are supported.

**What the vault stores:** connection URL (with the password, if the URL has one) and a display name.

**What's needed:** nothing. For safety, use a database user with the least access needed, ideally read-only.

---

## RSS

**Code:** `src/plugins/rss/`

**Sign-in:** none. Reads public feeds by URL.

**What's needed:** nothing.

---

## Related

- [#94](https://github.com/plosson/agentio/issues/94): vault key slots, so agent keys can unlock the vault after a restart.
- [#95](https://github.com/plosson/agentio/issues/95): GitHub device flow, removing the GitHub secret.
- [#96](https://github.com/plosson/agentio/issues/96): Atlassian, bringing your own app and keeping the secret off users' machines.
- [#84](https://github.com/plosson/agentio/issues/84): planned WhatsApp connector. It uses an unofficial client library (Baileys), so it carries a risk of account bans. Add it here when it ships.
- How to write a plugin: `docs/service-plugins.md` and `docs/plugin-sdk.md`.
