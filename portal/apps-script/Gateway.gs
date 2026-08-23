/**
 * Theta Tau Tracker gateway
 * =========================
 * A Google Apps Script web app that sits in front of the Tracker spreadsheet and
 * hands each signed-in brother ONLY their own row — demerits, payments, and (once
 * the tab exists) service hours.
 *
 * Why a gateway instead of publishing the sheet: a published sheet is readable by
 * anyone with the link. Balances and demerits should not be. This keeps the sheet
 * private and makes the portal the only way in.
 *
 * HOW IT KNOWS WHO IS ASKING (no passwords, no service-account key):
 *   1. The portal sends the brother's Firebase ID token.
 *   2. This script calls the Realtime Database REST API using THAT token as the
 *      caller. Your database rules already say a user may only read
 *      users/{their own uid}, so the database itself does the verifying — an
 *      invalid or someone else's token simply gets refused.
 *   3. Whatever roll number comes back is authoritative. A brother cannot ask for
 *      another brother's roll number, because they can't read another user record.
 *
 * SETUP
 *   1. Open the Tracker spreadsheet - Extensions - Apps Script.
 *   2. Add a NEW file (+ - Script) named Gateway, and paste this in.
 *      Do NOT paste over the existing Code.gs. That file is the template
 *      builder; the two live side by side and share no function names.
 *   3. Deploy - New deployment - type "Web app".
 *        Execute as:       Me
 *        Who has access:   Anyone
 *      "Anyone" is required so the portal can call it; the token check above is
 *      what actually protects the data.
 *   4. Copy the /exec URL it gives you into portal/js/tracker.js (GATEWAY_URL).
 *
 * After changing this file you must Deploy - Manage deployments - edit - Deploy
 * again, or the old version keeps serving.
 */

// ── Config ───────────────────────────────────────────────────────────────────

var FIREBASE_DB = 'https://thetatauzd-2ab25-default-rtdb.firebaseio.com';

// Optional: the separate chapter-roll spreadsheet used for sign-up autofill.
// Leave blank to fall back to this workbook's own "Roster" tab.
var ROLL_SPREADSHEET_ID = '';
var ROLL_SHEET_NAME = '';

// Each entry lists the tab names to try, in order. The live workbook has drifted
// from what the template builder creates (the dashboard was renamed), so both
// spellings are accepted rather than assuming one.
var SHEETS = {
  roster: ['Roster'],
  payments: ['Payments_Fines'],
  demerits: ['DemeritDashboard', 'Dashboard'],
  adjustments: ['Standards_Adjustments'],
  serviceHours: ['Service_Hours']   // optional; ignored until you add it
};

// ── Entry points ─────────────────────────────────────────────────────────────

function doPost(e) {
  return handle(e);
}

function doGet(e) {
  return handle(e);
}

function handle(e) {
  try {
    var req = parseRequest(e);
    var action = req.action || 'me';

    if (action === 'me') return json(getMyRecord(req.idToken));
    if (action === 'lookupRoll') return json(lookupRoll(req.idToken, req.rollNumber));
    if (action === 'ping') return json({ ok: true, sheets: listTabs() });

    return json({ ok: false, error: 'Unknown action: ' + action });
  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err) });
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
 * Read the caller's own user record straight from the Realtime Database, using
 * their token as the credential. Returns { uid, email, name, rollNumber, role }.
 * Throws if the token is missing, expired, or the record is unreadable.
 */
function resolveCaller(idToken) {
  if (!idToken) throw new Error('Not signed in.');

  var uid = uidFromToken(idToken);
  if (!uid) throw new Error('Could not read that sign-in token.');

  var url = FIREBASE_DB + '/users/' + encodeURIComponent(uid) + '.json?auth=' +
            encodeURIComponent(idToken);
  var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  var code = res.getResponseCode();

  if (code === 401 || code === 403) throw new Error('Your session expired. Sign in again.');
  if (code !== 200) throw new Error('Could not verify your account (' + code + ').');

  var rec = JSON.parse(res.getContentText() || 'null');
  if (!rec) throw new Error('No portal account found for you yet.');
  if (rec.role === 'pending') throw new Error('Your account is still awaiting approval.');

  return {
    uid: uid,
    email: rec.email || '',
    name: rec.name || '',
    rollNumber: normalizeRoll(rec.rollNumber),
    role: rec.role || ''
  };
}

/** Pull the uid out of the token body. The database call above is what verifies it. */
function uidFromToken(idToken) {
  var parts = String(idToken).split('.');
  if (parts.length < 2) return null;
  try {
    var payload = Utilities.newBlob(
      Utilities.base64DecodeWebSafe(parts[1])
    ).getDataAsString();
    var obj = JSON.parse(payload);
    return obj.user_id || obj.sub || null;
  } catch (err) {
    return null;
  }
}

// ── Sheet helpers ────────────────────────────────────────────────────────────

function listTabs() {
  return SpreadsheetApp.getActiveSpreadsheet().getSheets().map(function (s) {
    return s.getName();
  });
}

/** First existing tab from a list of candidate names. */
function getSheet(names) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var list = Array.isArray(names) ? names : [names];
  for (var i = 0; i < list.length; i++) {
    var s = ss.getSheetByName(list[i]);
    if (s) return s;
  }
  return null;
}

/**
 * Read a tab as objects. Tabs in this workbook don't all start at row 1
 * (DemeritDashboard has title rows above its header), so the header row is found
 * by looking for the first row containing "Brother Name".
 */
function readTable(sheetNames, headerHint) {
  var sheet = getSheet(sheetNames);
  if (!sheet) return { headers: [], rows: [] };

  var values = sheet.getDataRange().getValues();
  if (!values.length) return { headers: [], rows: [] };

  var hint = (headerHint || 'brother name').toLowerCase();
  var headerIdx = -1;
  for (var i = 0; i < values.length && i < 30; i++) {
    var joined = values[i].join('|').toLowerCase();
    if (joined.indexOf(hint) !== -1) { headerIdx = i; break; }
  }
  if (headerIdx === -1) headerIdx = 0;

  var headers = values[headerIdx].map(function (h) { return String(h || '').trim(); });
  var rows = [];
  for (var r = headerIdx + 1; r < values.length; r++) {
    var raw = values[r];
    if (!raw.join('').trim()) continue;         // skip the blank spacer rows
    var obj = {};
    for (var c = 0; c < headers.length; c++) {
      if (headers[c]) obj[headers[c]] = raw[c];
    }
    rows.push(obj);
  }
  return { headers: headers, rows: rows };
}

/** Roll numbers arrive as 396, "396", or 396.0 depending on the cell. */
function normalizeRoll(v) {
  if (v === null || v === undefined) return '';
  var s = String(v).trim();
  if (!s) return '';
  if (/^\d+(\.0+)?$/.test(s)) return String(parseInt(s, 10));
  return s;
}

function normalizeName(v) {
  return String(v || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function pick(row, names) {
  for (var i = 0; i < names.length; i++) {
    var key = names[i];
    for (var k in row) {
      if (row.hasOwnProperty(k) && k.toLowerCase() === key.toLowerCase()) return row[k];
    }
  }
  return '';
}

/**
 * Match a header by substring. The rollover column is named for the semester
 * ("Spring 2026      Rollover Demerits"), so it changes every term and cannot be
 * matched exactly.
 */
function pickLike(row, fragments) {
  for (var i = 0; i < fragments.length; i++) {
    var frag = fragments[i].toLowerCase();
    for (var k in row) {
      if (row.hasOwnProperty(k) && k.toLowerCase().indexOf(frag) !== -1) return row[k];
    }
  }
  return '';
}

/** Name <-> roll number map built from the Roster tab. */
function rosterIndex() {
  var t = readTable(SHEETS.roster, 'brother name');
  var byRoll = {}, byName = {};
  t.rows.forEach(function (row) {
    var name = String(pick(row, ['Brother Name', 'Name'] ) || '').trim();
    var roll = normalizeRoll(pick(row, ['Roll Number', 'Roll #', 'Roll']));
    if (!name && !roll) return;
    if (roll) byRoll[roll] = name;
    if (name) byName[normalizeName(name)] = roll;
  });
  return { byRoll: byRoll, byName: byName };
}

/**
 * Does this sheet row belong to the brother we're serving? Prefers an explicit
 * Roll Number column when the tab has one, so adding that column to the tracker
 * tabs makes the match exact without breaking rows that only have a name.
 */
function rowMatches(row, rollNumber, name) {
  var rowRoll = normalizeRoll(pick(row, ['Roll Number', 'Roll #', 'Roll']));
  if (rowRoll) return rowRoll === rollNumber;
  var rowName = normalizeName(pick(row, ['Brother Name', 'Name']));
  return !!rowName && rowName === normalizeName(name);
}

function toNumber(v) {
  if (v === null || v === undefined || v === '') return 0;
  var n = Number(String(v).replace(/[$,]/g, ''));
  return isNaN(n) ? 0 : n;
}

function toDateString(v) {
  if (!v) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'MMM d, yyyy');
  }
  return String(v);
}

// ── Payloads ─────────────────────────────────────────────────────────────────

function getMyRecord(idToken) {
  var me = resolveCaller(idToken);
  var index = rosterIndex();

  // The roll number on the portal account is the key. Fall back to the roster's
  // spelling of the name so name-only sheet rows still line up.
  var roll = me.rollNumber;
  var sheetName = (roll && index.byRoll[roll]) || me.name;

  return {
    ok: true,
    brother: { name: me.name, rollNumber: roll, rosterName: sheetName },
    payments: getPayments(roll, sheetName),
    demerits: getDemerits(roll, sheetName),
    serviceHours: getServiceHours(roll, sheetName)
  };
}

function getPayments(roll, sheetName) {
  var t = readTable(SHEETS.payments, 'brother name');
  var items = [];
  var owed = 0, paid = 0;

  t.rows.forEach(function (row) {
    if (!rowMatches(row, roll, sheetName)) return;

    var amount = toNumber(pick(row, ['Amount Owed', 'Amount']));
    var status = String(pick(row, ['Payment Status', 'Status']) || '').trim();

    // The sheet's Lists tab allows Unpaid / Paid / Late / Waived. Only Paid counts
    // as money received, and a waived item is forgiven — it must not sit in the
    // balance due, or brothers see a bill the treasurer already cleared.
    var isPaid = /^paid$/i.test(status);
    var isWaived = /^waived$/i.test(status);

    if (isPaid) paid += amount;
    else if (!isWaived) owed += amount;

    items.push({
      item: String(pick(row, ['Item / Fine', 'Item', 'Fine']) || '').trim(),
      amount: amount,
      status: status || 'Unpaid',
      paid: isPaid,
      dueDate: toDateString(pick(row, ['Due Date'])),
      datePaid: toDateString(pick(row, ['Date Paid'])),
      demeritsIfLate: toNumber(pick(row, ['Demerits If Unpaid/Late', 'Demerits If Unpaid', 'Demerits'])),
      notes: String(pick(row, ['Notes']) || '').trim()
    });
  });

  // Unpaid first, then most recent due date.
  items.sort(function (a, b) {
    if (a.paid !== b.paid) return a.paid ? 1 : -1;
    return 0;
  });

  return { balanceDue: owed, totalPaid: paid, items: items };
}

function getDemerits(roll, sheetName) {
  var dash = readTable(SHEETS.demerits, 'brother name');
  var summary = null;

  dash.rows.forEach(function (row) {
    if (summary || !rowMatches(row, roll, sheetName)) return;
    summary = {
      total: toNumber(pick(row, ['Total Demerits'])),
      rollover: toNumber(pickLike(row, ['rollover'])),
      attendance: toNumber(pick(row, ['Attendance Demerits'])),
      payment: toNumber(pick(row, ['Payment/Fine Demerits'])),
      standards: toNumber(pick(row, ['Standards Adjustments'])),
      notes: String(pick(row, ['Notes']) || '').trim()
    };
  });

  // Individual standards entries, so a brother can see why, not just how many.
  var adj = readTable(SHEETS.adjustments, 'brother name');
  var entries = [];
  adj.rows.forEach(function (row) {
    if (!rowMatches(row, roll, sheetName)) return;
    entries.push({
      date: toDateString(pick(row, ['Date'])),
      reason: String(pick(row, ['Reason']) || '').trim(),
      change: toNumber(pick(row, ['Demerit Change', 'Change'])),
      enteredBy: String(pick(row, ['Entered By']) || '').trim(),
      notes: String(pick(row, ['Notes']) || '').trim()
    });
  });

  return {
    summary: summary || { total: 0, rollover: 0, attendance: 0, payment: 0, standards: 0, notes: '' },
    adjustments: entries,
    hasRow: !!summary
  };
}

/**
 * Optional. Returns available:false until a Service_Hours tab exists, so the
 * portal can simply hide the section rather than show a wrong zero.
 * Expected columns: Brother Name | Roll Number | Event | Date | Hours | Confirmed
 */
function getServiceHours(roll, sheetName) {
  if (!getSheet(SHEETS.serviceHours)) return { available: false, confirmed: 0, entries: [] };

  var t = readTable(SHEETS.serviceHours, 'brother name');
  var total = 0;
  var entries = [];

  t.rows.forEach(function (row) {
    if (!rowMatches(row, roll, sheetName)) return;
    var hours = toNumber(pick(row, ['Hours', 'Service Hours']));
    var confirmedRaw = pick(row, ['Confirmed', 'Confirmed By', 'Status']);
    var confirmed = confirmedRaw === true ||
      /^(y|yes|true|confirmed|approved)/i.test(String(confirmedRaw || '').trim());
    if (confirmed) total += hours;
    entries.push({
      event: String(pick(row, ['Event', 'Event Title']) || '').trim(),
      date: toDateString(pick(row, ['Date'])),
      hours: hours,
      confirmed: confirmed
    });
  });

  return { available: true, confirmed: total, entries: entries };
}

/**
 * Sign-up autofill. Given a roll number, return just the matching name — never
 * phone or email. Requires a valid sign-in token, so this is not an open roster
 * dump, but it is deliberately limited to one lookup at a time.
 */
function lookupRoll(idToken, rollNumber) {
  if (!idToken || !uidFromToken(idToken)) throw new Error('Sign in first.');

  var roll = normalizeRoll(rollNumber);
  if (!roll) return { ok: true, found: false };

  var name = rosterIndex().byRoll[roll] || '';

  if (!name && ROLL_SPREADSHEET_ID) {
    var ss = SpreadsheetApp.openById(ROLL_SPREADSHEET_ID);
    var sheet = ROLL_SHEET_NAME ? ss.getSheetByName(ROLL_SHEET_NAME) : ss.getSheets()[0];
    if (sheet) {
      var values = sheet.getDataRange().getValues();
      var headers = values[0].map(function (h) { return String(h || '').trim().toLowerCase(); });
      var rollCol = headers.indexOf('roll number');
      var nameCol = headers.indexOf('name');
      if (rollCol !== -1 && nameCol !== -1) {
        for (var i = 1; i < values.length; i++) {
          if (normalizeRoll(values[i][rollCol]) === roll) {
            name = String(values[i][nameCol] || '').trim();
            break;
          }
        }
      }
    }
  }

  return { ok: true, found: !!name, name: name, rollNumber: roll };
}
