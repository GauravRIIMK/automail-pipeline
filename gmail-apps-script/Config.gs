/**
 * ============================================================
 * Config.gs — AutoMail Pipeline: Configuration Constants
 * Reframed for JOB-SEEKING cold emails to Indian startup leaders
 * ============================================================
 */

// ─── SPREADSHEET SETUP ──────────────────────────────────────
var CONFIG = {
  // Sheet IDs and names
  SHEET_ID: '1ZMg0NychDnNqfD0DfVIqWZmzrGik5EFIdaaeJQWMsvY',
  DATA_SHEET: 'Sheet2',             // Main data sheet with lead list
  LOG_SHEET: 'PipelineLog',         // Log sheet for debugging

  // ─── PIPELINE PROCESSING ───────────────────────────────────

  // Batch processing
  // PATCH 2026-05-13 (D7 / AUDIT R19): reduced 5 → 3. Per-lead time is
  // ~60-100s (research grounded-call + composer + critic). 5 × 100s = 500s
  // exceeds both MAX_RUNTIME_MS (300s) and the GAS hard limit (360s),
  // causing mid-batch kills that orphan rows at intermediate statuses.
  // 3 × 100s = 300s fits inside both limits with margin. Trigger fires
  // every 2 min so total throughput stays similar; risk of orphans drops
  // to near zero.
  BATCH_SIZE: 3,                    // Leads to process per trigger execution (was 5; reduced for GAS time-budget safety)
  // ── PATCH `-eq2-drain` (2026-06-09): dedicated scanner dispatch cap ──
  // The scanner (Scanner.gs scanAndDispatch) uses THIS, not BATCH_SIZE, so we can
  // drain the parked-lead backlog faster WITHOUT also accelerating
  // processResearchedLeads / processNextBatch (which share BATCH_SIZE and each have
  // their own 6-min exposure). Safe because SCANNER_DISPATCH_BUDGET_MS stops the
  // dispatch loop BETWEEN leads before the GAS 6-min hard kill: fast-failing leads
  // (re-park / NEEDS_EMAIL) drain quickly up to the cap; slow full-draft leads
  // (~100s each) stop gracefully at the budget instead of dying mid-compose.
  // ─── M3 FRESH-FIRST + STRICT 10-DAY ELIGIBILITY (2026-06-12-fresh-first) ──
  // Leads older than LEAD_MAX_AGE_DAYS days are NOT auto-dispatched (SKIP_STALE_LEAD).
  // They remain untouched for manual handling — pipeline never writes a status to them.
  // Override-able via ScriptProperty LEAD_MAX_AGE_DAYS (same pattern as ENRICHMENT_* flags).
  // Missing capture date → treated as ELIGIBLE (legacy rows — stated policy, see Scanner.gs _leadWithinAgeWindow).
  LEAD_MAX_AGE_DAYS: 10,

  SCANNER_DISPATCH_MAX: 10,         // Max leads dispatched per scan tick (backlog-drain; was effectively 3 via BATCH_SIZE)
  SCANNER_DISPATCH_BUDGET_MS: 240000, // Stop STARTING new dispatches after 4 min elapsed (leaves 2 min for in-flight lead before 6-min kill)
  MAX_RUNTIME_MS: 300000,           // 5 minutes (safety margin under 6 min GAS limit)
  // PATCH 2026-06-13-transient-draft: cap createDraft calls per scanner run.
  // Gmail's short-window rate limit (~100-second window) fires when a burst of
  // createDraft calls are issued in rapid succession. Capping drafts-per-run at
  // this value spreads creation across 5-min cron ticks so any single tick can't
  // burst past the short-window cap. Remaining eligible leads are re-queued and
  // processed on the next tick. Realistic drain rate: ~6 drafts per 5-min tick.
  SCANNER_MAX_DRAFTS_PER_RUN: 6,    // Max createDraft calls per scanner run (short-window burst cap)

  // ─── EQ.7 ENRICHMENT QUALITY FLAGS (sub-sprint -eq7-enrichment-impl) ───────
  // Each gates a behavior-changing scorer/selector fix. ALL DEFAULT FALSE —
  // current behavior is 100% preserved live until you flip a flag. Design:
  // 25_enrichment_improvements_design.md. Flip via menuSetScriptProperty after
  // reviewing the shadow diff (menuEnrichmentShadowSample). Read at runtime via
  // _enrichmentFlag(name) which also honors ScriptProperties of the same name
  // (so you can promote WITHOUT a code push — set property ENRICHMENT_SORT_V2=1).
  ENRICHMENT_MX_V2: false,          // G3: distinguish transient DNS failure from genuine no-MX (don't -50 on timeout)
  ENRICHMENT_SOURCETYPE_V2: false,  // G2: VESTIGIAL since 2026-06-23 (F4). The apk->pattern collapse is now UNCONDITIONAL code in EmailSelector._sourceType (a ScriptProperty reset must not re-open A16), so this flag gates nothing. Setting it 0/1 has NO effect — left for back-compat with the admin endpoint + shadow tests.
  ENRICHMENT_SORT_V2: false,        // G1: score-first sort + verification-gated confidence floor + finalizer AND-rule
  ENRICHMENT_CLASSIFY_V2: false,    // G6: dynamic classification (FREE for freemail winner; roleAccount flag)
  ENRICHMENT_BOUNCE_V2: false,      // G4: per-address hard-reject + domain soft (no domain-level nuke); inert until G9 captures bounces
  ENRICHMENT_SHADOW_SAMPLE_N: 25,   // default sample size for menuEnrichmentShadowSample

  // ─── TEMPLATE_TRIGGER_STRICT (2026-06-12-autonomous-close) ─────────────────
  // When true (default), _selectTemplate only pushes T4_TRIGGER_EVENT if the
  // trigger event/type matches a qualifying funding/expansion keyword OR the
  // RECENTLY_FUNDED edgeCase is present. Generic triggers (e.g. 'new office')
  // no longer force T4, letting T1/T2/T3/T5 win their natural cases.
  // Rollback: set to false (no code push needed — one ScriptProperty write
  // can override via _enrichmentFlag, or flip here + redeploy).
  TEMPLATE_TRIGGER_STRICT: true,

  // ─── EQ.8 DELIVERABILITY V2 FLAG (-eq8-deliv-v2) ──────────────────────────
  // Kill-switch for the deliverability overhaul (T1-T4). Default TRUE.
  // Reverts all four changes at once without a code push:
  //   ScriptProperty FORMAT_DELIV_V2=0  →  instant rollback to eq8-contentguards behavior.
  // Read via _enrichmentFlag('FORMAT_DELIV_V2') (same resolver; override > ScriptProp > CONFIG).
  FORMAT_DELIV_V2: true,            // T2: CSS header instead of cid:emailBanner img; T3: mirrored plain-text MIME; T4: direct CTA hrefs

  LOCK_TIMEOUT_MS: 5000,            // Lock wait time to prevent concurrent runs
  TRIGGER_INTERVAL_MIN: 2,          // Minutes between batch triggers

  // ─── PHASE 5.2 SCANNER REFACTOR FLAG ──────────────────────────────────────
  // Default `true` throughout the 24-48h shadow window. New Scanner.gs runs
  // in DRYRUN mode during shadow (decision-only; zero side effects); legacy
  // _scanAndProcessNewRows continues to execute side effects. After zero-diff
  // window, flip to `false` → new path takes over, legacy retained one sprint.
  // Rollback: flip back to `true` (one Property write or one redeploy).
  // See `14_scanner_refactor_design.md` §4 for the full safety contract.
  //
  // PATCH `-promote-scanner-emdash-fix` (2026-06-09): PROMOTION GATE MET.
  // Live SHADOW_SCAN_COUNT=4305 (≫ 200 minimum), SHADOW_TOTAL_COMPARED=892,372,
  // SHADOW_TOTAL_DIFF=0. Zero unexplained divergences observed across 4305
  // scans / ~26 days of shadow operation. Promoting new Scanner.gs to primary.
  // Legacy `_scanAndProcessNewRows` retained as fallback for one sprint.
  // Rollback: flip back to `true` here (one-line change + UI redeploy).
  USE_LEGACY_SCANNER: false,

  // Deliverability safety
  // PATCH `-bump-draft-limit-100` (2026-06-09): raised from 25 to 100 at user
  // request. Rationale:
  //   - 25 was an artificial conservative cap, NOT a Gmail-enforced limit
  //   - Gmail's hard caps: 100 sends/day (personal), 1,500 (Workspace) — SEND
  //     not DRAFT. Draft creation has a higher implicit ceiling (~500-1000)
  //   - User manually triages drafts before sending (Phase 6 ships
  //     observability not batch-send), so the SEND-side deliverability
  //     concern is gated by human judgment, not by this counter
  //   - L1 quota guard (BatchProcessor.gs:480-520) still parks new leads
  //     at PENDING_QUOTA_RESET once the limit is hit, so token-waste loop
  //     stays closed at the new ceiling
  // To raise further OR lower in emergency, edit this line + redeploy.
  // USER MANDATE 2026-06-12: raised from 100 → 200. Cap governs DRAFT creation only —
  // sending volume stays user-controlled (manual Send), so sender-reputation exposure is unchanged.
  DAILY_DRAFT_LIMIT: 200,           // Max drafts per day (raised from 100 — user mandate 2026-06-12-quota-200)
  DAILY_SEND_LIMIT: 20,             // Recommended max sends per day
  MIN_DELAY_BETWEEN_DRAFTS_MS: 3000,// 3 second delay between draft creation

  // ─── GMAIL TRANSIENT QUOTA FLAG (2026-06-13-quota-transient) ───────────────
  // When GmailApp throws "Service invoked too many times for one day" and today's
  // total Gmail ops are BELOW this threshold, the error is a short-window rate
  // burst (transient), not true daily exhaustion. The flag is then typed 'transient'
  // and auto-clears in GMAIL_TRANSIENT_CLEAR_MS (~3 min = one scanner tick) rather
  // than the full 60-min probe-through used for genuine daily exhaustion.
  // ★RECALIBRATED -p6-gmail-reserve (2026-06-30): was 15000 (sized to the mythical
  // ~20K pool). The real ceiling is ~3.8-4K, so at 15000 EVERY genuine daily
  // exhaustion (~3800 ops) fell below the threshold → mis-typed 'transient' →
  // flag auto-cleared in 3 min → leads flowed back, re-hit createDraft, and churned
  // all day (gmailFlagSet read false despite real exhaustion). Now set BELOW the
  // GMAIL_SCAN_TOTAL_BUDGET reserve (2200) so real exhaustion is durably flagged.
  GMAIL_TRANSIENT_OPS_THRESHOLD: 1800,  // ops/day below which a quota error = transient
  GMAIL_TRANSIENT_CLEAR_MS: 180000,     // 3 min = one scanner tick (transient flag lifetime)

  // ─── AI MODELS ─────────────────────────────────────────────
  GEMINI_MODEL: 'gemini-2.5-flash',    // Update here when Google deprecates a model
  CLAUDE_MODEL: 'claude-sonnet-4-5-20250929',  // Sonnet 4.5/4.6 respects negative constraints best (used by FollowUp LLM composer)

  // ─── GEMINI AI SYSTEM PROMPT ───────────────────────────────
  // Reframed: Job-seeking research expert who analyzes role-fit signals
  GEMINI_SYSTEM_PROMPT: 'You are an expert job-seeking research analyst with deep knowledge of Indian startup ecosystems, organizational challenges, and strategic fit assessment. Your role is to help identify role-fit signals, understand org-specific challenges that match Gaurav\'s expertise, and uncover natural conversation hooks. Focus on: (1) Identifying growth/operations/strategy challenges the company faces, (2) Finding trigger events (funding, launches, expansion) that suggest staffing needs, (3) Locating authentic connection points based on shared background or mutual connections, (4) Assessing organizational maturity and decision-making structure to inform outreach approach.',

  // ─── SHEET COLUMNS (1-indexed) ─────────────────────────────
  // Matches LinkedIn Agent (Sheet1) column order for seamless sync
  COLUMNS: {
    // Input columns (Cols A-F) — matches Code111 / LinkedIn Agent format
    LINKEDIN_URL: 1,       // A: LinkedIn URL
    FULL_NAME: 2,          // B: Full Name
    HEADLINE: 3,           // C: Headline/Summary
    DESIGNATION: 4,        // D: Designation/Title
    ORGANIZATION: 5,       // E: Organization
    EMAIL: 6,              // F: Email

    // Pipeline state columns (Cols G-U)
    STATUS: 7,             // G: Pipeline_Status
    RESEARCH_JSON: 8,      // H: Research_JSON (compressed)
    ARCHETYPE: 9,          // I: Archetype
    TEMPLATE: 10,          // J: Template
    RESUME_VARIANT: 11,    // K: Resume_Variant
    SUBJECT_LINE: 12,      // L: Subject_Line
    EMAIL_BODY: 13,        // M: Email_Body
    QUALITY_SCORE: 14,     // N: Quality_Score
    DRAFT_ID: 15,          // O: Draft_ID
    FOLLOWUP_STAGE: 16,    // P: Followup_Stage
    RESPONSE_STATUS: 17,   // Q: Response_Status
    NOTES: 18,             // R: Notes
    // Bug #9 fix: Add missing columns referenced by SheetReader.gs
    SENT_DATE: 19,           // S: Sent_Date
    FOLLOWUP_DATES: 20,      // T: Followup_Dates
    LAST_UPDATED: 21,        // U: Last_Updated
    // 2026 rewrite — Gmail threading + email enrichment columns
    THREAD_ID: 22,           // V: Gmail thread ID captured from createDraft (enables threaded follow-ups)
    RFC822_MESSAGE_ID: 23,   // W: RFC 2822 Message-ID header (fallback for cross-client threading)
    ENRICHED_EMAIL: 24,      // X: Verified/guessed email used by the pipeline (kept alongside original in F)
    EMAIL_SOURCE: 25,        // Y: 'sheet_corporate' | 'guessed_pattern' | 'reoon_verified' | 'rejected' — audit trail
    EMAIL_CONFIDENCE: 26,    // Z: 0.0-1.0 actual deliverability confidence (Reoon SMTP + source weighting)
    // PATCH 2026-05-16 (Option 5 / Sub-option 2): TARGET_ROLE column.
    //   Empty (default for all 184+ existing leads) → composer frames email as
    //     INFORMATIONAL outreach about the function area at the recipient's
    //     company. Never claims a specific role is open.
    //   Non-empty → composer switches to APPLYING framing referencing this
    //     specific role title (or JD URL — accepts either form).
    //   Written via ?action=set_lead_field&field=target_role&value=...
    //   Sheet2-only (not in Sheet1; not propagated by =UNIQUE() formula).
    TARGET_ROLE: 27,         // AA: optional specific role being applied to; empty → informational framing
    // PATCH Phase 3 (2026-05-20 remediation sprint p3-leaduid): LEAD_UID
    // column. Appended (not inserted) at position 28 = AB. Stable identity
    // string written by BatchProcessor on first pickup; never rewritten after.
    // Backfill populates legacy rows asynchronously.
    LEAD_UID: 28             // AB: stable per-lead UUID; set on Sheet2 pickup or via backfill
  },
  // Total width (used by SheetReader getRange calls). Bump when new columns are added.
  SHEET_COL_COUNT: 28,

  // ─── SHEET1 (RAW AUDIT) COLUMN MAP ────────────────────────────────────────
  // Sheet1 is append-only audit; UNIQUE(Sheet1!B2:G) feeds Sheet2's first 6
  // columns. Sheet1 has 12 fixed columns A-L for the APK/extension payload.
  // Phase 3 appends a 13th (M) for LEAD_UID — outside the UNIQUE range so
  // the spillover continues working unchanged.
  SHEET1_COLUMNS: {
    TIMESTAMP:     1,   // A
    LINKEDIN_URL:  2,   // B  ─┐
    FULL_NAME:     3,   // C  │ UNIQUE(Sheet1!B2:G) → Sheet2!A2:F
    HEADLINE:      4,   // D  │
    DESIGNATION:   5,   // E  │
    ORGANIZATION:  6,   // F  │
    EMAIL:         7,   // G  ─┘
    PHONE:         8,   // H
    WEBSITE:       9,   // I
    LOCATION:     10,   // J
    CONNECTION:   11,   // K
    CONFIDENCE:   12,   // L
    LEAD_UID:     13    // M (Phase 3 — Sheet1.LEAD_UID, written by doPost)
  },
  SHEET1_COL_COUNT: 13,

  // Phase 3 — dedup window for same-URL captures (Resolution A).
  // If a second doPost arrives for the SAME linkedinUrl within this window,
  // reuse the existing Sheet1 row's LEAD_UID; do not append a new row.
  // 5 min matches "share via APK, immediately share via Chrome ext to add context".
  // Configurable here for adjustment per real usage pattern.
  LEAD_UID_DEDUP_WINDOW_MS: 5 * 60 * 1000,

  // Phase 3 QC1 follow-up — script-lock wait for the doPost lookup-then-append
  // critical section (_resolveCaptureUid_). Closes the millisecond-level TOCTOU
  // race where two concurrent same-URL captures (APK burst, or APK + extension
  // double-capture) both find no match and both appendRow. SHORT by design:
  // doPost is latency-sensitive (the client blocks on the response, and
  // _kickoffAfterCapture already adds cost), so the second caller rides out the
  // first execution's fast find+append, then dedups. On timeout we proceed
  // UNLOCKED (best-effort) rather than drop the capture — a rare duplicate is
  // recoverable (UNIQUE view + downstream UID checks); a lost lead is not.
  // Tune up if real bursts exceed this; down to cut tail latency on contention.
  CAPTURE_LOCK_TIMEOUT_MS: 500,

  // ─── SCRIPT PROPERTY KEYS (secrets live in Script Properties, never source) ─
  PROPERTY_KEYS: {
    REOON_API_KEY: 'REOON_API_KEY',                  // Email deliverability API key
    HUNTER_API_KEY: 'HUNTER_API_KEY',                // Hunter.io fallback for hard-to-find emails (Domain Search + Email Finder)
    APOLLO_API_KEY: 'APOLLO_API_KEY',                // Apollo.io — /organizations/search works on free tier (disambiguates same-named companies)
    SNOV_API_USER_ID: 'SNOV_API_USER_ID',            // Snov.io OAuth client ID — domain B2B presence + email finder
    SNOV_API_SECRET: 'SNOV_API_SECRET',              // Snov.io OAuth client secret
    GITHUB_PAT: 'GITHUB_PAT',                        // GitHub PAT — 60/hr → 5000/hr for org + commit-email mining
    LOR_DRIVE_ID: 'LOR_DRIVE_ID',                    // Drive file ID for Letter of Recommendation PDF
    AUTOMAIL_WEBAPP_SECRET: 'AUTOMAIL_WEBAPP_SECRET',// Shared secret for /doPost auth (extension + PWA)
    HOOK_ROTATION_QUEUE: 'HOOK_ROTATION_QUEUE',      // JSON array — last N hook tiers used (anti-bias)
    REOON_VERIFY_CACHE_PREFIX: 'REOON_VERIFY_',      // Per-email cache prefix (30-day TTL)
    HUNTER_VERIFY_CACHE_PREFIX: 'HUNTER_FIND_'       // Per-(domain+name) cache prefix (Hunter is rate-limited)
  },

  // ─── EMAIL FORMAT (2026 reference-email match) ──────────────
  EMAIL_FORMAT: {
    version: 'BULLET_V1',          // Toggle between 'PROSE_V0' (legacy) and 'BULLET_V1' (reference-style)
    maxBullets: 4,                 // Per reference emails, 3-4 bullets is the sweet spot
    minBullets: 2,                 // Below this, fall back to prose format
    bodyWordCountMax: 220,         // Bullet format needs more headroom than 125-word prose cap
    minDraftConfidence: 0.50,      // Pre-draft gate — RELAXED 2026-05-11 from 0.65 to 0.50 so corporate catch-all domains (very common — accept any address at SMTP) still get drafted. Threshold 0.50 = accepts "safe" + "role_account" + "catch_all" from both sheet & guess paths; rejects "unknown"/"skipped" guesses and explicit invalid/disabled/spamtrap (those are already filtered upstream). Set higher (e.g. 0.70) if you only want SMTP-confirmed deliveries.
    justInTimeReoonForLegacy: true // If lead row has no emailConfidence (older rows from before Reoon was wired), run a JIT Reoon verify just before draft creation.
  },

  // ─── HOOK ROTATION (kills the "every email opens the same way" bias) ──
  HOOK_ROTATION: {
    queueDepth: 5,                 // How many recent hook types to track per Claude prompt
    avoidConsecutiveTier: true,    // Forbid the same tier twice in a row
    maxSameTierIn5: 3              // Of the last 5 emails, no more than 3 from the same tier
  }
};

// ─── PIPELINE STATUS CONSTANTS ──────────────────────────────
var STATUS = {
  NEW: 'NEW',                                // Unprocessed lead
  NEEDS_EMAIL: 'NEEDS_EMAIL',                // Email gate: no usable address; no enrichment candidates possible
  NEEDS_EMAIL_REVIEW: 'NEEDS_EMAIL_REVIEW',  // Email gate: candidates proposed; user must pick one and re-run
  RESEARCHING: 'RESEARCHING',                // Currently researching
  RESEARCH_DONE: 'RESEARCH_DONE',            // Research complete, ready to classify
  CLASSIFYING: 'CLASSIFYING',                // Analyzing lead fit
  COMPOSING: 'COMPOSING',                    // Writing email
  HUMANIZING: 'HUMANIZING',                  // Making it more natural
  QUALITY_CHECK: 'QUALITY_CHECK',            // QualityGate review
  REVIEW: 'REVIEW',                          // Manual review needed (flag for user)
  // PATCH 2026-05-15 (v2 Track D): explicit terminal for Tier 3 deterministic
  // fallback drafts. Distinct from REVIEW so the dashboard can show a "needs
  // human personalization before send" indicator vs a generic "validator
  // wants you to look at this." NEEDS_REVIEW draft IS created in Gmail; user
  // edits before sending. Watchdog does NOT reset NEEDS_REVIEW (intentional
  // terminal that requires human action).
  NEEDS_REVIEW: 'NEEDS_REVIEW',              // Tier 3 deterministic fallback; draft created, needs personalization
  // PATCH 2026-05-18: PSV retries exhausted (>3) on Reoon=unknown — manual
  // decision required (send anyway, hold, or skip). Distinct from REVIEW
  // (validator-flagged) and NEEDS_EMAIL_REVIEW (no email picked yet).
  NEEDS_PRE_SEND_REVIEW: 'NEEDS_PRE_SEND_REVIEW',
  // PATCH 2026-05-18: Apollo-stale-sweep flagged this row's recipient as
  // belonging to an ex-employer. Draft IS already in Gmail (created
  // before the guard shipped) but the address is suspect. User edits
  // ENRICHED_EMAIL (col X) and flips to RESEARCH_DONE to re-draft, OR
  // confirms back to DRAFT_CREATED if the address is still good.
  STALE_RECIPIENT_REVIEW: 'STALE_RECIPIENT_REVIEW',
  DRAFT_CREATED: 'DRAFT_CREATED',            // Gmail draft ready
  DRAFT_FAILED: 'DRAFT_FAILED',              // PATCH `-eq8-content-fix` (#2): Gmail createDraft returned/threw failure. Was silently left at COMPOSING → infinite re-pick. Now an explicit, bounded-retry terminal (in scanner auto-recover whitelist with errRetry budget).
  // PATCH 2026-05-19: lifecycle states for drafts that sit in Drafts folder
  // indefinitely. DraftStateMonitor (daily cron) advances DRAFT_CREATED →
  // DRAFT_STALE at 14 days, DRAFT_STALE → DRAFT_ABANDONED at 30 days.
  // Both states are still reversible: edit STATUS back to DRAFT_CREATED
  // (or send the draft in Gmail) and the syncer picks it up normally.
  DRAFT_STALE: 'DRAFT_STALE',                // Sat in Drafts ≥14 days; FCM nudge sent
  DRAFT_ABANDONED: 'DRAFT_ABANDONED',        // Sat ≥30 days; auto-archived
  // Replaces ambiguous SKIPPED when the syncer detects a draft was deleted
  // without being sent. Explicit signal so user can distinguish "I rejected
  // this lead" (DRAFT_DELETED) from "system skipped due to data issue".
  DRAFT_DELETED: 'DRAFT_DELETED',
  SENT: 'SENT',                              // Email sent (anchors follow-up countdown)
  FOLLOWUP_1: 'FOLLOWUP_1',                  // First follow-up sent
  FOLLOWUP_2: 'FOLLOWUP_2',                  // Second follow-up sent
  FOLLOWUP_3: 'FOLLOWUP_3',                  // Third follow-up sent
  RESPONDED: 'RESPONDED',                    // Lead responded
  SKIPPED: 'SKIPPED',                        // Lead skipped (not a fit)
  ERROR: 'ERROR',                            // Processing error
  // PATCH `-p5-composer-preflight` (Phase 2b L1): pipeline parked the row
  // BEFORE running any Claude/Gemini calls because the daily Gmail draft
  // quota was exhausted. The row will be re-picked on the next-day cron
  // (PENDING_QUOTA_RESET is in the scanner whitelist; L1 quota check
  // re-gates and either succeeds or re-parks). Distinguishes "no draft
  // because quota" from ERROR (genuine processing failure) and avoids
  // burning ~5K Claude tokens per silently-failing reprocess.
  PENDING_QUOTA_RESET: 'PENDING_QUOTA_RESET',
  // PATCH `-p5-vendorresilience-gemini` (Phase 2c L1.5): pipeline parked
  // the row because Gemini is in an active 429-backoff window. Live
  // diagnosis showed ~32s/lead wasted on 429-retry storms (8 retries in
  // stage2_research + 8 in stage4_compose) — and worse, when Tier 1
  // Claude composer is invoked with degraded research data, it still
  // burns ~5K Claude tokens. Parking at this status until the backoff
  // expires (default 30s window, scanner re-picks on next cron) saves
  // both Gemini retry latency AND prevents Claude from being called
  // with garbage upstream data.
  PENDING_GEMINI_BACKOFF: 'PENDING_GEMINI_BACKOFF'
};

// ─── DELIVERABILITY SETTINGS ───────────────────────────────
// PATCH `-bump-draft-limit-100` (2026-06-09): maxDailyDrafts raised
// 25 → 100 to match CONFIG.DAILY_DRAFT_LIMIT (which is the actual gate
// read by _checkDailyDraftLimit). warmupSchedule week5+ also bumped
// since user is well past the warmup window. SEND cap (maxDailySends)
// kept at 20 — that's the deliverability-sensitive gate; user controls
// it manually by clicking Send.
// USER MANDATE 2026-06-12-quota-200: maxDailyDrafts + week5Plus raised 100 → 200
// to mirror CONFIG.DAILY_DRAFT_LIMIT. SEND cap stays 20 (deliverability-sensitive).
var DELIVERABILITY = {
  maxDailyDrafts: 200,
  maxDailySends: 20,
  minInterDraftDelayMs: 3000,
  warmupSchedule: {      // Gradual ramp-up for new senders
    week1: 5,
    week2: 10,
    week3: 15,
    week4: 20,
    week5Plus: 200   // bumped from 100 — user mandate 2026-06-12-quota-200; mirrors DAILY_DRAFT_LIMIT
  },
  trackingProperty: 'DAILY_DRAFTS_'  // Property key prefix for daily count
};

// ─── GAURAV PROFILE: Resume Highlights by Variant ──────────
var GAURAV_PROFILE = {
  GROWTH_MARKETING: {
    variant: 'GROWTH_MARKETING',
    title: 'Growth & Operations Lead',
    achievements: [
      'Senior Manager at Blinkit Bistro (Zomato): Scaled ~50 cloud kitchens across 4 cities with end-to-end P&L ownership and SLA management',
      'Profitability Waterfall: 13 margin interventions generating Rs 5.7L/month (~Rs 68L annualized)',
      'Quality Crisis Resolution: Cut complaint rate by 94% across 121K orders, closed 40% of quality gap in 2.5 weeks',
      'At Thoughtworks: Built AI-powered email system reducing drafting by 85%, managed 8 MarTech tools, achieved 25% APAC conversion lift and 30% CAC reduction',
      'At Blinkit Growth: GTM launch for 38 dark stores, doubled DAUs YoY growth rate to 15%, reduced marketing costs 40%',
      'At upGrad: Built referral program from 0 to Rs 1.5 Cr in 4 months with 100+ successful career transitions'
    ]
  },
  OPS_CONSULTING: {
    variant: 'OPS_CONSULTING',
    title: 'Operations & Strategy Consultant',
    achievements: [
      'Station P&L Ownership: End-to-end profit/loss, inventory, quality, and SLA management for 50+ cloud kitchens across 4 cities',
      'Inventory Optimization: QR-based putaway system with 10-15 min SLA, ~200 daily restocking cycles at ~100% adherence',
      'Analytics & Reporting: Built 8-tab quality analytics dashboard integrating 30+ cross-functional stakeholders',
      'Quality & Compliance: Managed cold-chain audits, FEFO workflows, GRN processes, and SLA scorecards — reduced complaints 94%',
      'P&L Workbook: Created 35K-formula workbook for real-time unit economics across all stations',
      'Stakeholder Management: Coordinated ops, supply chain, quality, and vendor teams to execute 40% quality gap closure in 2.5 weeks'
    ]
  },
  PRODUCT_AI_STRATEGY: {
    variant: 'PRODUCT_AI_STRATEGY',
    title: 'Product & AI Strategy Lead',
    achievements: [
      '6-Component AI Pipeline: Domain-restricted RAG system on Weaviate for B2B email generation, 800K+ character output with LangChain and Python',
      '85% Drafting Reduction: Automated routine email workflows for 8 MarTech tools, cut manual effort by 85%',
      '25% Conversion Boost: Predictive lead scoring and B2B segmentation (4x5x3x4 matrix) adopted globally across Thoughtworks APAC',
      'GTM Strategy & Unit Economics: P&L modeling, customer segmentation, and pricing strategy for SaaS products',
      'Tech Stack: Expertise in Jasper AI, LangChain, Weaviate RAG, DSPy prompt engineering, Sheets/Docs API integration',
      'Product Roadmap & Execution: Led product launches (38 dark stores GTM), feature prioritization, and stakeholder alignment'
    ]
  },

  // ─── PHASE 4 — TIER 3 VARIANT BLOCKS (stamp: -p4-cxotier3) ───────────────
  //
  // Resume-variant entries above (GROWTH_MARKETING, OPS_CONSULTING,
  // PRODUCT_AI_STRATEGY) control WHICH RESUME ATTACHMENT ships with the
  // email. The Tier 3 variant blocks below control which DETERMINISTIC
  // FALLBACK TEMPLATE renders when Claude is unreachable, keyed by the
  // recipient's classification.template (CXO_SHORT / HR_RECRUITER /
  // STANDARD-default).
  //
  // Required content per variant (per Phase 4.2 spec):
  //   bullets[]:     3 experience bullets framed for the audience
  //   hookFragment:  1 hook fragment with {{company_name}} substitution
  //   threadSummary: 1 thread-summary line specific to the variant
  //   psFragment:    1 P.S. fragment
  //
  // CXO outcomes/financial framing; HR process/scale/stakeholder framing.
  // STANDARD has no separate block here — it's the hardcoded default in
  // _composeDeterministicFallback (EmailComposer.gs:1722).

  // ─── PHASE 4-ENRICH (stamp: -p4-cxotier3-enrich) ──────────────────────────
  //
  // Variant content refactored per two authoritative playbook PDFs:
  //   1. Gaurav_Leadership_Cold_Email_Template.pdf  → cxoVariant
  //   2. Gaurav_Standardized_Recruiter_Email_AIxGrowth.pdf → hrVariant
  //
  // Design-decision table preserved in 12b_variant_design_decisions.md.
  //
  // Word-count targets:
  //   cxoVariant body:  90-125 words (Leadership §2 five-line structure)
  //   hrVariant body:  150-200 words (Recruiter §6 with India context block)
  //
  // Shared "Youngest department lead at Great Learning" P.S. (Recruiter §6
  // + Leadership §2 — single strongest differentiator). REVERSES the
  // earlier session's forbidden-youngest instruction; current playbook
  // authority + this prompt's Section 4.6+5.6 supersede.

  cxoVariant: {
    variant: 'CXO_SHORT',
    targetArchetype: 'CXO_SHORT',

    // 5-line structure (Leadership §2). Each line has a target word count:
    //   hook: 18-22 | credibility: 30-40 | bridge: 15-20 | ask: 12-18 | ps: ~25
    // {{company_name}} + {{first_name}} substituted at composition time.

    // Line 1: Hook — anchor + 2nd-order implication (18-22 words)
    // Amended -p4-cxotier3-enrich-amend2: further compressed for 90-125 strict band.
    // "operating at a scale where ... stop being separate problems" →
    // "is at a scale where ... blur into one problem" — same meaning, 6 words saved.
    hookFragment: '{{company_name}} is at a scale where growth, lifecycle, and ops usually blur ' +
                  'into one problem — that overlap is where I do my best work.',

    // Line 2: Credibility — 3 brand-anchored numeric outcomes, AI tools UNNAMED
    // (Leadership §1 audit: "Drop the tool names; they mean nothing to Saumya")
    // Amended: tighter sentence rhythm, ~6 words saved
    credibilityParagraph: 'Built upGrad\'s referral funnel from 0 to ₹1.5 Cr in 4 months. Ran ops ' +
                          'for ~50 cloud kitchens at Blinkit Bistro across 4 cities, 30+ stakeholders. ' +
                          'Shipped 3 AI tools solo, automating sourcing, outreach and CRM.',

    // Line 3: Bridge — problem-shape framing (15-20 words)
    // Amended -p4-cxotier3-enrich-amend2: further tightened — dropped "for a",
    // "who can", "end-to-end", "I'd value" (~4 words saved). No signal loss.
    bridgeFragment: 'If {{company_name}} is hiring a founding operator to own the AI-native ' +
                    'execution layer, worth 15 minutes?',

    // Line 4: Ask — single CTA, Calendly anchor (12-18 words)
    askFragment: '15 minutes Tue or Thu?',
    askCalendlyUrl: 'https://calendly.com/speak-to-gaurav/30min',

    // Line 5: P.S. — single strongest differentiator (locked, shared with hrVariant)
    psFragment: 'Youngest department lead at Great Learning — scaled B2B partnerships across ' +
                '50+ countries before turning 25.',

    // PATCH 2026-06-12-strategy-tilt: work-experience bullets for CXO (2-3, metric-led, ≤18 words each).
    // Rendered between hook+credibility and bridge/ask for Leadership-archetype emails.
    // Each bullet: ≤18 words, metric-led, from verified profile. No TA/recruiting claims.
    experienceBullets: [
      { label: 'upGrad',           body: 'Built referral funnel from 0 to ₹1.5 Cr in 4 months across 14 cross-functional teams.' },
      { label: 'Blinkit Bistro',   body: 'Ran P&L for ~50 cloud kitchens, 4 cities; cut complaint rate 94% across 121K orders.' },
      { label: 'Great Learning',   body: 'Scaled B2B partnerships across 50+ countries; built international vertical from zero.' }
    ],

    // Subject template: Leadership §3 Pattern B (peer-intro tone)
    // PATCH 2026-06-12-strategy-tilt: "growth & ops" → "strategy & growth" (strategy-first positioning)
    subjectTemplate: '{{first_name}} | Gaurav — note on {{company_name}} strategy & growth',

    // Signature: Leadership §1 audit — single-line provenance (2 lines + credentials inline)
    signatureLine1: 'ex-Great Learning · ex-upGrad · Blinkit Bistro | MBA, IIM Kozhikode',
    signatureLine2: 'LinkedIn · github.com/GauravRIIMK',

    // Banner: STRIPPED (Leadership §1 — "reads junior to a Director+")
    showBanner: false
  },

  hrVariant: {
    variant: 'HR_RECRUITER',
    targetArchetype: 'HR_RECRUITER',

    // Locked identity (Recruiter §5) — VERBATIM, never paraphrased.
    // Every HR email opens with this exact sentence (after greeting + hook).
    identityStatement: 'I am a growth & strategy operator who builds AI systems so lean teams ' +
                       'deliver what normally takes 3–5x the headcount.',

    // 4 proof bullets (Recruiter §4 Rule 1) — order matters, AI bullet LAST
    bullets: [
      'upGrad — built the 0-to-1 referral funnel to ₹1.5 Cr in 4 months.',
      'Blinkit Bistro — ran ops for ~50 cloud kitchens across 4 cities, 30+ stakeholders.',
      'Great Learning — scaled B2B partnerships across 50+ countries; youngest department lead ' +
        'in the company\'s history.',
      'Shipped 3 production AI tools solo — automating sourcing, outreach and CRM end-to-end.'
    ],

    // Hook line (Recruiter §7) — Tier 3 substitution; user rewrites at review
    // Amended -p4-cxotier3-enrich-amend: trimmed for word-count band compliance
    hookFragment: 'Following {{company_name}}\'s recent activity — there are usually a few growth, ' +
                  'lifecycle, and ops surfaces where an AI-native operator can compress what a team used to do.',

    // Closing line (Recruiter §5) — "problem-shape, not title"; portfolio candidacy
    // PATCH 2026-06-12-strategy-tilt: reordered to Strategy/Marketing/Growth-first; ops is supporting.
    closingLine: 'Exploring roles across strategy, growth, and marketing — anywhere an ' +
                 'AI-native operator fits. Glad to be considered for current or upcoming roles.',

    // India screening block (Recruiter §11.1) — omitting CTC/notice triggers silent skip
    // Amended: condensed location list + shorter labels
    indiaContextBlock: 'Quick context for screening:\n' +
                       '- Experience: 4.5+ years | Current: Senior Manager, Blinkit Bistro\n' +
                       '- Notice: [VERIFY BEFORE SEND] | Location: Gurgaon (open to NCR / Hybrid / Remote)\n' +
                       '- Expected CTC: [VERIFY BEFORE SEND]',

    // P.S. — locked, shared with cxoVariant
    psFragment: 'Youngest department lead at Great Learning — scaled B2B partnerships across ' +
                '50+ countries before turning 25.',

    // Subject template: Recruiter §8 Pattern A (identity-led, 83 chars — mobile-safe)
    // No {{company_name}} substitution — identity-led, not company-led
    subjectTemplate: 'AI-native Growth & Strategy operator — ex-upGrad (₹1.5 Cr funnel) | Gaurav Rathore',

    // Signature: Recruiter §6 — multi-line (recruiters use IIM-K as anchor)
    signatureLine1: 'MBA, IIM Kozhikode | B.E., Thapar University',
    signaturePhone: '+91-[VERIFY]',
    signatureLine2: 'LinkedIn | github.com/GauravRIIMK',

    // Banner: KEPT (Recruiter expects visual marker; Leadership §1 only marks it junior at Director+)
    showBanner: true
  }
};

// ─── TEMPORAL CONSTANTS (used by recency validator) ─────
// Today's date reference for "is this fact stale?" checks. Update once a year.
var CURRENT_YEAR = 2026;

// ─── GAURAV EXHAUSTIVE ACHIEVEMENT BANK (for validator fact-checks) ─────
// Each metric claim below is a VERIFIED fact from Gaurav's resumes. The validator
// uses this bank to confirm that any specific number / achievement / tool / role
// Claude emits in an email actually maps to a real line item. Anything not listed
// here is treated as unverified and flagged.
//
// Shape: each entry is a free-text achievement + a machine-readable "metrics" array
// of numeric/proper-noun tokens that MUST appear in the email text when citing this
// achievement, and an "aliases" array of alternate phrasings. The validator
// matches against normalized (lowercased, punctuation-stripped) body text.
var GAURAV_ACHIEVEMENT_BANK = {
  // ── Blinkit Bistro / Zomato (Cloud Kitchens) ──
  'blinkit_bistro_scale':        { metrics: ['50', '4 cities', 'cloud kitchens', 'p&l'], aliases: ['50 cloud kitchens', 'cloud kitchen', 'dark kitchen', 'bistro'], role: 'Senior Manager', org: 'Blinkit Bistro' },
  'blinkit_bistro_margin':       { metrics: ['13', '5.7', '68'],                          aliases: ['margin interventions', 'profitability waterfall', '68L', '68 lakh', '5.7L'], role: 'Senior Manager', org: 'Blinkit Bistro' },
  'blinkit_bistro_quality':      { metrics: ['94', '121', '40', '2.5'],                   aliases: ['complaint rate', 'quality gap', '121K orders', '94%', '2.5 weeks'], role: 'Senior Manager', org: 'Blinkit Bistro' },
  'blinkit_bistro_inventory':    { metrics: ['10', '15', '200'],                          aliases: ['qr-based putaway', 'qr putaway', 'restocking cycles', 'sla adherence', 'fefo', 'grn'], role: 'Senior Manager', org: 'Blinkit Bistro' },
  'blinkit_bistro_workbook':     { metrics: ['35', '35k'],                                aliases: ['35K formula', '35k-formula', 'p&l workbook', 'unit economics workbook'], role: 'Senior Manager', org: 'Blinkit Bistro' },
  'blinkit_bistro_dashboard':    { metrics: ['8', '30'],                                  aliases: ['8-tab', 'quality dashboard', 'cross-functional stakeholders'], role: 'Senior Manager', org: 'Blinkit Bistro' },

  // ── Blinkit Growth ──
  'blinkit_growth_launch':       { metrics: ['38'],                                       aliases: ['38 dark stores', 'dark stores', 'gtm launch', 'store launch'], role: 'Growth Manager', org: 'Blinkit' },
  'blinkit_growth_dau':          { metrics: ['15'],                                       aliases: ['dau', 'daily active', 'yoy growth', 'doubled dau'], role: 'Growth Manager', org: 'Blinkit' },
  'blinkit_growth_cac':          { metrics: ['40'],                                       aliases: ['marketing cost', 'cac reduction', '40% cac', 'acquisition cost'], role: 'Growth Manager', org: 'Blinkit' },

  // ── Thoughtworks ──
  'thoughtworks_ai_pipeline':    { metrics: ['6', '800'],                                 aliases: ['6-component', 'ai pipeline', 'rag', 'weaviate', 'langchain', 'b2b email'], role: 'Consultant', org: 'Thoughtworks' },
  'thoughtworks_drafting':       { metrics: ['85', '8'],                                  aliases: ['85% drafting', 'email system', 'martech tools', 'drafting by 85'], role: 'Consultant', org: 'Thoughtworks' },
  'thoughtworks_conversion':     { metrics: ['25', '30'],                                 aliases: ['apac conversion', 'conversion lift', 'cac reduction', 'lead scoring', 'b2b segmentation', '4x5x3x4'], role: 'Consultant', org: 'Thoughtworks' },

  // ── upGrad ──
  'upgrad_referral':             { metrics: ['1.5', '100', '0', '4'],                     aliases: ['referral program', '1.5cr', '1.5 cr', '100+ career transitions', 'career transitions', 'from 0 to'], role: 'Growth Lead', org: 'upGrad' },

  // ── Tech Stack / Tools (verified) ──
  'tools_stack':                 { metrics: [],                                            aliases: ['jasper ai', 'langchain', 'weaviate', 'dspy', 'python', 'sheets api', 'docs api', 'apps script', 'rag system', 'prompt engineering'], role: 'Cross-cutting', org: 'Cross-cutting' }
};

// All verified numbers/metrics across all roles (for quick "is this number real?" lookup)
// '15' here is the Blinkit inventory SLA (10-15 min) and Blinkit DAU growth (15%) —
// it is NOT the upGrad referral figure, which is 1.5 Cr. Do not remove '15'.
var GAURAV_METRIC_WHITELIST = [
  '50', '4', '13', '1.5', '5.7', '68', '94', '121', '40', '2.5', '10', '15', '200', '35', '8', '30',
  '38', '6', '800', '85', '25', '800k', '35k', '1.5cr', '68l', '5.7l', '121k',
  '0', '100', '4x5x3x4'
];

// Verified roles Gaurav has held (for "I led X" / "As a Y" verification)
var GAURAV_VERIFIED_ROLES = [
  'senior manager', 'growth manager', 'consultant', 'growth lead',
  'operations lead', 'strategy lead', 'product lead', 'p&l owner',
  'manager', 'lead', 'consultant', 'analyst'
];

// ─── GAURAV VERIFIED FACTS (anti-hallucination ground truth) ─────
// Used by EmailComposer to fact-check Claude's output before sending.
// Any claim about Gaurav's background MUST match one of these entries.
var GAURAV_FACTS = {
  // ─── Education (ONLY these institutions) ──
  education: [
    { institution: 'IIM Kozhikode', degree: 'MBA', type: 'postgrad' },
    { institution: 'Thapar University', degree: 'B.E.', type: 'undergrad' }
  ],
  // Keywords that identify his ACTUAL alma maters (for regex matching)
  alumniKeywords: ['iim kozhikode', 'iim k', 'iimk', 'thapar university', 'thapar'],

  // ─── Work History (ONLY these companies) ──
  companies: ['Blinkit', 'Blinkit Bistro', 'Zomato', 'Thoughtworks', 'upGrad', 'Great Learning', 'Shiprocket'],

  // ─── FALSE alumni claims to catch ──
  // These are institutions/orgs often confused with lead orgs.
  // If Claude claims "fellow alum" of any of these, it's hallucination.
  notAlumniOf: [
    'great lakes', 'iim bangalore', 'iim ahmedabad',
    'iim calcutta', 'iim lucknow', 'iim indore', 'iit', 'bits pilani',
    'xlri', 'fms', 'isb', 'sp jain', 'nmims', 'symbiosis', 'christ university',
    'manipal', 'amity', 'lovely professional'
  ],

  // ─── Current identity for signature ──
  // PATCH `-hr-cxo-template-polish` (2026-06-09): canonical LinkedIn URL
  // corrected from `gaurav-rathore-iimk` (404 / stale handle) to
  // `gaurav1-grow-learn-together` (live handle). `githubUrl` added so all
  // signature renderers can pull from one source of truth.
  fullName: 'Gaurav Rathore',
  signatureLine1: 'MBA, IIM Kozhikode | B.E., Thapar University',
  linkedin: 'https://www.linkedin.com/in/gaurav1-grow-learn-together/',
  githubUrl: 'https://github.com/GauravRIIMK'
};

// ─── REFERENCE-EMAIL STATIC BLOCKS (used by the bullet-list HTML builder) ─
// Mirrors the structure of Gaurav's two reference emails (Kapture / MAS): a
// short fixed AI-tools section + a one-line "current role" blurb + the LOR
// tag inserted on the Thoughtworks bullet for AI-relevant archetypes.
//
// These blocks are STATIC across all emails. The dynamic parts (greeting,
// hook, bridge, experience bullets, motivation, CTA, P.S.) are still
// generated by Claude per-lead.
var REFERENCE_BLOCKS = {
  // 3 AI tools — AUTHORITATIVE static block. Exact wording + URLs per canonical template.
  // The HTML builder uses item.url to wrap item.label in a <b><a href="..."> link.
  // DO NOT let Claude regenerate this section — showAiToolsBlock drives inclusion only.
  aiTools: {
    // PATCH -eq8-draftpolish (F5): colon → period + inline GitHub hyperlink
    header: 'On the builder side, three AI tools shipped independently (all live). <a href="https://github.com/GauravRIIMK" style="color:#1a73e8;text-decoration:underline;">github.com/GauravRIIMK</a>',
    items: [
      {
        label: 'LinkedIn Data Agent',
        body: 'solved the cold-outreach bottleneck (contact-data quality, not drafting): Apollo/Hunter/SMTP enrichment - drafts in your inbox with auto-resume',
        url: 'https://github.com/GauravRIIMK/automail-pipeline'
      },
      {
        label: 'Job Scraping Mailer',
        body: 'EasyApply optimises volume but kills reply rate; this surfaces hiring-manager posts on LinkedIn + Naukri, filtered by role; where replies actually happen',
        url: 'https://github.com/GauravRIIMK/linkedin-jobs-scraper-public'
      },
      {
        label: 'Scalar BDA CRM',
        body: 'shipped for Scalar\'s BD team; built for how non-technical operators actually work',
        url: 'https://github.com/GauravRIIMK/scaler-sales-agent'
      }
    ],
    githubFooter: 'Here\'s what my GitHub has been since Claude Code dropped: <a href="https://github.com/GauravRIIMK" style="color:#0b66c3;text-decoration:underline;">github.com/GauravRIIMK</a>'
    // — UNUSED since 2026-06-12-fresh-first (user mandate: line removed from emails).
    // The sentence was dangling linkless in T2 dedup edge cases (T2 stripped the footer
    // anchor while keeping the header anchor). The github.com link lives in aiTools.header.
  },

  // PATCH 2026-05-13 (D4 acceptance test): "Schedule a call here" calendly
  // anchor — the 5th required hyperlink per the gold-standard spec. Rendered
  // inline at the end of closingLogistics. Plain-text fallback shows the URL.
  calendlyAnchor: {
    text: 'Schedule a call here',
    url: 'https://calendly.com/speak-to-gaurav/30min',
    html: '<a href="https://calendly.com/speak-to-gaurav/30min" style="color:#0b66c3;text-decoration:underline;font-weight:bold;">Schedule a call here</a>'
  },

  // 1-line current role blurb — used for emails where the candidate's current
  // operational context is relevant (ops/strategy archetypes only)
  // PATCH 2026-05-12: corrected company name to "Blinkit Bistro" (was "Bistro by Blinkit")
  currentRoleBlurb: 'Currently working at Blinkit Bistro in the operations team - running ops + analytics across ~50 cloud-kitchen pods in NCR and Bengaluru.',

  // Always-attach LOR (per user choice scope=a). Inline mention only on the
  // Thoughtworks bullet for archetypes where the LOR is on-topic. The validator
  // will not block emails missing this — it's purely a presentation choice.
  lorInlineTagArchetypes: ['FOUNDER_CEO', 'VP_DIRECTOR', 'MANAGER', 'FUNCTIONAL_LEAD', 'PEOPLE_OPS'],
  lorInlineTagText: '(LOR attached)',

  // Closer — mirrors reference emails: explicit logistics + 15-min ask.
  // PATCH 2026-05-12: removed "I am" / "Would love" — feels more humble.
  closerVariants: [
    'Based in Gurgaon and available to start immediately. Would value 15 minutes to discuss how this maps to what your team is building at {ORG}.',
    'Open to a 15-min conversation about whether {FUNCTION_AREA} roles on your team could be a fit.',
    'Based in Gurgaon, available to start immediately. 15 min this week to compare notes on {ORG_TOPIC}?'
  ],

  // Resume mention — appears as the last sentence before the signoff.
  // PATCH 2026-05-12: rewritten to drop "I would appreciate" / "my skills" — humbler tone.
  resumeMention: 'Please find my resume attached below for further details. Would welcome the chance to discuss how this background aligns with what your team is building.'
};

// ─── COLD EMAIL PLAYBOOK RULES ─────────────────────────────
var COLD_EMAIL_RULES = {
  // Subject line constraints
  subjectLineWordCount: {
    min: 2,
    max: 4
  },
  subjectLineCharacters: {
    max: 40
  },

  // Body constraints — 2026 reference-format upgrade
  // Bullet-list format ("Three 0-to-1 builds...") needs more headroom than the
  // legacy 125-word prose cap. Cap matches CONFIG.EMAIL_FORMAT.bodyWordCountMax.
  bodyWordCount: {
    min: 80,
    max: 220
  },

  // Banned opening lines (2026 research-backed dead list — Prospeo, Digital Bloom, Woodpecker)
  bannedOpeners: [
    'I hope this email finds you well',
    'I hope you are doing well',
    'My name is',
    'I\'m reaching out because',
    'I am reaching out because',
    'I wanted to reach out',
    'I wanted to connect',
    'I believe you might be interested',
    'I came across your profile',
    'I saw your profile',
    'Sorry to bother you',
    'I know you are busy',
    'Just following up',
    'Dear [Name]'
  ],

  // Banned subject lines
  bannedSubjectPatterns: [
    'job inquiry',
    'seeking opportunities',
    'resume attached',
    'employment opportunity',
    'career change',
    'looking for a role'
  ],

  // Opening archetypes (choose one per email)
  archetypes: [
    'Earned Compliment — genuine praise for specific work/decision',
    'Shared Connection — mutual contact or overlapping background',
    'Observation — specific insight about their company/market',
    'Provocative Question — challenge their thinking on a topic',
    'Relevant Metric — data point that ties to their domain',
    'Trigger Event — funding, launch, expansion announcement',
    'Contrarian Insight — thoughtful disagreement or alternative view'
  ],

  // CTA frameworks (choose one)
  ctaFrameworks: [
    'Interest-based: "Would it be useful if I shared..."',
    'Time-based: "15 min this week?"',
    'Question-based: "What\'s your take on...?"'
  ],

  // Email structure: BAB / PAS / Timeline Hook
  frameworkOptions: [
    'BAB: Before-After-Bridge (contrast, resolution, call-to-action)',
    'PAS: Problem-Agitate-Solve (identify pain, deepen concern, propose conversation)',
    'Timeline Hook: Time-sensitive reason for conversation now'
  ],

  // Signature format
  signatureFormat: 'Gaurav Rathore\n[One-line capability]\nlinkedin.com/in/gaurav1-grow-learn-together/',

  // Mandatory rules
  mandatoryRules: [
    'NO HTML formatting',
    'NO attachments mentioned (first email never includes attachments)',
    'NO direct job-asking language (hire me, job opportunity, position)',
    'Every sentence passes "so what?" filter',
    'Include P.S. line as second hook',
    'Frame as exploring role-fit based on company challenges, NOT selling services',
    'Ask for conversation, NOT a job directly'
  ]
};

// ─── SPAM TRIGGER WORDS (2026 Gmail filter list) ────────────
var SPAM_TRIGGER_WORDS = {
  fatal: [
    'act now', 'limited time offer', 'buy now', 'click here', 'free gift',
    'winner', 'congratulations', 'no obligation', 'risk free',
    'double your income', 'earn money', 'cash bonus', 'order now',
    'apply now', 'dear friend', 'once in a lifetime', 'act immediately',
    'million dollars', 'special offer'
  ],
  warning: [
    'exclusive deal', 'incredible', 'amazing offer', 'best price',
    'bargain', 'bonus', 'clearance', 'drastically reduced',
    'save big', 'lowest price', 'subscribe now', 'opt in'
  ]
};

// ─── SUBJECT LINE BLACKLIST ────────────────────────────────
var SUBJECT_BLACKLIST = [
  'free', 'urgent', 'act now', 'limited time', 'exclusive', 'guaranteed',
  'congratulations', 'winner', 'discount', 'promotion', 'claim now',
  'for a limited time only', 'hurry', 'asap', 'before it\'s too late',
  'last chance', 'don\'t miss out', 'unbelievable', 'incredible', 'amazing',
  'shocking', 'secret', 'no catch', 'risk-free', 'money-back guarantee',
  'satisfaction guaranteed'
];

// ─── QUALITY GATE THRESHOLDS ───────────────────────────────
var QUALITY_GATES = {
  minPersonalizationScore: 60,     // Min score (0-100) for personalization
  minLengthWords: 80,              // Min words in body (bullet format raises floor)
  maxLengthWords: 220,             // Max words (bullet-list reference format)
  maxSpamWords: 2,                 // Max fatal spam words allowed
  minSubjectLength: 2,             // Min subject line words
  maxSubjectLength: 4              // Max subject line words (playbook rule)
};

// ─── EMAIL COMPOSING SETTINGS ───────────────────────────────
var EMAIL_CONFIG = {
  // Plain-text signatures (HTML formatting handled by EmailComposer.gs _buildHtmlEmail)
  signatureVariants: {
    growth: 'Gaurav Rathore\nGrowth & Operations Leader',
    ops: 'Gaurav Rathore\nOperations & Strategy Consultant',
    product: 'Gaurav Rathore\nProduct & AI Strategy Lead'
  },

  openingHookPatterns: {
    compliment: 'I\'ve been impressed by [SPECIFIC_ACHIEVEMENT] at [COMPANY]...',
    observation: 'Noticed your recent [TRIGGER_EVENT] — interesting move on [CONTEXT]...',
    shared: 'Saw you worked with [SHARED_CONNECTION] — we share background in [DOMAIN]...',
    question: 'Quick thought: how are you thinking about [ORG_CHALLENGE] as [COMPANY] scales?'
  }
};

// ─── LEAD CLASSIFICATION ARCHETYPES (Job-seeking reframed) ──
var ARCHETYPES = {
  FOUNDER_CEO: {
    roles: ['ceo', 'founder', 'co-founder'],
    hook: 'perspective_advice',
    template: 'FOUNDER_PERSPECTIVE',
    approach: 'Ask for perspective on industry/company direction, frame as learning from their vision'
  },
  VP_DIRECTOR: {
    roles: ['vp', 'svp', 'evp', 'director', 'head of'],
    hook: 'team_challenges',
    template: 'EXEC_TEAM_CHALLENGES',
    approach: 'Discuss team scaling/challenges you can help solve, peer-level conversation'
  },
  MANAGER: {
    roles: ['manager', 'senior manager', 'team lead'],
    hook: 'operational_fit',
    template: 'MANAGER_ROLE_FIT',
    approach: 'Peer-level conversation about shared domain, explore how skills align with team needs'
  },
  FUNCTIONAL_LEAD: {
    roles: ['lead', 'owner', 'principal', 'sr engineer', 'specialist'],
    hook: 'technical_insight',
    template: 'IC_PEER_COLLABORATION',
    approach: 'Humble learning conversation, explore collaboration on specific challenges'
  },
  PEOPLE_OPS: {
    roles: ['recruiter', 'talent', 'people operations', 'hr', 'hiring'],
    hook: 'strategic_fit',
    template: 'PEOPLE_OPS_CONVERSATION',
    approach: 'Explore if there\'s a natural role fit, ask about team needs'
  },
  SKIPPED: {
    roles: ['intern', 'no email', 'duplicate'],
    hook: 'none',
    template: 'SKIP',
    approach: 'log_reason'
  }
};

// ─── COMPANY STAGE DEFINITIONS ─────────────────────────────
var COMPANY_STAGES = {
  SEED: { range: [0, 1], label: 'Seed', growth: 'high-risk/high-reward' },
  SERIES_A: { range: [1, 5], label: 'Series A', growth: 'scaling-fast' },
  SERIES_B: { range: [5, 20], label: 'Series B', growth: 'scaling-steady' },
  SERIES_C_PLUS: { range: [20, 1000], label: 'Series C+', growth: 'mature' },
  PROFITABLE: { range: [0, 1000], label: 'Profitable', growth: 'sustainable' },
  PUBLIC: { range: [1000, 999999], label: 'Public', growth: 'enterprise' }
};

// ─── TRIGGER EVENTS (Role-fit signals) ──────────────────────
var TRIGGER_EVENTS = [
  'Series A', 'Series B', 'Series C', 'raised', 'funding',
  'announced', 'launched', 'new product', 'expansion',
  'scaling team', 'opened office', 'new location',
  'acquired', 'partnership', 'hiring for'
];

// ─── FOLLOW-UP CADENCE (2026) ─────────────────────────────
// Anchored to SENT_DATE (NOT draft-creation time). Day offsets below are
// added to the day the initial was actually sent. Sweet spot per Instantly
// 2026 report: 4–7 touches; we ship a conservative 3-touch sequence
// (Day 3 / Day 7 / Day 14) that stays well under Gmail bulk-sender limits
// and still captures the ~42% reply-rate lift from follow-ups.
var FOLLOWUP_CADENCE = {
  offsetDaysByStage: { 1: 3, 2: 7, 3: 14 },
  sendHour: 9,  // 9 AM local (prime window per Instantly/Lavender data)
  frameworkByStage: { 1: 'VALUE_ADD', 2: 'SOCIAL_PROOF', 3: 'BREAK_UP' }
};

// ─── SHARED BACKGROUND KEYWORDS ─────────────────────────────
var SHARED_BACKGROUND = [
  'founder',
  'startup',
  'growth',
  'operations',
  'strategy',
  'gtm',
  'product management',
  'ai',
  'automation',
  'android',
  'mba',
  'operations strategy'
];

// ─── EMAIL TEMPLATE EXAMPLES (reference) ───────────────────
var EMAIL_TEMPLATES = {
  FOUNDER_PERSPECTIVE: {
    subject: 'Idea for [COMPANY]',
    hooks: ['Impressed by', 'Saw your recent', 'Been tracking'],
    ending: 'Would love your perspective.'
  },
  EXEC_TEAM_CHALLENGES: {
    subject: '[FUNCTION] challenges at scale?',
    hooks: ['Noticed you\'re scaling', 'Recently worked with', 'Following your growth'],
    ending: 'Curious about your approach — 15 min?'
  },
  MANAGER_ROLE_FIT: {
    subject: 'Quick question, [NAME]',
    hooks: ['Saw your work on', 'Similar background in', 'Interested in how you\'re'],
    ending: 'Would be great to compare notes.'
  },
  IC_PEER_COLLABORATION: {
    subject: 'Thought on [TOPIC]',
    hooks: ['Fellow [ROLE] here', 'Love what you\'re doing', 'Respect your approach'],
    ending: 'Would love your take.'
  },
  PEOPLE_OPS_CONVERSATION: {
    subject: '[COMPANY] team building?',
    hooks: ['Building strong team', 'Impressed with culture', 'Growth stage feels right'],
    ending: 'Worth a quick conversation?'
  }
};

// ─── LOGGING & DEBUGGING ───────────────────────────────────
var DEBUG = {
  enableLogging: true,              // Set to false to reduce log verbosity
  logApi: true,                      // Log API calls
  logStageTransitions: true,        // Log pipeline stage transitions
  maxLogEntries: 1000               // Keep last N log entries
};

// ─── HELPER FUNCTIONS ───────────────────────────────────────

/**
 * Validates that CONFIG.SHEET_ID is set
 * @returns {boolean}
 */
function isConfigured() {
  return CONFIG.SHEET_ID !== 'YOUR_SHEET_ID_HERE';
}

/**
 * Gets current daily draft count for deliverability tracking
 * @returns {number}
 */
function getDailyDraftCount() {
  var today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  var key = DELIVERABILITY.trackingProperty + today;
  var props = PropertiesService.getScriptProperties();
  return parseInt(props.getProperty(key) || 0);
}

/**
 * Increments daily draft count
 * @returns {number} New count
 */
function incrementDailyDraftCount() {
  var today = new Date().toISOString().split('T')[0];
  var key = DELIVERABILITY.trackingProperty + today;
  var props = PropertiesService.getScriptProperties();
  var currentCount = parseInt(props.getProperty(key) || 0);
  var newCount = currentCount + 1;
  props.setProperty(key, newCount.toString());
  return newCount;
}

/**
 * Checks if daily draft limit has been reached
 * @returns {boolean}
 */
function isDailyDraftLimitReached() {
  return getDailyDraftCount() >= CONFIG.DAILY_DRAFT_LIMIT;
}
