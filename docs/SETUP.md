# Setup Guide

End-to-end setup: Google Sheet → Apps Script pipeline → Chrome extension → Android app.
Allocate **45–60 minutes** for the first run. Subsequent re-deploys take minutes.

---

## Prerequisites

| Requirement | Purpose |
|---|---|
| Google account | Owns the sheet, runs Apps Script, sends Gmail |
| Anthropic API key | Claude composition (https://console.anthropic.com) |
| Google AI Studio API key | Gemini research (https://aistudio.google.com) |
| Google Cloud project | OAuth credentials for the extension & extractor |
| Chrome ≥ 116 | Extension (MV3) |
| Android 11+ phone | Optional — Android app |
| Python 3.10+ | Optional — Gmail extractor |

---

## Step 1 — Google Sheet

1. Create a new Google Sheet called `AutoMail Pipeline`.
2. Copy the Sheet ID from the URL (`/d/<THIS_PART>/edit`) — you'll need it.
3. Rename the default tab to **Sheet1** (raw capture). Create a **Sheet2** tab (pipeline queue). Apps Script will add `PipelineLog` and `FollowUps` tabs automatically.

---

## Step 2 — Apps Script project

1. From the sheet: **Extensions → Apps Script**. Delete the default `Code.gs`.
2. **Project Settings → Show `appsscript.json`**. Replace its contents with [gmail-apps-script/appsscript.json](../gmail-apps-script/appsscript.json).
3. Back in the editor, create one script file per `.gs` in [gmail-apps-script/](../gmail-apps-script) and paste the contents:
   - `Config` → `Config.gs`
   - `Code`, `Code111`, `ApiClients`, `SheetReader`, `ResearchEngine`, `Classifier`, `ResumeSelector`, `EmailComposer`, `Humanizer`, `QualityGate`, `MasterValidator`, `EmailEnricher`, `GmailDrafter`, `BatchProcessor`, `FollowUp`
4. Save all (**Ctrl+S**).

### Replace placeholders

Open `Config.gs` and set `CONFIG.SHEET_ID` to your sheet ID (replaces `YOUR_GOOGLE_SHEET_ID`). Open `Code111.gs` and do the same for the hard-coded `SpreadsheetApp.openById()` calls.

### Set API keys (script properties, not code)

1. In the sheet, **refresh the page** so the custom menu loads.
2. **AutoMail Pipeline → Setup → ⚡ Quick Setup (Columns + Keys)**.
3. Authorise the script (standard Google OAuth flow; click through "Advanced → Go to project (unsafe)" for personal scripts).
4. Quick Setup prompts for:
   - `CLAUDE_API_KEY`
   - `GEMINI_API_KEY`
5. Optional: **AutoMail Pipeline → Setup → Set Resume Drive IDs** — upload your three resume PDFs to Drive with the expected filenames and the pipeline auto-discovers them, or paste the File IDs manually.

### Test

**AutoMail Pipeline → Setup → 4. Test API Connections** — expects `Gemini: CONNECTED` and `Claude: CONNECTED`.

### Install triggers

- **AutoMail Pipeline → Setup → 5. Setup Follow-Up Trigger** — daily 9 AM.
- **AutoMail Pipeline → Setup → 6. Setup Auto-Process Trigger** — fires on Sheet2 edit.

---

## Step 3 — Deploy as Web App

Needed for the Android app and extension to POST leads into the sheet.

1. **Deploy → New deployment → gear icon → Web app**.
2. Description: `AutoMail ingest v1`
3. Execute as: **Me**
4. Who has access: **Anyone**
5. **Deploy → copy the `/exec` URL.**
6. Test by opening the URL in a browser — you should see:
   ```json
   { "status": "active", "version": "2.0", "features": ["linkedin_capture", "automail_sync"] }
   ```

Save the URL; both the Android app and the Chrome extension will POST to it.

---

## Step 4 — Chrome extension

1. [Create an OAuth 2.0 Chrome App client ID in GCP](https://console.cloud.google.com/apis/credentials) scoped to `https://www.googleapis.com/auth/spreadsheets`.
2. In [chrome-extension/manifest.json](../chrome-extension/manifest.json), replace `YOUR_OAUTH_CLIENT_ID` with the client ID you just created.
3. `chrome://extensions` → toggle **Developer mode** → **Load unpacked** → select the [chrome-extension/](../chrome-extension) folder.
4. Click the extension icon → **Settings tab** → paste:
   - Your Google Sheet ID (replaces `YOUR_GOOGLE_SHEET_ID` at runtime, not in code).
   - Gemini API key.
5. Navigate to any LinkedIn profile → click the extension → **Extract**.

Read more: [chrome-extension/README.md](../chrome-extension/README.md).

---

## Step 5 — Android app (optional)

The Android source is proprietary; the APK is distributed via the [android-app/](../android-app) release notes.

1. Install `LinkedInDataAgent_v1.1.apk` (allow "Install unknown apps" for your file manager).
2. On first launch: **Settings → Accessibility → LinkedIn Data Agent → enable**.
3. **Settings inside the app:**
   - Gemini API key
   - Apps Script Web App URL (from Step 3)
   - Optional: Apollo, RocketReach, Hunter keys for email enrichment
4. Open LinkedIn app → any profile → tap the floating button.

Read more: [android-app/README.md](../android-app/README.md).

---

## Step 6 — Gmail extractor (optional seeding)

Bootstraps Sheet2 from people you've already emailed.

```bash
cd gmail-extractor
python -m venv .venv && source .venv/bin/activate   # PowerShell: .venv\Scripts\Activate.ps1
pip install -r requirements.txt
python -m spacy download en_core_web_lg
cp credentials.example.json credentials.json
# Fill in credentials.json with your OAuth desktop client from GCP Console
python intelligent_extractor.py
```

Output: `extracted_contacts_database.csv`. Clean and copy relevant rows into Sheet2 columns A-F.

Read more: [gmail-extractor/README.md](../gmail-extractor/README.md).

---

## Verify end-to-end

1. Add one test lead manually in Sheet2 row 2: Full_Name (B), Email (F), Designation (D), Organization (E).
2. Click any cell in row 2 → **AutoMail Pipeline → Process Single Lead (Current Row)**.
3. Watch columns G-U fill in over ~30 seconds: `NEW → RESEARCHING → … → DRAFT_CREATED`.
4. Open Gmail → Drafts → you should see the composed email with the resume attached.
5. Send it → Status flips to `SENT` on the next pipeline run.
6. Three / seven / fourteen days later, follow-ups land in the same thread.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Custom menu missing | F5 the sheet. If still missing, re-save `Code.gs` and reload. |
| `Gemini: FAILED — empty response` | Gemini 2.5 "thinking" model quirk. `ApiClients.gs` already sets `thinkingBudget: 0` for structured-JSON calls. If you've edited, revert. |
| `Claude: FAILED — invalid_request` | Wrong model name. Check `CONFIG.CLAUDE_MODEL` in Config.gs. |
| Stuck row | **AutoMail Pipeline → Tools → Reset Current Row Status** → re-run. |
| LinkedIn data never syncs | Ensure the lead has an email; Sheet2 sync is gated on it. |
| Draft not threaded | Check col V (ThreadId) and W (Message-ID) are populated. Follow-up uses both. |
| Exceeding daily quota | `CONFIG.DAILY_DRAFT_LIMIT` is 25. Raise carefully — Gmail flags aggressive warmup. |

More: [gmail-apps-script/README.md](../gmail-apps-script/README.md#troubleshooting).
