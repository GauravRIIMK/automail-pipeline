# Google Apps Script Pipeline

The **outreach brain**. Seventeen `.gs` files, ~4,500 lines, running on a V8 Apps Script runtime bound to your Google Sheet. No server, no container, no deploy pipeline — just a spreadsheet that happens to also be a stateful cold-email system.

---

## Files

| File | Role | Key functions |
|---|---|---|
| [`appsscript.json`](./appsscript.json) | Manifest (scopes, runtime, web-app config) | — |
| [`Config.gs`](./Config.gs) | All constants: columns, statuses, cadence, fact-bank, spam list | `CONFIG`, `STATUS`, `GAURAV_FACTS`, `GAURAV_ACHIEVEMENT_BANK` |
| [`Code.gs`](./Code.gs) | Main menu, quick setup, dashboard, single-lead run | `onOpen()`, `menuQuickSetup()`, `menuRunBatch()` |
| [`Code111.gs`](./Code111.gs) | Web App endpoint — receives captured leads | `doPost(e)`, `doGet(e)`, `syncSheet1ToSheet2()` |
| [`ApiClients.gs`](./ApiClients.gs) | Claude + Gemini clients, retry/backoff, quota tracking | `callClaude()`, `callGemini()`, `callGeminiGrounded()` |
| [`SheetReader.gs`](./SheetReader.gs) | Row I/O, status management, diagnostics | `getNextLeads()`, `updateLeadStatus()` |
| [`EmailEnricher.gs`](./EmailEnricher.gs) | Email gate — corporate vs. throwaway, pattern guess | `gate()` |
| [`ResearchEngine.gs`](./ResearchEngine.gs) | 2-pass research — grounded + structured | `researchLead()`, `decompressDossier()` |
| [`Classifier.gs`](./Classifier.gs) | Role → archetype mapping | `classifyLead()` |
| [`ResumeSelector.gs`](./ResumeSelector.gs) | Resume variant scoring + pick | `pickVariant()` |
| [`EmailComposer.gs`](./EmailComposer.gs) | Claude composition with fact-bank injection | `compose()` |
| [`Humanizer.gs`](./Humanizer.gs) | 3-layer de-AI-ification | `humanize()` |
| [`QualityGate.gs`](./QualityGate.gs) | 7-stage pre-draft validation | `check()` |
| [`MasterValidator.gs`](./MasterValidator.gs) | Anti-hallucination fact-check against whitelists | `factCheck()` |
| [`GmailDrafter.gs`](./GmailDrafter.gs) | Draft creation, resume attach, threading | `createDraft()` |
| [`BatchProcessor.gs`](./BatchProcessor.gs) | Trigger-chained batch orchestration | `processNextBatch()`, `_processOneLead()` |
| [`FollowUp.gs`](./FollowUp.gs) | Day-3 / 7 / 14 threaded follow-ups | `runDueFollowups()` |

---

## How to install

[docs/SETUP.md](../docs/SETUP.md) covers the full walk-through. Minimum:

1. New Google Sheet → **Extensions → Apps Script**.
2. **Show `appsscript.json`** in Project Settings → paste ours.
3. Create one script per `.gs` file → paste.
4. Refresh the sheet → **AutoMail Pipeline → Setup → ⚡ Quick Setup**.
5. **Deploy → New deployment → Web app → Execute as: Me, Access: Anyone**.

---

## How to run

- **Single row:** click any data row in Sheet2 → **AutoMail Pipeline → Process Single Lead (Current Row)**.
- **Batch:** **AutoMail Pipeline → Run Pipeline (Next Batch)** — pulls up to 5 NEW rows.
- **Auto:** **Setup → Setup Auto-Process Trigger** — fires on Sheet2 edit + every 2 minutes.
- **Follow-ups:** **Setup → Setup Follow-Up Trigger** — daily at 9 AM local.

---

## Config you'll want to tweak

Open `Config.gs`:

| Constant | Default | What to change |
|---|---|---|
| `CONFIG.SHEET_ID` | `YOUR_GOOGLE_SHEET_ID` | Your sheet ID |
| `CONFIG.BATCH_SIZE` | 5 | Lower for safer pacing, higher for throughput |
| `CONFIG.DAILY_DRAFT_LIMIT` | 25 | Only raise after 2+ weeks of warmup |
| `CONFIG.CLAUDE_MODEL` | `claude-sonnet-4-5-20250929` | Latest Sonnet preserves negative constraints best |
| `CONFIG.GEMINI_MODEL` | `gemini-2.5-flash` | Bump when Google ships 2.6+ |
| `GAURAV_PROFILE` | (author's achievements) | Replace entirely with yours — this is the single most impactful change |
| `GAURAV_FACTS` | (author's schools + companies) | Replace — fact-bank grounds every generated claim |
| `GAURAV_ACHIEVEMENT_BANK` | 13 entries | Replace — used by MasterValidator to ground numbers |
| `GAURAV_METRIC_WHITELIST` | 24 tokens | Replace with every number that can legitimately appear in a generated email |

**Critical:** if you don't update the fact bank, the MasterValidator will reject every email you generate (because it's looking for "Blinkit" / "Thoughtworks" / "IIM Kozhikode" claims that won't match your background).

---

## Anatomy of a pipeline run

Say you just added Jane Doe, VP Engineering at Acme Corp to row 5 of Sheet2. Here's what happens:

```
[T+0s]   Trigger fires. BatchProcessor.processNextBatch() picks up row 5 (Status empty ≈ NEW).
[T+0.1s] SheetReader.getLeadByRow(5)  → LeadProfile object.
[T+0.2s] EmailEnricher.gate(lead)     → email "jane@acme.com" passes (corporate TLD).
         Status → RESEARCHING
[T+0.5s] ResearchEngine.researchLead(lead)
         Pass 1: callGeminiGrounded('Research Acme Corp…')  — fresh news + funding + people
[T+8s]   Pass 2: callGemini(structured)  — typed dossier
[T+14s]  Dossier compressed, written to col H.
         Status → RESEARCH_DONE
[T+14.1s] Classifier.classifyLead(lead, dossier)  → archetype VP_DIRECTOR, template EXEC_TEAM_CHALLENGES
         Status → CLASSIFYING → COMPOSING
[T+14.2s] ResumeSelector.pickVariant(lead, dossier) → OPS_CONSULTING (she's engineering-ops focused)
[T+14.3s] EmailComposer.compose(lead, dossier, classification)
          callClaude(sonnet-4.5, prompt includes fact-bank, spam list, length rules)
[T+22s]  Claude returns {subject: "Scaling eng at Acme", body: "..."}
         Status → HUMANIZING
[T+22.1s] Humanizer.humanize(body)  → strips em-dashes, checks rhythm
[T+22.2s] QualityGate.check(subject, body)  → 8 checks, score 78/100  → pass
         Status → QUALITY_CHECK
[T+22.3s] MasterValidator.factCheck(body)
          every number in body ∈ GAURAV_METRIC_WHITELIST?  yes
          every role claim in body ∈ GAURAV_VERIFIED_ROLES?  yes
          no alumni claim of a non-alma-mater?  pass
[T+22.4s] GmailDrafter.createDraft(lead, subject, body, {variantId: OPS_CONSULTING})
          attach OPS_CONSULTING resume PDF from Drive
          capture threadId, Message-ID
[T+24s]  Draft created. Cols O, V, W populated.
         Status → DRAFT_CREATED
[T+24.1s] BatchProcessor checks remaining NEW rows. If any, re-arms trigger.
```

Total: ~24 seconds. Every transition persisted to the sheet as it happens.

---

## What's NOT in here

- **API keys.** They live in Script Properties (`PropertiesService.getScriptProperties()`), set via the Setup menu. Never in code.
- **Your identity.** `GAURAV_PROFILE` / `GAURAV_FACTS` / `GAURAV_ACHIEVEMENT_BANK` are the author's — you replace them with yours.
- **Actual leads.** Leads come from the Android app / Chrome extension / manual paste. The pipeline doesn't ship with any.

---

## Troubleshooting

| Issue | Check |
|---|---|
| Pipeline stuck on a row | `Tools → View Errors for Current Row` shows the last 10 log entries for that row. |
| Status `ERROR` | Read col R (Notes). Reset via `Tools → Reset Current Row Status`. |
| Every email goes to `REVIEW` | Your `GAURAV_*` constants aren't updated — MasterValidator rejects any claim not in the fact bank. |
| Gemini empty responses | Already handled in `_parseApiResponse()` — it has a thought-part fallback. If you see the fallback logs, consider raising `maxTokens`. |
| Exceeded daily limit | Wait 24 hours or reset via `resetApiQuotaCounters()`. Gmail-side cap is separate and real. |
| "Authorization required" | Re-run Quick Setup; Apps Script sometimes loses consent after a manifest change. |

More: [../docs/SETUP.md](../docs/SETUP.md).
