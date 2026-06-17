/**
 * ============================================================
 * UnifiedRecovery.gs — One-call recovery for all stuck states
 * (Patch 2026-05-19)
 * ============================================================
 *
 * After shipping the unified EmailSelector + the Reoon-advisory fix +
 * the Hunter-Valid PSV pass + the removed 0.8 quality gate, every NEW
 * lead from this point forward should flow end-to-end. But leads that
 * landed at terminal-ish states BEFORE these fixes are stuck:
 *
 *   • NEEDS_EMAIL              — enrichEmail rejected (now solved by selector)
 *   • NEEDS_PRE_SEND_REVIEW    — PSV blocked (now solved by Hunter-Valid pass)
 *   • REOON_RETRY_PENDING      — exhausted retries (selector picks better email)
 *   • NEEDS_EMAIL_REVIEW       — pattern guess inconclusive (selector decides)
 *
 * This function reclassifies them so they re-enter the pipeline under
 * the new code:
 *
 *   For NEEDS_EMAIL / NEEDS_EMAIL_REVIEW:
 *     → reset STATUS=NEW, clear ENRICHED_EMAIL + EMAIL_SOURCE so the
 *        selector starts fresh
 *
 *   For NEEDS_PRE_SEND_REVIEW / REOON_RETRY_PENDING:
 *     → reset STATUS=RESEARCH_DONE, preserve everything else. Scanner
 *        picks them up and re-runs composition + PSV (which now has
 *        Hunter-Valid authority pass).
 *
 * Plus a helper: findLeadByName(query) for the "I just want to debug
 * one specific lead" case.
 */

/**
 * Reset stuck leads so they re-flow through the post-2026-05-19 pipeline.
 *
 * @param {Object} [options]
 *   {boolean} dryRun           — scan + report but don't mutate
 *   {Array<string>} statuses   — which statuses to reset (default: all stuck)
 *
 * @returns {Object} { scanned, resetToNew, resetToResearchDone, results }
 */
function unifiedRecovery(options) {
  options = options || {};
  var dryRun = !!options.dryRun;
  var targetStatuses = options.statuses || [
    'NEEDS_EMAIL', 'NEEDS_EMAIL_REVIEW',
    'NEEDS_PRE_SEND_REVIEW', 'REOON_RETRY_PENDING'
  ];
  var statusSet = {};
  targetStatuses.forEach(function(s) { statusSet[s] = true; });

  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(CONFIG.DATA_SHEET);
  if (!sheet) return { error: 'data sheet missing' };
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { scanned: 0, resetToNew: 0, resetToResearchDone: 0, results: [] };

  var c = CONFIG.COLUMNS;
  var data = sheet.getRange(2, 1, lastRow - 1, CONFIG.SHEET_COL_COUNT).getValues();

  var scanned = 0;
  var resetToNew = 0;
  var resetToResearchDone = 0;
  var skipped = 0;
  var results = [];

  // Acquire lock to avoid racing with scanner
  var lock = LockService.getScriptLock();
  var lockHeld = false;
  if (!dryRun) {
    lockHeld = lock.tryLock(15000);
    if (!lockHeld) return { aborted: 'lock_busy' };
  }

  try {
    var ps = PropertiesService.getScriptProperties();
    for (var i = 0; i < data.length; i++) {
      var row = data[i];
      var rowNum = i + 2;
      var status = (row[c.STATUS - 1] || '').toString().trim();
      if (!statusSet[status]) continue;
      scanned++;

      var fullName = (row[c.FULL_NAME - 1] || '').toString();
      var linkedinUrl = (row[c.LINKEDIN_URL - 1] || '').toString();

      // Categorize: rows with no usable email need full re-pipeline (NEW).
      // Rows with an email + dossier just need PSV retry (RESEARCH_DONE).
      var hasEmailInState = (status === 'NEEDS_PRE_SEND_REVIEW' || status === 'REOON_RETRY_PENDING');
      var enrichedEmail = (row[c.ENRICHED_EMAIL - 1] || '').toString();
      var hasResearchJson = (row[c.RESEARCH_JSON - 1] || '').toString().length > 100;

      var targetStatus;
      var clearFields = {};
      if (hasEmailInState && hasResearchJson && enrichedEmail) {
        // Has dossier + email — just re-run from compose. Reset to RESEARCH_DONE
        // so the scanner picks it up and re-composes + re-drafts. PSV's new
        // Hunter-Valid pass should let it through this time.
        targetStatus = (typeof STATUS !== 'undefined' && STATUS.RESEARCH_DONE) ? STATUS.RESEARCH_DONE : 'RESEARCH_DONE';
        if (!dryRun) resetToResearchDone++;
      } else {
        // No email or no dossier — full re-pipeline from scratch via the
        // unified selector. Clear stale email artifacts so we don't bias.
        targetStatus = 'NEW';
        if (!dryRun) {
          clearFields[c.ENRICHED_EMAIL]   = '';
          clearFields[c.EMAIL_SOURCE]     = '';
          clearFields[c.EMAIL_CONFIDENCE] = '';
          resetToNew++;
        }
      }

      var rec = {
        rowNum: rowNum,
        fullName: fullName,
        prevStatus: status,
        targetStatus: targetStatus,
        path: targetStatus === 'NEW' ? 'full_re_pipeline' : 'recompose_and_draft',
        action: dryRun ? 'would_reset' : 'reset'
      };
      results.push(rec);

      if (!dryRun) {
        try {
          // Apply field clears (if any)
          Object.keys(clearFields).forEach(function(col) {
            sheet.getRange(rowNum, parseInt(col)).setValue(clearFields[col]);
          });
          // Set new status
          sheet.getRange(rowNum, c.STATUS).setValue(targetStatus);
          // Annotate notes
          var prevNotes = (row[c.NOTES - 1] || '').toString().substring(0, 600);
          var stamp = '[UnifiedRecovery ' + new Date().toISOString() + '] Was ' +
                      status + ' → ' + targetStatus + '. Re-flowing under post-2026-05-19 ' +
                      'pipeline (unified selector + Reoon-advisory + Hunter-Valid PSV pass).';
          sheet.getRange(rowNum, c.NOTES).setValue((stamp + ' | Previous: ' + prevNotes).substring(0, 1900));
          sheet.getRange(rowNum, c.LAST_UPDATED).setValue(new Date().toISOString());
          // Clear per-row dedupe cache so scanner picks it up immediately
          ps.deleteProperty('AUTO_PROCESSED_ROW_' + rowNum);
        } catch (writeErr) {
          rec.action = 'write_error: ' + writeErr.message;
          skipped++;
        }
      }
    }

    // Invoke scanner once at the end so eligible rows process immediately
    var scannerResult = null;
    if (!dryRun && (resetToNew + resetToResearchDone) > 0) {
      try {
        if (typeof _scanAndProcessNewRows === 'function') {
          _scanAndProcessNewRows('UNIFIED_RECOVERY');
          scannerResult = 'invoked';
        }
      } catch (e) {
        scannerResult = 'threw: ' + e.message;
      }
    }

    return {
      scanned: scanned,
      resetToNew: resetToNew,
      resetToResearchDone: resetToResearchDone,
      skipped: skipped,
      scannerInvoked: scannerResult,
      dryRun: dryRun,
      results: results,
      timestamp: new Date().toISOString()
    };
  } finally {
    if (lockHeld) lock.releaseLock();
  }
}

/**
 * Look up a lead by name fragment OR LinkedIn URL fragment.
 * Returns matching rows so the user can find rowNums without scrolling
 * the sheet.
 *
 * @param {string} query  — substring to match against FULL_NAME or LINKEDIN_URL
 * @returns {Object} { matches: [{rowNum, fullName, organization, status, linkedinUrl}, ...] }
 */
function findLeadByQuery(query) {
  if (!query || query.length < 2) return { matches: [], error: 'query too short' };
  var q = query.toString().toLowerCase().trim();

  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(CONFIG.DATA_SHEET);
  if (!sheet) return { matches: [], error: 'data sheet missing' };
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { matches: [] };

  var c = CONFIG.COLUMNS;
  var data = sheet.getRange(2, 1, lastRow - 1, CONFIG.SHEET_COL_COUNT).getValues();
  var matches = [];
  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    var name = (row[c.FULL_NAME - 1] || '').toString().toLowerCase();
    var url = (row[c.LINKEDIN_URL - 1] || '').toString().toLowerCase();
    if (name.indexOf(q) >= 0 || url.indexOf(q) >= 0) {
      matches.push({
        rowNum: i + 2,
        fullName: row[c.FULL_NAME - 1] || '',
        organization: row[c.ORGANIZATION - 1] || '',
        status: row[c.STATUS - 1] || '',
        linkedinUrl: row[c.LINKEDIN_URL - 1] || '',
        enrichedEmail: row[c.ENRICHED_EMAIL - 1] || ''
      });
      if (matches.length >= 20) break;  // cap output
    }
  }
  return { matches: matches, count: matches.length };
}
