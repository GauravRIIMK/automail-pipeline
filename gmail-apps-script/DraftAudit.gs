/**
 * DraftAudit.gs — Audit tool for the 10 newest Gmail drafts.
 * PATCH 2026-06-11-eq8-contentguards (T5).
 * PATCH 2026-06-11-eq8-deliv-v2 (T1): added htmlBytes + over3200 to bodyFlow.
 *   SpamAssassin HTML_IMAGE_ONLY fires only when raw HTML ≤ 3,200 bytes;
 *   our table-based body almost certainly exceeds that, which disproves the
 *   rule fires on our mails. Per-draft measurement confirms/disproves per flow.
 * PATCH 2026-06-11-eq8-deliv-v2-amend (T2): added isFollowUp + tinyBody fields.
 *   isFollowUp: true when (a) subject starts /^re:/i, OR (b) thread has >1 message.
 *   tinyBody: true (separate heuristic flag) when htmlBytes < 500 AND greetings == 0.
 *   These fields support the 108-byte draft investigation and ongoing follow-up auditing.
 *
 * menuAuditLast10Drafts(): Scan up to 60 drafts by message date, find the 10
 * newest. For each draft, join to Sheet2 by recipient email and return a
 * structured audit record:
 *
 *   { time, to, subject50, row, sheetName, sheetOrg, sheetDesignation,
 *     archetype, template, tierFromNotes, emailSource, bodyFlow }
 *
 * bodyFlow fields:
 *   greetings  — count of <p>Hi/Hello/Hey NAME,</p> blocks
 *   hasHook    — true if first content <p> after greeting is not a bullet table
 *   bullets    — count of width:28px bullet glyph cells
 *   github     — count of github.com/GauravRIIMK occurrences
 *   calendly   — count of calendly.com/speak-to-gaurav/30min occurrences
 *   box        — true if INTERNAL NOTE box is present
 *   researchOrgGuess — first proper-noun-ish token from hook excerpt (up to 120 chars)
 *   isFollowUp — true if subject matches /^re:/i OR thread.messageCount > 1
 *   tinyBody   — true if htmlBytes < 500 AND greetings == 0 (anomaly heuristic, separate from isFollowUp)
 *
 * Pure read — no sheet writes, no GmailApp mutations.
 * Whitelisted in WebApp.gs admin_run as 'menuAuditLast10Drafts'.
 */
function menuAuditLast10Drafts() {
  // ── Step 1: Collect up to 60 drafts, pick 10 newest by date ──────────────
  var allDrafts;
  try {
    allDrafts = GmailApp.getDrafts();
  } catch (e) {
    return { error: 'GmailApp.getDrafts() failed: ' + e.message };
  }

  var candidates = [];
  for (var di = 0; di < allDrafts.length && candidates.length < 60; di++) {
    var msg;
    try { msg = allDrafts[di].getMessage(); } catch (_) { continue; }
    var msgDate;
    try { msgDate = msg.getDate(); } catch (_) { continue; }
    candidates.push({ msg: msg, date: msgDate });
  }

  // Sort newest first
  candidates.sort(function(a, b) { return b.date - a.date; });
  var top10 = candidates.slice(0, 10);

  // ── Step 2: Build email→row index from Sheet2 (and fallback Sheet1) ──────
  var emailToRow = {};  // email (lower) → { row, sheetName, sheetOrg, sheetDesignation, archetype, template, tierFromNotes, emailSource }
  var c = CONFIG.COLUMNS;
  var ss;
  try { ss = SpreadsheetApp.openById(CONFIG.SHEET_ID); } catch (e) {
    return { error: 'Cannot open spreadsheet: ' + e.message };
  }

  // Scan Sheet2 first (primary pipeline sheet)
  var sheetNamesToScan = ['Sheet2', 'Sheet1'];
  sheetNamesToScan.forEach(function(sName) {
    var sheet;
    try { sheet = ss.getSheetByName(sName); } catch (_) { return; }
    if (!sheet) return;
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return;
    var numCols = Math.max(26, sheet.getLastColumn());
    var data;
    try { data = sheet.getRange(2, 1, lastRow - 1, numCols).getValues(); } catch (_) { return; }
    data.forEach(function(row, rIdx) {
      var rowNum = rIdx + 2;
      // Primary: ENRICHED_EMAIL (col 24)
      var enrichedEmail = (c.ENRICHED_EMAIL && row[c.ENRICHED_EMAIL - 1]) ? row[c.ENRICHED_EMAIL - 1].toString().trim().toLowerCase() : '';
      // Fallback: EMAIL (col 6)
      var sheetEmail = row[c.EMAIL - 1] ? row[c.EMAIL - 1].toString().trim().toLowerCase() : '';
      var emailKey = enrichedEmail || sheetEmail;
      if (!emailKey) return;
      if (emailToRow[emailKey]) return;  // Sheet2 wins over Sheet1 for same email

      // Parse FINALIZER tier from NOTES (col 18): 'FINALIZER tier=(\w+)'
      var notes = (c.NOTES && row[c.NOTES - 1]) ? row[c.NOTES - 1].toString() : '';
      var tierMatch = notes.match(/FINALIZER\s+tier=(\w+)/i);
      var tierFromNotes = tierMatch ? tierMatch[1] : '';

      emailToRow[emailKey] = {
        row: rowNum,
        sheetName: sName,
        sheetOrg: (c.ORGANIZATION && row[c.ORGANIZATION - 1]) ? row[c.ORGANIZATION - 1].toString().trim() : '',
        sheetDesignation: (c.DESIGNATION && row[c.DESIGNATION - 1]) ? row[c.DESIGNATION - 1].toString().trim() : '',
        archetype: (c.ARCHETYPE && row[c.ARCHETYPE - 1]) ? row[c.ARCHETYPE - 1].toString().trim() : '',
        template: (c.TEMPLATE && row[c.TEMPLATE - 1]) ? row[c.TEMPLATE - 1].toString().trim() : '',
        tierFromNotes: tierFromNotes,
        emailSource: (c.EMAIL_SOURCE && row[c.EMAIL_SOURCE - 1]) ? row[c.EMAIL_SOURCE - 1].toString().trim() : ''
      };
    });
  });

  // ── Step 3: Analyse each draft ────────────────────────────────────────────
  var results = top10.map(function(item) {
    var msg = item.msg;
    var subject = '';
    var to = '';
    var body = '';
    try { subject = msg.getSubject() || ''; } catch (_) {}
    try { to = msg.getTo() || ''; } catch (_) {}
    try { body = msg.getBody() || ''; } catch (_) {}

    // ── isFollowUp detection (PATCH 2026-06-11-eq8-deliv-v2-amend T2) ────────
    // (a) subject starts /^re:/i  → reply by subject convention
    // (b) thread has >1 message   → genuinely threaded reply
    var isFollowUp = false;
    try {
      if (/^re:/i.test(subject.trim())) {
        isFollowUp = true;
      } else {
        var threadMsgCount = msg.getThread().getMessageCount();
        if (threadMsgCount > 1) isFollowUp = true;
      }
    } catch (_fuErr) { /* non-critical — leave isFollowUp false on error */ }

    // Normalise recipient email for lookup
    var toEmail = to.toLowerCase().replace(/^[^<]*<([^>]+)>.*$/, '$1').trim();
    if (!toEmail) toEmail = to.toLowerCase().trim();

    // Sheet join
    var sheetData = emailToRow[toEmail] || null;

    // ── body flow analysis ────────────────────────────────────────────────
    // greetings: count <p>Hi|Hello|Hey name,</p>
    var greetRe = /<p[^>]*>\s*(Hi|Hello|Hey)\s+[^<,]{1,30},?\s*<\/p>/gi;
    var greetMatches = body.match(greetRe) || [];

    // bullets: count of width:28px glyph cells (experience bullet marker)
    var bulletMatches = body.match(/width:28px/g) || [];

    // github occurrences
    var githubCount = body.split('github.com/GauravRIIMK').length - 1;

    // calendly occurrences
    var calendlyCount = body.split('calendly.com/speak-to-gaurav/30min').length - 1;

    // box: INTERNAL NOTE present
    var hasBox = body.indexOf('INTERNAL NOTE') >= 0;

    // hasHook: after the first greeting <p>, next content element is NOT a bullet table
    // Heuristic: find position of first greeting; check next 200 chars for <table>
    var hasHook = false;
    var firstGreetIdx = body.search(/<p[^>]*>\s*(Hi|Hello|Hey)\s+[^<,]{1,30},?\s*<\/p>/i);
    if (firstGreetIdx >= 0) {
      var afterGreet = body.substring(firstGreetIdx).replace(/<p[^>]*>\s*(Hi|Hello|Hey)\s+[^<,]{1,30},?\s*<\/p>/i, '');
      var nextElement = afterGreet.substring(0, 300).trim();
      hasHook = !/^\s*<table/i.test(nextElement);
    } else {
      // No greeting found — check if there's any non-table paragraph near start
      hasHook = !/^\s*<div[^>]*>\s*<table/i.test(body.trim());
    }

    // researchOrgGuess: first proper-noun-ish token in hook excerpt (first 120 chars of plain text)
    var plainHookExcerpt = body.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').substring(0, 200);
    var orgGuess = '';
    // Look for sequences of 2+ capitalized words (Title Case) beyond "Hi Name,"
    var orgGuessMatch = plainHookExcerpt.match(/(?:Hi\s+\S+,\s*)?([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,}){1,3})/);
    if (orgGuessMatch) orgGuess = orgGuessMatch[1];

    // tinyBody: anomaly heuristic — separate from isFollowUp.
    // True when htmlBytes < 500 AND no greeting found (indicates a stub/near-empty body
    // inconsistent with a cold draft or a real follow-up with content).
    var tinyBody = (body.length < 500 && greetMatches.length === 0);

    return {
      time: Utilities.formatDate(item.date, 'Asia/Kolkata', 'yyyy-MM-dd HH:mm'),
      to: to.substring(0, 60),
      subject50: subject.substring(0, 50),
      row: sheetData ? sheetData.row : null,
      sheetName: sheetData ? sheetData.sheetName : null,
      sheetOrg: sheetData ? sheetData.sheetOrg : null,
      sheetDesignation: sheetData ? sheetData.sheetDesignation : null,
      archetype: sheetData ? sheetData.archetype : null,
      template: sheetData ? sheetData.template : null,
      tierFromNotes: sheetData ? sheetData.tierFromNotes : null,
      emailSource: sheetData ? sheetData.emailSource : null,
      isFollowUp: isFollowUp,
      bodyFlow: {
        greetings: greetMatches.length,
        hasHook: hasHook,
        bullets: bulletMatches.length,
        github: githubCount,
        calendly: calendlyCount,
        box: hasBox,
        researchOrgGuess: orgGuess,
        hookExcerpt120: plainHookExcerpt.substring(0, 120),
        // PATCH 2026-06-11-eq8-deliv-v2 (T1): raw HTML byte measurement.
        // SpamAssassin HTML_IMAGE_ONLY only fires at ≤3,200 bytes — this
        // proves/disproves per flow without changing any sending behavior.
        htmlBytes: body.length,
        over3200: body.length > 3200,
        // PATCH 2026-06-11-eq8-deliv-v2-amend (T2): follow-up + anomaly flags.
        isFollowUp: isFollowUp,
        tinyBody: tinyBody
      }
    };
  });

  Logger.log('[DraftAudit] menuAuditLast10Drafts: scanned ' + candidates.length +
             ' drafts, audited ' + results.length);
  return {
    scanned: candidates.length,
    audited: results.length,
    drafts: results
  };
}
