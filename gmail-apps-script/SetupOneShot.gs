/**
 * SetupOneShot.gs — bootstrap helpers run via `clasp run`.
 *
 * These functions are intentionally idempotent + return result info so the
 * caller can verify they took effect. Safe to call multiple times.
 *
 * Created 2026-05-12. Keys are stored in Script Properties, never logged
 * back out (the function returns key.length + key.preview only).
 */

function installForcedApiKeys2026_05_12() {
  var props = PropertiesService.getScriptProperties();
  // NOTE: This function used to ship with hardcoded keys. Keys are now stored
  // exclusively in Script Properties. Run this once to verify they are set:
  var required = ['HUNTER_API_KEY', 'SNOV_CLIENT_ID', 'SNOV_CLIENT_SECRET', 'APOLLO_API_KEY', 'REOON_API_KEY'];
  var missing = [];
  required.forEach(function(k) {
    var v = props.getProperty(k);
    if (!v || v.length < 8) missing.push(k);
  });
  if (missing.length > 0) {
    throw new Error('Missing Script Properties: ' + missing.join(', ')
      + '. Set them via Project Settings → Script Properties before running the cascade.');
  }
  Logger.log('All API keys present in Script Properties.');
}

function setupOneShot_GenerateAdminToken() {
  var props = PropertiesService.getScriptProperties();
  var existing = props.getProperty('ADMIN_TOKEN');
  if (existing && existing.length >= 16) {
    Logger.log('ADMIN_TOKEN already set (length ' + existing.length + ').');
    return;
  }
  var token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').substring(0, 16);
  props.setProperty('ADMIN_TOKEN', token);
  Logger.log('Generated ADMIN_TOKEN: ' + token + '\nSave this — you will need it for /exec calls.');
}

/**
 * Confirm what's currently configured. Returns presence + length per key.
 */
function inspectScriptPropertiesQuick() {
  var props = PropertiesService.getScriptProperties().getProperties();
  var watch = ['APOLLO_API_KEY', 'HUNTER_API_KEY', 'SNOV_CLIENT_ID', 'SNOV_CLIENT_SECRET',
               'REOON_API_KEY', 'FINDYMAIL_KEY', 'TRACKING_WEBAPP_BASE'];
  var out = {};
  watch.forEach(function(k) {
    var v = props[k] || '';
    out[k] = { set: !!v, length: v.length };
  });
  return out;
}
