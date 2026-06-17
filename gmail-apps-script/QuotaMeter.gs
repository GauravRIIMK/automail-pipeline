/**
 * ============================================================
 * QuotaMeter.gs — Gmail service-call usage meter
 * (PATCH -eq8-quota-relief, 2026-06-11)
 * ============================================================
 *
 * GAS exposes NO API to read remaining daily quota ("Service invoked too many
 * times for one day: gmail" is the only signal, and it arrives as an outage).
 * This meter self-counts Gmail ops at the instrumented call sites so we can
 * SEE which consumer burns the ~20K/day consumer pool.
 *
 * Keys are **US-Pacific-date-keyed** (GMAIL_OPS_<yyyy-MM-dd>) because Google's
 * daily quotas reset at midnight Pacific (= 12:30 PM IST during PDT), NOT at
 * script-TZ midnight. Counting in any other TZ would smear two quota windows
 * into one bucket.
 *
 * Usage at call sites — ONE aggregated call per tag per run (each _gmOps call
 * costs 4 ScriptProperties ops; never call it per-message):
 *   _gmOps('syncer.scan', 1 + threads + msgs);
 *
 * Read:  menuShowGmailOpsMeter()  — today's total + per-tag breakdown.
 * Hygiene: the menu reader deletes GMAIL_OPS_* keys older than 3 PT-days.
 */

function _gmPtDate(d) {
  return Utilities.formatDate(d || new Date(), 'America/Los_Angeles', 'yyyy-MM-dd');
}

function _gmOps(tag, n) {
  n = (typeof n === 'number' && n > 0) ? Math.round(n) : 1;
  try {
    var props = PropertiesService.getScriptProperties();
    var day = _gmPtDate();
    var totKey = 'GMAIL_OPS_' + day;
    props.setProperty(totKey, String(parseInt(props.getProperty(totKey) || '0', 10) + n));
    if (tag) {
      var tagKey = 'GMAIL_OPS_' + day + '_' + tag;
      props.setProperty(tagKey, String(parseInt(props.getProperty(tagKey) || '0', 10) + n));
    }
  } catch (_) { /* metering must never break the pipeline */ }
}

/**
 * Today's (PT) Gmail-ops usage: total + per-tag, sorted desc. Also prunes
 * meter keys older than 3 PT-days.
 */
function menuShowGmailOpsMeter() {
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties();
  var today = _gmPtDate();
  var prefix = 'GMAIL_OPS_' + today;
  var total = 0;
  var byTag = [];
  var pruned = 0;

  Object.keys(all).forEach(function(k) {
    if (k.indexOf('GMAIL_OPS_') !== 0) return;
    // Prune > 3 PT-days old (key format GMAIL_OPS_yyyy-MM-dd[_tag])
    var datePart = k.substring(10, 20);
    if (datePart < _gmPtDate(new Date(Date.now() - 3 * 86400000))) {
      try { props.deleteProperty(k); pruned++; } catch (_) {}
      return;
    }
    if (k === prefix) total = parseInt(all[k], 10) || 0;
    else if (k.indexOf(prefix + '_') === 0) {
      byTag.push([k.substring(prefix.length + 1), parseInt(all[k], 10) || 0]);
    }
  });
  byTag.sort(function(a, b) { return b[1] - a[1]; });

  Logger.log('=== GMAIL OPS METER — PT day ' + today + ' (pool ~20,000/day consumer; resets midnight PT = 12:30 PM IST) ===');
  Logger.log('Metered total today: ' + total + '  (' + (total / 200).toFixed(1) + '% of 20K — instrumented sites only, not all Gmail usage)');
  byTag.forEach(function(t) { Logger.log('  ' + t[0] + ': ' + t[1]); });
  if (pruned) Logger.log('(pruned ' + pruned + ' stale meter keys)');
  return { ptDate: today, total: total, byTag: byTag, pruned: pruned };
}
