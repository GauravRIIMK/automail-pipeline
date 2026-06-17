/**
 * ============================================================
 * Sheet2Realigner.gs — Recover from Sheet1↔Sheet2 desync
 * (Patch 2026-05-18)
 * ============================================================
 *
 * WHY THIS EXISTS
 * ───────────────
 * Sheet2 cols A-F are formula-driven by =UNIQUE(Sheet1!B2:G). When Sheet1
 * changes (row inserted/deleted, dedup run, manual cleanup), the UNIQUE
 * output's row order can shift up/down. Pipeline state columns G-Z, written
 * by updateLeadFields(rowNum, ...), are bound to physical row number — they
 * DON'T shift with the formula recompute. Result: a row's identity (A-F)
 * and its state (G-Z) end up describing different people.
 *
 * Symptom signature:
 *   row.fullName = "Arihant Kothari"  (current identity, from Sheet1)
 *   row.enrichedEmail = "prerna.mahato@meesho.com"  (state from when row
 *                       had a different identity)
 *
 * This realigner scans every row, classifies the relationship between
 * identity (fullName) and state (enrichedEmail.localPart), and takes one
 * of three actions:
 *
 *   1. MISMATCH (local-part doesn't contain the person's surname):
 *      State was written for a different person → clear cols G-Z and set
 *      STATUS=NEW so the pipeline reprocesses with the correct identity.
 *      (TARGET_ROLE col 27 is preserved — it's user-set, not pipeline state.)
 *
 *   2. MATCH + STALE_RECIPIENT_REVIEW + domains likely related (subsidiary
 *      or alias, e.g., publicismedia.com vs publicisgroupe.com):
 *      Sweeper false-positive → flip STATUS back to DRAFT_CREATED with
 *      annotation. The sweeper detected a domain difference but the email
 *      IS for the right person at a legitimate subsidiary/alias domain.
 *
 *   3. MATCH + (other status, or unrelated domains): leave unchanged.
 *      Includes genuine stale-Apollo (Harsh-class) — name matches local-part
 *      but domain is at unrelated ex-employer. Sweeper's STALE_RECIPIENT_
 *      REVIEW flag is correct; user decides per-row.
 *
 * Idempotent: re-running produces no additional changes because misaligned
 * rows are now STATUS=NEW and the pipeline overwrites their state during
 * reprocessing.
 *
 * USAGE
 * ─────
 *   /exec?action=realign_sheet2_state&dryRun=1&token=<ADMIN>   ← always do this first
 *   /exec?action=realign_sheet2_state&token=<ADMIN>            ← live run
 */

/**
 * Scan Sheet2 and realign misaligned rows + unflag false-positive aliases.
 *
 * @param {Object} [options]
 *   {boolean} dryRun  — when true, scans + reports but doesn't modify rows
 *
 * @returns {Object} {
 *   scanned, mismatchCount, aliasUnflagCount, staleKeptCount,
 *   matchSkippedCount, partialMatchCount,
 *   dryRun, results: [{rowNum, fullName, currentEmail, classification, domainRelation, action, details}, ...]
 * }
 */
function realignSheet2State(options) {
  options = options || {};
  var dryRun = !!options.dryRun;

  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(CONFIG.DATA_SHEET);
  if (!sheet) {
    Logger.log('[Sheet2Realigner] Sheet missing: ' + CONFIG.DATA_SHEET);
    return _realignerEmptyResult(dryRun);
  }
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return _realignerEmptyResult(dryRun);

  var c = CONFIG.COLUMNS;
  var data = sheet.getRange(2, 1, lastRow - 1, CONFIG.SHEET_COL_COUNT).getValues();

  var scanned = 0;
  var mismatchCount = 0;
  var aliasUnflagCount = 0;
  var staleKeptCount = 0;
  var matchSkippedCount = 0;
  var partialMatchCount = 0;
  var results = [];

  // Cache org→domain resolution across rows (Meesho, Flipkart, etc. repeat)
  var orgDomainCache = {};

  // Realigner uses a script lock for the entire pass so concurrent
  // doPost / cron writes don't race against our clear+reset operations.
  // 10s acquire timeout — typical Apps Script lock contention is <2s.
  var lock = LockService.getScriptLock();
  var lockHeld = false;
  if (!dryRun) {
    lockHeld = lock.tryLock(10000);
    if (!lockHeld) {
      Logger.log('[Sheet2Realigner] Could not acquire lock — aborting live run');
      return {
        scanned: 0, mismatchCount: 0, aliasUnflagCount: 0, staleKeptCount: 0,
        matchSkippedCount: 0, partialMatchCount: 0,
        dryRun: dryRun, results: [], aborted: 'lock_busy'
      };
    }
  }

  try {
    for (var i = 0; i < data.length; i++) {
      var row = data[i];
      var rowNum = i + 2;
      var fullName = (row[c.FULL_NAME - 1] || '').toString().trim();
      var enrichedEmail = (row[c.ENRICHED_EMAIL - 1] || '').toString().trim().toLowerCase();
      var status = (row[c.STATUS - 1] || '').toString().trim();
      var organization = (row[c.ORGANIZATION - 1] || '').toString().trim();
      var emailSource = (row[c.EMAIL_SOURCE - 1] || '').toString().toLowerCase();
      var draftId = (row[c.DRAFT_ID - 1] || '').toString().trim();

      // Skip empty rows
      if (!fullName && !enrichedEmail && !status) continue;
      // Skip rows without an enriched email — nothing to evaluate
      if (!enrichedEmail) continue;

      scanned++;
      var classification = _classifyEmailNameMatch(fullName, enrichedEmail);

      // ── MATCH path: name aligns with local-part — state belongs to this identity ──
      if (classification === 'match') {
        // Is the row sitting at STALE_RECIPIENT_REVIEW because of the sweeper?
        // Sub-classify the domain relationship.
        if (status === 'STALE_RECIPIENT_REVIEW') {
          var emailDomain = (enrichedEmail.split('@')[1] || '').toLowerCase();
          var expectedDomain = '';
          if (organization) {
            if (orgDomainCache.hasOwnProperty(organization)) {
              expectedDomain = orgDomainCache[organization];
            } else {
              try {
                var resolved = (typeof resolveDomainContextual === 'function')
                  ? resolveDomainContextual(organization, {
                      firstName: (fullName.split(' ')[0] || ''),
                      headline: (row[c.HEADLINE - 1] || '').toString(),
                      linkedinUrl: (row[c.LINKEDIN_URL - 1] || '').toString()
                    })
                  : null;
                if (resolved && resolved.domain && (resolved.confidence || 0) >= 0.50) {
                  expectedDomain = resolved.domain.toLowerCase().trim();
                }
              } catch (_) {}
              orgDomainCache[organization] = expectedDomain;
            }
          }
          var domainRelation = _classifyDomainRelation(emailDomain, expectedDomain);

          var rec = {
            rowNum: rowNum, fullName: fullName, currentEmail: enrichedEmail,
            organization: organization, expectedDomain: expectedDomain,
            classification: 'match', domainRelation: domainRelation,
            action: '', details: ''
          };

          if (domainRelation === 'related_alias_or_subsidiary') {
            // False positive — sweeper flagged a legit subsidiary/alias.
            // Flip back to DRAFT_CREATED with annotation.
            aliasUnflagCount++;
            rec.action = dryRun ? 'would_unflag_to_DRAFT_CREATED' : 'unflagged_to_DRAFT_CREATED';
            rec.details = 'Email belongs to ' + fullName + ' at subsidiary/alias domain (' +
                          emailDomain + ' vs expected ' + expectedDomain + ').';
            results.push(rec);
            if (!dryRun) {
              try {
                sheet.getRange(rowNum, c.STATUS).setValue('DRAFT_CREATED');
                var prevNotes1 = (row[c.NOTES - 1] || '').toString();
                var unflagNote = '[Realigner ' + new Date().toISOString() + '] Unflagged from ' +
                                 'STALE_RECIPIENT_REVIEW: email ' + enrichedEmail +
                                 ' is for ' + fullName + ' at subsidiary/alias domain ' +
                                 '(' + emailDomain + ' ≈ ' + expectedDomain + '). Original sweeper ' +
                                 'flag was a false positive on related-domain match.';
                sheet.getRange(rowNum, c.NOTES).setValue((unflagNote + ' | Previous: ' + prevNotes1.substring(0, 400)).substring(0, 1900));
                sheet.getRange(rowNum, c.LAST_UPDATED).setValue(new Date().toISOString());
              } catch (writeErr) {
                rec.action = 'write_error: ' + writeErr.message;
              }
            }
          } else {
            // Domains unrelated → genuine stale-Apollo (Harsh-class). Leave
            // STALE_RECIPIENT_REVIEW flag in place; user decides per-row.
            staleKeptCount++;
            rec.action = 'kept_STALE_RECIPIENT_REVIEW';
            rec.details = 'Name matches local-part but email domain (' + emailDomain +
                          ') is unrelated to expected (' + expectedDomain + ') — ' +
                          'genuine stale-Apollo case. Manual decision required.';
            results.push(rec);
          }
        } else {
          // status is something else (DRAFT_CREATED, SENT, etc.) — leave alone
          matchSkippedCount++;
        }
        continue;
      }

      // ── PARTIAL_MATCH path: ambiguous, report but don't auto-act ──
      if (classification === 'partial_match') {
        partialMatchCount++;
        results.push({
          rowNum: rowNum, fullName: fullName, currentEmail: enrichedEmail,
          organization: organization, expectedDomain: '',
          classification: 'partial_match', domainRelation: '',
          action: 'reported_no_action',
          details: 'First-name token matches local-part but last name does not. ' +
                   'Could be a different person sharing a first name, or a ' +
                   'nickname/abbreviation. Manual review.'
        });
        continue;
      }

      // ── MISMATCH path: state belongs to a different person → realign ──
      mismatchCount++;
      var rec2 = {
        rowNum: rowNum, fullName: fullName, currentEmail: enrichedEmail,
        organization: organization, expectedDomain: '',
        classification: 'mismatch', domainRelation: '',
        emailSource: emailSource,
        hadDraft: !!draftId, prevStatus: status,
        action: dryRun ? 'would_realign' : 'realigned',
        details: 'Email local-part does not contain person\'s surname. State was ' +
                 'written when row had a different identity (likely Sheet1 row-shift ' +
                 'after deletion or dedup). Clearing state for re-processing.'
      };
      results.push(rec2);

      if (!dryRun) {
        try {
          // Clear pipeline state cols G through Z (STATUS=7 through EMAIL_CONFIDENCE=26).
          // TARGET_ROLE (col 27) preserved — it's user-set, not pipeline state.
          var clearCount = c.EMAIL_CONFIDENCE - c.STATUS + 1; // 20 cols
          var clearArray = [];
          for (var ci = 0; ci < clearCount; ci++) clearArray.push('');
          sheet.getRange(rowNum, c.STATUS, 1, clearCount).setValues([clearArray]);

          // Restamp: STATUS=NEW, NOTES=annotation, LAST_UPDATED=now
          sheet.getRange(rowNum, c.STATUS).setValue(STATUS.NEW);
          var prevNotes2 = (row[c.NOTES - 1] || '').toString().substring(0, 300);
          var realignNote = '[Realigner ' + new Date().toISOString() + '] Row state was misaligned ' +
                            'with current identity (' + fullName + '). Previous enriched_email=' +
                            enrichedEmail + ' belonged to a different person. ' +
                            (draftId ? 'Old draftId=' + draftId + ' still in Gmail — review and ' +
                              'delete if it was sent to the wrong person. ' : '') +
                            'Previous status=' + status + '. Cleared state cols G-Z (kept TARGET_ROLE). ' +
                            'Pipeline will reprocess on next cron tick.';
          sheet.getRange(rowNum, c.NOTES).setValue(realignNote.substring(0, 1900));
          sheet.getRange(rowNum, c.LAST_UPDATED).setValue(new Date().toISOString());
        } catch (writeErr) {
          rec2.action = 'write_error: ' + writeErr.message;
          rec2.details += ' ERROR: ' + writeErr.message;
        }
      }
    }
  } finally {
    if (lockHeld) lock.releaseLock();
  }

  Logger.log('[Sheet2Realigner] Done. Scanned=' + scanned +
             ' mismatch=' + mismatchCount + ' alias_unflag=' + aliasUnflagCount +
             ' stale_kept=' + staleKeptCount + ' match_skipped=' + matchSkippedCount +
             ' partial=' + partialMatchCount + ' dryRun=' + dryRun);
  try {
    if (typeof logPipelineEvent === 'function' && (mismatchCount + aliasUnflagCount) > 0) {
      logPipelineEvent(null, 'REALIGN',
        'Realigned ' + mismatchCount + ' misaligned + unflagged ' + aliasUnflagCount + ' alias false-positives' +
        (dryRun ? ' (dry-run)' : ''),
        'WARN');
    }
  } catch (_) {}

  return {
    scanned: scanned,
    mismatchCount: mismatchCount,
    aliasUnflagCount: aliasUnflagCount,
    staleKeptCount: staleKeptCount,
    matchSkippedCount: matchSkippedCount,
    partialMatchCount: partialMatchCount,
    dryRun: dryRun,
    results: results
  };
}

/**
 * Classify whether an email's local-part is plausibly FOR the named person.
 *
 *   match         → last name (≥3 chars) is present in local-part AND
 *                   (first name is present OR first-initial matches)
 *   partial_match → first name is present but last name is not (ambiguous —
 *                   could be a different person sharing a first name)
 *   mismatch      → neither — state is bound to a different person
 *   unknown       → insufficient signal (missing name or email)
 */
function _classifyEmailNameMatch(fullName, email) {
  if (!fullName || !email) return 'unknown';
  var localPart = (email.split('@')[0] || '').toLowerCase().replace(/\d+$/, '');
  if (!localPart) return 'unknown';

  var nameTokens = fullName.toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .split(/\s+/)
    .filter(function(t) { return t.length >= 2; });
  if (nameTokens.length === 0) return 'unknown';

  var fName = nameTokens[0];
  var lName = nameTokens.length > 1 ? nameTokens[nameTokens.length - 1] : '';

  // Single-name leads (unusual but possible) — match if first name is in local-part
  if (!lName) {
    if (fName.length >= 3 && localPart.indexOf(fName) >= 0) return 'match';
    return 'mismatch';
  }

  // Last name should be present in local-part as the distinguishing token.
  // Use length-3 minimum to avoid false positives on very short last names.
  var lNameInLocal = (lName.length >= 3 && localPart.indexOf(lName) >= 0);
  if (!lNameInLocal) {
    // Special case: f<lastname> pattern (jdoe). Try first-initial+last.
    var fInitLast = (fName.charAt(0) + lName);
    if (lName.length >= 3 && (localPart === fInitLast || localPart.indexOf(fInitLast) === 0)) {
      return 'match';
    }
    // First-name token present but last name absent? Partial match.
    var localTokens = localPart.split(/[._\-+]/).filter(function(t) { return t.length > 0; });
    if (fName.length >= 3 && (localTokens.indexOf(fName) >= 0 || localPart.indexOf(fName) >= 0)) {
      return 'partial_match';
    }
    return 'mismatch';
  }

  // Last name is present. Check first name or first-initial too.
  var fNameInLocal = (fName.length >= 3 && localPart.indexOf(fName) >= 0);
  var fInitMatch = (localPart.charAt(0) === fName.charAt(0));
  if (fNameInLocal || fInitMatch) return 'match';

  // Last name present but no first-name signal — likely partial (lastname@... patterns)
  return 'partial_match';
}

/**
 * Classify the relationship between two domains.
 *
 *   related_alias_or_subsidiary  → share a ≥6-character prefix
 *                                  (publicisgroupe.com ↔ publicismedia.com)
 *                                  (jpmorganchase.com ↔ jpmorgan.com)
 *   unrelated                    → no significant overlap (4700bc.com ↔ flipkart.com)
 *   unknown                      → missing input
 *
 * This is a heuristic — false positives possible on coincidental prefix
 * collisions (e.g., google.com ↔ goodyear.com both start with "good"), but
 * the 6-char threshold makes those rare. False negatives possible on
 * unrelated-looking subsidiaries (TCS BPS uses tcsbps.com vs tcs.com — only
 * 3 char overlap → would NOT flag as related; conservative, requires manual).
 */
function _classifyDomainRelation(emailDomain, expectedDomain) {
  if (!emailDomain || !expectedDomain) return 'unknown';
  if (emailDomain === expectedDomain) return 'identical';

  var e = (emailDomain.split('.')[0] || '');
  var x = (expectedDomain.split('.')[0] || '');
  if (e.length < 4 || x.length < 4) return 'unrelated';

  // Check substring containment first (one is contained in the other)
  if (e.indexOf(x) === 0 || x.indexOf(e) === 0) return 'related_alias_or_subsidiary';

  // Otherwise compare 6-char prefix
  var prefixLen = 6;
  if (e.length >= prefixLen && x.length >= prefixLen
      && e.substring(0, prefixLen) === x.substring(0, prefixLen)) {
    return 'related_alias_or_subsidiary';
  }
  return 'unrelated';
}

function _realignerEmptyResult(dryRun) {
  return {
    scanned: 0,
    mismatchCount: 0, aliasUnflagCount: 0, staleKeptCount: 0,
    matchSkippedCount: 0, partialMatchCount: 0,
    dryRun: dryRun, results: []
  };
}
