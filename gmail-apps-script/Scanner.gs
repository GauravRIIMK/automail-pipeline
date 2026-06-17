/**
 * ============================================================
 * Scanner.gs — Phase 5.2 BatchProcessor refactor (under feature flag)
 * ============================================================
 *
 * Three-layer architecture replacing the inline 4-way OR in
 * BatchProcessor.gs:_scanAndProcessNewRows. Locked behavior per
 * `13_scanner_gate_inventory.md`; target design per
 * `14_scanner_refactor_design.md`.
 *
 * LAYER 1 — ADVISORY SCORERS (5 pure functions, independently testable)
 *   scoreFreshness                  → isFresh    (Inventory §3 row 1)
 *   scoreReoonRetryReady            → isReoonRetry + retryAfter gate (row 2)
 *   scoreResearchDoneReady          → isResearchDone (row 3)
 *   scoreStuckAutoRecoverEligible   → isStuckAutoRecover + errRetry gate (row 4)
 *   scoreIdentityInputAvailable     → hasUsableEmail || canGuessEmail || hasUrlPath
 *
 * LAYER 2 — DISPATCHER (single function combineSignals — explicit precedence)
 *   identityInputAvailable === false                            → SKIP_NO_IDENTITY
 *   anyOf(4 OR-group signals) === true                          → DISPATCH
 *   otherwise                                                   → SKIP_FALL_THROUGH (silent)
 *
 * LAYER 3 — EXECUTOR (lock + dedupe + force-write + _processOneLead + retry)
 *   Gated by `opts.dryRun` flag. During shadow window, dryRun=true short-circuits
 *   BEFORE any side effect — see `14_scanner_refactor_design.md` §4 for the
 *   exhaustive inertness contract.
 *
 * FEATURE FLAG: `CONFIG.USE_LEGACY_SCANNER = true` (default during shadow).
 *   true  → legacy `_scanAndProcessNewRows` executes; new path runs dryRun=true
 *           and logs diff to `scanner_shadow_diff` sheet
 *   false → new path executes (Layer 3 with dryRun=false); legacy retained in
 *           source one sprint as rollback
 *
 * BUG FIXES landed in this file (per Inventory §7 authorization):
 *   #1 — CLASSIFYING added to STUCK_AUTO_RECOVER_STATUSES
 *   #6 — UID-keyed dedupe (AUTO_PROCESSED_LEAD_<uid>) with row-keyed fallback
 *        for legacy rows without UID
 *
 * BUGS preserved in legacy (per authorization):
 *   #3 — HUMANIZING / QUALITY_CHECK phantom write targets (defensive forward-compat)
 *   #4 — processResearchedLeads REVIEW dead path (Phase 6+ cleanup)
 *
 * BUGS fixed in legacy directly (this push, in BatchProcessor.gs):
 *   #2 — BATCH_SIZE || 5 dead fallback
 *   #5 — Loop A error path errRetry:0/2 init
 *
 * ============================================================
 */

// ─── CONSTANTS ──────────────────────────────────────────────────────────────

// Bug #1 FIX (per Inventory §7): CLASSIFYING added to the whitelist.
// Phantom-write protection: if a future patch ever writes STATUS=CLASSIFYING,
// auto-recover picks it up instead of silently orphaning the row.
//
// ── REGRESSION FIX `-eq2-scannerfix` (2026-06-09) ───────────────────────────
// PENDING_QUOTA_RESET and PENDING_GEMINI_BACKOFF were MISSING here after the
// scanner promotion (USE_LEGACY_SCANNER=false). The legacy isStuckAutoRecover
// (BatchProcessor.gs:2188/2194) HAD them — added by Phase 2b/2c (tasks #110,
// #130) — but the new Scanner whitelist was authored as a fresh copy that
// never carried them. Result: 119 leads (55% of the sheet) parked at
// PENDING_QUOTA_RESET by the L1 quota guard were SILENTLY STRANDED — every
// scan tick skipped them with kind=SKIP_FALL_THROUGH reason=no_whitelist_match,
// so they never produced drafts even after quota freed up.
//
// These two statuses are PARKED-BY-DESIGN states: the pipeline's own L1/L1.5
// guards set them when the daily Gmail draft quota or the Gemini backoff is
// active, expecting the NEXT scan tick to retry once the breaker clears. They
// MUST be in the auto-recover whitelist or the park becomes permanent.
//
// This list is now the SINGLE SOURCE OF TRUTH — _computeLegacyDecision (the
// parity-comparison port) references it directly (see below) so the two can
// never drift again. The drift is why the shadow parity check reported
// agree=218 diff=0: it was comparing two copies of the SAME buggy list, not
// against the real legacy function.
var STUCK_AUTO_RECOVER_STATUSES = [
  'NEEDS_EMAIL', 'NEEDS_EMAIL_REVIEW', 'NEEDS_REVIEW',
  'REVIEW', 'COMPOSING', 'CLASSIFYING',
  'HUMANIZING', 'QUALITY_CHECK', 'ERROR',
  // Parked-by-design states — must auto-recover when the breaker clears:
  'PENDING_QUOTA_RESET', 'PENDING_GEMINI_BACKOFF',
  // PATCH `-eq8-content-fix` (#2): DRAFT_FAILED gets BOUNDED retry via the
  // errRetry:N/M budget the whitelist already applies — after M attempts the
  // row stops being re-picked (visible terminal, not an infinite loop).
  'DRAFT_FAILED'
];

// Bug #6 FIX (per Inventory §7): UID-keyed dedupe key prefix.
// Replaces the old row-keyed `AUTO_PROCESSED_ROW_<n>` for rows with LEAD_UID.
// Falls back to row-keyed for legacy rows (UID empty until backfill completes).
var DEDUPE_KEY_PREFIX_UID = 'AUTO_PROCESSED_LEAD_';
var DEDUPE_KEY_PREFIX_ROW = 'AUTO_PROCESSED_ROW_';  // legacy fallback only

// Dedupe window (matches legacy semantics).
var DEDUPE_WINDOW_MS = 2 * 60 * 1000;

// ─── LAYER 1 — ADVISORY SCORERS ─────────────────────────────────────────────

/**
 * Score the "freshness" of a row — is it eligible to start a new processing run?
 * Inventory §3 row 1: status === '' OR status === STATUS.NEW
 * Pure function. No side effects.
 *
 * @param {Array} row — full row from sheet.getValues()
 * @param {Object} cols — CONFIG.COLUMNS
 * @returns {{eligible: boolean, reason: string}}
 */
function scoreFreshness(row, cols) {
  var status = (row[cols.STATUS - 1] || '').toString().trim();
  var eligible = (status === '' || status === 'NEW');
  return {
    eligible: eligible,
    reason: eligible ? 'fresh' : 'not_fresh_status_' + status
  };
}

/**
 * Score the "ReoonRetryReady" condition — REOON_RETRY_PENDING + retryAfter elapsed.
 * Inventory §3 row 2.
 * Pure function. No side effects.
 *
 * @param {Array} row
 * @param {Object} cols
 * @param {number} nowMs — current epoch ms (injectable for determinism)
 * @returns {{eligible: boolean, reason: string, debug?: object}}
 */
function scoreReoonRetryReady(row, cols, nowMs) {
  var status = (row[cols.STATUS - 1] || '').toString().trim();
  if (status !== 'REOON_RETRY_PENDING') {
    return { eligible: false, reason: 'not_reoon_retry' };
  }
  var notes = (row[cols.NOTES - 1] || '').toString();
  var m = notes.match(/retryAfter:(\d+)/);
  if (!m) {
    return { eligible: false, reason: 'reoon_retry_no_timestamp' };
  }
  var retryAtMs = parseInt(m[1], 10);
  var eligible = nowMs >= retryAtMs;
  return {
    eligible: eligible,
    reason: eligible ? 'reoon_retry_due' : 'reoon_retry_not_due_yet',
    debug: { retryAtMs: retryAtMs, nowMs: nowMs, deltaMs: retryAtMs - nowMs }
  };
}

/**
 * Score the "ResearchDoneReady" condition — status === RESEARCH_DONE.
 * Inventory §3 row 3. Pure function.
 */
function scoreResearchDoneReady(row, cols) {
  var status = (row[cols.STATUS - 1] || '').toString().trim();
  var eligible = (status === 'RESEARCH_DONE');
  return {
    eligible: eligible,
    reason: eligible ? 'research_done_ready' : 'not_research_done'
  };
}

/**
 * Score the "StuckAutoRecoverEligible" condition.
 * Inventory §3 row 4 + Bug #1 FIX (CLASSIFYING added).
 * status ∈ STUCK_AUTO_RECOVER_STATUSES AND errRetry:N/M with N<M (or no token yet)
 * Pure function.
 */
function scoreStuckAutoRecoverEligible(row, cols) {
  var status = (row[cols.STATUS - 1] || '').toString().trim();
  if (STUCK_AUTO_RECOVER_STATUSES.indexOf(status) < 0) {
    return { eligible: false, reason: 'not_stuck_status' };
  }
  var notes = (row[cols.NOTES - 1] || '').toString();
  var m = notes.match(/errRetry:(\d+)\/(\d+)/);
  if (!m) {
    return { eligible: true, reason: 'stuck_no_retry_token_yet' };  // pristine
  }
  var attempts = parseInt(m[1], 10);
  var max      = parseInt(m[2], 10);
  var eligible = attempts < max;
  return {
    eligible: eligible,
    reason: eligible ? 'stuck_retry_budget_available' : 'stuck_retry_budget_exhausted',
    debug: { attempts: attempts, max: max }
  };
}

/**
 * Score the "IdentityInputAvailable" gate.
 * Inventory §3 identity gate — preserved verbatim from legacy lines 1933-1936.
 * `hasUsableEmail || canGuessEmail || hasUrlPath`
 * Pure function.
 *
 * PATCH 2026-06-12-fresh-first (P0 defensive guard):
 * The `row` parameter MUST be a raw sheet values array (from sheet.getValues()).
 * If this function is accidentally called with a lead OBJECT (which has named
 * properties like .email, .linkedinUrl, .fullName instead of numeric indices),
 * every field reads undefined → scores false → SKIP_NO_IDENTITY for all rows.
 * This bug surfaced after the 2026-06-12-errretry-preserve patch which changed
 * how the lead object is constructed. Guard: detect object-shaped input and
 * remap it to the expected array shape. Log a clear error for diagnosis.
 */
function scoreIdentityInputAvailable(row, cols) {
  // ── P0 DEFENSIVE GUARD: detect lead-object vs row-array shape ──
  // A row array has numeric indices; a lead object has named string keys.
  // If row.email is defined (named property), we received a lead object instead
  // of a raw row array. Remap it to array-indexed access using cols values.
  if (row && typeof row === 'object' && !Array.isArray(row) && typeof row.email !== 'undefined') {
    Logger.log('[Scanner.scoreIdentityInputAvailable] P0 GUARD: received lead object instead of ' +
               'raw row array — remapping. Caller must pass sheet.getValues() row. ' +
               'This prevents SKIP_NO_IDENTITY for all rows. File: Scanner.gs');
    // Build a sparse array from the lead object's named fields
    var remappedRow = [];
    remappedRow[cols.EMAIL - 1]        = row.email || '';
    remappedRow[cols.FULL_NAME - 1]    = row.fullName || '';
    remappedRow[cols.ORGANIZATION - 1] = row.organization || '';
    remappedRow[cols.LINKEDIN_URL - 1] = row.linkedinUrl || '';
    if (cols.ENRICHED_EMAIL) remappedRow[cols.ENRICHED_EMAIL - 1] = row.enrichedEmail || '';
    row = remappedRow;
  }

  var email         = (row[cols.EMAIL - 1] || '').toString().trim();
  var firstName     = '';  // derived from FULL_NAME if needed by canGuessEmail
  var fullName      = (row[cols.FULL_NAME - 1] || '').toString().trim();
  var org           = (row[cols.ORGANIZATION - 1] || '').toString().trim();
  var url           = (row[cols.LINKEDIN_URL - 1] || '').toString().trim();
  // ── P0 FIX 2026-06-12-fresh-first: also check ENRICHED_EMAIL (col 24) ──
  // Sheet2 rows populated via UNIQUE(Sheet1) often have no email in col F (legacy
  // APK builds did not always export email). The enrichment pipeline writes the
  // resolved/verified email to ENRICHED_EMAIL. A row with ENRICHED_EMAIL set is
  // fully identifiable and processable — it must NOT score identity_unavailable.
  // Root cause confirmed: 43 NEW rows (REQUEUE_BUILDERBLOCK cohort) had valid
  // enrichedEmail but empty col F, causing all to SKIP_NO_IDENTITY.
  var enrichedEmail = (cols.ENRICHED_EMAIL && row[cols.ENRICHED_EMAIL - 1])
                      ? (row[cols.ENRICHED_EMAIL - 1] || '').toString().trim()
                      : '';

  if (fullName) {
    var fn = fullName.split(/\s+/)[0];
    if (/^[A-Za-zÀ-ſ][A-Za-zÀ-ſ'.\-]{1,}$/.test(fn)) firstName = fn;
  }

  var hasUsableEmail  = !!(email && email.indexOf('@') > 0);
  var hasEnrichedEmail = !!(enrichedEmail && enrichedEmail.indexOf('@') > 0);
  var canGuessEmail   = !!(firstName && org);
  var hasUrlPath      = !!(url && /\/in\/[^/?#]+/i.test(url));

  var eligible = hasUsableEmail || hasEnrichedEmail || canGuessEmail || hasUrlPath;
  var identityKind = hasUsableEmail    ? 'email'
                   : hasEnrichedEmail  ? 'enriched_email'
                   : canGuessEmail     ? 'guessable'
                   : 'url_only';
  return {
    eligible: eligible,
    reason: eligible ? ('identity_available_' + identityKind) : 'identity_unavailable',
    debug: {
      hasUsableEmail:   hasUsableEmail,
      hasEnrichedEmail: hasEnrichedEmail,
      canGuessEmail:    canGuessEmail,
      hasUrlPath:       hasUrlPath
    }
  };
}

// ─── DUPLICATE LEAD GUARD (PATCH 2026-06-12-dup-lead-guard) ────────────────
//
// ROOT CAUSE: Sheet2 = UNIQUE(Sheet1!B2:G). The APK/capture dedupe only
// suppresses same-URL captures within a 5-minute window. Re-scans on later
// days, or captures where ANY of cols B..G differ (headline/designation drift),
// produce ADDITIONAL Sheet2 rows for the SAME person. Each row drafts
// independently: user deletes draft for row N → that row correctly parks
// DRAFT_DELETED → sibling row M composes a fresh draft → looks like
// resurrection. This guard prevents sibling rows from drafting when a
// human-decided state already exists for that email/URL.
//
// HUMAN-DECIDED states: statuses where the user (or a deterministic pipeline
// outcome) has made a final decision. Dispatching a sibling on top of these
// silently overrides user intent.
var HUMAN_DECIDED_STATUSES = {
  'DRAFT_DELETED': true,
  'DRAFT_ABANDONED': true,
  'SENT': true,
  'BOUNCED_HARD': true,
  'BOUNCED_SOFT': true,
  'DRAFT_CREATED': true
};

/**
 * Pure helper: scan all data rows once (O(n) single-pass map build) to find
 * the canonical row for a given email or linkedin URL.
 *
 * CANONICAL ROW = the row carrying a HUMAN_DECIDED state for that identity.
 * If multiple human-decided rows exist (e.g., two siblings both ended up
 * DRAFT_DELETED), the one with the lowest rowNum is canonical.
 * If no human-decided row exists, returns null (no duplicate constraint).
 *
 * EMAIL NORMALIZATION: lower-cased ENRICHED_EMAIL (col 24) first, fallback
 * EMAIL (col 6). Both are checked against the candidate's normalized email.
 * LinkedIn URL is also checked: /in/<slug> extracted and matched case-insensitively.
 *
 * @param {Array}  data     — array of row arrays from sheet.getValues() (0-indexed)
 * @param {Object} cols     — CONFIG.COLUMNS
 * @param {number} candidateRowNum — the row number of the candidate (1-indexed, header=1, data starts 2)
 * @param {string} candidateEmail  — normalized (lowercased) email of candidate (may be empty)
 * @param {string} candidateUrl    — full linkedin URL of candidate (may be empty)
 * @returns {{ canonicalRowNum: number, canonicalStatus: string } | null}
 */
function _findCanonicalLeadRow(data, cols, candidateRowNum, candidateEmail, candidateUrl) {
  if (!data || data.length === 0) return null;

  // Extract /in/<slug> from URL for normalized comparison
  var candidateSlug = '';
  if (candidateUrl) {
    var slugM = candidateUrl.match(/\/in\/([^/?#]+)/i);
    if (slugM) candidateSlug = slugM[1].toLowerCase();
  }

  // Build identity map in a SINGLE PASS: identity_key → { rowNum, status }
  // We collect ALL human-decided rows first, then check if the candidate's
  // identity matches any of them.
  var humanDecidedByEmail = {};  // normalized_email → { rowNum, status }
  var humanDecidedBySlug  = {};  // linkedin_slug    → { rowNum, status }

  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    var rowNum = i + 2;  // header is row 1, data starts at row 2
    if (rowNum === candidateRowNum) continue;  // skip self

    var status = (row[cols.STATUS - 1] || '').toString().trim();
    if (!HUMAN_DECIDED_STATUSES[status]) continue;

    // Normalize email: ENRICHED_EMAIL preferred, fallback EMAIL
    var enriched = (cols.ENRICHED_EMAIL && row[cols.ENRICHED_EMAIL - 1])
                   ? (row[cols.ENRICHED_EMAIL - 1] || '').toString().trim().toLowerCase()
                   : '';
    var rawEmail = (row[cols.EMAIL - 1] || '').toString().trim().toLowerCase();
    var normEmail = (enriched && enriched.indexOf('@') > 0) ? enriched
                  : (rawEmail && rawEmail.indexOf('@') > 0)  ? rawEmail
                  : '';

    if (normEmail) {
      if (!humanDecidedByEmail[normEmail] || humanDecidedByEmail[normEmail].rowNum > rowNum) {
        humanDecidedByEmail[normEmail] = { rowNum: rowNum, status: status };
      }
    }

    // Normalize LinkedIn URL → slug
    var urlRaw = (row[cols.LINKEDIN_URL - 1] || '').toString().trim();
    if (urlRaw) {
      var m = urlRaw.match(/\/in\/([^/?#]+)/i);
      if (m) {
        var slug = m[1].toLowerCase();
        if (!humanDecidedBySlug[slug] || humanDecidedBySlug[slug].rowNum > rowNum) {
          humanDecidedBySlug[slug] = { rowNum: rowNum, status: status };
        }
      }
    }
  }

  // Check candidate against the map
  if (candidateEmail && candidateEmail.indexOf('@') > 0) {
    var emailMatch = humanDecidedByEmail[candidateEmail.toLowerCase()];
    if (emailMatch) return { canonicalRowNum: emailMatch.rowNum, canonicalStatus: emailMatch.status };
  }
  if (candidateSlug) {
    var slugMatch = humanDecidedBySlug[candidateSlug];
    if (slugMatch) return { canonicalRowNum: slugMatch.rowNum, canonicalStatus: slugMatch.status };
  }

  return null;
}

// ─── LAYER 2 — DISPATCHER ───────────────────────────────────────────────────

/**
 * Combine the 5 advisory signals into a single dispatch decision.
 * Inventory §3 precedence — identity gate first, then 4-way OR.
 * No side effects.
 *
 * NOTE: the duplicate-lead guard is applied ABOVE combineSignals in
 * scoreRowForDispatch (which has access to the full data array). combineSignals
 * itself remains a pure signal combiner with no sheet access.
 *
 * @param {Object} signals — { freshness, reoonRetry, researchDone, stuck, identity }
 * @returns {{dispatch: boolean, kind: string, reason: string, signals: object}}
 */
function combineSignals(signals) {
  // Gate 0: identity input must be available
  if (!signals.identity.eligible) {
    return {
      dispatch: false,
      kind: 'SKIP_NO_IDENTITY',
      reason: signals.identity.reason,
      signals: signals
    };
  }

  // OR-group: any of 4 dispatch signals
  if (signals.freshness.eligible) {
    return {
      dispatch: true,
      kind: 'DISPATCH',
      reason: 'freshness:' + signals.freshness.reason,
      signals: signals
    };
  }
  if (signals.reoonRetry.eligible) {
    return {
      dispatch: true,
      kind: 'DISPATCH',
      reason: 'reoon_retry:' + signals.reoonRetry.reason,
      signals: signals
    };
  }
  if (signals.researchDone.eligible) {
    return {
      dispatch: true,
      kind: 'DISPATCH',
      reason: 'research_done:' + signals.researchDone.reason,
      signals: signals
    };
  }
  if (signals.stuck.eligible) {
    return {
      dispatch: true,
      kind: 'DISPATCH',
      reason: 'stuck_auto_recover:' + signals.stuck.reason,
      signals: signals
    };
  }

  // Fall-through: silent skip preserves Inventory §4 semantic
  return {
    dispatch: false,
    kind: 'SKIP_FALL_THROUGH',
    reason: 'no_whitelist_match',
    signals: signals
  };
}

// ─── M3: LEAD AGE GATE ────────────────────────────────────────────────────────
//
// PATCH 2026-06-12-fresh-first: leads whose capture/created age exceeds
// CONFIG.LEAD_MAX_AGE_DAYS (default 10) are NOT auto-dispatched. They remain
// untouched for manual handling (no status written to them).
//
// CAPTURE DATE RESOLUTION POLICY (stated here for auditability):
//   Sheet2 has NO direct capture-timestamp column (the UNIQUE formula spills
//   cols B-G from Sheet1 but not col A=timestamp). LEAD_UID (col 28) is a random
//   UUID (no embedded timestamp). Therefore:
//     - MISSING capture date → treated as ELIGIBLE (legacy rows without timestamp).
//       This is the conservative choice: don't punish rows we can't date.
//     - Row number DESC is used as a recency PROXY for ordering (higher row# =
//       more recently appended by the UNIQUE formula). This is correct under the
//       assumption that Sheet2 is append-only (which it is: rows are never
//       reordered, only new rows are added by UNIQUE spill).
//   If a future patch adds a CAPTURED_AT column to Sheet2, replace the row-number
//   proxy with a date comparison in _leadWithinAgeWindow.

/**
 * Pure helper: true if the lead's capture date (from LAST_UPDATED or rowNum proxy)
 * is within LEAD_MAX_AGE_DAYS of nowMs.
 *
 * MISSING DATE POLICY: if no date is resolvable, returns true (eligible).
 * Legacy rows without a LAST_UPDATED timestamp are treated as eligible so they
 * are not silently stranded.
 *
 * @param {Array}  row    — raw sheet row array (from sheet.getValues())
 * @param {Object} cols   — CONFIG.COLUMNS
 * @param {number} nowMs  — current epoch ms
 * @param {number} [maxAgeDays] — override; defaults to CONFIG.LEAD_MAX_AGE_DAYS
 * @returns {boolean}
 */
function _leadWithinAgeWindow(row, cols, nowMs, maxAgeDays) {
  var maxDays = (typeof maxAgeDays === 'number') ? maxAgeDays
              : ((typeof CONFIG !== 'undefined' && CONFIG.LEAD_MAX_AGE_DAYS) ? CONFIG.LEAD_MAX_AGE_DAYS : 10);
  var maxMs = maxDays * 24 * 60 * 60 * 1000;

  // Sheet2 has no dedicated capture-ts column. Use LAST_UPDATED (col 21) if present
  // and non-empty; otherwise treat as eligible (missing-date policy).
  var lastUpdatedRaw = row[cols.LAST_UPDATED - 1];
  if (!lastUpdatedRaw) {
    // Missing capture date — policy: eligible (legacy row).
    return true;
  }
  var captureMs = 0;
  try {
    captureMs = (lastUpdatedRaw instanceof Date)
      ? lastUpdatedRaw.getTime()
      : new Date(lastUpdatedRaw.toString()).getTime();
  } catch (_) {}
  if (!captureMs || isNaN(captureMs)) {
    // Unparseable date — policy: eligible.
    return true;
  }
  return (nowMs - captureMs) <= maxMs;
}

/**
 * Compute a dispatch decision for a single row. Pure function over inputs
 * (row, cols, nowMs). Use this to compute decisions for both shadow comparison
 * AND for real execution in `executeDispatch`.
 *
 * PATCH 2026-06-12-fresh-first: applies the 10-day age gate BEFORE identity
 * scoring. Stale leads (over LEAD_MAX_AGE_DAYS) are skipped with
 * SKIP_STALE_LEAD:over_10d and are NOT written to (no status update).
 *
 * PATCH 2026-06-12-dup-lead-guard: applies lead-level uniqueness guard.
 * If another row for the same email/URL is already in a HUMAN_DECIDED state
 * (DRAFT_DELETED, DRAFT_ABANDONED, SENT, BOUNCED_*, DRAFT_CREATED), this row
 * is skipped with SKIP_DUPLICATE_LEAD:row_<N>. The canonical row (the one
 * carrying the human decision) is returned as part of the reason.
 *
 * @param {Array}  row       — raw sheet row array (from sheet.getValues())
 * @param {Object} cols      — CONFIG.COLUMNS
 * @param {number} nowMs     — current epoch ms
 * @param {number} [rowNum]  — 1-indexed row number of this row (needed for dup guard)
 * @param {Array}  [allData] — full data array (needed for dup guard; omit to skip guard)
 */
function scoreRowForDispatch(row, cols, nowMs, rowNum, allData) {
  // ── M3: 10-day age gate (applied before identity to avoid false SKIP_NO_IDENTITY) ──
  if (!_leadWithinAgeWindow(row, cols, nowMs)) {
    return {
      dispatch: false,
      kind: 'SKIP_STALE_LEAD',
      reason: 'over_' + ((typeof CONFIG !== 'undefined' && CONFIG.LEAD_MAX_AGE_DAYS) || 10) + 'd'
    };
  }

  // ── PATCH 2026-06-12-dup-lead-guard: lead-level uniqueness guard ──
  // Applied BEFORE identity scoring so duplicate rows get the right kind
  // (SKIP_DUPLICATE_LEAD) rather than falling through to SKIP_NO_IDENTITY.
  // Only applied when allData is provided (production path via scanAndDispatch).
  // Omitting allData (legacy shadow path + direct unit tests) disables the guard.
  if (allData && rowNum) {
    var enriched = (cols.ENRICHED_EMAIL && row[cols.ENRICHED_EMAIL - 1])
                   ? (row[cols.ENRICHED_EMAIL - 1] || '').toString().trim().toLowerCase()
                   : '';
    var rawEmail = (row[cols.EMAIL - 1] || '').toString().trim().toLowerCase();
    var normEmail = (enriched && enriched.indexOf('@') > 0) ? enriched
                  : (rawEmail && rawEmail.indexOf('@') > 0)  ? rawEmail
                  : '';
    var candidateUrl = (row[cols.LINKEDIN_URL - 1] || '').toString().trim();
    var canonical = _findCanonicalLeadRow(allData, cols, rowNum, normEmail, candidateUrl);
    if (canonical) {
      return {
        dispatch: false,
        kind: 'SKIP_DUPLICATE_LEAD',
        reason: 'row_' + canonical.canonicalRowNum + ':' + canonical.canonicalStatus
      };
    }
  }

  var signals = {
    freshness:    scoreFreshness(row, cols),
    reoonRetry:   scoreReoonRetryReady(row, cols, nowMs),
    researchDone: scoreResearchDoneReady(row, cols),
    stuck:        scoreStuckAutoRecoverEligible(row, cols),
    identity:     scoreIdentityInputAvailable(row, cols)
  };
  return combineSignals(signals);
}

// ─── LAYER 3 — EXECUTOR (gated by dryRun) ───────────────────────────────────

/**
 * Execute the dispatch decision for a row. Gated by `opts.dryRun`.
 *
 * CRITICAL — SHADOW MODE SAFETY CONTRACT (per `14_scanner_refactor_design.md` §4):
 *   The `opts.dryRun` short-circuit MUST be the FIRST conditional in this
 *   function body. If a side-effect call lands above this check, double-
 *   execution occurs: Gmail drafts created twice, vendor APIs called twice,
 *   quota burned twice. The parity test `scanner_parity_new_path_dryRun_short_circuit_is_FIRST_check`
 *   verifies this by source introspection.
 *
 * @param {Object} lead — sheet-truth lead object (full LeadProfile fields plus
 *                        the scan-time fields; built by the dispatch-lead builder)
 * @param {Object} decision — output of combineSignals(...)
 * @param {Object} opts — {dryRun: boolean, legacyDecision?: object, source: string}
 * @returns {Object} — execution result
 */
function executeDispatch(lead, decision, opts) {
  opts = opts || {};

  // ── CRITICAL: dryRun short-circuit BEFORE any side effect ──
  // Phase 5.2a shadow-mode safety. If this check moves below ANY side-effect call,
  // shadow mode becomes unsafe. Locked by parity test.
  if (opts.dryRun) {
    try { _logShadowDiff(lead, decision, opts.legacyDecision, opts.source); } catch (_) {}
    return { ok: true, mode: 'shadow_dryrun', decision: decision };
  }

  // ── BELOW THIS LINE: REAL EXECUTION (only reached when dryRun=false) ──

  if (!decision.dispatch) {
    return { ok: true, mode: 'skip', decision: decision };
  }

  // Acquire lock (Inventory §5 — script-wide LockService)
  var lockService = (typeof _svc === 'function') ? _svc('Lock') : LockService;
  var lock = lockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) {
    return { ok: false, mode: 'lock_busy', decision: decision };
  }

  var result;
  try {
    // Bug #6 FIX: UID-keyed dedupe (falls back to row-keyed for legacy rows)
    var props = (typeof _svc === 'function') ? _svc('Properties') : PropertiesService.getScriptProperties();
    var dedupeKey = (lead.leadUid)
      ? (DEDUPE_KEY_PREFIX_UID + lead.leadUid)
      : (DEDUPE_KEY_PREFIX_ROW + lead.rowNum);
    var lastDispatchedAt = parseInt(props.getProperty(dedupeKey) || '0', 10);
    if (Date.now() - lastDispatchedAt < DEDUPE_WINDOW_MS) {
      result = { ok: true, mode: 'dedupe_skip', decision: decision, dedupeKey: dedupeKey };
    } else {
      props.setProperty(dedupeKey, Date.now().toString());

      // Force-write STATUS=NEW (Inventory §3 destroys-and-restarts semantic)
      try {
        updateLeadFields(lead.rowNum, { STATUS: 'NEW' },
          lead.linkedinUrl ? { verifyUrl: lead.linkedinUrl, verifyUid: lead.leadUid } : undefined);
      } catch (writeErr) {
        Logger.log('[Scanner.executeDispatch] force-NEW write failed: ' + writeErr.message);
      }

      // Diagnostic: stamp the composite lock key
      try {
        props.setProperty('_ACTIVE_LEAD_LOCK_KEY',
          'row:' + lead.rowNum + ':uid:' + (lead.leadUid || 'NONE'));
      } catch (_) {}

      // Invoke the per-lead processor (same callee as legacy)
      try {
        _processOneLead(lead);
        result = { ok: true, mode: 'dispatched', decision: decision };
      } catch (procErr) {
        // Bounded retry via errRetry:N/M (matches legacy semantics; Inventory §9.2)
        _bumpErrRetryOnError(lead, procErr);
        result = { ok: false, mode: 'error_retry', decision: decision, error: procErr.message };
      }
    }
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }

  return result;
}

// ─── DISPATCH LEAD CONSTRUCTION (sheet-truth) ───────────────────────────────
//
// PATCH 2026-06-12-dispatch-truth. PURE helper — builds the lead handed to the
// executor from the full in-memory row snapshot, so every sheet column (col-F
// email, organization, designation, headline, parsed name parts, ...) rides
// along at dispatch time instead of arriving undefined. The merge rule mirrors
// the executor-side hydration guard exactly: the scan-time keys rowNum,
// linkedinUrl, leadUid and notes keep their scan-time values when non-empty
// (the errRetry token in notes among them — see the errretry-preserve patch),
// while every other key — fullName included — takes the parsed profile's
// value (junk names are cleared by the parser for safe greeting fallback,
// which is exactly what the executor-side hydration produced before this
// patch). When the parser yields nothing (rows with no name and no email)
// the scan-time fields pass through unchanged — the legacy minimal shape —
// and the executor-side hydration guard remains as defense-in-depth.

/**
 * @param {Array}  row        — in-memory row snapshot (scan-time, full width)
 * @param {number} rowNum     — 1-indexed sheet row number
 * @param {Object} scanFields — scan-time fields {rowNum, linkedinUrl, leadUid,
 *                              fullName, notes}; preserve rule applies on merge
 * @returns {Object} lead object for the executor
 */
function _dispatchLeadFromRow(row, rowNum, scanFields) {
  var profile = null;
  try {
    profile = _rowToLeadProfile(row, rowNum);
  } catch (_) {
    profile = null;
  }
  var lead = {};
  var k;
  for (k in scanFields) lead[k] = scanFields[k];
  if (!profile) return lead;
  var preserve = { rowNum: 1, linkedinUrl: 1, leadUid: 1, notes: 1 };
  for (k in profile) {
    if (!preserve[k] || !lead[k]) lead[k] = profile[k];
  }
  return lead;
}

// ─── ENTRY POINT — scanAndDispatch ──────────────────────────────────────────

/**
 * Public entry point. Reads the data sheet, computes a dispatch decision per row
 * via the 3 layers, and (if dryRun=false) executes the decision.
 *
 * Same caller-compatibility signature as legacy `_scanAndProcessNewRows`:
 * called by `processNextBatch` (Loop A wrapper), `autoProcessSafetyNet`,
 * `onSheetChange`, `_kickoffAfterCapture`.
 *
 * @param {Object} opts — {source: string, dryRun?: boolean, legacyDecisionsByRow?: object}
 * @returns {Object} — {scanned: N, dispatched: N, skipped: N, errors: N, dryRun: bool}
 */
function scanAndDispatch(opts) {
  opts = opts || {};
  var source = opts.source || 'unknown';
  var dryRun = !!opts.dryRun;

  // ── PATCH `-p5-scannerrefactor-promote-amend2` (observability) ──
  // HEARTBEAT: increment SHADOW_SCAN_COUNT on EVERY invocation, regardless of
  // outcome. Distinguishes "never ran" (counter stays 0) from "ran and agreed"
  // (counter increments, sheet may stay header-only). The prior amend's empty
  // tab was ambiguous; this counter resolves it.
  var hbCount = 0;
  try {
    var hbProps = (typeof _svc === 'function') ? _svc('Properties') : PropertiesService.getScriptProperties();
    hbCount = parseInt(hbProps.getProperty('SHADOW_SCAN_COUNT') || '0', 10) + 1;
    hbProps.setProperty('SHADOW_SCAN_COUNT', String(hbCount));
    hbProps.setProperty('SHADOW_LAST_RAN_AT', new Date().toISOString());
    hbProps.setProperty('SHADOW_LAST_SOURCE', source);
  } catch (_) {}

  // ── PATCH `-p5-scannerrefactor-promote-amend3` (Phase 1d budget guard) ──
  // If the legacy scan ran close to the 360s GAS hard limit, the shadow
  // compare can hit "Service Spreadsheets timed out" at the tail. Skip the
  // compare if < 30s of budget remains; set SHADOW_SKIPPED_BUDGET so the
  // skip is observable, not silent. Heartbeat (above) already incremented.
  if (opts.legacyStartTime) {
    var elapsedSec = (Date.now() - opts.legacyStartTime) / 1000;
    var remainingSec = 360 - elapsedSec;
    if (remainingSec < 30) {
      try {
        var bp = (typeof _svc === 'function') ? _svc('Properties') : PropertiesService.getScriptProperties();
        var skipCount = parseInt(bp.getProperty('SHADOW_SKIPPED_BUDGET') || '0', 10) + 1;
        bp.setProperty('SHADOW_SKIPPED_BUDGET', String(skipCount));
        bp.setProperty('SHADOW_SKIPPED_LAST_AT', new Date().toISOString());
      } catch (_) {}
      Logger.log('[Scanner.scanAndDispatch] BUDGET SKIP - ' +
                 elapsedSec.toFixed(1) + 's of 360s elapsed; ' +
                 remainingSec.toFixed(1) + 's remaining < 30s threshold. ' +
                 'Heartbeat=' + hbCount + ' SHADOW_SKIPPED_BUDGET incremented.');
      return {
        scanned: 0, dispatched: 0, skipped: 0, errors: 0,
        rowsCompared: 0, agreeRows: 0, diffRows: 0,
        dryRun: dryRun, heartbeat: hbCount,
        skippedReason: 'budget_low'
      };
    }
  }

  var sheetsApp = (typeof _svc === 'function') ? _svc('Sheets') : SpreadsheetApp;
  var ss = sheetsApp.openById(CONFIG.SHEET_ID);

  // EAGER TAB: create scanner_shadow_diff with header on EVERY invocation.
  // Was lazy (only on first divergence) → absent tab couldn't distinguish
  // "never ran" from "ran and agreed." `_ensureShadowDiffSheet` is idempotent.
  try { _ensureShadowDiffSheet(ss); } catch (_) {}

  // ── PATCH amend3 (Phase 1c): reuse legacy's pre-fetched row data when ──
  // available. Avoids second full-sheet read at tail of long runs (root
  // cause of "Service Spreadsheets timed out" in prior amend logs).
  var data = opts.legacyRowData;
  var dataSource = 'opts.legacyRowData';
  if (!data) {
    dataSource = 'self_read_fallback';
    var sheet = ss.getSheetByName(CONFIG.DATA_SHEET);
    if (!sheet) {
      Logger.log('[Scanner.scanAndDispatch] data sheet not found; skip');
      return { scanned: 0, dispatched: 0, skipped: 0, errors: 0, dryRun: dryRun, heartbeat: hbCount };
    }
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) {
      return { scanned: 0, dispatched: 0, skipped: 0, errors: 0, dryRun: dryRun, heartbeat: hbCount };
    }
    data = sheet.getRange(2, 1, lastRow - 1, CONFIG.SHEET_COL_COUNT).getValues();
  }
  if (!data || data.length === 0) {
    return { scanned: 0, dispatched: 0, skipped: 0, errors: 0, dryRun: dryRun, heartbeat: hbCount };
  }
  var cols = CONFIG.COLUMNS;
  var nowMs = Date.now();

  var counters = {
    scanned: 0, dispatched: 0, skipped: 0, errors: 0,
    rowsCompared: 0, agreeRows: 0, diffRows: 0,
    dryRun: dryRun, heartbeat: hbCount
  };

  // Bug #2 FIX: use CONFIG.BATCH_SIZE directly (no `|| 5` fallback)
  // PATCH `-eq2-drain`: dedicated scanner cap (falls back to BATCH_SIZE if unset).
  // Decoupled from BATCH_SIZE so draining the parked backlog faster does NOT also
  // accelerate processResearchedLeads / processNextBatch (which share BATCH_SIZE).
  var maxDispatches = CONFIG.SCANNER_DISPATCH_MAX || CONFIG.BATCH_SIZE;
  var dispatchCount = 0;

  // PATCH 2026-06-13-transient-draft: per-run draft-rate cap.
  // Gmail's short-window rate limit (~100-second window) fires when a burst of
  // createDraft calls are issued in rapid succession. This counter tracks
  // _processOneLead calls dispatched this run; once it reaches
  // SCANNER_MAX_DRAFTS_PER_RUN the loop stops dispatching further draft-bound
  // leads (they remain eligible and are picked up on the next 5-min tick).
  // Non-draft work (research/classify only) isn't present here — every
  // _processOneLead call can createDraft, so the cap is on total dispatches.
  // This spreads createDraft calls over time, preventing a single-tick burst
  // from re-tripping the short-window cap and causing flag flapping.
  var maxDraftsPerRun = CONFIG.SCANNER_MAX_DRAFTS_PER_RUN || 6;
  var draftDispatchCount = 0;

  // PATCH `-eq2-drain`: dispatch time-budget. Each dispatch runs the FULL
  // per-lead pipeline (_processOneLead) synchronously, ~100s each. With a high
  // cap, back-to-back dispatches could blow past the GAS 6-min hard kill and
  // strand a row mid-compose. This guard stops STARTING new dispatches once the
  // loop has burned the budget, letting the in-flight lead finish cleanly.
  // Remaining eligible rows defer to the next 2-min cron tick.
  var dispatchLoopStartMs = Date.now();
  var dispatchBudgetMs = CONFIG.SCANNER_DISPATCH_BUDGET_MS || CONFIG.MAX_RUNTIME_MS || 240000;
  var budgetExhausted = false;

  // PATCH 2026-06-12-fresh-first (M3): FRESH-FIRST ordering.
  // Iterate rows in REVERSE (highest row number first = newest lead first).
  // Rationale: Sheet2 is append-only; the UNIQUE formula appends new leads at
  // the bottom. Row number DESC is the only reliable recency proxy (no capture
  // timestamp column in Sheet2). Older rows are not skipped here — they are
  // visited last and still dispatched (unless the 10-day gate fires). The gate
  // in scoreRowForDispatch (SKIP_STALE_LEAD) handles the actual cutoff.
  for (var i = data.length - 1; i >= 0; i--) {
    counters.scanned++;
    var row = data[i];
    var rowNum = i + 2;

    // Compute NEW path decision via the 3 layers
    // PATCH 2026-06-12-dup-lead-guard: pass rowNum + allData so the duplicate
    // guard can do the single-pass canonical-row scan. Legacy decision port
    // (_computeLegacyDecision) does NOT get the guard — it is a parity replica
    // of the old code and must not change semantics.
    var newDecision = scoreRowForDispatch(row, cols, nowMs, rowNum, data);

    // Compute LEGACY-EQUIVALENT decision via a separate code path (port of
    // _scanAndProcessNewRows IF-chain). Distinct from scoreRowForDispatch so
    // bugs in the new scorers DO produce diffs we can catch (not comparing
    // scoreRowForDispatch to itself).
    var legacyDecision = _computeLegacyDecision(row, cols, nowMs);

    // ── Always-on per-row comparison (observability) ──
    counters.rowsCompared++;
    var agree = (newDecision.kind === legacyDecision.kind);
    if (agree) {
      counters.agreeRows++;
    } else {
      counters.diffRows++;
      // Log diff row to sheet (eager-created tab from above) — diff='Y'
      try { _logShadowDiff(
        {
          rowNum: rowNum,
          leadUid: (row[cols.LEAD_UID - 1] || '').toString(),
          status:  (row[cols.STATUS - 1] || '').toString()
        },
        newDecision,
        legacyDecision,
        source
      ); } catch (_) {}
    }

    if (!newDecision.dispatch) {
      counters.skipped++;
      // PATCH 2026-06-12-dup-lead-guard: persist DUPLICATE status so this row
      // never scores for dispatch again. The write is idempotent — if the row
      // already has STATUS='DUPLICATE' the sheet write is a no-op in effect.
      // dryRun mode suppresses all side effects per the shadow-mode contract.
      if (!dryRun && newDecision.kind === 'SKIP_DUPLICATE_LEAD') {
        try {
          var sheetsApp2 = (typeof _svc === 'function') ? _svc('Sheets') : SpreadsheetApp;
          var ss2 = sheetsApp2.openById(CONFIG.SHEET_ID);
          var sheet2 = ss2.getSheetByName(CONFIG.DATA_SHEET);
          if (sheet2) {
            var canonInfo = newDecision.reason || '';
            var existingNotes = (sheet2.getRange(rowNum, cols.NOTES).getValue() || '').toString();
            var dupNote = '[DUPLICATE_LEAD] canonical ' + canonInfo +
                          '; user decision honored. ' + new Date().toISOString();
            var newNotes = (existingNotes + ' | ' + dupNote).substring(0, 1900);
            sheet2.getRange(rowNum, cols.STATUS).setValue('DUPLICATE');
            sheet2.getRange(rowNum, cols.NOTES).setValue(newNotes);
            sheet2.getRange(rowNum, cols.LAST_UPDATED).setValue(new Date().toISOString());
          }
        } catch (dupWriteErr) {
          Logger.log('[Scanner.scanAndDispatch] dup-lead status write failed row ' +
                     rowNum + ': ' + dupWriteErr.message);
        }
        if (typeof counters.duplicates === 'number') {
          counters.duplicates++;
        } else {
          counters.duplicates = 1;
        }
      }
      continue;
    }

    // Cap dispatch count
    if (dispatchCount >= maxDispatches) {
      counters.skipped++;
      continue;
    }

    // PATCH 2026-06-13-transient-draft: draft-rate cap.
    // Stop dispatching once this run has dispatched SCANNER_MAX_DRAFTS_PER_RUN leads.
    // Each _processOneLead can createDraft; capping total dispatches per run spreads
    // createDraft calls across 5-min ticks so a single burst can't re-trip Gmail's
    // short-window rate limit. Remaining eligible leads process on the next tick.
    if (draftDispatchCount >= maxDraftsPerRun) {
      counters.skipped++;
      // Log once at the boundary, not for every subsequent skipped row
      if (draftDispatchCount === maxDraftsPerRun) {
        Logger.log('[Scanner] draft-rate cap ' + maxDraftsPerRun + ' reached — remaining leads next tick');
        // Use a sentinel larger than cap to suppress duplicate logs
        draftDispatchCount = maxDraftsPerRun + 1;
      }
      continue;
    }

    // PATCH `-eq2-drain`: time-budget guard. Stop STARTING new full-pipeline
    // dispatches once within ~2 min of the GAS 6-min kill, so the in-flight
    // lead finishes cleanly instead of dying mid-compose (which strands the
    // row). Comparison/observability for remaining rows continues; the
    // remaining eligible rows are picked up on the next cron tick.
    if (!budgetExhausted && (Date.now() - dispatchLoopStartMs) > dispatchBudgetMs) {
      budgetExhausted = true;
      Logger.log('[Scanner.scanAndDispatch] DISPATCH BUDGET reached after ' +
                 Math.round((Date.now() - dispatchLoopStartMs) / 1000) + 's (> ' +
                 Math.round(dispatchBudgetMs / 1000) + 's). Dispatched ' + dispatchCount +
                 ' this tick; deferring remaining eligible rows to next cron tick.');
    }
    if (budgetExhausted) {
      counters.skipped++;
      continue;
    }

    // Build the dispatch lead for the executor.
    // PATCH 2026-06-12-dispatch-truth: the executor used to receive ONLY the
    // five scan-time fields below — every other sheet column arrived
    // undefined, starving the downstream truth gates until the executor-side
    // hydration guard re-read the row per lead. The lead is now the FULL
    // profile parsed from this same in-memory row snapshot (no per-lead
    // sheet read), with the scan-time fields overlaid per the executor's
    // own preserve rule so their effective values are unchanged. The
    // executor-side hydration guard stays as defense-in-depth and no-ops
    // on this path.
    // PATCH 2026-06-12-errretry-preserve: carry scan-time NOTES on the lead.
    // The failure writes in BatchProcessor.gs compose NOTES wholesale and now
    // preserve an existing errRetry:N/M token via lead.notes — without this
    // field the scanner-dispatched path read undefined and reseeded 0/2 every
    // failing cycle, so the bounded budget plateaued at 1/2 forever. This is
    // the same row snapshot scoreStuckAutoRecoverEligible just gated on.
    var scanFields = {
      rowNum: rowNum,
      linkedinUrl: (row[cols.LINKEDIN_URL - 1] || '').toString().trim(),
      leadUid:     (row[cols.LEAD_UID - 1] || '').toString().trim(),
      fullName:    (row[cols.FULL_NAME - 1] || '').toString().trim(),
      notes:       (row[cols.NOTES - 1] || '').toString()
    };
    var lead = _dispatchLeadFromRow(row, rowNum, scanFields);

    var execResult = executeDispatch(lead, newDecision, {
      dryRun: dryRun,
      legacyDecision: legacyDecision,
      source: source
    });

    if (execResult.ok && execResult.mode === 'dispatched') {
      counters.dispatched++;
      dispatchCount++;
      draftDispatchCount++;  // PATCH 2026-06-13-transient-draft: count toward draft-rate cap
    } else if (execResult.ok && execResult.mode === 'shadow_dryrun') {
      counters.dispatched++;  // would-have-dispatched
      dispatchCount++;
      draftDispatchCount++;  // PATCH 2026-06-13-transient-draft: count shadow dispatches too
    } else if (execResult.mode === 'dedupe_skip') {
      counters.skipped++;
    } else if (!execResult.ok) {
      counters.errors++;
    }
  }

  // Update aggregate counters for the summary endpoint
  try {
    var ap = (typeof _svc === 'function') ? _svc('Properties') : PropertiesService.getScriptProperties();
    var totalCompared = parseInt(ap.getProperty('SHADOW_TOTAL_COMPARED') || '0', 10) + counters.rowsCompared;
    var totalAgree    = parseInt(ap.getProperty('SHADOW_TOTAL_AGREE')    || '0', 10) + counters.agreeRows;
    var totalDiff     = parseInt(ap.getProperty('SHADOW_TOTAL_DIFF')     || '0', 10) + counters.diffRows;
    ap.setProperty('SHADOW_TOTAL_COMPARED', String(totalCompared));
    ap.setProperty('SHADOW_TOTAL_AGREE',    String(totalAgree));
    ap.setProperty('SHADOW_TOTAL_DIFF',     String(totalDiff));
  } catch (_) {}

  Logger.log('[Scanner.scanAndDispatch] source=' + source + ' dryRun=' + dryRun +
             ' heartbeat=' + counters.heartbeat +
             ' scanned=' + counters.scanned +
             ' compared=' + counters.rowsCompared +
             ' agree=' + counters.agreeRows + ' diff=' + counters.diffRows +
             ' dispatched=' + counters.dispatched +
             ' skipped=' + counters.skipped + ' errors=' + counters.errors);
  return counters;
}

// ─── LEGACY DECISION PORT (separate code path for shadow comparison) ────────
//
// Mirrors `_scanAndProcessNewRows` IF-chain (BatchProcessor.gs:1947-1989).
// Separate from scoreRowForDispatch so that diffs catch scorer bugs (not just
// "scoreRowForDispatch differs from itself"). If the 3-layer scorers have a
// regression vs legacy semantics, this function's output will diverge from
// scoreRowForDispatch's, surfacing the bug in the diff log.
//
// PURE function — no side effects. Returns the same {dispatch, kind, reason}
// shape as combineSignals.

function _computeLegacyDecision(row, cols, nowMs) {
  var status = (row[cols.STATUS - 1] || '').toString().trim();
  var notes  = (row[cols.NOTES - 1] || '').toString();

  // Whitelist branch 1: isFresh
  var isFresh = (status === '' || status === 'NEW');

  // Whitelist branch 2: isReoonRetry + retryAfter gate
  var isReoonRetry = false;
  if (status === 'REOON_RETRY_PENDING') {
    var m = notes.match(/retryAfter:(\d+)/);
    if (m && nowMs >= parseInt(m[1], 10)) isReoonRetry = true;
  }

  // Whitelist branch 3: isResearchDone
  var isResearchDone = (status === 'RESEARCH_DONE');

  // Whitelist branch 4: isStuckAutoRecover.
  // REGRESSION FIX `-eq2-scannerfix`: reference the SHARED constant instead of
  // a local copy. Previously this was a duplicated literal list that drifted
  // from STUCK_AUTO_RECOVER_STATUSES — both lacked the PENDING_* states, so the
  // parity comparison agreed with itself (diff=0) while both were wrong vs the
  // real legacy isStuckAutoRecover. Referencing the constant makes the port and
  // the dispatch path provably identical — no silent drift possible.
  var stuckStatuses = STUCK_AUTO_RECOVER_STATUSES;
  var isStuckAutoRecover = (stuckStatuses.indexOf(status) >= 0);
  if (isStuckAutoRecover) {
    var rm = notes.match(/errRetry:(\d+)\/(\d+)/);
    if (rm) {
      var attempts = parseInt(rm[1], 10);
      var max      = parseInt(rm[2], 10);
      if (attempts >= max) isStuckAutoRecover = false;
    }
  }

  if (!isFresh && !isReoonRetry && !isResearchDone && !isStuckAutoRecover) {
    return { dispatch: false, kind: 'SKIP_FALL_THROUGH', reason: 'no_whitelist_match' };
  }

  // Identity gate (mirrors legacy 1933-1936)
  var email     = (row[cols.EMAIL - 1] || '').toString().trim();
  var fullName  = (row[cols.FULL_NAME - 1] || '').toString().trim();
  var org       = (row[cols.ORGANIZATION - 1] || '').toString().trim();
  var url       = (row[cols.LINKEDIN_URL - 1] || '').toString().trim();
  var firstName = '';
  if (fullName) {
    var fn = fullName.split(/\s+/)[0];
    if (/^[A-Za-zÀ-ſ][A-Za-zÀ-ſ'.\-]{1,}$/.test(fn)) firstName = fn;
  }
  var hasUsableEmail = !!(email && email.indexOf('@') > 0);
  var canGuessEmail  = !!(firstName && org);
  var hasUrlPath     = !!(url && /\/in\/[^/?#]+/i.test(url));

  if (!hasUsableEmail && !canGuessEmail && !hasUrlPath) {
    return { dispatch: false, kind: 'SKIP_NO_IDENTITY', reason: 'identity_unavailable' };
  }

  // Reaches the candidate pool → DISPATCH
  var reason = 'legacy_whitelist_and_identity';
  if (isFresh)              reason = 'legacy_fresh';
  else if (isReoonRetry)    reason = 'legacy_reoon_retry';
  else if (isResearchDone)  reason = 'legacy_research_done';
  else if (isStuckAutoRecover) reason = 'legacy_stuck_auto_recover';
  return { dispatch: true, kind: 'DISPATCH', reason: reason };
}

// ─── EAGER TAB CREATION ────────────────────────────────────────────────────

/**
 * Idempotent: creates `scanner_shadow_diff` with header row if not present.
 * Called from scanAndDispatch on EVERY invocation so the tab exists from the
 * first scan, before any divergence occurs.
 *
 * PATCH `-p5-scannerrefactor-promote-amend3` (Phase 1b): `ss` is now optional;
 * when absent, obtained via `_svc('Sheets').openById(CONFIG.SHEET_ID)`. This
 * routes the test path through `_svc` consistently with prod, so test mocks
 * (registered via `_svc.setMock('Sheets', ...)`) intercept correctly AND the
 * test suite never mutates the live sheet.
 *
 * The eager-tab semantics are unchanged: tab + header created on first call,
 * no-op on subsequent. Header columns lock the diff log schema for the
 * shadow_diff_summary endpoint.
 */
function _ensureShadowDiffSheet(ss) {
  if (!ss) {
    var sheetsApp = (typeof _svc === 'function') ? _svc('Sheets') : SpreadsheetApp;
    ss = sheetsApp.openById(CONFIG.SHEET_ID);
  }
  var sheet = ss.getSheetByName('scanner_shadow_diff');
  if (sheet) return sheet;  // already exists
  sheet = ss.insertSheet('scanner_shadow_diff');
  sheet.appendRow([
    'timestamp', 'source', 'row', 'leadUid', 'status',
    'legacy_kind', 'legacy_reason', 'new_kind', 'new_reason',
    'diff', 'category'
  ]);
  // Lock header row visually
  try { sheet.setFrozenRows(1); } catch (_) {}
  Logger.log('[Scanner._ensureShadowDiffSheet] created scanner_shadow_diff with header (first-scan eager init)');
  return sheet;
}

// ─── SHADOW DIFF LOGGING ────────────────────────────────────────────────────

/**
 * Append a diff record to the `scanner_shadow_diff` sheet. Schema:
 *   timestamp | source | row | leadUid | status |
 *   legacy_kind | legacy_reason | new_kind | new_reason | diff | category
 *
 * Called only when decisions disagree (caller pre-checks). Category column
 * classifies known-expected diffs (per inventory §7 bug fixes) vs unexplained:
 *   - "expected_bug_1_classifying"  — legacy now whitelists CLASSIFYING
 *   - "expected_bug_5_errretry_init" — Loop A's new errRetry:0/2 token
 *   - "expected_bug_6_uid_dedupe"   — UID-keyed vs row-keyed dedupe (executor-level)
 *   - "unexplained"                 — surface for review
 *
 * SAFE no-op if sheet missing or write fails.
 */
function _logShadowDiff(lead, newDecision, legacyDecision, source) {
  if (!legacyDecision) return;  // can't diff without legacy
  var newKind    = newDecision.kind || 'UNKNOWN';
  var legacyKind = legacyDecision.kind || 'UNKNOWN';
  if (newKind === legacyKind) return;  // caller should pre-check; defensive

  try {
    var sheetsApp = (typeof _svc === 'function') ? _svc('Sheets') : SpreadsheetApp;
    var ss = sheetsApp.openById(CONFIG.SHEET_ID);
    var sheet = _ensureShadowDiffSheet(ss);

    var category = _categorizeShadowDiff(newDecision, legacyDecision, lead);

    sheet.appendRow([
      new Date().toISOString(),
      source || 'unknown',
      lead.rowNum || '',
      lead.leadUid || '',
      lead.status || '',
      legacyKind,
      legacyDecision.reason || '',
      newKind,
      newDecision.reason || '',
      'Y',                  // every row in this sheet is a diff
      category
    ]);
  } catch (e) {
    Logger.log('[Scanner._logShadowDiff] log write failed: ' + e.message);
  }
}

/**
 * Classify a shadow diff into a known-expected category vs "unexplained."
 * Used by the summary endpoint to compute "diffs categorized as expected vs
 * unexplained" — only unexplained diffs block promotion.
 */
function _categorizeShadowDiff(newDecision, legacyDecision, lead) {
  // Bug #1: legacy now whitelists CLASSIFYING (post -p5-promote). If a row
  // is CLASSIFYING and new says DISPATCH but legacy SKIP, that's the old
  // legacy semantics surfacing — but post-fix legacy ALSO dispatches, so
  // they should agree. If they disagree on a CLASSIFYING row, surface as
  // expected_bug_1 since that's the fix area.
  if (lead && /classifying/i.test((lead.status || '').toString())) {
    return 'expected_bug_1_classifying';
  }
  // Bug #5: ERROR rows with errRetry:0/2 — new path may treat as dispatch
  // (post-fix), legacy might still see it as eligible. Either way, ERROR-
  // status diffs are bug #5 territory.
  if (lead && /error/i.test((lead.status || '').toString())) {
    return 'expected_bug_5_errretry_init';
  }
  // Bug #6: dedupe diffs surface at executor level, not in scanAndDispatch
  // decision phase. So bug #6 won't typically show up here as a kind
  // mismatch. But include the category for completeness.
  if (newDecision.reason && /dedupe/i.test(newDecision.reason)) {
    return 'expected_bug_6_uid_dedupe';
  }
  return 'unexplained';
}

function _identifyDivergeSignal(newDecision, legacyDecision) {
  if (!newDecision.signals) return 'no_new_signals';
  // Coarse: if reasons differ but kinds match, surface the new reason
  if (newDecision.kind === (legacyDecision.kind || '')) {
    return 'kind_agree_reason_differs';
  }
  // Identify which signal flipped
  if (newDecision.kind === 'SKIP_NO_IDENTITY') return 'identity_gate';
  if (newDecision.kind === 'SKIP_FALL_THROUGH') return 'fall_through';
  if (newDecision.kind === 'DISPATCH') {
    var r = newDecision.reason || '';
    if (r.indexOf('freshness') === 0)         return 'freshness';
    if (r.indexOf('reoon_retry') === 0)       return 'reoon_retry';
    if (r.indexOf('research_done') === 0)     return 'research_done';
    if (r.indexOf('stuck_auto_recover') === 0) return 'stuck_auto_recover';
  }
  return 'unclassified';
}

// ─── ERROR BOUNDED RETRY (matches legacy semantics) ─────────────────────────

/**
 * Bump the errRetry:N/M counter on the lead's NOTES column after an
 * error. If N >= M, write STATUS=ERROR; else keep the lead's current
 * status so the next scan picks it up via auto-recover.
 *
 * Format matches legacy (Inventory §9.2). Other code grep-depends.
 */
function _bumpErrRetryOnError(lead, err) {
  try {
    var sheetsApp = (typeof _svc === 'function') ? _svc('Sheets') : SpreadsheetApp;
    var ss = sheetsApp.openById(CONFIG.SHEET_ID);
    var sheet = ss.getSheetByName(CONFIG.DATA_SHEET);
    if (!sheet) return;
    var existingNotes = (sheet.getRange(lead.rowNum, CONFIG.COLUMNS.NOTES).getValue() || '').toString();
    var m = existingNotes.match(/errRetry:(\d+)\/(\d+)/);
    var attempts = m ? parseInt(m[1], 10) : 0;
    var max      = m ? parseInt(m[2], 10) : 2;
    var newAttempts = attempts + 1;
    var newToken = 'errRetry:' + newAttempts + '/' + max;
    var newNotes = m
      ? existingNotes.replace(/errRetry:\d+\/\d+/, newToken)
      : (existingNotes + ' ' + newToken).trim();
    var updates = { NOTES: (newNotes + ' | err:' + (err.message || err).toString().substring(0, 200)).substring(0, 1900) };
    if (newAttempts >= max) updates.STATUS = 'ERROR';
    updateLeadFields(lead.rowNum, updates,
      lead.linkedinUrl ? { verifyUrl: lead.linkedinUrl, verifyUid: lead.leadUid } : undefined);
  } catch (bumpErr) {
    Logger.log('[Scanner._bumpErrRetryOnError] bump failed: ' + bumpErr.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// DIAGNOSTIC — per-row dispatch decision dump (read-only, no side effects)
// PATCH `-eq2-scannerfix` (2026-06-09)
//
// Answers "why is row X not producing a draft?" without running the pipeline.
// Runs scoreRowForDispatch (pure) on EVERY row and groups the verdict by
// (status -> decision kind -> reason). Surfaces exactly which rows dispatch,
// which skip, and WHY each skip happens. Use after any whitelist/eligibility
// change to confirm the parked cohort will actually flow.
//
// Run: menuDiagnoseDispatch()  → read the execution log.
// ═══════════════════════════════════════════════════════════════════════════
function menuDiagnoseDispatch() {
  var ssId = (typeof CONFIG !== 'undefined' && CONFIG.SHEET_ID) ? CONFIG.SHEET_ID : null;
  var sheetName = (typeof CONFIG !== 'undefined' && CONFIG.DATA_SHEET) ? CONFIG.DATA_SHEET : 'Sheet2';
  if (!ssId) { Logger.log('[DiagnoseDispatch] CONFIG.SHEET_ID not set'); return null; }
  var ss = SpreadsheetApp.openById(ssId);
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) { Logger.log('[DiagnoseDispatch] Sheet not found'); return null; }
  var cols = CONFIG.COLUMNS;
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) { Logger.log('[DiagnoseDispatch] Sheet empty'); return null; }

  var nowMs = Date.now();
  var maxCol = sheet.getLastColumn();
  var data = sheet.getRange(2, 1, lastRow - 1, maxCol).getValues();

  // status -> { dispatch: N, skipKinds: { reason: N }, rows: [..] }
  var byStatus = {};
  var totalDispatch = 0, totalSkip = 0;
  var dispatchRowsByStatus = {};

  // PATCH 2026-06-12-fresh-first: iterate newest-first (same order as scanAndDispatch).
  for (var i = data.length - 1; i >= 0; i--) {
    var row = data[i];
    var rowNum = i + 2;
    var status = (row[cols.STATUS - 1] || '<blank>').toString().trim() || '<blank>';
    var decision = scoreRowForDispatch(row, cols, nowMs);

    if (!byStatus[status]) byStatus[status] = { dispatch: 0, skip: 0, reasons: {}, sampleDispatchRows: [] };
    if (decision.dispatch) {
      byStatus[status].dispatch++;
      totalDispatch++;
      if (byStatus[status].sampleDispatchRows.length < 5) byStatus[status].sampleDispatchRows.push(rowNum);
    } else {
      byStatus[status].skip++;
      totalSkip++;
      var rk = decision.kind + ':' + decision.reason;
      byStatus[status].reasons[rk] = (byStatus[status].reasons[rk] || 0) + 1;
    }
  }

  Logger.log('═══════════════════════════════════════════════════════════════');
  Logger.log('DISPATCH DIAGNOSTIC — per-status decision breakdown');
  Logger.log('Total rows: ' + data.length + ' | would-dispatch: ' + totalDispatch +
             ' | would-skip: ' + totalSkip);
  Logger.log('NOTE: dispatch count here is pre-BATCH_SIZE-cap and pre-dedupe. The');
  Logger.log('live scanner caps at CONFIG.BATCH_SIZE=' + CONFIG.BATCH_SIZE +
             ' per tick and dedupes rows processed in the last 2 min.');
  Logger.log('═══════════════════════════════════════════════════════════════');

  Object.keys(byStatus).sort().forEach(function(st) {
    var b = byStatus[st];
    Logger.log('');
    Logger.log('STATUS=' + st + '  (dispatch=' + b.dispatch + ', skip=' + b.skip + ')');
    if (b.dispatch > 0) {
      Logger.log('  → WOULD DISPATCH (sample rows: ' + b.sampleDispatchRows.join(', ') + ')');
    }
    Object.keys(b.reasons).forEach(function(rk) {
      Logger.log('  → SKIP ' + rk + '  ×' + b.reasons[rk]);
    });
  });

  Logger.log('');
  Logger.log('--- INTERPRETATION GUIDE ---');
  Logger.log('SKIP_FALL_THROUGH:no_whitelist_match → status not in any dispatch whitelist.');
  Logger.log('  If you see PENDING_QUOTA_RESET / PENDING_GEMINI_BACKOFF here, the -eq2-scannerfix did NOT deploy.');
  Logger.log('SKIP_NO_IDENTITY:identity_unavailable → row has no email, no firstName+org, no /in/ URL path.');
  Logger.log('  These rows can never enrich — they need a usable LinkedIn URL or name+company.');
  Logger.log('SKIP_STALE_LEAD:over_Nd → lead LAST_UPDATED is older than CONFIG.LEAD_MAX_AGE_DAYS (' +
             ((typeof CONFIG !== 'undefined' && CONFIG.LEAD_MAX_AGE_DAYS) || 10) + ' days).');
  Logger.log('  These rows are left untouched for manual handling. No status is written to them.');
  Logger.log('  Missing/unparseable LAST_UPDATED → treated as eligible (legacy rows).');
  Logger.log('Terminal statuses (DRAFT_CREATED, SENT, DRAFT_DELETED) SHOULD skip — that is correct.');

  return { totalRows: data.length, totalDispatch: totalDispatch, totalSkip: totalSkip, byStatus: byStatus };
}

// ═══════════════════════════════════════════════════════════════════════════
// menuSampleNewRows — sample first 10 NEW rows showing identity fields
// Temporary diagnostic: helps confirm whether identity fields are empty
// in the actual sheet data vs a column mapping drift.
// ═══════════════════════════════════════════════════════════════════════════
function menuSampleNewRows() {
  var ssId = (typeof CONFIG !== 'undefined' && CONFIG.SHEET_ID) ? CONFIG.SHEET_ID : null;
  var sheetName = (typeof CONFIG !== 'undefined' && CONFIG.DATA_SHEET) ? CONFIG.DATA_SHEET : 'Sheet2';
  if (!ssId) { return { error: 'no SHEET_ID' }; }
  var ss = SpreadsheetApp.openById(ssId);
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) { return { error: 'sheet not found' }; }
  var cols = CONFIG.COLUMNS;
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) { return { error: 'empty' }; }
  var maxCol = Math.min(sheet.getLastColumn(), 10);
  var data = sheet.getRange(2, 1, lastRow - 1, maxCol).getValues();

  var maxCol2 = sheet.getLastColumn();
  var dataFull = sheet.getRange(2, 1, lastRow - 1, maxCol2).getValues();
  var samples = [];
  for (var i = dataFull.length - 1; i >= 0 && samples.length < 10; i--) {
    var row = dataFull[i];
    var status = (row[cols.STATUS - 1] || '').toString().trim();
    if (status !== 'NEW') continue;
    var emailVal    = (row[cols.EMAIL - 1] || '').toString().trim();
    var fullName    = (row[cols.FULL_NAME - 1] || '').toString().trim();
    var org         = (row[cols.ORGANIZATION - 1] || '').toString().trim();
    var url         = (row[cols.LINKEDIN_URL - 1] || '').toString().trim();
    var enrichedEm  = cols.ENRICHED_EMAIL ? (row[cols.ENRICHED_EMAIL - 1] || '').toString().trim() : '';
    var notes       = cols.NOTES ? (row[cols.NOTES - 1] || '').toString().substring(0, 60) : '';
    samples.push({
      rowNum: i + 2,
      email: emailVal || '<empty>',
      fullName: fullName || '<empty>',
      organization: org || '<empty>',
      linkedinUrl: url ? url.substring(0, 60) : '<empty>',
      enrichedEmail: enrichedEm || '<empty>',
      notesPreview: notes || '<empty>',
      rawCols: row.slice(0, 8).map(function(v) { return (v || '').toString().substring(0, 30); })
    });
  }

  // Also check if any row in the sheet has a non-empty email col F
  var rowsWithEmail = 0;
  var rowsWithLinkedin = 0;
  var newRowNums = [];
  for (var j = 0; j < data.length; j++) {
    var r = data[j];
    var st = ((r[cols.STATUS - 1] || '').toString().trim());
    var em = (r[cols.EMAIL - 1] || '').toString().trim();
    var li = (r[cols.LINKEDIN_URL - 1] || '').toString().trim();
    if (em && em.indexOf('@') > 0) rowsWithEmail++;
    if (li && li.indexOf('/in/') > 0) rowsWithLinkedin++;
    if (st === 'NEW') newRowNums.push(j + 2);
  }

  return {
    totalNewRows: newRowNums.length,
    newRowNums: newRowNums,
    totalRowsWithEmail: rowsWithEmail,
    totalRowsWithLinkedinUrl: rowsWithLinkedin,
    cols: { EMAIL: cols.EMAIL, FULL_NAME: cols.FULL_NAME, ORGANIZATION: cols.ORGANIZATION, LINKEDIN_URL: cols.LINKEDIN_URL },
    samples: samples
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// menuFindLeadRows — read-only diagnostic
// PATCH 2026-06-12-dup-lead-guard
//
// Find all Sheet2 rows where EMAIL or ENRICHED_EMAIL contains argS
// (case-insensitive substring), OR the linkedinUrl local-part (slug) matches.
// Returns per-row: rowNum, fullName, org, status, draftId, enrichedEmail,
// lastUpdated, notesPreview(120).
//
// Run via admin_run: /exec?action=admin_run&fn=menuFindLeadRows&argS=jaspreet.sidhana&token=<ADMIN>
// ═══════════════════════════════════════════════════════════════════════════
function menuFindLeadRows(_, argS) {
  var query = (argS || '').toString().trim().toLowerCase();
  if (!query) return { error: 'argS required (email substring or linkedin slug)' };

  var ssId = (typeof CONFIG !== 'undefined' && CONFIG.SHEET_ID) ? CONFIG.SHEET_ID : null;
  if (!ssId) return { error: 'CONFIG.SHEET_ID not set' };

  var ss = SpreadsheetApp.openById(ssId);
  var sheet = ss.getSheetByName(CONFIG.DATA_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return { rows: [], totalFound: 0, query: query };

  var c = CONFIG.COLUMNS;
  var maxCol = sheet.getLastColumn();
  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, maxCol).getValues();
  var found = [];

  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    var email       = (row[c.EMAIL - 1] || '').toString().trim();
    var enriched    = (c.ENRICHED_EMAIL && row[c.ENRICHED_EMAIL - 1]) ? (row[c.ENRICHED_EMAIL - 1] || '').toString().trim() : '';
    var url         = (row[c.LINKEDIN_URL - 1] || '').toString().trim();
    var emailMatch  = (email.toLowerCase().indexOf(query) >= 0) ||
                      (enriched.toLowerCase().indexOf(query) >= 0);
    var urlMatch    = url.toLowerCase().indexOf(query) >= 0;
    if (!emailMatch && !urlMatch) continue;

    var rowNum      = i + 2;
    var status      = (row[c.STATUS - 1] || '').toString().trim();
    var draftId     = (c.DRAFT_ID && row[c.DRAFT_ID - 1]) ? (row[c.DRAFT_ID - 1] || '').toString().trim() : '';
    var lastUpdated = (c.LAST_UPDATED && row[c.LAST_UPDATED - 1]) ? (row[c.LAST_UPDATED - 1] || '').toString() : '';
    var notes       = (c.NOTES && row[c.NOTES - 1]) ? (row[c.NOTES - 1] || '').toString().substring(0, 120) : '';
    var fullName    = (row[c.FULL_NAME - 1] || '').toString().trim();
    var org         = (row[c.ORGANIZATION - 1] || '').toString().trim();

    found.push({
      rowNum:       rowNum,
      fullName:     fullName,
      org:          org,
      status:       status,
      draftId:      draftId || '<none>',
      email:        email || '<none>',
      enrichedEmail: enriched || '<none>',
      lastUpdated:  lastUpdated ? lastUpdated.toString().substring(0, 30) : '<none>',
      notesPreview: notes,
      matchedOn:    emailMatch ? 'email' : 'url'
    });
  }

  Logger.log('[menuFindLeadRows] query="' + query + '" found=' + found.length + ' rows');
  found.forEach(function(r) {
    Logger.log('  row=' + r.rowNum + ' status=' + r.status + ' email=' + r.email +
               ' enriched=' + r.enrichedEmail + ' draftId=' + r.draftId +
               ' notes=' + r.notesPreview.substring(0, 80));
  });

  return { rows: found, totalFound: found.length, query: query };
}
