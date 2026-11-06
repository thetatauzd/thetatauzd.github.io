#!/usr/bin/env node
/**
 * Drives the real portal/js/newsletters.js (the Newsletters admin page) against a tiny fake DOM, a fake
 * Firebase (auth + the newsletters node) and a fake newsletter script reached through a fake fetch.
 * Covers the Email subscribers flow: not deployed (empty URL), the summary line, confirm and cancel,
 * success, partial (Gmail's daily limit), errors, the offer after publishing, and that publish and
 * delete still work as before. Never touches the live database or a real script.
 * Usage: node scripts/newsletters-admin-tests.js
 */
'use strict';
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var root = path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(root, rel), 'utf8'); }

var SCRIPT_URL = 'https://script.google.com/macros/s/TEST-DEPLOYMENT/exec';
var DAILY = '(Gmail lets the chapter account send about 100 a day)';

// ── A tiny DOM ──
function FakeEl(tag) {
  this.tagName = String(tag).toUpperCase();
  this.children = [];
  this.attrs = {};
  this.listeners = {};
  this.className = '';
  this.style = {};
  this.disabled = false;
  this.value = '';
  this.type = '';
  this.href = '';
  this._text = '';
}
Object.defineProperty(FakeEl.prototype, 'textContent', {
  get: function () {
    if (!this.children.length) return this._text;
    return this.children.map(function (c) { return c.textContent; }).join('');
  },
  set: function (v) { this.children = []; this._text = v === null || v === undefined ? '' : String(v); }
});
Object.defineProperty(FakeEl.prototype, 'innerHTML', {
  get: function () { return this.textContent; },
  set: function (v) {
    if (v !== '') throw new Error('The fake DOM only supports clearing innerHTML.');
    this.children = []; this._text = '';
  }
});
FakeEl.prototype.appendChild = function (c) { c.parentNode = this; this.children.push(c); return c; };
FakeEl.prototype.setAttribute = function (k, v) { this.attrs[k] = String(v); };
FakeEl.prototype.getAttribute = function (k) { return k in this.attrs ? this.attrs[k] : null; };
FakeEl.prototype.addEventListener = function (type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); };
FakeEl.prototype.dispatch = function (type, evt) {
  var self = this;
  (this.listeners[type] || []).forEach(function (fn) { fn.call(self, evt || {}); });
};
/** Like a person clicking: a disabled button does nothing. */
FakeEl.prototype.click = function () { if (!this.disabled) this.dispatch('click', {}); };

function findAll(node, pred, out) {
  out = out || [];
  (node.children || []).forEach(function (c) {
    if (pred(c)) out.push(c);
    findAll(c, pred, out);
  });
  return out;
}
function hasClass(node, cls) { return (' ' + (node.className || '') + ' ').indexOf(' ' + cls + ' ') !== -1; }

// ── One page load ──
function deferred() {
  var d = {};
  d.promise = new Promise(function (res, rej) { d.resolve = res; d.reject = rej; });
  return d;
}
function tick() { return new Promise(function (r) { setImmediate(r); }); }
function settle() { return tick().then(tick).then(tick).then(tick); }

function sampleIssues() {
  return {
    '-a': { title: 'Fall 2026 Newsletter', date: '2026-10', description: '', fileURL: 'https://drive.google.com/file/d/AAA/view', uploadedBy: 'admin@example.com', uploadedAt: '2026-10-20T12:00:00.000Z' },
    '-b': { title: 'Spring 2026 Newsletter', date: '2026-04', description: '', fileURL: 'https://drive.google.com/file/d/BBB/view', uploadedBy: 'admin@example.com', uploadedAt: '2026-04-20T12:00:00.000Z' },
    '-c': { title: 'Old Issue', date: '2025-04', description: '', fileURL: 'https://example.com/issue.pdf', uploadedBy: 'admin@example.com', uploadedAt: '2025-04-20T12:00:00.000Z' }
  };
}

/**
 * opts.url: NEWSLETTER_GATEWAY_URL. opts.script(body): what the fake script replies to one call: a reply
 * object, a Promise of one, 'network' (fetch fails) or 'bad-json' (an HTML error page). opts.confirm: answers.
 */
function load(opts) {
  opts = opts || {};
  var env = { fetchCalls: [], confirms: [], alerts: [], pushes: [], removes: [], tokens: 0, resets: 0 };
  var data = { newsletters: opts.issues || sampleIssues() };
  var valueListeners = [];
  var pushN = 0;

  var byId = {};
  ['nl-status', 'newsletters-admin-tbody', 'nl-title', 'nl-date', 'nl-description', 'nl-link', 'nl-submit',
    'nl-subscribers-summary', 'nl-notify-offer', 'newsletter-form'].forEach(function (id) {
    byId[id] = new FakeEl(id === 'newsletters-admin-tbody' ? 'tbody' : 'div');
  });
  byId['nl-notify-offer'].className = 'nl-notify-offer hidden';
  byId['newsletter-form'].reset = function () {
    env.resets++;
    ['nl-title', 'nl-date', 'nl-description', 'nl-link'].forEach(function (id) { byId[id].value = ''; });
  };
  var document = {
    readyState: 'complete',
    getElementById: function (id) { return byId[id] || null; },
    createElement: function (tag) { return new FakeEl(tag); },
    createTextNode: function (t) { return { nodeType: 3, textContent: String(t), children: [] }; },
    addEventListener: function () {}
  };

  function snap() { var v = JSON.parse(JSON.stringify(data.newsletters)); return { val: function () { return v; } }; }
  function fireValue() { valueListeners.forEach(function (cb) { cb(snap()); }); }
  var user = { email: 'admin@example.com', getIdToken: function () { env.tokens++; return Promise.resolve('test-id-token'); } };
  var authObj = { currentUser: user };
  var firebase = {
    auth: function () { return authObj; },
    database: function () {
      return {
        ref: function (p) {
          return {
            on: function (evt, cb) { valueListeners.push(cb); cb(snap()); },
            push: function (rec) {
              var key = '-new' + (++pushN);
              env.pushes.push({ path: p, key: key, rec: JSON.parse(JSON.stringify(rec)) });
              data.newsletters[key] = JSON.parse(JSON.stringify(rec));
              fireValue(); // Firebase fires local listeners before the write is confirmed
              var done = Promise.resolve();
              return { key: key, then: function (a, b) { return done.then(a, b); } };
            },
            remove: function () {
              env.removes.push(p);
              var id = p.split('/')[1];
              delete data.newsletters[id];
              fireValue();
              return Promise.resolve();
            }
          };
        }
      };
    }
  };

  var confirmAnswers = (opts.confirm || []).slice();
  var sb = {
    console: console,
    document: document,
    firebase: firebase,
    NEWSLETTER_GATEWAY_URL: opts.url === undefined ? SCRIPT_URL : opts.url,
    PortalAuth: {
      requireAdmin: function () { return Promise.resolve({ uid: 'u1', role: 'admin', name: 'Test Admin' }); },
      initNav: function () {},
      getAuth: function () { return authObj; }
    },
    confirm: function (msg) {
      env.confirms.push(msg);
      return confirmAnswers.length ? confirmAnswers.shift() : false;
    },
    alert: function (msg) { env.alerts.push(msg); },
    fetch: function (url, o) {
      var body = JSON.parse(o.body);
      env.fetchCalls.push({ url: url, opts: o, body: body });
      var reply = opts.script ? opts.script(body, env) : { ok: true };
      if (reply === 'network') return Promise.reject(new TypeError('Failed to fetch'));
      return Promise.resolve(reply).then(function (r) {
        return { json: function () { return r === 'bad-json' ? Promise.reject(new SyntaxError('Unexpected token <')) : Promise.resolve(r); } };
      });
    }
  };
  sb.window = sb;
  vm.createContext(sb);
  if (opts.realConfig) {
    delete sb.NEWSLETTER_GATEWAY_URL;
    vm.runInContext(read('js/newsletter-config.js'), sb, { filename: 'js/newsletter-config.js' });
  }
  vm.runInContext(read('portal/js/newsletters.js'), sb, { filename: 'portal/js/newsletters.js' });

  env.sb = sb;
  env.byId = byId;
  env.data = data;
  env.fireValue = fireValue;
  env.summary = function () { return byId['nl-subscribers-summary']; };
  env.rowFor = function (id) {
    var btn = findAll(byId['newsletters-admin-tbody'], function (n) { return n.getAttribute && n.getAttribute('data-email-id') === id; })[0];
    var tr = btn && btn.parentNode && btn.parentNode.parentNode;
    var note = tr && findAll(tr, function (n) { return hasClass(n, 'nl-mail-note'); })[0];
    var del = tr && findAll(tr, function (n) { return hasClass(n, 'btn-delete-newsletter'); })[0];
    return { btn: btn, note: note, del: del, tr: tr };
  };
  env.calls = function (action) { return env.fetchCalls.filter(function (c) { return c.body.action === action; }); };
  return env;
}

function statusReply(o) {
  var r = { ok: true, active: 5, unsubscribed: 1, quotaLeft: 97, issues: {} };
  for (var k in (o || {})) r[k] = o[k];
  return r;
}

// ── Test runner ──
var results = [];
var queue = [];
function test(name, fn) { queue.push({ name: name, fn: fn }); }
function eq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error((label || 'value') + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}
function ok(cond, label) { if (!cond) throw new Error(label || 'expected true'); }

// ── Page markup ──
test('page loads the config before newsletters.js, both with a cache number, and has every element the script uses', function () {
  var html = read('portal/newsletters-admin.html');
  var cfgM = /<script src="\.\.\/js\/newsletter-config\.js\?v=\d+"><\/script>/.exec(html);
  var jsM = /<script src="js\/newsletters\.js\?v=\d+"><\/script>/.exec(html);
  ok(!!cfgM, 'loads ../js/newsletter-config.js?v=N');
  ok(!!jsM, 'loads js/newsletters.js?v=N');
  ok(cfgM && jsM && cfgM.index < jsM.index, 'config loads first');
  ['nl-status', 'newsletters-admin-tbody', 'nl-title', 'nl-date', 'nl-description', 'nl-link', 'nl-submit',
    'nl-subscribers-summary', 'nl-notify-offer', 'newsletter-form'].forEach(function (id) {
    ok(html.indexOf('id="' + id + '"') !== -1, 'has #' + id);
  });
  var main = html.slice(html.indexOf('<main'), html.indexOf('</main>'));
  ok(!/—/.test(main), 'no em dashes in the page copy');
  ok(!/one-click|one click/i.test(main), 'the page does not promise a one-click unsubscribe (the page asks to confirm)');
  ok(main.indexOf('Every email has an unsubscribe link: it opens the Newsletters page, where the person presses Unsubscribe.') !== -1,
    'the page says how unsubscribing works');
});

test('the real js/newsletter-config.js sets an empty URL or an Apps Script /exec URL', function () {
  if (!fs.existsSync(path.join(root, 'js/newsletter-config.js'))) throw new Error('js/newsletter-config.js is missing');
  var env = load({ realConfig: true, script: function () { return statusReply(); } });
  var url = env.sb.NEWSLETTER_GATEWAY_URL;
  eq(typeof url, 'string', 'type');
  ok(url === '' || /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url), 'URL shape: ' + url);
  return settle().then(function () {
    if (url === '') ok(/not deployed yet/.test(env.summary().textContent), 'not-deployed summary with the real config');
    else eq(env.fetchCalls[0].url, url, 'calls the configured URL');
  });
});

test('links the script will email: https Drive or thetatauzd.org only', function () {
  var env = load({ url: '' });
  var f = env.sb.PortalNewsletters.emailableLink;
  eq(f('https://drive.google.com/file/d/X/view'), true, 'drive');
  eq(f('https://www.thetatauzd.org/newsletters/fall.pdf'), true, 'www site');
  eq(f('https://thetatauzd.org/x'), true, 'site');
  eq(f('http://drive.google.com/file/d/X/view'), false, 'http');
  eq(f('https://drive.google.com.example.com/x'), false, 'look-alike host');
  eq(f('https://thetatauzd.org.example.com/x'), false, 'look-alike site');
  eq(f('https://example.com/issue.pdf'), false, 'other host');
  eq(f(''), false, 'empty');
});

// ── Not deployed ──
test('empty URL: summary says the script is not deployed, and the button explains it without calling anything', function () {
  var env = load({ url: '' });
  return settle().then(function () {
    ok(/not deployed yet/.test(env.summary().textContent), 'summary: ' + env.summary().textContent);
    ok(/js\/newsletter-config\.js/.test(env.summary().textContent), 'summary names the config file');
    eq(env.summary().className, 'nl-subscribers-summary muted', 'summary class');
    var row = env.rowFor('-a');
    ok(row.btn, 'row has an Email subscribers button');
    eq(row.btn.textContent, 'Email subscribers', 'label');
    eq(row.btn.disabled, false, 'button stays pressable');
    row.btn.click();
    return settle().then(function () {
      ok(/not deployed yet/.test(row.note.textContent), 'note: ' + row.note.textContent);
      eq(row.note.className, 'nl-mail-note error', 'note class');
      eq(env.fetchCalls.length, 0, 'no fetch');
      eq(env.confirms.length, 0, 'no confirm');
    });
  });
});

// ── Summary ──
test('summary line: active, unsubscribed, quota left; per-issue sent counts; plain-text POST with the ID token', function () {
  var env = load({ script: function () { return statusReply({ issues: { '-a': { sent: 2, total: 5 } } }); } });
  return settle().then(function () {
    eq(env.fetchCalls.length, 1, 'one call on load');
    var c = env.fetchCalls[0];
    eq(c.url, SCRIPT_URL, 'url');
    eq(c.opts.method, 'POST', 'method');
    eq(c.opts.headers['Content-Type'], 'text/plain;charset=utf-8', 'content type (no preflight)');
    eq(c.body.action, 'status', 'action');
    eq(c.body.idToken, 'test-id-token', 'id token');
    eq(env.summary().textContent, '5 active subscribers. 1 unsubscribed. Gmail can send 97 more emails today.', 'summary');
    eq(env.summary().className, 'nl-subscribers-summary', 'summary class');
    eq(env.rowFor('-a').note.textContent, 'Emailed to 2 of 5.', 'sent count on the row');
    eq(env.rowFor('-b').note.textContent, '', 'nothing on an issue never sent');
  });
});

test('summary: singular words and a status error', function () {
  var env = load({ script: function () { return statusReply({ active: 1, unsubscribed: 0, quotaLeft: 1 }); } });
  return settle().then(function () {
    eq(env.summary().textContent, '1 active subscriber. 0 unsubscribed. Gmail can send 1 more email today.', 'summary');
    var env2 = load({ script: function () { return { ok: false, code: 'not-admin', error: 'Only admins can see the list.' }; } });
    return settle().then(function () {
      eq(env2.summary().textContent, 'Could not load the subscriber list. Only admins can see the list.', 'error summary');
      eq(env2.summary().className, 'nl-subscribers-summary error', 'error class');
    });
  });
});

// ── Confirm ──
test('confirm first: "Email N subscribers about <title>?"; cancel sends nothing', function () {
  var env = load({ script: function () { return statusReply(); }, confirm: [false] });
  return settle().then(function () {
    var row = env.rowFor('-b');
    row.btn.click();
    eq(row.btn.disabled, true, 'disabled while checking');
    eq(row.btn.textContent, 'Checking...', 'checking label');
    return settle().then(function () {
      eq(env.confirms.length, 1, 'asked once');
      eq(env.confirms[0], 'Email 5 subscribers about Spring 2026 Newsletter?', 'question');
      eq(env.calls('notify').length, 0, 'no notify after cancel');
      eq(env.calls('status').length, 2, 'status on load and on press');
      eq(row.btn.disabled, false, 'enabled again');
      eq(row.btn.textContent, 'Email subscribers', 'label back');
      eq(row.note.textContent, '', 'no note');
    });
  });
});

test('confirm counts only the subscribers who do not have the issue yet', function () {
  var env = load({ script: function () { return statusReply({ active: 52, issues: { '-a': { sent: 40, total: 52 } } }); }, confirm: [false] });
  return settle().then(function () {
    env.rowFor('-a').btn.click();
    return settle().then(function () {
      eq(env.confirms[0], 'Email 12 subscribers about Fall 2026 Newsletter?', 'question');
    });
  });
});

// ── Success ──
test('success: disabled while sending, sends id/title/url with the token, then "Sent X. Everyone has it."', function () {
  var notify = deferred();
  var quota = 97;
  var env = load({
    confirm: [true],
    script: function (body) {
      if (body.action === 'notify') return notify.promise;
      return statusReply({ quotaLeft: quota });
    }
  });
  return settle().then(function () {
    var row = env.rowFor('-b');
    row.btn.click();
    return settle().then(function () {
      eq(env.confirms[0], 'Email 5 subscribers about Spring 2026 Newsletter?', 'question');
      eq(row.btn.disabled, true, 'disabled while sending');
      eq(row.btn.textContent, 'Sending...', 'sending label');
      row.btn.dispatch('click'); // even a forced second click does nothing while busy
      env.fireValue();           // and a fresh copy of the list keeps the busy state
      var fresh = env.rowFor('-b');
      eq(fresh.btn.disabled, true, 're-rendered button still disabled');
      eq(fresh.btn.textContent, 'Sending...', 're-rendered label');
      return settle().then(function () {
        var n = env.calls('notify');
        eq(n.length, 1, 'one notify');
        eq(n[0].body.idToken, 'test-id-token', 'token');
        eq(n[0].body.newsletterId, '-b', 'newsletterId is the database key');
        eq(n[0].body.title, 'Spring 2026 Newsletter', 'title');
        eq(n[0].body.url, 'https://drive.google.com/file/d/BBB/view', 'url is the fileURL');
        quota = 92;
        notify.resolve({ ok: true, sent: 5, total: 5, alreadySent: 0, remaining: 0, quotaLeft: 92, done: true });
        return settle().then(function () {
          var r = env.rowFor('-b');
          eq(r.note.textContent, 'Sent 5. Everyone has it.', 'result');
          eq(r.note.className, 'nl-mail-note success', 'success class');
          eq(r.btn.disabled, false, 'enabled again');
          eq(r.btn.textContent, 'Email subscribers', 'label back');
          eq(env.calls('status').length, 3, 'summary refreshed after sending');
          eq(env.summary().textContent, '5 active subscribers. 1 unsubscribed. Gmail can send 92 more emails today.', 'summary updated');
        });
      });
    });
  });
});

test('nothing to do: everyone has it, nobody subscribed, or the daily limit is used up (no confirm, no send)', function () {
  var env = load({ script: function () { return statusReply({ issues: { '-a': { sent: 5, total: 5 } } }); } });
  return settle().then(function () {
    var row = env.rowFor('-a');
    row.btn.click();
    return settle();
  }).then(function () {
    eq(env.rowFor('-a').note.textContent, 'Everyone has it.', 'everyone');
    eq(env.confirms.length, 0, 'no confirm');
    eq(env.calls('notify').length, 0, 'no notify');

    var env2 = load({ script: function () { return statusReply({ active: 0, unsubscribed: 0 }); } });
    return settle().then(function () {
      env2.rowFor('-b').btn.click();
      return settle();
    }).then(function () {
      eq(env2.rowFor('-b').note.textContent, 'No one has subscribed yet.', 'nobody');
      eq(env2.confirms.length, 0, 'no confirm');
    });
  }).then(function () {
    var env3 = load({ script: function () { return statusReply({ quotaLeft: 0 }); } });
    return settle().then(function () {
      env3.rowFor('-b').btn.click();
      return settle();
    }).then(function () {
      eq(env3.rowFor('-b').note.textContent, 'Today\'s Gmail limit is used up. 5 still to go: press again tomorrow ' + DAILY + '.', 'quota');
      eq(env3.confirms.length, 0, 'no confirm');
      eq(env3.calls('notify').length, 0, 'no notify');
    });
  });
});

// ── Partial ──
test('partial: more subscribers than today\'s quota; "Sent X. Y still to go: press again tomorrow"', function () {
  var env = load({
    confirm: [true],
    script: function (body) {
      if (body.action === 'notify') return { ok: true, sent: 100, total: 140, alreadySent: 0, remaining: 40, quotaLeft: 0, done: false };
      return statusReply({ active: 140, quotaLeft: 100 });
    }
  });
  return settle().then(function () {
    env.rowFor('-b').btn.click();
    return settle();
  }).then(function () {
    ok(env.confirms[0].indexOf('Email 140 subscribers about Spring 2026 Newsletter?') === 0, 'question starts right: ' + env.confirms[0]);
    ok(/send 100 more today/.test(env.confirms[0]), 'warns about the daily limit');
    var row = env.rowFor('-b');
    eq(row.note.textContent, 'Sent 100. 40 still to go: press again tomorrow ' + DAILY + '.', 'result');
    eq(row.note.className, 'nl-mail-note', 'plain class');
    eq(row.btn.disabled, false, 'enabled again');
  });
});

test('result wording for the other replies', function () {
  var f = load({ url: '' }).sb.PortalNewsletters.resultText;
  eq(f({ sent: 0, remaining: 0, done: true }), 'Everyone has it.', 'already done');
  eq(f({ sent: 0, remaining: 30, quotaLeft: 0, done: false }), 'Nothing sent. Today\'s Gmail limit is used up. 30 still to go: press again tomorrow ' + DAILY + '.', 'no quota');
  eq(f({ sent: 60, remaining: 30, quotaLeft: 20, done: false }), 'Sent 60. 30 still to go: press again to send the rest.', 'stopped early with quota left');
  eq(f({ sent: 0, remaining: 30, quotaLeft: 20, done: false, failed: 0 }),
    'Nothing sent: Gmail is not taking emails right now. 30 still to go: try again in a while, or tomorrow ' + DAILY + '.',
    'nothing sent, nothing refused, quota left: Gmail refused the first send');
  eq(f({ sent: 0, remaining: 5, quotaLeft: 20, done: false, failed: 1 }),
    'Nothing sent: Gmail is not taking emails right now. Gmail turned down 1 address: check the Subscribers tab for typos (the Apps Script log names the rows). ' +
    '5 still to go: try again in a while, or tomorrow ' + DAILY + '.', 'one refused, then Gmail stopped: both said');
  eq(f({ sent: 0, remaining: 2, quotaLeft: 95, done: false, failed: 2 }),
    'Nothing sent. Gmail turned down the 2 addresses still to go. Fix them in the Subscribers tab (the Apps Script log names the rows), ' +
    'or set their status to removed, then press again.', 'every one still to go refused: fix the rows, not "press again to send the rest"');
  eq(f({ sent: 4, remaining: 1, quotaLeft: 90, done: false, failed: 1 }),
    'Sent 4. Gmail turned down the 1 address still to go. Fix it in the Subscribers tab (the Apps Script log names the row), ' +
    'or set its status to removed, then press again.', 'sent some, the only one left was refused');
  eq(f({ sent: 3, remaining: 1, quotaLeft: 0, done: false, failed: 1 }),
    'Sent 3. Gmail turned down the 1 address still to go. Fix it in the Subscribers tab (the Apps Script log names the row), ' +
    'or set its status to removed, then press again tomorrow ' + DAILY + '.', 'the only one left was refused and the quota is used up');
  eq(f({ sent: 4, remaining: 6, quotaLeft: 90, done: false, failed: 1 }),
    'Sent 4. Gmail turned down 1 address: check the Subscribers tab for typos (the Apps Script log names the rows). 6 still to go: press again to send the rest.', 'some refused, others still to go');
  ok(!/press again to send the rest/.test(f({ sent: 0, remaining: 3, quotaLeft: 50, done: false, failed: 3 })), 'all refused never says "press again to send the rest"');
});

// The gateway stops a press after 5 refusals in a row with nothing sent between them
// (MAX_REFUSALS_IN_A_ROW in NewsletterGateway.gs): then Gmail is refusing everything.
var GMAIL_DOWN = 'Nothing sent: Gmail is not taking emails right now. Gmail turned down 5 addresses: ' +
  'check the Subscribers tab for typos (the Apps Script log names the rows). ';
test('Gmail refusing every send is not blamed on the addresses', function () {
  var f = load({ url: '' }).sb.PortalNewsletters.resultText;
  // The reply scripts/newsletter-tests.js gets when every send throws ("Gmail refuses every send").
  eq(f({ ok: true, sent: 0, total: 8, alreadySent: 0, remaining: 8, quotaLeft: 100, done: false, failed: 5 }),
    GMAIL_DOWN + '8 still to go: try again in a while, or tomorrow ' + DAILY + '.', 'every send refused, more to go than were tried');
  eq(f({ sent: 0, remaining: 5, quotaLeft: 100, done: false, failed: 5 }),
    GMAIL_DOWN + '5 still to go: try again in a while, or tomorrow ' + DAILY + '.', 'exactly 5 to go, all refused, nothing sent: Gmail, not "fix those rows"');
  ok(!/Fix (it|them) in the Subscribers tab/.test(f({ sent: 0, remaining: 7, quotaLeft: 60, done: false, failed: 7 })), 'more than 5 refused and nothing sent never says "fix those rows"');
  eq(f({ sent: 0, remaining: 4, quotaLeft: 100, done: false, failed: 4 }),
    'Nothing sent. Gmail turned down the 4 addresses still to go. Fix them in the Subscribers tab (the Apps Script log names the rows), ' +
    'or set their status to removed, then press again.', 'fewer than 5, all refused: plausibly those rows');
  eq(f({ sent: 7, remaining: 5, quotaLeft: 90, done: false, failed: 5 }),
    'Sent 7. Gmail turned down the 5 addresses still to go. Fix them in the Subscribers tab (the Apps Script log names the rows), ' +
    'or set their status to removed, then press again.', 'some sent, then the last 5 refused: those rows');
  // The reply scripts/newsletter-tests.js gets for one bad row with the others fine.
  eq(f({ ok: true, sent: 3, total: 4, alreadySent: 0, remaining: 1, quotaLeft: 97, done: false, failed: 1 }),
    'Sent 3. Gmail turned down the 1 address still to go. Fix it in the Subscribers tab (the Apps Script log names the row), ' +
    'or set its status to removed, then press again.', 'one bad row, the others fine: the rest sent, the refused one named');
});

test('the note after a press where Gmail refused every send', function () {
  var env = load({
    confirm: [true],
    script: function (body) {
      if (body.action === 'notify') return { ok: true, sent: 0, total: 8, alreadySent: 0, remaining: 8, quotaLeft: 100, done: false, failed: 5 };
      return statusReply({ active: 8, quotaLeft: 100 });
    }
  });
  return settle().then(function () {
    env.rowFor('-b').btn.click();
    return settle();
  }).then(function () {
    eq(env.calls('notify').length, 1, 'one notify');
    var row = env.rowFor('-b');
    eq(row.note.textContent, GMAIL_DOWN + '8 still to go: try again in a while, or tomorrow ' + DAILY + '.', 'not-taking-emails wording');
    eq(row.note.className, 'nl-mail-note', 'plain class');
    eq(row.btn.disabled, false, 'enabled again');
  });
});

test('result wording when the script says which refusals were bad addresses (badAddresses)', function () {
  var f = load({ url: '' }).sb.PortalNewsletters.resultText;
  eq(f({ sent: 0, remaining: 8, failed: 5, badAddresses: 0, quotaLeft: 100, done: false }),
    'Nothing sent: Gmail is not taking emails right now. 8 still to go: try again in a while, or tomorrow ' + DAILY + '.', 'Gmail refused everything: no advice to remove rows');
  eq(f({ sent: 0, remaining: 3, failed: 3, badAddresses: 0, quotaLeft: 100, done: false }),
    'Nothing sent: Gmail is not taking emails right now. 3 still to go: try again in a while, or tomorrow ' + DAILY + '.', 'the last 3 refused by a Gmail error: still not blamed on the rows');
  eq(f({ sent: 7, remaining: 3, failed: 3, badAddresses: 0, quotaLeft: 93, done: false }),
    'Sent 7, then Gmail stopped taking emails. 3 still to go: try again in a while, or tomorrow ' + DAILY + '.', 'Gmail stopped partway');
  ok(/^Sent 3\. Gmail turned down the 7 addresses still to go\. Fix them in the Subscribers tab/.test(
    f({ sent: 3, remaining: 7, failed: 7, badAddresses: 7, quotaLeft: 90, done: false })), 'every one still to go is a bad address: fix those rows');
  ok(/^Nothing sent\. Gmail turned down the 7 addresses still to go\./.test(
    f({ sent: 0, remaining: 7, failed: 7, badAddresses: 7, quotaLeft: 90, done: false })), '... even with nothing sent (a bot burst of 7 bad rows)');
  eq(f({ sent: 4, remaining: 2, failed: 1, badAddresses: 1, quotaLeft: 0, done: false }),
    'Sent 4. Gmail turned down 1 address: check the Subscribers tab for typos (the Apps Script log names the rows). 2 still to go: press again tomorrow ' + DAILY + '.', 'one bad row and the daily limit');
});

test('sign-ups since the last email: in the summary and the confirm, only once something was sent', function () {
  var sum = load({ url: '' }).sb.PortalNewsletters.summaryText;
  eq(sum(statusReply({ newSinceLastSend: 5 })), '5 active subscribers. 1 unsubscribed. Gmail can send 97 more emails today.', 'no email sent yet: not shown');
  eq(sum(statusReply({ newSinceLastSend: 3, issues: { '-a': { sent: 2, total: 5 } } })),
    '5 active subscribers. 1 unsubscribed. 3 signed up since the last email. Gmail can send 97 more emails today.', 'shown after a send');
  var env = load({ script: function () { return statusReply({ newSinceLastSend: 3, issues: { '-a': { sent: 2, total: 5 } } }); }, confirm: [false] });
  return settle().then(function () {
    env.rowFor('-b').btn.click();
    return settle();
  }).then(function () {
    eq(env.confirms[0], 'Email 5 subscribers about Spring 2026 Newsletter?\n\n3 people signed up since the last email. ' +
      'If that looks too high, check the Subscribers tab for fake sign-ups first.', 'the confirm names the new sign-ups');
  });
});

// ── Errors ──
test('errors: the script says no, the network fails, or the reply is not JSON; the button comes back', function () {
  var env = load({
    confirm: [true],
    script: function (body) {
      if (body.action === 'notify') return { ok: false, code: 'not-admin', error: 'Only admins can email subscribers.' };
      return statusReply();
    }
  });
  return settle().then(function () {
    env.rowFor('-b').btn.click();
    return settle();
  }).then(function () {
    var row = env.rowFor('-b');
    eq(row.note.textContent, 'Could not email subscribers. Only admins can email subscribers.', 'script error');
    eq(row.note.className, 'nl-mail-note error', 'error class');
    eq(row.btn.disabled, false, 'enabled again');
    eq(row.btn.textContent, 'Email subscribers', 'label back');

    var first = true;
    var env2 = load({ script: function () { if (first) { first = false; return statusReply(); } return 'network'; } });
    return settle().then(function () {
      env2.rowFor('-b').btn.click();
      return settle();
    }).then(function () {
      var r = env2.rowFor('-b');
      eq(r.note.textContent, 'Could not email subscribers. Could not reach the newsletter script. Check your connection and try again.', 'network');
      eq(r.btn.disabled, false, 'enabled again');
      eq(env2.confirms.length, 0, 'no confirm without a status');
    });
  }).then(function () {
    var env3 = load({ confirm: [true], script: function (body) { return body.action === 'notify' ? 'bad-json' : statusReply(); } });
    return settle().then(function () {
      env3.rowFor('-b').btn.click();
      return settle();
    }).then(function () {
      ok(/sent back something unexpected/.test(env3.rowFor('-b').note.textContent), 'bad reply: ' + env3.rowFor('-b').note.textContent);
      eq(env3.rowFor('-b').btn.disabled, false, 'enabled again');
    });
  });
});

test('a link the script would refuse is caught before asking', function () {
  var env = load({ script: function () { return statusReply(); } });
  return settle().then(function () {
    env.rowFor('-c').btn.click();
    return settle();
  }).then(function () {
    var row = env.rowFor('-c');
    ok(/cannot be emailed/.test(row.note.textContent), 'note: ' + row.note.textContent);
    eq(env.fetchCalls.length, 1, 'only the load-time status');
    eq(env.confirms.length, 0, 'no confirm');
  });
});

// ── Publish and delete ──
function fillForm(env, link) {
  env.byId['nl-title'].value = '  Winter 2026 Newsletter ';
  env.byId['nl-date'].value = '2026-12';
  env.byId['nl-description'].value = ' What we did this fall. ';
  env.byId['nl-link'].value = link;
}

test('publish works as before, then offers Email subscribers for the new issue', function () {
  var env = load({
    confirm: [true],
    script: function (body) {
      if (body.action === 'notify') return { ok: true, sent: 5, total: 5, alreadySent: 0, remaining: 0, quotaLeft: 92, done: true };
      return statusReply();
    }
  });
  return settle().then(function () {
    fillForm(env, 'https://drive.google.com/file/d/NEW/view');
    var prevented = false;
    env.byId['newsletter-form'].dispatch('submit', { preventDefault: function () { prevented = true; } });
    ok(prevented, 'submit prevented');
    eq(env.byId['nl-submit'].disabled, true, 'submit disabled while publishing');
    return settle().then(function () {
      eq(env.pushes.length, 1, 'one push');
      var p = env.pushes[0];
      eq(p.path, 'newsletters', 'path');
      eq(p.rec.title, 'Winter 2026 Newsletter', 'title trimmed');
      eq(p.rec.date, '2026-12', 'date');
      eq(p.rec.description, 'What we did this fall.', 'description trimmed');
      eq(p.rec.fileURL, 'https://drive.google.com/file/d/NEW/view', 'fileURL');
      eq(p.rec.uploadedBy, 'admin@example.com', 'uploadedBy');
      ok(/^\d{4}-\d\d-\d\dT/.test(p.rec.uploadedAt), 'uploadedAt');
      eq(Object.keys(p.rec).sort().join(','), 'date,description,fileURL,title,uploadedAt,uploadedBy', 'same fields as before');
      eq(env.byId['nl-status'].textContent, 'Newsletter published.', 'status');
      eq(env.byId['nl-status'].className, 'newsletter-form-status success', 'status class');
      eq(env.resets, 1, 'form reset');
      eq(env.byId['nl-submit'].disabled, false, 'submit enabled again');

      var box = env.byId['nl-notify-offer'];
      eq(box.className, 'nl-notify-offer', 'offer shown');
      var btn = findAll(box, function (n) { return hasClass(n, 'btn-email-subscribers'); })[0];
      ok(btn, 'offer has the button');
      eq(btn.getAttribute('data-email-id'), p.key, 'for the new issue');
      ok(env.rowFor(p.key).btn, 'new issue has a row button too');
      btn.click();
      return settle().then(function () {
        eq(env.confirms[0], 'Email 5 subscribers about Winter 2026 Newsletter?', 'question');
        var n = env.calls('notify');
        eq(n.length, 1, 'notify');
        eq(n[0].body.newsletterId, p.key, 'newsletterId');
        eq(n[0].body.url, 'https://drive.google.com/file/d/NEW/view', 'url');
        var note = findAll(box, function (x) { return hasClass(x, 'nl-mail-note'); })[0];
        eq(note.textContent, 'Sent 5. Everyone has it.', 'offer note');
        eq(env.rowFor(p.key).note.textContent, 'Sent 5. Everyone has it.', 'row note matches');

        // The next publish clears the old offer.
        fillForm(env, 'https://drive.google.com/file/d/NEXT/view');
        env.byId['newsletter-form'].dispatch('submit', { preventDefault: function () {} });
        eq(box.className, 'nl-notify-offer hidden', 'offer hidden while the next one publishes');
        return settle().then(function () {
          var b2 = findAll(box, function (n2) { return hasClass(n2, 'btn-email-subscribers'); })[0];
          eq(b2.getAttribute('data-email-id'), env.pushes[1].key, 'offer moved to the newest issue');
        });
      });
    });
  });
});

test('publish validation and the non-Drive nudge are unchanged', function () {
  var env = load({ url: '', confirm: [false] });
  return settle().then(function () {
    env.byId['newsletter-form'].dispatch('submit', { preventDefault: function () {} });
    eq(env.byId['nl-status'].textContent, 'Title, issue date, and a Drive link are all required.', 'required');
    fillForm(env, 'drive.google.com/file/d/X');
    env.byId['newsletter-form'].dispatch('submit', { preventDefault: function () {} });
    eq(env.byId['nl-status'].textContent, 'That doesn\'t look like a valid link. It should start with https://', 'needs https');
    fillForm(env, 'https://example.com/issue.pdf');
    env.byId['newsletter-form'].dispatch('submit', { preventDefault: function () {} });
    eq(env.confirms[0], 'That link doesn\'t look like a Google Drive link. Publish it anyway?', 'nudge');
    eq(env.pushes.length, 0, 'cancelled, nothing pushed');
  });
});

test('delete works as before', function () {
  var env = load({ url: '', confirm: [false, true] });
  return settle().then(function () {
    var row = env.rowFor('-a');
    row.del.click();
    eq(env.confirms[0], 'Delete "Fall 2026 Newsletter"? This removes it from the public page immediately (the file itself stays in Drive; delete it there separately if you want it fully gone).', 'question');
    eq(env.removes.length, 0, 'cancel keeps it');
    row.del.click();
    return settle().then(function () {
      eq(env.removes.join(','), 'newsletters/-a', 'removed');
      ok(!env.rowFor('-a').btn, 'row gone');
    });
  });
});

test('rows are newest first, and titles go in as text', function () {
  var issues = sampleIssues();
  issues['-x'] = { title: '<img src=x onerror=alert(1)>', date: '2026-11', fileURL: 'https://drive.google.com/file/d/X/view' };
  var env = load({ url: '', issues: issues });
  return settle().then(function () {
    var rows = env.byId['newsletters-admin-tbody'].children;
    eq(rows.map(function (tr) { return tr.children[1].textContent; }).join(','), '2026-11,2026-10,2026-04,2025-04', 'order');
    eq(rows[0].children[0].children[0].textContent, '<img src=x onerror=alert(1)>', 'title is a text node');
    eq(rows[0].children[2].textContent, '—', 'missing upload date shows the old placeholder');
  });
});

// ── Run ──
(function run(i) {
  if (i >= queue.length) {
    var fail = results.filter(function (r) { return !r.ok; }).length;
    console.log('\n' + (results.length - fail) + ' passed, ' + fail + ' failed');
    process.exit(fail ? 1 : 0);
  }
  var t = queue[i];
  Promise.resolve().then(t.fn).then(function () {
    results.push({ ok: true });
    console.log('OK   ' + t.name);
  }, function (err) {
    results.push({ ok: false });
    console.log('FAIL ' + t.name + '\n     ' + (err && err.message || err));
  }).then(function () { run(i + 1); });
})(0);
