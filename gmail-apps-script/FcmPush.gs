/**
 * ============================================================
 * FcmPush.gs — Firebase Cloud Messaging HTTP v1 sender
 * (Patch 2026-05-12)
 *
 * REQUIRES Script Property: FCM_SERVICE_ACCOUNT_JSON (paste full JSON
 * file contents from a Firebase service account with role
 * "Firebase Cloud Messaging API Admin").
 *
 * If the property is unset, all helpers no-op silently — the rest of
 * the pipeline keeps working with hourly polling as the fallback.
 *
 * Entry points:
 *   sendFcmBroadcast(title, body, data) — to all registered devices
 *   sendFcmMessage(deviceToken, title, body, data) — to one device
 *
 * Used by: Tracking._trackingRecordOpen, _trackingRecordClick;
 *          ReplyDetector.processReplies
 * ============================================================
 */

var FCM_ACCESS_TOKEN_KEY = 'FCM_ACCESS_TOKEN';
var FCM_ACCESS_TOKEN_EXPIRY_KEY = 'FCM_ACCESS_TOKEN_EXPIRY';
var FCM_TOKENS_SHEET = 'FcmTokens';

function sendFcmBroadcast(title, body, data) {
  var tokens = _getAllFcmTokens();
  if (!tokens.length) return { sent: 0, reason: 'no_tokens_registered' };
  var sent = 0, failed = 0;
  for (var i = 0; i < tokens.length; i++) {
    var ok = sendFcmMessage(tokens[i], title, body, data);
    if (ok) sent++; else failed++;
  }
  return { sent: sent, failed: failed };
}

function sendFcmMessage(deviceToken, title, body, data) {
  if (!deviceToken) return false;
  var sa = _getFcmServiceAccount();
  if (!sa) return false;  // silent no-op when not configured

  var token = getFcmAccessToken();
  if (!token) return false;

  var dataPayload = {};
  if (data && typeof data === 'object') {
    Object.keys(data).forEach(function(k) { dataPayload[k] = String(data[k]); });
  }
  var payload = {
    message: {
      token: deviceToken,
      notification: { title: title, body: body },
      data: dataPayload,
      android: { priority: 'HIGH', notification: { sound: 'default' } }
    }
  };
  try {
    var resp = UrlFetchApp.fetch(
      'https://fcm.googleapis.com/v1/projects/' + sa.project_id + '/messages:send',
      {
        method: 'post',
        contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + token },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });
    var code = resp.getResponseCode();
    if (code !== 200) {
      Logger.log('[FCM] send failed ' + code + ': ' + resp.getContentText().substring(0, 200));
      // Token-invalid 404 → prune dead token from sheet
      if (code === 404 || code === 410) {
        _pruneFcmToken(deviceToken);
      }
      return false;
    }
    return true;
  } catch (e) {
    Logger.log('[FCM] fetch error: ' + e.message);
    return false;
  }
}

function getFcmAccessToken() {
  var props = PropertiesService.getScriptProperties();
  var cached = props.getProperty(FCM_ACCESS_TOKEN_KEY);
  var expiry = parseInt(props.getProperty(FCM_ACCESS_TOKEN_EXPIRY_KEY) || '0', 10);
  if (cached && expiry && Math.floor(Date.now() / 1000) < (expiry - 60)) return cached;

  var sa = _getFcmServiceAccount();
  if (!sa) return null;
  var newToken = _exchangeJwtForAccessToken(sa);
  if (newToken) {
    var newExp = Math.floor(Date.now() / 1000) + 3300;  // 55 min cache
    props.setProperty(FCM_ACCESS_TOKEN_KEY, newToken);
    props.setProperty(FCM_ACCESS_TOKEN_EXPIRY_KEY, String(newExp));
  }
  return newToken;
}

function _exchangeJwtForAccessToken(sa) {
  var TOKEN_URL = 'https://oauth2.googleapis.com/token';
  var now = Math.floor(Date.now() / 1000);
  var header = { alg: 'RS256', typ: 'JWT' };
  var claim = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: TOKEN_URL,
    iat: now, exp: now + 3600
  };
  function b64url(obj) {
    return Utilities.base64EncodeWebSafe(JSON.stringify(obj)).replace(/=+$/, '');
  }
  var signingInput = b64url(header) + '.' + b64url(claim);
  var privateKey = sa.private_key.replace(/\\n/g, '\n');
  try {
    var sigBytes = Utilities.computeRsaSha256Signature(signingInput, privateKey);
    var signature = Utilities.base64EncodeWebSafe(sigBytes).replace(/=+$/, '');
    var jwt = signingInput + '.' + signature;
    var resp = UrlFetchApp.fetch(TOKEN_URL, {
      method: 'post',
      contentType: 'application/x-www-form-urlencoded',
      payload: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') +
               '&assertion=' + encodeURIComponent(jwt),
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() !== 200) {
      Logger.log('[FCM] token-exchange failed: ' + resp.getContentText().substring(0, 200));
      return null;
    }
    return JSON.parse(resp.getContentText()).access_token || null;
  } catch (e) {
    Logger.log('[FCM] JWT signing failed: ' + e.message);
    return null;
  }
}

function _getFcmServiceAccount() {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty('FCM_SERVICE_ACCOUNT_JSON');
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    Logger.log('[FCM] could not parse FCM_SERVICE_ACCOUNT_JSON: ' + e.message);
    return null;
  }
}

function _getAllFcmTokens() {
  try {
    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = ss.getSheetByName(FCM_TOKENS_SHEET);
    if (!sheet || sheet.getLastRow() < 2) return [];
    return sheet.getRange(2, 2, sheet.getLastRow() - 1, 1).getValues()
      .map(function(r) { return (r[0] || '').toString().trim(); })
      .filter(function(t) { return t.length > 20; });
  } catch (e) {
    Logger.log('[FCM] _getAllFcmTokens error: ' + e.message);
    return [];
  }
}

function _pruneFcmToken(token) {
  try {
    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = ss.getSheetByName(FCM_TOKENS_SHEET);
    if (!sheet || sheet.getLastRow() < 2) return;
    var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues();
    for (var i = 0; i < rows.length; i++) {
      if (rows[i][1] === token) {
        sheet.deleteRow(i + 2);
        Logger.log('[FCM] Pruned invalid token: ' + token.substring(0, 20) + '...');
        return;
      }
    }
  } catch (e) {
    Logger.log('[FCM] _pruneFcmToken error: ' + e.message);
  }
}

/** Register FCM token from APK. Called by WebApp.gs action=register_fcm_token. */
function registerFcmTokenForUser(token, userEmail) {
  if (!token || token.length < 20) return { status: 'error', error: 'invalid_token' };
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(FCM_TOKENS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(FCM_TOKENS_SHEET);
    sheet.appendRow(['Timestamp', 'FCM_Token', 'User_Email']);
    sheet.getRange(1, 1, 1, 3).setFontWeight('bold');
  }
  // Idempotent upsert
  if (sheet.getLastRow() >= 2) {
    var existing = sheet.getRange(2, 2, sheet.getLastRow() - 1, 1).getValues();
    for (var i = 0; i < existing.length; i++) {
      if (existing[i][0] === token) {
        sheet.getRange(i + 2, 1).setValue(new Date().toISOString());
        return { status: 'ok', action: 'updated' };
      }
    }
  }
  sheet.appendRow([new Date().toISOString(), token, userEmail || '']);
  return { status: 'ok', action: 'registered' };
}
