# Pipeline Overview — Stage by Stage

A deep dive into what happens at each of the 12 stages between "LinkedIn profile" and "Gmail draft with follow-ups scheduled". Pair this with [ARCHITECTURE.md](./ARCHITECTURE.md) for the top-down view.

---

## 0. Capture (Android app or Chrome extension)

**Goal:** turn a LinkedIn profile you're looking at into a structured JSON blob that lands in your sheet.

### Android path
- `AccessibilityService` watches the LinkedIn app's window-state events.
- On tap of the floating button, the app enters an **8-state machine**:
  ```
  IDLE → SCREENSHOT_HEADER → SCROLLING → SCREENSHOT_CONTACT
       → PROCESSING_VISION → ENRICHING_EMAIL → EXPORTING → COMPLETE
  ```
- Two screenshots (profile header + contact drawer) are sent to **Gemini 2.5 Flash Vision**. A label-adjacency algorithm finds "Phone", "Email", "Website" labels and grabs the text immediately after.
- The LinkedIn URL is parallel-sent to **Apollo.io People Match**, **RocketReach**, and **Hunter.io**. Results cross-validate:
  - Apollo + RocketReach agree → 99% confidence
  - Apollo + Hunter agree → 98% confidence
  - Hunter SMTP verification → confirms deliverability
  - Gemini fallback → reasons about `firstname.lastname@company.tld` patterns
- Final JSON is POSTed to the Apps Script `/exec` URL.

### Chrome extension path
- User hits **Extract** on `popup.html`.
- `background.js` injects `content.js` into the active LinkedIn tab (MV3 `chrome.scripting.executeScript`).
- `content.js` scrapes the rendered DOM + calls Gemini to clean it up.
- Data is written to the sheet via **Google Sheets API v4** using an OAuth2 user token obtained via `chrome.identity.getAuthToken`. No Web App hop needed.

---

## 1. Web App intake (`Code111.gs`)

`doPost(e)` does two things:

1. **Sheet1 append** — raw capture with all 12 fields (Timestamp → Confidence). Nothing is filtered here; Sheet1 is the unfiltered audit log.
2. **Sheet2 sync** — if (and only if) `email` is non-empty:
   - Dedupe against the existing column F (emails lower-cased, trimmed).
   - If new, append only columns A-F (LinkedIn_URL, Full_Name, Headline, Designation, Organization, Email).
   - Status column G is left empty, which the pipeline treats as `NEW`.

Return JSON:
```json
{ "status": "success", "automail_sync": "synced|duplicate|skipped" }
```

A `doGet()` health endpoint returns the current version so the capture surfaces can version-check.

---

## 2. Batch trigger (`BatchProcessor.gs`)

Installed as a time-driven trigger (every `CONFIG.TRIGGER_INTERVAL_MIN` = 2 minutes). On each fire:

1. Acquire a script lock with `LOCK_TIMEOUT_MS = 5000` (prevents two triggers stepping on each other).
2. Stop cleanly at `MAX_RUNTIME_MS = 300000` (5-min cushion under the 6-min Apps Script hard limit).
3. Pull up to `BATCH_SIZE = 5` rows via `SheetReader.getNextLeads()`.
4. Call `_processOneLead(lead)` on each; if it throws, log to PipelineLog with `Level = ERROR` and set Status = `ERROR`, Notes = message.
5. If rows remain, re-arm the trigger.

Every single stage transition is persisted back to the sheet *immediately* — so a runtime kill costs at most one lead, not the whole batch.

---

## 3. Email gate (`EmailEnricher.gs`)

Before spending a Gemini call, sanity-check the email:

- **Corporate vs. throwaway**: flag `gmail.com`, `outlook.com`, `yahoo.com`, etc. as lower-trust. Does not reject — just marks `EMAIL_SOURCE = sheet_personal` in col Y.
- **Pattern guess**: if the email looks like `first.last@company.tld`, keep it. If it's `info@` / `support@` / `no-reply@`, mark `NEEDS_EMAIL_REVIEW`.
- **No email at all** → `NEEDS_EMAIL`. User can fix by running **Tools → Enrich Email** which fires a Gemini call with the name + domain to propose candidates.

Writes two new columns — `X: Enriched_Email`, `Y: Email_Source` — so the user can see which email the pipeline actually used (enriched may differ from input F).

---

## 4. Research (`ResearchEngine.gs`)

The most expensive stage and the quality floor for everything downstream. **Two passes**:

### Pass 1 — Grounded (fresh web facts)
- `callGeminiGrounded(prompt)` with `tools: [{ googleSearch: {} }]`.
- System prompt: the full `GEMINI_SYSTEM_PROMPT` from Config — a job-seeking research analyst persona.
- Returns unstructured prose because Gemini doesn't let you combine Search grounding with `responseSchema`.

### Pass 2 — Structured (typed dossier)
- `callGemini(prompt, { responseFormat: 'json', responseSchema })` with:
  - `getCompanyResearchSchema()` for company-side fields
  - `getIndividualResearchSchema()` for person-side fields
- For Gemini 2.5 thinking models, `thinkingConfig: { thinkingBudget: 0 }` is set — otherwise empty responses sneak through where the model emits only "thought" parts.

### Output — `ResearchDossier`
```js
{
  company: { name, industry, stage, description, recentNews, latestFundingRound, … },
  individual: { roleKPIs, painPoints, recentActivity, communicationStyle, bestHookAngle, … },
  triggerEvents: [...],     // funding, launches, expansions
  sharedBackground: [...],  // matched against SHARED_BACKGROUND keywords
  hooks: [...]              // derived opening-line candidates
}
```
Compressed with `compressDossier()` and written to col H. Decompressed on read.

---

## 5. Classify (`Classifier.gs`)

Reads the lead's designation + dossier and picks one of six archetypes from `ARCHETYPES` (Config.gs):

| Archetype | Trigger roles | Hook type | Template key |
|---|---|---|---|
| `FOUNDER_CEO` | ceo, founder, co-founder | perspective_advice | `FOUNDER_PERSPECTIVE` |
| `VP_DIRECTOR` | vp, svp, evp, director, head of | team_challenges | `EXEC_TEAM_CHALLENGES` |
| `MANAGER` | manager, senior manager, team lead | operational_fit | `MANAGER_ROLE_FIT` |
| `FUNCTIONAL_LEAD` | lead, owner, principal, specialist | technical_insight | `IC_PEER_COLLABORATION` |
| `PEOPLE_OPS` | recruiter, talent, people ops, hr | strategic_fit | `PEOPLE_OPS_CONVERSATION` |
| `SKIPPED` | intern, no-email, duplicate | — | `SKIP` |

Writes I (archetype), J (template), R (approach/reasoning).

---

## 6. Resume pick (`ResumeSelector.gs`)

Three variants, each with a file stored in Google Drive:

| Variant | Emphasised achievements |
|---|---|
| `GROWTH_MARKETING` | Blinkit Bistro scale, 94% complaint reduction, 25% APAC conversion lift |
| `OPS_CONSULTING` | 50-kitchen P&L, 35k-formula workbook, 8-tab quality dashboard |
| `PRODUCT_AI_STRATEGY` | 6-component AI pipeline, RAG on Weaviate, 85% drafting reduction |

Scoring logic: each variant gets +1 for every dossier keyword it matches (e.g. "AI" → +1 for PRODUCT, "P&L" → +1 for OPS). Highest score wins; tie-break favours the user's primary variant (configurable). Writes the variant to K.

---

## 7. Compose (`EmailComposer.gs`)

Calls **Claude Sonnet 4.5** with a strict prompt that embeds:

1. The resolved archetype's template (from `EMAIL_TEMPLATES`).
2. The dossier facts (company, person, triggers, shared background).
3. The selected resume variant's achievement list (from `GAURAV_PROFILE[variant].achievements`).
4. `COLD_EMAIL_RULES` — all 14 banned openers, all 6 banned subject patterns, the 7 archetypes, the 3 CTA frameworks, the 3 structures (BAB/PAS/Timeline), the 7 mandatory rules.
5. `SPAM_TRIGGER_WORDS` (fatal + warning) to avoid.
6. Length constraints: subject 2–4 words, ≤40 chars; body 50–125 words.

Temperature: 0.7 (enough variance to avoid template sameness; low enough to respect negative constraints).

Returns `{ subject, body }`. Writes L and M.

---

## 8. Humanize (`Humanizer.gs`)

Three layers, each opt-in:

1. **AI-tell stripper** — deletes em-dashes, smart quotes, "delve", "leverage", "holistic", "navigate", "tapestry", "utilize" (→ "use"), "plethora".
2. **Rhythm variance** — ensures at least one ≤6-word sentence and one ≥14-word sentence; breaks up 3+ consecutive long sentences.
3. **Micro-typos & contractions** (off by default) — swaps "I am" → "I'm", "cannot" → "can't", etc. Adds one hand-typed-looking micro-imperfection if enabled.

---

## 9. Quality gate (`QualityGate.gs`)

Seven checks, scored 0–100 with the minimum `QUALITY_GATES.minPersonalizationScore = 60`:

| # | Check | Kill threshold |
|---|---|---|
| 1 | Body length | < 50 or > 125 words → fail |
| 2 | Subject length | < 2 or > 4 words, or > 40 chars → fail |
| 3 | Banned openers | any match in `COLD_EMAIL_RULES.bannedOpeners` → fail |
| 4 | Fatal spam words | > `maxSpamWords = 2` matches → fail |
| 5 | Personalization | requires ≥ 2 dossier references (company name, trigger event, shared background) |
| 6 | No job-ask | regex: "hire me", "job opportunity", "looking for a role", etc. → fail |
| 7 | Format | HTML tags, attachment-mention in first email → fail |

Pass → Status = `QUALITY_CHECK`. Fail → Status = `REVIEW`, Notes populated with which check failed.

---

## 10. Fact check (`MasterValidator.gs`)

The anti-hallucination step. Before any email becomes a draft, the body is scanned against three whitelists in Config.gs:

- **`GAURAV_METRIC_WHITELIST`** — every number in the email must appear here. "Scaled 200 stores" → fail (whitelist has "38 dark stores"). "Cut complaints by 94%" → pass.
- **`GAURAV_VERIFIED_ROLES`** — "As a senior manager…" passes; "As a founder…" fails.
- **`GAURAV_FACTS.notAlumniOf`** — "fellow IIM Bangalore alum" fails; only `iim kozhikode` / `thapar` pass.
- **`GAURAV_ACHIEVEMENT_BANK`** — claims must cite one of the 13 verified achievement entries.

A single failure bumps Status to `REVIEW` with Notes = `"fact-check: claim 'X' not in bank"`.

---

## 11. Draft (`GmailDrafter.gs`)

- Pulls the selected resume PDF via `DriveApp.getFileById(property[variantKey])`.
- Builds an HTML body with the plain text + signature from `EMAIL_CONFIG.signatureVariants[variant]`.
- Calls `GmailApp.createDraft(to, subject, plainBody, { htmlBody, attachments, name })`.
- Captures:
  - `draft.getId()` → col O
  - `draft.getMessage().getThread().getId()` → col V (THREAD_ID)
  - `Message-ID` header → col W (for RFC-2822 cross-client threading)
- Enforces:
  - `DAILY_DRAFT_LIMIT = 25` (via `getDailyDraftCount()` in script properties, date-keyed).
  - `MIN_DELAY_BETWEEN_DRAFTS_MS = 3000`.
  - Warmup schedule (5/10/15/20/25 drafts/day for weeks 1-5).

Status → `DRAFT_CREATED`.

---

## 12. Follow-ups (`FollowUp.gs`)

A daily trigger (9 AM, `FOLLOWUP_CADENCE.sendHour`) scans rows where:

```
Status ∈ {SENT, FOLLOWUP_1, FOLLOWUP_2}
AND (today - Sent_Date) ≥ offsetDaysByStage[nextStage]
```

For each due row:

1. Look up the dossier (col H) and the original draft's thread.
2. Pick the framework for the stage (`VALUE_ADD` → `SOCIAL_PROOF` → `BREAK_UP`).
3. Call Claude with a follow-up-specific prompt that embeds the original email body (so it reads naturally as a follow-up, not a restart).
4. Reply on the existing thread using `thread.reply(body)` — true in-thread, same subject.
5. Advance Status: `SENT` → `FOLLOWUP_1` → `FOLLOWUP_2` → `FOLLOWUP_3`.

If any incoming reply hits the tracked thread (detected by scanning `GmailApp.search('is:inbox in:anywhere threadId:...')`), Status flips to `RESPONDED` and the follow-up schedule is cancelled.

---

## How long does all this take?

| Stage | Typical time / lead |
|---|---|
| Capture (Android) | 6-10s |
| Capture (Chrome) | 2-4s |
| Web app ingest | < 200ms |
| Research (Gemini grounded + structured) | 8-15s |
| Classify + resume pick | < 1s |
| Compose (Claude) | 5-10s |
| Humanize + quality gate + fact check | < 500ms |
| Gmail draft | 1-2s |
| **Total (capture → draft)** | **~30s** |
| Follow-ups | async, triggered daily |

At `BATCH_SIZE = 5` and `TRIGGER_INTERVAL_MIN = 2`, the pipeline sustains **~150 leads/hour** conservatively, well under the Gmail per-user quota.
