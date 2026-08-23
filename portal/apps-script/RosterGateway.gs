/**
 * Chapter roll gateway
 * ====================
 * A second Apps Script web app, bound to the **brother list** spreadsheet (the
 * full chapter roll: PC, Roll Number, Name, Major, Minor(s), Graduation,
 * Executive Roles, Phone, Email).
 *
 * This is a SEPARATE project from the Tracker gateway. Put it in the brother
 * list spreadsheet, deploy it, and you get a second /exec URL.
 *
 * WHAT IT IS FOR
 *   Sign-up autofill. A brother registering for the portal types either their
 *   roll number or their name, and the other fills itself in — so roll numbers
 *   in the portal match the chapter roll instead of being typed from memory.
 *
 * WHAT IT DELIBERATELY WILL NOT DO
 *   It never returns Phone or Email. Only name and roll number ever leave this
 *   script, no matter what is asked for. It also has no "list everyone" action —
 *   every lookup is one exact match at a time, so it cannot be used to pull the
 *   roll down in bulk.
 *
 * HOW IT KNOWS THE CALLER IS REAL
 *   The Tracker gateway checks identity by reading the caller's own record out
 *   of the Realtime Database. That cannot work here: someone signing up does not
 *   have a portal account yet, which is the whole point. So this script verifies
 *   the Firebase ID token directly with Google's Identity Toolkit instead. A
 *   valid Google sign-in is required; a portal account is not.
 *
 * SETUP
 *   1. Open the BROTHER LIST spreadsheet - Extensions - Apps Script.
 *   2. Paste this in as Code.gs (this project is new, nothing to preserve).
 *   3. Deploy - New deployment - Web app.
 *        Execute as:      Me
 *        Who has access:  Anyone
 *   4. Copy the /exec URL and send it over to be wired into the sign-up page.
 *
 * Re-deploy (Deploy - Manage deployments - edit - Deploy) after any edit here,
 * or the previous version keeps serving.
 */

// ── Config ───────────────────────────────────────────────────────────────────

// Firebase Web API key, used only to ask Google whether a sign-in token is real.
// Safe to keep here: it is a public client key, already shipped in the site.
var FIREBASE_API_KEY = 'AIzaSyB7hAKBXbY79fd4UDDpV6cWLk_xvflCq8E';

// Leave blank to use the first tab. Set a name if the roll ever moves tabs.
var ROLL_SHEET_NAME = '';

// Column headers as they appear on row 1. Only these two are ever read out;
// Phone and Email are intentionally absent and must stay that way.
var COL_ROLL = 'Roll Number';
var COL_NAME = 'Name';

// ── Entry points ─────────────────────────────────────────────────────────────

function doPost(e) { return handle(e); }
function doGet(e)  { return handle(e); }

function handle(e) {
  try {
    var req = parseRequest(e);
    var action = req.action || 'lookup';

    if (action === 'ping') {
      return json({ ok: true, rows: rollTable().length });
    }
    if (action === 'lookup') {
      requireValidToken(req.idToken);
      return json(lookup(req.rollNumber, req.name));
    }
    return json({ ok: false, error: 'Unknown action: ' + action });
  } catch (err) {
    return json({ ok: false, error: String((err && err.message) || err) });
  }
}

function parseRequest(e) {
  if (e && e.postData && e.postData.contents) {
    try { return JSON.parse(e.postData.contents); } catch (ignored) {}
  }
  return (e && e.parameter) || {};
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── Identity ─────────────────────────────────────────────────────────────────

/**
 * Confirm the caller holds a real, unexpired Firebase sign-in. Throws otherwise.
 * No portal account is required — someone registering does not have one yet.
 */
function requireValidToken(idToken) {
  if (!idToken) throw new Error('Sign in first.');

  var res = UrlFetchApp.fetch(
    'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + FIREBASE_API_KEY,
    {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ idToken: idToken }),
      muteHttpExceptions: true
    }
  );

  if (res.getResponseCode() !== 200) {
    throw new Error('Your sign-in has expired. Sign in again.');
  }
  var body = JSON.parse(res.getContentText() || '{}');
  if (!body.users || !body.users.length) {
    throw new Error('Could not verify your sign-in.');
  }
  return body.users[0];
}

// ── Roll lookup ──────────────────────────────────────────────────────────────

/** Roll numbers appear as 396, "396", 396.0, and occasionally as "1XX". */
function normalizeRoll(v) {
  if (v === null || v === undefined) return '';
  var s = String(v).trim();
  if (!s) return '';
  if (/^\d+(\.0+)?$/.test(s)) return String(parseInt(s, 10));
  return s.toUpperCase();
}

function normalizeName(v) {
  return String(v || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Cached so repeated lookups during one sign-up don't re-read 600+ rows. */
function rollTable() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('rollTable');
  if (hit) {
    try { return JSON.parse(hit); } catch (ignored) {}
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ROLL_SHEET_NAME ? ss.getSheetByName(ROLL_SHEET_NAME) : ss.getSheets()[0];
  if (!sheet) return [];

  var values = sheet.getDataRange().getValues();
  if (!values.length) return [];

  var headers = values[0].map(function (h) { return String(h || '').trim().toLowerCase(); });
  var rollCol = headers.indexOf(COL_ROLL.toLowerCase());
  var nameCol = headers.indexOf(COL_NAME.toLowerCase());
  if (rollCol === -1 || nameCol === -1) {
    throw new Error('Could not find "' + COL_ROLL + '" and "' + COL_NAME + '" columns.');
  }

  // Only these two fields are ever held in memory, so nothing else can leak.
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var roll = normalizeRoll(values[i][rollCol]);
    var name = String(values[i][nameCol] || '').trim();
    if (roll || name) out.push({ roll: roll, name: name });
  }

  cache.put('rollTable', JSON.stringify(out), 900);   // 15 minutes
  return out;
}

/**
 * One exact match, either direction. Returns name and roll number only.
 * There is no partial or prefix matching on purpose — that would let the roll be
 * walked a letter at a time.
 */
function lookup(rollNumber, name) {
  var rows = rollTable();

  var wantRoll = normalizeRoll(rollNumber);
  if (wantRoll) {
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].roll && rows[i].roll === wantRoll) {
        return { ok: true, found: true, rollNumber: rows[i].roll, name: rows[i].name };
      }
    }
    return { ok: true, found: false };
  }

  var wantName = normalizeName(name);
  if (wantName) {
    var matches = rows.filter(function (r) { return normalizeName(r.name) === wantName; });
    if (matches.length === 1) {
      return { ok: true, found: true, rollNumber: matches[0].roll, name: matches[0].name };
    }
    // Two brothers with the same name — make them pick by roll number instead of
    // guessing wrong and stamping the wrong roll onto their portal account.
    if (matches.length > 1) {
      return { ok: true, found: false, ambiguous: true, count: matches.length };
    }
    return { ok: true, found: false };
  }

  return { ok: true, found: false };
}
