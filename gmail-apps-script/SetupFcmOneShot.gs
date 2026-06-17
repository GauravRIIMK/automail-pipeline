/**
 * SetupFcmOneShot.gs — Previously installed FCM_SERVICE_ACCOUNT_JSON via
 * a one-shot endpoint (since the Script Properties UI is read-only past 50
 * properties). The base64 payload has been cleared from source post-install
 * on 2026-05-12; the property remains populated and FCM is operational.
 *
 * Leaving this file in place with empty payload so the `verify_fcm` and
 * `fcm_test_push` endpoints in WebApp.gs continue to work without dispatch
 * errors. To re-install or rotate, paste a fresh base64-encoded JSON below
 * and re-run /exec?action=setup_install_fcm&token=...
 */

var FCM_JSON_B64 = '';  // cleared post-install

function installFcmServiceAccount() {
  if (!FCM_JSON_B64 || FCM_JSON_B64.length < 100) {
    return { status: 'noop', message: 'b64_payload_cleared_post_install',
             alreadyInstalled: !!PropertiesService.getScriptProperties().getProperty('FCM_SERVICE_ACCOUNT_JSON') };
  }
  var raw;
  try {
    var bytes = Utilities.base64Decode(FCM_JSON_B64);
    raw = Utilities.newBlob(bytes).getDataAsString('UTF-8');
  } catch (e) {
    return { status: 'error', error: 'b64_decode_failed: ' + e.message };
  }
  var parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { return { status: 'error', error: 'invalid_json: ' + e.message }; }
  if (!parsed.project_id || !parsed.private_key || !parsed.client_email) {
    return { status: 'error', error: 'missing_required_fields' };
  }
  PropertiesService.getScriptProperties().setProperty('FCM_SERVICE_ACCOUNT_JSON', raw);
  return { status: 'ok', project_id: parsed.project_id, client_email: parsed.client_email };
}

function verifyFcmSetup() {
  var token = (typeof getFcmAccessToken === 'function') ? getFcmAccessToken() : null;
  return {
    status: 'ok',
    serviceAccountInstalled: !!PropertiesService.getScriptProperties().getProperty('FCM_SERVICE_ACCOUNT_JSON'),
    accessTokenMinted: !!token,
    tokenPreview: token ? (token.substring(0, 12) + '…') : null
  };
}
