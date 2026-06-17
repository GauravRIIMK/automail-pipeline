/**
 * ============================================================
 * ErrorRowReprocessor.gs — Manual recovery for ERROR rows
 * (Patch 2026-05-19)
 * ============================================================
 *
 * Companion to the stack-trace-capturing error handlers in BatchProcessor.
 * Use after a deploy that fixes the underlying bug — flips ERROR rows
 * back to NEW so the scanner re-runs them through the now-patched
 * pipeline.
 *
 * Use case: 5 leads landed at STATUS=ERROR with "Maximum call stack size
 * exceeded" (2026-05-18). After diagnosing + patching the actual bug,
 * call this to re-attempt them. The new error handler (with stack
 * capture + bounded retry) will produce diagnosable output if the bug
 * persists.
 *
 * Idempotent: re-running won't re-process rows that already passed.
 */

/**
 * Reset every ERROR row to STATUS=NEW so the scanner picks them up again.
 * Optionally filter by error-message substring.
 *
 * @param {Object} [options]
 *   {boolean} dryRun         — scan + report but don't mutate
 *   {string}  messageFilter  — only reset rows whose NOTES contains this
 *                              substring (case-insensitive). Useful for
 *                              targeting a specific error class.
 *   {boolean} resetRetryCount — if true, ALSO strips the `errRetry:N`
 *                              counter so a row that exhausted retries
 *                              gets a fresh budget. Default false.
 *
 * @returns {Object} { scanned, reset, results }
 */
function reprocessErrorRows(options) {
  options = options || {};
  var dryRun = !!options.dryRun;
  var messageFilter = (options.messageFilter || '').toString().toLowerCase();
  var resetRetryCount = !!options.resetRetryCount;

  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(CONFIG.DATA_SHEET);
  if (!sheet) return { scanned: 0, reset: 0, results: [], error: 'sheet missing' };
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { scanned: 0, reset: 0, results: [] };

  var c = CONFIG.COLUMNS;
  var data = sheet.getRange(2, 1, lastRow - 1, CONFIG.SHEET_COL_COUNT).getValues();

  var scanned = 0, reset = 0;
  var results = [];

  // Acquire lock to avoid racing with scanner cron
  var lock = LockService.getScriptLock();
  var lockHeld = false;
  if (!dryRun) {
    lockHeld = lock.tryLock(10000);
    if (!lockHeld) {
      return { scanned: 0, reset: 0, results: [], aborted: 'lock_busy' };
    }
  }

  try {
    for (var i = 0; i < data.length; i++) {
      var row = data[i];
      var rowNum = i + 2;
      var status = (row[c.STATUS - 1] || '').toString().trim();
      if (status !== 'ERROR') continue;
      scanned++;

      var notes = (row[c.NOTES - 1] || '').toString();
      if (messageFilter && notes.toLowerCase().indexOf(messageFilter) < 0) continue;

      var fullName = (row[c.FULL_NAME - 1] || '').toString();
      var errorMessage = notes.length > 200 ? notes.substring(0, 200) + '...' : notes;

      var rec = {
        rowNum: rowNum,
        fullName: fullName,
        previousError: errorMessage,
        action: dryRun ? 'would_reset_to_NEW' : 'reset_to_NEW'
      };
      results.push(rec);

      if (!dryRun) {
        try {
          var cleanedNotes = notes;
          if (resetRetryCount) {
            cleanedNotes = cleanedNotes.replace(/\s*\|?\s*errRetry:\d+\/\d+/g, '');
          }
          var stamp = '[Reprocessed ' + new Date().toISOString() + '] Was ERROR. Previous notes: ' +
                      cleanedNotes.substring(0, 1200);
          sheet.getRange(rowNum, c.STATUS).setValue(STATUS.NEW);
          sheet.getRange(rowNum, c.NOTES).setValue(stamp.substring(0, 1900));
          sheet.getRange(rowNum, c.LAST_UPDATED).setValue(new Date().toISOString());
          // Clear the per-row dedupe cache so the scanner picks it up
          // immediately on the next 5-min run (else dedupe window blocks
          // re-processing for 2 minutes).
          var dedupeKey = 'AUTO_PROCESSED_ROW_' + rowNum;
          PropertiesService.getScriptProperties().deleteProperty(dedupeKey);
          reset++;
        } catch (resetErr) {
          rec.action = 'reset_failed: ' + resetErr.message;
        }
      }
    }
  } finally {
    if (lockHeld) lock.releaseLock();
  }

  Logger.log('[ErrorRowReprocessor] scanned=' + scanned + ' reset=' + reset +
             ' dryRun=' + dryRun + ' filter=' + (messageFilter || '<none>'));
  try {
    if (typeof logPipelineEvent === 'function' && reset > 0) {
      logPipelineEvent(null, 'REPROCESS',
        'Reset ' + reset + '/' + scanned + ' ERROR rows to NEW' +
        (messageFilter ? ' (filter: ' + messageFilter + ')' : ''), 'INFO');
    }
  } catch (_) {}

  return {
    scanned: scanned,
    reset: reset,
    messageFilter: messageFilter || null,
    resetRetryCount: resetRetryCount,
    dryRun: dryRun,
    results: results
  };
}
