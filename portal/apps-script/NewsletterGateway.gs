/**
 * @OnlyCurrentDoc
 */
/**
 * Newsletter sign-up gateway
 * ==========================
 * A Google Apps Script web app bound to the chapter's "Newsletter Subscribers"
 * Google Sheet. It is a separate Apps Script project from Gateway.gs and
 * RosterGateway.gs, and it is owned and deployed by the chapter Gmail
 * (thetatauusc@gmail.com), because Apps Script sends mail as the account that
 * owns it. Replies go to sotheta@mailbox.sc.edu.
 *
 * WHAT IT DOES
 *   - The public Newsletters page (newsletter.html) sends 'subscribe' when a
 *     visitor enters their email. The address goes into the Subscribers tab.
 *     No email is sent at sign-up, so nobody can use the form to make this
 *     script email someone else.
 *   - Every email has an unsubscribe link:
 *     https://www.thetatauzd.org/newsletter?unsubscribe=<token>
 *     The page asks the person to press Unsubscribe, then sends 'unsubscribe'.
 *     It never unsubscribes on page load, because mail filters open links.
 *   - After an admin posts an issue, they press "Email subscribers" on the
 *     portal's Newsletters admin page. That sends 'notify'. The script emails
 *     each active subscriber who has not had that issue yet, one message per
 *     person, and never more than the account's daily quota. Each send is
 *     written to the Sends tab, so pressing again carries on where it stopped.
 *
 * WHERE THE DATA LIVES
 *   Only in this Sheet. No email address goes into Firebase or the repository.
 *   The Sheet holds personal emails: keep it private and never commit it.
 *
 * HOW ADMINS ARE CHECKED (same as Gateway.gs)
 *   The portal sends the admin's Firebase ID token. This script reads
 *   users/{uid}.json?auth=<token> from the Realtime Database with that token.
 *   The database rules only let a user read their own record, so a bad or
 *   borrowed token is refused by the database itself. role must be 'admin'.
 *
 * SETUP: see portal/apps-script/README.md, "Newsletter sign-up gateway".
 *   1. Create the Sheet while signed in as thetatauusc@gmail.com.
 *   2. Extensions - Apps Script. Paste this file over Code.gs.
 *   3. Run setup once and allow the permissions it asks for.
 *   4. Deploy - New deployment - Web app. Execute as: Me. Who has access: Anyone.
 *   5. Put the /exec URL in js/newsletter-config.js. Check it with ?action=ping.
 *
 * After any change to this file: raise NEWSLETTER_GATEWAY_VERSION, then Deploy -
 * Manage deployments - pencil (Edit) - Version: New version - Deploy. That keeps
 * the same /exec URL, and ?action=ping then shows the new version number, which
 * proves the live copy is current.
 *
 * The pure helpers (no Apps Script services) are tested in node by
 * scripts/newsletter-tests.js. Run it after any change: node scripts/newsletter-tests.js
 */

// -- Config -------------------------------------------------------------------

var NEWSLETTER_GATEWAY_VERSION = 2;

// From portal/js/firebase-config.js (databaseURL).
var FIREBASE_DB_URL = 'https://thetatauzd-2ab25-default-rtdb.firebaseio.com';

var SITE_NEWSLETTER_URL = 'https://www.thetatauzd.org/newsletter';
var FROM_NAME = 'Theta Tau Zeta Delta';
var REPLY_TO = 'sotheta@mailbox.sc.edu';
var SUBJECT_PREFIX = 'New from Theta Tau Zeta Delta: ';

var SUBSCRIBERS_TAB = 'Subscribers';
var SENDS_TAB = 'Sends';
var SUBSCRIBER_HEADERS = ['email', 'name', 'status', 'subscribedAt', 'unsubscribedAt', 'token', 'source'];
var SEND_HEADERS = ['newsletterId', 'email', 'sentAt'];

// Sign-up limits for the whole list, not per person. A bot that gets past the
// honeypot can add at most SIGNUPS_PER_DAY rows a day, fewer than one day of
// Gmail quota. Raise them before a big sign-up push if real sign-ups hit them.
var SIGNUPS_PER_MINUTE = 10;
var SIGNUPS_PER_HOUR = 30;
var SIGNUPS_PER_DAY = 75;      // counted in Script Properties: the cache forgets after 6 hours
var DAY_COUNT_KEY = 'nl:rate:day';
var SAME_EMAIL_SECONDS = 60;   // the same email again within this time is just 'already'

// Sending. Free Gmail allows about 100 recipients a day. MailApp reports the
// exact number left, and the script never goes past it.
var MAX_SENDS_PER_PRESS = 150;
// This many refusals in a row, with nothing sent between them, means Gmail is refusing
// every email (a restricted account, an outage), not that these addresses are bad. The
// press stops and leaves the rest pending. The admin page reads failed with this number.
var MAX_REFUSALS_IN_A_ROW = 5;
var SEND_TIME_BUDGET_MS = 270000;  // stop at 4.5 minutes; Apps Script stops a run at 6
var NOTIFY_FLAG_KEY = 'nl:notify:running';   // a Script Property holding when the run started
var NOTIFY_FLAG_SECONDS = 360;
// A Script Property: when the last press that sent something read the list (ms). Sign-ups
// after it are "new since the last send", including ones made while that press was sending.
var LAST_PLAN_KEY = 'nl:lastPlanAt';

var LOCK_WAIT_MS = 10000;
var MAX_BODY_CHARS = 5000;
var NAME_MAX = 80;
var TITLE_MAX = 150;
var LINK_MAX = 2000;
var ALLOWED_LINK_HOSTS = ['drive.google.com', 'thetatauzd.org', 'www.thetatauzd.org'];

// -- Entry points -------------------------------------------------------------

/** GET is for the ping check only. Everything else must be a POST. */
function doGet(e) {
  var p = (e && e.parameter) || {};
  var action = String(p.action || 'ping');
  if (action !== 'ping') return reply(fail('use-post', 'Send this as a POST request.'));
  return reply(ping());
}

/**
 * The browser posts a JSON body as text/plain (no CORS preflight, which Apps
 * Script cannot answer), the same way portal/js/tracker.js calls Gateway.gs.
 */
function doPost(e) {
  var raw = (e && e.postData && typeof e.postData.contents === 'string') ? e.postData.contents : '';
  return reply(handlePost(raw));
}

function handlePost(raw) {
  try {
    var req = parseBody(raw);
    var action = req.action;
    if (action === 'ping') return ping();
    if (action === 'subscribe') return subscribe(req);
    if (action === 'unsubscribe') return unsubscribe(req);
    if (action === 'notify') return notifySubscribers(req);
    if (action === 'status') return getStatus(req);
    return fail('bad-request', 'Unknown action.');
  } catch (err) {
    return errorReply(err);
  }
}

function ping() {
  return { ok: true, version: NEWSLETTER_GATEWAY_VERSION };
}

function reply(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// -- Actions ------------------------------------------------------------------

/**
 * { action:'subscribe', email, name, website, source }
 * -> { ok:true, status:'subscribed'|'already'|'resubscribed'|'held' }
 *  | { ok:false, code:'invalid-email'|'rate-limited'|'bot', error }
 * 'held': an admin gave that address another status (removed, paused), so the
 * form cannot put it back. Nothing is written.
 */
function subscribe(req) {
  // A filled honeypot gets the normal answer and nothing is written.
  if (honeypotFilled(req.website)) return { ok: true, status: 'subscribed' };

  var email = normalizeEmail(req.email);
  if (!isValidEmail(email)) return fail('invalid-email', 'That email address does not look right.');
  var name = cleanName(req.name);
  if (looksLikeSpam(name)) return fail('bot', 'Please take the link out of your name.');
  var source = cleanSource(req.source);

  var cache = CacheService.getScriptCache();
  if (cache.get(recentKey(email))) return { ok: true, status: 'already' };

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) return fail('rate-limited', 'We are busy. Try again in a minute.');
  var result;
  try {
    var keys = rateKeys(nowMs());
    var counts = { minute: toCount(cache.get(keys.minute)), hour: toCount(cache.get(keys.hour)) };
    if (!rateAllows(counts, { minute: SIGNUPS_PER_MINUTE, hour: SIGNUPS_PER_HOUR })) {
      return fail('rate-limited', 'A lot of people are signing up right now. Try again in a few minutes.');
    }
    var props = PropertiesService.getScriptProperties();
    var day = dayKey(nowMs());
    var today = dayCount(props.getProperty(DAY_COUNT_KEY), day);
    if (today >= SIGNUPS_PER_DAY) {
      return fail('rate-limited', 'A lot of people signed up today. Try again tomorrow, or email ' + REPLY_TO + '.');
    }
    props.setProperty(DAY_COUNT_KEY, day + ':' + (today + 1));
    cache.put(keys.minute, String(counts.minute + 1), 120);
    cache.put(keys.hour, String(counts.hour + 1), 3900);

    var sheet = ensureSheet(SUBSCRIBERS_TAB, SUBSCRIBER_HEADERS);
    var book = parseSubscribers(sheet.getDataRange().getValues());
    var group = book.byEmail[email] || null;
    result = decideSubscribe(group);
    var now = new Date(nowMs());

    if (result === 'subscribed') {
      sheet.appendRow(buildRow(book.cols, book.width, {
        email: email,
        name: name,
        status: 'active',
        subscribedAt: now,
        unsubscribedAt: '',
        token: makeToken(),
        source: source
      }));
    } else if (result === 'resubscribed') {
      var c = book.cols;
      group.rows.forEach(function (rec) {
        if (rec.status === 'active') return;
        setCell(sheet, rec.row, c.status, 'active');
        setCell(sheet, rec.row, c.subscribedAt, now);
        setCell(sheet, rec.row, c.unsubscribedAt, '');
      });
      var first = group.rows[0];
      if (!group.token) setCell(sheet, first.row, c.token, makeToken());
      if (name && !first.name) setCell(sheet, first.row, c.name, name);
    }
    // Save the rows before the lock goes, so the next run never reads the Sheet without them.
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  if (result !== 'held') cache.put(recentKey(email), '1', SAME_EMAIL_SECONDS);
  return { ok: true, status: result };
}

/**
 * { action:'unsubscribe', token }
 * -> { ok:true, status:'unsubscribed'|'already' } | { ok:false, code:'unknown-token', error }
 * Only active rows become 'unsubscribed'. A row an admin gave another status (removed,
 * paused) keeps it, so the form still cannot re-activate it, but gets unsubscribedAt, so a
 * later admin can see the person asked to leave. With no active row the answer is 'already'.
 */
function unsubscribe(req) {
  var token = normalizeToken(req.token);
  var unknown = fail('unknown-token', 'That unsubscribe link is not valid. Email ' + REPLY_TO + ' and we will take you off the list.');
  if (!isValidToken(token)) return unknown;

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) return fail('busy', 'We are busy. Try the link again in a minute.');
  var changed = 0, email = '';
  try {
    var sheet = ensureSheet(SUBSCRIBERS_TAB, SUBSCRIBER_HEADERS);
    var book = parseSubscribers(sheet.getDataRange().getValues());
    var group = book.byToken[token];
    if (!group) return unknown;
    email = group.email;
    var now = new Date(nowMs());
    // Every row for this email, so a duplicate row cannot keep sending.
    group.rows.forEach(function (rec) {
      if (rec.status === 'unsubscribed') return;
      if (rec.status === 'other') {
        setCell(sheet, rec.row, book.cols.unsubscribedAt, now);
        return;
      }
      setCell(sheet, rec.row, book.cols.status, 'unsubscribed');
      setCell(sheet, rec.row, book.cols.unsubscribedAt, now);
      changed++;
    });
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  // Without this, signing up again within a minute would say 'already' and write nothing.
  CacheService.getScriptCache().remove(recentKey(email));
  return { ok: true, status: changed ? 'unsubscribed' : 'already' };
}

/**
 * Admin only. { action:'notify', idToken, newsletterId, title, url }
 * -> { ok:true, sent, total, alreadySent, remaining, quotaLeft, done, failed, badAddresses }
 *
 * total: active subscribers now. alreadySent: of those, how many had this issue
 * before this press. sent: emailed by this press. remaining: still to go.
 * failed: addresses MailApp refused this press (they stay in remaining).
 * badAddresses: the refusals whose error named the address (a bad row). The rest of
 * failed is Gmail refusing everything: after MAX_REFUSALS_IN_A_ROW of those with
 * nothing sent between them, the press stops. Bad rows never stop it.
 */
function notifySubscribers(req) {
  verifyAdmin(req.idToken);

  var newsletterId = String(req.newsletterId === null || req.newsletterId === undefined ? '' : req.newsletterId).trim();
  if (!isValidNewsletterId(newsletterId)) return fail('bad-request', 'Missing or bad newsletterId.');
  var title = cleanTitle(req.title);
  if (!title) return fail('bad-request', 'The newsletter needs a title.');
  var url = typeof req.url === 'string' ? req.url.trim() : '';
  if (!isAllowedLink(url)) {
    return fail('bad-url', 'The link must start with https:// and go to drive.google.com or thetatauzd.org.');
  }

  // The "already sending" flag is a Script Property, not a cache entry: the cache may drop
  // an entry early, and then two presses could email the same people.
  var props = PropertiesService.getScriptProperties();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) return fail('busy', 'The list is busy. Try again in a minute.');
  var plan, sendsSheet, sendCols, sendWidth;
  var flagSet = false;
  try {
    var pressedAt = nowMs();
    if (notifyRunning(props.getProperty(NOTIFY_FLAG_KEY), pressedAt)) {
      return fail('busy', 'Emails are already going out. Wait a few minutes, then press again.');
    }
    props.setProperty(NOTIFY_FLAG_KEY, String(pressedAt));
    flagSet = true;

    var subsSheet = ensureSheet(SUBSCRIBERS_TAB, SUBSCRIBER_HEADERS);
    sendsSheet = ensureSheet(SENDS_TAB, SEND_HEADERS);
    var book = parseSubscribers(subsSheet.getDataRange().getValues());
    fillMissingTokens(subsSheet, book);
    var sends = parseSends(sendsSheet.getDataRange().getValues());
    sendCols = sends.cols;
    sendWidth = sends.width;
    plan = planNotify(book, sends.list, newsletterId, MailApp.getRemainingDailyQuota(), MAX_SENDS_PER_PRESS);
    SpreadsheetApp.flush();   // the tokens fillMissingTokens wrote
  } catch (err) {
    if (flagSet) props.deleteProperty(NOTIFY_FLAG_KEY);
    throw err;
  } finally {
    lock.releaseLock();
  }

  var sent = 0, failed = 0, badAddresses = 0, refusedInARow = 0, start = nowMs();
  try {
    for (var i = 0; i < plan.pending.length; i++) {
      // Only emails that went out count against the limit, so a bad address near the top
      // cannot use up every press. The time budget, quota errors and MAX_REFUSALS_IN_A_ROW
      // still end the loop.
      if (sent >= plan.limit) break;
      var t = nowMs();
      if (t - start > SEND_TIME_BUDGET_MS) break;
      var sub = plan.pending[i];
      var mail = renderEmail({ title: title, url: url, token: sub.token });
      try {
        // One recipient per message, so nobody sees the list.
        MailApp.sendEmail({
          to: sub.email,
          subject: mail.subject,
          body: mail.body,
          htmlBody: mail.htmlBody,
          name: FROM_NAME,
          replyTo: REPLY_TO
        });
      } catch (sendErr) {
        var why = String((sendErr && sendErr.message) || sendErr);
        var said = withoutAddresses(why);
        if (isQuotaError(sendErr)) {
          console.warn('Newsletter: Gmail says the daily limit is used up, at Subscribers row ' + sub.row + ': ' + said);
          break;
        }
        failed++;
        // An error that names the address is about that row. One that does not is Gmail
        // refusing everything, and only those count toward stopping the press.
        if (said !== why) badAddresses++; else refusedInARow++;
        console.warn('Newsletter: could not send to Subscribers row ' + sub.row + ': ' + said);
        if (refusedInARow >= MAX_REFUSALS_IN_A_ROW) {
          console.warn('Newsletter: ' + refusedInARow + ' refused in a row with nothing sent between them. Stopping this press: Gmail is not taking emails.');
          break;
        }
        continue;
      }
      appendWithLock(sendsSheet, buildRow(sendCols, sendWidth, { newsletterId: newsletterId, email: sub.email, sentAt: new Date(t) }));
      sent++;
      refusedInARow = 0;
    }
  } finally {
    // The plan was read at pressedAt, so anyone who signed up after that (even while this
    // press was sending) did not get this issue and counts as new in getStatus.
    if (sent > 0) {
      try {
        props.setProperty(LAST_PLAN_KEY, String(pressedAt));
      } catch (propErr) {
        console.warn('Newsletter: could not save ' + LAST_PLAN_KEY + ': ' + String(propErr && propErr.message || propErr));
      }
    }
    props.deleteProperty(NOTIFY_FLAG_KEY);
  }

  var remaining = plan.pending.length - sent;
  return {
    ok: true,
    sent: sent,
    total: plan.total,
    alreadySent: plan.alreadySent,
    remaining: remaining,
    quotaLeft: MailApp.getRemainingDailyQuota(),
    done: remaining === 0,
    failed: failed,
    badAddresses: badAddresses
  };
}

/**
 * Admin only. { action:'status', idToken }
 * -> { ok:true, active, unsubscribed, newSinceLastSend, quotaLeft, issues:{ <newsletterId>: { sent, total } } }
 * issues[id].sent counts active subscribers who have that issue; total is all active subscribers.
 * newSinceLastSend: active subscribers who signed up after the last press that sent something
 * read the list (LAST_PLAN_KEY), so sign-ups made while that press was sending count too.
 * Without that property it counts from the newest row in Sends, and before the first send it
 * counts everyone with a sign-up date. A sudden jump means bots got past the form.
 */
function getStatus(req) {
  verifyAdmin(req.idToken);
  var props = PropertiesService.getScriptProperties();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) return fail('busy', 'The list is busy. Try again in a minute.');
  var book, sends, lastPlanAt;
  try {
    book = parseSubscribers(ensureSheet(SUBSCRIBERS_TAB, SUBSCRIBER_HEADERS).getDataRange().getValues());
    sends = parseSends(ensureSheet(SENDS_TAB, SEND_HEADERS).getDataRange().getValues());
    lastPlanAt = toCount(props.getProperty(LAST_PLAN_KEY));
  } finally {
    lock.releaseLock();
  }
  var counts = countSubscribers(book);
  return {
    ok: true,
    active: counts.active,
    unsubscribed: counts.unsubscribed,
    newSinceLastSend: countNewSince(book, lastPlanAt || sends.lastSentAt),
    quotaLeft: MailApp.getRemainingDailyQuota(),
    issues: summarizeIssues(book, sends.list)
  };
}

// -- Run these from the Apps Script editor ------------------------------------

/**
 * Run once after pasting the script. It makes the two tabs and asks Google for
 * the permissions the web app needs (the Sheet, sending mail, calling Firebase).
 */
function setup() {
  var subs = ensureSheet(SUBSCRIBERS_TAB, SUBSCRIBER_HEADERS);
  var sends = ensureSheet(SENDS_TAB, SEND_HEADERS);
  var msg = 'Ready. Tabs: ' + subs.getName() + ' and ' + sends.getName() +
            '. Emails left today: ' + MailApp.getRemainingDailyQuota() + '.';
  console.log(msg);
  return msg;
}

/**
 * Sends one sample email to the account that owns the script, so you can see
 * how it looks. It uses one email from today's quota. Its unsubscribe link is a
 * sample and will say the link is not valid.
 */
function sendTestEmail() {
  var me = Session.getEffectiveUser().getEmail();
  var mail = renderEmail({ title: 'Sample issue', url: SITE_NEWSLETTER_URL, token: '0123456789abcdef0123456789abcdef' });
  MailApp.sendEmail({
    to: me,
    subject: '[Test] ' + mail.subject,
    body: mail.body,
    htmlBody: mail.htmlBody,
    name: FROM_NAME,
    replyTo: REPLY_TO
  });
  console.log('Sent a test email to ' + me + '.');
}

// -- Identity -----------------------------------------------------------------

/** Same check as Gateway.gs resolveCaller, plus role 'admin'. Throws a coded error. */
function verifyAdmin(idToken) {
  var token = typeof idToken === 'string' ? idToken.trim() : '';
  if (!token || token.length > 4096) throw codedError('not-signed-in', 'Sign in to the portal first.');
  var uid = uidFromIdToken(token);
  if (!uid || !/^[A-Za-z0-9_-]{1,128}$/.test(uid)) {
    throw codedError('not-signed-in', 'Could not read your sign-in. Sign in again.');
  }

  var res = UrlFetchApp.fetch(
    FIREBASE_DB_URL + '/users/' + encodeURIComponent(uid) + '.json?auth=' + encodeURIComponent(token),
    { muteHttpExceptions: true }
  );
  var code = res.getResponseCode();
  if (code === 401 || code === 403) throw codedError('not-signed-in', 'Your sign-in expired. Reload the page and try again.');
  if (code !== 200) throw codedError('server-error', 'Could not check your account (' + code + '). Try again.');

  var rec = null;
  try { rec = JSON.parse(res.getContentText() || 'null'); } catch (ignored) {}
  if (!rec || rec.role !== 'admin') throw codedError('not-admin', 'Only portal admins can do this.');
  return { uid: uid };
}

/** The uid from the token body. The database read above is what verifies the token. */
function uidFromIdToken(idToken) {
  var parts = String(idToken).split('.');
  if (parts.length < 2) return null;
  try {
    var b64 = parts[1];
    while (b64.length % 4) b64 += '=';
    var payload = Utilities.newBlob(Utilities.base64DecodeWebSafe(b64)).getDataAsString();
    var obj = JSON.parse(payload);
    return obj.user_id || obj.sub || null;
  } catch (err) {
    return null;
  }
}

// -- Sheet helpers (Apps Script services) -------------------------------------

/** The tab, made if missing, with every header in row 1. Missing headers go on the right. */
function ensureSheet(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  var lastCol = sheet.getLastColumn();
  var current = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  var missing = missingHeaders(current, headers);
  if (missing.length) {
    var start = lastCol + 1;
    var extra = start + missing.length - 1 - sheet.getMaxColumns();
    if (extra > 0) sheet.insertColumnsAfter(sheet.getMaxColumns(), extra);
    sheet.getRange(1, start, 1, missing.length).setValues([missing]);
    sheet.getRange(1, 1, 1, start + missing.length - 1).setFontWeight('bold');
    if (sheet.getFrozenRows() < 1) sheet.setFrozenRows(1);
    SpreadsheetApp.flush();   // callers may return before their own flush (an unknown token, say)
  }
  return sheet;
}

/** col is 0-based (from headerMap); rows are 1-based like the Sheet. */
function setCell(sheet, row, col, value) {
  if (col < 0) return;
  sheet.getRange(row, col + 1, 1, 1).setValue(asText(value));
}

/**
 * Only notify writes Sends, and only one notify runs at a time, so it appends even if the lock is slow.
 * The flush saves the row before the lock goes, and so before notify deletes its "already sending" flag.
 */
function appendWithLock(sheet, row) {
  var lock = LockService.getScriptLock();
  var got = lock.tryLock(LOCK_WAIT_MS);
  try {
    sheet.appendRow(row);
    SpreadsheetApp.flush();
  } finally {
    if (got) lock.releaseLock();
  }
}

/** Active subscribers with no unsubscribe token (rows typed in by hand) get one before any email goes out. */
function fillMissingTokens(sheet, book) {
  book.groups.forEach(function (g) {
    if (!g.active || g.token) return;
    var t = makeToken();
    setCell(sheet, g.rows[0].row, book.cols.token, t);
    g.rows[0].token = t;
    g.token = t;
    book.byToken[t] = g;
  });
}

function makeToken(uuidFn) {
  var gen = uuidFn || function () { return Utilities.getUuid(); };
  for (var i = 0; i < 20; i++) {
    var t = String(gen()).toLowerCase().replace(/[^0-9a-f]/g, '');
    // Keep at least one of a-d or f, so the Sheet can never read the token as a number.
    if (t.length >= 32) {
      t = t.slice(0, 32);
      if (/[a-df]/.test(t)) return t;
    }
  }
  throw new Error('Could not make an unsubscribe token.');
}

function nowMs() {
  return Date.now();
}

/** An error whose message is safe to show. Anything else gets a plain message (see errorReply). */
function codedError(code, message) {
  var err = new Error(message);
  err.code = code;
  err.gatewayError = true;
  return err;
}

function errorReply(err) {
  if (err && err.gatewayError && err.code) return fail(err.code, err.message);
  console.error('Newsletter gateway error: ' + String((err && err.stack) || err));
  return fail('server-error', 'Something went wrong. Try again later.');
}

function fail(code, message) {
  return { ok: false, code: code, error: message };
}

// -- Pure helpers (no Apps Script services; tested in node) -------------------

function parseBody(raw) {
  if (!raw) throw codedError('bad-request', 'Empty request.');
  if (raw.length > MAX_BODY_CHARS) throw codedError('bad-request', 'Request too large.');
  var req;
  try { req = JSON.parse(raw); } catch (e) { throw codedError('bad-request', 'The request is not JSON.'); }
  if (!req || typeof req !== 'object' || Array.isArray(req)) throw codedError('bad-request', 'The request is not an object.');
  return req;
}

function normalizeEmail(v) {
  if (v === null || v === undefined || typeof v === 'object') return '';
  return String(v).trim().toLowerCase();
}

/**
 * Practical rules, not the full RFC. Rejects anything MailApp could read as two
 * addresses (commas, semicolons, spaces, angle brackets) and anything a Sheet
 * could read as a formula (the first character must be a letter, digit or _).
 */
var EMAIL_RE = /^[a-z0-9_][a-z0-9_.+'-]*@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,24}|xn--[a-z0-9-]{1,59})$/;

function isValidEmail(email) {
  if (typeof email !== 'string' || email.length > 254) return false;
  if (!EMAIL_RE.test(email)) return false;
  var local = email.slice(0, email.indexOf('@'));
  if (local.length > 64) return false;
  if (local.indexOf('..') !== -1 || local.charAt(local.length - 1) === '.') return false;
  return true;
}

function honeypotFilled(v) {
  if (v === null || v === undefined || v === false) return false;
  return String(v).trim() !== '';
}

/** Control and invisible characters out, spaces collapsed, cut to max. */
function cleanText(v, max) {
  if (v === null || v === undefined || typeof v === 'object') return '';
  var s = String(v)
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > max) s = s.slice(0, max).trim();
  return s;
}

/** A name never starts with = + - or @, so a CSV export of the Sheet cannot run it as a formula. */
function cleanName(v) {
  return cleanText(v, NAME_MAX).replace(/^[=+\-@\s]+/, '');
}

function cleanTitle(v) {
  return cleanText(v, TITLE_MAX);
}

/** Bots put links in name fields. People do not. */
function looksLikeSpam(name) {
  return /https?:|www\.|[<>]|\[\/?url/i.test(String(name || ''));
}

function cleanSource(v) {
  var s = String(v === null || v === undefined ? '' : v).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
  return /^[a-z]/.test(s) ? s : 'web';
}

function isValidToken(t) {
  return typeof t === 'string' && /^[0-9a-f]{32}$/.test(t);
}

function normalizeToken(v) {
  if (v === null || v === undefined || typeof v === 'object') return '';
  return readText(v).toLowerCase();
}

/** Firebase push keys, like the ids under newsletters/ in the database. */
function isValidNewsletterId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

/** https only, and the host must be exactly one on ALLOWED_LINK_HOSTS. No user@ part, no other port. */
function isAllowedLink(url) {
  if (typeof url !== 'string' || !url || url.length > LINK_MAX) return false;
  if (/[\s"'<>\\`\u0000-\u001f\u007f]/.test(url)) return false;
  var m = /^https:\/\/([^\/?#]+)(?:[\/?#]|$)/i.exec(url);
  if (!m) return false;
  var authority = m[1];
  if (authority.indexOf('@') !== -1) return false;
  var host = authority.toLowerCase().replace(/:443$/, '');
  return ALLOWED_LINK_HOSTS.indexOf(host) !== -1;
}

function unsubscribeLink(token) {
  return SITE_NEWSLETTER_URL + '?unsubscribe=' + encodeURIComponent(token);
}

/**
 * A Sheet reads a cell that starts with = + - or @ as a formula. A leading
 * apostrophe keeps it as text, and the Sheet does not keep the apostrophe.
 * Firebase push keys start with -, so newsletterIds need this.
 */
function asText(v) {
  if (typeof v !== 'string') return v;
  return /^[=+\-@]/.test(v) ? "'" + v : v;
}

function readText(v) {
  if (v === null || v === undefined) return '';
  var s = String(v);
  if (/^'[=+\-@]/.test(s)) s = s.slice(1);
  return s.trim();
}

/** 'subscribedAt', 'Subscribed At' and 'subscribed_at' are the same header. */
function headerKey(h) {
  return String(h === null || h === undefined ? '' : h).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function headerMap(headerRow, names) {
  var keys = (headerRow || []).map(headerKey);
  var cols = {};
  names.forEach(function (n) { cols[n] = keys.indexOf(headerKey(n)); });
  return cols;
}

function missingHeaders(current, names) {
  var keys = (current || []).map(headerKey);
  return names.filter(function (n) { return keys.indexOf(headerKey(n)) === -1; });
}

/** A row in the Sheet's own column order. */
function buildRow(cols, width, rec) {
  var w = width;
  Object.keys(cols).forEach(function (k) { if (cols[k] + 1 > w) w = cols[k] + 1; });
  var row = [];
  for (var i = 0; i < w; i++) row.push('');
  Object.keys(rec).forEach(function (k) {
    if (cols[k] === undefined || cols[k] < 0) return;
    row[cols[k]] = asText(rec[k]);
  });
  return row;
}

/** Blank counts as active (rows typed in by hand). Anything but active or blank gets no email. */
function statusOf(v) {
  var s = readText(v).toLowerCase();
  if (!s || s === 'active' || s === 'subscribed') return 'active';
  if (s === 'unsubscribed') return 'unsubscribed';
  return 'other';
}

/**
 * The Subscribers tab as groups, one per email. If an email has more than one
 * row (a hand edit), it is active only when every one of its rows is active.
 */
function parseSubscribers(values) {
  values = values || [];
  var cols = headerMap(values[0] || [], SUBSCRIBER_HEADERS);
  if (cols.email < 0) throw codedError('server-error', 'The Subscribers tab needs an email column in row 1.');
  var width = Math.max((values[0] || []).length, SUBSCRIBER_HEADERS.length);
  var groups = [], byEmail = {}, byToken = {};
  function cell(r, k) { return cols[k] >= 0 ? r[cols[k]] : ''; }
  for (var i = 1; i < values.length; i++) {
    var r = values[i] || [];
    var email = normalizeEmail(readText(cell(r, 'email')));
    if (!email) continue;
    var token = normalizeToken(cell(r, 'token'));
    var rec = {
      row: i + 1,
      email: email,
      name: readText(cell(r, 'name')),
      status: statusOf(cell(r, 'status')),
      token: isValidToken(token) ? token : '',
      subscribedAt: timeOf(cell(r, 'subscribedAt'))
    };
    var g = byEmail[email];
    if (!g) {
      g = { email: email, rows: [], active: true, token: '', subscribedAt: 0 };
      byEmail[email] = g;
      groups.push(g);
    }
    if (rec.subscribedAt > g.subscribedAt) g.subscribedAt = rec.subscribedAt;
    // A token copied onto another person's row would let one link unsubscribe them both.
    // The later row loses it and gets a new one before the next send.
    if (rec.token && byToken[rec.token] && byToken[rec.token] !== g) rec.token = '';
    g.rows.push(rec);
    if (rec.status !== 'active') g.active = false;
    if (rec.token) {
      if (!g.token) g.token = rec.token;
      if (!byToken[rec.token]) byToken[rec.token] = g;
    }
  }
  // A bad address in the Sheet never gets mail.
  groups.forEach(function (g) { if (!isValidEmail(g.email)) g.active = false; });
  return { cols: cols, width: width, groups: groups, byEmail: byEmail, byToken: byToken };
}

function parseSends(values) {
  values = values || [];
  var cols = headerMap(values[0] || [], SEND_HEADERS);
  var width = Math.max((values[0] || []).length, SEND_HEADERS.length);
  var list = [], lastSentAt = 0;
  if (cols.newsletterId >= 0 && cols.email >= 0) {
    for (var i = 1; i < values.length; i++) {
      var r = values[i] || [];
      var id = readText(r[cols.newsletterId]);
      var email = normalizeEmail(readText(r[cols.email]));
      if (id && email) list.push({ newsletterId: id, email: email });
      var at = cols.sentAt >= 0 ? timeOf(r[cols.sentAt]) : 0;
      if (at > lastSentAt) lastSentAt = at;
    }
  }
  return { cols: cols, width: width, list: list, lastSentAt: lastSentAt };
}

/**
 * null (no row) -> subscribed; a row an admin set to another status (removed, paused) -> held;
 * every row active -> already; otherwise (unsubscribed) -> resubscribed.
 */
function decideSubscribe(group) {
  if (!group || !group.rows || !group.rows.length) return 'subscribed';
  for (var i = 0; i < group.rows.length; i++) {
    if (group.rows[i].status === 'other') return 'held';
  }
  return group.active ? 'already' : 'resubscribed';
}

/** Active subscribers who signed up after lastSentAt (ms). Rows typed in with no date do not count. */
function countNewSince(book, lastSentAt) {
  var n = 0;
  book.groups.forEach(function (g) { if (g.active && g.subscribedAt > (lastSentAt || 0)) n++; });
  return n;
}

function countSubscribers(book) {
  var active = 0, unsubscribed = 0;
  book.groups.forEach(function (g) { if (g.active) active++; else unsubscribed++; });
  return { active: active, unsubscribed: unsubscribed };
}

/**
 * Who gets this issue on this press. pending is every active subscriber who has
 * not had it yet, in Sheet order; limit is how many may be emailed now.
 */
function planNotify(book, sends, newsletterId, quota, maxPerPress) {
  var had = {};
  (sends || []).forEach(function (s) { if (s.newsletterId === newsletterId) had[s.email] = true; });
  var active = book.groups.filter(function (g) { return g.active; });
  var pending = [], alreadySent = 0;
  active.forEach(function (g) {
    if (had[g.email]) { alreadySent++; return; }
    pending.push({ email: g.email, token: g.token, row: g.rows[0].row });
  });
  var q = Math.floor(Number(quota));
  if (!isFinite(q) || q < 0) q = 0;
  return {
    total: active.length,
    alreadySent: alreadySent,
    pending: pending,
    limit: Math.max(0, Math.min(q, maxPerPress))
  };
}

function summarizeIssues(book, sends) {
  var active = {}, total = 0;
  book.groups.forEach(function (g) { if (g.active) { active[g.email] = true; total++; } });
  var seen = {}, issues = {};
  (sends || []).forEach(function (s) {
    if (!issues[s.newsletterId]) issues[s.newsletterId] = { sent: 0, total: total };
    var key = s.newsletterId + '\n' + s.email;
    if (seen[key] || !active[s.email]) return;
    seen[key] = true;
    issues[s.newsletterId].sent++;
  });
  return issues;
}

function rateKeys(now) {
  return {
    minute: 'nl:rate:m:' + Math.floor(now / 60000),
    hour: 'nl:rate:h:' + Math.floor(now / 3600000)
  };
}

function rateAllows(counts, limits) {
  return counts.minute < limits.minute && counts.hour < limits.hour;
}

/** The UTC day number, which is the key for the daily sign-up count. */
function dayKey(now) {
  return String(Math.floor(now / 86400000));
}

/** The saved 'day:count' value -> today's count (0 when it is from another day or unreadable). */
function dayCount(saved, day) {
  var parts = String(saved === null || saved === undefined ? '' : saved).split(':');
  return parts[0] === day ? toCount(parts[1]) : 0;
}

/** True while another notify run holds the flag. A flag older than NOTIFY_FLAG_SECONDS is from a run that died. */
function notifyRunning(saved, now) {
  var started = parseInt(saved, 10);
  return isFinite(started) && started > 0 && now - started < NOTIFY_FLAG_SECONDS * 1000;
}

/** A Sheet cell as ms since 1970: Dates from getValues(), or date text. 0 when it is not a date. */
function timeOf(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') {
    var t = v.getTime();
    return isFinite(t) ? t : 0;
  }
  if (typeof v === 'string' && v.trim()) {
    var p = Date.parse(v);
    return isFinite(p) ? p : 0;
  }
  return 0;
}

function toCount(v) {
  var n = parseInt(v, 10);
  return isFinite(n) && n > 0 ? n : 0;
}

function recentKey(email) {
  return ('nl:recent:' + email).slice(0, 250);
}

/**
 * MailApp errors quote the address. The log only needs the row number. An apostrophe can
 * be part of an address (EMAIL_RE allows it), so it is not treated as an edge here.
 */
function withoutAddresses(text) {
  return String(text || '').replace(/[^\s@<>",;:]+@[^\s@<>",;:]+/g, '<address>');
}

/**
 * True when MailApp says the daily limit is used up. The address is taken out first, so a
 * refused address such as quotas@example.com is not read as a quota error.
 */
function isQuotaError(err) {
  return /too many times|quota|limit exceeded/i.test(withoutAddresses(String((err && err.message) || err || '')));
}

function escapeHtml(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The email for one subscriber. It never uses the name from the sign-up form,
 * because anyone can type a name next to someone else's address.
 */
function renderEmail(opts) {
  var title = cleanTitle(opts.title);
  var url = String(opts.url || '');
  var unsub = unsubscribeLink(opts.token);
  var subject = SUBJECT_PREFIX + title;

  var body = [
    'A new Theta Tau Zeta Delta newsletter is out.',
    '',
    title,
    'Read it here: ' + url,
    '',
    'See every issue: ' + SITE_NEWSLETTER_URL,
    '',
    'You get this email because you signed up for newsletter emails on thetatauzd.org.',
    'Unsubscribe: ' + unsub,
    'Questions? Reply to this email.',
    '',
    'Theta Tau, Zeta Delta chapter',
    'University of South Carolina'
  ].join('\n');

  var maroon = '#8B0000';
  var htmlBody =
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:#1a1a1a;max-width:560px;margin:0 auto;padding:24px;">' +
      '<p style="margin:0 0 4px;font-size:13px;font-weight:bold;letter-spacing:0.08em;text-transform:uppercase;color:' + maroon + ';">Theta Tau Zeta Delta</p>' +
      '<h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:#1a1a1a;">A new newsletter is out</h1>' +
      '<p style="margin:0 0 20px;">' + escapeHtml(title) + '</p>' +
      '<p style="margin:0 0 24px;"><a href="' + escapeHtml(url) + '" style="display:inline-block;background:' + maroon + ';color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 20px;border-radius:6px;">Read the newsletter</a></p>' +
      '<p style="margin:0 0 24px;">See every issue at <a href="' + escapeHtml(SITE_NEWSLETTER_URL) + '" style="color:' + maroon + ';">thetatauzd.org/newsletter</a>.</p>' +
      '<hr style="border:none;border-top:1px solid #e5e5e5;margin:24px 0;">' +
      '<p style="margin:0 0 8px;font-size:13px;color:#555555;">You get this email because you signed up for newsletter emails on thetatauzd.org. ' +
        '<a href="' + escapeHtml(unsub) + '" style="color:#555555;">Unsubscribe</a> any time. Questions? Reply to this email.</p>' +
      '<p style="margin:0;font-size:13px;color:#555555;">Theta Tau, Zeta Delta chapter. University of South Carolina.</p>' +
    '</div>';

  return { subject: subject, body: body, htmlBody: htmlBody };
}
