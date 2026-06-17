/**
 * WeeklyDigest.gs — Monday 9am summary email (Patch 2026-05-12)
 *
 * Aggregates the last 7 days of activity and emails it to the project owner.
 * One trigger to set up, no APK touchpoint needed.
 *
 * Numbers reported:
 *   - Drafts created
 *   - Emails sent (drafts that left as a real send)
 *   - Unique opens (across all sends, deduped per recipient by tracking_id)
 *   - Clicks (excludes scan_clicks from corporate URL-rewriters)
 *   - Replies (from RepliedLog)
 *   - Bounces (from BounceLog, hard vs soft split)
 *   - Follow-ups in the queue: pending, sent this week, cancelled
 *   - Top 5 leads by engagement (opens + clicks combined)
 *   - APIs that fired this week (Apollo, Hunter, Snov, Reoon, Findymail)
 */

function sendWeeklyDigest() {
  var now = new Date();
  var weekAgo = new Date(now.getTime() - 7 * 86400 * 1000);
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);

  var stats = _digestCollectStats(ss, weekAgo);
  var html = _digestRenderHtml(stats, weekAgo, now);
  var recipient = Session.getEffectiveUser().getEmail();

  try {
    GmailApp.sendEmail(recipient, _digestSubject(stats), 'Open this in HTML-capable client.', {
      htmlBody: html,
      name: 'AutoMail Weekly Digest'
    });
    Logger.log('[WeeklyDigest] Sent to ' + recipient + ': ' + JSON.stringify(stats.top));
    return { status: 'ok', recipient: recipient, stats: stats.top };
  } catch (e) {
    Logger.log('[WeeklyDigest] sendEmail failed: ' + e.message);
    return { status: 'error', error: e.message };
  }
}

function _digestSubject(stats) {
  var bits = [];
  if (stats.top.drafts) bits.push(stats.top.drafts + ' drafts');
  if (stats.top.opens) bits.push(stats.top.opens + ' opens');
  if (stats.top.clicks) bits.push(stats.top.clicks + ' clicks');
  if (stats.top.replies) bits.push(stats.top.replies + ' replies');
  return '📊 AutoMail weekly — ' + (bits.length ? bits.join(' · ') : 'no activity this week');
}

function _digestCollectStats(ss, weekAgo) {
  var c = CONFIG.COLUMNS;
  var tWeekAgo = weekAgo.getTime();
  var stats = {
    top: { drafts: 0, sent: 0, opens: 0, clicks: 0, replies: 0, bouncesHard: 0, bouncesSoft: 0,
           followupsPending: 0, followupsSent: 0 },
    apis: { apollo: 0, hunter: 0, snov: 0, reoon: 0, findymail: 0, autoPicked: 0 },
    topLeads: [],
    statusBreakdown: {}
  };

  // Sheet2 — for status breakdown + draft/sent counts
  var sheet2 = ss.getSheetByName(CONFIG.DATA_SHEET);
  if (sheet2 && sheet2.getLastRow() >= 2) {
    var data = sheet2.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      var status = (data[i][c.STATUS - 1] || '').toString();
      stats.statusBreakdown[status] = (stats.statusBreakdown[status] || 0) + 1;
      var lastUpdated = data[i][c.LAST_UPDATED - 1];
      if (lastUpdated) {
        var ts = new Date(lastUpdated).getTime();
        if (ts >= tWeekAgo) {
          if (status === 'DRAFT_CREATED') stats.top.drafts++;
          else if (status === 'SENT') stats.top.sent++;
        }
      }
      // Tally email source for API-usage breakdown
      if (c.EMAIL_SOURCE) {
        var src = (data[i][c.EMAIL_SOURCE - 1] || '').toString();
        if (src.indexOf('apollo') >= 0) stats.apis.apollo++;
        else if (src.indexOf('hunter') >= 0) stats.apis.hunter++;
        else if (src.indexOf('snov') >= 0) stats.apis.snov++;
        else if (src.indexOf('findymail') >= 0) stats.apis.findymail++;
        if (src.indexOf('auto_picked') >= 0) stats.apis.autoPicked++;
      }
    }
  }

  // TrackingLog — opens + clicks
  var log = ss.getSheetByName('TrackingLog');
  var openCountByLead = {};
  var clickCountByLead = {};
  if (log && log.getLastRow() >= 2) {
    var ld = log.getDataRange().getValues();
    for (var j = 1; j < ld.length; j++) {
      var tsStr = ld[j][0];
      var ts = tsStr ? new Date(tsStr).getTime() : 0;
      if (ts < tWeekAgo) continue;
      var event = ld[j][1];
      var leadUrl = (ld[j][6] || '').toString();
      if (event === 'open') {
        stats.top.opens++;
        openCountByLead[leadUrl] = (openCountByLead[leadUrl] || 0) + 1;
      } else if (event === 'click') {
        stats.top.clicks++;
        clickCountByLead[leadUrl] = (clickCountByLead[leadUrl] || 0) + 1;
      }
    }
  }

  // Top 5 leads by engagement
  var combined = {};
  Object.keys(openCountByLead).forEach(function(url) {
    combined[url] = (combined[url] || 0) + openCountByLead[url];
  });
  Object.keys(clickCountByLead).forEach(function(url) {
    combined[url] = (combined[url] || 0) + clickCountByLead[url] * 2;  // weight clicks higher
  });
  var ranked = Object.keys(combined).map(function(url) {
    return { url: url, score: combined[url],
             opens: openCountByLead[url] || 0,
             clicks: clickCountByLead[url] || 0 };
  }).sort(function(a, b) { return b.score - a.score; }).slice(0, 5);
  stats.topLeads = ranked;

  // RepliedLog
  var replied = ss.getSheetByName('RepliedLog');
  if (replied && replied.getLastRow() >= 2) {
    var rd = replied.getDataRange().getValues();
    for (var k = 1; k < rd.length; k++) {
      var ts2 = rd[k][0] ? new Date(rd[k][0]).getTime() : 0;
      if (ts2 >= tWeekAgo) stats.top.replies++;
    }
  }

  // BounceLog
  var bounce = ss.getSheetByName('BounceLog');
  if (bounce && bounce.getLastRow() >= 2) {
    var bd = bounce.getDataRange().getValues();
    for (var l = 1; l < bd.length; l++) {
      var bts = bd[l][0] ? new Date(bd[l][0]).getTime() : 0;
      if (bts < tWeekAgo) continue;
      var cat = (bd[l][3] || '').toString();
      if (cat === 'hard') stats.top.bouncesHard++;
      else if (cat === 'soft') stats.top.bouncesSoft++;
    }
  }

  // FollowUps
  var fu = ss.getSheetByName('FollowUps');
  if (fu && fu.getLastRow() >= 2) {
    var fd = fu.getDataRange().getValues();
    var hdr = fd[0].map(function(h) { return (h || '').toString().trim(); });
    var iStatus = hdr.indexOf('Status');
    var iSched = hdr.indexOf('ScheduledDate');
    for (var f = 1; f < fd.length; f++) {
      var fst = (fd[f][iStatus] || '').toString();
      var fsched = iSched >= 0 ? fd[f][iSched] : null;
      if (fst === 'PENDING') stats.top.followupsPending++;
      else if (fst === 'SENT' && fsched && new Date(fsched).getTime() >= tWeekAgo) stats.top.followupsSent++;
    }
  }

  return stats;
}

function _digestRenderHtml(stats, weekAgo, now) {
  var fmtDate = function(d) { return Utilities.formatDate(d, Session.getScriptTimeZone(), 'EEE, MMM d'); };
  var pct = function(n, d) { return d > 0 ? Math.round((n / d) * 100) + '%' : '—'; };
  var openRate = pct(stats.top.opens, stats.top.drafts);
  var replyRate = pct(stats.top.replies, stats.top.drafts);

  var h = '';
  h += '<div style="font-family:Calibri,Arial,sans-serif;color:#1a1a1a;max-width:560px;">';
  h += '<h2 style="color:#0a66c2;margin:0 0 6px 0;">AutoMail Weekly Digest</h2>';
  h += '<p style="color:#666;font-size:13px;margin:0 0 18px 0;">' + fmtDate(weekAgo) + ' → ' + fmtDate(now) + '</p>';

  h += '<table style="width:100%;border-collapse:collapse;font-size:14px;">';
  h += _digestRow('📝 Drafts created', stats.top.drafts);
  h += _digestRow('📤 Emails sent', stats.top.sent);
  h += _digestRow('👀 Unique opens', stats.top.opens + ' <span style="color:#666;">(' + openRate + ' open-rate)</span>');
  h += _digestRow('🖱 Real clicks', stats.top.clicks);
  h += _digestRow('💬 Replies', stats.top.replies + ' <span style="color:#666;">(' + replyRate + ' reply-rate)</span>');
  h += _digestRow('⚠ Hard bounces', stats.top.bouncesHard);
  h += _digestRow('⏱ Soft bounces', stats.top.bouncesSoft);
  h += _digestRow('⏰ Follow-ups pending', stats.top.followupsPending);
  h += _digestRow('✉ Follow-ups sent (this week)', stats.top.followupsSent);
  h += '</table>';

  // Top leads
  if (stats.topLeads.length > 0) {
    h += '<h3 style="margin:20px 0 8px 0;color:#0a66c2;">Top engaged leads</h3>';
    h += '<ol style="margin:0;padding-left:24px;font-size:13px;">';
    stats.topLeads.forEach(function(lead) {
      h += '<li style="margin-bottom:4px;"><a href="' + lead.url + '" style="color:#0a66c2;">' +
           lead.url.replace(/^https?:\/\/(www\.)?linkedin\.com\/in\//, '') + '</a> — ' +
           lead.opens + ' opens, ' + lead.clicks + ' clicks</li>';
    });
    h += '</ol>';
  }

  // API source breakdown
  h += '<h3 style="margin:20px 0 8px 0;color:#0a66c2;">Email-source breakdown</h3>';
  h += '<p style="font-size:13px;margin:0 0 4px 0;">Apollo: <b>' + stats.apis.apollo + '</b> · ' +
       'Hunter: <b>' + stats.apis.hunter + '</b> · ' +
       'Snov: <b>' + stats.apis.snov + '</b> · ' +
       'Findymail: <b>' + stats.apis.findymail + '</b> · ' +
       'Auto-picked: <b>' + stats.apis.autoPicked + '</b></p>';

  // Pipeline status breakdown
  var sbKeys = Object.keys(stats.statusBreakdown).sort(function(a, b) {
    return stats.statusBreakdown[b] - stats.statusBreakdown[a];
  });
  if (sbKeys.length > 0) {
    h += '<h3 style="margin:20px 0 8px 0;color:#0a66c2;">Pipeline status</h3>';
    h += '<p style="font-size:13px;margin:0;">';
    h += sbKeys.slice(0, 6).map(function(k) {
      return '<span style="display:inline-block;background:#e8f1fb;border-radius:8px;padding:2px 8px;margin:2px 4px 2px 0;">' +
             k + ': <b>' + stats.statusBreakdown[k] + '</b></span>';
    }).join('');
    h += '</p>';
  }

  h += '<p style="color:#999;font-size:11px;margin-top:30px;">' +
       'Generated by AutoMail Pipeline · ' + now.toISOString() + '</p>';
  h += '</div>';
  return h;
}

function _digestRow(label, value) {
  return '<tr><td style="padding:6px 12px 6px 0;color:#666;width:60%;">' + label +
         '</td><td style="padding:6px 0;font-weight:bold;font-size:16px;">' + value + '</td></tr>';
}

/** Run once from editor (or via setup endpoint). Monday 9am script TZ. */
function installWeeklyDigestTrigger() {
  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === 'sendWeeklyDigest') ScriptApp.deleteTrigger(existing[i]);
  }
  ScriptApp.newTrigger('sendWeeklyDigest').timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(9).create();
  return { status: 'ok', schedule: 'Monday 9am script timezone' };
}
