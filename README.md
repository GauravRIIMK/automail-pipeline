# AutoMail Pipeline

> **End-to-end cold-email automation: LinkedIn profile → enriched lead → researched dossier → personalised email → Gmail draft → threaded follow-ups.**
>
> Built as a multi-surface system — an **Android app** and a **Chrome extension** feed an **Apps Script** pipeline that uses **Claude** for composition, **Gemini** (with Google Search grounding) for research, and **Gmail** for delivery.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Apps Script](https://img.shields.io/badge/Google%20Apps%20Script-V8-4285F4)](https://developers.google.com/apps-script)
[![Chrome MV3](https://img.shields.io/badge/Chrome-Manifest%20V3-1A73E8)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![Android](https://img.shields.io/badge/Android-11%2B-3DDC84)](./android-app)

---

## ✨ What makes this first-of-its-kind

Cold-outreach automation isn't new — Apollo, Outreach, lemlist, and Instantly have existed for years. What's novel here is the **combination of five choices that no existing tool makes *together*:**

1. **Capture at the source.** You add a lead from *inside the LinkedIn app you're already scrolling* — one tap on the phone, one click in the browser — not by exporting a CSV or pasting a URL into a dashboard. The gap between "I should reach out to them" and "they're in the pipeline" collapses to a single gesture.
2. **It runs on infrastructure you already own.** The entire brain is a **Google Sheet + Apps Script** — no server to rent, no per-seat subscription, no data leaving your Google account. Your CRM, your queue, and your automation are the *same spreadsheet* you can open and edit by hand.
3. **The AI writes drafts — it never sends.** Every other "AI SDR" optimises for hands-off sending, which is exactly what torches sender reputation and fires hallucinations off at scale. This inverts that: it automates the 95% that's tedious (research, writing, formatting, attaching, scheduling) and leaves the 5% that carries the risk — hitting *send* — to you.
4. **The model is fact-checked, not trusted.** Every number, role, and claim the LLM writes is cross-checked against a verified fact-bank; anything it can't prove bounces the email back to review. The LLM is treated as a *constrained draft-writer*, not an oracle — the opposite of "let the model write it and hope."
5. **Production reliability on a 'toy' platform.** Apps Script is normally used for throwaway scripts. This applies real site-reliability discipline to it — self-healing triggers, lock-serialised writes, an idempotent resumable state machine, quota-aware back-off — so it survives running unattended for weeks.

> **The deepest novelty is conceptual:** most tools sell you *an AI that sends emails.* This is *a verification-and-reliability pipeline that happens to use an AI to draft them.* That inversion is what makes the output trustworthy enough to put your own name on.

---

## 🧠 The logic — and why it's the right one

Every major design decision is a deliberate answer to a specific risk. The reasoning, made explicit:

| Design choice | Why it's the logical one (the second-order reasoning) |
|---|---|
| **A spreadsheet as the database** | Free, zero-ops, and *visible* — you watch every lead move through its states and fix one by editing a cell. The sheet is the database, the dashboard, **and** the manual-override console at once. At single-operator scale a "real" database would add ops cost and *remove* that transparency. |
| **A deterministic state machine** | Outreach is a long-running, interruptible job on a flaky platform. Writing each lead's status back after every step means any lead **resumes from its last good step** — a crash never loses work or double-charges an API. |
| **Draft, don't send** | The marginal *value* of automating the final send is tiny; the marginal *risk* (a flawed email to a dream contact, or a burned sending domain) is enormous. Automating up-to-the-send and stopping is the only rational risk/reward split. |
| **Verify every claim** | A hallucinated metric in a cold email to an investor or hiring manager is *instantly* disqualifying, while a verification lookup is nearly free. When the downside is catastrophic and the check is cheap, you **always** check. |
| **A multi-vendor enrichment waterfall** | No single email source has full coverage. Cascading providers (Apollo → Hunter → Snov → pattern) and stopping at the first verified hit maximises match rate while minimising cost — you only pay the next vendor when the previous one misses. |
| **Idempotent, self-healing, lock-serialised** | The substrate (Apps Script triggers, Gmail quotas) is unreliable *by nature*. The logical response to an unreliable foundation is to make every operation retry-safe, every trigger self-repairing, and every write conflict-free. |

> **The throughline:** *assume every component will fail, make failure cheap and recoverable, and keep a human at the one irreversible step.*

---

## ⏱️ How it changes your day-to-day

A genuinely personalised, researched cold email — find the person, read their background and company news, locate a valid address, write something tailored, attach the right document, and remember to follow up three times — takes a careful person **20–40 minutes**. This compresses it to about **two minutes of your attention**: one tap to capture, a glance to approve the draft, one click to send.

What that actually changes:

- **Reach stops being rationed by time.** When quality outreach costs ~2 minutes instead of ~30, you can finally contact the people you'd normally skip "because it isn't worth the effort." The economics of attention flip.
- **Follow-ups actually happen.** Most people send one email and quit — yet most replies come from the 2nd and 3rd touch. Automatic Day 3 / 7 / 14 follow-ups (in-thread, anchored to the real send date) roughly **triple your touchpoints** without a single reminder.
- **Your *worst* email gets better.** Every message is researched, fact-checked, and spam-filtered before you ever see it — so even on a tired day, nothing generic, false, or sloppy goes out under your name.
- **The mental overhead disappears.** No blank page, no "did I already email them?", no spreadsheet bookkeeping. The pipeline *is* the memory.

> **The second-order effect is the real one:** it converts outreach from a *batch-and-blast vs. hand-craft-a-few* trade-off into **hand-crafted quality at blast scale** — while the human-in-the-loop send keeps you in control of, and learning from, every message.

---

## 🎯 Who it's for — pitch decks, B2B sales, and beyond

Job applications were just the *first* use. Strip it to the architecture and this is a **personalised-outreach engine**: capture → enrich → research → write → verify → draft → follow up. Only **three** things are domain-specific — *the attachment, the fact-bank, and the message templates.* Everything else is universal, which is why it re-points at a new use case in minutes, not weeks.

| Who | What they capture | What the engine does | What you swap in |
|---|---|---|---|
| **Startup founder → investors** | A VC / angel from LinkedIn | Researches their thesis + recent cheques, writes a tailored intro that references their portfolio, **attaches your pitch deck**, then follows up | Resume → **pitch deck**; fact-bank → your traction metrics |
| **B2B sales / SDR** | A VP / Director at a target account | Finds the work email, writes a value-prop tied to their role + the company's recent news, attaches a one-pager, sequences the follow-ups | Resume → **one-pager / case study**; templates → your offer |
| **Recruiter / sourcer** | A passive candidate | Personalised outreach referencing their actual background, attaches the role's spec | Resume → **job description** |
| **Partnerships / BD** | A potential partner | Researches their company and proposes a *specific, concrete* collaboration | Fact-bank → your partnership assets |
| **Consultant / agency** | A decision-maker | Case-study-anchored outreach that proves relevant, verifiable results | Fact-bank → your client wins |
| **Job seeker** *(original)* | A hiring manager / future team lead | Archetype-matched application email with the right resume variant attached | — *(works out of the box)* |

> **Why one engine covers all of these:** the hard, universal, risky parts — deliverability, email-finding, real-time research, anti-hallucination, follow-up sequencing, and unattended reliability — are solved **once**, inside the pipeline. Re-aiming it at a new campaign means changing only **what you attach and what you're allowed to claim** — never rebuilding the machine.

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
├── gmail-apps-script/          ← 59 .gs files: the whole pipeline + test suite
└── gmail-extractor/            ← Python OAuth2 extractor for seed data
```

Every surface has its own `README.md` with setup, architecture, and extension points.

---

## 4. Surfaces — at a glance

| Surface | Tech | What it does | Source |
|---|---|---|---|
| **Android app** | Java, Accessibility Service, Gemini 2.5 Flash Vision, Apollo + RocketReach + Hunter | Watches LinkedIn app, screenshots profile, extracts structured data via vision, cross-validates emails through 3 enrichment APIs, posts to Apps Script Web App. | `android-app/` (architecture write-up only — source and APK are not published) |
| **Chrome extension** | Manifest V3, Gemini, Chrome Identity API, Google Sheets API v4 | Low-signature, user-initiated LinkedIn page extractor. Uses OAuth2 to write directly to Google Sheets. | [`chrome-extension/`](./chrome-extension) |
| **Apps Script pipeline** | Google Apps Script V8, Gmail / Drive / Sheets API, Claude, Gemini | The outreach brain. Reads Sheet2, researches, composes, validates, drafts, and schedules follow-ups. | [`gmail-apps-script/`](./gmail-apps-script) |
| **Gmail extractor** | Python 3.10+, Gmail API, spaCy NER | One-shot contact-graph extractor from your own sent box. Useful for bootstrapping the lead list. | [`gmail-extractor/`](./gmail-extractor) |

---

## 5. Quick start (5 minutes)

The three surfaces can run independently. Follow [docs/SETUP.md](./docs/SETUP.md) for the full walk-through. TL;DR:

1. **Fork + clone this repo.**
2. **Apps Script:** open a Google Sheet → Extensions → Apps Script → paste the 59 `.gs` files from `gmail-apps-script/` + the `appsscript.json` manifest. Run `menuQuickSetup()` once.
3. **Add your keys** via the sheet menu (`AutoMail Pipeline → Setup → Set API Keys`) — Claude + Gemini. They are stored in Script Properties, not in code.
4. **Deploy the Apps Script as a Web App** (Execute as: Me, Access: Anyone) to get the `/exec` URL your capture surfaces will POST to.
5. **Chrome extension:** `chrome://extensions → Load unpacked → chrome-extension/`, then paste your OAuth client ID in `manifest.json` and the Web App URL in the popup settings.
6. **Android app:** the APK is not distributed publicly and its source is not in this repo — see [android-app/](./android-app) for the architecture write-up. The pipeline runs fine without it; the Chrome extension and a manual sheet row are both valid capture paths.

---

## 6. Everything that has been masked

Every credential in this repo is a placeholder — no live secret exists anywhere in the current tree. The table below is the complete list of what you must supply yourself; each is read from Script Properties at runtime, never from source.

| Placeholder | Meaning | Where to get it |
|---|---|---|
| `YOUR_CLAUDE_API_KEY` | Anthropic Claude API key | https://console.anthropic.com |
| `YOUR_GEMINI_API_KEY` | Google AI Studio Gemini key | https://aistudio.google.com |
| `YOUR_HUNTER_API_KEY` | Hunter.io email-finder key | https://hunter.io |
| `YOUR_REOON_API_KEY` | Reoon email-verifier key | https://emailverifier.reoon.com |
| `YOUR_ZEROBOUNCE_API_KEY` | ZeroBounce verifier key (legacy — extension only) | https://zerobounce.net |
| `YOUR_GOOGLE_SHEET_ID` | Target Sheet ID (from Sheet URL after `/d/`) | Sheets UI |
| `YOUR_OAUTH_CLIENT_ID` | OAuth 2.0 Desktop / Chrome client ID | GCP Console → APIs & Services → Credentials |
| `YOUR_OAUTH_CLIENT_SECRET` | OAuth 2.0 client secret | same |
| `YOUR_GCP_PROJECT_NUMBER` | Google Cloud project number | GCP Console → Home |
| `YOUR_BRIGHTDATA_API_KEY` | Bright Data proxy key (optional — extension only) | https://brightdata.com |
| `YOUR_APOLLO_API_KEY` (+ `_FALLBACK`) | Apollo.io enrichment + email-finder key (primary + fallback) | https://apollo.io |
| `YOUR_SNOV_USER_ID` / `YOUR_SNOV_API_SECRET` | Snov.io OAuth client (email-finder fallback) | https://snov.io |
| `YOUR_ADMIN_TOKEN` | Token guarding the Web App admin / diagnostic endpoints | self-generate any random string |
| `YOUR_DEPLOYMENT_ID` | Apps Script Web App deployment ID (the long string in the `/exec` URL) | Deploy → Manage deployments |
| `YOUR_GITHUB_PAT` | GitHub token used by an optional internal backup helper | https://github.com/settings/tokens |
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

- **Drafts, never auto-sends.** The pipeline only ever creates Gmail **drafts** — you review and hit send yourself. Nothing leaves your account automatically.
- **Gmail rate limits:** a configurable daily draft cap (`DAILY_DRAFT_LIMIT`, default 200), a 3-second inter-draft delay, a multi-week warmup ramp, and automatic back-off when Gmail's short-window rate limit trips (the lead is parked and retried, not failed). See `gmail-apps-script/Config.gs` (`DELIVERABILITY`).
- **Anti-hallucination:** every number, role, and alumni claim in a generated email is cross-checked against `GAURAV_ACHIEVEMENT_BANK` and `GAURAV_FACTS` — unverified claims bounce the email back to `REVIEW`.
- **Spam-trigger filtering:** 40+ fatal + warning words are stripped pre-draft (see `SPAM_TRIGGER_WORDS`).
- **OAuth scopes:** all surfaces request the minimum scope needed. Extension requests `spreadsheets` only; Apps Script requests compose/modify/drive/external_request only.
- **LinkedIn ToS:** this is a user-initiated tool that pulls data from pages you are already logged in to view. No headless scraping, no automated crawling, no ToS evasion.

---

## 9. Reliability engineering

Cold outreach runs unattended for weeks, so the hard part isn't the happy path — it's what happens when something breaks. Each mechanism below exists because a specific failure actually happened (or was anticipated) and needed a defense. The guiding principle: **fail loud, recover automatically, and never lose a lead or send the wrong thing.**

- **Self-healing triggers.** A 30-minute watchdog re-installs any time-driven trigger Google silently dropped and deletes accidental duplicates, keeping the project under the 20-trigger cap. If a cron disappears, the system repairs itself within one cycle instead of going quietly dead.
- **Resumable state machine.** Every lead's status is written back to the sheet after each stage, so a lead always resumes from its last good step. A crash mid-compose never loses work or double-charges the AI APIs.
- **Lock-serialized writes.** Triggers can fire concurrently, so every sheet mutation passes through a script lock — two runs can never clobber the same row (a lost-update race that would otherwise silently drop leads).
- **Quota-aware drafting.** Before spending a single AI token, the pipeline checks the Gmail draft quota; if it's exhausted it parks the lead (`PENDING_QUOTA_RESET`) and retries after the midnight reset — no wasted tokens, no burned retries.
- **Capture audit trail.** Every inbound capture — accepted *or* rejected — is logged, so a lead that never appears can be diagnosed in seconds instead of vanishing without a trace.
- **Current-employer integrity.** Naming the wrong employer is the most visible failure this system can have, so the rule is deliberately narrow: the employer comes *only* from the Experience entry whose date range reads "Present". An earlier version inferred it from the LinkedIn headline instead — that proved unreliable in production and was retired at every layer rather than patched. When a third-party enrichment source disagrees with what was actually read from the profile, the profile wins and the draft is flagged for human review; a disagreement is never resolved silently.
- **Append-only intake guard.** The raw-capture sheet is defended against a subtle Google Sheets trap — a stray filter silently turns row-appends into no-ops — that can otherwise freeze *all* new intake with no error at all.
- **671 automated tests.** A self-contained suite (run from the sheet menu or an admin endpoint) covers composition rules, classification, email selection, the state machine, and every fix above — so changes can't silently regress behaviour.

---

## 10. License

MIT — see [LICENSE](./LICENSE). Use it, fork it, ship it; just don't blame me if Gmail flags your domain because you skipped the warmup schedule.

---

*Built by Gaurav Rathore. Credits: Anthropic Claude, Google Gemini, Apollo.io, RocketReach, Hunter.io, and the Apps Script team.*
