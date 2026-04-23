# AutoMail Pipeline

> **End-to-end cold-email automation: LinkedIn profile → enriched lead → researched dossier → personalised email → Gmail draft → threaded follow-ups.**
>
> Built as a multi-surface system — an **Android app** and a **Chrome extension** feed an **Apps Script** pipeline that uses **Claude** for composition, **Gemini** (with Google Search grounding) for research, and **Gmail** for delivery.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Apps Script](https://img.shields.io/badge/Google%20Apps%20Script-V8-4285F4)](https://developers.google.com/apps-script)
[![Chrome MV3](https://img.shields.io/badge/Chrome-Manifest%20V3-1A73E8)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![Android](https://img.shields.io/badge/Android-11%2B-3DDC84)](./android-app)

---

## 1. What this repo does

You are on LinkedIn. You see a profile you'd love to talk to. One tap (phone) or one click (browser) later:

1. The profile's **name, headline, designation, organisation, email, phone, website, location** are scraped and verified.
2. The contact lands in your **Google Sheet** (Sheet1 = raw capture, Sheet2 = pipeline queue) with no duplicates.
3. An **Apps Script pipeline** picks the new row up and runs it through a deterministic state machine:
   `NEW → RESEARCHING → RESEARCH_DONE → CLASSIFYING → COMPOSING → HUMANIZING → QUALITY_CHECK → DRAFT_CREATED → SENT → FOLLOWUP_1 → FOLLOWUP_2 → FOLLOWUP_3 → RESPONDED`
4. **Gemini 2.5 Flash** (with Google Search grounding) researches the lead + their company in real time.
5. A **classifier** maps the lead to one of six archetypes (Founder / VP / Manager / IC / People-Ops / Skip) and picks the right **resume variant** (Growth-Marketing / Ops-Consulting / Product-AI-Strategy).
6. **Claude Sonnet 4.5** composes a ≤125-word email anchored to verified achievements from a fact-bank.
7. A **3-layer humanizer** + **7-stage quality gate** strip AI tells, check spam triggers, enforce length/subject rules, and verify every number against the achievement bank (anti-hallucination).
8. A Gmail **draft** is created with the right resume PDF attached, threaded, and RFC-2822-tagged.
9. **Follow-ups fire on Day 3 / 7 / 14** anchored to the actual send date, in the same thread.

Every step writes status back to the sheet, so any row can be resumed from the last good stage.

---

## 2. Pipeline at a glance

```
┌─────────────────────────────────────────────────────────────────────────┐
│  CAPTURE SURFACES                                                       │
│  ┌─────────────────────┐     ┌──────────────────────┐                   │
│  │ Android App         │     │ Chrome Extension     │                   │
│  │ (accessibility +    │     │ (MV3 + Gemini Vision │                   │
│  │  Gemini Vision)     │     │  + OAuth2)           │                   │
│  └──────────┬──────────┘     └──────────┬───────────┘                   │
│             │  POST /exec                │  sheets.googleapis.com       │
│             │  (JSON lead)               │  (OAuth2 user token)         │
└─────────────┼────────────────────────────┼──────────────────────────────┘
              ▼                            ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  GOOGLE SHEET                                                           │
│  Sheet1: raw capture (12 cols)   Sheet2: pipeline queue (25 cols)       │
│                                   A-F input | G-U state | V-Y threading │
└─────────────────────────────────┬───────────────────────────────────────┘
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  APPS SCRIPT PIPELINE (V8 runtime, time-driven triggers)                │
│                                                                         │
│   SheetReader  → EmailEnricher → ResearchEngine → Classifier →          │
│   ResumeSelector → EmailComposer → Humanizer → QualityGate →            │
│   MasterValidator → GmailDrafter → BatchProcessor → FollowUp            │
│                                                                         │
│   AI layer: Gemini 2.5 Flash (research + grounding)                     │
│             Claude Sonnet 4.5 (composition + follow-up)                 │
└─────────────────────────────────┬───────────────────────────────────────┘
                                  ▼
                        Gmail Drafts (threaded)
```

See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for the full component-level diagram and [docs/PIPELINE_OVERVIEW.md](./docs/PIPELINE_OVERVIEW.md) for a stage-by-stage walkthrough.

---

## 3. Repo layout

```
automail-pipeline/
├── README.md                   ← you are here
├── LICENSE
├── .gitignore
├── .env.example                ← all secrets listed as placeholders
├── docs/
│   ├── ARCHITECTURE.md
│   ├── PIPELINE_OVERVIEW.md
│   ├── SETUP.md
│   ├── COST_BREAKDOWN.md
│   └── chrome-extension-notes/ ← historical change logs for the extension
├── android-app/                ← APK architecture & state machine (source is proprietary)
├── chrome-extension/           ← Chrome MV3 extension (background/content/popup)
├── gmail-apps-script/          ← 17 .gs files: the whole pipeline
└── gmail-extractor/            ← Python OAuth2 extractor for seed data
```

Every surface has its own `README.md` with setup, architecture, and extension points.

---

## 4. Surfaces — at a glance

| Surface | Tech | What it does | Source |
|---|---|---|---|
| **Android app** | Java, Accessibility Service, Gemini 2.5 Flash Vision, Apollo + RocketReach + Hunter | Watches LinkedIn app, screenshots profile, extracts structured data via vision, cross-validates emails through 3 enrichment APIs, posts to Apps Script Web App. | `android-app/` (architecture + APK release notes — source is proprietary) |
| **Chrome extension** | Manifest V3, Gemini, Chrome Identity API, Google Sheets API v4 | Low-signature, user-initiated LinkedIn page extractor. Uses OAuth2 to write directly to Google Sheets. | [`chrome-extension/`](./chrome-extension) |
| **Apps Script pipeline** | Google Apps Script V8, Gmail / Drive / Sheets API, Claude, Gemini | The outreach brain. Reads Sheet2, researches, composes, validates, drafts, and schedules follow-ups. | [`gmail-apps-script/`](./gmail-apps-script) |
| **Gmail extractor** | Python 3.10+, Gmail API, spaCy NER | One-shot contact-graph extractor from your own sent box. Useful for bootstrapping the lead list. | [`gmail-extractor/`](./gmail-extractor) |

---

## 5. Quick start (5 minutes)

The three surfaces can run independently. Follow [docs/SETUP.md](./docs/SETUP.md) for the full walk-through. TL;DR:

1. **Fork + clone this repo.**
2. **Apps Script:** open a Google Sheet → Extensions → Apps Script → paste the 17 `.gs` files from `gmail-apps-script/` + the `appsscript.json` manifest. Run `menuQuickSetup()` once.
3. **Add your keys** via the sheet menu (`AutoMail Pipeline → Setup → Set API Keys`) — Claude + Gemini. They are stored in Script Properties, not in code.
4. **Deploy the Apps Script as a Web App** (Execute as: Me, Access: Anyone) to get the `/exec` URL your capture surfaces will POST to.
5. **Chrome extension:** `chrome://extensions → Load unpacked → chrome-extension/`, then paste your OAuth client ID in `manifest.json` and the Web App URL in the popup settings.
6. **Android app:** download the APK from the [android-app/](./android-app) release notes, install, grant Accessibility permission, paste the Web App URL in settings.

---

## 6. Everything that has been masked

This repo is a clean export — no real secrets are committed. Every one of the following has been replaced with a placeholder:

| Placeholder | Meaning | Where to get it |
|---|---|---|
| `YOUR_CLAUDE_API_KEY` | Anthropic Claude API key | https://console.anthropic.com |
| `YOUR_GEMINI_API_KEY` | Google AI Studio Gemini key | https://aistudio.google.com |
| `YOUR_GOOGLE_SHEET_ID` | Target Sheet ID (from Sheet URL after `/d/`) | Sheets UI |
| `YOUR_OAUTH_CLIENT_ID` | OAuth 2.0 Desktop / Chrome client ID | GCP Console → APIs & Services → Credentials |
| `YOUR_OAUTH_CLIENT_SECRET` | OAuth 2.0 client secret | same |
| `YOUR_GCP_PROJECT_NUMBER` | Google Cloud project number | GCP Console → Home |
| `YOUR_BRIGHTDATA_API_KEY` | Bright Data proxy key (optional — extension only) | https://brightdata.com |
| `your.email@example.com` | Your sender email | the one you'll send from |

Fill these in via environment variables / Script Properties / UI — never back into source. A `.env.example` template is in the root.

---

## 7. Cost

| Tier | Monthly | Profiles / month | Best for |
|---|---|---|---|
| **Starter** | ~₹4,100 (~$49) | ~900 | Individual users (Apollo + free Gemini/Claude dev tier) |
| **Pro** | ~₹6,950 | 900+ | Adds Hunter.io Starter for higher email-match confidence |
| **Pro + Phones** | ~₹10,200 | 900+ | Adds RocketReach Essentials for phone discovery |

Full breakdown: [docs/COST_BREAKDOWN.md](./docs/COST_BREAKDOWN.md).

---

## 8. Safety & ethics

- **Gmail rate limits:** hard-capped at 25 drafts/day, 20 sends/day, 3-second inter-draft delay, with a 5-week warmup schedule (5 / 10 / 15 / 20 / 25). See `gmail-apps-script/Config.gs` (`DELIVERABILITY`).
- **Anti-hallucination:** every number, role, and alumni claim in a generated email is cross-checked against `GAURAV_ACHIEVEMENT_BANK` and `GAURAV_FACTS` — unverified claims bounce the email back to `REVIEW`.
- **Spam-trigger filtering:** 40+ fatal + warning words are stripped pre-draft (see `SPAM_TRIGGER_WORDS`).
- **OAuth scopes:** all surfaces request the minimum scope needed. Extension requests `spreadsheets` only; Apps Script requests compose/modify/drive/external_request only.
- **LinkedIn ToS:** this is a user-initiated tool that pulls data from pages you are already logged in to view. No headless scraping, no automated crawling, no ToS evasion.

---

## 9. License

MIT — see [LICENSE](./LICENSE). Use it, fork it, ship it; just don't blame me if Gmail flags your domain because you skipped the warmup schedule.

---

*Built by Gaurav Rathore. Credits: Anthropic Claude, Google Gemini, Apollo.io, RocketReach, Hunter.io, and the Apps Script team.*
