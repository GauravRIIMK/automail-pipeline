/**
 * DraftInspector.gs — machine-check recent Gmail drafts against the 7
 * draft-quality fixes (PATCH -eq8-draftcheck, 2026-06-11). Read-only.
 *
 * For the N newest drafts created today, pulls the HTML body and evaluates:
 *   c1 compact box   — 'INTERNAL NOTE' present → must be the one-line style
 *   c2 greeting      — no "Hi There"/"Hi [Name]"; real "Hi <Name>,"
 *   c4 hr bullets    — if Blinkit/upGrad content: table rows (width:28px)
 *   c5 github        — '(all live).' + github.com/GauravRIIMK link
 *   c6 calendly      — calendly.com/speak-to-gaurav/30min link
 *   c7 positioning   — subject mentions Growth/Marketing/Strategy
 *   c3 org-match     — not body-checkable alone; surfaces to+subject+hook
 *                      excerpt for eyeball cross-check (gate is test-verified)
 */
function menuInspectRecentDrafts(n) {
  n = (typeof n === 'number' && n > 0) ? n : 8;
  var drafts = GmailApp.getDrafts();
  if (typeof _gmOps === 'function') _gmOps('inspector', 1 + Math.min(drafts.length, 60));
  var todayIst = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd');
  var out = [];
  // getDrafts() order is not guaranteed — scan up to 60, keep today's, sort desc.
  var cand = [];
  for (var i = 0; i < drafts.length && cand.length < 60; i++) {
    var m;
    try { m = drafts[i].getMessage(); } catch (_) { continue; }
    var d = m.getDate();
    if (Utilities.formatDate(d, 'Asia/Kolkata', 'yyyy-MM-dd') === todayIst) {
      cand.push({ m: m, d: d });
    }
  }
  cand.sort(function(a, b) { return b.d - a.d; });
  cand.slice(0, n).forEach(function(c) {
    var body = '';
    try { body = c.m.getBody() || ''; } catch (_) {}
    var subject = c.m.getSubject() || '';
    var hasNote = body.indexOf('INTERNAL NOTE') >= 0;
    var noteIdx = body.indexOf('INTERNAL NOTE');
    var noteExcerpt = hasNote ? body.substring(Math.max(0, noteIdx - 40), noteIdx + 160).replace(/<[^>]+>/g, ' ').substring(0, 140) : '';
    var greetMatch = body.match(/Hi\s+\*?([A-Za-z\[][^,<*]{0,25})/);
    var hrContent = /Blinkit Bistro|upGrad/i.test(body);
    out.push({
      dateIst: Utilities.formatDate(c.d, 'Asia/Kolkata', 'HH:mm'),
      to: (c.m.getTo() || '').substring(0, 50),
      subject: subject.substring(0, 70),
      c1_box: hasNote ? { compact: noteExcerpt.indexOf('delete') >= 0 || noteExcerpt.length < 140, excerpt: noteExcerpt } : 'no-box(verified-tier)',
      c2_greeting: greetMatch ? greetMatch[0].substring(0, 20) : 'NO-GREETING-FOUND',
      c2_ok: !!greetMatch && !/there|\[?name\]?/i.test(greetMatch[1] || ''),
      c4_hr_bullets_ok: hrContent ? (body.indexOf('width:28px') >= 0) : 'n/a-not-hr-content',
      c5_github_ok: body.indexOf('github.com/GauravRIIMK') >= 0 && body.indexOf('(all live).') >= 0,
      c6_calendly_ok: body.indexOf('calendly.com/speak-to-gaurav/30min') >= 0,
      c7_subject_ok: /growth|marketing|strategy/i.test(subject),
      c3_hook_excerpt: body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').substring(0, 220)
    });
  });
  Logger.log(JSON.stringify({ todayIst: todayIst, inspected: out.length }, null, 0));
  return { todayIst: todayIst, totalDraftsScanned: Math.min(drafts.length, 60), todayCount: cand.length, inspected: out };
}
