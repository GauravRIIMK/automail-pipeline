/**
 * EmailAccuracyShadow.gs — 2026-06-19-email-accuracy (Track B, SHADOW phase)
 *
 * Read-only computation of the CURRENT-EMPLOYER-DOMAIN-ANCHORED email selection.
 * Nothing here mutates a lead, writes the sheet, or changes live behaviour — it
 * only computes what the new logic WOULD pick and reports the diff vs the current
 * enrichedEmail, so the change can be validated before being wired into the live
 * finalizer (behind a flag).
 *
 * CORE PRINCIPLE (from the design): an email is only as good as its domain's match
 * to the person's CURRENT employer. A constructed/vendor address on an ex-employer
 * domain (e.g. bistro.sk for someone now at Flipkart) must lose to the captured
 * current-employer address — or be held — never silently win.
 *
 * Reuses existing helpers: _normCompanyName, _extractHeadlineCurrentCompany,
 * _companiesConflict (BatchProcessor.gs), FREE_EMAIL_DOMAINS + verifyMxRecord
 * (EmailEnricher.gs).
 */

// Pure: domain part of an email (lowercased), or '' .
function _emailDomainOf_(email) {
  var e = (email || '').toString().toLowerCase().trim();
  var at = e.indexOf('@');
  return (at > 0 && at < e.length - 1) ? e.substring(at + 1) : '';
}

// Pure: does an email/host domain plausibly belong to `company`? Compares the domain's
// leading label (e.g. "flipkart" of flipkart.com) against the normalized company name and
// its significant tokens. Strict by design: bistro.sk vs "Flipkart" → false (the fix).
function _domainMatchesCompany_(domainOrEmail, company) {
  if (!domainOrEmail || !company) return false;
  var dom = String(domainOrEmail).toLowerCase().trim();
  if (dom.indexOf('@') >= 0) dom = dom.split('@').pop();
  dom = dom.replace(/^www\./, '');
  var label = (dom.split('.')[0] || '');                 // "flipkart" from "flipkart.com"
  if (label.length < 3) return false;
  var comp = (typeof _normCompanyName === 'function') ? _normCompanyName(company) : String(company).toLowerCase();
  var compJoined = comp.replace(/\s+/g, '');             // "flipkart"
  if (!compJoined) return false;
  if (compJoined.indexOf(label) >= 0 || label.indexOf(compJoined) >= 0) return true;
  // multi-word companies: any significant (>=4 char) token overlapping the label
  return comp.split(' ').some(function(t) {
    return t.length >= 4 && (label.indexOf(t) >= 0 || t.indexOf(label) >= 0);
  });
}

// Free DoH org→domain probe: try the normalized company name as .com/.in/.io and return the
// first that resolves with MX records (cached via verifyMxRecord). India-aware (.in). This is
// the signal that lets the anchor be derived INDEPENDENTLY of the email we're judging. '' if none.
function _probeOrgDomain_(company) {
  var comp = (typeof _normCompanyName === 'function') ? _normCompanyName(company) : String(company || '').toLowerCase();
  var joined = comp.replace(/\s+/g, '');
  if (joined.length < 3 || joined.length > 30) return '';
  var tlds = ['com', 'in', 'io'];
  for (var i = 0; i < tlds.length; i++) {
    var d = joined + '.' + tlds[i];
    try { if (typeof verifyMxRecord === 'function' && verifyMxRecord(d).hasMx) return d; } catch (_) {}
  }
  return '';
}

// Resolve the CURRENT employer's email domain (shadow). Returns { domain, source, company }.
// The anchor is derived INDEPENDENTLY of the enrichedEmail we're judging (no circularity):
//   (1) APK-captured email's domain IF non-free AND it matches the current company;
//   (2) the captured website field IF present AND it matches;
//   (3) (allowProbe only) a free DoH probe of <company>.com/.in/.io with MX records.
// Current company = the ORG field. The org is the APK's structured current-position company,
// and the upstream _reconcileCurrentEmployer already corrects a stale org (Samarth case) BEFORE
// selection. We deliberately do NOT re-parse the headline here: _extractHeadlineCurrentCompany's
// "@Company" branch mis-reads "Ex Product @Bistro" as current, which is exactly the ex-employer
// trap we're closing.
function _resolveCurrentEmployerDomain_(lead, allowProbe) {
  var out = { domain: '', source: '', company: '' };
  if (!lead) return out;
  var company = (lead.organization || '').toString();
  out.company = company;
  if (!company) return out;

  var apkDom = _emailDomainOf_(lead.email);
  var apkFree = apkDom && (typeof FREE_EMAIL_DOMAINS !== 'undefined') && !!FREE_EMAIL_DOMAINS[apkDom];
  if (apkDom && !apkFree && _domainMatchesCompany_(apkDom, company)) {
    out.domain = apkDom; out.source = 'apk_email_on_current_company';
    return out;
  }

  var web = (lead.website || '').toString().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].split('?')[0];
  var webFree = web && (typeof FREE_EMAIL_DOMAINS !== 'undefined') && !!FREE_EMAIL_DOMAINS[web];
  if (web && web.indexOf('.') > 0 && !webFree && _domainMatchesCompany_(web, company)) {
    out.domain = web; out.source = 'website_field';
    return out;
  }

  if (allowProbe) {
    var probed = _probeOrgDomain_(company);
    if (probed) { out.domain = probed; out.source = 'doh_org_probe'; return out; }
  }
  return out;  // unresolved → WOULD_HOLD
}

// Compute what the anchored logic would pick for a lead (shadow, no mutation).
// Returns { oldEmail, shadowEmail, currentDomain, source, verdict, changed, mxOk }.
// verdict ∈ { OK_ON_DOMAIN, WOULD_CHANGE, WOULD_HOLD, same }.
// doVerify=true also runs a cached DoH MX check on the chosen domain (advisory).
function _shadowPickEmail_(lead, doVerify) {
  var oldEmail = (lead && lead.enrichedEmail || '').toString().toLowerCase().trim();
  var res = { oldEmail: oldEmail, shadowEmail: '', currentDomain: '', source: '', verdict: '', changed: false, mxOk: null };
  var cur = _resolveCurrentEmployerDomain_(lead, doVerify);   // probe org→domain only when verifying
  res.currentDomain = cur.domain;

  if (!cur.domain) {
    // Can't confirm a current-employer domain → the live logic would HOLD (VERIFY_EMAIL),
    // never guess an off-domain address. If the current pick is already on no-known-domain
    // it stays as-is in the shadow (we don't have a better answer without vendor resolution).
    res.shadowEmail = oldEmail;
    res.verdict = 'WOULD_HOLD';
    res.source = 'no_current_domain_resolved';
    return res;
  }

  var apk = (lead && lead.email || '').toString().toLowerCase().trim();
  function onCur(e) { return _emailDomainOf_(e) === cur.domain; }

  if (apk && onCur(apk)) { res.shadowEmail = apk; res.source = 'apk_on_current_domain'; }
  else if (oldEmail && onCur(oldEmail)) { res.shadowEmail = oldEmail; res.source = 'kept_old_on_current_domain'; }
  else {
    var nm = (lead && lead.fullName || '').toString().toLowerCase().replace(/[^a-z\s]/g, ' ').trim().split(/\s+/);
    if (nm.length >= 2 && nm[0]) {
      res.shadowEmail = nm[0] + '.' + nm[nm.length - 1] + '@' + cur.domain;
      res.source = 'constructed_first_last_on_current_domain';
    } else {
      res.shadowEmail = oldEmail;
      res.source = 'no_name_for_construction';
    }
  }

  res.changed = !!(res.shadowEmail && res.shadowEmail !== oldEmail);
  // OK_ON_DOMAIN = current pick already on the right domain; WOULD_CHANGE = off-domain pick corrected.
  res.verdict = (oldEmail && onCur(oldEmail)) ? 'OK_ON_DOMAIN' : (res.changed ? 'WOULD_CHANGE' : 'same');

  if (doVerify && cur.domain && typeof verifyMxRecord === 'function') {
    try { res.mxOk = !!verifyMxRecord(cur.domain).hasMx; } catch (_) { res.mxOk = null; }
  }
  return res;
}

// DIAGNOSTIC (read-only): scan recent leads, compute the anchored pick for each, and report
// the diff vs the current enrichedEmail. Quantifies the blast radius of the off-domain bug
// and shows exactly what the durable fix would change — BEFORE anything goes live.
// arg1 = how many recent rows to scan (default 120). argS = optional status filter
// ('VERIFY_EMAIL', 'DRAFT_CREATED', ...) or 'changed' to return only WOULD_CHANGE rows.
function menuShadowEmailDiff(a, argS) {
  var scanN = (typeof a === 'number' && a > 0) ? a : (parseInt(a, 10) > 0 ? parseInt(a, 10) : 120);
  var filter = (argS || '').toString().trim();
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sh = ss.getSheetByName(CONFIG.DATA_SHEET);
  if (!sh) return { status: 'error', error: 'data sheet not found' };
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return { status: 'ok', scanned: 0, leads: [] };
  var c = CONFIG.COLUMNS;
  var width = CONFIG.SHEET_COL_COUNT || 26;
  var startRow = Math.max(2, lastRow - scanN + 1);
  var data = sh.getRange(startRow, 1, lastRow - startRow + 1, width).getValues();

  // Statuses worth analysing for email accuracy (skip terminal/non-email states).
  var ANALYZE = { 'VERIFY_EMAIL': 1, 'DRAFT_CREATED': 1, 'SENT': 1, 'NEW': 1, 'RESEARCH_DONE': 1,
                  'COMPOSING': 1, 'HUMANIZING': 1, 'QUALITY_CHECK': 1, 'FOLLOWUP_1': 1, 'FOLLOWUP_2': 1, 'FOLLOWUP_3': 1 };
  var summary = { OK_ON_DOMAIN: 0, WOULD_CHANGE: 0, WOULD_HOLD: 0, same: 0, skipped: 0 };
  var changes = [];
  for (var i = 0; i < data.length; i++) {
    var r = data[i];
    var status = (r[c.STATUS - 1] || '').toString();
    var enriched = c.ENRICHED_EMAIL ? (r[c.ENRICHED_EMAIL - 1] || '').toString() : '';
    if (!ANALYZE[status] || !enriched) { summary.skipped++; continue; }
    var lead = {
      rowNum: startRow + i,
      fullName:     (r[c.FULL_NAME - 1]    || '').toString(),
      organization: (r[c.ORGANIZATION - 1] || '').toString(),
      headline:     c.HEADLINE ? (r[c.HEADLINE - 1] || '').toString() : '',
      email:        (r[c.EMAIL - 1]        || '').toString(),
      enrichedEmail: enriched,
      status: status
    };
    if (filter && filter !== 'changed' && status !== filter) { summary.skipped++; continue; }
    var pick = _shadowPickEmail_(lead, true);   // enable DoH org-probe so holds aren't overstated
    summary[pick.verdict] = (summary[pick.verdict] || 0) + 1;
    if (pick.verdict === 'WOULD_CHANGE' || (filter !== 'changed' && pick.verdict === 'WOULD_HOLD' && status !== 'VERIFY_EMAIL')) {
      changes.push({
        row: lead.rowNum, name: lead.fullName, org: lead.organization, status: status,
        oldEmail: pick.oldEmail, shadowEmail: pick.shadowEmail,
        currentDomain: pick.currentDomain, source: pick.source, verdict: pick.verdict
      });
    }
  }
  // MX-verify the distinct target domains of the WOULD_CHANGE rows (cached, bounded).
  var seenDom = {};
  changes.forEach(function(ch) {
    if (ch.verdict === 'WOULD_CHANGE' && ch.currentDomain && !(ch.currentDomain in seenDom)) {
      try { seenDom[ch.currentDomain] = (typeof verifyMxRecord === 'function') ? !!verifyMxRecord(ch.currentDomain).hasMx : null; }
      catch (_) { seenDom[ch.currentDomain] = null; }
    }
    ch.targetDomainHasMx = (ch.currentDomain in seenDom) ? seenDom[ch.currentDomain] : null;
  });
  return {
    status: 'ok',
    scannedRows: data.length,
    fromRow: startRow, toRow: lastRow,
    summary: summary,
    note: 'READ-ONLY shadow. OK_ON_DOMAIN=current pick already on the current-employer domain; ' +
          'WOULD_CHANGE=off-domain pick the durable fix would correct; WOULD_HOLD=no current domain ' +
          'resolvable (would park at VERIFY_EMAIL). Nothing was modified.',
    changes: changes.slice(0, 40)
  };
}

// DIAGNOSTIC (read-only): show what _extractHeadlineCurrentCompany now extracts as the CURRENT
// employer from each recent lead's headline, and flag the rows where it WOULD override the org
// (a _companiesConflict). This is the eyeball for the keystone parser fix — confirm it never
// resurrects an ex-employer (e.g. Bhavya → '' not "Bistro") and only overrides on genuine staleness
// (e.g. Samarth → "Anthropic"). arg1 = rows to scan (default 80). No writes.
function menuShadowEmployerParse(a, argS) {
  var scanN = (typeof a === 'number' && a > 0) ? a : (parseInt(a, 10) > 0 ? parseInt(a, 10) : 80);
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sh = ss.getSheetByName(CONFIG.DATA_SHEET);
  if (!sh) return { status: 'error', error: 'data sheet not found' };
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return { status: 'ok', scanned: 0 };
  var c = CONFIG.COLUMNS, width = CONFIG.SHEET_COL_COUNT || 26;
  var startRow = Math.max(2, lastRow - scanN + 1);
  var data = sh.getRange(startRow, 1, lastRow - startRow + 1, width).getValues();
  var out = { status: 'ok', scanned: data.length, wouldOverride: [], extractedCount: 0, emptyCount: 0 };
  for (var i = 0; i < data.length; i++) {
    var r = data[i];
    var headline = c.HEADLINE ? (r[c.HEADLINE - 1] || '').toString() : '';
    if (!headline) continue;
    var org = (r[c.ORGANIZATION - 1] || '').toString();
    var name = (r[c.FULL_NAME - 1] || '').toString();
    var parsed = (typeof _extractHeadlineCurrentCompany === 'function') ? _extractHeadlineCurrentCompany(headline) : '';
    if (parsed) out.extractedCount++; else out.emptyCount++;
    var conflict = parsed && (typeof _companiesConflict === 'function') && _companiesConflict(parsed, org);
    if (conflict) {
      out.wouldOverride.push({ row: startRow + i, name: name, org: org, headlineCurrent: parsed, headline: headline.substring(0, 90) });
    }
  }
  out.note = 'wouldOverride = rows where the parser extracts a CURRENT employer that differs from the org ' +
             'field → _reconcileCurrentEmployer would replace org with headlineCurrent. Verify each is a ' +
             'genuine stale-org correction (good), NOT an ex-employer resurrection (bad).';
  return out;
}
