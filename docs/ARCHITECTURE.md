# Architecture

A system-level view of AutoMail. If `README.md` tells you *what* the pipeline does, this document tells you *how* it's wired.

---

## 1. Component diagram

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              CAPTURE SURFACES                                │
│                                                                              │
│  ┌────────────────────────────────┐         ┌──────────────────────────────┐ │
│  │   Android App                  │         │   Chrome Extension (MV3)     │ │
│  │   (LinkedInDataAgent v1.1)     │         │                              │ │
│  │                                │         │  ┌─────────────────────────┐ │ │
│  │  • AccessibilityService        │         │  │ popup.html / popup.js   │ │ │
│  │  • Screenshot capture          │         │  │ (user presses Extract)  │ │ │
│  │  • State machine (8 states)    │         │  └──────────┬──────────────┘ │ │
│  │  • Gemini 2.5 Flash Vision     │         │             │ message        │ │
│  │  • Apollo / RocketReach /      │         │  ┌──────────▼──────────────┐ │ │
│  │    Hunter enrichment chain     │         │  │ background.js           │ │ │
│  │  • Remote log endpoint         │         │  │ (service worker,        │ │ │
│  │                                │         │  │  chrome.identity OAuth) │ │ │
│  └───────────┬────────────────────┘         │  └──────────┬──────────────┘ │ │
│              │                              │             │ inject         │ │
│              │                              │  ┌──────────▼──────────────┐ │ │
│              │                              │  │ content.js              │ │ │
│              │                              │  │ (DOM scrape on          │ │ │
│              │                              │  │  linkedin.com pages +   │ │ │
│              │                              │  │  Gemini call)           │ │ │
│              │                              │  └──────────┬──────────────┘ │ │
│              │                              └─────────────┼────────────────┘ │
│              │                                            │                  │
└──────────────┼────────────────────────────────────────────┼──────────────────┘
               │                                            │
               │ POST https://script.google.com/macros/     │ Google Sheets API v4
               │  s/<DEPLOYMENT>/exec                       │ (OAuth2 user token)
               │ body: { linkedinUrl, fullName, email, … }  │ spreadsheets.values.append
               ▼                                            ▼
  ┌──────────────────────────────────────────────────────────────────────────┐
  │                          GOOGLE SHEET (state store)                       │
  │                                                                           │
  │  Sheet1  (raw LinkedIn capture, 12 cols)                                  │
  │    Timestamp | LinkedIn_URL | Full_Name | Headline | Designation |        │
  │    Organization | Email | Phone | Website | Location | Connection |      │
  │    Confidence                                                             │
  │                                                                           │
  │  Sheet2  (pipeline queue, 25 cols: A-F input, G-U state, V-Y threading)  │
  │    A-F  LinkedIn_URL, Full_Name, Headline, Designation, Organization,     │
  │         Email                                                             │
  │    G    Pipeline_Status  (NEW / RESEARCHING / … / RESPONDED)              │
  │    H    Research_JSON    (compressed dossier)                             │
  │    I-K  Archetype, Template, Resume_Variant                               │
  │    L-M  Subject_Line, Email_Body                                          │
  │    N    Quality_Score    (0–100)                                          │
  │    O    Draft_ID         (Gmail)                                          │
  │    P-Q  Followup_Stage, Response_Status                                   │
  │    R    Notes                                                             │
  │    S-U  Sent_Date, Followup_Dates, Last_Updated                           │
  │    V-Y  Thread_ID, RFC822_Message_ID, Enriched_Email, Email_Source       │
  │                                                                           │
  │  PipelineLog  (debug stream: Timestamp, Run_ID, Row, Stage, Level, Msg)   │
  │  FollowUps    (scheduled follow-up queue)                                 │
  └────────────────────────────────┬──────────────────────────────────────────┘
                                   │
                         time-driven trigger
                         (every 2 min, BATCH_SIZE=5)
                                   ▼
  ┌──────────────────────────────────────────────────────────────────────────┐
  │                     APPS SCRIPT PIPELINE (V8)                             │
  │                                                                           │
  │  ┌──────────────┐  Code111.gs      doPost()          ← Android / Ext      │
  │  │ Web App      │  (captures incoming lead, dedupes, syncs to Sheet2)     │
  │  └──────┬───────┘                                                         │
  │         ▼                                                                 │
  │  ┌──────────────┐  SheetReader.gs  getNextLeads()                         │
  │  │ Reader       │  (reads N rows where Status in {NEW, RESEARCHING})      │
  │  └──────┬───────┘                                                         │
  │         ▼                                                                 │
  │  ┌──────────────┐  EmailEnricher.gs                                       │
  │  │ Email gate   │  (pattern + SMTP-check via Gemini; guard corporate      │
  │  │              │   vs. throwaway; may flag NEEDS_EMAIL_REVIEW)           │
  │  └──────┬───────┘                                                         │
  │         ▼                                                                 │
  │  ┌──────────────┐  ResearchEngine.gs                                      │
  │  │ Research     │  Pass 1: Gemini + Google Search grounding (fresh facts) │
  │  │              │  Pass 2: Gemini structured JSON (typed ResearchDossier) │
  │  │              │  Output: compressed dossier written to H                │
  │  └──────┬───────┘                                                         │
  │         ▼                                                                 │
  │  ┌──────────────┐  Classifier.gs                                          │
  │  │ Classifier   │  maps role → archetype (Founder/VP/Manager/IC/HR/Skip)  │
  │  │              │  picks template key + approach string                   │
  │  └──────┬───────┘                                                         │
  │         ▼                                                                 │
  │  ┌──────────────┐  ResumeSelector.gs                                      │
  │  │ Resume pick  │  scores 3 variants against role KPIs + dossier signals │
  │  │              │  (GROWTH_MARKETING / OPS_CONSULTING / PRODUCT_AI)       │
  │  └──────┬───────┘                                                         │
  │         ▼                                                                 │
  │  ┌──────────────┐  EmailComposer.gs                                       │
  │  │ Claude       │  Sonnet 4.5, strict system prompt, fact-bank injected   │
  │  │ Composer     │  returns { subject, body }                              │
  │  └──────┬───────┘                                                         │
  │         ▼                                                                 │
  │  ┌──────────────┐  Humanizer.gs                                           │
  │  │ 3-layer      │  L1: AI-tell stripper (em-dashes, "delve", etc.)        │
  │  │ humanizer    │  L2: rhythm variance (short + long sentence pattern)    │
  │  │              │  L3: micro-typos/contractions (opt-in)                  │
  │  └──────┬───────┘                                                         │
  │         ▼                                                                 │
  │  ┌──────────────┐  QualityGate.gs                                         │
  │  │ 7-stage      │  1. Length (50–125 words)                               │
  │  │ quality gate │  2. Subject 2–4 words, ≤40 chars, no blacklist          │
  │  │              │  3. Banned openers ("I hope this finds you well")       │
  │  │              │  4. Spam triggers (fatal + warning lists)               │
  │  │              │  5. Personalization score ≥ 60                          │
  │  │              │  6. No direct job-asking language                       │
  │  │              │  7. No HTML / no attachment-mention                     │
  │  └──────┬───────┘                                                         │
  │         ▼                                                                 │
  │  ┌──────────────┐  MasterValidator.gs                                     │
  │  │ Anti-halluc. │  every number checked against GAURAV_METRIC_WHITELIST   │
  │  │ fact-check   │  every role against GAURAV_VERIFIED_ROLES               │
  │  │              │  every alumni claim against GAURAV_FACTS.alumniKeywords │
  │  └──────┬───────┘                                                         │
  │         ▼                                                                 │
  │  ┌──────────────┐  GmailDrafter.gs                                        │
  │  │ Gmail draft  │  creates HTML + plain-text draft, attaches right resume │
  │  │              │  captures ThreadId + Message-ID into cols V/W           │
  │  │              │  respects DAILY_DRAFT_LIMIT + MIN_DELAY_BETWEEN_DRAFTS  │
  │  └──────┬───────┘                                                         │
  │         ▼                                                                 │
  │  ┌──────────────┐  BatchProcessor.gs                                      │
  │  │ Orchestrator │  chains triggers (5 leads/run, 2-min interval)          │
  │  │              │  resumes from last good stage on timeout                │
  │  │              │  writes diagnostics to PipelineLog                      │
  │  └──────┬───────┘                                                         │
  │         ▼                                                                 │
  │  ┌──────────────┐  FollowUp.gs                                            │
  │  │ 3-touch      │  Day+3: VALUE_ADD    (LLM-composed in-thread reply)     │
  │  │ cadence      │  Day+7: SOCIAL_PROOF                                    │
  │  │              │  Day+14: BREAK_UP                                       │
  │  │              │  anchored on Sent_Date (S), not draft-creation          │
  │  └──────────────┘                                                         │
  │                                                                           │
  └──────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Data flow — one lead, end to end

```
[phone] tap ↓
   ├→ Android app takes screenshot
   ├→ Gemini 2.5 Flash extracts JSON { name, headline, designation, org, email }
   ├→ Apollo / RocketReach / Hunter cross-validate email (up to 7 verification steps)
   └→ POST JSON → Apps Script Web App

[Apps Script Web App] Code111.doPost()
   ├→ append to Sheet1 (raw capture)
   ├→ dedupe by email against Sheet2.F
   └→ if new + has email: append A-F to Sheet2, Status = NEW

[Trigger fires, every 2 min]  BatchProcessor.processNextBatch()
   ├→ SheetReader.getNextLeads(BATCH_SIZE=5)  (rows where Status ∈ {NEW,…})
   │
   ├→ for each lead:
   │     ├→ EmailEnricher.gate(lead)                    → pass / NEEDS_EMAIL_REVIEW
   │     ├→ ResearchEngine.researchLead(lead)           → dossier JSON (col H)
   │     ├→ Classifier.classifyLead(lead, dossier)      → archetype + template
   │     ├→ ResumeSelector.pickVariant(lead, dossier)   → GROWTH / OPS / PRODUCT
   │     ├→ EmailComposer.compose(lead, dossier, arch)  → Claude → {subject, body}
   │     ├→ Humanizer.humanize(body)                    → 3-layer transforms
   │     ├→ QualityGate.check(subject, body)            → score ≥ 60 or REVIEW
   │     ├→ MasterValidator.factCheck(body)             → every number whitelisted
   │     └→ GmailDrafter.createDraft(lead, subject, body, {variantId})
   │          ├→ attach right resume PDF
   │          ├→ capture draft.getId(), thread.getId(), Message-ID header
   │          └→ write cols O, V, W, and set Status = DRAFT_CREATED
   │
   └→ BatchProcessor.chain()  → schedule next trigger if more NEW rows remain

[User hits "Send" on draft in Gmail]
   └→ onSend trigger (time-based scan of thread) sets Status = SENT, Sent_Date = today

[Follow-up trigger, daily at 9 AM]  FollowUp.runDueFollowups()
   ├→ for each row where Status ∈ {SENT, FOLLOWUP_1, FOLLOWUP_2}
   │      and (today - Sent_Date) ∈ {3, 7, 14}:
   │   ├→ LLM-compose in-thread follow-up (VALUE_ADD / SOCIAL_PROOF / BREAK_UP)
   │   ├→ reply on thread using Thread_ID + Message-ID (true threading, not a fork)
   │   └→ advance Status: SENT → FOLLOWUP_1 → FOLLOWUP_2 → FOLLOWUP_3
   │
   └→ if any incoming reply arrives in a tracked thread → Status = RESPONDED
```

---

## 3. State machine (Pipeline_Status column G)

```
                        ┌─────────────┐
                        │  (new row)  │
                        └──────┬──────┘
                               ▼
 ┌──────────┐         ┌──────────────┐         ┌──────────────────┐
 │ SKIPPED  │◄────────┤     NEW      │────────►│ NEEDS_EMAIL[_…]  │
 └──────────┘         └──────┬───────┘         └──────────────────┘
                               ▼
                      ┌───────────────┐
                      │  RESEARCHING  │
                      └──────┬────────┘
                               ▼
                      ┌────────────────┐
                      │ RESEARCH_DONE  │
                      └──────┬─────────┘
                               ▼
                      ┌────────────────┐
                      │  CLASSIFYING   │
                      └──────┬─────────┘
                               ▼
                      ┌────────────────┐
                      │   COMPOSING    │  ← Claude call
                      └──────┬─────────┘
                               ▼
                      ┌────────────────┐
                      │   HUMANIZING   │
                      └──────┬─────────┘
                               ▼
                      ┌────────────────┐         ┌────────┐
                      │ QUALITY_CHECK  │────────►│ REVIEW │  (score < 60 or
                      └──────┬─────────┘         └────────┘   fact-check fail)
                               ▼
                      ┌────────────────┐
                      │ DRAFT_CREATED  │
                      └──────┬─────────┘
                               ▼
                      ┌────────────────┐
                      │     SENT       │  ← user clicks Send in Gmail
                      └──┬──┬──┬───────┘
               day+3 ▼    ▼ day+7   ▼ day+14
             FOLLOWUP_1  FOLLOWUP_2  FOLLOWUP_3
                   │         │          │
                   └─────────┴──────────┘
                               ▼
                       ┌────────────┐
                       │ RESPONDED  │  (any inbound reply)
                       └────────────┘

                     ERROR — terminal, logs reason in Notes (col R)
```

---

## 4. Files → stages map

| Stage | File(s) | Key entry points |
|---|---|---|
| Web App | `Code111.gs` | `doPost(e)`, `doGet(e)`, `syncSheet1ToSheet2()` |
| Menu / setup | `Code.gs` | `onOpen()`, `menuQuickSetup()`, `menuRunBatch()` |
| Config | `Config.gs` | `CONFIG`, `STATUS`, `GAURAV_PROFILE`, `GAURAV_FACTS`, `GAURAV_ACHIEVEMENT_BANK`, `ARCHETYPES` |
| API clients | `ApiClients.gs` | `callClaude()`, `callGemini()`, `callGeminiGrounded()` |
| Sheet I/O | `SheetReader.gs` | `getNextLeads()`, `updateLeadStatus()`, `updateLeadFields()` |
| Email gate | `EmailEnricher.gs` | `gate(lead)` |
| Research | `ResearchEngine.gs` | `researchLead(lead)`, `decompressDossier(json)` |
| Classify | `Classifier.gs` | `classifyLead(lead, dossier)` |
| Resume pick | `ResumeSelector.gs` | `pickVariant(lead, dossier)` |
| Compose | `EmailComposer.gs` | `compose(lead, dossier, classification)` |
| Humanize | `Humanizer.gs` | `humanize(body, options)` |
| Quality | `QualityGate.gs` | `check(subject, body)` |
| Fact check | `MasterValidator.gs` | `factCheck(body)`, `validateMetrics()`, `validateAlumni()` |
| Draft | `GmailDrafter.gs` | `createDraft(lead, subject, body, opts)` |
| Orchestrate | `BatchProcessor.gs` | `processNextBatch(force)`, `_processOneLead(lead)` |
| Follow-ups | `FollowUp.gs` | `runDueFollowups()`, `composeFollowup(stage, dossier)` |

---

## 5. Why this architecture

- **Everything is resumable.** The sheet is the source of truth. Any row's progress is written back after each stage — kill the script, restart it, and it picks up from the last good stage.
- **Apps Script was deliberate.** Free, runs inside the Google account that owns the Gmail account doing outreach, no server to provision, no OAuth drift. Built-in Gmail / Drive / Sheets APIs mean zero token plumbing.
- **Two-surface capture.** Android for phone-first LinkedIn users; Chrome extension for desktop. Both speak the same JSON shape to the same Web App.
- **Two LLMs, not one.** Gemini for research (fast, cheap, grounded in Google Search). Claude for composition (best at respecting negative constraints like "don't open with I hope").
- **Fact bank over prompts.** Instead of fighting hallucinations with longer prompts, the validator checks every claim against a whitelist of verified metrics + roles + alumni institutions. Unverified → REVIEW, never sent.
