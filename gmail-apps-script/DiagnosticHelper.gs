/**
 * ============================================================
 * DiagnosticHelper.gs — Editor-runnable diagnostic functions
 *
 * Run these from the Apps Script editor (Run button) when you can't
 * deploy fresh code to the Web App. They read live sheet state +
 * return formatted output to the Apps Script Execution log, which
 * you can copy + paste back to debug stuck leads.
 *
 * Usage (in editor):
 *   1. Select function `diagnoseLead` from the function dropdown
 *   2. Edit the QUERY constant below to the name/url you want to search
 *   3. Press Run → check Execution log for output
 *
 * Or call from another function:
 *   diagnoseLead('abhay');                  // matches any lead containing 'abhay'
 *   diagnoseLead('linkedin.com/in/foo');    // by URL substring
 *   diagnoseLead('@acme.com');              // by email domain
 * ============================================================
 */

// Default query if running diagnoseLead() with no arg via editor Run button.
// Edit this line then press Run, OR call diagnoseLead('your query') from another function.
var DIAG_DEFAULT_QUERY = 'abhay';

/**
 * Main diagnostic entry — reads Sheet1, Sheet2, PipelineLog and reports
 * everything matching the query. Output goes to Logger which is visible
 * in the Apps Script Execution log.
 *
 * @param {string} query - case-insensitive substring of name/email/url to find
 */
function diagnoseLead(query) {
  query = (query || DIAG_DEFAULT_QUERY).toString().toLowerCase();
  Logger.log('═══════════════════════════════════════════════════════════');
  Logger.log('  DIAGNOSE — searching for: ' + query);
  Logger.log('  Time: ' + new Date().toISOString());
  Logger.log('═══════════════════════════════════════════════════════════');

  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);

  // ── Section 1: Sheet1 (raw audit, what the APK / extension wrote) ──
  Logger.log('');
  Logger.log('━━━ SECTION 1: Sheet1 (RAW AUDIT — what APK/extension wrote) ━━━');
  var sheet1 = ss.getSheetByName('Sheet1');
  if (!sheet1) {
    Logger.log('  Sheet1 does NOT exist. No APK / extension captures yet.');
  } else {
    var last1 = sheet1.getLastRow();
    Logger.log('  Total rows in Sheet1: ' + (last1 - 1));
    if (last1 > 1) {
      var data1 = sheet1.getRange(2, 1, last1 - 1, 12).getValues();
      var headers1 = ['Timestamp','LinkedIn_URL','Full_Name','Headline','Designation','Organization','Email','Phone','Website','Location','Connection','Confidence'];
      var matches1 = [];
      for (var i = 0; i < data1.length; i++) {
        var rowText = data1[i].join(' ').toLowerCase();
        if (rowText.indexOf(query) >= 0) {
          matches1.push({ rowNum: i + 2, data: data1[i] });
        }
      }
      Logger.log('  Matching rows: ' + matches1.length);
      matches1.slice(-10).forEach(function(m) {
        Logger.log('  ─── Sheet1 row ' + m.rowNum + ' ───');
        for (var k = 0; k < headers1.length; k++) {
          var val = m.data[k];
          if (val !== '' && val !== null && val !== undefined) {
            Logger.log('    ' + headers1[k] + ' = ' + String(val).substring(0, 120));
          }
        }
      });
    }
  }

  // ── Section 2: Sheet2 (pipeline input + state) ──
  Logger.log('');
  Logger.log('━━━ SECTION 2: Sheet2 (PIPELINE STATE — what processing did) ━━━');
  var sheet2 = ss.getSheetByName(CONFIG.DATA_SHEET);
  if (!sheet2) {
    Logger.log('  Sheet2 (' + CONFIG.DATA_SHEET + ') does NOT exist.');
  } else {
    var last2 = sheet2.getLastRow();
    Logger.log('  Total rows in Sheet2: ' + (last2 - 1));
    if (last2 > 1) {
      var width = CONFIG.SHEET_COL_COUNT || 26;
      var data2 = sheet2.getRange(2, 1, last2 - 1, width).getValues();
      var c = CONFIG.COLUMNS;
      var matches2 = [];
      for (var i2 = 0; i2 < data2.length; i2++) {
        var rowText2 = data2[i2].join(' ').toLowerCase();
        if (rowText2.indexOf(query) >= 0) {
          matches2.push({ rowNum: i2 + 2, data: data2[i2] });
        }
      }
      Logger.log('  Matching rows: ' + matches2.length);
      matches2.slice(-10).forEach(function(m2) {
        Logger.log('  ─── Sheet2 row ' + m2.rowNum + ' ───');
        var fields = [
          ['LinkedIn_URL',   c.LINKEDIN_URL],
          ['Full_Name',      c.FULL_NAME],
          ['Headline',       c.HEADLINE],
          ['Designation',    c.DESIGNATION],
          ['Organization',   c.ORGANIZATION],
          ['Email',          c.EMAIL],
          ['Pipeline_Status', c.STATUS],
          ['Archetype',      c.ARCHETYPE],
          ['Resume_Variant', c.RESUME_VARIANT],
          ['Quality_Score',  c.QUALITY_SCORE],
          ['Draft_ID',       c.DRAFT_ID],
          ['Followup_Stage', c.FOLLOWUP_STAGE],
          ['Notes',          c.NOTES],
          ['Sent_Date',      c.SENT_DATE],
          ['Last_Updated',   c.LAST_UPDATED],
          ['Enriched_Email', c.ENRICHED_EMAIL],
          ['Email_Source',   c.EMAIL_SOURCE],
          ['Email_Confidence', c.EMAIL_CONFIDENCE]
        ];
        fields.forEach(function(f) {
          if (f[1]) {
            var v = m2.data[f[1] - 1];
            if (v !== '' && v !== null && v !== undefined) {
              Logger.log('    ' + f[0] + ' = ' + String(v).substring(0, 200));
            }
          }
        });
      });
    }
  }

  // ── Section 3: PipelineLog — all events for matching rows ──
  Logger.log('');
  Logger.log('━━━ SECTION 3: PipelineLog (every event the engine recorded) ━━━');
  var logSheet = ss.getSheetByName(CONFIG.LOG_SHEET);
  if (!logSheet) {
    Logger.log('  PipelineLog does NOT exist. Pipeline never ran.');
  } else {
    var lastL = logSheet.getLastRow();
    Logger.log('  Total log entries: ' + (lastL - 1));
    if (lastL > 1) {
      var dataL = logSheet.getRange(2, 1, lastL - 1, 6).getValues();
      var matchesL = [];
      for (var iL = 0; iL < dataL.length; iL++) {
        var combined = dataL[iL].join(' ').toLowerCase();
        if (combined.indexOf(query) >= 0) {
          matchesL.push({ rowNum: iL + 2, data: dataL[iL] });
        }
      }
      Logger.log('  Matching log entries: ' + matchesL.length);
      if (matchesL.length === 0) {
        Logger.log('  → No log entries match the query. Pipeline NEVER processed any row for this lead.');
        Logger.log('  → This means the lead row in Sheet2 was either rejected at the auto-process gate, OR never reached Sheet2 at all.');
      }
      matchesL.slice(-30).forEach(function(mL) {
        var d = mL.data;
        var ts = d[0] ? d[0].toString().substring(0, 19) : '';
        Logger.log('  ' + ts + ' | row=' + d[2] + ' | ' + d[3] + ' | ' + d[4] + ' | ' + String(d[5] || '').substring(0, 200));
      });
    }
  }

  // ── Section 4: Status histogram (anywhere a 'NEEDS_*' or 'ERROR' is stuck) ──
  Logger.log('');
  Logger.log('━━━ SECTION 4: Sheet2 status histogram (where are leads stuck?) ━━━');
  if (sheet2 && sheet2.getLastRow() > 1) {
    var statusCol = sheet2.getRange(2, CONFIG.COLUMNS.STATUS, sheet2.getLastRow() - 1, 1).getValues();
    var counts = {};
    statusCol.forEach(function(r) {
      var s = (r[0] || '').toString().trim() || '(empty)';
      counts[s] = (counts[s] || 0) + 1;
    });
    Object.keys(counts).sort().forEach(function(s) {
      Logger.log('  ' + s + ': ' + counts[s]);
    });
  }

  // ── Section 5: Recent ERRORS / WARN entries across whole log ──
  Logger.log('');
  Logger.log('━━━ SECTION 5: Last 15 ERROR/WARN entries (any lead) ━━━');
  if (logSheet && logSheet.getLastRow() > 1) {
    var allLog = logSheet.getRange(2, 1, logSheet.getLastRow() - 1, 6).getValues();
    var probs = allLog.filter(function(r) {
      var lvl = (r[4] || '').toString().toUpperCase();
      return lvl === 'ERROR' || lvl === 'WARN';
    });
    probs.slice(-15).forEach(function(r) {
      var ts = r[0] ? r[0].toString().substring(0, 19) : '';
      Logger.log('  ' + ts + ' | row=' + r[2] + ' | ' + r[3] + ' | ' + r[4] + ' | ' + String(r[5] || '').substring(0, 200));
    });
  }

  Logger.log('');
  Logger.log('═══════════════════════════════════════════════════════════');
  Logger.log('  DIAGNOSIS HEURISTIC');
  Logger.log('═══════════════════════════════════════════════════════════');
  if (sheet1 && sheet1.getLastRow() > 1) {
    Logger.log('  Sheet1 has data → APK or extension popup IS writing.');
  } else {
    Logger.log('  Sheet1 is EMPTY → APK/extension never reached Web App OR Sheet1 write failed.');
  }
  if (sheet2 && sheet2.getLastRow() > 1) {
    Logger.log('  Sheet2 has data → pipeline IS receiving rows.');
  } else {
    Logger.log('  Sheet2 is EMPTY → doPost _handleApkPayload skipped Sheet2 (likely "email missing" bug) OR doPost was never called.');
  }
  Logger.log('');
  Logger.log('  Done. Copy this entire output and paste back for diagnosis.');
}

/**
 * Convenience wrappers — pick one based on what you want to debug.
 */
function diagnoseAbhay()           { diagnoseLead('abhay'); }
function diagnoseRecent()          { diagnoseLead(''); /* matches everything; truncates to last 10 */ }
function diagnoseStuckLeads()      { diagnoseLead('needs_email'); }
function diagnoseErrors()          { diagnoseLead('error'); }

/**
 * dumpSheet1Recent — print the last N rows of Sheet1 (raw APK / extension
 * audit log) with every field. Tells you whether the APK reached the Web App
 * at all, and which fields it was able to scrape from LinkedIn.
 *
 * Usage in editor:
 *   - Select dumpSheet1Recent from the function dropdown → Run
 *   - Or call dumpSheet1Recent(50) for the last 50 rows
 *
 * Interpretation of the output:
 *   - 0 rows total            → APK / extension never reached Web App.
 *                               Causes: wrong /exec URL in Settings, no
 *                               internet on phone, button doesn't fire.
 *   - Rows exist, all blank   → APK reached us but LinkedIn UI didn't yield
 *                               anything. Likely: not logged in, Vision API
 *                               quota, scraping defenses tripped.
 *   - Rows exist, URL only    → APK scraped the URL field but everything
 *                               else was empty/inaccessible. Likely: not
 *                               1st-degree connected to that profile, or
 *                               LinkedIn rendered a wall.
 *   - Rows exist, name+org    → APK extracted text fine but email/phone
 *                               are gated. ← THIS IS NORMAL for non-1st-deg.
 *                               Pipeline will pattern-guess + verify email.
 */
function dumpSheet1Recent(n) {
  n = parseInt(n) || 25;
  Logger.log('═══════════════════════════════════════════════════════════');
  Logger.log('  DUMP Sheet1 — last ' + n + ' rows');
  Logger.log('  Time: ' + new Date().toISOString());
  Logger.log('═══════════════════════════════════════════════════════════');

  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet1 = ss.getSheetByName('Sheet1');
  if (!sheet1) {
    Logger.log('  Sheet1 does NOT exist. APK / extension has never written here.');
    Logger.log('  → APK Web App URL probably wrong, OR APK was never tapped + extracted, OR no network.');
    return;
  }
  var lastRow = sheet1.getLastRow();
  Logger.log('  Total rows in Sheet1: ' + (lastRow - 1));
  if (lastRow < 2) {
    Logger.log('  Sheet1 is empty (header only).');
    Logger.log('  → APK / extension has NEVER successfully POSTed to Web App.');
    return;
  }

  var startRow = Math.max(2, lastRow - n + 1);
  var data = sheet1.getRange(startRow, 1, lastRow - startRow + 1, 12).getValues();
  var headers = ['Timestamp','LinkedIn_URL','Full_Name','Headline','Designation','Organization','Email','Phone','Website','Location','Connection','Confidence'];

  // Aggregate field-fill stats
  var stats = { name: 0, url: 0, email: 0, phone: 0, org: 0, total: data.length };
  data.forEach(function(r) {
    if (r[2]) stats.name++;
    if (r[1]) stats.url++;
    if (r[6]) stats.email++;
    if (r[7]) stats.phone++;
    if (r[5]) stats.org++;
  });
  Logger.log('  Field-fill rate across last ' + stats.total + ' rows:');
  Logger.log('    LinkedIn_URL:  ' + stats.url   + '/' + stats.total);
  Logger.log('    Full_Name:     ' + stats.name  + '/' + stats.total);
  Logger.log('    Organization:  ' + stats.org   + '/' + stats.total);
  Logger.log('    Email:         ' + stats.email + '/' + stats.total + (stats.email === 0 ? '  ← APK never gets email' : ''));
  Logger.log('    Phone:         ' + stats.phone + '/' + stats.total + (stats.phone === 0 ? '  ← APK never gets phone' : ''));
  Logger.log('');

  // Newest first
  for (var i = data.length - 1; i >= 0; i--) {
    var r = data[i];
    Logger.log('  ─── Sheet1 row ' + (startRow + i) + ' ───');
    for (var k = 0; k < headers.length; k++) {
      var val = r[k];
      if (val !== '' && val !== null && val !== undefined) {
        Logger.log('    ' + headers[k] + ' = ' + String(val).substring(0, 150));
      }
    }
  }

  Logger.log('');
  Logger.log('═══════════════════════════════════════════════════════════');
  Logger.log('  INTERPRETATION');
  Logger.log('═══════════════════════════════════════════════════════════');
  if (stats.email === 0 && stats.phone === 0) {
    Logger.log('  Email + phone are BOTH 0 across all recent rows. Two possibilities:');
    Logger.log('  (a) You are NOT 1st-degree connected to these profiles. LinkedIn');
    Logger.log('      hides email/phone in the Contact Info drawer for non-1st-deg.');
    Logger.log('      → Connect with them OR rely on pipeline pattern-guessing.');
    Logger.log('  (b) APK accessibility scraping fails to find the Contact Info button,');
    Logger.log('      or Gemini Vision API failed to OCR it.');
    Logger.log('      → Try a profile you are CONNECTED with as a test.');
  }
  if (stats.name === 0) {
    Logger.log('  Full_Name is 0 across all rows. APK is reaching us but extraction failed entirely.');
    Logger.log('  → Likely: not logged into LinkedIn on phone, OR LinkedIn UI changed.');
  }
  if (stats.url > 0 && stats.name > 0 && stats.email === 0) {
    Logger.log('  GOOD: APK extracts name + URL fine — just no email/phone (LinkedIn gating).');
    Logger.log('  Pipeline pattern-guesses email from {firstName.lastName@orgDomain}.');
    Logger.log('  Check Sheet2 for status NEEDS_EMAIL_REVIEW (pattern-guessed candidates).');
  }
}

/**
 * dumpSheet1Today — only rows with timestamp from the last 24 hours.
 * Useful right after a fresh test run to see ONLY what just happened.
 */
function dumpSheet1Today() {
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet1 = ss.getSheetByName('Sheet1');
  if (!sheet1) { Logger.log('Sheet1 does not exist.'); return; }
  var lastRow = sheet1.getLastRow();
  if (lastRow < 2) { Logger.log('Sheet1 empty.'); return; }

  var cutoff = new Date(Date.now() - 24 * 3600 * 1000);
  var data = sheet1.getRange(2, 1, lastRow - 1, 12).getValues();
  var recent = [];
  for (var i = 0; i < data.length; i++) {
    var ts = data[i][0];
    if (!ts) continue;
    var d = (ts instanceof Date) ? ts : new Date(ts);
    if (d >= cutoff) recent.push({ rowNum: i + 2, data: data[i], ts: d });
  }
  Logger.log('═══ Sheet1 rows in last 24h: ' + recent.length + ' ═══');
  recent.sort(function(a, b) { return b.ts - a.ts; });
  var headers = ['Timestamp','LinkedIn_URL','Full_Name','Headline','Designation','Organization','Email','Phone','Website','Location','Connection','Confidence'];
  recent.forEach(function(r) {
    Logger.log('  ─── row ' + r.rowNum + ' (' + r.ts.toISOString() + ') ───');
    for (var k = 0; k < headers.length; k++) {
      var v = r.data[k];
      if (v !== '' && v !== null && v !== undefined) {
        Logger.log('    ' + headers[k] + ' = ' + String(v).substring(0, 150));
      }
    }
  });
  if (recent.length === 0) {
    Logger.log('  → No APK or extension POST has hit Sheet1 in the last 24h.');
    Logger.log('  → Your most recent test extraction NEVER reached the Web App.');
    Logger.log('  → Check: APK Settings → Apps Script Web App URL is the LIVE /exec URL,');
    Logger.log('           AND APK Settings → Auto-export is ON,');
    Logger.log('           AND phone has internet access.');
  }
}

/**
 * setupGitHubPat — one-shot installer for the GitHub Personal Access Token.
 * Sets Script Property GITHUB_PAT so EnrichmentSources.gs can use 5000-req/hr
 * authenticated GitHub API quota instead of the 60-req/hr unauthenticated one.
 *
 * Token is hardcoded here for the user's convenience but ALSO written via
 * setProperty — the source can be cleaned afterward. Run once from the editor.
 *
 * After running, verify with inspectScriptProperties() — GITHUB_PAT should
 * appear with length 93.
 */
function setupAllNewKeys() {
  // One-shot installer for GitHub PAT, Apollo key, and Snov.io OAuth credentials.
  // Run from editor once. Verifies each by making a real API call.
  var props = PropertiesService.getScriptProperties();
  props.setProperty('GITHUB_PAT',       'YOUR_GITHUB_PAT');
  // Apollo key rotation 2026-05-11:
  //   YOUR_APOLLO_API_KEY — new key (auth OK, but account has payment block → 403 on /organizations/search until user resolves payment)
  //   YOUR_APOLLO_API_KEY_FALLBACK — previous working key (kept as documented fallback)
  // To revert: change APOLLO_API_KEY to the previous value in Script Properties.
  props.setProperty('APOLLO_API_KEY',   'YOUR_APOLLO_API_KEY');
  props.setProperty('APOLLO_API_KEY_FALLBACK', 'YOUR_APOLLO_API_KEY_FALLBACK');
  props.setProperty('SNOV_API_USER_ID', 'YOUR_SNOV_USER_ID');
  props.setProperty('SNOV_API_SECRET',  'YOUR_SNOV_API_SECRET');
  Logger.log('All 4 keys persisted to Script Properties. Verifying each…');

  // GitHub
  try {
    var r = UrlFetchApp.fetch('https://api.github.com/rate_limit', {
      headers: { 'Authorization': 'Bearer ' + props.getProperty('GITHUB_PAT'), 'User-Agent': 'AutoMailPipeline' },
      muteHttpExceptions: true
    });
    Logger.log('GitHub: HTTP ' + r.getResponseCode() + ' (200 = key valid, 5000 req/hr quota)');
  } catch (e) { Logger.log('GitHub: ' + e.message); }

  // Apollo — /organizations/search (free-tier accessible)
  try {
    var r = UrlFetchApp.fetch('https://api.apollo.io/api/v1/organizations/search', {
      method: 'post',
      headers: { 'X-Api-Key': props.getProperty('APOLLO_API_KEY'), 'Content-Type': 'application/json' },
      payload: JSON.stringify({ q_organization_name: 'OpenAI', per_page: 1 }),
      muteHttpExceptions: true
    });
    Logger.log('Apollo: HTTP ' + r.getResponseCode() + ' (200 = key valid for /organizations/search on free tier)');
  } catch (e) { Logger.log('Apollo: ' + e.message); }

  // Snov.io — OAuth token + balance
  try {
    var tr = UrlFetchApp.fetch('https://api.snov.io/v1/oauth/access_token', {
      method: 'post',
      payload: 'grant_type=client_credentials&client_id=' + props.getProperty('SNOV_API_USER_ID') +
               '&client_secret=' + props.getProperty('SNOV_API_SECRET'),
      muteHttpExceptions: true
    });
    if (tr.getResponseCode() === 200) {
      var token = JSON.parse(tr.getContentText()).access_token;
      var br = UrlFetchApp.fetch('https://api.snov.io/v1/get-balance', {
        headers: { 'Authorization': 'Bearer ' + token }, muteHttpExceptions: true
      });
      Logger.log('Snov.io: OAuth OK, balance: ' + br.getContentText());
    } else {
      Logger.log('Snov.io OAuth: HTTP ' + tr.getResponseCode());
    }
  } catch (e) { Logger.log('Snov.io: ' + e.message); }

  Logger.log('Done. Run inspectScriptProperties() to confirm all 4 keys persisted.');
}

// Legacy alias — kept so previously-shared instructions still work.
function setupGitHubPat() {
  var token = 'YOUR_GITHUB_PAT';
  PropertiesService.getScriptProperties().setProperty('GITHUB_PAT', token);
  Logger.log('GITHUB_PAT set (length=' + token.length + '). EnrichmentSources will now use 5000 req/hr quota.');

  // Verify by making a real call (rate limit endpoint costs 0 credits)
  try {
    var res = UrlFetchApp.fetch('https://api.github.com/rate_limit', {
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'AutoMailPipeline'
      },
      muteHttpExceptions: true
    });
    if (res.getResponseCode() === 200) {
      var info = JSON.parse(res.getContentText());
      Logger.log('Live verification OK. Core rate limit: ' +
        info.rate.remaining + '/' + info.rate.limit +
        ' (resets at ' + new Date(info.rate.reset * 1000).toISOString() + ')');
      Logger.log('Search rate limit: ' +
        info.resources.search.remaining + '/' + info.resources.search.limit);
    } else {
      Logger.log('Token verification HTTP ' + res.getResponseCode() + ' — token may be invalid');
    }
  } catch (e) {
    Logger.log('Verification call failed: ' + e.message);
  }
}

/**
 * setupSheet2AsFormulaView — one-shot migration to the new architecture:
 * Sheet1 = single source of truth (raw appends from APK + Chrome ext),
 * Sheet2!A2 = `=UNIQUE(Sheet1!B2:G)` auto-populates the pipeline input cols.
 *
 * BEFORE running:
 *   - You'll lose any manual edits in Sheet2 cols A-F (they'll be overwritten
 *     by the UNIQUE formula's output). Existing pipeline state in cols G-Z
 *     (status, draft ID, notes, etc.) is BACKED UP to "Sheet2_Backup_<date>"
 *     before the migration, so you can manually re-map state to leads if needed.
 *
 * AFTER running:
 *   - APK / Chrome extension POSTs write only Sheet1
 *   - Sheet2 cols A-F populate automatically (dedup by exact-tuple via UNIQUE)
 *   - Pipeline writes status/draft to Sheet2 cols G-Z by row number
 *   - INVARIANT: keep Sheet1 append-only. Deleting/editing Sheet1 rows
 *     re-orders Sheet2 → orphans pipeline state.
 *
 * Idempotent — safe to re-run; only installs the formula if absent.
 */
function setupSheet2AsFormulaView() {
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet2 = ss.getSheetByName(CONFIG.DATA_SHEET);
  if (!sheet2) {
    Logger.log('Sheet2 (' + CONFIG.DATA_SHEET + ') does not exist. Create it manually first.');
    return;
  }

  var a2Formula = sheet2.getRange('A2').getFormula();
  if (a2Formula && a2Formula.indexOf('UNIQUE') >= 0 && a2Formula.indexOf('Sheet1') >= 0) {
    Logger.log('UNIQUE formula already installed at Sheet2!A2: ' + a2Formula);
    Logger.log('No action needed. Sheet2 is already in formula-view mode.');
    return;
  }

  var lastRow = sheet2.getLastRow();
  var width = CONFIG.SHEET_COL_COUNT || 26;

  // ── Backup current Sheet2 state ──
  if (lastRow >= 2) {
    var stamp = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyyMMdd_HHmm');
    var backupName = 'Sheet2_Backup_' + stamp;
    var backupSheet = ss.insertSheet(backupName);
    var allData = sheet2.getRange(1, 1, lastRow, width).getValues();
    backupSheet.getRange(1, 1, lastRow, width).setValues(allData);
    Logger.log('Backed up ' + (lastRow - 1) + ' rows to sheet "' + backupName + '"');
  } else {
    Logger.log('Sheet2 has no existing data — no backup needed');
  }

  // ── Clear input cols A-F (cols G-Z preserved so existing draft IDs etc. stay) ──
  // Actually: clearing only A-F while leaving G-Z would leave orphaned state
  // (rows would shift when UNIQUE recalculates). Cleaner to clear the whole
  // body. The backup sheet preserves everything for manual recovery.
  if (lastRow >= 2) {
    sheet2.getRange(2, 1, lastRow - 1, width).clearContent();
    Logger.log('Cleared Sheet2 body (rows 2-' + lastRow + ', cols A-' + String.fromCharCode(64 + width) + ')');
  }

  // ── Install the UNIQUE formula ──
  sheet2.getRange('A2').setFormula('=UNIQUE(Sheet1!B2:G)');
  Logger.log('Installed `=UNIQUE(Sheet1!B2:G)` at Sheet2!A2');

  // ── Verify ──
  SpreadsheetApp.flush();  // force recalc
  var newLastRow = sheet2.getLastRow();
  Logger.log('Sheet2 now has ' + (newLastRow - 1) + ' data rows (formula-driven from Sheet1)');
  Logger.log('Done. Next APK or Chrome-ext POST will go to Sheet1 only; Sheet2 will auto-update.');
}

/**
 * inspectScriptProperties — list every Script Property (PropertiesService)
 * that's been set, with key name + length + masked preview. Confirms whether
 * REOON_API_KEY, HUNTER_API_KEY, LOR_DRIVE_ID, AUTOMAIL_WEBAPP_SECRET are all
 * configured. Never logs raw values.
 */
function inspectScriptProperties() {
  var props = PropertiesService.getScriptProperties().getProperties();
  var keys = Object.keys(props).sort();
  Logger.log('═══ Script Properties: ' + keys.length + ' total ═══');
  keys.forEach(function(k) {
    var v = props[k] || '';
    var masked = v.length > 6 ? (v.substring(0, 4) + '…' + v.substring(v.length - 2)) : '(short)';
    Logger.log('  ' + k + ' = [' + v.length + ' chars] ' + masked);
  });
  if (keys.length === 0) Logger.log('  (no properties set)');
}

// ─── PATCH 2026-06-12-autonomous-close: mail-tester probe helpers ─────────────
//
// Three functions that together form a controlled probe loop for checking
// Gmail deliverability via mail-tester.com:
//   menuCreateMailTesterLead  — injects a synthetic lead (email must be @mail-tester.com)
//   menuSendMailTesterDraft   — sends a pipeline-created draft to that lead
//   menuRequeueDegradedTodayDrafts — requeues rows hit by the degraded-renderer window
//
// SECURITY NOTE: menuSendMailTesterDraft carries a HARD GUARD that refuses to send
// to any address not matching the mail-tester.com regex. This guard is the security
// boundary preventing the bridge from sending to arbitrary recipients. Never weaken.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * menuCreateMailTesterLead(_, emailAddr)
 * Injects a synthetic lead row into the pipeline data sheet for mail-tester.com probing.
 *
 * REUSE BEHAVIOUR (2026-06-12-mailtester-probe): if a row already exists with EMAIL
 * matching the mail-tester regex, that row is RESET IN PLACE:
 *   STATUS='NEW', DRAFT_ID='', NOTES='[MAILTESTER_PROBE retry]',
 *   ENRICHED_EMAIL=emailAddr, EMAIL_CONFIDENCE=0.99, EMAIL_SOURCE='mailtester_probe',
 *   LAST_UPDATED=now
 * Returns { row, email, reused:true }.
 *
 * NEW-ROW BEHAVIOUR (2026-06-12-probe-via-sheet1): if no existing row is found,
 * the probe is written into Sheet1 — the same intake surface the APK/extension
 * capture path (doPost → _handleApkPayload) uses. The data sheet's cols A-F are
 * a UNIQUE(Sheet1!B2:G) spill: growing the data sheet directly blocks the
 * formula from expanding and silently dams ALL new lead intake (live incident
 * 2026-06-12). After the Sheet1 write, the function flushes, locates the row
 * the spill materialized, seeds the same fields there (state cols G+ only,
 * never the spill range A-F), and returns { row, email, reused:false }.
 *
 * HARD GUARD: emailAddr must match /@(?:srv\d+\.)?mail-tester\.com$/i — any other
 * recipient is refused. This prevents the function from being repurposed to inject
 * real contacts via the autonomy bridge.
 *
 * @param {*} _ — ignored (arg1 placeholder for admin_run compat)
 * @param {string} emailAddr — must be a @mail-tester.com address
 * @returns {{row:number, email:string, reused:boolean}|{status:'refused', reason:string}}
 */
function menuCreateMailTesterLead(_, emailAddr) {
  // HARD GUARD — security boundary
  if (!/@(?:srv\d+\.)?mail-tester\.com$/i.test(String(emailAddr || ''))) {
    return { status: 'refused', reason: 'recipient not mail-tester.com' };
  }
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(CONFIG.DATA_SHEET);
  if (!sheet) {
    return { status: 'error', error: 'data sheet not found: ' + CONFIG.DATA_SHEET };
  }
  var C = CONFIG.COLUMNS;
  var now = new Date().toISOString();
  var colCount = CONFIG.SHEET_COL_COUNT || 28;
  var lastRow = sheet.getLastRow();

  // ── REUSE PATH: scan for existing row with EMAIL matching the mail-tester regex ──
  if (lastRow >= 2) {
    var emailColData = sheet.getRange(2, C.EMAIL, lastRow - 1, 1).getValues();
    for (var i = 0; i < emailColData.length; i++) {
      var existingEmail = String(emailColData[i][0] || '').trim();
      if (/@(?:srv\d+\.)?mail-tester\.com$/i.test(existingEmail)) {
        // Reset the existing row in place
        var existingRow = i + 2;
        sheet.getRange(existingRow, C.STATUS           ).setValue('NEW');
        sheet.getRange(existingRow, C.DRAFT_ID         ).setValue('');
        sheet.getRange(existingRow, C.NOTES            ).setValue('[MAILTESTER_PROBE retry]');
        sheet.getRange(existingRow, C.ENRICHED_EMAIL   ).setValue(emailAddr);
        sheet.getRange(existingRow, C.EMAIL_CONFIDENCE ).setValue(0.99);
        sheet.getRange(existingRow, C.EMAIL_SOURCE     ).setValue('mailtester_probe');
        sheet.getRange(existingRow, C.LAST_UPDATED     ).setValue(now);
        return { row: existingRow, email: emailAddr, reused: true };
      }
    }
  }

  // ── NEW-ROW PATH (2026-06-12-probe-via-sheet1): probe enters via Sheet1 ──
  // The data sheet's cols A-F are a UNIQUE(Sheet1!B2:G) spill. Growing the
  // data sheet directly blocks the formula from expanding and silently dams
  // ALL new lead intake (live incident 2026-06-12). The probe therefore goes
  // in through Sheet1 — the same intake surface the APK/extension capture
  // path uses — and the spill materializes it into the data sheet, where only
  // state cols (G+) are then written.
  var S1 = CONFIG.SHEET1_COLUMNS;
  var intake = ss.getSheetByName('Sheet1');
  if (!intake) {
    return { status: 'error', error: 'Sheet1 (intake) not found — cannot place probe' };
  }
  if (typeof _ensureSheet2UniqueFormula === 'function') {
    _ensureSheet2UniqueFormula(ss);
  }
  // Unique per call, so UNIQUE always materializes a fresh tuple; doubles as
  // the locate key for the materialized row.
  var probeMark = 'Deliverability probe ' + now;
  var s1row = [];
  for (var j = 0; j < (CONFIG.SHEET1_COL_COUNT || 13); j++) s1row.push('');
  s1row[S1.TIMESTAMP    - 1] = now;
  s1row[S1.FULL_NAME    - 1] = 'Alex Mailtester';
  s1row[S1.HEADLINE     - 1] = probeMark;
  s1row[S1.DESIGNATION  - 1] = 'Hiring Manager';
  s1row[S1.ORGANIZATION - 1] = 'Mailtester Labs';
  s1row[S1.EMAIL        - 1] = emailAddr;
  s1row[S1.LEAD_UID     - 1] = Utilities.getUuid();
  // PATCH 2026-06-17-filter-fix: strip any stray Sheet1 basic filter first — with
  // one present, appendRow silently no-ops and the row is lost (no error thrown).
  if (typeof _ensureNoSheet1Filter_ === 'function') _ensureNoSheet1Filter_(intake);
  intake.appendRow(s1row);

  // Locate the materialized row (new tuples land at the bottom of the spill).
  var foundRow = 0;
  for (var attempt = 0; attempt < 5 && !foundRow; attempt++) {
    if (attempt > 0) Utilities.sleep(400);
    SpreadsheetApp.flush();
    var last2 = sheet.getLastRow();
    if (last2 >= 2) {
      var spillVals = sheet.getRange(2, 1, last2 - 1, 6).getValues();
      for (var r = spillVals.length - 1; r >= 0; r--) {
        if (String(spillVals[r][C.HEADLINE - 1] || '') === probeMark &&
            String(spillVals[r][C.EMAIL - 1] || '').toLowerCase() === String(emailAddr).toLowerCase()) {
          foundRow = r + 2;
          break;
        }
      }
    }
  }
  if (!foundRow) {
    var a2State = '';
    try {
      a2State = sheet.getRange('A2').getFormula() || String(sheet.getRange('A2').getValue() || '');
    } catch (_) {}
    return {
      status: 'error',
      error: 'probe row did not materialize in ' + CONFIG.DATA_SHEET + ' after 5 flush attempts; ' +
             'Sheet2!A2 holds: ' + (a2State || '(empty)') + ' — if that is not the UNIQUE formula, ' +
             'the spill is dammed (see setupSheet2AsFormulaView)'
    };
  }
  // Seed pipeline state on the materialized row — state cols only, never A-F.
  sheet.getRange(foundRow, C.STATUS           ).setValue('NEW');
  sheet.getRange(foundRow, C.ENRICHED_EMAIL   ).setValue(emailAddr);
  sheet.getRange(foundRow, C.EMAIL_CONFIDENCE ).setValue(0.99);
  sheet.getRange(foundRow, C.EMAIL_SOURCE     ).setValue('mailtester_probe');
  sheet.getRange(foundRow, C.LAST_UPDATED     ).setValue(now);
  return { row: foundRow, email: emailAddr, reused: false };
}

/**
 * menuSendMailTesterDraft(rowNum)
 * Sends a pipeline-created draft from the given row to its mail-tester.com recipient.
 *
 * Requirements:
 *   - Row STATUS must be 'DRAFT_CREATED'
 *   - Row DRAFT_ID must be non-empty
 *   - Draft's getTo() address must match the mail-tester.com regex
 *
 * HARD GUARD: the draft's To address is re-validated against the mail-tester regex
 * before send(). This is the SECURITY BOUNDARY — the bridge must never be able to
 * send to a non-mail-tester recipient regardless of how the DRAFT_ID was set.
 * NEVER weaken this guard.
 *
 * @param {number} rowNum — 1-indexed sheet row
 * @returns {{sent:boolean, to:string, draftId:string}|{status:'refused'}|{status:'error'}}
 */
function menuSendMailTesterDraft(rowNum) {
  rowNum = parseInt(rowNum, 10);
  if (!rowNum || rowNum < 2) return { status: 'error', error: 'invalid rowNum' };
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(CONFIG.DATA_SHEET);
  if (!sheet) return { status: 'error', error: 'data sheet not found' };
  var C = CONFIG.COLUMNS;
  var colCount = CONFIG.SHEET_COL_COUNT || 28;
  var rowData = sheet.getRange(rowNum, 1, 1, colCount).getValues()[0];
  var status  = String(rowData[C.STATUS   - 1] || '');
  var draftId = String(rowData[C.DRAFT_ID - 1] || '').trim();
  var notes   = String(rowData[C.NOTES    - 1] || '');
  if (status !== 'DRAFT_CREATED') {
    return { status: 'error', error: 'row status is not DRAFT_CREATED: ' + status };
  }
  if (!draftId) {
    return { status: 'error', error: 'DRAFT_ID is empty' };
  }
  var draft = GmailApp.getDraft(draftId);
  if (!draft) return { status: 'error', error: 'draft not found: ' + draftId };
  var msg = draft.getMessage();
  var to  = msg.getTo();
  // HARD GUARD — security boundary: refuse if To address is not mail-tester.com
  if (!/@(?:srv\d+\.)?mail-tester\.com$/i.test(String(to || ''))) {
    return { status: 'refused', reason: 'draft To address does not match mail-tester.com: ' + to };
  }
  // Send
  draft.send();
  var now = new Date().toISOString();
  var newNotes = (notes ? notes + ' ' : '') + '[MAILTESTER_PROBE]';
  if (newNotes.length > 1900) newNotes = newNotes.substring(newNotes.length - 1900);
  sheet.getRange(rowNum, C.STATUS       ).setValue('SENT');
  sheet.getRange(rowNum, C.SENT_DATE    ).setValue(now);
  sheet.getRange(rowNum, C.NOTES        ).setValue(newNotes);
  sheet.getRange(rowNum, C.LAST_UPDATED ).setValue(now);
  return { sent: true, to: to, draftId: draftId };
}

/**
 * menuRequeueDegradedTodayDrafts()
 * Requeues rows where STATUS='DRAFT_CREATED' and LAST_UPDATED falls in the
 * degraded-renderer window: 2026-06-12 08:20:00Z – 09:00:00Z (13:50–14:30 IST).
 *
 * For each matched row:
 *   - Appends '[REQUEUE_BUILDERBLOCK] old draft <DRAFT_ID> superseded; ' to NOTES (1900 cap)
 *   - Clears DRAFT_ID
 *   - Sets STATUS='NEW', LAST_UPDATED=now
 *
 * The pipeline will compose fresh drafts. Old Gmail drafts remain for the user to
 * bulk-delete — their IDs are captured in the return value and in NOTES.
 *
 * @returns {{requeued:number, rows:Array<{row,to,oldDraftId}>}}
 */
function menuRequeueDegradedTodayDrafts() {
  // ★2026-06-29 rewrite: this WAS hardcoded to a 2026-06-12 08:20-09:00Z incident window
  // (a one-shot tool whose name lied — it never tracked "today", so it requeued 0 on 06-29).
  // Now it SELF-IDENTIFIES degraded drafts by note content: DRAFT_CREATED rows whose body
  // fell back to the generic deterministic template because the Claude composer failed
  // (NOTES contains 'claude_api_error' — typically a credit-exhaustion HTTP 400). Requeue
  // (STATUS=NEW) so they recompose with REAL Claude content once credits are restored.
  //   • DRAFT_CREATED-only → never touches SENT/REPLIED/DRAFT_DELETED (terminal/human-killed).
  //   • Recent-only (LAST_UPDATED within RECENT_DAYS) → never resurrects ancient rows.
  //   • Idempotent → sets STATUS=NEW, so a re-run finds nothing (no double-requeue).
  // Reusable for the next outage.
  var RECENT_DAYS = 7;
  var cutoff = Date.now() - RECENT_DAYS * 24 * 3600 * 1000;
  var MARKER = 'claude_api_error';
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(CONFIG.DATA_SHEET);
  if (!sheet) return { status: 'error', error: 'data sheet not found' };
  var C = CONFIG.COLUMNS;
  var colCount = CONFIG.SHEET_COL_COUNT || 28;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { requeued: 0, rows: [] };
  var data = sheet.getRange(2, 1, lastRow - 1, colCount).getValues();
  var requeued = 0;
  var skippedStale = 0;
  var rows = [];
  var now = new Date().toISOString();
  for (var i = 0; i < data.length; i++) {
    var rowNum = i + 2;
    var status = String(data[i][C.STATUS - 1] || '');
    if (status !== 'DRAFT_CREATED') continue;
    var notes = String(data[i][C.NOTES - 1] || '');
    if (notes.indexOf(MARKER) < 0) continue;   // not a Claude-degraded draft
    // Recent-only guard (skip drafts whose generic body predates this outage window).
    var lastUpdRaw = data[i][C.LAST_UPDATED - 1];
    var ts = 0;
    try { var d = (lastUpdRaw instanceof Date) ? lastUpdRaw : new Date(lastUpdRaw); ts = d.getTime(); } catch (_) {}
    if (ts && ts < cutoff) { skippedStale++; continue; }
    var draftId = String(data[i][C.DRAFT_ID - 1] || '').trim();
    var email   = String(data[i][C.EMAIL - 1] || '');
    var newNotes = '[REQUEUE_CLAUDE_RECOVER] old draft ' + (draftId || 'unknown') +
                   ' superseded (was generic deterministic fallback; Claude recovered); ' + notes;
    if (newNotes.length > 1900) newNotes = newNotes.substring(0, 1900);
    sheet.getRange(rowNum, C.NOTES       ).setValue(newNotes);
    sheet.getRange(rowNum, C.DRAFT_ID    ).setValue('');
    sheet.getRange(rowNum, C.STATUS      ).setValue('NEW');
    sheet.getRange(rowNum, C.LAST_UPDATED).setValue(now);
    requeued++;
    if (rows.length < 60) {
      rows.push({ row: rowNum, to: email, oldDraftId: draftId });
    }
  }
  return { requeued: requeued, skippedStale: skippedStale, marker: MARKER, recentDays: RECENT_DAYS, rows: rows };
}

/**
 * PATCH 2026-06-12-template-unify: Requeue prose-body DRAFT_CREATED rows by email list.
 * PATCH 2026-06-12-requeue-generic: Generalised to accept a comma-separated argS list
 *   of recipient emails instead of the previous hardcoded two-email whitelist.
 *
 * For each matching row with STATUS='DRAFT_CREATED':
 *   - Appends '[REQUEUE_TEMPLATE_UNIFY] old draft <DRAFT_ID> superseded; ' to NOTES (1900 cap)
 *   - Clears DRAFT_ID
 *   - Sets STATUS='NEW', LAST_UPDATED=now
 * Refuses (skips, reports) rows in any other status.
 *
 * @param {*} _ — ignored (arg1 placeholder for admin_run compat)
 * @param {string} argS — comma-separated list of recipient email addresses to target
 * @returns {{requeued:number, rows:Array<{row,to,oldDraftId}>, skipped:Array<{row,to,status}>}}
 */
function menuRequeueTemplateUnifyRows(_, argS) {
  var rawList = String(argS || '').trim();
  if (!rawList) {
    return { status: 'error', error: 'argS is required: pass a comma-separated list of recipient emails' };
  }
  var TARGET_EMAILS = rawList.split(',').map(function(s) { return s.trim().toLowerCase(); }).filter(function(s) { return s.length > 0; });
  if (TARGET_EMAILS.length === 0) {
    return { status: 'error', error: 'argS produced an empty email list after parsing' };
  }
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(CONFIG.DATA_SHEET);
  if (!sheet) return { status: 'error', error: 'data sheet not found' };
  var C = CONFIG.COLUMNS;
  var colCount = CONFIG.SHEET_COL_COUNT || 28;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { requeued: 0, rows: [], skipped: [] };
  var data = sheet.getRange(2, 1, lastRow - 1, colCount).getValues();
  var requeued = 0;
  var rows = [];
  var skipped = [];
  var now = new Date().toISOString();
  for (var i = 0; i < data.length; i++) {
    var rowNum = i + 2;
    var status  = String(data[i][C.STATUS  - 1] || '');
    var email   = String(data[i][C.EMAIL   - 1] || '').trim().toLowerCase();
    var enrichedEmail = (C.ENRICHED_EMAIL && data[i][C.ENRICHED_EMAIL - 1])
      ? String(data[i][C.ENRICHED_EMAIL - 1] || '').trim().toLowerCase()
      : '';
    var matchedAddr = null;
    for (var ti = 0; ti < TARGET_EMAILS.length; ti++) {
      if (email === TARGET_EMAILS[ti] || enrichedEmail === TARGET_EMAILS[ti]) {
        matchedAddr = TARGET_EMAILS[ti];
        break;
      }
    }
    if (!matchedAddr) continue;
    // PATCH 2026-06-12-handoff-fix: also accept ERROR rows when argS was provided
    // explicitly (targeted requeue after a pipeline bug fix). DRAFT_CREATED is still
    // the primary guard; ERROR is allowed as a secondary path so a pair reset after
    // a seam regression does not require a separate tool. The argS requirement ensures
    // this is never a blanket-ERROR reset — only explicitly named addresses are touched.
    var isEligibleStatus = (status === 'DRAFT_CREATED') ||
      (status === 'ERROR' && rawList.trim().length > 0);
    if (!isEligibleStatus) {
      // Refuse rows in any other status — idempotent guard
      skipped.push({ row: rowNum, to: email || enrichedEmail, status: status });
      continue;
    }
    var draftId = String(data[i][C.DRAFT_ID - 1] || '').trim();
    var notes   = String(data[i][C.NOTES    - 1] || '');
    // PATCH 2026-06-12-handoff-fix: strip stale errRetry:N/M token from preserved
    // notes so the re-queued row starts with a fresh budget. Without this, a row
    // that previously exhausted errRetry:2/2 carries that token into the next run;
    // _seedOrPreserveErrRetry preserves it and the pipeline immediately writes ERROR
    // on the first failure without any retry headroom.
    var notesWithoutErrRetry = notes.replace(/\s*errRetry:\d+\/\d+/g, '').trim();
    var newNotes = '[REQUEUE_TEMPLATE_UNIFY] old draft ' + (draftId || 'unknown') +
      ' superseded; [HANDOFF_FIX retry] errRetry:0/2; ' + notesWithoutErrRetry;
    if (newNotes.length > 1900) newNotes = newNotes.substring(0, 1900);
    sheet.getRange(rowNum, C.NOTES       ).setValue(newNotes);
    sheet.getRange(rowNum, C.DRAFT_ID    ).setValue('');
    sheet.getRange(rowNum, C.STATUS      ).setValue('NEW');
    sheet.getRange(rowNum, C.LAST_UPDATED).setValue(now);
    // PATCH 2026-06-12-org-domain-gate: clear stale enrichment so re-enrichment
    // starts clean. Without this, re-queued rows retain the wrong ENRICHED_EMAIL /
    // EMAIL_SOURCE / EMAIL_CONFIDENCE from the prior (wrong-person) selection and
    // the pipeline skips enrichment for rows that already have ENRICHED_EMAIL set.
    if (C.ENRICHED_EMAIL)   sheet.getRange(rowNum, C.ENRICHED_EMAIL  ).setValue('');
    if (C.EMAIL_SOURCE)     sheet.getRange(rowNum, C.EMAIL_SOURCE    ).setValue('');
    if (C.EMAIL_CONFIDENCE) sheet.getRange(rowNum, C.EMAIL_CONFIDENCE).setValue('');
    requeued++;
    rows.push({ row: rowNum, to: email || enrichedEmail, oldDraftId: draftId });
  }
  Logger.log('[REQUEUE_TEMPLATE_UNIFY] requeued=' + requeued + ' rows=' + JSON.stringify(rows) + ' skipped=' + JSON.stringify(skipped));
  return { requeued: requeued, rows: rows, skipped: skipped };
}

/**
 * PATCH 2026-06-13-op-budget (Phase 3): reset ERROR rows whose errRetry budget was
 * exhausted by a SYSTEM failure (Gmail quota: "Service invoked too many times").
 *
 * Root cause analysis: the Gmail op-budget guards fix prevents TOMORROW's quota
 * exhaustion; the ERROR rows (row 297 confirmed) parked today because DRAFT_FAILED
 * triggered errRetry:1/2 then errRetry:2/2 — both failures caused by quota, not content.
 * With errRetry:2/2, the scanner's scoreStuckAutoRecoverEligible correctly returns
 * eligible:false, producing SKIP_FALL_THROUGH:no_whitelist_match. ERROR IS in
 * STUCK_AUTO_RECOVER_STATUSES — there is no whitelist gap. The recovery gap is the
 * exhausted errRetry counter for system-caused (quota) failures.
 *
 * Fix: reset the errRetry token for ERROR rows whose NOTES contain the quota error
 * signature. Bounded to rows from the last 3 days (system-error recency window).
 * Rows with non-quota ERROR notes are NOT touched (content failures keep their
 * exhausted budget — that's correct behavior).
 *
 * After reset: these rows become eligible for scoreStuckAutoRecoverEligible again.
 * The midnight PT quota reset (~12:30 AM IST / 12:30 PM IST during PDT) restores
 * the Gmail pool; the next scanner tick will re-attempt drafting.
 *
 * @returns {{ scanned: number, reset: number, rows: Array, skipped: Array }}
 */
function menuResetQuotaExhaustedErrorRows() {
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(CONFIG.DATA_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return { scanned: 0, reset: 0, rows: [], skipped: [] };

  var C = CONFIG.COLUMNS;
  var colCount = CONFIG.SHEET_COL_COUNT || 28;
  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, colCount).getValues();
  var now = new Date().toISOString();

  // Only reset ERROR rows whose notes contain the Gmail quota error signature.
  var QUOTA_SIG = 'Service invoked too many times';
  var scanned = 0, reset = 0;
  var rows = [], skipped = [];

  for (var i = 0; i < data.length; i++) {
    var status = (data[i][C.STATUS - 1] || '').toString().trim();
    if (status !== 'ERROR') continue;
    scanned++;

    var notes = (data[i][C.NOTES - 1] || '').toString();
    if (notes.indexOf(QUOTA_SIG) < 0) {
      skipped.push({ row: i + 2, reason: 'no_quota_sig_in_notes' });
      continue;
    }
    // Strip the exhausted errRetry token; inject a fresh one
    var notesClean = notes.replace(/\s*errRetry:\d+\/\d+/g, '').trim();
    var newNotes = ('[OP_BUDGET_RESET ' + now + '] errRetry reset (system quota failure, not content failure). ' +
                   'Will re-attempt after Gmail quota reset. errRetry:0/2 | ' + notesClean)
                   .substring(0, 1900);
    var rowNum = i + 2;
    try {
      sheet.getRange(rowNum, C.NOTES).setValue(newNotes);
      sheet.getRange(rowNum, C.LAST_UPDATED).setValue(now);
      reset++;
      rows.push({ row: rowNum, email: (data[i][C.EMAIL - 1] || '').toString().trim() ||
                                      (data[i][C.ENRICHED_EMAIL - 1] || '').toString().trim() || '<unknown>' });
    } catch (writeErr) {
      skipped.push({ row: rowNum, reason: 'write_error: ' + writeErr.message });
    }
  }

  Logger.log('[menuResetQuotaExhaustedErrorRows] scanned=' + scanned + ' reset=' + reset +
             ' rows=' + JSON.stringify(rows));
  return { scanned: scanned, reset: reset, rows: rows, skipped: skipped };
}

// ═══════════════════════════════════════════════════════════════════════
// FOLLOW-UP DIAGNOSTICS (2026-06-13-followup-thread)
// ═══════════════════════════════════════════════════════════════════════

/**
 * menuFollowupAudit — READ-ONLY follow-up health report.
 *
 * Returns:
 *   totalRows        — total FollowUps sheet rows (excl. header)
 *   pendingByStage   — { '1': n, '2': n, '3': n } PENDING counts per stage
 *   duplicateGroups  — number of (email,stage) groups with >1 PENDING row
 *   emptyThreadIdMainRows — count of MAIN sheet rows with SENT-family status + empty THREAD_ID (Path-B-risk population)
 *
 * Bridge-callable: /exec?action=admin_run&fn=menuFollowupAudit&token=<ADMIN>
 */
function menuFollowupAudit() {
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);

  // ── FollowUps sheet analysis ──
  var fuSheet = ss.getSheetByName('FollowUps');
  var totalRows = 0;
  var pendingByStage = {};
  var duplicateGroups = 0;

  if (fuSheet) {
    var fuData = fuSheet.getDataRange().getValues();
    if (fuData.length >= 2) {
      totalRows = fuData.length - 1;
      var fuHeaders = fuData[0].map(function(h) { return (h || '').toString().trim(); });
      var fuColStatus = fuHeaders.indexOf('Status');
      var fuColStage  = fuHeaders.indexOf('Stage');
      var fuColEmail  = fuHeaders.indexOf('Email');

      var pendingGroupMap = {};

      for (var fi = 1; fi < fuData.length; fi++) {
        var fuStatus = fuColStatus >= 0 ? (fuData[fi][fuColStatus] || '').toString().trim() : '';
        var fuStage  = fuColStage  >= 0 ? (fuData[fi][fuColStage]  || '').toString().trim() : '';
        var fuEmail  = fuColEmail  >= 0 ? (fuData[fi][fuColEmail]  || '').toString().trim().toLowerCase() : '';

        if (fuStatus === 'PENDING') {
          pendingByStage[fuStage] = (pendingByStage[fuStage] || 0) + 1;
          var pgKey = fuEmail + '|' + fuStage;
          pendingGroupMap[pgKey] = (pendingGroupMap[pgKey] || 0) + 1;
        }
      }

      Object.keys(pendingGroupMap).forEach(function(k) {
        if (pendingGroupMap[k] > 1) duplicateGroups++;
      });
    }
  }

  // ── Main sheet: SENT-family rows with empty THREAD_ID (Path-B-risk population) ──
  var emptyThreadIdMainRows = 0;
  try {
    var mainSheet = ss.getSheetByName(CONFIG.DATA_SHEET);
    if (mainSheet) {
      var C = CONFIG.COLUMNS;
      var sentFamilyStatuses = ['SENT', 'FOLLOWUP_1', 'FOLLOWUP_2', 'FOLLOWUP_3'];
      var lastRow = mainSheet.getLastRow();
      if (lastRow >= 2) {
        var mainData = mainSheet.getRange(2, 1, lastRow - 1, Math.max(C.THREAD_ID, C.STATUS)).getValues();
        mainData.forEach(function(row) {
          var st = (row[C.STATUS - 1] || '').toString().trim();
          var tid = (row[C.THREAD_ID - 1] || '').toString().trim();
          if (sentFamilyStatuses.indexOf(st) >= 0 && !tid) {
            emptyThreadIdMainRows++;
          }
        });
      }
    }
  } catch (mainErr) {
    Logger.log('[menuFollowupAudit] Main sheet scan failed: ' + mainErr.message);
  }

  var result = {
    totalRows: totalRows,
    pendingByStage: pendingByStage,
    duplicateGroups: duplicateGroups,
    emptyThreadIdMainRows: emptyThreadIdMainRows
  };
  Logger.log('[menuFollowupAudit] ' + JSON.stringify(result));
  return result;
}

/**
 * menuPurgeDuplicateFollowups — WRITE: for each (email,stage) PENDING group,
 * keep the earliest-scheduled row, mark the rest CANCELLED.
 *
 * Lock-guarded (script lock) to prevent race with daily trigger.
 * Idempotent — safe to re-run.
 *
 * Returns: { groupsScanned, cancelled, rows }
 *
 * Bridge-callable: /exec?action=admin_run&fn=menuPurgeDuplicateFollowups&token=<ADMIN>
 */
function menuPurgeDuplicateFollowups() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    return { status: 'busy', error: 'pipeline_busy',
             message: 'Another pipeline run holds the lock. Retry in 1-2 minutes.' };
  }
  try {
    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var fuSheet = ss.getSheetByName('FollowUps');
    if (!fuSheet) return { groupsScanned: 0, cancelled: 0, rows: [] };

    var fuData = fuSheet.getDataRange().getValues();
    if (fuData.length < 2) return { groupsScanned: 0, cancelled: 0, rows: [] };

    var fuHeaders = fuData[0].map(function(h) { return (h || '').toString().trim(); });
    var fuIdx = {};
    fuHeaders.forEach(function(h, i) { fuIdx[h] = i; });

    var colStatus  = fuIdx['Status'];
    var colStage   = fuIdx['Stage'];
    var colEmail   = fuIdx['Email'];
    var colSchedDate = fuIdx['ScheduledDate'];
    var colNotes   = fuIdx['Notes'];

    // Build per (email,stage) group list
    var groups = {};
    for (var gi = 1; gi < fuData.length; gi++) {
      var gStatus = colStatus !== undefined ? (fuData[gi][colStatus] || '').toString().trim() : '';
      if (gStatus !== 'PENDING') continue;
      var gEmail = colEmail !== undefined ? (fuData[gi][colEmail] || '').toString().trim().toLowerCase() : '';
      var gStage = colStage !== undefined ? (fuData[gi][colStage] || '').toString().trim() : '';
      if (!gEmail || !gStage) continue;

      var gKey = gEmail + '|' + gStage;
      var gSchedMs = colSchedDate !== undefined && fuData[gi][colSchedDate]
        ? (new Date(fuData[gi][colSchedDate]).getTime() || 0) : 0;

      if (!groups[gKey]) groups[gKey] = [];
      groups[gKey].push({ rowIdx: gi, scheduledDateMs: gSchedMs });
    }

    var groupsScanned = Object.keys(groups).length;
    var cancelled = 0;
    var cancelledRows = [];

    Object.keys(groups).forEach(function(key) {
      var group = groups[key];
      if (group.length < 2) return;
      // Sort ascending; keep first
      group.sort(function(a, b) {
        return a.scheduledDateMs !== b.scheduledDateMs
          ? a.scheduledDateMs - b.scheduledDateMs
          : a.rowIdx - b.rowIdx;
      });
      for (var ci = 1; ci < group.length; ci++) {
        var cancelRowIdx = group[ci].rowIdx;
        try {
          fuSheet.getRange(cancelRowIdx + 1, colStatus + 1).setValue('CANCELLED');
          if (colNotes !== undefined) {
            fuSheet.getRange(cancelRowIdx + 1, colNotes + 1).setValue('[DUP_FOLLOWUP] superseded by menuPurgeDuplicateFollowups');
          }
          cancelled++;
          cancelledRows.push({ sheetRow: cancelRowIdx + 1, key: key });
        } catch (cancelErr) {
          Logger.log('[menuPurgeDuplicateFollowups] Could not cancel row ' + (cancelRowIdx + 1) + ': ' + cancelErr.message);
        }
      }
    });

    Logger.log('[menuPurgeDuplicateFollowups] groupsScanned=' + groupsScanned + ' cancelled=' + cancelled);
    return { groupsScanned: groupsScanned, cancelled: cancelled, rows: cancelledRows };

  } finally {
    lock.releaseLock();
  }
}

// ═══════════════════════════════════════════════════════════════════════
// ORG-GATE SUBSTR FIX REQUEUE (2026-06-13-orggate-substr)
// ═══════════════════════════════════════════════════════════════════════

/**
 * menuRequeueOrgGateStranded — reprocess leads stranded by the old exact-token
 * org-domain gate. Targets rows whose NOTES contain "[ORG_DOMAIN_GATE]" OR
 * whose STATUS is NEEDS_EMAIL_REVIEW with empty ENRICHED_EMAIL (gate-stranded
 * leads land in NEEDS_EMAIL_REVIEW with empty enrichedEmail).
 *
 * For each matching row:
 *   - Clears ENRICHED_EMAIL, EMAIL_SOURCE, EMAIL_CONFIDENCE so re-enrichment
 *     starts clean under the fixed substring gate.
 *   - Sets STATUS = 'NEW', LAST_UPDATED = now.
 *   - Preserves existing NOTES, appends '[ORGGATE_FIX_REQUEUE]' marker.
 *   - Does NOT touch EMAIL (col F / sheet-truth — keep what APK captured).
 *
 * After reset, these rows are in STUCK_AUTO_RECOVER_STATUSES (NEW) and will
 * re-dispatch on the next scanner tick. With mesaschool.co now passing the
 * gate, parth@mesaschool.co will be selected as sheet_captured on the next
 * enrichment pass.
 *
 * Bridge-callable:
 *   /exec?action=admin_run&fn=menuRequeueOrgGateStranded&token=<ADMIN>
 *
 * @returns {{ scanned: number, requeued: number, rows: Array, skipped: Array }}
 */
function menuRequeueOrgGateStranded() {
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(CONFIG.DATA_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return { scanned: 0, requeued: 0, rows: [], skipped: [] };

  var C = CONFIG.COLUMNS;
  var colCount = CONFIG.SHEET_COL_COUNT || 28;
  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, colCount).getValues();
  var now = new Date().toISOString();
  var scanned = 0, requeued = 0;
  var rows = [], skipped = [];

  var ORG_GATE_SIG = '[ORG_DOMAIN_GATE]';

  for (var i = 0; i < data.length; i++) {
    var rowNum  = i + 2;
    var status  = (data[i][C.STATUS - 1] || '').toString().trim();
    var notes   = (data[i][C.NOTES  - 1] || '').toString();
    var enrichedEmail = C.ENRICHED_EMAIL ? (data[i][C.ENRICHED_EMAIL - 1] || '').toString().trim() : '';

    // Qualify: NOTES contain gate signature, OR NEEDS_EMAIL_REVIEW with empty enrichedEmail
    var hasGateSig      = notes.indexOf(ORG_GATE_SIG) >= 0;
    var isEmptyReview   = (status === 'NEEDS_EMAIL_REVIEW' && enrichedEmail === '');

    if (!hasGateSig && !isEmptyReview) continue;
    scanned++;

    // Skip rows already in NEW (already requeued by a prior run — idempotency)
    if (status === 'NEW') {
      skipped.push({ row: rowNum, reason: 'already_NEW' });
      continue;
    }

    // Build updated notes: preserve existing, strip stale errRetry, add ORGGATE marker
    var notesClean = notes.replace(/\s*errRetry:\d+\/\d+/g, '').trim();
    var newNotes = ('[ORGGATE_FIX_REQUEUE ' + now + '] re-enrich under fixed substring gate. ' +
                   notesClean).substring(0, 1900);

    try {
      sheet.getRange(rowNum, C.STATUS).setValue('NEW');
      sheet.getRange(rowNum, C.LAST_UPDATED).setValue(now);
      sheet.getRange(rowNum, C.NOTES).setValue(newNotes);
      if (C.ENRICHED_EMAIL)   sheet.getRange(rowNum, C.ENRICHED_EMAIL  ).setValue('');
      if (C.EMAIL_SOURCE)     sheet.getRange(rowNum, C.EMAIL_SOURCE    ).setValue('');
      if (C.EMAIL_CONFIDENCE) sheet.getRange(rowNum, C.EMAIL_CONFIDENCE).setValue('');
      requeued++;
      rows.push({
        row:    rowNum,
        status: status,
        reason: hasGateSig ? 'org_gate_sig_in_notes' : 'needs_email_review_empty_enriched',
        email:  (data[i][C.EMAIL - 1] || '').toString().trim() || '<none>'
      });
    } catch (writeErr) {
      skipped.push({ row: rowNum, reason: 'write_error: ' + writeErr.message });
    }
  }

  Logger.log('[menuRequeueOrgGateStranded] scanned=' + scanned + ' requeued=' + requeued +
             ' rows=' + JSON.stringify(rows));
  return { scanned: scanned, requeued: requeued, rows: rows, skipped: skipped };
}

// ─── menuRequeueReviewLeads (2026-06-13-sheetmail-fallthrough) ────────────────
/**
 * menuRequeueReviewLeads — reset NEEDS_EMAIL_REVIEW leads (and any rows with
 * [SHEET_EMAIL_UNDELIVERABLE] or [ORG_DOMAIN_GATE] or no enrichedEmail) to
 * STATUS=NEW with cleared ENRICHED_EMAIL/EMAIL_SOURCE/EMAIL_CONFIDENCE so the
 * full vendor waterfall re-runs under the sheetmail-fallthrough fix.
 *
 * Targets:
 *   - STATUS = NEEDS_EMAIL_REVIEW with empty ENRICHED_EMAIL (vendor never tried)
 *   - NOTES contains [SHEET_EMAIL_UNDELIVERABLE] (old dead-end path)
 *   - NOTES contains [ORG_DOMAIN_GATE] (gate-stranded leads)
 *
 * Does NOT touch col-F EMAIL (sheet truth). The waterfall will clear lead.email
 * internally during the sheetmail-fallthrough run if Reoon flags it again.
 *
 * Idempotent: rows already in NEW are skipped.
 *
 * Bridge-callable:
 *   /exec?action=admin_run&fn=menuRequeueReviewLeads&token=<ADMIN>
 *
 * @returns {{ scanned: number, requeued: number, rows: Array, skipped: Array }}
 */
function menuRequeueReviewLeads() {
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(CONFIG.DATA_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return { scanned: 0, requeued: 0, rows: [], skipped: [] };

  var C = CONFIG.COLUMNS;
  var colCount = CONFIG.SHEET_COL_COUNT || 28;
  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, colCount).getValues();
  var now = new Date().toISOString();
  var scanned = 0, requeued = 0;
  var rows = [], skipped = [];

  var SHEET_UNDELIV_SIG = '[SHEET_EMAIL_UNDELIVERABLE]';
  var ORG_GATE_SIG      = '[ORG_DOMAIN_GATE]';

  for (var i = 0; i < data.length; i++) {
    var rowNum  = i + 2;
    var status  = (data[i][C.STATUS - 1] || '').toString().trim();
    var notes   = (data[i][C.NOTES  - 1] || '').toString();
    var enrichedEmail = C.ENRICHED_EMAIL ? (data[i][C.ENRICHED_EMAIL - 1] || '').toString().trim() : '';

    var hasSheetUndelivSig = notes.indexOf(SHEET_UNDELIV_SIG) >= 0;
    var hasOrgGateSig      = notes.indexOf(ORG_GATE_SIG) >= 0;
    var isEmptyReview      = (status === 'NEEDS_EMAIL_REVIEW' && enrichedEmail === '');

    // Qualify: any of the three signatures
    if (!hasSheetUndelivSig && !hasOrgGateSig && !isEmptyReview) continue;
    scanned++;

    // Skip rows already in NEW (idempotency)
    if (status === 'NEW') {
      skipped.push({ row: rowNum, reason: 'already_NEW' });
      continue;
    }

    var reason = hasSheetUndelivSig ? 'sheet_email_undeliv_sig'
               : hasOrgGateSig     ? 'org_gate_sig'
               : 'needs_email_review_empty_enriched';

    var notesClean = notes.replace(/\s*errRetry:\d+\/\d+/g, '').trim();
    var newNotes = ('[SHEETMAIL_FALLTHROUGH_REQUEUE ' + now + '] re-enrich under sheetmail-fallthrough fix. ' +
                   notesClean).substring(0, 1900);

    try {
      sheet.getRange(rowNum, C.STATUS).setValue('NEW');
      sheet.getRange(rowNum, C.LAST_UPDATED).setValue(now);
      sheet.getRange(rowNum, C.NOTES).setValue(newNotes);
      if (C.ENRICHED_EMAIL)   sheet.getRange(rowNum, C.ENRICHED_EMAIL  ).setValue('');
      if (C.EMAIL_SOURCE)     sheet.getRange(rowNum, C.EMAIL_SOURCE    ).setValue('');
      if (C.EMAIL_CONFIDENCE) sheet.getRange(rowNum, C.EMAIL_CONFIDENCE).setValue('');
      requeued++;
      rows.push({
        row:    rowNum,
        status: status,
        reason: reason,
        email:  (data[i][C.EMAIL - 1] || '').toString().trim() || '<none>'
      });
    } catch (writeErr) {
      skipped.push({ row: rowNum, reason: 'write_error: ' + writeErr.message });
    }
  }

  Logger.log('[menuRequeueReviewLeads] scanned=' + scanned + ' requeued=' + requeued +
             ' rows=' + JSON.stringify(rows));
  return { scanned: scanned, requeued: requeued, rows: rows, skipped: skipped };
}

// ═══════════════════════════════════════════════════════════════════════
// FOLLOW-UP ORPHAN PURGE + ON-DEMAND RUNNER (2026-06-13-followup-ops)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Pure helper: returns true when a parent lead STATUS makes its follow-ups
 * permanently orphaned (parent will never be sent, so follow-ups can never
 * legitimately fire). Used by menuPurgeOrphanFollowUps for the per-row
 * predicate and independently testable.
 *
 * @param {string} status — the parent lead's current STATUS value
 * @returns {boolean}
 */
function _followUpParentIsOrphan(status) {
  var ORPHAN_STATUSES = {
    'DRAFT_DELETED': true,
    'BOUNCED_HARD':  true,
    'BOUNCED_SOFT':  true,
    'DUPLICATE':     true,
    'SKIPPED':       true,
    'ERROR':         true,
    'RESPONDED':     true,
    'REPLIED':       true
  };
  return !!(status && ORPHAN_STATUSES[status.toString().trim()]);
}

/**
 * menuPurgeOrphanFollowUps — WRITE: scan the FollowUps sheet for PENDING rows
 * whose parent lead is in a terminal/non-send state (DRAFT_DELETED, BOUNCED_*,
 * DUPLICATE, SKIPPED, ERROR, RESPONDED) OR whose parent row no longer exists.
 * These rows will NEVER fire legitimately and waste lock-time on every trigger.
 *
 * Algorithm:
 *   1. Read FollowUps sheet once; build a set of unique ParentRow numbers.
 *   2. Read the DATA_SHEET in one pass; build a parentRow→status map (O(n) total,
 *      not O(n×m) per-row).
 *   3. For each PENDING FollowUp row: if parent is missing OR
 *      _followUpParentIsOrphan(status) → mark CANCELLED with '[ORPHAN_PURGE] parent <status>'.
 *   4. NEVER cancel rows whose parent is SENT/FOLLOWUP_1/FOLLOWUP_2/FOLLOWUP_3
 *      (those are legitimate and must remain PENDING to fire).
 *
 * Bounded: ≤ ORPHAN_PURGE_LIMIT rows processed per run (default 2000).
 * Idempotent: CANCELLED/SENT rows are skipped.
 *
 * Bridge-callable:
 *   /exec?action=admin_run&fn=menuPurgeOrphanFollowUps&token=<ADMIN>
 *
 * @returns {{ scanned: number, cancelled: number, byParentStatus: Object, skipped: number }}
 */
function menuPurgeOrphanFollowUps() {
  var ORPHAN_PURGE_LIMIT = 2000;

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(12000)) {
    return { status: 'busy', error: 'pipeline_busy',
             message: 'Another pipeline run is in progress. Retry in 1-2 minutes.' };
  }

  try {
    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var fuSheet = ss.getSheetByName('FollowUps');
    if (!fuSheet || fuSheet.getLastRow() < 2) {
      return { scanned: 0, cancelled: 0, byParentStatus: {}, skipped: 0, note: 'FollowUps sheet empty or missing' };
    }

    var fuData = fuSheet.getDataRange().getValues();
    var fuHeaders = fuData[0].map(function(h) { return (h || '').toString().trim(); });

    var colStatus    = fuHeaders.indexOf('Status');
    var colParentRow = fuHeaders.indexOf('ParentRow');
    var colEmail     = fuHeaders.indexOf('Email');
    var colNotes     = fuHeaders.indexOf('Notes');

    if (colStatus < 0) {
      return { scanned: 0, cancelled: 0, byParentStatus: {}, skipped: 0,
               note: 'FollowUps sheet missing Status column' };
    }

    // ── Step 1: Build parent-status map in one DATA_SHEET read ──
    var parentStatusMap = {};   // rowNum (1-indexed) → status string
    var emailStatusMap  = {};   // email (lowercase) → status string (fallback)

    try {
      var dataSheet = ss.getSheetByName(CONFIG.DATA_SHEET);
      if (dataSheet && dataSheet.getLastRow() >= 2) {
        var C = CONFIG.COLUMNS;
        var colCount = CONFIG.SHEET_COL_COUNT || 28;
        var sheetData = dataSheet.getRange(2, 1, dataSheet.getLastRow() - 1, colCount).getValues();
        for (var di = 0; di < sheetData.length; di++) {
          var rowNum1 = di + 2;  // 1-indexed sheet row
          var st = (sheetData[di][C.STATUS - 1] || '').toString().trim();
          var em = (sheetData[di][C.EMAIL  - 1] || '').toString().trim().toLowerCase();
          parentStatusMap[rowNum1] = st;
          if (em) emailStatusMap[em] = st;
        }
      }
    } catch (mapErr) {
      Logger.log('[menuPurgeOrphanFollowUps] parent-status map build error: ' + mapErr.message);
    }

    // ── Step 2: Scan FollowUps rows ──
    var scanned = 0, cancelled = 0, skipped = 0;
    var byParentStatus = {};

    for (var i = 1; i < fuData.length && scanned < ORPHAN_PURGE_LIMIT; i++) {
      var rowStatus = ((fuData[i][colStatus] || '') + '').trim();

      // Idempotent: skip non-PENDING rows
      if (rowStatus !== 'PENDING') {
        skipped++;
        continue;
      }

      scanned++;

      // Resolve parent status
      var parentStatus = '';
      var parentMissing = false;

      if (colParentRow >= 0 && fuData[i][colParentRow]) {
        var prNum = parseInt(fuData[i][colParentRow]);
        if (prNum > 1) {
          if (parentStatusMap.hasOwnProperty(prNum)) {
            parentStatus = parentStatusMap[prNum];
          } else {
            parentMissing = true;
          }
        }
      }

      // Fallback: look up by email when ParentRow not available or not found
      if (!parentMissing && !parentStatus && colEmail >= 0) {
        var fuEmail = ((fuData[i][colEmail] || '') + '').trim().toLowerCase();
        if (fuEmail && emailStatusMap.hasOwnProperty(fuEmail)) {
          parentStatus = emailStatusMap[fuEmail];
        } else if (fuEmail) {
          parentMissing = true;
        }
      }

      // Decide: keep SENT/FOLLOWUP parents; cancel orphan parents
      var shouldCancel = parentMissing || _followUpParentIsOrphan(parentStatus);

      if (!shouldCancel) {
        // Parent is SENT/FOLLOWUP_1/etc. — legitimately pending
        continue;
      }

      // Mark CANCELLED
      var cancelLabel = parentMissing ? 'parent_missing' : parentStatus;
      try {
        fuSheet.getRange(i + 1, colStatus + 1).setValue('CANCELLED');
        if (colNotes >= 0) {
          var existingNotes = ((fuData[i][colNotes] || '') + '').trim();
          var newNote = '[ORPHAN_PURGE] parent ' + cancelLabel +
                        (existingNotes ? ' | ' + existingNotes.substring(0, 200) : '');
          fuSheet.getRange(i + 1, colNotes + 1).setValue(newNote.substring(0, 500));
        }
        cancelled++;
        byParentStatus[cancelLabel] = (byParentStatus[cancelLabel] || 0) + 1;
      } catch (writeErr) {
        Logger.log('[menuPurgeOrphanFollowUps] Could not cancel row ' + (i + 1) + ': ' + writeErr.message);
      }
    }

    var result = { scanned: scanned, cancelled: cancelled, byParentStatus: byParentStatus, skipped: skipped };
    Logger.log('[menuPurgeOrphanFollowUps] ' + JSON.stringify(result));
    return result;

  } finally {
    lock.releaseLock();
  }
}

/**
 * menuRunFollowUpsNow — thin lock-guarded wrapper that invokes
 * processScheduledFollowUps() immediately (on-demand, not waiting for the
 * 9am daily trigger). Returns the same drafted/skipped/deferred/errored
 * summary that the daily trigger produces.
 *
 * Why a wrapper vs. calling processScheduledFollowUps directly:
 *   processScheduledFollowUps acquires its own internal lock, so calling it
 *   directly is fine; but a named admin-bridge entry point lets the whitelist
 *   route it cleanly without reflection, and gives a consistent log marker
 *   to distinguish on-demand runs from cron runs in the Logger.
 *
 * Bridge-callable:
 *   /exec?action=admin_run&fn=menuRunFollowUpsNow&token=<ADMIN>
 *
 * @returns {Object} result from processScheduledFollowUps, or an error object
 */
function menuRunFollowUpsNow() {
  Logger.log('[menuRunFollowUpsNow] On-demand follow-up run started at ' + new Date().toISOString());
  if (typeof processScheduledFollowUps !== 'function') {
    return { status: 'error', error: 'processScheduledFollowUps not defined' };
  }
  try {
    var result = processScheduledFollowUps();
    Logger.log('[menuRunFollowUpsNow] Done: ' + JSON.stringify(result));
    return result || { status: 'ok', note: 'processScheduledFollowUps returned no value' };
  } catch (e) {
    Logger.log('[menuRunFollowUpsNow] Error: ' + e.message);
    return { status: 'error', error: e.message };
  }
}

// ─── PATCH 2026-06-13-sheet1-search ─────────────────────────────────────────
/**
 * menuSearchSheet1 — read Sheet1 (APK raw capture tab) directly and return
 * rows where any of {fullName, organization, linkedinUrl, email} contains
 * argS (case-insensitive substring). Also returns sheet1TotalRows,
 * sheet2TotalRows, and the gap between them (intake-gap diagnostic).
 *
 * Why: the admin bridge's Sheet2-based find_lead / lead_search cannot read
 * Sheet1 (the raw audit tab). Sheet2 = UNIQUE(Sheet1!B2:G) so a lead that
 * appeared in Sheet2 came from Sheet1; one that NEVER appeared in Sheet2
 * but whose APK capture DID reach the server will still be in Sheet1. This
 * function reads Sheet1 directly and is the definitive answer to
 * "was this person ever captured?".
 *
 * Column layout (from CONFIG.SHEET1_COLUMNS):
 *   A=TIMESTAMP, B=LINKEDIN_URL, C=FULL_NAME, D=HEADLINE, E=DESIGNATION,
 *   F=ORGANIZATION, G=EMAIL, H=PHONE, I=WEBSITE, J=LOCATION,
 *   K=CONNECTION, L=CONFIDENCE, M=LEAD_UID
 *
 * Bridge-callable (read-only, no lock):
 *   /exec?action=admin_run&fn=menuSearchSheet1&argS=debleena&token=<ADMIN>
 *
 * @param {*} _  unused (arg1 placeholder for bridge arity)
 * @param {string} argS  case-insensitive search term
 * @returns {Object}  { matches[], sheet1TotalRows, sheet2TotalRows, gap, argS, timestamp }
 */
function menuSearchSheet1(_, argS) {
  var term = (argS || '').toString().toLowerCase().trim();
  var result = {
    argS: term,
    matches: [],
    sheet1TotalRows: 0,
    sheet2TotalRows: 0,
    gap: 0,
    timestamp: new Date().toISOString()
  };
  try {
    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);

    // ── Sheet1 read ──
    var sheet1 = ss.getSheetByName('Sheet1');
    if (!sheet1) {
      result.error = 'Sheet1 tab not found in spreadsheet';
      return result;
    }
    var last1 = sheet1.getLastRow();
    result.sheet1TotalRows = Math.max(0, last1 - 1);  // minus header row

    if (last1 > 1 && term) {
      var C1 = CONFIG.SHEET1_COLUMNS;
      var colCount1 = CONFIG.SHEET1_COL_COUNT || 13;
      var rows1 = sheet1.getRange(2, 1, last1 - 1, colCount1).getValues();
      for (var i = 0; i < rows1.length; i++) {
        var r = rows1[i];
        var linkedinUrl  = (r[C1.LINKEDIN_URL  - 1] || '').toString();
        var fullName     = (r[C1.FULL_NAME     - 1] || '').toString();
        var organization = (r[C1.ORGANIZATION  - 1] || '').toString();
        var email        = (r[C1.EMAIL         - 1] || '').toString();
        var leadUid      = (r[C1.LEAD_UID      - 1] || '').toString();
        var haystack = (linkedinUrl + ' ' + fullName + ' ' + organization + ' ' + email).toLowerCase();
        if (haystack.indexOf(term) >= 0) {
          result.matches.push({
            sheet1Row: i + 2,  // 1-indexed sheet row (row 1 = header)
            fullName: fullName,
            organization: organization,
            linkedinUrl: linkedinUrl,
            email: email,
            leadUid: leadUid || null
          });
        }
      }
    }

    // ── Sheet2 row count (UNIQUE materialized view) ──
    var sheet2 = ss.getSheetByName(CONFIG.DATA_SHEET);
    if (sheet2) {
      result.sheet2TotalRows = Math.max(0, sheet2.getLastRow() - 1);
    }

    result.gap = result.sheet1TotalRows - result.sheet2TotalRows;
  } catch (err) {
    result.error = err.message;
  }
  return result;
}

// ─── PATCH 2026-06-17-capture-audit ──────────────────────────────────────────
// Manual lead injector — rescues a lead the APK couldn't deliver (degraded scan
// rejected by the shared-secret gate, or never transmitted). Writes a row into
// Sheet1 via the SAME intake surface the APK capture path uses (Sheet1 append →
// UNIQUE spill → Sheet2 → pipeline enrich+draft). Bypasses both the app and the
// auth gate; admin-token-gated through the admin_run whitelist. Email is left
// blank by default so the vendor waterfall (Apollo people-match by LinkedIn URL)
// resolves it — exactly as for a normal capture.
//
// argS: a bare LinkedIn profile URL, OR JSON {"url","name","org","email"}.
// Tests/diagnosis: menuShowCaptureAudit reads the audit trail this also writes to.
function menuInjectLeadFromUrl(_, argS) {
  var raw = String(argS || '').trim();
  if (!raw) {
    return { status: 'error', error: 'argS required: a LinkedIn /in/ URL, or JSON {url,name,org,email}' };
  }
  var spec = {};
  if (raw.charAt(0) === '{') {
    try { spec = JSON.parse(raw); }
    catch (e) { return { status: 'error', error: 'bad JSON in argS: ' + e.message }; }
  } else {
    spec = { url: raw };
  }
  // Canonicalize: drop query string / fragment / trailing slash (utm noise etc.).
  var url = String(spec.url || spec.linkedinUrl || '').trim().replace(/[?#].*$/, '').replace(/\/+$/, '');
  if (!/^https?:\/\/([a-z0-9-]+\.)?linkedin\.com\/in\/[^\s/?#]+/i.test(url)) {
    return { status: 'error', error: 'not a LinkedIn profile URL: ' + (url || '(empty)') };
  }
  var name  = String(spec.name  || spec.fullName     || '').trim();
  var org   = String(spec.org   || spec.organization || '').trim();
  var email = String(spec.email || '').trim();

  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var intake = ss.getSheetByName('Sheet1');
  if (!intake) return { status: 'error', error: 'Sheet1 (intake) not found' };
  if (typeof _ensureSheet2UniqueFormula === 'function') {
    try { _ensureSheet2UniqueFormula(ss); } catch (_) {}
  }

  var S1 = CONFIG.SHEET1_COLUMNS;
  var now = new Date().toISOString();
  var s1row = [];
  for (var j = 0; j < (CONFIG.SHEET1_COL_COUNT || 13); j++) s1row.push('');
  s1row[S1.TIMESTAMP    - 1] = now;
  s1row[S1.LINKEDIN_URL - 1] = url;
  s1row[S1.FULL_NAME    - 1] = name;
  s1row[S1.ORGANIZATION - 1] = org;
  s1row[S1.EMAIL        - 1] = email;   // usually blank → pipeline enriches
  s1row[S1.CONFIDENCE   - 1] = 100;
  s1row[S1.LEAD_UID     - 1] = Utilities.getUuid();
  // PATCH 2026-06-17-filter-fix: strip any stray Sheet1 basic filter first — with
  // one present, appendRow silently no-ops and the row is lost (no error thrown).
  if (typeof _ensureNoSheet1Filter_ === 'function') _ensureNoSheet1Filter_(intake);
  intake.appendRow(s1row);

  // Mirror the capture trail in the audit log so manual rescues are visible too.
  if (typeof _auditCapture_ === 'function') {
    try {
      _auditCapture_({ fullName: name, linkedinUrl: url, organization: org,
                       email: email, source: 'manual_inject', confidence: 100 },
                     null, 'MANUAL_INJECT');
    } catch (_) {}
  }

  // Kick the pipeline now (same as the capture path) so it doesn't wait on cron.
  if (typeof _kickoffAfterCapture === 'function') {
    try { _kickoffAfterCapture('MANUAL_INJECT'); } catch (_) {}
  }

  // Locate the materialized Sheet2 row by canonical URL (new tuples spill at bottom).
  var dataSheet = ss.getSheetByName(CONFIG.DATA_SHEET);
  var C = CONFIG.COLUMNS;
  var foundRow = 0;
  for (var attempt = 0; attempt < 5 && !foundRow && dataSheet; attempt++) {
    if (attempt > 0) Utilities.sleep(400);
    SpreadsheetApp.flush();
    var last2 = dataSheet.getLastRow();
    if (last2 >= 2) {
      var urlCol = dataSheet.getRange(2, C.LINKEDIN_URL, last2 - 1, 1).getValues();
      for (var r = urlCol.length - 1; r >= 0; r--) {
        var got = String(urlCol[r][0] || '').replace(/[?#].*$/, '').replace(/\/+$/, '');
        if (got.toLowerCase() === url.toLowerCase()) { foundRow = r + 2; break; }
      }
    }
  }

  return {
    status: 'ok',
    injected: true,
    sheet1Rows: intake.getLastRow(),
    materializedRow: foundRow || 'pending_recalc',
    url: url,
    name: name || '(none)',
    org: org || '(blank — Apollo people-match will resolve)',
    email: email || '(blank — vendor waterfall will resolve)',
    note: 'Injected via Sheet1 capture path; pipeline will enrich email + draft. ' +
          'Bypasses the APK and the shared-secret gate.'
  };
}

// Read the CaptureAudit trail (PATCH 2026-06-17-capture-audit). Returns the last
// N rows (default 25, max 200); optional argS filters rows whose JSON contains it
// (case-insensitive) — e.g. a name or outcome like 'REJECTED_UNAUTHORIZED'.
function menuShowCaptureAudit(a, argS) {
  var n = (typeof a === 'number' && a > 0) ? Math.min(a, 200) : 25;
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var tab = ss.getSheetByName('CaptureAudit');
  if (!tab) {
    return { status: 'ok', rows: [], total: 0,
             note: 'CaptureAudit tab not created yet — no POST has hit the new code path since deploy.' };
  }
  var lr = tab.getLastRow();
  if (lr < 2) return { status: 'ok', rows: [], total: 0 };
  var lc = tab.getLastColumn();
  var headers = tab.getRange(1, 1, 1, lc).getValues()[0];
  var start = Math.max(2, lr - n + 1);
  var vals = tab.getRange(start, 1, lr - start + 1, lc).getValues();
  var rows = vals.map(function(rv) {
    var o = {};
    for (var i = 0; i < headers.length; i++) o[String(headers[i])] = rv[i];
    return o;
  });
  var filter = String(argS || '').trim().toLowerCase();
  if (filter) {
    rows = rows.filter(function(o) { return JSON.stringify(o).toLowerCase().indexOf(filter) >= 0; });
  }
  return { status: 'ok', total: lr - 1, returned: rows.length, rows: rows,
           timestamp: new Date().toISOString() };
}

// ─── PATCH 2026-06-17-capture-audit (Sheet1 append-freeze diagnostic) ────────
// 2026-06-17 live finding: Sheet1's newest row is Sneha (Jun 15) and NOTHING
// appends after it — not the APK, not the production doPost path, not the
// manual injector — yet appendRow works on other tabs (CaptureAudit was created
// + written). appendRow to Sheet1 is a silent no-op (no thrown error). This
// probes the exact mechanism in ONE execution: does appendRow increment the row
// count within the execution, survive flush, and what Sheet1-specific blockers
// exist (grid cap, active filter, protections the script user can't edit). The
// probe row is marked DIAGPROBE and harmless (blank email → never drafts).
function menuDiagSheet1Append() {
  var out = { status: 'ok', ts: new Date().toISOString() };
  try {
    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sh = ss.getSheetByName('Sheet1');
    if (!sh) return { status: 'error', error: 'Sheet1 not found' };
    out.before      = sh.getLastRow();
    out.maxRows     = sh.getMaxRows();
    out.maxCols     = sh.getMaxColumns();
    out.hasFilter   = !!sh.getFilter();
    try {
      var pr = sh.getProtections(SpreadsheetApp.ProtectionType.RANGE) || [];
      var ps = sh.getProtections(SpreadsheetApp.ProtectionType.SHEET) || [];
      out.protRange = pr.length;
      out.protSheet = ps.length;
      out.canEditSheet = (ps.length > 0) ? ps[0].canEdit() : true;
    } catch (pe) { out.protErr = pe.message; }

    var marker = 'DIAGPROBE_' + out.before;
    var row = [];
    for (var j = 0; j < (CONFIG.SHEET1_COL_COUNT || 13); j++) row.push('');
    row[0] = new Date().toISOString();
    row[1] = 'https://www.linkedin.com/in/diagprobe-' + out.before;  // col B
    row[2] = marker;                                                  // col C (name)
    var threw = '';
    try { sh.appendRow(row); } catch (ae) { threw = ae.message; }
    out.appendThrew = threw || '(no error)';
    out.afterAppend = sh.getLastRow();
    try { SpreadsheetApp.flush(); } catch (_) {}
    out.afterFlush  = sh.getLastRow();
    // Read back what is actually at the (post-flush) last row.
    var lastVals = sh.getRange(out.afterFlush, 1, 1, 3).getValues()[0];
    out.lastRowColC = String(lastVals[2] || '');
    out.markerExpected = marker;
    out.appendPersisted = (out.lastRowColC === marker);
    out.incremented = (out.afterAppend === out.before + 1);
  } catch (err) {
    out.status = 'error';
    out.error = err.message;
    out.stack = (err.stack || '').substring(0, 300);
  }
  return out;
}

// PATCH 2026-06-17-filter-fix: explicit one-shot remover for the Sheet1 basic
// filter that silently froze intake (06-15 → 06-17). Safe + idempotent: removing
// a basic filter never deletes data. Capture appends now also strip it defensively
// (_ensureNoSheet1Filter_), but this gives immediate manual control + verification.
function menuRemoveSheet1Filter() {
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sh = ss.getSheetByName('Sheet1');
  if (!sh) return { status: 'error', error: 'Sheet1 not found' };
  var had = !!sh.getFilter();
  if (had) {
    try { sh.getFilter().remove(); }
    catch (e) { return { status: 'error', error: 'filter.remove() threw: ' + e.message }; }
  }
  return {
    status: 'ok',
    filterFound: had,
    filterRemoved: had,
    lastRow: sh.getLastRow(),
    note: had ? 'Removed the basic filter that was silently turning Sheet1 appendRow into a no-op. Intake is unblocked.'
              : 'No filter present on Sheet1.'
  };
}

// PATCH 2026-06-17-employer-reconcile: reset a specific Sheet2 lead to NEW so the
// scanner reprocesses it cleanly. Use when a lead was drafted with stale/incorrect
// data (e.g. Samarth Masson — drafted to the wrong employer BEFORE the headline-vs-org
// reconciliation shipped). Clears DRAFT_ID + enrichment state so the rerun starts
// fresh; the reconciliation + waterfall then produce the corrected identity. The
// previously-created Gmail draft (if any) is ORPHANED — delete it manually (no
// mail-delete ops by policy). arg1 = rowNum (>=2). Lock-guarded (sheet writes).
function menuResetLeadToNew(a, _) {
  var rowNum = (typeof a === 'number') ? a : parseInt(a, 10);
  if (!rowNum || rowNum < 2) return { status: 'error', error: 'arg1 rowNum (>=2) required' };
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sh = ss.getSheetByName(CONFIG.DATA_SHEET);
  if (!sh) return { status: 'error', error: 'data sheet not found' };
  if (rowNum > sh.getLastRow()) return { status: 'error', error: 'rowNum past last row (' + sh.getLastRow() + ')' };
  var C = CONFIG.COLUMNS;
  var name = String(sh.getRange(rowNum, C.FULL_NAME).getValue() || '');
  var before = String(sh.getRange(rowNum, C.STATUS).getValue() || '');
  var oldDraft = C.DRAFT_ID ? String(sh.getRange(rowNum, C.DRAFT_ID).getValue() || '') : '';
  sh.getRange(rowNum, C.STATUS).setValue('NEW');
  if (C.DRAFT_ID)         sh.getRange(rowNum, C.DRAFT_ID).setValue('');
  if (C.ENRICHED_EMAIL)   sh.getRange(rowNum, C.ENRICHED_EMAIL).setValue('');
  if (C.EMAIL_SOURCE)     sh.getRange(rowNum, C.EMAIL_SOURCE).setValue('');
  if (C.EMAIL_CONFIDENCE) sh.getRange(rowNum, C.EMAIL_CONFIDENCE).setValue('');
  if (C.NOTES) {
    var oldNotes = String(sh.getRange(rowNum, C.NOTES).getValue() || '');
    sh.getRange(rowNum, C.NOTES).setValue((oldNotes + ' [RESET_FOR_REPROCESS]').trim().substring(0, 480));
  }
  if (C.LAST_UPDATED) sh.getRange(rowNum, C.LAST_UPDATED).setValue(new Date().toISOString());
  return {
    status: 'ok', row: rowNum, name: name, statusBefore: before, statusAfter: 'NEW',
    orphanedDraftId: oldDraft || '(none)',
    note: 'Reset to NEW; scanner will reprocess with current logic. Any previously-created Gmail draft is orphaned — delete it manually.'
  };
}

// PATCH 2026-06-18-draftsync-probe: definitively test whether stored DRAFT_IDs
// still resolve via GmailApp.getDraft() — to distinguish a TRUE deletion from a
// false DRAFT_DELETED caused by the syncer treating a transient getDraft() error
// as "draft gone". argS = comma-separated draftIds. Returns per-id exists/error +
// the live draft count + sample real ids (for format comparison). Read-only.
function menuProbeDraftId(a, argS) {
  var ids = String(argS || '').split(',').map(function(s) { return s.trim(); }).filter(Boolean);
  var out = { probed: [], ts: new Date().toISOString() };
  ids.forEach(function(id) {
    var r = { id: id, exists: false, error: '', to: '' };
    try {
      var d = GmailApp.getDraft(id);
      r.exists = !!d;
      if (d) { try { r.to = d.getMessage().getTo(); } catch (_) {} }
    } catch (e) { r.error = (e && e.message) || String(e); }
    out.probed.push(r);
  });
  try {
    var all = GmailApp.getDrafts();
    out.totalDrafts = all.length;
    out.sampleRealIds = all.slice(0, 5).map(function(d) { return d.getId(); });
  } catch (e) { out.draftsErr = (e && e.message) || String(e); }
  return out;
}

// PATCH 2026-06-19-fu-recipient: probe HOW to address a follow-up reply to the LEAD
// (not self). On a self-started thread, createDraftReply targets the sender (you).
// Test (a) createDraftReply with a `to` override and (b) createDraftReplyAll, read
// back each draft's actual To, then delete the probe drafts. argS = threadId.
function menuTestReplyTo(a, argS) {
  var threadId = String(argS || '').trim();
  if (!threadId) return { status: 'error', error: 'argS=threadId required' };
  var thread;
  try { thread = GmailApp.getThreadById(threadId); } catch (e) { return { status: 'error', error: e.message }; }
  if (!thread) return { status: 'error', error: 'thread not found: ' + threadId };
  var out = { status: 'ok', threadId: threadId, tests: [] };
  try {
    var d1 = thread.createDraftReply('probe', { htmlBody: 'probe', to: 'fu-probe-a@example.com' });
    var t1 = ''; try { t1 = d1.getMessage().getTo(); } catch (_) {}
    out.tests.push({ method: 'createDraftReply+to', actualTo: t1, toHonored: (t1 || '').toLowerCase().indexOf('fu-probe-a') >= 0 });
    try { d1.deleteDraft(); } catch (_) {}
  } catch (e) { out.tests.push({ method: 'createDraftReply+to', error: (e && e.message) || String(e) }); }
  try {
    var d2 = thread.createDraftReplyAll('probe', { htmlBody: 'probe' });
    var t2 = ''; try { t2 = d2.getMessage().getTo(); } catch (_) {}
    out.tests.push({ method: 'createDraftReplyAll', actualTo: t2 });
    try { d2.deleteDraft(); } catch (_) {}
  } catch (e) { out.tests.push({ method: 'createDraftReplyAll', error: (e && e.message) || String(e) }); }
  return out;
}

// PATCH 2026-06-19-fu-recipient: end-to-end verify the FIXED follow-up path. Creates a
// threaded draft to a PROBE recipient (not a real lead) via _fuCreateThreadedDraftToLead_
// → confirms (a) the Gmail Advanced Service is enabled, (b) the draft is addressed to the
// recipient we asked for (not self), (c) GmailApp can resolve the returned draftId (so the
// syncer won't false-delete it), then deletes the probe draft. argS = threadId.
function menuTestGmailApiDraft(a, argS) {
  var threadId = String(argS || '').trim();
  if (!threadId) return { status: 'error', error: 'argS=threadId required' };
  var thread;
  try { thread = GmailApp.getThreadById(threadId); } catch (e) { return { status: 'error', error: e.message }; }
  if (!thread) return { status: 'error', error: 'thread not found: ' + threadId };

  var out = {
    status: 'ok',
    threadId: threadId,
    advancedServiceAvailable: (typeof Gmail !== 'undefined' && !!Gmail && !!Gmail.Users && !!Gmail.Users.Drafts)
  };
  if (!out.advancedServiceAvailable) {
    out.actionRequired = 'Enable the Gmail Advanced Service: Apps Script editor → Services (+ icon) → ' +
                         'Gmail API → Add. No re-authorization needed (gmail.modify/compose already granted).';
    return out;
  }

  var subj = ''; try { subj = thread.getFirstMessageSubject() || ''; } catch (_) {}
  try {
    var res = _fuCreateThreadedDraftToLead_(
      thread.getId(), 'fu-recipient-probe@example.com', subj, '<p>probe body</p>', 'probe body', '', 'Gaurav Rathore');
    out.created = res;
    if (res && res.ok && res.draftId) {
      var resolves = false, actualTo = '';
      try {
        var d = GmailApp.getDraft(res.draftId);
        resolves = true;
        try { actualTo = d.getMessage().getTo(); } catch (_) {}
      } catch (ge) { out.getDraftErr = ge.message; }
      out.gmailAppResolvesDraftId = resolves;   // must be true → syncer-safe
      out.actualTo = actualTo;
      out.addressesRequestedRecipient = (actualTo || '').toLowerCase().indexOf('fu-recipient-probe@example.com') >= 0;
      // Cleanup: prefer the Advanced Service remove, fall back to GmailApp.
      try { Gmail.Users.Drafts.remove('me', res.draftId); out.cleanedUp = true; }
      catch (ce) {
        try { GmailApp.getDraft(res.draftId).deleteDraft(); out.cleanedUp = true; }
        catch (ce2) { out.cleanedUp = false; out.cleanupErr = ce2.message; }
      }
    }
  } catch (e) { out.status = 'error'; out.error = (e && e.message) || String(e); }
  return out;
}

// PATCH 2026-06-19-fu-thread: show a lead's email thread — the sent cold email +
// any pending follow-up reply DRAFTS that live inside that thread — as concrete
// proof the follow-up engine creates threaded replies. argS = lead name/email; if
// blank, auto-picks the first FOLLOWUP_* lead with a threadId. Read-only.
function menuShowFollowUpThread(a, argS) {
  var term = String(argS || '').toLowerCase().trim();
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sh = ss.getSheetByName(CONFIG.DATA_SHEET);
  if (!sh) return { status: 'error', error: 'data sheet missing' };
  var c = CONFIG.COLUMNS;
  if (!c.THREAD_ID) return { status: 'error', error: 'no THREAD_ID column configured' };
  var last = sh.getLastRow();
  if (last < 2) return { status: 'ok', note: 'no rows' };
  var width = CONFIG.SHEET_COL_COUNT || 28;
  var data = sh.getRange(2, 1, last - 1, width).getValues();
  var found = null;
  for (var i = 0; i < data.length; i++) {
    var r = data[i];
    var tid = String(r[c.THREAD_ID - 1] || '').trim();
    if (!tid) continue;
    var st = String(r[c.STATUS - 1] || '');
    var nm = String(r[c.FULL_NAME - 1] || '').toLowerCase();
    var em = String(r[c.ENRICHED_EMAIL - 1] || r[c.EMAIL - 1] || '').toLowerCase();
    var isMatch = term ? (nm.indexOf(term) >= 0 || em.indexOf(term) >= 0) : (st.indexOf('FOLLOWUP_') === 0);
    if (isMatch) { found = { rowNum: i + 2, name: String(r[c.FULL_NAME - 1] || ''), status: st, threadId: tid }; break; }
  }
  if (!found) return { status: 'error', error: term ? 'no lead matching "' + term + '" with a threadId' : 'no FOLLOWUP_* lead with a threadId' };
  var out = { lead: found, messages: [], pendingFollowUpDrafts: [] };
  try {
    var thread = GmailApp.getThreadById(found.threadId);
    if (!thread) { out.threadErr = 'thread not found'; return out; }
    out.messageCount = thread.getMessageCount();
    thread.getMessages().forEach(function(m) {
      out.messages.push({
        date: m.getDate().toISOString(),
        from: (m.getFrom() || '').toString().substring(0, 45),
        to: (m.getTo() || '').toString().substring(0, 45),
        subject: (m.getSubject() || '').toString().substring(0, 80)
      });
    });
  } catch (e) { out.threadErr = (e && e.message) || String(e); return out; }
  try {
    var drafts = GmailApp.getDrafts(), checked = 0, matches = 0;
    for (var k = 0; k < drafts.length && checked < 250 && matches < 3; k++) {
      checked++;
      try {
        var dm = drafts[k].getMessage();
        if (dm.getThread().getId() === found.threadId) {
          matches++;
          out.pendingFollowUpDrafts.push({
            draftId: drafts[k].getId(),
            to: (dm.getTo() || '').toString().substring(0, 45),
            subject: (dm.getSubject() || '').toString().substring(0, 80),
            snippet: (dm.getPlainBody() || '').toString().replace(/\s+/g, ' ').substring(0, 120)
          });
        }
      } catch (_) {}
    }
    out.draftsScanned = checked;
  } catch (e) { out.draftScanErr = (e && e.message) || String(e); }
  return out;
}

// PATCH 2026-06-19-whoami: which Gmail account does the pipeline run as / hold the
// drafts in? Resolves "I can't see my drafts" — they live in the EFFECTIVE user's
// Drafts, which may differ from whichever Google account the user is viewing.
function menuWhoAmI() {
  var out = { ts: new Date().toISOString() };
  try { out.activeUser = Session.getActiveUser().getEmail(); } catch (e) { out.activeUserErr = (e && e.message) || String(e); }
  try { out.effectiveUser = Session.getEffectiveUser().getEmail(); } catch (e) { out.effectiveUserErr = (e && e.message) || String(e); }
  try {
    var drafts = GmailApp.getDrafts();
    out.draftCount = drafts.length;
    if (drafts.length) { try { out.newestDraftTo = drafts[0].getMessage().getTo(); } catch (_) {} }
  } catch (e) { out.draftErr = (e && e.message) || String(e); }
  return out;
}

// PATCH 2026-06-18-draftsync-transient: RECOVERY — restore leads falsely marked
// DRAFT_DELETED whose Gmail draft actually still exists (proven by getDraft).
// Scans DRAFT_DELETED rows, probes each draftId; if the draft resolves → flip back
// to DRAFT_CREATED. Genuinely-gone drafts and transient-lookup rows are left alone
// (safe: only PROVEN-existing drafts are restored). Run AFTER the syncer transient
// fix is deployed, else they'd be re-deleted. arg1 = max getDraft probes this run
// (default 300, to stay within the Gmail op budget — re-run to drain the rest).
function menuRestoreFalseDeletedDrafts(a) {
  var cap = (typeof a === 'number' && a > 0) ? a : 300;
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sh = ss.getSheetByName(CONFIG.DATA_SHEET);
  if (!sh) return { status: 'error', error: 'data sheet missing' };
  var c = CONFIG.COLUMNS;
  var last = sh.getLastRow();
  if (last < 2) return { status: 'ok', scanned: 0, restored: 0 };
  var width = CONFIG.SHEET_COL_COUNT || 28;
  var data = sh.getRange(2, 1, last - 1, width).getValues();
  var scanned = 0, restored = 0, stillGone = 0, transient = 0, noId = 0;
  var sampleRestored = [];
  for (var i = 0; i < data.length && scanned < cap; i++) {
    var r = data[i];
    if (String(r[c.STATUS - 1] || '') !== 'DRAFT_DELETED') continue;
    var draftId = String(r[c.DRAFT_ID - 1] || '').trim();
    if (!draftId) { noId++; continue; }
    scanned++;
    var exists = false, gone = false;
    try { exists = !!GmailApp.getDraft(draftId); }
    catch (e) {
      if (typeof _draftLookupErrorMeansGone === 'function' && _draftLookupErrorMeansGone(e && e.message)) gone = true;
      else { transient++; continue; }  // transient → leave as-is, don't touch
    }
    if (exists) {
      var rowNum = i + 2;
      sh.getRange(rowNum, c.STATUS).setValue('DRAFT_CREATED');
      var notes = String(r[c.NOTES - 1] || '');
      sh.getRange(rowNum, c.NOTES).setValue(
        ('[RESTORED_FALSE_DELETE] draft ' + draftId + ' still exists in Gmail — was wrongly marked DRAFT_DELETED by a transient syncer lookup. ' + notes).substring(0, 1900));
      if (c.LAST_UPDATED) sh.getRange(rowNum, c.LAST_UPDATED).setValue(new Date().toISOString());
      restored++;
      if (sampleRestored.length < 20) sampleRestored.push({ row: rowNum, to: String(r[c.ENRICHED_EMAIL - 1] || r[c.EMAIL - 1] || '') });
    } else if (gone) { stillGone++; }
  }
  return {
    status: 'ok', scannedDraftDeleted: scanned, restored: restored,
    genuinelyGone: stillGone, transientSkipped: transient, noDraftId: noId,
    sampleRestored: sampleRestored,
    note: restored + ' lead(s) had a live draft and were restored to DRAFT_CREATED. ' +
          (transient ? transient + ' skipped on transient lookup — re-run to drain. ' : '') +
          'Genuinely-deleted leads left as DRAFT_DELETED.'
  };
}

// PATCH 2026-06-17-verify-email-hold: promote a lead held at VERIFY_EMAIL (a
// low-confidence guessed address) once the user has confirmed the address is
// correct. Flips STATUS → NEW and stamps [EMAIL_VERIFIED_BY_USER] so the hold
// gate (_processOneLead) is bypassed on the re-run and the lead drafts to the
// stored ENRICHED_EMAIL. arg1 = rowNum (>=2). Lock-guarded (sheet writes).
function menuPromoteEmailVerify(a, _) {
  var rowNum = (typeof a === 'number') ? a : parseInt(a, 10);
  if (!rowNum || rowNum < 2) return { status: 'error', error: 'arg1 rowNum (>=2) required' };
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sh = ss.getSheetByName(CONFIG.DATA_SHEET);
  if (!sh) return { status: 'error', error: 'data sheet not found' };
  if (rowNum > sh.getLastRow()) return { status: 'error', error: 'rowNum past last row' };
  var C = CONFIG.COLUMNS;
  var cur = String(sh.getRange(rowNum, C.STATUS).getValue() || '');
  if (cur !== 'VERIFY_EMAIL') {
    return { status: 'error', error: 'row ' + rowNum + ' is "' + cur + '", not VERIFY_EMAIL', currentStatus: cur };
  }
  var email = C.ENRICHED_EMAIL ? String(sh.getRange(rowNum, C.ENRICHED_EMAIL).getValue() || '') : '';
  var notes = C.NOTES ? String(sh.getRange(rowNum, C.NOTES).getValue() || '') : '';
  sh.getRange(rowNum, C.STATUS).setValue('NEW');
  if (C.NOTES) sh.getRange(rowNum, C.NOTES).setValue((notes + ' [EMAIL_VERIFIED_BY_USER]').trim().substring(0, 1900));
  if (C.LAST_UPDATED) sh.getRange(rowNum, C.LAST_UPDATED).setValue(new Date().toISOString());
  return {
    status: 'ok', row: rowNum,
    name: String(sh.getRange(rowNum, C.FULL_NAME).getValue() || ''),
    promotedEmail: email, statusAfter: 'NEW',
    note: 'Promoted VERIFY_EMAIL → NEW with [EMAIL_VERIFIED_BY_USER]. The scanner will re-run the full pipeline and draft to this address (the hold gate is now bypassed). If the address is WRONG, correct ENRICHED_EMAIL before promoting.'
  };
}

// PATCH 2026-06-19-email-lock: correct a held lead's address to a HUMAN-VERIFIED one and
// promote it — SAFELY. menuPromoteEmailVerify alone is unsafe when the derived address is
// WRONG: the scanner re-runs the finalizer, which deterministically RE-derives the same
// wrong address (e.g. bistro.sk) and drafts to it (hold gate bypassed). This writes
// [EMAIL_LOCKED:<addr>] into NOTES, which finalizeEmailSelection honours as highest
// precedence (skips all derivation), so the corrected address actually sticks.
// a = rowNum (>=2), argS = the correct email. Whitelisted under a LockService guard.
function menuCorrectAndPromoteEmail(a, argS) {
  var rowNum = (typeof a === 'number') ? a : parseInt(a, 10);
  var email = String(argS || '').toLowerCase().trim();
  if (!rowNum || rowNum < 2) return { status: 'error', error: 'arg1 rowNum (>=2) required' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { status: 'error', error: 'argS must be a valid email — got: "' + email + '"' };
  }
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sh = ss.getSheetByName(CONFIG.DATA_SHEET);
  if (!sh) return { status: 'error', error: 'data sheet not found' };
  if (rowNum > sh.getLastRow()) return { status: 'error', error: 'rowNum past last row' };
  var C = CONFIG.COLUMNS;
  var statusBefore = String(sh.getRange(rowNum, C.STATUS).getValue() || '');
  var name = String(sh.getRange(rowNum, C.FULL_NAME).getValue() || '');
  var prevEmail = C.ENRICHED_EMAIL ? String(sh.getRange(rowNum, C.ENRICHED_EMAIL).getValue() || '') : '';
  var notes = C.NOTES ? String(sh.getRange(rowNum, C.NOTES).getValue() || '') : '';
  // Strip any prior lock marker so markers don't stack across corrections.
  notes = notes.replace(/\[EMAIL_LOCKED:[^\]]*\]/gi, '').replace(/\s{2,}/g, ' ').trim();
  if (C.ENRICHED_EMAIL) sh.getRange(rowNum, C.ENRICHED_EMAIL).setValue(email);
  // DURABLE lock (survives notes rewrites + reprocessing — the Vedansh fix). The NOTES
  // marker below is kept as a secondary/visible signal, but this is the authoritative store.
  if (typeof _emailLockSet_ === 'function') _emailLockSet_(rowNum, email);
  if (C.NOTES) {
    sh.getRange(rowNum, C.NOTES).setValue(
      (notes + ' [EMAIL_LOCKED:' + email + '] [EMAIL_VERIFIED_BY_USER]').trim().substring(0, 1900));
  }
  sh.getRange(rowNum, C.STATUS).setValue('NEW');
  if (C.LAST_UPDATED) sh.getRange(rowNum, C.LAST_UPDATED).setValue(new Date().toISOString());
  return {
    status: 'ok', row: rowNum, name: name,
    previousEmail: prevEmail, lockedEmail: email,
    statusBefore: statusBefore, statusAfter: 'NEW',
    note: 'Locked ' + email + ' ([EMAIL_LOCKED]) and promoted to NEW. The finalizer will trust ' +
          'this address verbatim (no re-derivation) and draft to it on the next scan.'
  };
}

// PATCH 2026-06-19-trust-org: toggle the headline→org override (_reconcileCurrentEmployer).
// arg1=0 → DISABLE (the APK org field becomes authoritative; the noisy headline never overrides it
// — the user's "trust the org field" choice, which also stops tagline/past-role mis-extractions
// from corrupting org). arg1=1 → re-enable. Read back by _employerReconcileEnabled_ (default ON).
function menuSetEmployerReconcileEnabled(a) {
  var on = !(String(a) === '0' || a === 0);
  PropertiesService.getScriptProperties().setProperty('EMPLOYER_RECONCILE_ENABLED', on ? '1' : '0');
  return {
    status: 'ok', EMPLOYER_RECONCILE_ENABLED: on ? '1' : '0',
    effect: on ? 'headline may override a conflicting org field'
               : 'org field is AUTHORITATIVE — headline ignored for current-employer (trust-org mode)'
  };
}

// PATCH 2026-06-19-trust-org: clear a suspect durable email lock AND park the lead at VERIFY_EMAIL
// for human review (used when a prior lock was probably wrong — e.g. org and headline disagree on
// the employer). a = rowNum, argS = review note shown to the user. Lock-guarded via the whitelist.
function menuUnlockEmailAndHold(a, argS) {
  var rowNum = (typeof a === 'number') ? a : parseInt(a, 10);
  if (!rowNum || rowNum < 2) return { status: 'error', error: 'arg1 rowNum (>=2) required' };
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sh = ss.getSheetByName(CONFIG.DATA_SHEET);
  if (!sh) return { status: 'error', error: 'data sheet not found' };
  if (rowNum > sh.getLastRow()) return { status: 'error', error: 'rowNum past last row' };
  var C = CONFIG.COLUMNS;
  var name = String(sh.getRange(rowNum, C.FULL_NAME).getValue() || '');
  var before = String(sh.getRange(rowNum, C.STATUS).getValue() || '');
  var clearedLock = (typeof _emailLockClear_ === 'function') ? _emailLockClear_(rowNum) : false;
  var notes = C.NOTES ? String(sh.getRange(rowNum, C.NOTES).getValue() || '') : '';
  notes = notes.replace(/\[EMAIL_LOCKED:[^\]]*\]/gi, '').replace(/\[EMAIL_VERIFIED_BY_USER\]/gi, '')
               .replace(/\s{2,}/g, ' ').trim();
  var review = String(argS || 'employer ambiguous — confirm current company before drafting');
  if (C.NOTES) sh.getRange(rowNum, C.NOTES).setValue((notes + ' [EMAIL_REVIEW] ' + review).trim().substring(0, 1900));
  sh.getRange(rowNum, C.STATUS).setValue('VERIFY_EMAIL');
  if (C.LAST_UPDATED) sh.getRange(rowNum, C.LAST_UPDATED).setValue(new Date().toISOString());
  return {
    status: 'ok', row: rowNum, name: name, statusBefore: before, statusAfter: 'VERIFY_EMAIL',
    clearedDurableLock: clearedLock, reviewNote: review
  };
}

// PATCH 2026-06-19-org-override: set a HUMAN-VERIFIED current employer, then promote — fixing BOTH
// the letter (composer reads lead.organization → org override) and the recipient. TWO modes:
//   argS = "Org Name"               → ENGINE mode (PREFERRED): set org override, CLEAR any prior
//                                     lock + stale enriched email, promote → the 3-tier enrichment
//                                     engine (Apollo→Snov→pattern, Reoon/MX-validated) re-derives
//                                     the BEST VALIDATED email against the verified company. We
//                                     supply the company (human-verified); the engine does the email.
//   argS = "Org Name|email@domain"  → LOCK mode: also durably lock a KNOWN-correct email (human
//                                     truth — skips engine derivation). Only when you KNOW the address.
// Use after confirming where someone actually works. a = rowNum. Lock-guarded via whitelist.
function menuFixEmployerAndPromote(a, argS) {
  var rowNum = (typeof a === 'number') ? a : parseInt(a, 10);
  if (!rowNum || rowNum < 2) return { status: 'error', error: 'arg1 rowNum (>=2) required' };
  var parts = String(argS || '').split('|');
  var org = (parts[0] || '').trim();
  var email = (parts[1] || '').trim().toLowerCase();
  if (!org) return { status: 'error', error: 'argS must be "Org Name" or "Org Name|email@domain" — missing org' };
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { status: 'error', error: 'optional email is malformed: "' + email + '"' };
  }
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sh = ss.getSheetByName(CONFIG.DATA_SHEET);
  if (!sh) return { status: 'error', error: 'data sheet not found' };
  if (rowNum > sh.getLastRow()) return { status: 'error', error: 'rowNum past last row' };
  var C = CONFIG.COLUMNS;
  var name = String(sh.getRange(rowNum, C.FULL_NAME).getValue() || '');
  var before = String(sh.getRange(rowNum, C.STATUS).getValue() || '');
  var orgSet = (typeof _orgOverrideSet_ === 'function') ? _orgOverrideSet_(rowNum, org) : false;
  var notes = C.NOTES ? String(sh.getRange(rowNum, C.NOTES).getValue() || '') : '';
  notes = notes.replace(/\[EMAIL_LOCKED:[^\]]*\]/gi, '').replace(/\[EMAIL_REVIEW\][^\[]*/gi, '')
               .replace(/\[ORG_VERIFIED:[^\]]*\]/gi, '').replace(/\[EMAIL_REENRICH\]/gi, '')
               .replace(/\[EMAIL_VERIFIED_BY_USER\]/gi, '').replace(/\s{2,}/g, ' ').trim();
  var mode, lockSet = false, markers;
  if (email) {
    lockSet = (typeof _emailLockSet_ === 'function') ? _emailLockSet_(rowNum, email) : false;
    if (C.ENRICHED_EMAIL) sh.getRange(rowNum, C.ENRICHED_EMAIL).setValue(email);
    mode = 'locked_known_email';
    markers = ' [ORG_VERIFIED:' + org + '] [EMAIL_LOCKED:' + email + '] [EMAIL_VERIFIED_BY_USER]';
  } else {
    if (typeof _emailLockClear_ === 'function') _emailLockClear_(rowNum);        // drop any prior guess
    if (C.ENRICHED_EMAIL) sh.getRange(rowNum, C.ENRICHED_EMAIL).setValue('');     // force fresh engine derivation
    mode = 'engine_rederive';
    markers = ' [ORG_VERIFIED:' + org + '] [EMAIL_REENRICH]';
  }
  if (C.NOTES) sh.getRange(rowNum, C.NOTES).setValue((notes + markers).trim().substring(0, 1900));
  sh.getRange(rowNum, C.STATUS).setValue('NEW');
  if (C.LAST_UPDATED) sh.getRange(rowNum, C.LAST_UPDATED).setValue(new Date().toISOString());
  return {
    status: 'ok', row: rowNum, name: name, statusBefore: before, statusAfter: 'NEW',
    mode: mode, verifiedOrg: org, lockedEmail: email || null, orgOverrideSet: orgSet, emailLockSet: lockSet,
    note: (email
      ? 'LOCK mode: locked known email ' + email + ' + org "' + org + '"; promoted.'
      : 'ENGINE mode: org "' + org + '" verified; prior lock + stale email cleared. The 3-tier enrichment ' +
        'engine will derive + Reoon-validate the best email against ' + org + ' on the next scan ' +
        '(or hold at VERIFY_EMAIL if it can only produce a low-confidence guess).')
  };
}

// ── FOLLOW-UP DIAGNOSTIC + CROSS-EMAIL DEDUP CLEANUP (-p7-followup-identity) ──
// menuFollowupsForLead(_, argS): dump FollowUps rows whose Email / LeadName / ParentRow
// contains argS (case-insensitive). Read-only. Flags fallback (frozen) bodies.
function menuFollowupsForLead(_, argS) {
  var needle = String(argS || '').trim().toLowerCase();
  if (!needle) return { status: 'error', error: 'argS required: email / name / parentRow substring' };
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sh = ss.getSheetByName('FollowUps');
  if (!sh) return { status: 'error', error: 'FollowUps sheet not found' };
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return { status: 'ok', matches: [] };
  var H = data[0].map(function(h){ return (h||'').toString().trim(); });
  var ix = {}; H.forEach(function(h,i){ ix[h]=i; });
  var out = [];
  for (var r = 1; r < data.length; r++) {
    var row = data[r];
    var email = (row[ix['Email']]||'').toString();
    var name  = (ix['LeadName']!==undefined ? row[ix['LeadName']] : '') + '';
    var pr    = (ix['ParentRow']!==undefined ? row[ix['ParentRow']] : '') + '';
    if ((email + ' ' + name + ' ' + pr).toLowerCase().indexOf(needle) < 0) continue;
    var bodyVal = (ix['Body']!==undefined ? row[ix['Body']] : '') || '';
    out.push({
      sheetRow: r + 1, email: email, leadName: name,
      stage: (row[ix['Stage']]||'') + '', status: (row[ix['Status']]||'') + '', parentRow: pr,
      scheduledDate: (row[ix['ScheduledDate']]||'') + '',
      bodyIsFallback: (typeof _fuBodyLooksLikeFallback_ === 'function') && _fuBodyLooksLikeFallback_(bodyVal),
      bodyPreview: bodyVal.toString().replace(/\s+/g,' ').substring(0, 90)
    });
  }
  return { status: 'ok', needle: needle, count: out.length, matches: out.slice(0, 60) };
}

// menuCleanupCrossEmailFollowups(arg1, argS): cancel cross-email DUPLICATE PENDING
// follow-up sets for the SAME lead — the Samriddhi (Wishlink→Lendbox) class. Groups
// PENDING rows by (ParentRow, Stage); when a group has >1 row under >1 distinct email,
// keeps the EARLIEST-scheduled and marks the rest CANCELLED. arg1 = a ParentRow to
// limit to (0/blank = all). argS='execute' writes; anything else = DRY RUN.
function menuCleanupCrossEmailFollowups(arg1, argS) {
  var onlyParent = parseInt(arg1, 10) || 0;
  var doExecute = String(argS || '').trim().toLowerCase() === 'execute';
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sh = ss.getSheetByName('FollowUps');
  if (!sh) return { status: 'error', error: 'FollowUps sheet not found' };
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return { status: 'ok', crossEmailDupGroups: 0, cancelled: 0 };
  var H = data[0].map(function(h){ return (h||'').toString().trim(); });
  var ix = {}; H.forEach(function(h,i){ ix[h]=i; });
  if (ix['ParentRow'] === undefined || ix['Stage'] === undefined || ix['Status'] === undefined) {
    return { status: 'error', error: 'FollowUps missing ParentRow/Stage/Status columns' };
  }
  var groups = {};
  for (var r = 1; r < data.length; r++) {
    var row = data[r];
    if (((row[ix['Status']]||'')+'').trim() !== 'PENDING') continue;
    var pr = parseInt(row[ix['ParentRow']], 10) || 0;
    if (!pr || (onlyParent && pr !== onlyParent)) continue;
    var stage = ((row[ix['Stage']]||'')+'').trim();
    var email = ((row[ix['Email']]||'')+'').trim().toLowerCase();
    var schedMs = (ix['ScheduledDate']!==undefined && row[ix['ScheduledDate']]) ? (new Date(row[ix['ScheduledDate']]).getTime() || 0) : 0;
    var k = pr + '|' + stage;
    (groups[k] = groups[k] || []).push({ sheetRow: r + 1, email: email, schedMs: schedMs });
  }
  var dupGroups = 0, cancelled = 0, report = [];
  Object.keys(groups).forEach(function(k){
    var g = groups[k], emails = {};
    g.forEach(function(x){ emails[x.email] = true; });
    if (g.length < 2 || Object.keys(emails).length < 2) return;  // true cross-email collision only
    dupGroups++;
    g.sort(function(a,b){ return (a.schedMs - b.schedMs) || (a.sheetRow - b.sheetRow); });
    var keep = g[0];
    for (var j = 1; j < g.length; j++) {
      report.push({ parentStage: k, cancelSheetRow: g[j].sheetRow, cancelEmail: g[j].email, keptEmail: keep.email });
      if (doExecute) {
        sh.getRange(g[j].sheetRow, ix['Status'] + 1).setValue('CANCELLED');
        if (ix['Notes'] !== undefined) sh.getRange(g[j].sheetRow, ix['Notes'] + 1).setValue('[DUP_FOLLOWUP_XEMAIL] superseded — kept ' + keep.email);
        cancelled++;
      }
    }
  });
  return { status: 'ok', mode: doExecute ? 'execute' : 'dryrun', onlyParent: onlyParent || 'all',
           crossEmailDupGroups: dupGroups, cancelled: cancelled, sample: report.slice(0, 40) };
}

// PATCH 2026-06-20-sheet2-spill: diagnose/repair a STALLED =UNIQUE(Sheet1!B2:G) spill — new Sheet1
// captures land but Sheet2 stops growing (Parth Shah landed yet never reached the pipeline). The
// classic cause is a stray value pasted into the A:F spill range BELOW the live spill, which dams
// further expansion. arg1=0 → DRY (inspect only); arg1=1 → REPAIR. Repair only ever (a) reinstalls
// the formula IF A2 is empty and (b) clears stray A:F cells BELOW the spill — it never reorders the
// existing spill, so the G-U pipeline state stays aligned to the same leads.
function menuRepairSheet2Spill(a) {
  var doRepair = (String(a) === '1' || a === 1);
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var s1 = ss.getSheetByName('Sheet1');
  var s2 = ss.getSheetByName(CONFIG.DATA_SHEET);
  if (!s1 || !s2) return { status: 'error', error: 'sheet missing', sheet1: !!s1, sheet2: !!s2 };
  var out = { status: 'ok', mode: doRepair ? 'repair' : 'dryrun' };
  out.sheet1LastRow = s1.getLastRow();
  out.sheet2LastRow = s2.getLastRow();
  out.a2formula = s2.getRange('A2').getFormula();
  out.a2isUnique = /UNIQUE/i.test(out.a2formula) && /Sheet1/i.test(out.a2formula);
  out.a2value = String(s2.getRange('A2').getValue()).substring(0, 60);
  var last = s2.getLastRow();
  var af = s2.getRange(2, 1, Math.max(1, last - 1), 6).getValues();
  var firstEmpty = -1, strays = [];
  for (var i = 0; i < af.length; i++) {
    var empty = af[i].every(function (c) { return String(c).trim() === ''; });
    if (empty && firstEmpty < 0) firstEmpty = i + 2;
    if (!empty && firstEmpty >= 0) strays.push(i + 2);
  }
  out.spillEndsAtRow = (firstEmpty > 0 ? firstEmpty - 1 : last);
  out.firstEmptyRow = firstEmpty;
  out.strayRowsBelowSpill = strays.slice(0, 25);
  out.strayCount = strays.length;
  out.straySamples = [];
  strays.slice(0, 6).forEach(function (r) {
    out.straySamples.push({ row: r, vals: s2.getRange(r, 1, 1, 6).getValues()[0].map(function (c) { return String(c).substring(0, 24); }) });
  });
  if (doRepair) {
    var actions = [];
    // 0) Snapshot the current spill's identity (col A = LinkedIn URL) so we can PROVE the G-U
    //    pipeline state still maps to the same leads after the recalc.
    var snapN = Math.max(0, out.sheet2LastRow - 1);
    var beforeA = snapN > 0 ? s2.getRange(2, 1, snapN, 1).getValues().map(function (r) { return String(r[0]); }) : [];
    // 1) Clear any stray blockers (none expected here, but safe).
    var cleared = 0;
    strays.forEach(function (r) { s2.getRange(r, 1, 1, 6).clearContent(); cleared++; });
    if (cleared) actions.push('cleared_' + cleared + '_stray_rows');
    // 2) If the formula is missing AND A2 is empty, install it; otherwise FORCE a recalc of the
    //    stuck spill (clear the anchor + re-set). Safe: Sheet1 is append-only → UNIQUE re-emits the
    //    same rows in the same order and appends the new ones at the bottom.
    if (!out.a2isUnique && out.a2value !== '' && out.a2value !== 'null') {
      out.actions = ['A2_NOT_FORMULA_AND_NOT_EMPTY — left untouched, needs manual review'];
      return out;
    }
    s2.getRange('A2').clearContent(); SpreadsheetApp.flush();
    s2.getRange('A2').setFormula('=UNIQUE(Sheet1!B2:G)'); SpreadsheetApp.flush();
    actions.push('forced_spill_recalc');
    out.sheet2LastRowAfter = s2.getLastRow();
    out.newRowsAdded = out.sheet2LastRowAfter - out.sheet2LastRow;
    // 3) Verify alignment — the first snapN rows must be byte-identical (col A) to before.
    var afterA = snapN > 0 ? s2.getRange(2, 1, snapN, 1).getValues().map(function (r) { return String(r[0]); }) : [];
    var mism = 0, firstMismRow = -1;
    for (var k = 0; k < snapN; k++) { if (beforeA[k] !== afterA[k]) { mism++; if (firstMismRow < 0) firstMismRow = k + 2; } }
    out.alignmentRowsChecked = snapN;
    out.alignmentMismatches = mism;
    out.alignmentSafe = (mism === 0);
    out.firstMismatchRow = firstMismRow;
    out.actions = actions;
  }
  return out;
}

// PATCH 2026-06-20-fu-scrub: clean PRE-FIX self-addressed follow-up drafts. Each created follow-up
// row in the 'FollowUps' sheet is marked Status='SENT' with 'draftId=<id>' in Notes. We read each
// such draft's recipient; if it's addressed to the OWNER (self — the pre-@241 bug), we delete the
// broken draft and reset the row to PENDING so the daily trigger regenerates it LEAD-addressed (and
// now styled). arg1=0 → DRY (count + samples); arg1=1 → execute. Lock-guarded via whitelist.
function menuScrubSelfAddressedFollowups(a) {
  var doFix = (String(a) === '1' || a === 1);
  var owner = '';
  try { owner = (Session.getEffectiveUser().getEmail() || '').toLowerCase(); } catch (_) {}
  if (!owner) return { status: 'error', error: 'could not resolve owner email' };

  // The FollowUps sheet has NO Notes column on this deployment, so the draftId is never persisted
  // (live code writes it only `if col.notes >= 0`). We can't key off the sheet — scan Gmail directly.
  // A pre-fix self-addressed follow-up is a draft whose subject is a "Re:" reply, inside one of OUR
  // self-started cold-email threads (first msg FROM the owner), addressed TO the owner instead of the
  // lead. Delete it + reset that lead's (email,stage) FollowUps row to PENDING so the daily trigger
  // regenerates it lead-addressed + newly styled. stage = thread message count (original + sent
  // follow-ups; the pending draft is the next stage, not yet a thread message).
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var fu = ss.getSheetByName('FollowUps');
  var fuData = (fu ? fu.getDataRange().getValues() : []);
  var fuHeaders = (fuData.length ? fuData[0].map(function (h) { return (h || '').toString().trim(); }) : []);
  function fcol(name) {
    var n = name.toLowerCase();
    for (var k = 0; k < fuHeaders.length; k++) { if (fuHeaders[k].toLowerCase().indexOf(n) >= 0) return k; }
    return -1;
  }
  var cEmail = fcol('email'), cStatus = fcol('status'), cStage = fcol('stage');

  var drafts = GmailApp.getDrafts();
  var out = { status: 'ok', mode: doFix ? 'execute' : 'dryrun', owner: owner,
              draftsScanned: drafts.length, followupReplies: 0, selfAddressed: 0,
              deleted: 0, rowsReset: 0, samples: [] };

  for (var i = 0; i < drafts.length; i++) {
    var msg;
    try { msg = drafts[i].getMessage(); } catch (e) { continue; }
    var subj = (msg.getSubject() || '').trim();
    if (!/^re:/i.test(subj)) continue;                          // follow-ups are "Re:" threaded replies
    out.followupReplies++;
    var to = (msg.getTo() || '').toLowerCase();
    if (to.indexOf(owner) < 0) continue;                        // addressed to the lead = correct → skip

    var leadEmail = '', stage = 0, firstFrom = '';
    try {
      var th = msg.getThread();
      var msgs = th.getMessages();
      firstFrom = (msgs[0].getFrom() || '').toLowerCase();
      var rawTo = (msgs[0].getTo() || '').toString();
      var mm = rawTo.match(/<([^>]+)>/);
      leadEmail = (mm ? mm[1] : rawTo).trim().toLowerCase();
      stage = th.getMessageCount();
    } catch (_) {}
    if (firstFrom.indexOf(owner) < 0) continue;                 // not our self-started cold-email thread → skip

    out.selfAddressed++;
    if (out.samples.length < 12) {
      out.samples.push({ draftId: drafts[i].getId(), subject: subj.substring(0, 45),
                         to: to.substring(0, 35), leadEmail: leadEmail, stage: stage });
    }
    if (doFix) {
      try { drafts[i].deleteDraft(); out.deleted++; } catch (_) {}
      if (fu && cEmail >= 0 && cStatus >= 0 && cStage >= 0 && leadEmail && stage) {
        for (var r = 1; r < fuData.length; r++) {
          if ((fuData[r][cEmail] || '').toString().toLowerCase() === leadEmail &&
              parseInt(fuData[r][cStage], 10) === stage &&
              (fuData[r][cStatus] || '').toString().trim() === 'SENT') {
            fu.getRange(r + 1, cStatus + 1).setValue('PENDING');
            fuData[r][cStatus] = 'PENDING';   // in-memory guard against double-reset
            out.rowsReset++;
          }
        }
      }
    }
  }
  out.note = doFix
    ? 'Deleted ' + out.deleted + ' self-addressed follow-up drafts + reset ' + out.rowsReset +
      ' FollowUps row(s) to PENDING → the daily trigger (processScheduledFollowUps) regenerates them ' +
      'LEAD-addressed with the new styling.'
    : out.selfAddressed + ' self-addressed follow-up draft(s) found (of ' + out.followupReplies +
      ' "Re:" drafts scanned). Set arg1=1 to delete + reset.';
  return out;
}

// PATCH 2026-06-20-purge-stale: one-time cleanup of STALE unsent drafts. Rule (user, 2026-06-20):
// any draft not sent within `daysOld` days of creation is deleted. arg1 = daysOld (default 5);
// argS = 'execute' to delete (else DRY RUN — counts/categories/age-buckets only). The age filter is
// a HARD safety boundary: anything newer than the cutoff (e.g. today's fresh cold drafts + the just-
// regenerated lead-addressed follow-ups) is KEPT untouched. Deletes are CAPPED + time-budgeted so the
// run stays under the HTTP/script timeout; if `moreRemain` is true, re-call to continue. After the
// final execute, run menuRunDraftSyncerNow to reconcile the deleted-draft leads → DRAFT_DELETED
// (the @237-correct syncer; no false-positives). Deleting an unsent draft never touches sent mail.
function menuPurgeStaleUnsentDrafts(daysOld, doFix) {
  var DAYS = parseInt(daysOld, 10);
  if (!DAYS || DAYS < 1) DAYS = 5;                       // the 5-day rule (default)
  var execute = (String(doFix).toLowerCase() === 'execute');
  var now = new Date();
  var cutoffMs = now.getTime() - DAYS * 86400000;
  var owner = '';
  try { owner = (Session.getEffectiveUser().getEmail() || '').toLowerCase(); } catch (_) {}

  var drafts;
  try { drafts = GmailApp.getDrafts(); } catch (e) { return { status: 'error', error: 'getDrafts failed: ' + e.message }; }

  var START = now.getTime();
  var TIME_BUDGET_MS = 150000;                           // ~2.5 min — return before timeout
  var MAX_DELETE = 100;                                  // per-call delete cap (resumable)

  var out = {
    status: 'ok', mode: execute ? 'execute' : 'dryrun', daysOld: DAYS,
    cutoff: Utilities.formatDate(new Date(cutoffMs), 'Asia/Kolkata', 'yyyy-MM-dd HH:mm'),
    totalDrafts: drafts.length, staleCandidates: 0, deleted: 0,
    byCategory: { cold: 0, reply: 0, selfOrOther: 0 }, ageBuckets: {}, samples: [], moreRemain: false
  };

  for (var i = 0; i < drafts.length; i++) {
    if (execute && (out.deleted >= MAX_DELETE || (new Date().getTime() - START) > TIME_BUDGET_MS)) {
      out.moreRemain = true; break;
    }
    var msg;
    try { msg = drafts[i].getMessage(); } catch (e) { continue; }
    var dt;
    try { dt = msg.getDate(); } catch (e) { continue; }
    if (!dt || dt.getTime() >= cutoffMs) continue;       // newer than cutoff → KEEP (hard safety boundary)

    out.staleCandidates++;
    var subj = '', to = '';
    try { subj = (msg.getSubject() || '').trim(); } catch (_) {}
    try { to = (msg.getTo() || ''); } catch (_) {}
    var toLc = to.toLowerCase();

    var cat = 'cold';
    if (/^re:/i.test(subj)) cat = 'reply';
    if (owner && toLc.indexOf(owner) >= 0) cat = 'selfOrOther';
    out.byCategory[cat]++;

    var ageDays = Math.floor((now.getTime() - dt.getTime()) / 86400000);
    var bk = ageDays >= 30 ? 'd30plus' : (ageDays >= 14 ? 'd14_29' : (ageDays >= 7 ? 'd7_13' : 'd5_6'));
    out.ageBuckets[bk] = (out.ageBuckets[bk] || 0) + 1;

    if (out.samples.length < 20) {
      out.samples.push({
        date: Utilities.formatDate(dt, 'Asia/Kolkata', 'yyyy-MM-dd'),
        ageDays: ageDays, cat: cat, to: to.substring(0, 36), subject: subj.substring(0, 40)
      });
    }

    if (execute) {
      try { drafts[i].deleteDraft(); out.deleted++; } catch (_) {}
    }
  }

  out.note = execute
    ? ('Deleted ' + out.deleted + ' stale (>=' + DAYS + 'd) unsent drafts this run' +
       (out.moreRemain ? ' — MORE REMAIN (cap/budget hit), re-run argS=execute to continue.'
                       : '. No more remain at this threshold.') +
       ' Then run menuRunDraftSyncerNow to reconcile leads -> DRAFT_DELETED.')
    : ('DRY RUN — ' + out.staleCandidates + ' stale unsent drafts (>=' + DAYS + 'd old, created on/before ' +
       out.cutoff + '). Re-call with argS=execute to delete (capped + resumable).');
  return out;
}

// PATCH 2026-06-20-leadphones: compile the ONLY legitimately-owned phone numbers into a 'LeadPhones'
// data sheet. Two free + consented sources:
//   A (apk_capture)    — Sheet1 col H: phones the APK scraped from 1st-degree LinkedIn connections
//                        (visible + opt-in). STRANDED there: UNIQUE(Sheet1!B2:G) omits col H, so the
//                        pipeline never sees them. We surface them.
//   B (reply_signature)— leads who REPLIED to outreach; a number in their reply signature is consented
//                        contact. We scan sent-ish leads' threads for the lead's OWN inbound message and
//                        pull the phone from the NEW reply text only (quoted original is stripped, so our
//                        own signature can't leak in).
// arg1=1 → (re)write the 'LeadPhones' sheet; arg1=0/empty → DRY RUN (counts + samples, no write).
function menuCompileLeadPhones(arg1) {
  var doWrite = (String(arg1) === '1' || arg1 === 1);
  var owner = '';
  try { owner = (Session.getEffectiveUser().getEmail() || '').toLowerCase(); } catch (_) {}
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var out = { status: 'ok', mode: doWrite ? 'write' : 'dryrun',
              captured: 0, replySigned: 0, threadsScanned: 0, unique: 0, wrote: false, samples: [] };

  // ── Source A: captured phones stranded in Sheet1 col H ──
  var captured = [];
  var s1 = ss.getSheetByName('Sheet1');
  if (s1) {
    var d1 = s1.getDataRange().getValues();
    for (var i = 1; i < d1.length; i++) {
      var rawPh = (d1[i][7] || '').toString();             // H Phone
      var ph = _phNormalizeIndian_(rawPh);
      if (!ph) continue;
      var em1 = (d1[i][6] || '').toString().trim();        // G Email
      var nm1 = (d1[i][2] || '').toString().trim();        // C Full_Name
      if (_phIsTestLead_(em1, nm1)) continue;              // drop E2E/diagnostic test rows
      captured.push({
        name: nm1, org: (d1[i][5] || '').toString().trim(),     // F Organization
        designation: (d1[i][4] || '').toString().trim(),        // E Designation
        email: em1, url: (d1[i][1] || '').toString().trim(),    // B LinkedIn_URL
        phone: ph, type: _phType_(rawPh), source: 'apk_capture',
        detail: 'conn=' + ((d1[i][10] || '').toString().trim() || '?')  // K Connection degree
      });
    }
  }
  out.captured = captured.length;

  // ── Source B: reply-signature phones from sent-ish leads' threads ──
  var replied = [];
  var c = CONFIG.COLUMNS;
  var SENTISH = { SENT: 1, FOLLOWUP_1: 1, FOLLOWUP_2: 1, FOLLOWUP_3: 1, RESPONDED: 1 };
  var s2 = ss.getSheetByName(CONFIG.DATA_SHEET);
  if (s2) {
    var d2 = s2.getDataRange().getValues();
    for (var j = 1; j < d2.length; j++) {
      var st = (d2[j][c.STATUS - 1] || '').toString().trim();
      if (!SENTISH[st]) continue;
      var threadId = (d2[j][c.THREAD_ID - 1] || '').toString().trim();
      var leadEmail = ((d2[j][c.ENRICHED_EMAIL - 1] || d2[j][c.EMAIL - 1] || '') + '').trim().toLowerCase();
      if (!threadId || !leadEmail) continue;
      out.threadsScanned++;
      try {
        var th = GmailApp.getThreadById(threadId);
        if (!th) continue;
        var msgs = th.getMessages(), foundPhone = '';
        for (var m = 0; m < msgs.length; m++) {
          var from = (msgs[m].getFrom() || '').toLowerCase();
          if (from.indexOf(owner) >= 0) continue;        // our own message
          if (from.indexOf(leadEmail) < 0) continue;     // only the lead's inbound message
          var ph2 = _phExtractFromReply_(msgs[m].getPlainBody() || '');
          if (ph2) foundPhone = ph2;                     // keep most-recent reply's phone
        }
        if (foundPhone && !_phIsTestLead_(leadEmail, '')) {
          replied.push({
            name: (d2[j][c.FULL_NAME - 1] || '').toString().trim(),
            org: (d2[j][c.ORGANIZATION - 1] || '').toString().trim(),
            designation: (d2[j][c.DESIGNATION - 1] || '').toString().trim(),
            email: leadEmail, url: (d2[j][c.LINKEDIN_URL - 1] || '').toString().trim(),
            phone: foundPhone, type: 'mobile_IN', source: 'reply_signature', detail: 'from reply'
          });
        }
      } catch (e) {}
    }
  }
  out.replySigned = replied.length;

  // ── Merge + dedup by lead (prefer reply_signature: actively shared = most current) ──
  var byKey = {};
  captured.concat(replied).forEach(function (r) {
    var key = (r.email || r.url || (r.name + '|' + r.phone)).toLowerCase();
    if (!byKey[key] || r.source === 'reply_signature') byKey[key] = r;
  });
  var rows = Object.keys(byKey).map(function (k) { return byKey[k]; });
  out.unique = rows.length;
  out.byType = {};
  rows.forEach(function (r) { out.byType[r.type || 'other'] = (out.byType[r.type || 'other'] || 0) + 1; });
  out.realMobiles = (out.byType['mobile_IN'] || 0);   // the only directly-useful personal numbers
  out.samples = rows.slice(0, 15).map(function (r) {
    return { name: r.name, org: r.org, phone: r.phone, type: r.type, source: r.source };
  });

  // ── Write the data sheet ──
  if (doWrite) {
    var sh = ss.getSheetByName('LeadPhones') || ss.insertSheet('LeadPhones');
    sh.clear();
    var headers = ['Name', 'Organization', 'Designation', 'Email', 'LinkedIn_URL', 'Phone', 'Type', 'Source', 'Detail'];
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    if (rows.length) {
      var data = rows.map(function (r) {
        return [r.name, r.org, r.designation, r.email, r.url, r.phone, r.type, r.source, r.detail];
      });
      sh.getRange(2, 1, data.length, headers.length).setValues(data);
    }
    sh.setFrozenRows(1);
    out.wrote = true;
    out.sheet = 'LeadPhones';
    try { out.url = ss.getUrl() + '#gid=' + sh.getSheetId(); } catch (_) {}
  }
  return out;
}

// Normalize/validate a phone string. Returns a clean '+91 XXXXX XXXXX' for Indian mobiles,
// the original string for plausible landline/intl (10-13 digits), '' for junk / our '[VERIFY]' placeholder.
function _phNormalizeIndian_(raw) {
  if (!raw) return '';
  var s = raw.toString().trim();
  if (!s || /verify/i.test(s)) return '';                 // skip our own '+91-[VERIFY]' placeholder
  var digits = s.replace(/[^\d]/g, '');
  if (digits.length < 10) return '';
  var d = digits;
  if (d.length === 12 && d.slice(0, 2) === '91') d = d.slice(2);
  if (d.length === 11 && d.charAt(0) === '0') d = d.slice(1);
  if (d.length === 10 && /^[6-9]/.test(d)) return '+91 ' + d.slice(0, 5) + ' ' + d.slice(5);  // clean Indian mobile
  if (digits.length >= 10 && digits.length <= 13) return s;  // landline / international — keep original
  return '';
}

// Strip the quoted-original portion of a reply so we only parse the lead's NEW text (their signature),
// never our own quoted cold-email signature.
function _phTopReplyText_(body) {
  if (!body) return '';
  var cut = body.search(/\n\s*On .+ wrote:|\n\s*From:\s|\n-{2,}\s*Original Message|\n_{5,}|\n>{1,}/);
  return (cut > 0) ? body.substring(0, cut) : body;
}

// Extract an Indian mobile from a reply's top text (signature = last match at the bottom).
function _phExtractFromReply_(body) {
  var top = _phTopReplyText_(body);
  if (!top) return '';
  // [6-9] then 9 more digits, each optionally preceded by a space/dash — matches 98765 43210,
  // 987-654-3210, 9876543210 alike (the old 3-3-4-only pattern missed the common 5-5 grouping).
  var re = /(?:\+?\s*91[\s-]?|\b0)?([6-9](?:[\s-]?\d){9})\b/g;
  var matches = [], m;
  while ((m = re.exec(top)) !== null) {
    var dg = m[1].replace(/[^\d]/g, '');
    if (dg.length === 10 && /^[6-9]/.test(dg)) matches.push('+91 ' + dg.slice(0, 5) + ' ' + dg.slice(5));
  }
  return matches.length ? matches[matches.length - 1] : '';   // signature sits at the bottom
}

// Classify a phone so the data sheet shows WHAT each number is (only mobile_IN is a directly-useful
// personal line; the rest are company/landline/intl switchboards).
function _phType_(raw) {
  var digits = (raw || '').toString().replace(/[^\d]/g, '');
  var d = digits;
  if (d.length === 12 && d.slice(0, 2) === '91') d = d.slice(2);
  if (d.length === 11 && d.charAt(0) === '0') d = d.slice(1);
  if (d.length === 10 && /^[6-9]/.test(d)) return 'mobile_IN';     // Indian mobile = personal
  if (d.length === 10 && /^[2-5]/.test(d)) return 'landline_IN';   // Indian landline / office (STD 2-5)
  if (digits.charAt(0) === '1' && digits.length === 11) return 'intl_US';
  return 'company_or_intl';
}

// Drop E2E/diagnostic test artifacts (RFC-reserved .example emails, automail test markers) so the
// data sheet holds only real leads.
function _phIsTestLead_(email, name) {
  var e = (email || '').toString().toLowerCase(), n = (name || '').toString().toLowerCase();
  var domain = (e.split('@')[1] || '');
  if (/\.example$/.test(domain)) return true;                      // RFC 2606 reserved — never a real lead
  if (/do-not-process|automail-(e2e|test)|@e2e-|testco-|e2e-test/.test(e)) return true;
  if (/\be2e\b|diag full name|do not process/.test(n)) return true;
  return false;
}

// PATCH 2026-06-20-leaddiag: read-only deep lookup of a lead by (partial) name across BOTH sheets.
// Returns Sheet1 (raw APK capture) AND Sheet2 (pipeline state) side-by-side so we can tell a CAPTURE
// bug (APK grabbed the wrong org) from a PROCESSING bug (pipeline changed it), and read the exact
// enrichment audit trail (enrichedEmail / emailSource / notes) behind a wrong or blank email.
function menuDiagnoseLeadByName(argS) {
  var q = (argS || '').toString().trim().toLowerCase();
  if (!q) return { status: 'error', error: 'pass a name via argS' };
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var c = CONFIG.COLUMNS;
  var out = { status: 'ok', query: q, sheet2: [], sheet1: [] };

  var s2 = ss.getSheetByName(CONFIG.DATA_SHEET);
  if (s2) {
    var d2 = s2.getDataRange().getValues();
    for (var i = 1; i < d2.length; i++) {
      if ((d2[i][c.FULL_NAME - 1] || '').toString().toLowerCase().indexOf(q) < 0) continue;
      out.sheet2.push({
        row: i + 1,
        name: (d2[i][c.FULL_NAME - 1] || '').toString(),
        headline: (d2[i][c.HEADLINE - 1] || '').toString(),
        designation: (d2[i][c.DESIGNATION - 1] || '').toString(),
        organization: (d2[i][c.ORGANIZATION - 1] || '').toString(),
        apkEmail: (d2[i][c.EMAIL - 1] || '').toString(),
        status: (d2[i][c.STATUS - 1] || '').toString(),
        enrichedEmail: (d2[i][c.ENRICHED_EMAIL - 1] || '').toString(),
        emailSource: (d2[i][c.EMAIL_SOURCE - 1] || '').toString(),
        emailConfidence: (d2[i][c.EMAIL_CONFIDENCE - 1] || '').toString(),
        notes: (d2[i][c.NOTES - 1] || '').toString().substring(0, 600),
        url: (d2[i][c.LINKEDIN_URL - 1] || '').toString()
      });
    }
  }

  var s1 = ss.getSheetByName('Sheet1');
  if (s1) {
    var d1 = s1.getDataRange().getValues();
    for (var j = 1; j < d1.length; j++) {
      if ((d1[j][2] || '').toString().toLowerCase().indexOf(q) < 0) continue;   // C Full_Name
      out.sheet1.push({
        row: j + 1,
        timestamp: d1[j][0] ? d1[j][0].toString() : '',
        url: (d1[j][1] || '').toString(), name: (d1[j][2] || '').toString(),
        headline: (d1[j][3] || '').toString(), designation: (d1[j][4] || '').toString(),
        organization: (d1[j][5] || '').toString(), email: (d1[j][6] || '').toString(),
        phone: (d1[j][7] || '').toString(), connection: (d1[j][10] || '').toString(),
        confidence: (d1[j][11] || '').toString()
      });
    }
  }
  return out;
}

// ─── VENDOR ACCOUNT + BREAKER DIAGNOSTIC (-p5-vendorfailover) ───────────────
//
// menuCheckVendorAccounts: READ-ONLY. Answers "which mail ID is the key linked
// to + how many credits are left" by calling Hunter's /v2/account (returns the
// account login email + plan + remaining credits) and Apollo's /v1/auth/health
// (validates the key WITHOUT consuming a credit), using the SERVER's
// ScriptProperty keys — then snapshots the VendorHealth circuit so you can see
// which vendor the failover is currently skipping. Full key is never returned —
// only the last-4 tail. Use after a top-up to confirm the right account refilled.
function menuCheckVendorAccounts() {
  var props = PropertiesService.getScriptProperties();
  var out = {
    hunter: {}, apollo: {}, breakers: {},
    killSwitch: (props.getProperty('VENDOR_FAILOVER_ENABLED') === '0') ? 'OFF (vendor skipping disabled)' : 'ON (failover active)'
  };

  var hk = props.getProperty('HUNTER_API_KEY');
  if (hk) {
    try {
      var hr = UrlFetchApp.fetch('https://api.hunter.io/v2/account?api_key=' + encodeURIComponent(hk),
                                 { muteHttpExceptions: true });
      var hcode = hr.getResponseCode();
      var hj = {};
      try { hj = JSON.parse(hr.getContentText()); } catch (_) {}
      var keyTail = hk.length > 4 ? ('…' + hk.substring(hk.length - 4)) : '(short)';
      if (hcode === 200 && hj && hj.data) {
        var sr = (hj.data.requests && hj.data.requests.searches) || {};
        out.hunter = {
          httpCode: hcode, keyTail: keyTail,
          accountEmail: hj.data.email || '',
          plan: hj.data.plan_name || '',
          resetDate: hj.data.reset_date || '',
          searchesUsed: (typeof sr.used === 'number') ? sr.used : null,
          searchesAvailable: (typeof sr.available === 'number') ? sr.available : null,
          searchesRemaining: (typeof sr.available === 'number' && typeof sr.used === 'number') ? (sr.available - sr.used) : null
        };
      } else {
        out.hunter = { httpCode: hcode, keyTail: keyTail, error: (hr.getContentText() || '').substring(0, 200) };
      }
    } catch (e) { out.hunter = { error: e.message }; }
  } else { out.hunter = { error: 'HUNTER_API_KEY not set in ScriptProperties' }; }

  var ak = props.getProperty('APOLLO_API_KEY');
  if (ak) {
    try {
      var ar = UrlFetchApp.fetch('https://api.apollo.io/api/v1/auth/health',
                                 { method: 'get', headers: { 'X-Api-Key': ak }, muteHttpExceptions: true });
      out.apollo = {
        httpCode: ar.getResponseCode(),
        body: (ar.getContentText() || '').substring(0, 160),
        keyTail: ak.length > 4 ? ('…' + ak.substring(ak.length - 4)) : '(short)',
        hasFallbackKey: !!props.getProperty('APOLLO_API_KEY_FALLBACK')
      };
    } catch (e) { out.apollo = { error: e.message }; }
  } else { out.apollo = { error: 'APOLLO_API_KEY not set in ScriptProperties' }; }

  try {
    var snap = (typeof vendorHealthSnapshot === 'function') ? vendorHealthSnapshot() : { providers: {} };
    out.breakers = snap.providers || {};
  } catch (e) { out.breakers = { error: e.message }; }

  Logger.log('[menuCheckVendorAccounts] ' + JSON.stringify(out, null, 2));
  return out;
}

// menuResetVendorBreaker(provider): manual circuit reset after a top-up, so the
// cascade resumes calling the vendor immediately instead of waiting for the
// cool-down probe. Pass the provider as argS (e.g. &argS=apollo). The
// vendorHealth property is self-locked (LockService) inside VendorHealth.gs.
function menuResetVendorBreaker(provider) {
  provider = (provider || '').toString().toLowerCase().trim();
  if (!provider) return { status: 'error', error: 'provider required (apollo|hunter|reoon|claude|gemini)' };
  if (typeof vendorHealthResetProvider !== 'function') return { status: 'error', error: 'VendorHealth.gs not deployed' };
  var res = vendorHealthResetProvider(provider);
  Logger.log('[menuResetVendorBreaker] ' + provider + ' reset → ' + JSON.stringify(res));
  return { status: 'ok', provider: provider, result: res };
}

// ─── ACCURACY LEDGER (-p6-accuracy-ledger) ─────────────────────────────────
//
// The ground-truth feedback loop the pipeline has lacked: it joins each lead's
// OUTCOME (STATUS col G) to the SOURCE that produced its email (EMAIL_SOURCE
// col Y) + the deliverability confidence band (EMAIL_CONFIDENCE col Z), and
// aggregates the sent / replied / bounced / deleted labels you ALREADY generate
// into per-source and per-confidence-band accuracy rates. Read-only. This is
// what tells us which sources are actually accurate vs which only LOOK
// confident — i.e. where the real dramatic gains are, instead of guessing.
//
// Pure helpers extracted so the bucket + rate math is unit-testable.

// Map a STATUS string to an outcome bucket.
function _ledgerBucketOf_(status) {
  var s = (status || '').toString().toUpperCase();
  if (s === 'RESPONDED' || s === 'REPLIED') return 'replied';      // strongest positive
  if (s.indexOf('BOUNCED') === 0) return 'bounced';                // hard negative (BOUNCED_<cat>)
  if (s === 'DRAFT_DELETED') return 'deleted';                     // human rejected the draft
  if (s === 'SENT' || s.indexOf('FOLLOWUP_') === 0) return 'sent'; // you approved + it went out
  if (s === 'DRAFT_CREATED' || s === 'DRAFT_STALE' || s === 'DRAFT_ABANDONED') return 'drafted'; // in-flight
  return 'other';                                                  // pre-draft / error — excluded from rates
}

// Confidence (col Z, 0-1) → band label aligned to the finalizer tiers.
function _ledgerConfBand_(z) {
  var v = parseFloat(z);
  if (isNaN(v)) return '(none)';
  if (v >= 0.85) return '0.85+';
  if (v >= 0.55) return '0.55-0.84';
  if (v >= 0.35) return '0.35-0.54';
  if (v >= 0.20) return '0.20-0.34';
  return '<0.20';
}

// Counts {sent,replied,bounced,deleted,...} → rates.
//   mailed     = went out (sent + replied + bounced); a replied/bounced row WAS sent.
//   bounceRate = bounced / mailed   (deliverability — the accuracy signal)
//   replyRate  = replied / mailed   (engagement / right-person signal)
//   deleteRate = deleted / (mailed + deleted)  (your manual reject rate on reviewed drafts)
function _ledgerRates_(o) {
  o = o || {};
  var sent = o.sent || 0, replied = o.replied || 0, bounced = o.bounced || 0, deleted = o.deleted || 0;
  var mailed = sent + replied + bounced;
  var reviewed = mailed + deleted;
  return {
    counts: o,
    mailed: mailed,
    bounceRate: mailed > 0 ? +(bounced / mailed).toFixed(3) : null,
    replyRate:  mailed > 0 ? +(replied / mailed).toFixed(3) : null,
    deleteRate: reviewed > 0 ? +(deleted / reviewed).toFixed(3) : null
  };
}

function menuAccuracyLedger(daysWindow) {
  var win = parseInt(daysWindow, 10);
  if (isNaN(win) || win < 0) win = 0;                       // 0 / blank = all-time
  var cutoffMs = win > 0 ? (Date.now() - win * 86400000) : 0;

  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(CONFIG.DATA_SHEET);
  if (!sheet) return { status: 'error', error: 'data sheet not found: ' + CONFIG.DATA_SHEET };
  var c = CONFIG.COLUMNS;
  var data = sheet.getDataRange().getValues();

  function fam(src) {
    return (typeof _eq2GroupSourcePrefix === 'function')
      ? _eq2GroupSourcePrefix(src) : ((src || '<empty>').toString());
  }
  function blank() { return { sent: 0, replied: 0, bounced: 0, deleted: 0, drafted: 0, other: 0 }; }

  var bySource = {}, byBand = {}, byVerify = { verify_flagged: blank(), clean: blank() };
  var totals = blank(); var rowsCounted = 0;

  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var status = row[c.STATUS - 1];
    if (!status) continue;
    if (cutoffMs) {
      var lu = row[c.LAST_UPDATED - 1];
      var luMs = lu ? new Date(lu).getTime() : 0;
      if (luMs && luMs < cutoffMs) continue;
    }
    var b = _ledgerBucketOf_(status);
    totals[b]++; rowsCounted++;
    var f = fam(row[c.EMAIL_SOURCE - 1]);
    if (!bySource[f]) bySource[f] = blank();
    bySource[f][b]++;
    var bd = _ledgerConfBand_(row[c.EMAIL_CONFIDENCE - 1]);
    if (!byBand[bd]) byBand[bd] = blank();
    byBand[bd][b]++;
    // [VERIFY] risk-flag cut: does flagging actually predict bounces? (validates the flag)
    var flagged = (row[c.SUBJECT_LINE - 1] || '').toString().indexOf('VERIFY') >= 0 ||
                  (row[c.NOTES - 1] || '').toString().indexOf('[VERIFY') >= 0;
    byVerify[flagged ? 'verify_flagged' : 'clean'][b]++;
  }

  function mapRates(obj) { var o = {}; Object.keys(obj).forEach(function(k){ o[k] = _ledgerRates_(obj[k]); }); return o; }

  // Worst-first: sources with >=3 mailed, ranked by bounceRate desc — the weak links.
  var ranked = Object.keys(bySource).map(function(k){ return { source: k, r: _ledgerRates_(bySource[k]) }; })
    .filter(function(x){ return x.r.mailed >= 3; })
    .sort(function(a, b){ return (b.r.bounceRate || 0) - (a.r.bounceRate || 0); })
    .map(function(x){ return { source: x.source, mailed: x.r.mailed, bounceRate: x.r.bounceRate,
                               replyRate: x.r.replyRate, deleteRate: x.r.deleteRate, counts: x.r.counts }; });

  var result = {
    windowDays: win || 'all', rowsCounted: rowsCounted, totals: totals,
    worstSourcesByBounce: ranked,
    bySource: mapRates(bySource),
    byConfidenceBand: mapRates(byBand),
    byVerifyFlag: mapRates(byVerify),
    legend: 'bounceRate/replyRate = of MAILED (sent+replied+bounced). deleteRate = deleted/(mailed+deleted) = your manual reject rate. drafted=in-flight (excluded). other=pre-draft/error (excluded). worstSourcesByBounce omits sources with <3 mailed (noise).'
  };
  Logger.log('[menuAccuracyLedger] ' + JSON.stringify(result, null, 2));
  return result;
}
