/**
 * ============================================================
 * BounceProcessor.gs — Post-send bounce feedback loop (Patch 2026-05-11)
 *
 * Scans the Gmail inbox for delivery-failure notifications, parses the
 * failed recipient + bounce category (hard / soft), and updates two stores:
 *
 *   1. `BounceLog` sheet — per-bounce row for audit / debugging
 *   2. `bouncedDomains` script property — per-domain { hard, soft } counter
 *      that EmailEnricher._getDomainBouncePenalty() reads to lower auto-pick
 *      confidence for domains with known delivery problems
 *
 * Bounces parsed from RFC 3464 DSN format (Final-Recipient + Status fields).
 * Both Gmail-side `mailer-daemon@googlemail.com` bounces and remote-MTA
 * `postmaster@*` rejections are covered.
 *
 * Schedule:
 *   ScriptApp.newTrigger('processBounces').timeBased().everyMinutes(30).create();
 *
 * Quotas:
 *   - Gmail read/write: 20k/day (consumer) or 50k/day (Workspace)
 *   - Apps Script max run: 6 min; this scans 200 threads/run worst case
 *   - With 48 runs/day @ 200 threads = 9.6k operations, well within budget
 *
 * Idempotency:
 *   Threads are labelled `bounce-processed` after scan; the search query
 *   excludes that label so we never re-scan. Re-running the trigger is safe.
 * ============================================================
 */

var BOUNCE_LABEL = 'bounce-processed';
var BOUNCE_SHEET = 'BounceLog';
var BOUNCE_PROPERTY = 'bouncedDomains';
var BOUNCED_DOMAINS_SHEET = 'BouncedDomains';  // PATCH 2026-05-12: migrated from ScriptProperty (9KB cap)
// 5-day window catches retried-delivery bounces (Gmail retries failed sends
// for up to 72h before giving up); processed-label is the durable idempotency
// guard for anything older.
//
// PATCH `-eq8-g9-bouncefix` (G9 root cause): the old query carried a
// `subject:(failure OR failed OR undelivered OR "delivery status")` clause that
// matched ZERO threads while the raw from:(mailer-daemon OR postmaster) search
// found 50 NDRs in the same 30 days (EQ.0 vs processBounces run 2026-06-10).
// Gmail threads NDRs onto the ORIGINAL message, so thread subjects are usually
// the original mail subject ("Job Application | ..."), not "Delivery Status
// Notification" — the subject pre-filter silently dropped everything.
// `_parseBounceMessage` already validates each message individually, so the
// SEARCH must be broad and the PARSER is the filter.
var BOUNCE_SEARCH_QUERY = 'from:(mailer-daemon OR postmaster) ' +
                          'newer_than:5d -label:bounce-processed';

// Build the query for a configurable window. includeSpam adds in:anywhere so
// spam-routed NDRs are swept too (backfill use).
function _bounceSearchQuery(daysBack, includeSpam, ignoreLabel) {
  daysBack = (typeof daysBack === 'number' && daysBack > 0) ? Math.floor(daysBack) : 5;
  var q = 'from:(mailer-daemon OR postmaster) newer_than:' + daysBack + 'd';
  // ignoreLabel (G9b re-sweep): threads were labeled bounce-processed even
  // though the broken parser logged nothing from them. The re-sweep must see
  // them again; ThreadId dedupe in processBounces prevents duplicate rows.
  if (!ignoreLabel) q += ' -label:bounce-processed';
  if (includeSpam) q = 'in:anywhere ' + q;
  return q;
}

/**
 * PATCH `-eq8-g9b-prep`: dump ONE raw mailer-daemon NDR so the parser can be
 * fixed against the REAL format Gmail uses (G9b: _parseBounceMessage rejected
 * ~all of the 26 scanned threads). Read-only; returns from/subject/body-head
 * for each message in the newest NDR thread, plus which message (if any) the
 * current parser accepts.
 */
function menuDumpOneNdrSample() {
  var threads = GmailApp.search('in:anywhere from:(mailer-daemon OR postmaster) newer_than:30d', 0, 1);
  if (typeof _gmOps === 'function') _gmOps('g9b.dump', 1 + threads.length);
  if (!threads.length) return { found: 0 };
  var msgs = threads[0].getMessages();
  var out = { found: 1, threadId: threads[0].getId(), messageCount: msgs.length, messages: [] };
  for (var i = 0; i < msgs.length; i++) {
    var m = msgs[i];
    var parsedOk = null;
    try { parsedOk = _parseBounceMessage(m); } catch (e) { parsedOk = 'threw: ' + e.message; }
    out.messages.push({
      idx: i,
      from: (m.getFrom() || '').substring(0, 120),
      subject: (m.getSubject() || '').substring(0, 120),
      date: m.getDate().toISOString(),
      bodyHead: (m.getPlainBody() || '').substring(0, 1200),
      parserAccepts: parsedOk && typeof parsedOk === 'object' ? parsedOk : (parsedOk || false)
    });
  }
  return out;
}

/**
 * One-time (re-runnable) backfill: sweep the last 30 days INCLUDING spam-routed
 * NDRs. Use after a capture outage (like the subject-filter regression).
 * Idempotent via the bounce-processed label.
 */
function menuBackfillBounces30d() {
  // ignoreLabel: re-sweep threads the broken parser labeled-but-skipped (G9b).
  return processBounces({ daysBack: 30, maxThreads: 500, includeSpam: true, ignoreLabel: true });
}

/**
 * Public entry. Schedule on a 30-min time-based trigger.
 * Returns array of parsed bounces for testing / manual invocation.
 *
 * @param {Object} [opts] — {daysBack, maxThreads, includeSpam}. NOTE: time-based
 *   triggers pass a clock-event object as the first arg; we only treat it as
 *   options when it carries our known keys (classic GAS trigger-arg pitfall).
 */
function processBounces(opts) {
  var o = (opts && (typeof opts.daysBack === 'number' ||
                    typeof opts.maxThreads === 'number' ||
                    typeof opts.includeSpam === 'boolean' ||
                    typeof opts.ignoreLabel === 'boolean')) ? opts : {};
  var runStart = Date.now();
  var label = GmailApp.getUserLabelByName(BOUNCE_LABEL) || GmailApp.createLabel(BOUNCE_LABEL);

  // ── Output sheet ──
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(BOUNCE_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(BOUNCE_SHEET);
    sheet.appendRow([
      'Timestamp', 'Email', 'Domain', 'Category', 'StatusCode',
      'Reason', 'ThreadId', 'OriginalSubject'
    ]);
    sheet.getRange(1, 1, 1, 8).setFontWeight('bold');
  }

  // ── Bounced-domains counter ──
  // PATCH 2026-05-12 (audit fix): migrate from ScriptProperty to BouncedDomains
  // sheet to escape the 9KB property-value cap. Load existing state from sheet
  // (or from legacy property as one-time migration), accumulate in memory,
  // write back to sheet at end of run.
  var bouncedDomains = _bouncedDomainsLoad(ss);

  // ── Search ──
  var __query = _bounceSearchQuery(o.daysBack, o.includeSpam, o.ignoreLabel);
  var __cap = (typeof o.maxThreads === 'number' && o.maxThreads > 0) ? o.maxThreads : 200;
  Logger.log('[BounceProcessor] query="' + __query + '" cap=' + __cap);
  var threads = GmailApp.search(__query, 0, __cap);
  if (typeof _gmOps === 'function') _gmOps('bounce.scan', 1 + threads.length);
  var newRows = [];
  var parsedCount = 0;
  var skippedCount = 0;

  // G9b re-sweep dedupe: when ignoring the processed-label, skip threads whose
  // ThreadId is already in BounceLog so re-runs never duplicate rows.
  var __loggedThreadIds = {};
  if (o.ignoreLabel && sheet.getLastRow() >= 2) {
    sheet.getRange(2, 7, sheet.getLastRow() - 1, 1).getValues().forEach(function(r) {
      if (r[0]) __loggedThreadIds[r[0].toString()] = true;
    });
  }

  for (var t = 0; t < threads.length; t++) {
    var thread = threads[t];
    if (o.ignoreLabel && __loggedThreadIds[thread.getId()]) { continue; }
    var messages = thread.getMessages();
    for (var m = 0; m < messages.length; m++) {
      var parsed = _parseBounceMessage(messages[m]);
      if (!parsed) { skippedCount++; continue; }

      var dom = (parsed.email.split('@')[1] || '').toLowerCase();
      newRows.push([
        parsed.timestamp,
        parsed.email,
        dom,
        parsed.category,
        parsed.statusCode,
        parsed.reason,
        thread.getId(),
        parsed.subject
      ]);

      if (dom) {
        if (!bouncedDomains[dom]) bouncedDomains[dom] = { hard: 0, soft: 0, firstSeen: parsed.timestamp };
        bouncedDomains[dom][parsed.category] = (bouncedDomains[dom][parsed.category] || 0) + 1;
        bouncedDomains[dom].lastSeen = parsed.timestamp;
      }
      parsedCount++;

      // ── Lead-row update: if this bounced address is on a Sheet2 row, mark BOUNCED ──
      try {
        _markLeadRowBounced(ss, parsed);
      } catch (lrErr) {
        Logger.log('[BounceProcessor] lead row update failed for ' + parsed.email + ': ' + lrErr.message);
      }
    }
    // Idempotency: mark whole thread regardless of parse success so we never re-scan
    try { thread.addLabel(label); } catch (_) {}

    // Soft budget guard: stop early if we've burned > 4 min
    if (Date.now() - runStart > 240000) {
      Logger.log('[BounceProcessor] Time budget reached at thread ' + (t + 1) +
                 '/' + threads.length + ' — stopping early');
      break;
    }
  }

  if (newRows.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, newRows[0].length).setValues(newRows);
  }
  // PATCH 2026-05-12: write bouncedDomains to dedicated sheet (no 9KB cap)
  // instead of ScriptProperty. Property still updated as a small read-cache
  // for callers that haven't been migrated yet (EmailEnricher already reads
  // from _bouncedDomainsGet which falls through to sheet if property absent).
  try {
    _bouncedDomainsSave(ss, bouncedDomains);
  } catch (e) {
    Logger.log('[BounceProcessor] WARN: bouncedDomains sheet write failed: ' + e.message);
  }

  Logger.log('[BounceProcessor] Run done. Threads scanned: ' + threads.length +
             ', bounces parsed: ' + parsedCount + ', skipped: ' + skippedCount +
             ', domains tracked: ' + Object.keys(bouncedDomains).length);
  return { threads: threads.length, parsed: parsedCount, skipped: skippedCount };
}

/**
 * Parse one bounce GmailMessage. Returns null for non-failures (OOO, delays).
 */
function _parseBounceMessage(msg) {
  var body, subject;
  try {
    body = msg.getPlainBody() || '';
    subject = msg.getSubject() || '';
  } catch (e) { return null; }

  // ── PATCH `-eq8-g9b-parserfix` (G9b root cause) ──────────────────────────
  // (1) DSN-SENDER GATE: only messages FROM a delivery subsystem are bounce
  //     candidates. The thread search matches mailer-daemon threads, but the
  //     loop iterates EVERY message in the thread — including the user's own
  //     outbound, whose body could trip the last-resort email-token scan and
  //     fabricate junk bounce rows.
  // (2) Gmail's own DSNs carry `Auto-Submitted: auto-replied` — the auto-reply
  //     skip below (meant for out-of-office mail) was rejecting EVERY genuine
  //     Gmail bounce (26 threads scanned → ~0 parsed on 2026-06-11). For DSN
  //     senders that header is expected; the skip now applies only to non-DSN
  //     senders, which gate (1) already returns on.
  var __from = '';
  try { __from = (msg.getFrom() || '').toString(); } catch (_) {}
  if (!/mailer-daemon|postmaster|mail delivery (subsystem|system)/i.test(__from)) {
    return null;
  }

  // Skip non-failure Action values (delayed/relayed/delivered/expanded)
  var actionMatch = body.match(/^Action:\s*(.+)$/im);
  var action = actionMatch ? actionMatch[1].trim().toLowerCase() : '';
  if (action && action !== 'failed') return null;
  // If no Action: header at all, still try to parse (some remote MTAs omit it)

  // PATCH `-eq8-g9b-parserfix`: the Auto-Submitted skip is REMOVED for DSN
  // senders (the only messages that reach this point, per the gate above).
  // Gmail DSNs legitimately carry `Auto-Submitted: auto-replied` — this check
  // was the G9b root cause that rejected every genuine bounce. Out-of-office
  // auto-replies come from human senders and never pass the DSN-sender gate.

  // 1. Prefer X-Failed-Recipients (Gmail's native header)
  var recipient = '';
  try {
    var xfail = msg.getHeader('X-Failed-Recipients');
    if (xfail) recipient = xfail.split(',')[0].trim();
  } catch (_) {}

  // 2. Fallback: Final-Recipient in DSN body
  if (!recipient) {
    var fr = body.match(/Final-Recipient:\s*rfc822;\s*([\w.+\-]+@[\w.\-]+)/im);
    if (fr) recipient = fr[1].trim();
  }
  // 3. Last resort: scan body for first email-shape token
  if (!recipient) {
    var anyMail = body.match(/([\w.+\-]+@[\w.\-]+\.[a-z]{2,})/i);
    if (anyMail) recipient = anyMail[1].trim();
  }
  if (!recipient || recipient.toLowerCase().indexOf('mailer-daemon') === 0) return null;

  // Status code → hard/soft classification
  var statusMatch = body.match(/^Status:\s*([245])\.(\d+)\.(\d+)/im);
  var statusCode = statusMatch ? (statusMatch[1] + '.' + statusMatch[2] + '.' + statusMatch[3]) : '';
  var firstDigit = statusMatch ? statusMatch[1] : '';
  var category;
  if (firstDigit === '5') category = 'hard';
  else if (firstDigit === '4') category = 'soft';
  else {
    // No status code parsed — infer from SMTP 5xx/4xx in diagnostic
    if (/55\d\s|55\d-/.test(body)) category = 'hard';
    else if (/45\d\s|45\d-/.test(body)) category = 'soft';
    else category = 'unknown';
  }

  // Reason from Diagnostic-Code (preferred) or body snippet
  var reason = '';
  var diag = body.match(/^Diagnostic-Code:\s*[^;]+;\s*(.+)$/im);
  if (diag) {
    reason = diag[1].trim();
  } else {
    // Body snippet near recipient address
    var snip = body.indexOf(recipient);
    if (snip >= 0) {
      reason = body.substring(snip, Math.min(snip + 200, body.length)).replace(/\s+/g, ' ');
    } else {
      reason = subject;
    }
  }
  reason = (reason || '').substring(0, 250);

  return {
    email: recipient.toLowerCase(),
    reason: reason,
    category: category,
    statusCode: statusCode,
    timestamp: msg.getDate().toISOString(),
    subject: subject.substring(0, 200)
  };
}

/**
 * If a bounced email matches a Sheet2 row, mark that row's status BOUNCED.
 * Best-effort: silent on failure, never blocks the main bounce scan.
 */
function _markLeadRowBounced(ss, parsed) {
  if (!parsed || !parsed.email) return;
  var sheet = ss.getSheetByName(CONFIG.DATA_SHEET);
  if (!sheet) return;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  var c = CONFIG.COLUMNS;
  var emailCol = c.EMAIL;
  var enrichedCol = c.ENRICHED_EMAIL || 0;
  var statusCol = c.STATUS;
  var notesCol = c.NOTES;

  var width = CONFIG.SHEET_COL_COUNT || 26;
  var allRows = sheet.getRange(2, 1, lastRow - 1, width).getValues();
  var target = parsed.email.toLowerCase();

  for (var i = 0; i < allRows.length; i++) {
    var r = allRows[i];
    var sheetEmail = ((r[emailCol - 1] || '') + '').toLowerCase().trim();
    var enriched = enrichedCol ? ((r[enrichedCol - 1] || '') + '').toLowerCase().trim() : '';
    if (sheetEmail === target || enriched === target) {
      var rowNum = i + 2;
      sheet.getRange(rowNum, statusCol).setValue('BOUNCED_' + parsed.category.toUpperCase());
      var existingNotes = (r[notesCol - 1] || '') + '';
      var bounceNote = '[BOUNCE ' + parsed.timestamp.substring(0, 10) +
                       ' ' + parsed.category + ' ' + parsed.statusCode + '] ' + parsed.reason;
      sheet.getRange(rowNum, notesCol).setValue(
        (existingNotes ? existingNotes + ' | ' : '') + bounceNote
      );
      Logger.log('[BounceProcessor] Marked row ' + rowNum + ' BOUNCED for ' + target);
      return;  // assume one row per email; stop at first hit
    }
  }
}

/**
 * One-time installer — schedule the 30-min trigger. Idempotent: removes any
 * existing trigger for processBounces before creating a new one.
 *
 * Run this once from the Apps Script editor after deploy.
 */
function installBounceTrigger() {
  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === 'processBounces') {
      ScriptApp.deleteTrigger(existing[i]);
    }
  }
  ScriptApp.newTrigger('processBounces').timeBased().everyMinutes(30).create();
  Logger.log('[BounceProcessor] 30-minute trigger installed for processBounces');
}

/**
 * Diagnostic — returns the current bouncedDomains map for inspection.
 * Hook into WebApp.gs?action=bounces if you want HTTP visibility.
 *
 * PATCH 2026-05-12: prefer BouncedDomains sheet over ScriptProperty
 * (no 9KB cap). Falls back to property for backward compat.
 */
function getBouncedDomainsSnapshot() {
  try {
    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var map = _bouncedDomainsLoad(ss);
    return { domains: map, count: Object.keys(map).length, source: 'BouncedDomains_sheet' };
  } catch (e) {
    var raw = PropertiesService.getScriptProperties().getProperty(BOUNCE_PROPERTY);
    if (!raw) return { domains: {}, count: 0 };
    try { var m = JSON.parse(raw); return { domains: m, count: Object.keys(m).length, source: 'property_fallback' }; }
    catch (_) { return { domains: {}, count: 0, error: e.message }; }
  }
}

// ─── Sheet-backed bouncedDomains store (Patch 2026-05-12) ──────────────────
//
// Replaces the ScriptProperty store which hit the 9KB cap at ~90 unique
// domains. Schema: [Domain, Hard_Count, Soft_Count, First_Seen, Last_Seen].
//
// Idempotent migration: if BouncedDomains sheet is missing/empty AND the
// legacy `bouncedDomains` property exists, the property is migrated into
// the sheet on first load and the property is left in place as a fallback
// read source for stale callers.

function _bouncedDomainsEnsureSheet(ss) {
  var sheet = ss.getSheetByName(BOUNCED_DOMAINS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(BOUNCED_DOMAINS_SHEET);
    sheet.appendRow(['Domain', 'Hard_Count', 'Soft_Count', 'First_Seen', 'Last_Seen']);
    sheet.getRange(1, 1, 1, 5).setFontWeight('bold');
  }
  return sheet;
}

function _bouncedDomainsLoad(ss) {
  var sheet = _bouncedDomainsEnsureSheet(ss);
  var map = {};
  if (sheet.getLastRow() >= 2) {
    var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 5).getValues();
    for (var i = 0; i < data.length; i++) {
      var d = (data[i][0] || '').toString().toLowerCase().trim();
      if (!d) continue;
      map[d] = {
        hard: parseInt(data[i][1]) || 0,
        soft: parseInt(data[i][2]) || 0,
        firstSeen: data[i][3] ? data[i][3].toString() : null,
        lastSeen: data[i][4] ? data[i][4].toString() : null
      };
    }
  } else {
    // Sheet empty → one-time migration from legacy ScriptProperty
    try {
      var legacy = PropertiesService.getScriptProperties().getProperty(BOUNCE_PROPERTY);
      if (legacy) {
        var parsed = JSON.parse(legacy);
        Object.keys(parsed).forEach(function(d) {
          map[d] = parsed[d];
        });
        Logger.log('[BounceProcessor] Migrated ' + Object.keys(map).length + ' legacy bouncedDomains entries to sheet');
        _bouncedDomainsSave(ss, map);
      }
    } catch (e) {
      Logger.log('[BounceProcessor] migration parse failed: ' + e.message);
    }
  }
  return map;
}

function _bouncedDomainsSave(ss, map) {
  var sheet = _bouncedDomainsEnsureSheet(ss);
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) sheet.deleteRows(2, lastRow - 1);
  var rows = Object.keys(map).map(function(d) {
    var e = map[d] || {};
    return [d, e.hard || 0, e.soft || 0, e.firstSeen || '', e.lastSeen || ''];
  });
  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, 5).setValues(rows);
  }
  // Maintain a small property cache (truncated to top-50-by-hard for legacy callers)
  try {
    var top = Object.keys(map).map(function(d) { return [d, map[d]]; })
      .sort(function(a, b) { return (b[1].hard || 0) - (a[1].hard || 0); })
      .slice(0, 50)
      .reduce(function(acc, kv) { acc[kv[0]] = kv[1]; return acc; }, {});
    PropertiesService.getScriptProperties().setProperty(BOUNCE_PROPERTY, JSON.stringify(top));
  } catch (_) {}
}
