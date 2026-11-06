#!/usr/bin/env node
/**
 * Tests portal/apps-script/NewsletterGateway.gs in node. The script is loaded in a vm sandbox with
 * in-memory stand-ins for SpreadsheetApp, MailApp, LockService, CacheService, UrlFetchApp, Utilities,
 * ContentService and Session, so nothing touches Google, Firebase or a real Sheet.
 *
 * The fake Sheet behaves like a real one where it matters: a cell that starts with = + - or @ turns into
 * '#ERROR!' (a formula) unless it starts with an apostrophe, which is dropped, and text that looks like a
 * number becomes a number. So a test fails if the script ever writes a value a Sheet would mangle.
 *
 * Addresses are invented (example.com). Usage: node scripts/newsletter-tests.js
 */
'use strict';
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var crypto = require('crypto');

var root = path.join(__dirname, '..');
var GS_PATH = 'portal/apps-script/NewsletterGateway.gs';
var src = fs.readFileSync(path.join(root, GS_PATH), 'utf8');

var pass = 0, failCount = 0, lines = [];
function ok(cond, label) {
  if (cond) { pass++; lines.push('OK   ' + label); } else { failCount++; lines.push('FAIL ' + label); }
}
function eq(actual, expected, label) {
  var a = JSON.stringify(actual), e = JSON.stringify(expected);
  ok(a === e, label + (a === e ? '' : '  (got ' + a + ', expected ' + e + ')'));
}
function section(name) { lines.push(''); lines.push('# ' + name); }
function isDate(v) { return Object.prototype.toString.call(v) === '[object Date]'; }

// -- Fake Google services --------------------------------------------------------

/** What a Sheet does with a written value. */
function coerce(v) {
  if (typeof v !== 'string') return v;
  if (v.charAt(0) === "'") return v.slice(1);
  if (/^[=+\-@]/.test(v)) return '#ERROR!';
  if (/^\d+(\.\d+)?(e[+-]?\d+)?$/i.test(v)) return Number(v);
  return v;
}

function FakeSheet(name) {
  this.name = name;
  this.rows = [];
  this.maxCols = 26;
  this.frozen = 0;
  this.boldTo = 0;
}
FakeSheet.prototype.getName = function () { return this.name; };
FakeSheet.prototype.getLastRow = function () {
  for (var r = this.rows.length - 1; r >= 0; r--) {
    if (this.rows[r].some(function (v) { return v !== '' && v !== null && v !== undefined; })) return r + 1;
  }
  return 0;
};
FakeSheet.prototype.getLastColumn = function () {
  var last = 0;
  this.rows.forEach(function (row) {
    for (var c = row.length - 1; c >= 0; c--) {
      if (row[c] !== '' && row[c] !== null && row[c] !== undefined) { if (c + 1 > last) last = c + 1; break; }
    }
  });
  return last;
};
FakeSheet.prototype.getMaxColumns = function () { return this.maxCols; };
FakeSheet.prototype.insertColumnsAfter = function (after, n) { this.maxCols += n; };
FakeSheet.prototype.getFrozenRows = function () { return this.frozen; };
FakeSheet.prototype.setFrozenRows = function (n) { this.frozen = n; };
FakeSheet.prototype.cell = function (r, c) { var row = this.rows[r - 1]; return row && row[c - 1] !== undefined ? row[c - 1] : ''; };
FakeSheet.prototype.put = function (r, c, v) {
  if (c > this.maxCols) throw new Error('The coordinates of the range are outside the dimensions of the sheet.');
  while (this.rows.length < r) this.rows.push([]);
  var row = this.rows[r - 1];
  while (row.length < c) row.push('');
  row[c - 1] = coerce(v);
  if (this.onWrite) this.onWrite();
};
FakeSheet.prototype.getRange = function (r, c, nr, nc) {
  var sheet = this;
  nr = nr || 1; nc = nc || 1;
  if (r < 1 || c < 1) throw new Error('Bad range');
  return {
    getValues: function () {
      var out = [];
      for (var i = 0; i < nr; i++) {
        var row = [];
        for (var j = 0; j < nc; j++) row.push(sheet.cell(r + i, c + j));
        out.push(row);
      }
      return out;
    },
    setValues: function (vals) {
      if (vals.length !== nr || vals.some(function (row) { return row.length !== nc; })) throw new Error('The number of rows or columns does not match the range.');
      for (var i = 0; i < nr; i++) for (var j = 0; j < nc; j++) sheet.put(r + i, c + j, vals[i][j]);
      return this;
    },
    setValue: function (v) {
      if (nr !== 1 || nc !== 1) throw new Error('setValue on a range bigger than one cell');
      sheet.put(r, c, v);
      return this;
    },
    setFontWeight: function () { sheet.boldTo = c + nc - 1; return this; }
  };
};
FakeSheet.prototype.getDataRange = function () {
  var lr = this.getLastRow(), lc = this.getLastColumn();
  if (!lr || !lc) return { getValues: function () { return [['']]; } };
  return this.getRange(1, 1, lr, lc);
};
FakeSheet.prototype.appendRow = function (arr) {
  var r = this.getLastRow() + 1;
  for (var c = 0; c < arr.length; c++) this.put(r, c + 1, arr[c]);
  if (!arr.length) this.rows.push([]);
  return this;
};
/** Rows below the header as objects keyed by the header text. */
FakeSheet.prototype.records = function () {
  var head = this.rows[0] || [];
  return this.rows.slice(1).map(function (row) {
    var o = {};
    head.forEach(function (h, i) { o[h] = row[i] === undefined ? '' : row[i]; });
    return o;
  });
};

function makeJwt(payload) {
  return 'eyJhbGciOiJSUzI1NiJ9.' + Buffer.from(JSON.stringify(payload)).toString('base64url') + '.c2ln';
}

function makeWorld() {
  var clock = { now: Date.UTC(2026, 10, 3, 15, 0, 0) };
  var sheets = {};
  var ss = {
    broken: false,
    getSheetByName: function (n) { if (ss.broken) throw new Error('Spreadsheet exploded'); return sheets[n] || null; },
    insertSheet: function (n) {
      if (sheets[n]) throw new Error('exists');
      sheets[n] = new FakeSheet(n);
      sheets[n].onWrite = function () { lockState.dirty = true; };   // a write not saved by flush yet
      return sheets[n];
    },
    getSheets: function () { return Object.keys(sheets).map(function (k) { return sheets[k]; }); }
  };
  var mail = {
    quota: 100,
    hardLimit: Infinity,      // MailApp refuses after this many, even if the quota said more
    failFor: {},
    sent: [],
    getRemainingDailyQuota: function () { return mail.quota; },
    sendEmail: function (msg) {
      if (!msg || typeof msg !== 'object') throw new Error('sendEmail expects one message object');
      if (mail.quota <= 0 || mail.sent.length >= mail.hardLimit) throw new Error('Service invoked too many times for one day: email.');
      if (mail.failFor[msg.to]) throw new Error('Invalid email: ' + msg.to);
      mail.sent.push(JSON.parse(JSON.stringify(msg)));
      mail.quota--;
    }
  };
  var cacheStore = {};
  var cache = {
    get: function (k) {
      var e = cacheStore[k];
      if (!e) return null;
      if (e.exp <= clock.now) { delete cacheStore[k]; return null; }
      return e.v;
    },
    put: function (k, v, ttl) {
      if (typeof v !== 'string') throw new Error('Cache values must be strings');
      if (k.length > 250) throw new Error('Cache key too long');
      if (ttl > 21600) throw new Error('Cache TTL too long');
      cacheStore[k] = { v: v, exp: clock.now + (ttl || 600) * 1000 };
    },
    remove: function (k) { delete cacheStore[k]; }
  };
  var propStore = {};
  var props = {
    getProperty: function (k) { return Object.prototype.hasOwnProperty.call(propStore, k) ? propStore[k] : null; },
    setProperty: function (k, v) {
      if (typeof v !== 'string') throw new Error('Property values must be strings');
      propStore[k] = v;
      return props;
    },
    deleteProperty: function (k) {
      // Every Sends row must be saved before the "already sending" flag goes.
      if (k === 'nl:notify:running' && lockState.dirty) lockState.unsavedAtUnflag++;
      delete propStore[k];
      return props;
    }
  };
  // dirty: a Sheet write since the last flush. unsaved: locks released with a write not saved yet.
  // Taking the lock clears dirty, so a test's own hand edits between calls are not blamed on the script.
  var lockState = { held: 0, fail: false, taken: 0, dirty: false, flushes: 0, unsaved: 0, unsavedAtUnflag: 0 };
  function took() { if (!lockState.held) lockState.dirty = false; lockState.held++; lockState.taken++; }
  var lockService = {
    getScriptLock: function () {
      var mine = false;
      return {
        tryLock: function () { if (lockState.fail) return false; took(); mine = true; return true; },
        waitLock: function () { if (lockState.fail) throw new Error('Lock timeout'); took(); mine = true; },
        releaseLock: function () {
          if (!mine) return;
          if (lockState.dirty) lockState.unsaved++;
          lockState.held--;
          mine = false;
        },
        hasLock: function () { return mine; }
      };
    }
  };
  var users = {};   // uid -> { token, record }
  var fetches = [];
  var urlFetch = {
    fetch: function (url, opts) {
      fetches.push({ url: url, opts: opts });
      var m = /^https:\/\/thetatauzd-2ab25-default-rtdb\.firebaseio\.com\/users\/([^.\/?]+)\.json\?auth=(.+)$/.exec(url);
      var code = 401, body = '{"error":"Permission denied"}';
      if (m) {
        var u = users[decodeURIComponent(m[1])];
        if (u && u.token === decodeURIComponent(m[2])) { code = 200; body = JSON.stringify(u.record); }
      } else {
        code = 404; body = 'not found';
      }
      return { getResponseCode: function () { return code; }, getContentText: function () { return body; } };
    }
  };
  var logs = [];
  var quietConsole = {
    log: function () { logs.push(['log'].concat([].slice.call(arguments)).join(' ')); },
    warn: function () { logs.push(['warn'].concat([].slice.call(arguments)).join(' ')); },
    error: function () { logs.push(['error'].concat([].slice.call(arguments)).join(' ')); }
  };
  var sandbox = {
    console: quietConsole,
    Date: Date,
    SpreadsheetApp: {
      getActiveSpreadsheet: function () { return ss; },
      flush: function () { lockState.dirty = false; lockState.flushes++; }
    },
    MailApp: mail,
    CacheService: { getScriptCache: function () { return cache; } },
    PropertiesService: { getScriptProperties: function () { return props; } },
    LockService: lockService,
    UrlFetchApp: urlFetch,
    Utilities: {
      getUuid: function () { return crypto.randomUUID(); },
      base64DecodeWebSafe: function (s) {
        return Array.prototype.slice.call(Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
      },
      newBlob: function (bytes) { return { getDataAsString: function () { return Buffer.from(bytes).toString('utf8'); } }; }
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: function (s) {
        return { content: s, mime: null, setMimeType: function (m) { this.mime = m; return this; }, getContent: function () { return this.content; } };
      }
    },
    Session: { getEffectiveUser: function () { return { getEmail: function () { return 'owner@example.com'; } }; } }
  };
  var ctx = vm.createContext(sandbox);
  vm.runInContext(src, ctx, { filename: GS_PATH });
  ctx.nowMs = function () { return clock.now; };

  function admin(uid, role) {
    var token = makeJwt({ user_id: uid, sub: uid, aud: 'thetatauzd-2ab25' });
    users[uid] = { token: token, record: { name: 'Test ' + uid, role: role || 'admin', email: uid + '@example.com' } };
    return token;
  }
  function post(obj) {
    var out = ctx.doPost({ postData: { contents: typeof obj === 'string' ? obj : JSON.stringify(obj) } });
    if (out.mime !== 'application/json') throw new Error('Reply is not JSON');
    return JSON.parse(out.getContent());
  }
  function get(params) {
    return JSON.parse(ctx.doGet({ parameter: params || {} }).getContent());
  }
  return {
    ctx: ctx, clock: clock, sheets: sheets, ss: ss, mail: mail, cacheStore: cacheStore, propStore: propStore, lockState: lockState,
    users: users, fetches: fetches, logs: logs, admin: admin, post: post, get: get
  };
}

function sub(w, email, extra) {
  var body = { action: 'subscribe', email: email, name: '', website: '', source: 'newsletter-page' };
  Object.keys(extra || {}).forEach(function (k) { body[k] = extra[k]; });
  return w.post(body);
}
function later(w, seconds) { w.clock.now += seconds * 1000; }
/** The lock checks for one world: all released, and every Sheet write saved before its lock went. */
function locksClean(w, label) {
  eq(w.lockState.held, 0, label + ': every lock released');
  eq(w.lockState.unsaved, 0, label + ': every Sheet write saved (flush) before its lock was released');
  eq(w.lockState.unsavedAtUnflag, 0, label + ': every Sends row saved before the sending flag was deleted');
}
function tokenOf(w, email) {
  var rec = w.sheets.Subscribers.records().filter(function (r) { return r.email === email; })[0];
  return rec ? rec.token : null;
}

// -- Pure helpers -----------------------------------------------------------------

var w0 = makeWorld();
var G = w0.ctx;

section('Config');
var fbConfig = fs.readFileSync(path.join(root, 'portal/js/firebase-config.js'), 'utf8');
var dbUrl = (/databaseURL:\s*'([^']+)'/.exec(fbConfig) || [])[1];
eq(G.FIREBASE_DB_URL, dbUrl, 'FIREBASE_DB_URL matches databaseURL in portal/js/firebase-config.js');
eq(G.REPLY_TO, 'sotheta@mailbox.sc.edu', 'replies go to the chapter USC mailbox');
eq(G.FROM_NAME, 'Theta Tau Zeta Delta', 'display name');
eq(G.SITE_NEWSLETTER_URL + '?unsubscribe=abc', 'https://www.thetatauzd.org/newsletter?unsubscribe=abc', 'unsubscribe page is the public Newsletters page');
eq([].slice.call(G.SUBSCRIBER_HEADERS), ['email', 'name', 'status', 'subscribedAt', 'unsubscribedAt', 'token', 'source'], 'Subscribers headers');
eq([].slice.call(G.SEND_HEADERS), ['newsletterId', 'email', 'sentAt'], 'Sends headers');

section('Email addresses');
eq(G.normalizeEmail('  Alex.Rivera@Example.COM '), 'alex.rivera@example.com', 'trimmed and lowercased');
eq(G.normalizeEmail(null), '', 'null is empty');
eq(G.normalizeEmail({ a: 1 }), '', 'an object is empty');
['alex@example.com', 'a.b+news@mail.example.co', "o'neil@example.org", 'first_last@sub.example.edu',
 'x9@example.museum', 'pat@xn--bcher-kva.example', 'pat-lee@example.io'].forEach(function (e) {
  ok(G.isValidEmail(e), 'valid: ' + e);
});
var longLocal = new Array(66).join('a') + '@example.com';
var longAll = 'a@' + new Array(60).join('abcd.') + 'example.com';
['', 'alex', 'alex@', '@example.com', 'alex@example', 'alex@@example.com', 'a@b@example.com',
 'alex@example.com, eve@example.com', 'alex@example.com;eve@example.com', 'alex @example.com',
 '<alex@example.com>', 'Alex <alex@example.com>', '.alex@example.com', 'alex.@example.com', 'al..ex@example.com',
 '=cmd@example.com', '+1@example.com', '-x@example.com', 'alex@-example.com', 'alex@example-.com',
 'alex@[127.0.0.1]', 'alex@example.c', 'alex@example.com\nbcc:eve@example.com', 'alex@exa_mple.com',
 'ALEX@EXAMPLE.COM', longLocal, longAll].forEach(function (e) {
  ok(!G.isValidEmail(e), 'invalid: ' + JSON.stringify(e.length > 60 ? e.slice(0, 40) + '...' : e));
});
ok(!G.isValidEmail(12345), 'a number is not an email');

section('Honeypot, names, source');
ok(!G.honeypotFilled(''), 'empty honeypot is fine');
ok(!G.honeypotFilled('   '), 'spaces-only honeypot is fine');
ok(!G.honeypotFilled(undefined) && !G.honeypotFilled(null), 'missing honeypot is fine');
ok(G.honeypotFilled('https://spam.example'), 'filled honeypot is caught');
ok(G.honeypotFilled(0), 'a number in the honeypot is caught');
eq(G.cleanName('  Pat    Lee  '), 'Pat Lee', 'name spaces collapsed');
eq(G.cleanName('Pat\u0000\n\tLee\u200b'), 'Pat Lee', 'control and invisible characters removed');
eq(G.cleanName(new Array(101).join('x')).length, 80, 'name cut to 80');
eq(G.cleanName({ toString: 1 }), '', 'object name is empty');
eq(G.cleanName(undefined), '', 'missing name is empty');
eq(G.cleanName(' =HYPERLINK("x") '), 'HYPERLINK("x")', 'a leading = is dropped, so a CSV export cannot run it');
eq(G.cleanName('+-@ Pat'), 'Pat', 'leading + - @ dropped');
eq(G.cleanName('Mary-Kate'), 'Mary-Kate', 'a - inside a name stays');
ok(G.looksLikeSpam('Visit https://spam.example'), 'link in name is spam');
ok(G.looksLikeSpam('www.spam.example'), 'www in name is spam');
ok(G.looksLikeSpam('<b>Pat</b>'), 'markup in name is spam');
ok(G.looksLikeSpam('[url=x]'), 'bbcode in name is spam');
ok(!G.looksLikeSpam("D'Angelo Smith-Jones Jr."), 'a real name is not spam');
ok(!G.looksLikeSpam(''), 'no name is not spam');
eq(G.cleanSource('newsletter-page'), 'newsletter-page', 'source kept');
eq(G.cleanSource(''), 'web', 'missing source is web');
eq(G.cleanSource('123'), 'web', 'source must start with a letter');
eq(G.cleanSource('=HACK()'), 'hack', 'source stripped to letters, digits and dashes');

section('Tokens');
var toks = {}, allGood = true, allLettered = true;
for (var i = 0; i < 1000; i++) {
  var t = G.makeToken();
  if (!/^[0-9a-f]{32}$/.test(t)) allGood = false;
  if (!/[a-df]/.test(t)) allLettered = false;
  toks[t] = true;
}
ok(allGood, 'tokens are 32 lowercase hex characters');
ok(allLettered, 'every token has a letter other than e, so a Sheet never reads it as a number');
eq(Object.keys(toks).length, 1000, '1000 tokens, no repeats');
var feed = ['12345678-1234-4234-8234-123456789012', 'ABCDEF01-2345-4678-9abc-def012345678'];
eq(G.makeToken(function () { return feed.shift(); }), 'abcdef0123454678' + '9abcdef012345678', 'an all-digit uuid is skipped');
var threw = false;
try { G.makeToken(function () { return '11111111-1111-4111-8111-111111111111'; }); } catch (e) { threw = true; }
ok(threw, 'gives up rather than loop forever');
ok(G.isValidToken('0123456789abcdef0123456789abcdef'), 'valid token');
ok(!G.isValidToken('0123456789ABCDEF0123456789ABCDEF'), 'uppercase is not valid until normalised');
eq(G.normalizeToken(' 0123456789ABCDEF0123456789ABCDEF '), '0123456789abcdef0123456789abcdef', 'normalizeToken trims and lowercases');
ok(!G.isValidToken('0123456789abcdef0123456789abcde'), '31 characters is not valid');
ok(!G.isValidToken('0123456789abcdef0123456789abcdeg'), 'non-hex is not valid');
ok(!G.isValidToken(null) && !G.isValidToken(123), 'non-strings are not valid');
eq(G.normalizeToken({}), '', 'object token is empty');

section('Links in notify');
['https://drive.google.com/file/d/1AbC_dEf-123/view?usp=sharing', 'https://DRIVE.google.com/file/d/x/view',
 'https://www.thetatauzd.org/newsletter', 'https://thetatauzd.org/newsletter#latest', 'https://drive.google.com:443/x',
 'https://drive.google.com'].forEach(function (u) {
  ok(G.isAllowedLink(u), 'allowed: ' + u);
});
['http://drive.google.com/file/d/x', 'javascript:alert(1)', 'https://drive.google.com.evil.example/x',
 'https://evil.example/drive.google.com', 'https://drive.google.com@evil.example/x', 'https://user:pw@drive.google.com/x',
 'https://docs.google.com/document/d/x', 'https://drive.google.com:8443/x', 'https://drive.google.com/x y',
 'https://drive.google.com/x"onmouseover="a', "https://drive.google.com/x'", 'https://drive.google.com/<x>',
 '//drive.google.com/x', 'https:/drive.google.com/x', '', 'https://thetatauzd.org.evil.example/',
 'https://drive.google.com/' + new Array(2001).join('x')].forEach(function (u) {
  ok(!G.isAllowedLink(u), 'refused: ' + JSON.stringify(u.length > 60 ? u.slice(0, 40) + '...' : u));
});
ok(!G.isAllowedLink(null) && !G.isAllowedLink({}), 'non-strings refused');
ok(G.isValidNewsletterId('-OAbc123_def-XYZ'), 'Firebase push key is a valid newsletterId');
ok(!G.isValidNewsletterId(''), 'empty newsletterId refused');
ok(!G.isValidNewsletterId('a/b') && !G.isValidNewsletterId('a.b') && !G.isValidNewsletterId('a b'), 'path characters refused');
ok(!G.isValidNewsletterId(new Array(66).join('a')), '65 characters refused');
ok(!G.isValidNewsletterId(42), 'number refused');

section('Sheet cells');
eq(G.asText('-OAbc'), "'-OAbc", 'a value starting with - is kept as text');
eq(G.asText('=SUM(A1)'), "'=SUM(A1)", 'a formula is kept as text');
eq(G.asText('+Pat'), "'+Pat", '+ is kept as text');
eq(G.asText('@Pat'), "'@Pat", '@ is kept as text');
eq(G.asText('Pat'), 'Pat', 'plain text untouched');
ok(isDate(G.asText(new Date())), 'dates untouched');
eq(G.readText("'-OAbc"), '-OAbc', 'a kept apostrophe is dropped on read');
eq(G.readText("'tis"), "'tis", 'an ordinary apostrophe stays');
eq(G.readText('  x  '), 'x', 'read trims');
eq(G.readText(null), '', 'read null');
var hm = G.headerMap(['Email', ' Subscribed At ', 'TOKEN', 'notes'], G.SUBSCRIBER_HEADERS);
eq([hm.email, hm.subscribedAt, hm.token, hm.name], [0, 1, 2, -1], 'headers match by letters only, any case');
eq([].slice.call(G.missingHeaders(['email', 'Name'], ['email', 'name', 'status'])), ['status'], 'missing headers found');
eq([].slice.call(G.buildRow({ a: 2, b: 0 }, 4, { a: '-x', b: 'y', c: 'z' })), ['y', '', "'-x", ''], 'buildRow follows the Sheet column order');

section('Subscriber list logic');
var H = ['email', 'name', 'status', 'subscribedAt', 'unsubscribedAt', 'token', 'source'];
var T1 = '1111aaaa1111aaaa1111aaaa1111aaaa', T2 = '2222bbbb2222bbbb2222bbbb2222bbbb', T3 = '3333cccc3333cccc3333cccc3333cccc';
var book = G.parseSubscribers([
  H,
  ['ann@example.com', 'Ann', 'active', '', '', T1, 'newsletter-page'],
  [' BEN@Example.com ', '', '', '', '', '', 'hand'],                    // typed in: blank status, no token
  ['cat@example.com', '', 'unsubscribed', '', '', T2, ''],
  ['dan@example.com', '', 'paused', '', '', T3, ''],
  ['ann@example.com', '', 'active', '', '', '', ''],                    // duplicate row, still active
  ['eve@example.com', '', 'active', '', '', '', ''],
  ['eve@example.com', '', 'unsubscribed', '', '', '', ''],              // duplicate with an unsubscribe wins
  ['not an email', '', 'active', '', '', '', ''],
  ['fay@example.com', '', 'active', '', '', T1, ''],                    // token copied from ann
  ['', '', '', '', '', '', ''],
  ["'-weird@example.com", '', 'active', '', '', '', '']
]);
eq(book.groups.length, 8, 'one group per email, blank rows skipped');
eq(book.byEmail['ben@example.com'].active, true, 'blank status counts as active');
eq(book.byEmail['ben@example.com'].token, '', 'typed-in row has no token yet');
eq(book.byEmail['cat@example.com'].active, false, 'unsubscribed is not active');
eq(book.byEmail['dan@example.com'].active, false, 'any other status is not active');
eq(book.byEmail['ann@example.com'].rows.length, 2, 'duplicate rows grouped');
eq(book.byEmail['ann@example.com'].active, true, 'all rows active means active');
eq(book.byEmail['eve@example.com'].active, false, 'one unsubscribed row stops the email');
eq(book.byEmail['not an email'].active, false, 'a bad address never gets mail');
eq(book.byEmail['fay@example.com'].token, '', 'a token copied onto another email is dropped');
ok(book.byToken[T1] === book.byEmail['ann@example.com'], 'the copied token still belongs to the first email');
eq(G.decideSubscribe(null), 'subscribed', 'new email: subscribed');
eq(G.decideSubscribe(book.byEmail['ann@example.com']), 'already', 'active email: already');
eq(G.decideSubscribe(book.byEmail['cat@example.com']), 'resubscribed', 'unsubscribed email: resubscribed');
eq(G.decideSubscribe(book.byEmail['eve@example.com']), 'resubscribed', 'mixed rows: resubscribed');
eq(G.decideSubscribe(book.byEmail['dan@example.com']), 'held', 'a status an admin set (paused): held, the form cannot undo it');
var cnt = G.countSubscribers(book);
eq([cnt.active, cnt.unsubscribed], [3, 5], 'counts: active ann, ben, fay; the rest get nothing');
threw = false;
try { G.parseSubscribers([['name', 'status'], ['x', 'active']]); } catch (e) { threw = e.code === 'server-error'; }
ok(threw, 'a Subscribers tab with no email column is an error, not an empty list');

section('Who gets an issue');
var sends = [
  { newsletterId: '-A', email: 'ann@example.com' },
  { newsletterId: '-B', email: 'ben@example.com' },
  { newsletterId: '-A', email: 'cat@example.com' },
  { newsletterId: '-A', email: 'ann@example.com' }
];
var plan = G.planNotify(book, sends, '-A', 1, 150);
eq([plan.total, plan.alreadySent, plan.pending.length, plan.limit], [3, 1, 2, 1], 'quota 1: total 3, 1 already had it, 2 pending, 1 now');
eq(plan.pending.map(function (p) { return p.email; }), ['ben@example.com', 'fay@example.com'], 'pending in Sheet order, other issues ignored');
eq(G.planNotify(book, sends, '-A', 500, 150).limit, 150, 'never more than MAX_SENDS_PER_PRESS');
eq(G.planNotify(book, sends, '-A', -3, 150).limit, 0, 'negative quota is 0');
eq(G.planNotify(book, sends, '-A', 'x', 150).limit, 0, 'unreadable quota is 0');
eq(G.planNotify(book, [], '-C', 100, 150).pending.length, 3, 'a new issue goes to every active subscriber');
var issues = G.summarizeIssues(book, sends);
eq(JSON.parse(JSON.stringify(issues)), { '-A': { sent: 1, total: 3 }, '-B': { sent: 1, total: 3 } }, 'issue counts: active people who have it, duplicates once');

section('Rate limits');
var k1 = G.rateKeys(Date.UTC(2026, 10, 3, 15, 0, 59)), k2 = G.rateKeys(Date.UTC(2026, 10, 3, 15, 1, 0));
ok(k1.minute !== k2.minute && k1.hour === k2.hour, 'minute and hour windows');
ok(G.rateAllows({ minute: 9, hour: 59 }, { minute: 10, hour: 60 }), 'under both limits');
ok(!G.rateAllows({ minute: 10, hour: 0 }, { minute: 10, hour: 60 }), 'minute limit');
ok(!G.rateAllows({ minute: 0, hour: 60 }, { minute: 10, hour: 60 }), 'hour limit');
eq([G.SIGNUPS_PER_MINUTE, G.SIGNUPS_PER_HOUR, G.SIGNUPS_PER_DAY], [10, 30, 75], 'limits: 10 a minute, 30 an hour, 75 a day');
ok(G.SIGNUPS_PER_DAY < 100, 'a day of bot sign-ups is less than a day of Gmail quota');
var d1 = G.dayKey(Date.UTC(2026, 10, 3, 23, 59, 59)), d2 = G.dayKey(Date.UTC(2026, 10, 4, 0, 0, 0));
ok(d1 !== d2, 'day key changes at UTC midnight');
eq([G.dayCount(d1 + ':7', d1), G.dayCount(d1 + ':7', d2), G.dayCount(null, d1), G.dayCount('junk', d1)], [7, 0, 0, 0], 'day count: same day, new day, none, junk');
eq([G.notifyRunning(null, 1e6), G.notifyRunning('x', 1e6), G.notifyRunning(String(1e6 - 1000), 1e6), G.notifyRunning(String(1e6 - 360000), 1e6)],
  [false, false, true, false], 'sending flag: none, junk, fresh, expired');
eq([G.timeOf(new Date(5000)), G.timeOf('2026-11-03T00:00:00Z'), G.timeOf(''), G.timeOf('soon'), G.timeOf(42)],
  [5000, Date.UTC(2026, 10, 3), 0, 0, 0], 'timeOf reads Dates and date text only');
eq([G.toCount(null), G.toCount('7'), G.toCount('x')], [0, 7, 0], 'cache counts');
ok(G.recentKey(new Array(300).join('a') + '@example.com').length <= 250, 'cache key fits');
ok(G.isQuotaError(new Error('Service invoked too many times for one day: email.')), 'quota error spotted');
eq(G.withoutAddresses('Invalid email: pat.lee+x@example.com, or <b@example.org>'), 'Invalid email: <address>, or <<address>>', 'addresses taken out of log lines');
ok(!G.isQuotaError(new Error('Invalid email: x')), 'bad address is not a quota error');
// MailApp quotes the refused address. Words inside it must not read as a quota error, or one
// address would stop every press at its row. The spaced ones show the words go even when
// they sit right against the address.
ok(!G.isQuotaError(new Error('Invalid email: quotas@example.com')), 'an address with "quota" in it is not a quota error');
ok(!G.isQuotaError(new Error('Invalid email: pat@quota.example.com')), 'a domain with "quota" in it is not a quota error');
ok(!G.isQuotaError(new Error('Invalid email: too many times@example.com')), '"too many times" against the address is not a quota error');
ok(!G.isQuotaError(new Error('Invalid email: <limit exceeded@example.org>')), '"limit exceeded" against the address is not a quota error');
ok(!G.isQuotaError('Invalid email: quota.fan@example.com'), 'the same for a plain string');
ok(G.isQuotaError(new Error('Service invoked too many times for one day: email. Recipient: pat@example.com')), 'a quota error that quotes an address is still a quota error');
ok(G.isQuotaError(new Error('Limit Exceeded: Email Total Attachments Size.')), 'limit exceeded is a quota error');
ok(G.isQuotaError(new Error('Email quota used up for today.')), 'quota is a quota error');
ok(!G.isQuotaError(new Error('Gmail operation not allowed.')) && !G.isQuotaError(new Error('A server error occurred. Please try again later.')),
  'a Gmail-wide refusal is not a quota error (MAX_REFUSALS_IN_A_ROW ends that press)');
eq(G.MAX_REFUSALS_IN_A_ROW, 5, 'a press stops after 5 refusals in a row');

section('The email');
var url = 'https://drive.google.com/file/d/AbC/view?usp=sharing&x=1';
var mailOut = G.renderEmail({ title: 'Fall <script>alert(1)</script> & "News"\nBcc: eve@example.com', url: url, token: T1 });
eq(mailOut.subject, 'New from Theta Tau Zeta Delta: Fall <script>alert(1)</script> & "News" Bcc: eve@example.com', 'subject is one line with the prefix');
ok(mailOut.subject.indexOf('\n') === -1 && mailOut.subject.indexOf('\r') === -1, 'no line breaks in the subject');
ok(mailOut.body.indexOf('Read it here: ' + url) !== -1, 'plain body has the link');
ok(mailOut.body.indexOf('https://www.thetatauzd.org/newsletter?unsubscribe=' + T1) !== -1, 'plain body has the unsubscribe link');
ok(mailOut.htmlBody.indexOf('https://www.thetatauzd.org/newsletter?unsubscribe=' + T1) !== -1, 'html has the unsubscribe link');
ok(/because you signed up/.test(mailOut.body) && /because you signed up/.test(mailOut.htmlBody), 'both say why they get it');
ok(!/one click|one-click/i.test(mailOut.body + mailOut.htmlBody), 'the email does not promise one click (the page asks to confirm)');
ok(mailOut.htmlBody.indexOf('<script>') === -1 && mailOut.htmlBody.indexOf('&lt;script&gt;') !== -1, 'title escaped in html');
ok(mailOut.htmlBody.indexOf('href="' + url.replace(/&/g, '&amp;') + '"') !== -1, 'link escaped in the href');
ok(!/[\u2013\u2014]/.test(mailOut.subject + mailOut.body + mailOut.htmlBody), 'no em or en dashes in the email');
ok(!/Ann|Hi |Dear /.test(mailOut.body), 'the email never uses a sign-up name');
eq(G.escapeHtml('<a href="x">\'&</a>'), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&lt;/a&gt;', 'escapeHtml');

section('Requests');
var e1; try { G.parseBody(''); } catch (e) { e1 = e.code; } eq(e1, 'bad-request', 'empty body');
var e2; try { G.parseBody('{nope'); } catch (e) { e2 = e.code; } eq(e2, 'bad-request', 'not JSON');
var e3; try { G.parseBody('[1]'); } catch (e) { e3 = e.code; } eq(e3, 'bad-request', 'array body');
var e4; try { G.parseBody(JSON.stringify({ action: 'ping', pad: new Array(5001).join('x') })); } catch (e) { e4 = e.code; } eq(e4, 'bad-request', 'too large');
eq(G.uidFromIdToken(makeJwt({ user_id: 'abc' })), 'abc', 'uid from token');
eq(G.uidFromIdToken(makeJwt({ sub: 'abcd' })), 'abcd', 'uid from sub');
eq(G.uidFromIdToken(makeJwt({ user_id: 'abcde', pad: 'xx' })), 'abcde', 'unpadded payloads decode');
eq(G.uidFromIdToken('garbage'), null, 'garbage token has no uid');

// -- The web app end to end ---------------------------------------------------------

section('Web app: GET');
var w = makeWorld();
eq(w.get({ action: 'ping' }), { ok: true, version: 2 }, 'GET ?action=ping');
eq(w.get({}), { ok: true, version: 2 }, 'GET with no action is a ping');
eq(w.get({ action: 'subscribe', email: 'x@example.com' }).code, 'use-post', 'GET cannot subscribe');
eq(w.get({ action: 'notify' }).code, 'use-post', 'GET cannot notify');
eq(Object.keys(w.sheets).length, 0, 'ping touches no Sheet');

section('Web app: POST basics');
eq(w.post({ action: 'ping' }), { ok: true, version: 2 }, 'POST ping');
eq(w.post('').code, 'bad-request', 'empty POST');
eq(w.post('not json').code, 'bad-request', 'non-JSON POST');
eq(w.post({ action: 'drop-table' }).code, 'bad-request', 'unknown action');
var noAction = w.post({});
ok(noAction.ok === false && typeof noAction.error === 'string', 'failures carry ok:false and an error string');

section('Web app: subscribe');
var r = sub(w, '  Alex.Rivera@Example.COM ', { name: '  Alex   Rivera ' });
eq(r, { ok: true, status: 'subscribed' }, 'new address: subscribed');
var S = w.sheets.Subscribers;
ok(!!S, 'Subscribers tab made on first use');
eq(S.rows[0], H, 'Subscribers headers in row 1');
eq(S.frozen, 1, 'header row frozen');
var rec = S.records()[0];
eq([rec.email, rec.name, rec.status, rec.unsubscribedAt, rec.source], ['alex.rivera@example.com', 'Alex Rivera', 'active', '', 'newsletter-page'], 'row written, email lowercased and trimmed');
ok(G.isValidToken(rec.token), 'row has an unsubscribe token');
ok(isDate(rec.subscribedAt), 'subscribedAt is a date');
eq(w.mail.sent.length, 0, 'no welcome email');
eq(sub(w, 'ALEX.RIVERA@example.com').status, 'already', 'same address again within a minute: already');
later(w, 61);
eq(sub(w, 'alex.rivera@example.com').status, 'already', 'same address after a minute: already (from the Sheet)');
eq(S.records().length, 1, 'still one row');
eq(sub(w, 'pat@example.com', { website: 'http://spam.example' }), { ok: true, status: 'subscribed' }, 'honeypot: same answer as a real sign-up');
eq(S.records().length, 1, 'honeypot wrote nothing');
r = sub(w, 'not-an-email');
eq([r.ok, r.code], [false, 'invalid-email'], 'bad address: invalid-email');
ok(typeof r.error === 'string' && r.error.length > 0, 'invalid-email has a message');
eq(sub(w, 'a@example.com, b@example.com').code, 'invalid-email', 'two addresses: invalid-email');
eq(sub(w, 'pat@example.com', { name: 'Cheap pills https://spam.example' }).code, 'bot', 'link in name: bot');
eq(sub(w, 'pat@example.com', { email: 12 }).code, 'invalid-email', 'number for email: invalid-email');
sub(w, 'formula@example.com', { name: '=IMPORTRANGE("x","y")' });
sub(w, 'plus@example.com', { name: '+Pat -Lee' });
eq(S.records().filter(function (x) { return x.email === 'formula@example.com'; })[0].name, 'IMPORTRANGE("x","y")', 'a formula-looking name loses its leading =');
eq(S.records().filter(function (x) { return x.email === 'plus@example.com'; })[0].name, 'Pat -Lee', 'a name starting with + loses the +');
sub(w, 'nameless@example.com', { name: undefined, source: undefined });
eq(S.records().filter(function (x) { return x.email === 'nameless@example.com'; })[0].source, 'web', 'missing source stored as web');
ok(S.records().every(function (x) { return String(x.name).indexOf('#ERROR') === -1 && typeof x.token === 'string'; }), 'no cell became a formula or a number');
eq(w.lockState.held, 0, 'every lock released');
ok(w.lockState.flushes > 0, 'subscribe saves the Sheet with SpreadsheetApp.flush()');
locksClean(w, 'subscribe');

section('Web app: unsubscribe and come back');
var tok = tokenOf(w, 'alex.rivera@example.com');
r = w.post({ action: 'unsubscribe', token: tok });
eq(r, { ok: true, status: 'unsubscribed' }, 'unsubscribe with the token');
rec = S.records()[0];
eq(rec.status, 'unsubscribed', 'row marked unsubscribed');
ok(isDate(rec.unsubscribedAt), 'unsubscribedAt set');
eq(w.post({ action: 'unsubscribe', token: tok }).status, 'already', 'second click: already');
eq(w.post({ action: 'unsubscribe', token: tok.toUpperCase() }).status, 'already', 'token is not case sensitive');
eq(w.post({ action: 'unsubscribe', token: 'nope' }).code, 'unknown-token', 'malformed token: unknown-token');
eq(w.post({ action: 'unsubscribe', token: '0123456789abcdef0123456789abcdef' }).code, 'unknown-token', 'unknown token: unknown-token');
eq(w.post({ action: 'unsubscribe' }).code, 'unknown-token', 'no token: unknown-token');
eq(w.post({ action: 'unsubscribe', token: { $gt: '' } }).code, 'unknown-token', 'object token: unknown-token');
var p2 = tokenOf(w, 'plus@example.com');
w.post({ action: 'unsubscribe', token: p2 });
r = sub(w, 'plus@example.com');
eq(r.status, 'resubscribed', 'sign up again right after unsubscribing: resubscribed (not stuck on already)');
rec = S.records().filter(function (x) { return x.email === 'plus@example.com'; })[0];
eq([rec.status, rec.unsubscribedAt, rec.token], ['active', '', p2], 'active again, same token, so old links still work');
eq(S.records().filter(function (x) { return x.email === 'plus@example.com'; }).length, 1, 'still one row for that email');
// A duplicate row for the same email is unsubscribed too.
S.appendRow(['dup@example.com', '', 'active', '', '', 'dddd0000dddd0000dddd0000dddd0000', '']);
S.appendRow(['DUP@example.com', '', '', '', '', '', 'hand']);
w.post({ action: 'unsubscribe', token: 'dddd0000dddd0000dddd0000dddd0000' });
eq(S.records().filter(function (x) { return /^dup@/i.test(x.email); }).map(function (x) { return x.status; }), ['unsubscribed', 'unsubscribed'], 'every row for that email is unsubscribed');
// A status an admin set (removed, paused) is kept: the link only notes that the person asked to leave,
// so the form still cannot bring the address back.
function recsOf(email) { return S.records().filter(function (x) { return x.email === email; }); }
S.appendRow(['held@example.com', '', 'removed', '', '', 'aaaa1111aaaa1111aaaa1111aaaa1111', '']);
r = w.post({ action: 'unsubscribe', token: 'aaaa1111aaaa1111aaaa1111aaaa1111' });
eq(r, { ok: true, status: 'already' }, 'removed row: the link answers already (no active row to change)');
eq(recsOf('held@example.com')[0].status, 'removed', 'removed row: status still removed after the link');
ok(isDate(recsOf('held@example.com')[0].unsubscribedAt), 'removed row: unsubscribedAt shows they asked to leave');
eq(sub(w, 'held@example.com').status, 'held', 'removed row: signing up again is still held');
eq(recsOf('held@example.com')[0].status, 'removed', 'removed row: still removed after the sign-up try');
S.appendRow(['spaced@example.com', '', ' Removed ', '', '', 'bbbb2222bbbb2222bbbb2222bbbb2222', '']);
eq(sub(w, 'spaced@example.com').status, 'held', 'status " Removed " (capitals and spaces) is held too');
eq(w.post({ action: 'unsubscribe', token: 'bbbb2222bbbb2222bbbb2222bbbb2222' }).status, 'already', '" Removed ": the link answers already');
eq(recsOf('spaced@example.com')[0].status, ' Removed ', '" Removed ": status cell untouched');
eq(sub(w, 'spaced@example.com').status, 'held', '" Removed ": signing up after the link is still held');
S.appendRow(['mixed@example.com', '', 'active', '', '', 'cccc3333cccc3333cccc3333cccc3333', '']);
S.appendRow(['mixed@example.com', '', 'paused', '', '', '', '']);
eq(w.post({ action: 'unsubscribe', token: 'cccc3333cccc3333cccc3333cccc3333' }).status, 'unsubscribed', 'an active row next to a paused one: unsubscribed');
eq(recsOf('mixed@example.com').map(function (x) { return x.status; }), ['unsubscribed', 'paused'], 'only the active row changes; the paused row keeps its status');
ok(recsOf('mixed@example.com').every(function (x) { return isDate(x.unsubscribedAt); }), 'both rows get unsubscribedAt');
eq(sub(w, 'mixed@example.com').status, 'held', 'and the form cannot bring it back');
locksClean(w, 'unsubscribe');

section('Web app: rate limits');
var wr = makeWorld();
wr.clock.now = Date.UTC(2026, 10, 3, 1, 0, 0);   // the top of a UTC hour, early in a UTC day
var results = [];
for (var m = 0; m < 3; m++) {
  for (var n = 0; n < 10; n++) results.push(sub(wr, 'p' + m + '-' + n + '@example.com').status);
  r = sub(wr, 'extra' + m + '@example.com');
  ok(r.code === 'rate-limited', 'minute ' + m + ': the 11th sign-up is rate-limited');
  later(wr, 60);
}
ok(results.every(function (s) { return s === 'subscribed'; }), '30 sign-ups over 3 minutes all land');
r = sub(wr, 'late@example.com');
eq(r.code, 'rate-limited', 'the 31st in the hour is rate-limited, even in a fresh minute');
eq(sub(wr, 'p0-0@example.com').code, 'rate-limited', 'under the hour cap even a known address is rate-limited (slows anyone probing the list)');
eq(sub(wr, 'bot@example.com', { website: 'x' }).status, 'subscribed', 'honeypot answer unchanged under the limit');
later(wr, 3600);
eq(sub(wr, 'late@example.com').status, 'subscribed', 'next hour: sign-ups work again');
eq(wr.sheets.Subscribers.records().length, 31, 'exactly 31 rows');
// The daily cap: 75 in one UTC day, however the minutes and hours are spread.
var dayN = 31;
later(wr, 60);
while (dayN < 75) {
  for (var k = 0; k < 10 && dayN < 75; k++) { sub(wr, 'd' + dayN + '@example.com'); dayN++; }
  later(wr, 3600);
}
eq(wr.sheets.Subscribers.records().length, 75, '75 rows by the daily cap');
r = sub(wr, 'over@example.com');
eq(r.code, 'rate-limited', 'the 76th sign-up in a UTC day is rate-limited, in a fresh hour and minute');
ok(/tomorrow/.test(r.error) && r.error.indexOf('sotheta@mailbox.sc.edu') !== -1, 'the daily cap says try tomorrow or email the chapter');
eq(wr.sheets.Subscribers.records().length, 75, 'nothing written over the cap');
wr.clock.now = Date.UTC(2026, 10, 4, 0, 30, 0);
eq(sub(wr, 'over@example.com').status, 'subscribed', 'the next UTC day: sign-ups work again');
wr.lockState.fail = true;
eq(sub(wr, 'busy@example.com').code, 'rate-limited', 'lock busy: subscribe says rate-limited');
eq(wr.post({ action: 'unsubscribe', token: tokenOf(wr, 'late@example.com') }).code, 'busy', 'lock busy: unsubscribe says busy');
wr.lockState.fail = false;

section('Web app: admin checks');
var wa = makeWorld();
var adminTok = wa.admin('uidAdmin1', 'admin');
var brotherTok = wa.admin('uidBrother1', 'brother');
var pendingTok = wa.admin('uidPending1', 'pending');
var good = { action: 'notify', newsletterId: '-OTest123', title: 'Fall 2026 Newsletter', url: 'https://drive.google.com/file/d/AbC/view' };
function withTok(base, t) { var o = JSON.parse(JSON.stringify(base)); if (t !== undefined) o.idToken = t; return o; }
eq(wa.post(withTok(good)).code, 'not-signed-in', 'notify with no token: not-signed-in');
eq(wa.post(withTok(good, 'abc')).code, 'not-signed-in', 'notify with a garbage token: not-signed-in');
eq(wa.post(withTok(good, makeJwt({ user_id: 'uidAdmin1' }))).code, 'not-signed-in', 'a forged token for a real admin uid: refused by the database');
eq(wa.post(withTok(good, makeJwt({ user_id: '../../x' }))).code, 'not-signed-in', 'a uid with path characters never reaches the database');
eq(wa.post(withTok(good, brotherTok)).code, 'not-admin', 'a brother: not-admin');
eq(wa.post(withTok(good, pendingTok)).code, 'not-admin', 'a pending account: not-admin');
eq(wa.post({ action: 'status', idToken: brotherTok }).code, 'not-admin', 'status needs admin too');
eq(wa.mail.sent.length, 0, 'nothing sent to non-admins');
var lastFetch = wa.fetches[wa.fetches.length - 1].url;
ok(lastFetch.indexOf('https://thetatauzd-2ab25-default-rtdb.firebaseio.com/users/uidBrother1.json?auth=') === 0, 'checks users/{uid}.json?auth=<token>');
r = wa.post({ action: 'status', idToken: adminTok });
eq(JSON.parse(JSON.stringify(r)), { ok: true, active: 0, unsubscribed: 0, newSinceLastSend: 0, quotaLeft: 100, issues: {} }, 'status on an empty list');
eq(wa.sheets.Sends.rows[0], ['newsletterId', 'email', 'sentAt'], 'Sends tab made with headers');

section('Web app: notify bad input');
eq(wa.post(withTok({ action: 'notify', newsletterId: '-OTest123', title: 'X', url: 'http://drive.google.com/x' }, adminTok)).code, 'bad-url', 'http link: bad-url');
eq(wa.post(withTok({ action: 'notify', newsletterId: '-OTest123', title: 'X', url: 'https://evil.example/x' }, adminTok)).code, 'bad-url', 'other host: bad-url');
eq(wa.post(withTok({ action: 'notify', newsletterId: '-OTest123', title: 'X' }, adminTok)).code, 'bad-url', 'no link: bad-url');
eq(wa.post(withTok({ action: 'notify', newsletterId: 'a/b', title: 'X', url: good.url }, adminTok)).code, 'bad-request', 'bad newsletterId: bad-request');
eq(wa.post(withTok({ action: 'notify', newsletterId: '-OTest123', title: '  ', url: good.url }, adminTok)).code, 'bad-request', 'no title: bad-request');

section('Web app: notify sends, stops at the quota, and carries on');
['ann', 'ben', 'cat', 'dan', 'eli'].forEach(function (x) { sub(wa, x + '@example.com', { name: x.toUpperCase() }); });
sub(wa, 'gone@example.com');
wa.post({ action: 'unsubscribe', token: tokenOf(wa, 'gone@example.com') });
var WS = wa.sheets.Subscribers;
WS.appendRow(['  Hand.Typed@Example.com ', 'Typed In', '', '', '', '', '']);   // pasted by hand: no status, no token
WS.appendRow(['paused@example.com', '', 'paused', '', '', 'eeee1111eeee1111eeee1111eeee1111', '']);
r = sub(wa, 'paused@example.com');
eq(r, { ok: true, status: 'held' }, 'the form cannot re-activate an address an admin paused');
eq(WS.records().filter(function (x) { return x.email === 'paused@example.com'; })[0].status, 'paused', 'paused row unchanged');
eq(sub(wa, 'paused@example.com').status, 'held', 'asking again still says held (not a cached already)');
r = wa.post({ action: 'status', idToken: adminTok });
eq([r.active, r.newSinceLastSend], [6, 5], 'before the first send: the 5 form sign-ups are new (the typed-in row has no date)');
wa.mail.quota = 3;
r = wa.post(withTok(good, adminTok));
eq(JSON.parse(JSON.stringify(r)), { ok: true, sent: 3, total: 6, alreadySent: 0, remaining: 3, quotaLeft: 0, done: false, failed: 0 , badAddresses: 0 }, 'first press, quota 3: 3 sent, 3 to go');
eq(wa.mail.sent.length, 3, '3 emails out');
var handTok = WS.records().filter(function (x) { return /hand\.typed/i.test(x.email); })[0].token;
ok(G.isValidToken(handTok), 'the typed-in row got a token before sending');
var first = wa.mail.sent[0];
eq(Object.keys(first).sort(), ['body', 'htmlBody', 'name', 'replyTo', 'subject', 'to'], 'message fields: no cc or bcc');
eq([first.name, first.replyTo, first.subject], ['Theta Tau Zeta Delta', 'sotheta@mailbox.sc.edu', 'New from Theta Tau Zeta Delta: Fall 2026 Newsletter'], 'from name, reply-to and subject');
ok(wa.mail.sent.every(function (msg) { return G.isValidEmail(msg.to); }), 'one recipient per message');
ok(wa.mail.sent.every(function (msg) {
  var t = tokenOf(wa, msg.to);
  return t && msg.body.indexOf('?unsubscribe=' + t) !== -1 && msg.htmlBody.indexOf('?unsubscribe=' + t) !== -1;
}), 'each email carries that person\'s own unsubscribe link');
ok(wa.mail.sent.every(function (msg) { return msg.body.indexOf(good.url) !== -1; }), 'each email links the issue');
var SD = wa.sheets.Sends;
eq(SD.records().map(function (x) { return x.newsletterId; }), ['-OTest123', '-OTest123', '-OTest123'], 'Sends rows keep the - in the newsletterId (no formula)');
ok(SD.records().every(function (x) { return isDate(x.sentAt); }), 'sentAt is a date');
r = wa.post(withTok(good, adminTok));
eq(JSON.parse(JSON.stringify(r)), { ok: true, sent: 0, total: 6, alreadySent: 3, remaining: 3, quotaLeft: 0, done: false, failed: 0 , badAddresses: 0 }, 'press again with no quota left: nothing sent, nothing lost');
wa.mail.quota = 100;
later(wa, 86400);
r = wa.post(withTok(good, adminTok));
eq(JSON.parse(JSON.stringify(r)), { ok: true, sent: 3, total: 6, alreadySent: 3, remaining: 0, quotaLeft: 97, done: true, failed: 0 , badAddresses: 0 }, 'next day: the other 3, done');
var tos = wa.mail.sent.map(function (msg) { return msg.to; }).sort();
eq(tos, ['ann@example.com', 'ben@example.com', 'cat@example.com', 'dan@example.com', 'eli@example.com', 'hand.typed@example.com'], 'everyone active got it exactly once');
r = wa.post(withTok(good, adminTok));
eq([r.sent, r.alreadySent, r.remaining, r.done], [0, 6, 0, true], 'pressing again after done sends nothing');
eq(wa.mail.sent.length, 6, 'still 6 emails');
sub(wa, 'newbie@example.com');
r = wa.post(withTok(good, adminTok));
eq([r.sent, r.total, r.done], [1, 7, true], 'someone who signed up later gets the issue on the next press');
r = wa.post(withTok({ action: 'notify', newsletterId: '-OSpring27', title: 'Spring', url: 'https://www.thetatauzd.org/newsletter' }, adminTok));
eq([r.sent, r.total, r.done], [7, 7, true], 'a new issue goes to all 7');
r = wa.post({ action: 'status', idToken: adminTok });
eq(JSON.parse(JSON.stringify(r)), { ok: true, active: 7, unsubscribed: 2, newSinceLastSend: 0, quotaLeft: 89, issues: { '-OTest123': { sent: 7, total: 7 }, '-OSpring27': { sent: 7, total: 7 } } }, 'status: counts and per-issue progress');
later(wa, 60);
sub(wa, 'fresh1@example.com');
sub(wa, 'fresh2@example.com');
eq(wa.post({ action: 'status', idToken: adminTok }).newSinceLastSend, 2, 'two sign-ups after the last send: newSinceLastSend 2');
WS.records().forEach(function (x, i) { if (/^fresh/.test(x.email)) WS.rows[i + 1][WS.rows[0].indexOf('status')] = 'removed'; });
eq(wa.post({ action: 'status', idToken: adminTok }).newSinceLastSend, 0, 'rows an admin removed are not counted');
later(wa, 61);
eq(sub(wa, 'fresh1@example.com').status, 'held', 'and the form cannot bring them back');
eq(wa.lockState.held, 0, 'every lock released');
ok(!wa.propStore[G.NOTIFY_FLAG_KEY], 'the sending flag is cleared after each press');
ok(!wa.cacheStore[G.NOTIFY_FLAG_KEY], 'the sending flag is not kept in the cache');
locksClean(wa, 'notify');

section('Web app: notify edge cases');
var issue3 = withTok({ action: 'notify', newsletterId: '-OEdge', title: 'Edge', url: good.url }, adminTok);
wa.mail.failFor['ben@example.com'] = true;
r = wa.post(issue3);
eq([r.sent, r.failed, r.remaining, r.done], [6, 1, 1, false], 'an address MailApp refuses is counted as failed and stays pending');
ok(wa.logs.some(function (l) { return /could not send to Subscribers row/.test(l) && l.indexOf('ben@') === -1; }), 'failure logged by row, without the address');
delete wa.mail.failFor['ben@example.com'];
r = wa.post(issue3);
eq([r.sent, r.failed, r.remaining, r.done], [1, 0, 0, true], 'next press sends it');
var issue4 = withTok({ action: 'notify', newsletterId: '-OQuota', title: 'Quota', url: good.url }, adminTok);
wa.mail.hardLimit = wa.mail.sent.length + 2;
r = wa.post(issue4);
eq([r.sent, r.failed, r.remaining, r.done], [2, 0, 5, false], 'MailApp says quota mid-run: stops, records what went out');
wa.mail.hardLimit = Infinity;
wa.ctx.MAX_SENDS_PER_PRESS = 2;
r = wa.post(issue4);
eq([r.sent, r.remaining], [2, 3], 'never more than MAX_SENDS_PER_PRESS in one press');
wa.ctx.MAX_SENDS_PER_PRESS = 150;
wa.ctx.nowMs = function () { wa.clock.now += 100000; return wa.clock.now; };
r = wa.post(issue4);
eq([r.sent, r.remaining, r.done], [2, 1, false], 'stops before the 6 minute limit and says how many are left');
wa.ctx.nowMs = function () { return wa.clock.now; };
wa.propStore[G.NOTIFY_FLAG_KEY] = String(wa.clock.now - 1000);
r = wa.post(issue4);
eq(r.code, 'busy', 'a second press while one is sending: busy');
ok(!!wa.propStore[G.NOTIFY_FLAG_KEY], 'a busy press leaves the other run\'s flag alone');
wa.propStore[G.NOTIFY_FLAG_KEY] = String(wa.clock.now - 361000);
r = wa.post(issue4);
eq([r.sent, r.remaining, r.done], [1, 0, true], 'a flag older than 6 minutes is from a run that died: it finishes');
var perIssue = {};
wa.sheets.Sends.records().forEach(function (x) { var k = x.newsletterId + ' ' + x.email; perIssue[k] = (perIssue[k] || 0) + 1; });
ok(Object.keys(perIssue).every(function (k) { return perIssue[k] === 1; }), 'no one is in Sends twice for the same issue');
ok(wa.mail.sent.every(function (msg) { return msg.to !== 'gone@example.com' && msg.to !== 'paused@example.com'; }), 'unsubscribed and paused people never get mail');
var dupTo = {};
wa.mail.sent.forEach(function (msg) { var k = msg.subject + ' ' + msg.to; dupTo[k] = (dupTo[k] || 0) + 1; });
ok(Object.keys(dupTo).every(function (k) { return dupTo[k] === 1; }), 'no one got the same issue twice');
locksClean(wa, 'notify edge cases');

section('Web app: a refused address does not use up the press');
var wq = makeWorld();
var wqAdmin = wq.admin('uidAdmin4', 'admin');
sub(wq, 'typo@example.com');
sub(wq, 'fine@example.com');
wq.mail.failFor['typo@example.com'] = true;
wq.mail.quota = 1;
r = wq.post(withTok(good, wqAdmin));
eq([r.sent, r.failed, r.remaining, r.done], [1, 1, 1, false], 'quota 1 and the first row refused: the next one is still sent');
eq(wq.mail.sent.map(function (msg) { return msg.to; }), ['fine@example.com'], 'the email went to the next address');
wq.mail.quota = 1;
r = wq.post(withTok(good, wqAdmin));
eq([r.sent, r.failed, r.remaining, r.done], [0, 1, 1, false], 'pressing again: only the refused one is left, and it is refused again');
locksClean(wq, 'refused address');

section('Web app: an address with quota words in it is just a refused address');
var wz = makeWorld();
var wzAdmin = wz.admin('uidAdmin6', 'admin');
['quota.fan', 'ann', 'ben', 'cat'].forEach(function (x) { sub(wz, x + '@example.com'); later(wz, 7); });
wz.mail.failFor['quota.fan@example.com'] = true;
r = wz.post(withTok(good, wzAdmin));
eq(JSON.parse(JSON.stringify(r)), { ok: true, sent: 3, total: 4, alreadySent: 0, remaining: 1, quotaLeft: 97, done: false, failed: 1 , badAddresses: 1 },
  'one bad row first, the others fine: the rest are sent and the bad one stays pending');
eq(wz.mail.sent.map(function (msg) { return msg.to; }), ['ann@example.com', 'ben@example.com', 'cat@example.com'], 'the 3 good addresses got it');
ok(wz.logs.some(function (l) { return /could not send to Subscribers row 2: Invalid email: <address>/.test(l); }), 'the log names the refused row, not the address');
// Rows with a bad address never reach MailApp (isValidEmail), so these are addresses the form takes.
['too.many.times', 'limit.exceeded'].forEach(function (x) { later(wz, 7); sub(wz, x + '@quota.example.com'); wz.mail.failFor[x + '@quota.example.com'] = true; });
later(wz, 7);
sub(wz, 'dee@example.com');
r = wz.post(withTok(good, wzAdmin));
eq([r.sent, r.failed, r.remaining, r.done], [1, 3, 3, false], 'addresses with "quota", "too many times" and "limit exceeded" are each refused, and the press goes on to the next row');
eq((wz.mail.sent[wz.mail.sent.length - 1] || {}).to, 'dee@example.com', 'the row after them got it');
locksClean(wz, 'quota words in an address');

section('Web app: Gmail refuses every send');
var wg = makeWorld();
var wgAdmin = wg.admin('uidAdmin5', 'admin');
['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8'].forEach(function (x) { sub(wg, x + '@example.com'); later(wg, 7); });
var wgTries = 0;
wg.mail.sendEmail = function () { wgTries++; throw new Error('Gmail operation not allowed.'); };
r = wg.post(withTok(good, wgAdmin));
eq(JSON.parse(JSON.stringify(r)), { ok: true, sent: 0, total: 8, alreadySent: 0, remaining: 8, quotaLeft: 100, done: false, failed: 5 , badAddresses: 0 },
  'every send refused (restricted account): stops after 5, all 8 still to go');
eq(wgTries, 5, 'it tried 5 sends, not all 8');
eq(wg.sheets.Sends.records().length, 0, 'nothing written to Sends');
ok(wg.logs.some(function (l) { return /5 refused in a row/.test(l); }), 'the log says why the press stopped');
ok(!wg.propStore[G.LAST_PLAN_KEY], 'nl:lastPlanAt not saved when nothing was sent');
ok(!wg.propStore[G.NOTIFY_FLAG_KEY], 'the sending flag is cleared');
wgTries = 0;
wg.mail.sendEmail = function () { wgTries++; throw new Error('A server error occurred. Please try again later.'); };
r = wg.post(withTok(good, wgAdmin));
eq([r.sent, r.failed, r.remaining, r.done, wgTries], [0, 5, 8, false, 5], 'a Gmail outage: the same, 5 tries and all 8 still to go');
locksClean(wg, 'Gmail refuses every send');

section('Web app: bad addresses never stop a press');
var wr = makeWorld();
var wrAdmin = wr.admin('uidAdmin7', 'admin');
['bad1', 'bad2', 'bad3', 'bad4', 'bad5', 'bad6', 'bad7', 'ok1', 'ok2', 'ok3'].forEach(function (x) { sub(wr, x + '@example.com'); later(wr, 7); });
['bad1', 'bad2', 'bad3', 'bad4', 'bad5', 'bad6', 'bad7'].forEach(function (x) { wr.mail.failFor[x + '@example.com'] = true; });
r = wr.post(withTok(good, wrAdmin));
eq([r.sent, r.failed, r.badAddresses, r.remaining, r.done], [3, 7, 7, 7, false], '7 bad rows at the top (a bot burst): every row is tried and the 3 good ones get it');
eq(wr.mail.sent.map(function (msg) { return msg.to; }), ['ok1@example.com', 'ok2@example.com', 'ok3@example.com'], 'the rows after them got it');
r = wr.post(withTok(good, wrAdmin));
eq([r.sent, r.failed, r.badAddresses, r.remaining], [0, 7, 7, 7], 'pressing again: the same 7 are refused, and the reply says they are bad addresses');
locksClean(wr, 'bad addresses in a row');

section('Web app: Gmail refusals in a row start over after a send');
var wo = makeWorld();
var woAdmin = wo.admin('uidAdmin8', 'admin');
['x1', 'x2', 'x3', 'x4', 'ok1', 'x5', 'x6', 'x7', 'x8', 'ok2'].forEach(function (x) { sub(wo, x + '@example.com'); later(wo, 7); });
var woReal = wo.mail.sendEmail;
wo.mail.sendEmail = function (msg) { if (/^x/.test(msg.to)) throw new Error('A server error occurred. Please try again later.'); return woReal(msg); };
r = wo.post(withTok(good, woAdmin));
eq([r.sent, r.failed, r.badAddresses, r.remaining], [2, 8, 0, 8], '4 refused, 1 sent, 4 refused, 1 sent: no stop, because a send came between');
locksClean(wo, 'Gmail refusals in a row');

section('Web app: an apostrophe in a refused address');
var wq2 = makeWorld();
var wq2Admin = wq2.admin('uidAdmin9', 'admin');
["quota'fan", 'next'].forEach(function (x) { sub(wq2, x + '@example.com'); later(wq2, 7); });
wq2.mail.failFor["quota'fan@example.com"] = true;
ok(!G.isQuotaError(new Error("Invalid email: quota'fan@example.com")), 'an address with an apostrophe and "quota" is not a quota error');
eq(G.withoutAddresses("Invalid email: quota'fan@example.com"), 'Invalid email: <address>', 'the whole address, apostrophe included, is taken out of the log');
r = wq2.post(withTok(good, wq2Admin));
eq([r.sent, r.failed, r.badAddresses, r.remaining], [1, 1, 1, 1], 'it counts as a bad address and the next row still gets the email');
locksClean(wq2, 'apostrophe address');

section('Web app: while a press is sending');
var wn = makeWorld();
var wnAdmin = wn.admin('uidAdmin3', 'admin');
['amy', 'bo', 'cy'].forEach(function (x) { sub(wn, x + '@example.com'); });
later(wn, 60);
var realSend = wn.mail.sendEmail;
var flagDuring = [], during = {};
wn.mail.sendEmail = function (msg) {
  flagDuring.push(wn.propStore[G.NOTIFY_FLAG_KEY]);
  if (flagDuring.length === 1) {
    later(wn, 1);
    during.signup = sub(wn, 'during@example.com').status;
    during.second = wn.post(withTok(good, wnAdmin));
  }
  later(wn, 1);   // each email takes a moment, so later Sends rows are newer than that sign-up
  return realSend(msg);
};
var pressAt = wn.clock.now;
r = wn.post(withTok(good, wnAdmin));
wn.mail.sendEmail = realSend;
eq([r.sent, r.total, r.remaining, r.done], [3, 3, 0, true], 'the press sends to the 3 who were on the list when it started');
eq(flagDuring, [String(pressAt), String(pressAt), String(pressAt)], 'the sending flag holds the press time while each email goes out');
eq(during.second && during.second.code, 'busy', 'a second press from inside a send: busy');
eq(during.signup, 'subscribed', 'a sign-up while the press is sending lands');
ok(wn.mail.sent.every(function (msg) { return msg.to !== 'during@example.com'; }), 'and is not in that press (the list was read at the start)');
eq(wn.propStore[G.LAST_PLAN_KEY], String(pressAt), 'the press time is saved as nl:lastPlanAt');
ok(!wn.propStore[G.NOTIFY_FLAG_KEY], 'the sending flag is cleared after the press');
eq(wn.post({ action: 'status', idToken: wnAdmin }).newSinceLastSend, 1, 'the sign-up made while sending counts as new since the last send');
delete wn.propStore[G.LAST_PLAN_KEY];
eq(wn.post({ action: 'status', idToken: wnAdmin }).newSinceLastSend, 0, 'without nl:lastPlanAt it falls back to the newest Sends row (which misses that sign-up)');
wn.propStore[G.LAST_PLAN_KEY] = String(pressAt);
later(wn, 60);
wn.mail.quota = 0;
r = wn.post(withTok(good, wnAdmin));
eq([r.sent, r.remaining], [0, 1], 'a press with no quota sends nothing');
eq(wn.propStore[G.LAST_PLAN_KEY], String(pressAt), 'and leaves nl:lastPlanAt alone');
wn.mail.quota = 100;
r = wn.post(withTok(good, wnAdmin));
eq([r.sent, r.done], [1, true], 'the next press sends to the one who signed up while sending');
eq(wn.propStore[G.LAST_PLAN_KEY], String(wn.clock.now), 'and moves nl:lastPlanAt to its own press time');
eq(wn.post({ action: 'status', idToken: wnAdmin }).newSinceLastSend, 0, 'nobody new since then');
locksClean(wn, 'while sending');

section('Web app: errors');
var we = makeWorld();
we.ss.broken = true;
r = sub(we, 'pat@example.com');
eq([r.ok, r.code, r.error], [false, 'server-error', 'Something went wrong. Try again later.'], 'an unexpected error gives a plain message, no details');
ok(we.logs.some(function (l) { return /Spreadsheet exploded/.test(l); }), 'the real error goes to the execution log');
var coded = new Error('secret detail'); coded.code = 'E42';
eq(JSON.parse(JSON.stringify(we.ctx.errorReply(coded))), { ok: false, code: 'server-error', error: 'Something went wrong. Try again later.' }, 'a service error with its own code still gets the plain message');
eq(we.lockState.held, 0, 'lock released after an error');
we.ss.broken = false;
var weAdmin = we.admin('uidAdmin2', 'admin');
we.ss.broken = true;
r = we.post(withTok(good, weAdmin));
eq(r.code, 'server-error', 'notify with a broken Sheet: server-error');
ok(!we.propStore[G.NOTIFY_FLAG_KEY] && !we.propStore['nl:notify:running'], 'the sending flag is cleared after an error');
eq(we.lockState.held, 0, 'lock released');

section('Editor helpers');
var ws = makeWorld();
ok(/Ready\. Tabs: Subscribers and Sends\. Emails left today: 100\./.test(ws.ctx.setup()), 'setup makes both tabs and reports the quota');
ok(ws.sheets.Subscribers && ws.sheets.Sends, 'both tabs exist');
ws.ctx.setup();
eq(ws.sheets.Subscribers.rows[0], H, 'running setup twice changes nothing');
ws.sheets.Subscribers.rows[0] = ['Email', 'Name', 'Status'];
ws.ctx.setup();
eq(ws.sheets.Subscribers.rows[0], ['Email', 'Name', 'Status', 'subscribedAt', 'unsubscribedAt', 'token', 'source'], 'missing headers are added on the right, existing ones kept');
ws.ctx.sendTestEmail();
eq([ws.mail.sent.length, ws.mail.sent[0].to, ws.mail.sent[0].subject.indexOf('[Test] ')], [1, 'owner@example.com', 0], 'sendTestEmail mails the owner only');

section('House rules');
var readme = fs.readFileSync(path.join(root, 'portal/apps-script/README.md'), 'utf8');
var at = readme.indexOf('# Newsletter sign-up gateway');
ok(at !== -1, 'README has the Newsletter sign-up gateway section');
var readmeSection = at === -1 ? '' : readme.slice(at);
eq(G.NEWSLETTER_GATEWAY_VERSION, 2, 'gateway version 2 (raise it with every change, so a ping shows the live copy is current)');
ok(readmeSection.indexOf('{"ok":true,"version":' + G.NEWSLETTER_GATEWAY_VERSION + '}') !== -1, 'the README shows the ping reply for the current version');
ok(readmeSection.indexOf('`version: ' + G.NEWSLETTER_GATEWAY_VERSION + '`') !== -1, 'the README actions table shows the current version');
var intro = at === -1 ? readme : readme.slice(0, at);
ok(/There are \*\*three\*\*/.test(intro), 'the README intro says there are three gateways');
ok(/\| \[`NewsletterGateway\.gs`\]\(NewsletterGateway\.gs\) \|/.test(intro), 'the README intro table lists NewsletterGateway.gs');
ok(readmeSection.indexOf('nl:lastPlanAt') !== -1, 'the README explains nl:lastPlanAt');
var testsSrc = fs.readFileSync(__filename, 'utf8');
ok(!/[\u2014]/.test(src) && !/[\u2014]/.test(readmeSection) && !/[\u2014]/.test(testsSrc), 'no em dashes in the script, the README section or the tests');
ok(!/=>|`\$\{|^\s*(let|const|class)\s/m.test(src), 'the script is plain ES5 (no arrows, let, const, class or template strings)');
function emailsIn(text) { return text.match(/[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []; }
var allowed = { 'sotheta@mailbox.sc.edu': 1, 'thetatauusc@gmail.com': 1 };
var stray = emailsIn(src + '\n' + readmeSection + '\n' + testsSrc).filter(function (e) {
  var low = e.toLowerCase().replace(/^'+/, '');
  // drive.google.com shows up after user:pw@ in a link test; it is not a mailbox.
  return !allowed[low] && !/@[a-z0-9.-]*example[a-z0-9.-]*$/.test(low) && !/@drive\.google\.com$/.test(low);
});
eq(stray, [], 'no real email addresses besides the two chapter ones');

// -- Report --------------------------------------------------------------------------

lines.forEach(function (l) { console.log(l); });
console.log('');
console.log(failCount ? failCount + ' FAILED, ' + pass + ' passed' : 'All ' + pass + ' tests passed');
process.exit(failCount ? 1 : 0);
