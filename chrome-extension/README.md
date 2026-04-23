# Chrome Extension — LinkedIn Data Agent

Low-signature, user-initiated Chrome extension (Manifest V3) that extracts structured profile data from any LinkedIn page you're logged in to view and writes it directly to your Google Sheet via Sheets API v4.

> **Philosophy:** no headless scraping, no background crawling, no ToS evasion. You open a profile, you click Extract, data flows. That's it.

---

## Files

| File | Role |
|---|---|
| [`manifest.json`](./manifest.json) | MV3 manifest — permissions, OAuth2, host permissions |
| [`background.js`](./background.js) | Service worker — injection, OAuth2 token lifecycle, optional proxy setup |
| [`content.js`](./content.js) | Injected into LinkedIn pages — scrapes DOM + calls Gemini |
| [`popup.html`](./popup.html) | UI (three tabs: Extract / Resume AI / Settings) |
| [`popup.js`](./popup.js) | Popup logic — settings persistence, extract trigger, Sheets write |
| [`setup-google-sheets.html`](./setup-google-sheets.html) | First-run Sheets setup wizard |
| `test-*.html` | Standalone test harnesses for extraction, Sheets, AI, and outreach features |
| `icons/` | 16/48/128 PNG icons |

---

## Architecture

```
User on linkedin.com/in/someone
        │
        │ click extension icon
        ▼
┌──────────────┐    chrome.runtime.sendMessage('initiate_extraction')
│  popup.js    │────────────────────────────────────────────────────►┐
└──────────────┘                                                     │
                                                                     ▼
                                                        ┌──────────────────┐
                                                        │  background.js   │
                                                        │  (service worker)│
                                                        └────────┬─────────┘
                                                                 │ chrome.scripting.executeScript
                                                                 ▼
                                          ┌────────────────────────────────┐
                                          │  content.js (injected into tab)│
                                          │  1. DOM scrape                 │
                                          │  2. Gemini structure/validate  │
                                          │  3. Send back via message      │
                                          └─────────┬──────────────────────┘
                                                    │ 'extraction_complete'
                                                    ▼
                          ┌─────────────────────────────────────┐
                          │  background.js stores to            │
                          │  chrome.storage.local[tabId]        │
                          └────────┬────────────────────────────┘
                                   │
                                   │ popup polls for result
                                   ▼
                          ┌──────────────────────────────┐
                          │  popup.js writes to Sheets   │
                          │  via chrome.identity OAuth2  │
                          │  (spreadsheets.values.append)│
                          └──────────────────────────────┘
```

---

## Install

1. `git clone` this repo.
2. Open `chrome-extension/manifest.json`, replace:
   - `YOUR_OAUTH_CLIENT_ID.apps.googleusercontent.com` with your Chrome app OAuth 2.0 client ID.
3. `chrome://extensions` → toggle **Developer mode** → **Load unpacked** → select the `chrome-extension/` folder.
4. Click the extension → **Settings tab**:
   - Paste your Sheet ID.
   - Paste your Gemini API key.
   - (Optional) Enable Google Sheets export toggle.
5. (First time only) Click **Save Configuration** → you'll be prompted to consent to the Sheets scope.
6. Navigate to any LinkedIn profile → click the extension → **Extract Profile Data**.

### Create the OAuth client

[GCP Console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials):

1. **Create Credentials → OAuth client ID → Chrome app**.
2. **Application ID**: the 32-char extension ID from `chrome://extensions` (visible after Load unpacked).
3. Enable the **Google Sheets API** and **Google Drive API** on the same project.
4. Copy the client ID into `manifest.json`.

---

## Permissions explained

| Permission | Why |
|---|---|
| `activeTab` | Access the current LinkedIn tab only when the user clicks the extension |
| `scripting` | Inject `content.js` into the active tab on demand |
| `storage` | Persist user settings (Sheet ID, API key) across sessions |
| `identity` | Get an OAuth2 token for Sheets API via `chrome.identity.getAuthToken` |
| `proxy`, `webRequest`, `webRequestAuthProvider` | Optional Bright Data proxy support (commented out by default in `background.js`) |
| `<all_urls>` host | Needed for Sheets API calls; LinkedIn-only scraping is enforced in content.js |

The extension does **not** request `tabs` — it can't enumerate your browsing history. It does not request `history`. It only reads the active tab when you click.

---

## What the extension does NOT do

- No automated crawling. One click = one profile.
- No background browsing.
- No data exfiltration. Everything goes to **your** Sheet via **your** OAuth token.
- No telemetry to the author. No external analytics beacons.

---

## Development notes

- `content.js` is ~8000 lines because it embeds the LinkedIn DOM-selector heuristics, email-pattern generator, and Gemini call logic inline. In production you'd split it; it's inline here to avoid MV3 bundling headaches.
- `popup.js` uses `chrome.identity.getAuthToken({ interactive: true })`. First call prompts consent; subsequent calls are silent until the token expires (~1 hr).
- `background.js` line 330+: there's a commented-out `getOAuth2Token()` example for a `Promise`-based token fetcher — enable it if you want to refactor the callback-based `handleOAuthTokenRequest`.

---

## Historical change logs

The original private repo had one document per enhancement iteration. They're preserved in [../docs/chrome-extension-notes/](../docs/chrome-extension-notes/) for provenance, but most are superseded by this README.

Starting points, still useful:
- [`README-Project-Fusion-2.0.md`](../docs/chrome-extension-notes/README-Project-Fusion-2.0.md) — full feature spec
- [`GOOGLE-SHEETS-TROUBLESHOOTING.md`](../docs/chrome-extension-notes/GOOGLE-SHEETS-TROUBLESHOOTING.md) — OAuth consent issues
- [`ADVANCED-API-SETUP-GUIDE.md`](../docs/chrome-extension-notes/ADVANCED-API-SETUP-GUIDE.md) — Bright Data proxy walk-through

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Extract button does nothing | Open DevTools on the popup (right-click → Inspect popup) → check console. Usually a bad Sheet ID or missing OAuth client. |
| `OAuth2 not granted or revoked` | Remove the extension's cached token: `chrome://identity-internals` → Revoke → reload extension. |
| Data arrives but sheet is empty | `manifest.json` `oauth2.scopes` is limited to `spreadsheets`. Add `drive.file` if you want to create sheets programmatically. |
| Gemini returns empty | Check you pasted the key without whitespace. Test at [AI Studio](https://aistudio.google.com). |
| Content script doesn't inject | Some LinkedIn pages (login walls, public /pub/ profiles) block injection. Open the profile while logged in. |
