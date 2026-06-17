/**
 * ============================================================
 * EnrichmentV2.gs — EQ.7 flag resolver + sampled shadow harness
 * (sub-sprint -eq7-enrichment-impl, 2026-06-10)
 * ============================================================
 *
 * Holds the cross-cutting plumbing for the EQ.7 enrichment-quality fixes so
 * the fixes themselves stay as small flag-gated branches in EmailSelector.gs /
 * EmailFinalizer.gs.
 *
 *   _enrichmentFlag(name)            — resolve a V2 flag (override > ScriptProp > CONFIG)
 *   _ENRICHMENT_FLAG_OVERRIDE        — test/shadow hook (module global)
 *   _enrichmentAllV2On()             — the {all-V2-true} override object
 *   menuEnrichmentShadowSample(n)    — user-triggered, SAMPLED shadow compare
 *
 * Promotion model (no code push needed): set a ScriptProperty of the same name
 * to '1'/'true' (e.g. ENRICHMENT_SORT_V2=1) and _enrichmentFlag picks it up.
 * Design: 25_enrichment_improvements_design.md.
 */

// Test/shadow hook. When non-null, _enrichmentFlag reads from it FIRST.
// Always restore to null in a finally block. Never leave set across a request.
var _ENRICHMENT_FLAG_OVERRIDE = null;

var _ENRICHMENT_V2_FLAG_NAMES = [
  'ENRICHMENT_MX_V2',
  'ENRICHMENT_SOURCETYPE_V2',
  'ENRICHMENT_SORT_V2',
  'ENRICHMENT_CLASSIFY_V2',
  'ENRICHMENT_BOUNCE_V2'
];

/**
 * Resolve a V2 flag. Precedence:
 *   1. _ENRICHMENT_FLAG_OVERRIDE[name]  (tests + shadow)
 *   2. ScriptProperty <name> = '1'|'true'|'yes'  (promote without a code push)
 *   3. CONFIG[name]  (the committed default — all false)
 */
function _enrichmentFlag(name) {
  if (_ENRICHMENT_FLAG_OVERRIDE && _ENRICHMENT_FLAG_OVERRIDE.hasOwnProperty(name)) {
    return !!_ENRICHMENT_FLAG_OVERRIDE[name];
  }
  try {
    var p = PropertiesService.getScriptProperties().getProperty(name);
    if (p !== null && p !== undefined && p !== '') {
      var v = p.toString().toLowerCase();
      return (v === '1' || v === 'true' || v === 'yes' || v === 'on');
    }
  } catch (_) { /* fall through to CONFIG */ }
  return !!(typeof CONFIG !== 'undefined' && CONFIG[name]);
}

// The override object that turns every V2 fix ON — used by the shadow compare.
function _enrichmentAllV2On() {
  var o = {};
  _ENRICHMENT_V2_FLAG_NAMES.forEach(function(n) { o[n] = true; });
  return o;
}

/**
 * SAMPLED shadow compare (user-triggered; OFF the hot path).
 *
 * For the last N resolved leads, run selectBestEmail TWICE — once under live
 * flags (current behavior) and once with all V2 fixes ON — and log every
 * decision DIFF to the `enrichment_shadow_diff` sheet. The live pipeline is
 * untouched; this is observation only. Run a few times across a measurement
 * window, then review the sheet before flipping any ENRICHMENT_*_V2 flag.
 *
 * Vendor cost: the 2nd run mostly hits the 30-day Reoon/MX caches the 1st run
 * warmed, so cost ≈ 1× per sampled lead. Keep N modest.
 *
 * @param {number} n — sample size (default CONFIG.ENRICHMENT_SHADOW_SAMPLE_N)
 */
function menuEnrichmentShadowSample(n) {
  n = (typeof n === 'number' && n > 0) ? n : (CONFIG.ENRICHMENT_SHADOW_SAMPLE_N || 25);
  if (typeof selectBestEmail !== 'function') { Logger.log('[ShadowV2] selectBestEmail not in scope'); return null; }

  var ssId = (typeof CONFIG !== 'undefined' && CONFIG.SHEET_ID) ? CONFIG.SHEET_ID : null;
  var sheetName = (typeof CONFIG !== 'undefined' && CONFIG.DATA_SHEET) ? CONFIG.DATA_SHEET : 'Sheet2';
  if (!ssId) { Logger.log('[ShadowV2] CONFIG.SHEET_ID not set'); return null; }
  var ss = SpreadsheetApp.openById(ssId);
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) { Logger.log('[ShadowV2] data sheet not found'); return null; }
  var c = CONFIG.COLUMNS;
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) { Logger.log('[ShadowV2] sheet empty'); return null; }

  var maxCol = Math.max(c.FULL_NAME, c.EMAIL, c.ORGANIZATION, c.LINKEDIN_URL, c.ENRICHED_EMAIL, c.STATUS);
  var startRow = Math.max(2, lastRow - (n * 3));  // scan a wider band; we filter to resolved
  var data = sheet.getRange(startRow, 1, lastRow - startRow + 1, maxCol).getValues();

  var diffSheet = _ensureEnrichmentShadowSheet(ss);
  var sampled = 0, changed = 0, confUp = 0, confDown = 0;
  var diffs = [];
  // Time budget: each sampled lead costs 2 selector runs (~2-4s each). Stop
  // sampling at 4 min so the run finishes cleanly inside the 6-min GAS kill
  // (the 2026-06-10 sample died mid-run without this).
  var __shadowStart = Date.now();
  var __shadowBudgetMs = 240000;

  for (var i = data.length - 1; i >= 0 && sampled < n; i--) {
    if (Date.now() - __shadowStart > __shadowBudgetMs) {
      Logger.log('[ShadowV2] TIME BUDGET reached after ' + sampled + ' samples — stopping cleanly. Re-run to sample more.');
      break;
    }
    var row = data[i];
    var rowNum = startRow + i;
    var enriched = (row[c.ENRICHED_EMAIL - 1] || '').toString().trim();
    if (!enriched) continue;  // only leads that actually resolved an email

    var fullName = (row[c.FULL_NAME - 1] || '').toString().trim();
    var parts = fullName.split(/\s+/);
    var lead = {
      rowNum: rowNum,
      email: (row[c.EMAIL - 1] || '').toString().trim(),
      fullName: fullName,
      firstName: parts[0] || '',
      lastName: parts.length > 1 ? parts.slice(1).join(' ') : '',
      organization: (row[c.ORGANIZATION - 1] || '').toString().trim(),
      linkedinUrl: (row[c.LINKEDIN_URL - 1] || '').toString().trim()
    };

    var oldR, newR;
    // Live (current flags — typically all false)
    _ENRICHMENT_FLAG_OVERRIDE = null;
    try { oldR = selectBestEmail(lead); } catch (e) { oldR = { email: '<err>', confidence: 0, status: 'ERR', diversity: 0 }; }
    // All-V2-on
    _ENRICHMENT_FLAG_OVERRIDE = _enrichmentAllV2On();
    try { newR = selectBestEmail(lead); } catch (e2) { newR = { email: '<err>', confidence: 0, status: 'ERR', diversity: 0 }; }
    _ENRICHMENT_FLAG_OVERRIDE = null;  // ALWAYS restore

    sampled++;
    var oldEmail = (oldR && oldR.email) || '';
    var newEmail = (newR && newR.email) || '';
    var oldConf = (oldR && oldR.confidence) || 0;
    var newConf = (newR && newR.confidence) || 0;
    var emailChanged = (oldEmail !== newEmail);
    var statusChanged = ((oldR && oldR.status) !== (newR && newR.status));
    if (emailChanged || statusChanged || Math.abs(oldConf - newConf) >= 0.01) {
      changed++;
      if (newConf > oldConf + 0.001) confUp++;
      if (newConf < oldConf - 0.001) confDown++;
      var diffKind = emailChanged ? 'EMAIL_CHANGED' : (statusChanged ? 'STATUS_CHANGED' : 'CONF_CHANGED');
      diffs.push([
        new Date().toISOString(), rowNum, (lead.fullName || '').substring(0, 40),
        oldEmail, oldConf.toFixed(2), (oldR && oldR.status) || '', (oldR && oldR.diversity) || 0,
        newEmail, newConf.toFixed(2), (newR && newR.status) || '', (newR && newR.diversity) || 0,
        diffKind
      ]);
    }
  }

  if (diffs.length > 0) {
    diffSheet.getRange(diffSheet.getLastRow() + 1, 1, diffs.length, diffs[0].length).setValues(diffs);
  }

  Logger.log('=== EQ.7 ENRICHMENT SHADOW SAMPLE ===');
  Logger.log('Sampled (resolved leads): ' + sampled);
  Logger.log('Decisions that CHANGED under all-V2-on: ' + changed +
             ' (' + (sampled > 0 ? (changed / sampled * 100).toFixed(1) : '0') + '%)');
  Logger.log('  confidence increased: ' + confUp + ' | decreased: ' + confDown);
  Logger.log('Diffs appended to enrichment_shadow_diff sheet: ' + diffs.length);
  Logger.log('Review the sheet, then flip individual ENRICHMENT_*_V2 flags (ScriptProperty=1) to promote.');

  return { sampled: sampled, changed: changed, confUp: confUp, confDown: confDown, logged: diffs.length };
}

/** Idempotent: create enrichment_shadow_diff with header if absent. */
function _ensureEnrichmentShadowSheet(ss) {
  var sheet = ss.getSheetByName('enrichment_shadow_diff');
  if (sheet) return sheet;
  sheet = ss.insertSheet('enrichment_shadow_diff');
  sheet.appendRow([
    'timestamp', 'row', 'name',
    'old_email', 'old_conf', 'old_status', 'old_diversity',
    'new_email', 'new_conf', 'new_status', 'new_diversity',
    'diff_kind'
  ]);
  try { sheet.setFrozenRows(1); } catch (_) {}
  return sheet;
}
