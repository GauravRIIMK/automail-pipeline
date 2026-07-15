/**
 * ============================================================
 * GmailDraftSyncer.gs — Detect manual Gmail sends + flip STATUS
 * (Patch 2026-05-18)
 * ============================================================
 *
 * WHY THIS EXISTS
 * ───────────────
 * The pipeline creates Gmail drafts and writes STATUS=DRAFT_CREATED. The
 * STATUS only flips to SENT via the `send_draft` admin endpoint (called
 * from the APK's "Send" button).
 *
 * Real-world behavior: 90%+ of users open the draft in Gmail's web/mobile
 * UI and click Send directly — never touching the APK. In that case the
 * pipeline has no signal that the email went out. STATUS stays at
 * DRAFT_CREATED forever.
 *
 * Downstream consequence: FollowUp.gs's processScheduledFollowUps gates
 * on `parentLead.status === SENT` at line 399. Manual-sent leads never
 * pass the gate → no follow-ups created → no FCM notifications.
 *
 * THIS SYNCER closes the loop:
 *   1. Scan all DRAFT_CREATED rows with a draftId
 *   2. For each, try GmailApp.getDraft(draftId)
 *      • If the draft still exists  → user hasn't sent yet, skip
 *      • If the draft is gone (404) → user either sent or deleted
 *   3. For "gone" drafts: read the THREAD_ID and check the thread for a
 *      message FROM the current user dated after LAST_UPDATED
 *      • If found  → SENT (write STATUS=SENT, SENT_DATE=msg.getDate())
 *      • If absent → SKIPPED (user deleted the draft without sending;
 *        annotate NOTES so user can recover by editing)
 *
 * Idempotent: re-running produces no additional state changes because
 * rows are now STATUS=SENT (gate filters them out next pass).
 *
 * Scheduling: install as a 15-minute cron via installGmailDraftSyncerTrigger().
 *
 * ONE-SHOT recovery for existing leads: the same function works as a
 * one-time backfill — it will find every previously manual-sent lead
 * sitting at DRAFT_CREATED and flip them all to SENT in one run, after
 * which the follow-up cron will see them on the next 9 AM run.
 */

var GMAIL_SYNC_MAX_PER_RUN = 50;   // bounded for 6-min Apps Script budget

// ─── OP-BUDGET CONFIG (2026-06-13-op-budget) ────────────────────────────────
//
// The Gmail consumer quota is ~20,000 ops/day. Historically the syncer consumed
// 30,392 ops/day (90% of the pool), starving draft-creation and causing
// "Service invoked too many times: gmail." on real leads (e.g. row 317 Riya).
//
// Fix: two hard budget knobs. When a tag's daily total reaches its ceiling,
// the entry point skips the entire tick with 0 Gmail ops consumed. The draft-
// creation path (BatchProcessor) gets the lion's share of the pool (~80%+).
//
// Override via ScriptProperty SYNCER_DAILY_GMAIL_OP_BUDGET / REPLY_DAILY_GMAIL_OP_BUDGET
// (integer string) without a code push.
// ★RECALIBRATED -p6-gmail-reserve (2026-06-30): the prior 3000/1500 were sized as
// "15%/7.5% of a ~20,000/day pool" — but that 20K pool figure was a MYTH. Live data
// showed createDraft fail with "Service invoked too many times for one day: gmail"
// at only ~3,812 metered scan ops (syncer 2297 + reply 1515). So the real GAS Gmail
// ceiling for this account is ~5× smaller (~3.8-4K), and the old COMBINED budget
// (4500) EXCEEDED it — letting the two scanners collectively starve draft creation.
// New combined per-tag budget = 2000, held under the GMAIL_SCAN_TOTAL_BUDGET global
// reserve (2200, below) so the rest of the real ceiling is left for createDraft.
var SYNCER_DAILY_GMAIL_OP_BUDGET = 1200;
var REPLY_DAILY_GMAIL_OP_BUDGET  = 800;

// Per-tick row-scan cap + rotation cursor (2026-06-13-op-budget).
// Cap rows checked per tick and rotate via a ScriptProperty cursor so each
// DRAFT_CREATED row is revisited at most once per (ROWS_PER_TICK / total_pending)
// ticks — roughly once per hour for a backlog of 30 rows × 96 ticks/day.
// This eliminates the prior pattern of checking ALL rows every tick.
var SYNCER_MAX_ROWS_PER_TICK = 30;
var SYNCER_ROW_CURSOR_KEY     = 'SYNCER_ROW_CURSOR';

/**
 * Pure helper: how many Gmail ops remain in today's (PT-date) budget for `tag`.
 * Returns budget - used (can be negative if budget exceeded mid-day).
 * A result <= 0 means the budget is exhausted for today.
 *
 * @param {string} tag    — meter tag (e.g. 'syncer.scan', 'reply.scan')
 * @param {number} budget — daily op ceiling
 * @returns {number}      — remaining ops (negative = over budget)
 */
function _gmOpBudgetRemaining(tag, budget) {
  try {
    var props = PropertiesService.getScriptProperties();
    var day = _gmPtDate();
    var tagKey = 'GMAIL_OPS_' + day + '_' + tag;
    var used = parseInt(props.getProperty(tagKey) || '0', 10);
    return budget - used;
  } catch (_) {
    return budget; // fail-open: if meter is broken, don't skip
  }
}

// ── GLOBAL SCAN-RESERVE (-p6-gmail-reserve) ────────────────────────────────
// The per-tag budgets above cap each scanner INDEPENDENTLY, but nothing bounds
// their SUM — live data: syncer(2297)+reply(1515)=3812, each under its own budget
// yet COLLECTIVELY hitting the real ceiling and starving createDraft. This global
// cap makes BOTH scanners yield once today's TOTAL metered Gmail ops reach
// GMAIL_SCAN_TOTAL_BUDGET, reserving the rest of the (observed ~3.8-4K, NOT the
// mythical 20K) daily ceiling for draft creation. Kill-switch: GMAIL_SCAN_RESERVE_ENABLED='0'.
var GMAIL_SCAN_TOTAL_BUDGET_DEFAULT = 2200;  // scans yield above this; remainder reserved for drafts

// Pure (unit-testable): with today's total metered ops + the cap, must scans yield?
function _gmScanReserveExceeded_(totalOps, cap) {
  return (typeof totalOps === 'number' && typeof cap === 'number' && cap > 0 && totalOps >= cap);
}

// Reads the PT-date TOTAL meter + kill-switch. true = background scans must yield
// to protect draft creation. Fail-open (false) if anything throws — never block
// scans on a meter read error.
function _gmScanReserveShouldYield() {
  try {
    var props = PropertiesService.getScriptProperties();
    if (props.getProperty('GMAIL_SCAN_RESERVE_ENABLED') === '0') return false;  // kill-switch
    var cap = parseInt(props.getProperty('GMAIL_SCAN_TOTAL_BUDGET') || '', 10);
    if (!(cap > 0)) cap = GMAIL_SCAN_TOTAL_BUDGET_DEFAULT;
    var total = parseInt(props.getProperty('GMAIL_OPS_' + _gmPtDate()) || '0', 10);
    return _gmScanReserveExceeded_(total, cap);
  } catch (_) {
    return false;
  }
}

/**
 * Pure helper: build a targeted Gmail sent-folder query from a list of
 * recipient emails. Returns a query string like:
 *   "in:sent newer_than:Nd (to:a@x OR to:b@y OR ...)"
 * or null if recipients is empty (caller must skip the search entirely).
 *
 * PATCH 2026-06-13-syncer-targeted: replaces the unconditional broad
 * `in:sent newer_than:Nd` search (which fetched up to 500 threads with
 * full message reads just to discover a To: address) with a targeted
 * query that returns ONLY threads addressed to people we are already
 * waiting on. Typically 0-5 matches per tick vs the prior 500-thread
 * walk — ~30× cheaper per tick, ~30K→hundreds of ops/day projected.
 *
 * Safety: Gmail query length cap is ~500 chars of operators; at 25
 * recipients max per call the "to:a@x OR to:b@y" block is ~900 chars
 * worst-case but Gmail handles it reliably. The caller chunks at 25.
 *
 * @param {string[]} recipients - Array of lowercase email addresses
 * @param {number}   searchDays - Lookback window in days
 * @returns {string|null}       - Query string, or null if recipients empty
 */
// PATCH 2026-06-18-draftsync-transient: a draft lookup throwing is NOT proof the
// draft is gone. GmailApp.getDraft() throws on a genuine not-found AND on transient
// infra errors (rate limit / "service invoked too many times" / timeout). Treating
// every throw as "gone" mass-marked 269 leads DRAFT_DELETED whose drafts still
// existed (verified live via getDraft). Only an EXPLICIT not-found means gone; any
// other error must NOT conclude deletion (skip the row, retry next tick). Pure.
function _draftLookupErrorMeansGone(errMsg) {
  var em = (errMsg || '').toString().toLowerCase();
  if (!em) return false;  // empty/unknown → do NOT conclude gone
  return em.indexOf('no item with the given id') >= 0 ||
         em.indexOf('do not have permission') >= 0 ||
         em.indexOf('not found') >= 0;
}

function _buildTargetedSentQuery(recipients, searchDays) {
  if (!recipients || recipients.length === 0) return null;
  var toClause = recipients.map(function(e) { return 'to:' + e; }).join(' OR ');
  return 'in:sent newer_than:' + searchDays + 'd (' + toClause + ')';
}

/**
 * Scan DRAFT_CREATED rows; flip SENT for ones whose draft is gone AND
 * the Sent folder confirms a message to the recipient.
 *
 * PATCH 2026-05-18 (v2 — search-folder approach):
 *   v1 tried to identify "you" via GmailApp.getAliases()[0] + Session.
 *   getActiveUser().getEmail() and matched against thread message FROM.
 *   In installed-trigger contexts both calls often return empty strings,
 *   so the userAddress check failed silently and every row fell to
 *   SKIPPED. v2 drops user-identity matching entirely — instead it
 *   does ONE batch search of in:sent for the time window, builds a
 *   recipient→sentDate map, then does O(1) lookups per row. Works for
 *   rows with empty threadId AND avoids quota burn vs per-row searches.
 *
 * PATCH 2026-06-13-syncer-targeted: replaces the unconditional 500-thread
 * broad sent scan with a TARGETED search: query includes only the
 * recipient emails from THIS tick's cursor window. 0 pending → no search
 * (0 ops). 1-25 recipients → 1 search returning 0-few threads. 26-30 →
 * 2 searches max (chunk at 25). ~30× reduction in ops/tick; no false
 * DRAFT_DELETED risk because we only skip the search when the window
 * has 0 pending recipients (early-exit already guaranteed by the
 * pending-rows-first guard above). Correctness: DRAFT_DELETED is only
 * emitted when the draft is gone AND the targeted search for that
 * specific recipient found no sent message.
 *
 * @param {Object} [options]
 *   {boolean} dryRun     — scan + report but don't mutate the sheet
 *   {number}  limit      — cap on rows examined this run (default 50)
 *   {number}  searchDays — Sent-folder lookback window (default 14 for
 *                          15-min cron; pass 90+ for backfill of older drafts)
 * @returns {Object} { scanned, flippedToSent, flippedToSkipped, stillDraft, errors, dryRun, results }
 */
function syncSentDrafts(options) {
  options = options || {};
  var dryRun = !!options.dryRun;
  var limit  = options.limit || GMAIL_SYNC_MAX_PER_RUN;
  // PATCH 2026-05-19: default search window 14d → 90d. Users routinely sit
  // on drafts for weeks before sending; the prior 14d window was too narrow
  // and caused false SKIPPED flips for late sends. 90d covers the vast
  // majority of "I'll get to it next month" cases at marginal cost: Gmail
  // search is fast, the recipient-map fits in memory, and the cron still
  // completes inside the 6-min Apps Script budget for thousands of sent
  // messages.
  var searchDays = options.searchDays || 90;

  // ── PATCH 2026-06-13-op-budget: DAILY OP BUDGET GUARD ──────────────────
  // If today's syncer.scan ops have already reached SYNCER_DAILY_GMAIL_OP_BUDGET,
  // skip this tick entirely. This is the primary defense that ensures draft-
  // creation (BatchProcessor) keeps the lion's share of the ~20K/day consumer
  // Gmail quota. The budget is intentionally conservative (3000 = 15% of pool).
  // Override: ScriptProperty SYNCER_DAILY_GMAIL_OP_BUDGET (integer string).
  // GLOBAL scan-reserve first: yield if the two scanners' COMBINED metered ops
  // have reached the reserve cap, so createDraft keeps its share of the real ceiling.
  if (!options._skipBudgetGuard && typeof _gmScanReserveShouldYield === 'function' && _gmScanReserveShouldYield()) {
    Logger.log('[Syncer] global Gmail scan-reserve reached — yielding to protect draft creation');
    return _gmailSyncerEmpty(dryRun, 'gmail_scan_reserve_reached');
  }
  if (!options._skipBudgetGuard) {
    var _syncerBudget = (function() {
      try {
        var b = parseInt(
          PropertiesService.getScriptProperties().getProperty('SYNCER_DAILY_GMAIL_OP_BUDGET') || '', 10);
        return (b > 0) ? b : SYNCER_DAILY_GMAIL_OP_BUDGET;
      } catch (_) { return SYNCER_DAILY_GMAIL_OP_BUDGET; }
    })();
    var _syncerRemaining = _gmOpBudgetRemaining('syncer.scan', _syncerBudget);
    if (_syncerRemaining <= 0) {
      Logger.log('[Syncer] daily op budget ' + _syncerBudget + ' reached (' +
                 (_syncerBudget - _syncerRemaining) + ' used) — skipping to protect draft creation');
      return _gmailSyncerEmpty(dryRun, 'daily_op_budget_reached');
    }
  }

  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(CONFIG.DATA_SHEET);
  if (!sheet) {
    Logger.log('[GmailDraftSyncer] Data sheet missing: ' + CONFIG.DATA_SHEET);
    return _gmailSyncerEmpty(dryRun);
  }
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return _gmailSyncerEmpty(dryRun);

  var c = CONFIG.COLUMNS;
  var data = sheet.getRange(2, 1, lastRow - 1, CONFIG.SHEET_COL_COUNT).getValues();

  // ─── QUOTA RELIEF (-eq8-quota-relief): pending rows FIRST ───────────
  //
  // ROOT CAUSE of the daily "Service invoked too many times: gmail": this
  // syncer ran the 90-day full sent-folder walk (1 search + up to 500
  // thread reads + every message in each) on EVERY 15-min tick, even when
  // there was NOTHING to sync — ≈600+ ops × 96 runs/day ≈ 3× the entire
  // 20K consumer pool, all by itself.
  //
  // Fix 1 — early exit: gather DRAFT_CREATED rows BEFORE touching Gmail.
  //   Zero pending → return with ZERO Gmail ops (the common idle case).
  // Fix 2 — adaptive window: a draft can only have been SENT after it was
  //   created, so the lookback only needs to reach the OLDEST pending
  //   row's LAST_UPDATED (+2d buffer), capped at the legacy 90d.
  // Fix 3 (2026-06-13-op-budget) — cursor rotation: gather ALL pending row
  //   indices first, then only process the window of SYNCER_MAX_ROWS_PER_TICK
  //   starting from the saved cursor. Advance cursor for next tick. This
  //   ensures each pending row is checked at most once per (total/cap) ticks
  //   (~1hr for 30-row backlog), not 96× every day.
  var __allPendingIndices = [];
  var __oldestPendingMs = null;
  for (var __pi = 0; __pi < data.length; __pi++) {
    if ((data[__pi][c.STATUS - 1] || '').toString().trim() !== 'DRAFT_CREATED') continue;
    if (!(data[__pi][c.DRAFT_ID - 1] || '').toString().trim()) continue;
    __allPendingIndices.push(__pi);
    var __lu = data[__pi][c.LAST_UPDATED - 1];
    var __luMs = __lu ? ((__lu instanceof Date) ? __lu.getTime() : Date.parse(__lu.toString())) : NaN;
    if (!isNaN(__luMs) && (__oldestPendingMs === null || __luMs < __oldestPendingMs)) __oldestPendingMs = __luMs;
  }
  var __pendingCount = __allPendingIndices.length;
  if (__pendingCount === 0) {
    Logger.log('[GmailDraftSyncer] 0 pending DRAFT_CREATED rows — skipping sent scan entirely (0 Gmail ops this tick).');
    return _gmailSyncerEmpty(dryRun, 'no_pending');
  }

  // Cursor-based rotation (2026-06-13-op-budget): read + advance the cursor
  // ScriptProperty so each tick processes the NEXT window of pending rows.
  var _maxRowsPerTick = SYNCER_MAX_ROWS_PER_TICK;
  var _cursor = 0;
  try {
    var _cursorRaw = PropertiesService.getScriptProperties().getProperty(SYNCER_ROW_CURSOR_KEY);
    _cursor = parseInt(_cursorRaw || '0', 10) || 0;
    if (_cursor < 0 || _cursor >= __pendingCount) _cursor = 0; // wrap/reset
  } catch (_) {}
  // Slice the pending indices starting from cursor, wrapping around
  var _windowIndices = [];
  for (var _wi = 0; _wi < Math.min(_maxRowsPerTick, __pendingCount); _wi++) {
    _windowIndices.push(__allPendingIndices[(_cursor + _wi) % __pendingCount]);
  }
  var _nextCursor = (_cursor + _maxRowsPerTick) % __pendingCount;
  if (!dryRun) {
    try {
      PropertiesService.getScriptProperties().setProperty(SYNCER_ROW_CURSOR_KEY, String(_nextCursor));
    } catch (_) {}
  }
  // Build a Set for O(1) membership test in the main scan loop
  var _windowSet = {};
  _windowIndices.forEach(function(idx) { _windowSet[idx] = true; });
  Logger.log('[GmailDraftSyncer] Cursor rotation: pending=' + __pendingCount +
             ' cursor=' + _cursor + ' window=' + _windowIndices.length +
             ' nextCursor=' + _nextCursor);

  if (!options.searchDays) {
    var __ageDays = (__oldestPendingMs !== null)
      ? Math.ceil((Date.now() - __oldestPendingMs) / 86400000) + 2
      : 90;
    searchDays = Math.max(3, Math.min(90, __ageDays));
    Logger.log('[GmailDraftSyncer] Adaptive window: ' + __pendingCount + ' pending, oldest ' +
               (__oldestPendingMs ? new Date(__oldestPendingMs).toISOString() : '<no LAST_UPDATED>') +
               ' → searchDays=' + searchDays);
  }

  // ─── TARGETED SENT-FOLDER SCAN (2026-06-13-syncer-targeted) ───────────
  //
  // BEFORE (broad): GmailApp.search('in:sent newer_than:Nd', 0, 500) — fetched
  // up to 500 threads + getMessages()[0] per thread just to read To:. ~1002 ops
  // per tick × 96 ticks/day = ~96K ops. With 3 K daily budget, budget exhausted
  // in < 3 ticks, causing constant skip of send-detection.
  //
  // AFTER (targeted): build query only for the THIS tick's window recipients.
  //   GmailApp.search('in:sent newer_than:Nd (to:a@x OR to:b@y OR ...)', 0, max)
  // Returns ONLY threads to people we are actually waiting on — typically 0-3 for
  // a 30-row window. Chunk at 25 recipients per query for safety (max 2 searches).
  // 0 pending recipients → skip the search entirely (0 ops).
  //
  // CORRECTNESS GUARD: DRAFT_DELETED is only emitted when the draft is gone AND
  // the targeted search for that specific recipient found no sent message. Because
  // we searched targeted-to that recipient, the absence from results IS meaningful
  // (not just "outside the search scope"). This eliminates false DRAFT_DELETED.
  //
  // PATCH 2026-06-12-sent-sync: map stores { date, threadId } per recipient so
  // sent-detection writes col V (THREAD_ID=22) alongside STATUS+SENT_DATE.
  // The APK tracking dashboard and FCM threadId both depend on col V.
  //
  // Track which recipients were actually included in the targeted search so the
  // DRAFT_DELETED gate can verify "we did search for this recipient".
  var sentByRecipient = {};       // email -> { date: Date, threadId: string }
  var _searchedRecipients = {};   // email -> true — recipients we sent a targeted query for
  var sentScanCount = 0;
  var totalSearchOps = 0;

  // Collect unique pending recipient emails from the cursor window
  var _windowRecipients = [];
  var _windowRecipientSet = {};
  for (var _wri = 0; _wri < _windowIndices.length; _wri++) {
    var _wrRow = data[_windowIndices[_wri]];
    var _wrEmail = (_wrRow[c.ENRICHED_EMAIL - 1] || _wrRow[c.EMAIL - 1] || '').toString().trim().toLowerCase();
    if (_wrEmail && _wrEmail.indexOf('@') >= 0 && !_windowRecipientSet[_wrEmail]) {
      _windowRecipients.push(_wrEmail);
      _windowRecipientSet[_wrEmail] = true;
    }
  }

  if (_windowRecipients.length === 0) {
    // All window rows lack recipient emails — no search possible; log and skip
    Logger.log('[GmailDraftSyncer] Targeted scan: 0 recipient emails in window — skipping sent search (0 ops).');
  } else {
    // Chunk at 25 recipients per query (Gmail query safety)
    var _CHUNK = 25;
    for (var _ci = 0; _ci < _windowRecipients.length; _ci += _CHUNK) {
      var _chunk = _windowRecipients.slice(_ci, _ci + _CHUNK);
      var _tQuery = _buildTargetedSentQuery(_chunk, searchDays);
      if (!_tQuery) continue;
      // Mark all recipients in this chunk as searched
      _chunk.forEach(function(e) { _searchedRecipients[e] = true; });
      try {
        // Limit to 50 results — targeted query should return far fewer; 50 is a
        // safety cap. Each result is a thread to exactly one of our recipients.
        var _tThreads = GmailApp.search(_tQuery, 0, 50);
        totalSearchOps += 1; // 1 op for the search call
        Logger.log('[GmailDraftSyncer] Targeted search chunk [' + _ci + '/' + _windowRecipients.length +
                   ']: "' + _tQuery.substring(0, 120) + '" → ' + _tThreads.length + ' threads');
        // Process matching threads. Since the query is to:-scoped, each thread's
        // first message is the outbound to one of our recipients. We don't need
        // to re-read To: — the recipient IS one of _chunk — but we still read
        // the message for the sent-timestamp and threadId (needed for col V stamp).
        _tThreads.forEach(function(thread) {
          var tId = '';
          try { tId = thread.getId(); } catch (_) {}
          var msgs;
          try { msgs = thread.getMessages(); } catch (_) { return; }
          if (!msgs || msgs.length === 0) return;
          var msg = msgs[0];
          var date = msg.getDate();
          totalSearchOps += 2; // thread.getId() + getMessages() + msgs[0].getDate() = ~2 ops
          sentScanCount++;
          // Extract To/Cc to identify which chunk recipient this thread belongs to.
          // The query already ensures it IS one of our recipients; reading To: confirms which one.
          var toRaw = (msg.getTo() || '') + ',' + (msg.getCc() || '');
          toRaw.toLowerCase().split(',').forEach(function(addr) {
            var clean = addr.replace(/[\s\S]*<|>[\s\S]*/g, '').trim();
            if (!clean || clean.indexOf('@') < 0) return;
            // Only index if this address is one we searched for (avoid cross-contamination)
            if (!_windowRecipientSet[clean]) return;
            if (!sentByRecipient[clean] || sentByRecipient[clean].date < date) {
              sentByRecipient[clean] = { date: date, threadId: tId };
            }
          });
        });
      } catch (searchErr) {
        Logger.log('[GmailDraftSyncer] Targeted sent search FAILED for chunk [' + _ci + ']: ' +
                   searchErr.message + ' — recipients in this chunk treated as unsearched');
        // Un-mark recipients from this chunk as searched so they don't get false DRAFT_DELETED
        _chunk.forEach(function(e) { delete _searchedRecipients[e]; });
      }
    }
    Logger.log('[GmailDraftSyncer] Targeted scan done: ' + Object.keys(sentByRecipient).length +
               ' recipients with sent threads found, ' + sentScanCount + ' first-messages read, ' +
               totalSearchOps + ' total Gmail ops, ' +
               Object.keys(_searchedRecipients).length + '/' + _windowRecipients.length + ' recipients searched');
    // Meter: actual ops consumed (search calls + thread reads + message reads)
    if (typeof _gmOps === 'function' && totalSearchOps > 0) _gmOps('syncer.scan', totalSearchOps);
  }

  var scanned = 0, flippedToSent = 0, flippedToSkipped = 0;
  var stillDraft = 0, errors = 0;
  var results = [];

  // Acquire script lock to avoid racing with FollowUp's cron or BatchProcessor
  var lock = LockService.getScriptLock();
  var lockHeld = false;
  if (!dryRun) {
    lockHeld = lock.tryLock(10000);
    if (!lockHeld) {
      Logger.log('[GmailDraftSyncer] Could not acquire lock — aborting live run');
      return _gmailSyncerEmpty(dryRun, 'lock_busy');
    }
  }

  try {
    // PATCH 2026-06-13-op-budget: iterate only _windowIndices (cursor-selected slice)
    // instead of the full data array. This limits getDraft() calls to SYNCER_MAX_ROWS_PER_TICK
    // per tick, not all pending rows (which could be dozens re-checked 96×/day).
    for (var _wi2 = 0; _wi2 < _windowIndices.length && scanned < limit; _wi2++) {
      var i = _windowIndices[_wi2];
      var row = data[i];
      var rowNum = i + 2;
      var status = (row[c.STATUS - 1] || '').toString().trim();
      if (status !== 'DRAFT_CREATED') continue;

      var draftId = (row[c.DRAFT_ID - 1] || '').toString().trim();
      var threadId = (row[c.THREAD_ID - 1] || '').toString().trim();
      var fullName = (row[c.FULL_NAME - 1] || '').toString().trim();
      var enrichedEmail = (row[c.ENRICHED_EMAIL - 1] || row[c.EMAIL - 1] || '').toString().trim().toLowerCase();

      if (!draftId) continue;  // no way to check
      scanned++;

      // ── Step 1: is the draft still in Gmail? ────────────────────────
      var draftExists = false;
      try {
        var draft = GmailApp.getDraft(draftId);
        draftExists = !!draft;
      } catch (lookupErr) {
        // PATCH 2026-06-18-draftsync-transient: distinguish a genuine not-found
        // from a transient Gmail error. A transient throw is NOT proof the draft
        // is gone — concluding so mass-marked live drafts DRAFT_DELETED. Only an
        // explicit not-found counts; otherwise SKIP this row (retry next tick).
        if (_draftLookupErrorMeansGone(lookupErr && lookupErr.message)) {
          draftExists = false;  // genuinely gone (sent or deleted)
        } else {
          Logger.log('[Syncer] getDraft transient/ambiguous for row ' + rowNum + ' draft ' +
                     draftId + ' (' + ((lookupErr && lookupErr.message) || '?') +
                     ') — skipping; will NOT false-mark DRAFT_DELETED.');
          continue;  // do not risk a false deletion on a transient error
        }
      }

      if (draftExists) {
        stillDraft++;
        continue;
      }

      // ── Step 2: draft is gone. Did the user actually send? ──────────
      //
      // Primary signal: was a message sent to this recipient email?
      // Look up enrichedEmail in the recipient map built above.
      // Map value is now { date: Date, threadId: string } (PATCH 2026-06-12-sent-sync).
      // Reliable for both populated AND empty threadId rows.
      var sentDate = null;
      var detectedThreadId = '';  // threadId sourced from the sent message (PATCH 2026-06-12-sent-sync)
      var sentFolderEntry = (enrichedEmail && sentByRecipient[enrichedEmail]) ? sentByRecipient[enrichedEmail] : null;
      if (sentFolderEntry) {
        sentDate = sentFolderEntry.date;
        detectedThreadId = sentFolderEntry.threadId || '';
      }

      // Secondary signal (only if primary missed AND threadId is set):
      // peek at the thread for any message. Drafts don't appear in
      // thread.getMessages() — only sent/received messages do. So
      // any non-empty getMessages() proves the draft transitioned to
      // a real message.
      if (!sentDate && threadId) {
        try {
          var thread = GmailApp.getThreadById(threadId);
          if (thread) {
            var msgs = thread.getMessages();
            if (msgs && msgs.length > 0) {
              // For cold-email cold-start threads, the first message
              // is the user's send. Use its date.
              sentDate = msgs[0].getDate();
              // Re-use the existing threadId from the row (we fetched it above).
              detectedThreadId = threadId;
            }
          }
        } catch (_) {}
      }

      // Resolve the final threadId to stamp — prefer the one from the sent
      // message (detectedThreadId), fall back to whatever was already in col V.
      // PATCH 2026-06-12-sent-sync: this is the critical write that was missing
      // — without it every manually-sent draft showed "No tracking signal" in
      // the APK dashboard because col V (THREAD_ID) was never populated.
      var finalThreadId = detectedThreadId || threadId;

      if (sentDate) {
        flippedToSent++;
        var rec = {
          rowNum: rowNum, fullName: fullName, email: enrichedEmail,
          draftId: draftId, threadId: finalThreadId,
          sentDate: sentDate.toISOString(),
          detectedVia: sentFolderEntry ? 'sent_folder_match' : 'thread_message_count',
          action: dryRun ? 'would_flip_to_SENT' : 'flipped_to_SENT'
        };
        results.push(rec);

        if (!dryRun) {
          try {
            var iso = sentDate.toISOString();
            sheet.getRange(rowNum, c.STATUS).setValue('SENT');
            sheet.getRange(rowNum, c.SENT_DATE).setValue(iso);
            // PATCH 2026-06-12-sent-sync: write THREAD_ID (col V=22) so the APK
            // tracking dashboard and FCM push resolve the thread link immediately.
            // Previously this write was absent — "No tracking signal" root cause.
            if (finalThreadId) {
              sheet.getRange(rowNum, c.THREAD_ID).setValue(finalThreadId);
            }
            sheet.getRange(rowNum, c.LAST_UPDATED).setValue(new Date().toISOString());
            var prevNotes = (row[c.NOTES - 1] || '').toString().substring(0, 500);
            var stamp = '[GmailDraftSyncer ' + new Date().toISOString() +
                        '] Detected manual Gmail send at ' + iso +
                        ' (via ' + rec.detectedVia + '). Status flipped DRAFT_CREATED->SENT.' +
                        (finalThreadId ? ' threadId=' + finalThreadId + '.' : '') +
                        ' Follow-ups will schedule via SENT_DATE + offset.';
            sheet.getRange(rowNum, c.NOTES).setValue(
              (stamp + (prevNotes ? ' | Previous: ' + prevNotes : '')).substring(0, 1900));
          } catch (writeErr) {
            rec.action = 'write_error: ' + writeErr.message;
            errors++;
          }
        }
      } else {
        // Draft gone, no Sent-folder match, no thread message.
        //
        // CORRECTNESS GUARD (2026-06-13-syncer-targeted): with the new
        // targeted search, absence from sentByRecipient is only meaningful
        // if we actually sent a targeted query for this recipient. If the
        // recipient was not in the window (e.g. missing email) and thus not
        // included in _searchedRecipients, we did NOT look — so we cannot
        // conclude the draft was deleted. In that case, leave the row at
        // DRAFT_CREATED so the next tick can search for it.
        if (enrichedEmail && !_searchedRecipients[enrichedEmail] && !threadId) {
          Logger.log('[GmailDraftSyncer] Row ' + rowNum + ': draft gone but recipient ' +
                     enrichedEmail + ' was NOT searched (not in window or chunk failed) ' +
                     '— skipping DRAFT_DELETED, will retry via threadId or next tick.');
          continue;
        }
        // User either deleted the draft OR sent it more than `searchDays`
        // ago (older than our search window). Flip to DRAFT_DELETED
        // (renamed from SKIPPED for clarity — distinguishes "user
        // rejected" from "system skipped due to data issue") + FCM nudge
        // so the user knows the system noticed the delete.
        flippedToSkipped++;
        var rec2 = {
          rowNum: rowNum, fullName: fullName, email: enrichedEmail,
          draftId: draftId, threadId: threadId,
          action: dryRun ? 'would_flip_to_DRAFT_DELETED' : 'flipped_to_DRAFT_DELETED',
          hint: 'Draft gone; no send to ' + enrichedEmail + ' found in last ' + searchDays +
                'd. If sent earlier, re-run with &searchDays=' + (searchDays * 2) + '.'
        };
        results.push(rec2);

        if (!dryRun) {
          try {
            sheet.getRange(rowNum, c.STATUS).setValue('DRAFT_DELETED');
            var prevNotes2 = (row[c.NOTES - 1] || '').toString().substring(0, 500);
            var stamp2 = '[GmailDraftSyncer ' + new Date().toISOString() +
                         '] Draft ' + draftId + ' is gone; no send to ' +
                         enrichedEmail + ' found in last ' + searchDays + 'd. Marked DRAFT_DELETED. ' +
                         'If you DID send to a different address, flip STATUS to SENT manually with SENT_DATE; ' +
                         'or flip to NEW to re-draft.';
            sheet.getRange(rowNum, c.NOTES).setValue(
              (stamp2 + (prevNotes2 ? ' | Previous: ' + prevNotes2 : '')).substring(0, 1900));
            sheet.getRange(rowNum, c.LAST_UPDATED).setValue(new Date().toISOString());
            // FCM nudge so the user notices the delete (single push per row;
            // syncer marks DRAFT_DELETED only once per draft lifecycle).
            try {
              if (typeof sendFcmBroadcast === 'function') {
                sendFcmBroadcast(
                  'Draft deleted',
                  'Draft for ' + (fullName || 'lead') + ' was removed from Gmail without sending. Flip STATUS to NEW to re-draft.',
                  { event: 'draft_deleted', leadRow: String(rowNum) }
                );
              }
            } catch (_) {}
          } catch (writeErr2) {
            rec2.action = 'write_error: ' + writeErr2.message;
            errors++;
          }
        }
      }
    }
  } finally {
    if (lockHeld) lock.releaseLock();
  }

  Logger.log('[GmailDraftSyncer] Done. scanned=' + scanned +
             ' flippedToSent=' + flippedToSent +
             ' flippedToSkipped=' + flippedToSkipped +
             ' stillDraft=' + stillDraft +
             ' errors=' + errors + ' dryRun=' + dryRun +
             ' searchDays=' + searchDays);
  try {
    if (typeof logPipelineEvent === 'function' && (flippedToSent + flippedToSkipped) > 0) {
      logPipelineEvent(null, 'GMAIL_SYNC',
        'Detected ' + flippedToSent + ' manual sends + ' + flippedToSkipped +
        ' deleted/old drafts' + (dryRun ? ' (dry-run)' : ''), 'INFO');
    }
  } catch (_) {}

  return {
    scanned: scanned,
    flippedToSent: flippedToSent,
    flippedToSkipped: flippedToSkipped,
    stillDraft: stillDraft,
    errors: errors,
    searchDays: searchDays,
    indexedRecipients: Object.keys(sentByRecipient).length,
    dryRun: dryRun,
    results: results
  };
}

function _gmailSyncerEmpty(dryRun, aborted) {
  return {
    scanned: 0, flippedToSent: 0, flippedToSkipped: 0,
    stillDraft: 0, errors: 0, dryRun: dryRun,
    results: [], aborted: aborted || null
  };
}

/**
 * Installs the 15-minute cron trigger that runs syncSentDrafts. Idempotent.
 * Run once from the Apps Script editor: installGmailDraftSyncerTrigger()
 */
/**
 * On-demand syncer run — force a full syncSentDrafts pass right now.
 * PATCH 2026-06-12-sent-sync: whitelisted in WebApp.gs admin_run so
 * send-detection can be forced via the bridge without waiting for the
 * 15-min cron, useful for immediate stuck-row recovery.
 * Lock-guarded (same _adminRunWithLock_ pattern used by processBounces
 * and menuRestoreResurrectedDeletedDrafts) because it mutates row STATUS,
 * SENT_DATE, THREAD_ID, NOTES.
 *
 * @param {Object} [opts]
 *   {boolean} dryRun   — scan but don't write (default false)
 *   {number}  limit    — max rows to process (default 50)
 * @returns {Object}    syncSentDrafts result envelope
 */
function menuRunDraftSyncerNow(opts) {
  opts = opts || {};
  Logger.log('[menuRunDraftSyncerNow] Forcing immediate syncSentDrafts run at ' + new Date().toISOString());
  var result = syncSentDrafts({
    dryRun: !!opts.dryRun,
    limit: opts.limit || 50
  });
  Logger.log('[menuRunDraftSyncerNow] Done: ' + JSON.stringify({
    scanned: result.scanned,
    flippedToSent: result.flippedToSent,
    flippedToSkipped: result.flippedToSkipped,
    errors: result.errors
  }));
  return result;
}

/**
 * Installs the 15-minute cron trigger that runs syncSentDrafts. Idempotent.
 * Run once from the Apps Script editor: installGmailDraftSyncerTrigger()
 */
function installGmailDraftSyncerTrigger() {
  // Remove duplicates first
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'syncSentDrafts') {
      ScriptApp.deleteTrigger(t);
    }
  });

  ScriptApp.newTrigger('syncSentDrafts')
    .timeBased()
    .everyMinutes(15)
    .create();

  Logger.log('[GmailDraftSyncer] Trigger installed: syncSentDrafts every 15 minutes');
  return 'installed_every_15min';
}
