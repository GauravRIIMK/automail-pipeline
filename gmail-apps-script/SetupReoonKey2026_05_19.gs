/**
 * ============================================================
 * SetupReoonKey2026_05_19.gs — One-shot Reoon API key rotation
 * ============================================================
 *
 * Background: the previous REOON_API_KEY started returning 401 on every
 * verify call (see logs from 2026-05-19 morning — all enrichEmail
 * verifications failing with `"Invalid API key."`). User issued a new
 * key via Reoon's dashboard.
 *
 * To run:
 *   1. Open Apps Script editor → this file
 *   2. Function dropdown → `installNewReoonKey_2026_05_19`
 *   3. Click Run ▶
 *   4. Authorize if prompted
 *   5. Check Execution log → should report "Reoon API live with new key"
 *
 * After verification, this file can be safely deleted from the project
 * (the key is now persisted in Script Properties; this one-shot was
 * only the installer).
 *
 * The key itself is embedded here per the user's explicit instruction
 * (2026-05-19 chat). If you ever rotate again, edit the constant below
 * or use the generic `set_script_property` admin endpoint added in the
 * 2026-05-19 deploy.
 */

var REOON_NEW_KEY_2026_05_19 = '0Mj56KV7wZN2nd31PoN7Ul1hnPafAlxn';

/**
 * Installs the new Reoon key into Script Properties, then immediately
 * tests it by calling Reoon's `quick-verify` endpoint on a known-valid
 * mailbox. Reports success or failure with the actual API response.
 *
 * Idempotent: re-running just re-writes the same key.
 */
function installNewReoonKey_2026_05_19() {
  var props = PropertiesService.getScriptProperties();
  var oldKey = props.getProperty('REOON_API_KEY') || '';
  var oldKeyPreview = oldKey ? (oldKey.substring(0, 6) + '...') : '<unset>';

  // Step 1: write new key
  props.setProperty('REOON_API_KEY', REOON_NEW_KEY_2026_05_19);
  Logger.log('[ReoonKeyRotate] Replaced ' + oldKeyPreview +
             ' → ' + REOON_NEW_KEY_2026_05_19.substring(0, 6) + '... (length ' +
             REOON_NEW_KEY_2026_05_19.length + ')');

  // Step 2: live-test by calling Reoon on a test email. Use a well-known
  // address that's guaranteed valid — Google's own postmaster account is
  // a stable target. Reoon will return safe/role_account for it.
  var testEmail = 'postmaster@gmail.com';
  var testUrl = 'https://emailverifier.reoon.com/api/v1/verify?email=' +
                encodeURIComponent(testEmail) +
                '&key=' + encodeURIComponent(REOON_NEW_KEY_2026_05_19) +
                '&mode=quick';

  try {
    var res = UrlFetchApp.fetch(testUrl, { muteHttpExceptions: true });
    var code = res.getResponseCode();
    var bodyExcerpt = (res.getContentText() || '').substring(0, 300);

    if (code === 200) {
      Logger.log('[ReoonKeyRotate] ✅ Reoon API LIVE with new key. Response: ' + bodyExcerpt);
      return {
        status: 'ok',
        keyInstalled: true,
        keyLength: REOON_NEW_KEY_2026_05_19.length,
        keyPreview: REOON_NEW_KEY_2026_05_19.substring(0, 6) + '...',
        testEmail: testEmail,
        testHttp: code,
        testResponse: bodyExcerpt
      };
    } else if (code === 401) {
      Logger.log('[ReoonKeyRotate] ❌ New key STILL returns 401. Body: ' + bodyExcerpt);
      return {
        status: 'auth_failed',
        keyInstalled: true,
        testHttp: code,
        testResponse: bodyExcerpt,
        nextStep: 'Verify the key is correct at https://emailverifier.reoon.com — possibly a typo or rate limit on new keys'
      };
    } else {
      Logger.log('[ReoonKeyRotate] ⚠️ Unexpected HTTP ' + code + ': ' + bodyExcerpt);
      return {
        status: 'unexpected_response',
        keyInstalled: true,
        testHttp: code,
        testResponse: bodyExcerpt
      };
    }
  } catch (err) {
    Logger.log('[ReoonKeyRotate] Test request threw: ' + err.message);
    return {
      status: 'test_threw',
      keyInstalled: true,
      error: err.message,
      nextStep: 'Key is installed but live test failed. Try ?action=test_reoon_key&token=<ADMIN> after deploy.'
    };
  }
}
