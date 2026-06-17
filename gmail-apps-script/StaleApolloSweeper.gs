/**
 * ============================================================
 * StaleApolloSweeper.gs — One-shot Apollo-stale-recipient sweep
 * (Patch 2026-05-18)
 * ============================================================
 *
 * Companion to the EmailEnricher Apollo stale-email guard. The guard
 * prevents NEW leads from getting stale Apollo recipients; this sweeper
 * cleans up EXISTING drafts that were created before the guard shipped.
 *
 * Pattern signature this sweep catches:
 *   - STATUS == 'DRAFT_CREATED'
 *   - EMAIL_SOURCE startsWith 'apollo'
 *   - ENRICHED_EMAIL's domain does NOT match lead.organization's expected
 *     domain (per resolveDomainContextual with confidence ≥ 0.50)
 *
 * Effect on matched rows:
 *   - STATUS flipped from DRAFT_CREATED to STALE_RECIPIENT_REVIEW
 *   - NOTES prepended with explicit explanation + redirect suggestion
 *   - Sheet's existing draft is NOT deleted (user can still inspect),
 *     but the Tracking screen / send-queue won't auto-fire on this status
 *
 * The user manually decides per-row:
 *   a) Confirm the Apollo email is actually still valid → flip back to DRAFT_CREATED
 *   b) Replace ENRICHED_EMAIL with a pattern-guess at current org → flip to RESEARCH_DONE
 *      (the scanner picks up RESEARCH_DONE and re-runs compose+draft with new email)
 *   c) Skip entirely → flip to SKIPPED
 *
 * Idempotent: re-running on the same sheet a second time produces no
 * additional changes because matched rows are now STALE_RECIPIENT_REVIEW,
 * not DRAFT_CREATED.
 */

/**
 * Scan Sheet2 for DRAFT_CREATED rows whose Apollo-sourced email points to
 * a domain inconsistent with the lead's current organization. Returns a
 * summary object for the caller to log + show to the user.
 *
 * @param {Object} [options]
 *   {boolean} dryRun          — when true, scans + reports but doesn't modify rows
 *   {number}  maxAgeDays      — only consider rows updated in the last N days (default 60)
 *   {Array<string>} sourceWhitelist — which email_source prefixes to scan (default ['apollo'])
 *
 * @returns {Object} { scanned, flagged, dryRun, results: [{rowNum, fullName, organization, currentEmail, expectedDomain, suggestedEmail, action}, ...] }
 */
function sweepStaleApolloDrafts(options) {
  options = options || {};
  var dryRun = !!options.dryRun;
  var maxAgeDays = options.maxAgeDays || 60;
  var sourceWhitelist = options.sourceWhitelist || ['apollo'];

  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(CONFIG.DATA_SHEET);
  if (!sheet) {
    Logger.log('[StaleApolloSweeper] Sheet missing: ' + CONFIG.DATA_SHEET);
    return { scanned: 0, flagged: 0, dryRun: dryRun, results: [] };
  }
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { scanned: 0, flagged: 0, dryRun: dryRun, results: [] };

  var c = CONFIG.COLUMNS;
  var data = sheet.getRange(2, 1, lastRow - 1, CONFIG.SHEET_COL_COUNT).getValues();
  var cutoffMs = Date.now() - (maxAgeDays * 86400000);

  var scanned = 0;
  var flagged = 0;
  var results = [];

  // Cache org→domain resolution across rows (same org appears multiple
  // times — Flipkart, Meesho, etc.). Cuts API calls dramatically.
  var orgDomainCache = {};

  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    var rowNum = i + 2;
    var status = (row[c.STATUS - 1] || '').toString().trim();
    if (status !== 'DRAFT_CREATED') continue;

    var emailSource = (row[c.EMAIL_SOURCE - 1] || '').toString().toLowerCase().trim();
    var sourceMatches = sourceWhitelist.some(function(prefix) {
      return emailSource.indexOf(prefix) === 0;
    });
    if (!sourceMatches) continue;

    // Date filter
    var lastUpd = row[c.LAST_UPDATED - 1];
    if (lastUpd) {
      try {
        var ts = new Date(lastUpd);
        if (!isNaN(ts.getTime()) && ts.getTime() < cutoffMs) continue;
      } catch (_) {}
    }

    scanned++;

    var enrichedEmail = (row[c.ENRICHED_EMAIL - 1] || row[c.EMAIL - 1] || '').toString().trim().toLowerCase();
    var emailDomain = (enrichedEmail.split('@')[1] || '').trim();
    var organization = (row[c.ORGANIZATION - 1] || '').toString().trim();
    var fullName = (row[c.FULL_NAME - 1] || '').toString().trim();
    if (!enrichedEmail || !emailDomain || !organization) continue;

    // Resolve org → expected domain (with cache)
    var resolved;
    if (orgDomainCache.hasOwnProperty(organization)) {
      resolved = orgDomainCache[organization];
    } else {
      resolved = null;
      try {
        if (typeof resolveDomainContextual === 'function') {
          resolved = resolveDomainContextual(organization, {
            firstName: (fullName.split(' ')[0] || ''),
            headline: (row[c.HEADLINE - 1] || '').toString(),
            linkedinUrl: (row[c.LINKEDIN_URL - 1] || '').toString()
          });
        }
      } catch (_) {}
      orgDomainCache[organization] = resolved;
    }

    if (!resolved || !resolved.domain || (resolved.confidence || 0) < 0.50) {
      // Can't confidently resolve — skip this row
      continue;
    }
    var expectedDomain = resolved.domain.toLowerCase().trim();
    if (_sweeperBaseDomain(emailDomain) === _sweeperBaseDomain(expectedDomain)) continue;

    // Mismatch detected — flag the row
    flagged++;

    // Suggest a pattern-guess at current org (top guess only, no Reoon
    // verification in the sweep — too expensive for batch; user verifies
    // before committing)
    var parts = fullName.split(/\s+/).filter(function(p) { return p.length > 0; });
    var fName = parts[0] || '';
    var lName = parts.length > 1 ? parts.slice(1).join(' ') : '';
    var suggested = '';
    try {
      var guesses = (typeof guessProfessionalEmail === 'function')
        ? guessProfessionalEmail(fName, lName, expectedDomain) : [];
      if (guesses && guesses.length) suggested = guesses[0];
    } catch (_) {}

    var rec = {
      rowNum: rowNum,
      fullName: fullName,
      organization: organization,
      currentEmail: enrichedEmail,
      currentDomain: emailDomain,
      expectedDomain: expectedDomain,
      expectedDomainConfidence: resolved.confidence,
      suggestedEmail: suggested,
      action: dryRun ? 'would_flag' : 'flagged'
    };
    results.push(rec);

    if (!dryRun) {
      try {
        sheet.getRange(rowNum, c.STATUS).setValue('STALE_RECIPIENT_REVIEW');
        var prevNotes = (row[c.NOTES - 1] || '').toString();
        var stamp = '[StaleApolloSweep ' + new Date().toISOString() + '] ' +
                    'Apollo email at ex-employer detected. Current org=' + organization +
                    ' resolves to ' + expectedDomain + ' (conf=' + resolved.confidence.toFixed(2) +
                    '). Current email=' + enrichedEmail + ' points to ' + emailDomain + '. ' +
                    (suggested ? 'Suggested replacement: ' + suggested + '. ' : '') +
                    'Action: replace ENRICHED_EMAIL (col X) with correct address and flip STATUS to RESEARCH_DONE to re-draft, OR flip to DRAFT_CREATED to keep current email, OR SKIPPED to drop.';
        sheet.getRange(rowNum, c.NOTES).setValue((stamp + (prevNotes ? ' | Previous: ' + prevNotes.substring(0, 800) : '')).substring(0, 1900));
        sheet.getRange(rowNum, c.LAST_UPDATED).setValue(new Date().toISOString());
      } catch (writeErr) {
        Logger.log('[StaleApolloSweeper] write failed for row ' + rowNum + ': ' + writeErr.message);
        rec.action = 'write_failed: ' + writeErr.message;
      }
    }
  }

  Logger.log('[StaleApolloSweeper] Scanned ' + scanned + ' rows, flagged ' + flagged +
             ' (dryRun=' + dryRun + ')');
  try {
    if (typeof logPipelineEvent === 'function' && flagged > 0) {
      logPipelineEvent(null, 'SWEEP',
        'Stale-Apollo sweep flagged ' + flagged + '/' + scanned + ' rows for review',
        'WARN');
    }
  } catch (_) {}

  return { scanned: scanned, flagged: flagged, dryRun: dryRun, results: results };
}

// eTLD+1 helper (mirrors the one in EmailEnricher._detectStaleApolloEmail
// and PreSendVerifier Signal 10 — kept local to avoid a global dependency)
function _sweeperBaseDomain(d) {
  if (!d) return '';
  var parts = d.split('.');
  if (parts.length <= 2) return d;
  var last2 = parts.slice(-2).join('.');
  var ccTld2 = { 'co.uk': 1, 'co.in': 1, 'com.au': 1, 'com.br': 1, 'co.jp': 1, 'co.kr': 1 };
  if (ccTld2[last2]) return parts.slice(-3).join('.');
  return last2;
}
