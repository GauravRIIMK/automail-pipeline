/**
 * ============================================================
 * Tracking.gs — Email open + link-click tracking (Patch 2026-05-11)
 *
 * Provides:
 *   1. doGet handlers:
 *        - action=track_open  → 1x1 transparent PNG (data-URI in HTML), logs open
 *        - action=track_click → meta-refresh redirect to original URL, logs click
 *        - action=tracking_summary → JSON of opens + clicks for a given lead
 *   2. Helpers used by EmailComposer.gs at draft-creation time:
 *        - newTrackingId(leadRow, draftId, threadId, linkedinUrl)
 *        - rewriteLinksForTracking(htmlBody, trackingId, leadRow, linkedinUrl)
 *        - buildPixelTag(trackingId)
 *
 * Sheets touched:
 *   - TrackingLog   : 8 cols [ts, event, tracking_id, link_id, thread_id,
 *                             lead_row, linkedin_url, ua]   (audit trail)
 *   - TrackingLinks : 7 cols [tracking_id, link_id, original_url, lead_row,
 *                             linkedin_url, created_at, click_count]
 *
 * Dedup semantics:
 *   - Opens: 30-second window per tracking_id to collapse Gmail's prefetch
 *     scan that fires near-instantly at delivery (false-positive at-delivery
 *     "opens"). Filter at log-time; the on-record count = unique opens.
 *   - Clicks: each click is logged (per-link counter). Bot-filter is a soft
 *     gate based on click_delta_from_send: if < 5s, mark as `event=scan_click`
 *     so the summary endpoint can distinguish humans from corporate URL
 *     pre-fetchers (Mimecast/SafeLinks/Proofpoint).
 *
 * Limitations (Apps Script platform):
 *   - doGet cannot return HTTP 302 — we use HtmlService + meta-refresh
 *   - doGet cannot read inbound User-Agent or IP — UA col stays blank
 *   - ContentService has no image MimeType — we use HtmlOutput w/ data-URI PNG
 * ============================================================
 */

var TRACKING_LOG_SHEET = 'TrackingLog';
var TRACKING_LINKS_SHEET = 'TrackingLinks';
var TRACKING_DEDUP_OPEN_MS = 30 * 1000;     // 30s collapse window
var TRACKING_BOT_CLICK_THRESHOLD_MS = 5000; // <5s after send = scan_click

// Smallest valid 1x1 transparent PNG, base64 (67 bytes decoded)
var TRACKING_PIXEL_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

// ─── Public entry: WebApp.gs routes these actions to us ────────────

function trackingHandleOpen(e) {
  try {
    var t = (e && e.parameter && e.parameter.t) || '';
    if (t) _trackingRecordOpen(t);
  } catch (err) {
    Logger.log('[Tracking] open error: ' + err.message);
  }
  return _trackingPixelResponse();
}

function trackingHandleClick(e) {
  var trackingId = (e && e.parameter && e.parameter.t) || '';
  var linkId = (e && e.parameter && e.parameter.l) || '';
  var dest = '';
  try {
    dest = _trackingLookupLinkUrl(trackingId, linkId);
    if (trackingId) _trackingRecordClick(trackingId, linkId, dest);
  } catch (err) {
    Logger.log('[Tracking] click error: ' + err.message);
  }
  if (!dest) {
    return HtmlService.createHtmlOutput(
      '<html><body><p>Link not found.</p></body></html>'
    ).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }
  return _trackingRedirectResponse(dest);
}

function trackingHandleSummary(e) {
  var p = (e && e.parameter) || {};
  var linkedinUrl = (p.url || '').toString().trim().toLowerCase().replace(/\/$/, '');
  var trackingId = (p.t || '').toString();
  if (!linkedinUrl && !trackingId) {
    return _trackingJson({ status: 'error', error: 'must_provide_url_or_t' });
  }
  try {
    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var logSheet = ss.getSheetByName(TRACKING_LOG_SHEET);
    var linksSheet = ss.getSheetByName(TRACKING_LINKS_SHEET);
    if (!logSheet) {
      return _trackingJson({ status: 'ok', found: false, message: 'no_tracking_log_yet' });
    }

    var data = logSheet.getDataRange().getValues();
    // Schema: ts, event, tracking_id, link_id, thread_id, lead_row, linkedin_url, ua
    var opens = [];
    var clicks = [];
    var scanClicks = [];
    var resolvedTrackingId = trackingId;
    var threadId = '';
    var leadRow = 0;

    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      var rowUrl = (row[6] || '').toString().toLowerCase().replace(/\/$/, '');
      var matches = trackingId
        ? (row[2] === trackingId)
        : (rowUrl === linkedinUrl);
      if (!matches) continue;
      if (!resolvedTrackingId) resolvedTrackingId = row[2];
      if (!threadId && row[4]) threadId = row[4];
      if (!leadRow && row[5]) leadRow = row[5];

      var evt = (row[1] || '').toString();
      var entry = {
        ts: row[0] ? row[0].toString() : '',
        linkId: (row[3] || '').toString() || null
      };
      if (evt === 'open') opens.push(entry);
      else if (evt === 'click') clicks.push(entry);
      else if (evt === 'scan_click') scanClicks.push(entry);
    }

    // Per-link aggregation
    var perLink = {};
    clicks.forEach(function(c) {
      if (!c.linkId) return;
      perLink[c.linkId] = (perLink[c.linkId] || 0) + 1;
    });

    // Pull original URLs for context
    var linkUrls = {};
    if (linksSheet && resolvedTrackingId) {
      var linkData = linksSheet.getDataRange().getValues();
      for (var j = 1; j < linkData.length; j++) {
        if (linkData[j][0] === resolvedTrackingId) {
          linkUrls[linkData[j][1]] = (linkData[j][2] || '').toString();
        }
      }
    }

    return _trackingJson({
      status: 'ok',
      found: opens.length > 0 || clicks.length > 0 || scanClicks.length > 0,
      trackingId: resolvedTrackingId || null,
      threadId: threadId || null,
      leadRow: leadRow || null,
      linkedinUrl: linkedinUrl || null,
      opens: opens.length,
      lastOpenAt: opens.length ? opens[opens.length - 1].ts : null,
      firstOpenAt: opens.length ? opens[0].ts : null,
      clicks: clicks.length,
      clicksPerLink: perLink,
      linkUrls: linkUrls,
      scanClicks: scanClicks.length,
      gmailThreadUrl: threadId
        ? 'https://mail.google.com/mail/u/0/#inbox/' + threadId
        : null
    });
  } catch (err) {
    return _trackingJson({ status: 'error', error: err.message });
  }
}

// ─── Helpers called by EmailComposer.gs at draft-creation time ──────

/**
 * Create a tracking ID and persist a stub link record. Should be called once
 * per email send, before HTML body is finalized.
 */
function newTrackingId(leadRow, draftId, threadId, linkedinUrl) {
  return Utilities.getUuid();  // 36-char UUID v4, URL-safe
}

/**
 * Returns the pixel <img> tag to embed at the bottom of the email HTML.
 * Caller passes the tracking_id obtained from newTrackingId().
 */
function buildPixelTag(trackingId) {
  var base = _trackingWebAppBase();
  if (!base) return '';
  return '<img src="' + base + '?action=track_open&t=' + encodeURIComponent(trackingId) +
         '" width="1" height="1" alt="" style="display:none;border:0;outline:none;" />';
}

/**
 * Rewrites all <a href> links in the HTML body to go through our tracker.
 * Stores the (tracking_id, link_id) → original_url map in TrackingLinks sheet.
 *
 * Skips: mailto:, tel:, sms:, #anchor, javascript:, already-wrapped tracker URLs.
 *
 * PATCH 2026-06-11-eq8-deliv-v2 (T4): when FORMAT_DELIV_V2 is ON, the two
 * CTA destination domains (calendly.com and github.com/GauravRIIMK) are
 * exempt from rewrapping — their hrefs are kept DIRECT.
 * Rationale: script.google.com redirect hrefs are documented phishing infra
 * blocked by some corporate gateways (binary-fatal, invisible to testers).
 * No free reputable redirect host exists at $0. The PIXEL stays on
 * script.google.com (image fetch ≠ click destination; lower risk class).
 * Click-tracking is intentionally lost on CTAs by design ($0 constraint);
 * opens are still tracked via the pixel.
 */
function rewriteLinksForTracking(htmlBody, trackingId, leadRow, linkedinUrl) {
  if (!htmlBody || !trackingId) return htmlBody;
  var base = _trackingWebAppBase();
  if (!base) return htmlBody;  // no webapp URL — no tracking, return as-is

  // PATCH 2026-06-11-eq8-deliv-v2 (T4): CTA exemption domains.
  // When V2 is ON, hrefs matching these are passed through unchanged.
  // Click-tracking lost on CTAs by design ($0 constraint); opens tracked via pixel.
  var _delivV2CtaOn = (typeof _enrichmentFlag === 'function') && _enrichmentFlag('FORMAT_DELIV_V2');
  var _ctaExemptRe = _delivV2CtaOn
    ? /^https?:\/\/(www\.)?calendly\.com\/|^https?:\/\/(www\.)?github\.com\/GauravRIIMK|^https?:\/\/(www\.)?linkedin\.com\/in\/gaurav1-grow-learn-together/i
    : null;

  // Strip <style> / <script> blocks so we don't mangle CSS selectors that
  // happen to contain href references.
  var stripped = [];
  var safe = htmlBody.replace(/<style[\s\S]*?<\/style>/gi, function(m) {
    stripped.push(m); return '__TRACK_STYLE_' + (stripped.length - 1) + '__';
  }).replace(/<script[\s\S]*?<\/script>/gi, function(m) {
    stripped.push(m); return '__TRACK_STYLE_' + (stripped.length - 1) + '__';
  });

  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = _trackingEnsureLinksSheet(ss);
  var linkRows = [];
  var linkIndex = 0;

  var hrefRe = /<a\b([^>]*?\bhref\s*=\s*)(["'])([\s\S]*?)\2([^>]*?>)/gi;
  var skipRe = /^(mailto:|tel:|sms:|#|javascript:)/i;

  var rewritten = safe.replace(hrefRe, function(match, pre, quote, url, post) {
    var trimmed = (url || '').toString().trim();
    if (!trimmed) return match;
    if (skipRe.test(trimmed)) return match;
    if (trimmed.indexOf(base) === 0) return match;  // already wrapped
    if (!/^https?:\/\//i.test(trimmed)) return match;  // skip relative for now

    // PATCH 2026-06-11-eq8-deliv-v2 (T4): exempt CTA domains from rewrapping
    if (_ctaExemptRe && _ctaExemptRe.test(trimmed)) return match;  // direct href kept

    linkIndex++;
    var linkId = 'L' + linkIndex;
    var trackedHref = base + '?action=track_click&t=' + encodeURIComponent(trackingId) +
                       '&l=' + encodeURIComponent(linkId);
    linkRows.push([
      trackingId, linkId, trimmed, leadRow || 0, linkedinUrl || '',
      new Date().toISOString(), 0
    ]);
    return '<a' + pre + quote + trackedHref + quote + post;
  });

  // Restore stripped blocks
  var final = rewritten.replace(/__TRACK_STYLE_(\d+)__/g, function(_, i) {
    return stripped[parseInt(i, 10)];
  });

  if (linkRows.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, linkRows.length, linkRows[0].length)
         .setValues(linkRows);
  }

  return final;
}

// ─── Internal: logging + lookup ─────────────────────────────────────

function _trackingRecordOpen(trackingId) {
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = _trackingEnsureLogSheet(ss);
  var meta = _trackingLookupMeta(ss, trackingId);

  // Dedup: collapse opens within 30s window
  var lastTs = _trackingLastEventTs(sheet, trackingId, 'open');
  if (lastTs && (Date.now() - lastTs) < TRACKING_DEDUP_OPEN_MS) {
    return;
  }
  sheet.appendRow([
    new Date().toISOString(),
    'open',
    trackingId,
    '',
    meta.threadId || '',
    meta.leadRow || '',
    meta.linkedinUrl || '',
    ''
  ]);
  // PATCH 2026-05-12: fire FCM push so the APK gets real-time notification
  // (vs the 15-min poll). Best-effort — failure never blocks the log.
  // PATCH 2026-06-12-funnel-truth (F2): resolve lead's real name from the data
  // sheet via meta.leadRow (bounded single-row read, 60s cache). Previously
  // this used only the LinkedIn URL slug, which is an unreadable handle (e.g.
  // "neel-murthy-123abc"), not the person's actual name.
  try {
    if (typeof sendFcmBroadcast === 'function') {
      var who = _trackingResolveFcmName(ss, meta.leadRow, meta.linkedinUrl);
      sendFcmBroadcast('👀 Email opened', who + ' just opened your email',
        { event: 'open', trackingId: trackingId, threadId: meta.threadId || '',
          leadRow: String(meta.leadRow || ''), leadName: who });
    }
  } catch (fcmErr) { Logger.log('[FCM] open push failed: ' + fcmErr.message); }
}

function _trackingRecordClick(trackingId, linkId, destUrl) {
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = _trackingEnsureLogSheet(ss);
  var meta = _trackingLookupMeta(ss, trackingId);

  // Bot heuristic — if click landed < 5s after the link map's created_at,
  // it's almost certainly a corporate URL pre-fetcher (Mimecast / SafeLinks /
  // Proofpoint), not a human. Mark as 'scan_click' so the summary endpoint
  // can distinguish; humans typically click ≥30s after delivery.
  var createdAt = _trackingLinkCreatedAt(ss, trackingId, linkId);
  var deltaMs = createdAt ? (Date.now() - createdAt) : 0;
  var event = (createdAt && deltaMs < TRACKING_BOT_CLICK_THRESHOLD_MS) ? 'scan_click' : 'click';

  sheet.appendRow([
    new Date().toISOString(),
    event,
    trackingId,
    linkId || '',
    meta.threadId || '',
    meta.leadRow || '',
    meta.linkedinUrl || '',
    ''
  ]);

  // Bump click_count on TrackingLinks row (best-effort)
  if (event === 'click') {
    try { _trackingBumpClickCount(ss, trackingId, linkId); } catch (_) {}
    // PATCH 2026-05-12: FCM push on REAL click (skip scan_click bots)
    // [2026-06-12-fcm-name-fix] Use _trackingResolveFcmName (same as open path)
    // instead of the raw slug strip. Previously this used
    //   meta.linkedinUrl.replace(/linkedin.com\/in\//, '')
    // which produces a URL handle like "neel-murthy-123abc" not a real name.
    // [activates at next deploy post-version-prune]
    try {
      if (typeof sendFcmBroadcast === 'function') {
        var who = _trackingResolveFcmName(ss, meta.leadRow, meta.linkedinUrl);
        sendFcmBroadcast('🖱 Link clicked', who + ' clicked a link',
          { event: 'click', trackingId: trackingId, linkId: linkId,
            threadId: meta.threadId || '', leadName: who });
      }
    } catch (fcmErr) { Logger.log('[FCM] click push failed: ' + fcmErr.message); }
  }
}

function _trackingLookupLinkUrl(trackingId, linkId) {
  if (!trackingId || !linkId) return '';
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(TRACKING_LINKS_SHEET);
  if (!sheet) return '';
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === trackingId && data[i][1] === linkId) {
      return (data[i][2] || '').toString();
    }
  }
  return '';
}

function _trackingLookupMeta(ss, trackingId) {
  // Pulls thread_id / lead_row / linkedin_url from the FIRST TrackingLinks row
  // matching this tracking_id. Composer registers all link rows with these
  // fields, so any row gives us the meta.
  // PATCH 2026-06-12-e2e-hardening: read column index 7 (Thread_ID, column H)
  // which _trackingStampThreadId writes after draft creation (GmailDrafter.gs
  // line ~371). Previously threadId was hardcoded to '' so gmailThreadUrl was
  // always null in trackingHandleSummary and FCM push notifications never
  // contained the deep-link. Widened read to 9 columns to include Thread_ID (H)
  // and Draft_ID (I) written by the stamp function.
  var sheet = ss.getSheetByName(TRACKING_LINKS_SHEET);
  if (!sheet) return {};
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === trackingId) {
      return {
        leadRow: data[i][3] || '',
        linkedinUrl: data[i][4] || '',
        threadId: (data[i][7] || '').toString(),  // col H — written by _trackingStampThreadId
        createdAt: data[i][5] || ''
      };
    }
  }
  return {};
}

function _trackingLinkCreatedAt(ss, trackingId, linkId) {
  var sheet = ss.getSheetByName(TRACKING_LINKS_SHEET);
  if (!sheet) return null;
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === trackingId && (data[i][1] === linkId || !linkId)) {
      try { return new Date(data[i][5]).getTime(); } catch (_) { return null; }
    }
  }
  return null;
}

function _trackingBumpClickCount(ss, trackingId, linkId) {
  var sheet = ss.getSheetByName(TRACKING_LINKS_SHEET);
  if (!sheet) return;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  var data = sheet.getRange(2, 1, lastRow - 1, 7).getValues();
  for (var i = 0; i < data.length; i++) {
    if (data[i][0] === trackingId && data[i][1] === linkId) {
      var current = parseInt(data[i][6] || 0, 10) || 0;
      sheet.getRange(i + 2, 7).setValue(current + 1);
      return;
    }
  }
}

function _trackingLastEventTs(sheet, trackingId, eventType) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  // Scan from bottom up, stop on first match
  var startRow = Math.max(2, lastRow - 300);
  var data = sheet.getRange(startRow, 1, lastRow - startRow + 1, 8).getValues();
  for (var i = data.length - 1; i >= 0; i--) {
    if (data[i][2] === trackingId && data[i][1] === eventType) {
      try { return new Date(data[i][0]).getTime(); } catch (_) { return null; }
    }
  }
  return null;
}

function _trackingEnsureLogSheet(ss) {
  var sheet = ss.getSheetByName(TRACKING_LOG_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(TRACKING_LOG_SHEET);
    sheet.appendRow([
      'Timestamp', 'Event', 'Tracking_ID', 'Link_ID',
      'Thread_ID', 'Lead_Row', 'LinkedIn_URL', 'User_Agent'
    ]);
    sheet.getRange(1, 1, 1, 8).setFontWeight('bold');
  }
  return sheet;
}

function _trackingEnsureLinksSheet(ss) {
  var sheet = ss.getSheetByName(TRACKING_LINKS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(TRACKING_LINKS_SHEET);
    sheet.appendRow([
      'Tracking_ID', 'Link_ID', 'Original_URL', 'Lead_Row',
      'LinkedIn_URL', 'Created_At', 'Click_Count'
    ]);
    sheet.getRange(1, 1, 1, 7).setFontWeight('bold');
  }
  return sheet;
}

// ─── FCM name resolver (2026-06-12-funnel-truth F2) ────────────────────────
//
// Resolves the lead's real full name for FCM push notifications. Uses a bounded
// single-row read from CONFIG.DATA_SHEET (Sheet2) via the row number stored in
// TrackingLinks. Caches the result in CacheService for 60s to avoid hammering
// the sheet on burst open events (Gmail's multi-prefetch can fire 2-3 opens
// within seconds). Falls back to LinkedIn slug or 'a lead' if unavailable.
//
// Pure helper: no sheet writes. All errors swallowed — callers are FCM
// best-effort paths that must never block the log write.
//
// @param {Spreadsheet} ss         - already-opened spreadsheet (re-used from caller)
// @param {number|string} leadRow  - row number from TrackingLinks (col D)
// @param {string} linkedinUrl     - fallback identity signal
// @returns {string} display name suitable for FCM notification body

function _trackingResolveFcmName(ss, leadRow, linkedinUrl) {
  var rowNum = parseInt(leadRow, 10);
  // Fast path: cache hit
  if (rowNum > 0) {
    try {
      var _cacheKey = 'TRACKING_LEAD_NAME_R' + rowNum;
      var _cache = CacheService.getScriptCache();
      var _cached = _cache && _cache.get(_cacheKey);
      if (_cached) return _cached;
    } catch (_) {}
  }

  var name = '';
  if (rowNum > 0) {
    try {
      var sheet2 = ss.getSheetByName(CONFIG.DATA_SHEET);
      if (sheet2 && sheet2.getLastRow() >= rowNum) {
        // CONFIG.COLUMNS.FULL_NAME is 1-based col index for "fullName" in Sheet2
        var nameCol = (typeof CONFIG !== 'undefined' && CONFIG.COLUMNS && CONFIG.COLUMNS.FULL_NAME)
                      ? CONFIG.COLUMNS.FULL_NAME : 3;  // col C default
        var cellVal = sheet2.getRange(rowNum, nameCol).getValue();
        if (cellVal) name = String(cellVal).trim();
      }
    } catch (_) {}
  }

  // Cache hit or fall-through
  if (!name && linkedinUrl) {
    // Extract readable slug portion; avoid raw UUID-like handles
    var slug = linkedinUrl.replace(/^https?:\/\/(www\.)?linkedin\.com\/in\//i, '').replace(/\/$/, '');
    // Replace hyphens with spaces and title-case if it looks like a name (2-3 words, no numerics)
    if (/^[a-z]+(-[a-z]+){1,2}$/i.test(slug)) {
      name = slug.replace(/-/g, ' ').replace(/\b\w/g, function(c) { return c.toUpperCase(); });
    }
  }
  if (!name) name = 'a lead';

  // Cache for 60s
  if (rowNum > 0 && name !== 'a lead') {
    try {
      var _cacheW = CacheService.getScriptCache();
      if (_cacheW) _cacheW.put('TRACKING_LEAD_NAME_R' + rowNum, name, 60);
    } catch (_) {}
  }
  return name;
}

// ─── Response builders ─────────────────────────────────────────────

function _trackingPixelResponse() {
  // HtmlOutput with data-URI PNG. Gmail's image proxy fetches the URL (→ logs
  // open), then renders the inner data-URI image as the actual 1x1 pixel.
  // 'ALLOWALL' frame mode means corporate webviews / proxies that wrap the
  // response in their own iframe won't blank the page.
  return HtmlService.createHtmlOutput(
    '<!DOCTYPE html><html><body style="margin:0;padding:0;background:transparent;">' +
    '<img src="data:image/png;base64,' + TRACKING_PIXEL_B64 + '" ' +
    'width="1" height="1" alt="" style="display:block;border:0;outline:none;" />' +
    '</body></html>'
  ).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function _trackingRedirectResponse(destUrl) {
  // Apps Script doGet can't return HTTP 302. We use BOTH meta-refresh AND
  // JS window.top.location for max compatibility (Gmail mobile uses Chrome
  // Custom Tabs / SFSafariViewController which run JS; corporate proxies
  // strip JS but honor meta-refresh).
  var safeUrl = (destUrl || '').toString()
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return HtmlService.createHtmlOutput(
    '<!DOCTYPE html><html><head>' +
    '<meta http-equiv="refresh" content="0;url=' + safeUrl + '">' +
    '<title>Redirecting…</title>' +
    '</head><body>' +
    '<script>try{window.top.location.href="' + safeUrl + '";}catch(e){window.location.href="' + safeUrl + '";}</script>' +
    '<p>If you are not redirected automatically, <a href="' + safeUrl + '">click here</a>.</p>' +
    '</body></html>'
  ).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function _trackingJson(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function _trackingWebAppBase() {
  // The Apps Script Web App URL — used to construct outgoing pixel + click URLs.
  // Must be set via Script Properties: TRACKING_WEBAPP_BASE = <your /exec URL>
  var base = PropertiesService.getScriptProperties().getProperty('TRACKING_WEBAPP_BASE');
  if (!base || base.length < 20) {
    throw new Error('TRACKING_WEBAPP_BASE not set in Script Properties. '
      + 'Set it to your /exec deployment URL via Project Settings → Script Properties.');
  }
  return base.replace(/\/$/, '');
}

/**
 * Called by GmailDrafter after draft creation so the summary endpoint can
 * return a Gmail deep-link. Adds thread_id + draft_id to the TrackingLinks
 * sheet schema by widening the row (columns H/I if not present). Best-effort.
 *
 * [2026-06-12-fcm-name-fix] Added leadRow + linkedinUrl params. When the email
 * had no tracked links, rewriteLinksForTracking wrote zero rows to TrackingLinks
 * and the meta-only row inserted here had empty col D (leadRow). The FCM name
 * resolver (_trackingResolveFcmName) then got leadRow='' → rowNum=0 → fell back
 * to slug/`a lead`. Now we carry the identity from GmailDrafter into this row
 * so every tracking_id can resolve a name. Callers that don't pass the new args
 * are backward-compatible (undefined → '' → same meta-row as before).
 * [activates at next deploy post-version-prune]
 */
function _trackingStampThreadId(trackingId, threadId, draftId, leadRow, linkedinUrl) {
  if (!trackingId || !threadId) return;
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(TRACKING_LINKS_SHEET);
  if (!sheet) return;
  var lastRow = sheet.getLastRow();
  var safeLeadRow = leadRow || 0;
  var safeLinkedinUrl = linkedinUrl || '';
  if (lastRow < 2) {
    // No link rows yet — create a meta-only row so summary endpoint can find thread
    sheet.appendRow([trackingId, '', '', safeLeadRow, safeLinkedinUrl,
                     new Date().toISOString(), 0, threadId, draftId || '']);
    return;
  }
  // Ensure columns H + I exist; widen header if needed
  if (sheet.getLastColumn() < 9) {
    sheet.getRange(1, 8, 1, 2).setValues([['Thread_ID', 'Draft_ID']]);
  }
  var data = sheet.getRange(2, 1, lastRow - 1, 9).getValues();
  var updates = 0;
  for (var i = 0; i < data.length; i++) {
    if (data[i][0] === trackingId) {
      sheet.getRange(i + 2, 8).setValue(threadId);
      if (draftId) sheet.getRange(i + 2, 9).setValue(draftId);
      // [2026-06-12-fcm-name-fix] backfill leadRow/linkedinUrl if the link row
      // had them empty (e.g. CTA-exempt email where only meta row exists)
      if (safeLeadRow && !data[i][3]) sheet.getRange(i + 2, 4).setValue(safeLeadRow);
      if (safeLinkedinUrl && !data[i][4]) sheet.getRange(i + 2, 5).setValue(safeLinkedinUrl);
      updates++;
    }
  }
  if (updates === 0) {
    // Tracking_id has no link rows (email had no links). Insert a meta row.
    sheet.appendRow([trackingId, '', '', safeLeadRow, safeLinkedinUrl,
                     new Date().toISOString(), 0, threadId, draftId || '']);
  }
}

// ─── Backfill: populate missing leadRow in TrackingLinks ───────────────────
//
// [2026-06-12-fcm-name-fix] Before this patch, TrackingLinks rows created for
// emails whose links were CTA-exempt (calendly/github direct hrefs) or had no
// <a href> at all were written with leadRow=0 / linkedinUrl=''. The FCM open
// notification resolver (_trackingResolveFcmName) therefore always fell back
// to 'a lead' for those tokens. This watchdog helper joins TrackingLinks rows
// that have empty col D/E against the data sheet (Sheet2) via LinkedIn URL
// match or by inspecting the TrackingLog sheet for the token's linkedin_url.
//
// Designed for use by PipelineWatchdog Job 9:
//   - Bounded: processes at most maxRows rows per tick (default 200)
//   - Self-terminating: stops when no more empty rows remain
//   - Idempotent: rows already populated are skipped
//   - No deploys needed: backfill runs under HEAD (push-effective)
//
// @param {number} maxRows - maximum TrackingLinks rows to inspect per call
// @returns {Object} { scanned, backfilled, skipped, errors }

function _trackingBackfillLeadRow(maxRows) {
  var MAX = maxRows || 200;
  var result = { scanned: 0, backfilled: 0, skipped: 0, errors: [] };
  try {
    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var linksSheet = ss.getSheetByName(TRACKING_LINKS_SHEET);
    if (!linksSheet || linksSheet.getLastRow() < 2) return result;

    var linksLastRow = linksSheet.getLastRow();
    // Read up to MAX rows from the end (most recent tokens most likely to generate opens)
    var startRow = Math.max(2, linksLastRow - MAX + 1);
    var rangeWidth = Math.min(linksSheet.getLastColumn(), 9);
    var data = linksSheet.getRange(startRow, 1, linksLastRow - startRow + 1, rangeWidth).getValues();

    // Build LinkedIn URL → row-number index from Sheet2 for fast join
    var sheet2 = ss.getSheetByName(CONFIG.DATA_SHEET);
    var urlToRow = {};
    if (sheet2 && sheet2.getLastRow() >= 2) {
      var urlCol = CONFIG.COLUMNS.LINKEDIN_URL;
      var sheet2Data = sheet2.getRange(2, urlCol, sheet2.getLastRow() - 1, 1).getValues();
      for (var r = 0; r < sheet2Data.length; r++) {
        var url = (sheet2Data[r][0] || '').toString().trim().toLowerCase().replace(/\/$/, '');
        if (url) urlToRow[url] = r + 2;  // 1-based row in Sheet2
      }
    }

    // Also read TrackingLog to recover linkedin_url for tokens that wrote zero link rows
    // (the log always has linkedin_url in col G, written by _trackingRecordOpen)
    var tokenToLinkedinUrl = {};
    var logSheet = ss.getSheetByName(TRACKING_LOG_SHEET);
    if (logSheet && logSheet.getLastRow() >= 2) {
      var logData = logSheet.getRange(2, 1, logSheet.getLastRow() - 1, 7).getValues();
      for (var l = 0; l < logData.length; l++) {
        var tok = (logData[l][2] || '').toString();
        var lurl = (logData[l][6] || '').toString().trim().toLowerCase().replace(/\/$/, '');
        if (tok && lurl && !tokenToLinkedinUrl[tok]) tokenToLinkedinUrl[tok] = lurl;
      }
    }

    for (var i = 0; i < data.length; i++) {
      result.scanned++;
      var rowIndex = startRow + i;  // 1-based sheet row
      var token = (data[i][0] || '').toString();
      var existingLeadRow = data[i][3];           // col D (0-indexed: index 3)
      var existingLinkedinUrl = (data[i][4] || '').toString().trim();  // col E

      // Skip rows that already have leadRow
      if (existingLeadRow && parseInt(existingLeadRow, 10) > 0) {
        result.skipped++;
        continue;
      }

      // Try to resolve linkedinUrl: existing col E, then TrackingLog fallback
      var resolvedUrl = existingLinkedinUrl.toLowerCase().replace(/\/$/, '');
      if (!resolvedUrl && token) resolvedUrl = tokenToLinkedinUrl[token] || '';
      if (!resolvedUrl) { result.skipped++; continue; }

      // Join against Sheet2 URL index
      var resolvedRowNum = urlToRow[resolvedUrl] || 0;
      if (!resolvedRowNum) { result.skipped++; continue; }

      // Write col D (leadRow) and col E (linkedinUrl) if missing
      try {
        linksSheet.getRange(rowIndex, 4).setValue(resolvedRowNum);
        if (!existingLinkedinUrl) linksSheet.getRange(rowIndex, 5).setValue(resolvedUrl);
        result.backfilled++;
        Logger.log('[TrackingBackfill] Row ' + rowIndex + ' token=' + token.substring(0, 8) +
                   ' backfilled leadRow=' + resolvedRowNum + ' url=' + resolvedUrl);
      } catch (writeErr) {
        result.errors.push('row' + rowIndex + ':' + writeErr.message);
      }
    }
  } catch (outerErr) {
    result.errors.push('outer:' + outerErr.message);
    Logger.log('[TrackingBackfill] failed: ' + outerErr.message);
  }
  Logger.log('[TrackingBackfill] scanned=' + result.scanned + ' backfilled=' + result.backfilled +
             ' skipped=' + result.skipped + ' errors=' + result.errors.length);
  return result;
}

// ─── Diagnostic: clear all tracking data (manual) ──────────────────

function clearAllTrackingData() {
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var log = ss.getSheetByName(TRACKING_LOG_SHEET);
  var links = ss.getSheetByName(TRACKING_LINKS_SHEET);
  if (log && log.getLastRow() > 1) log.deleteRows(2, log.getLastRow() - 1);
  if (links && links.getLastRow() > 1) links.deleteRows(2, links.getLastRow() - 1);
  Logger.log('[Tracking] All tracking data cleared');
}
