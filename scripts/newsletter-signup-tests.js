#!/usr/bin/env node
/**
 * Tests js/newsletter-signup.js (the newsletter email sign-up and unsubscribe on newsletter.html) in node.
 * 1. The pure parts: URL check and fallback, email check, request body, reply -> message, query helpers.
 * 2. The page wiring, against a tiny fake DOM and a fake fetch (no network, no real gateway):
 *    fallback before the URL is set, the subscribe states, double submits, and the ?unsubscribe= flow
 *    (token sent once, never logged, dropped from the address bar once the answer is final and kept
 *    while Try again is offered).
 * 3. The markup in newsletter.html and the shape of js/newsletter-config.js.
 * Test addresses use example.com only. Usage: node scripts/newsletter-signup-tests.js
 */
'use strict';
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var root = path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(root, rel), 'utf8'); }
var SRC = read('js/newsletter-signup.js');
var URL_OK = 'https://script.google.com/macros/s/TEST-DEPLOYMENT/exec';

var pass = 0, fail = 0, lines = [];
function check(name, cond, detail) {
  if (cond) { pass++; lines.push('OK    ' + name); }
  else { fail++; lines.push('FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
}
function eq(name, got, want) { check(name, JSON.stringify(got) === JSON.stringify(want), { got: got, want: want }); }

// ── Fake DOM: just what newsletter-signup.js touches ──
function Node(tag, doc) {
  this.tagName = tag; this.ownerDocument = doc; this.children = []; this.attrs = {}; this.listeners = {};
  this._text = ''; this.className = ''; this.hidden = false; this.disabled = false; this.value = ''; this.href = ''; this.type = '';
}
Object.defineProperty(Node.prototype, 'textContent', {
  get: function () { return this._text + this.children.map(function (c) { return c.textContent; }).join(''); },
  set: function (v) { this.children = []; this._text = String(v); }
});
Object.defineProperty(Node.prototype, 'innerHTML', {
  get: function () { return this.textContent; },
  set: function (v) { if (v !== '') throw new Error('innerHTML is only ever cleared'); this.children = []; this._text = ''; }
});
Object.defineProperty(Node.prototype, 'firstChild', { get: function () { return this.children[0] || null; } });
Node.prototype.appendChild = function (c) { this.children.push(c); c.parentNode = this; return c; };
Node.prototype.setAttribute = function (k, v) { this.attrs[k] = String(v); };
Node.prototype.getAttribute = function (k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; };
Node.prototype.removeAttribute = function (k) { delete this.attrs[k]; };
Node.prototype.addEventListener = function (t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); };
Node.prototype.fire = function (t, ev) { (this.listeners[t] || []).forEach(function (fn) { fn(ev || {}); }); };
Node.prototype.focus = function () { this.ownerDocument.activeElement = this; };
Node.prototype.find = function (pred) {
  if (pred(this)) return this;
  for (var i = 0; i < this.children.length; i++) { var r = this.children[i].find(pred); if (r) return r; }
  return null;
};

function makeDoc() {
  var doc = { readyState: 'complete', activeElement: null, byId: {} };
  function add(id, tag) { var n = new Node(tag, doc); n.id = id; doc.byId[id] = n; return n; }
  var form = add('signup-form', 'form'); form.hidden = true; form.resets = 0;
  var button = new Node('button', doc); button.type = 'submit'; button.textContent = 'Subscribe';
  form.querySelector = function (sel) { return sel === 'button[type="submit"]' ? button : null; };
  form.reset = function () { form.resets++; email.value = ''; name.value = ''; hp.value = ''; };
  var email = add('signup-email', 'input'), name = add('signup-name', 'input'), hp = add('signup-website', 'input');
  add('signup-fallback', 'p');
  add('signup-status', 'div');
  add('unsubscribe-notice', 'div');
  doc.button = button;
  doc.getElementById = function (id) { return doc.byId[id] || null; };
  doc.createElement = function (tag) { return new Node(tag, doc); };
  doc.createTextNode = function (t) { var n = new Node('#text', doc); n._text = String(t); return n; };
  doc.addEventListener = function () {};
  return doc;
}

/** Loads the script into a fresh window. replies: a list of fetch outcomes, used in order. */
function boot(opts) {
  var doc = makeDoc();
  var logged = [];
  var calls = [];
  var replaced = [];
  var replies = (opts.replies || []).slice();
  function capture() { logged.push(Array.prototype.slice.call(arguments).map(String).join(' ')); }
  var sb = {
    console: { log: capture, info: capture, warn: capture, error: capture, debug: capture },
    setTimeout: setTimeout, clearTimeout: clearTimeout, JSON: JSON, encodeURIComponent: encodeURIComponent, decodeURIComponent: decodeURIComponent,
    NEWSLETTER_GATEWAY_URL: opts.url,
    document: doc,
    location: { pathname: '/newsletter', search: opts.search || '', hash: opts.hash || '' },
    history: { state: null, replaceState: function (s, t, u) { replaced.push(u); } },
    fetch: function (url, init) {
      calls.push({ url: url, init: init, body: JSON.parse(init.body) });
      var r = replies.length ? replies.shift() : { json: { ok: true } };
      if (r.hold) return r.hold;
      if (r.reject) return Promise.reject(new Error('offline'));
      return Promise.resolve({ json: function () { return r.notJson ? Promise.reject(new SyntaxError('bad json')) : Promise.resolve(r.json); } });
    }
  };
  if (opts.noFetch) delete sb.fetch;
  sb.window = sb;
  vm.runInContext(SRC, vm.createContext(sb), { filename: 'js/newsletter-signup.js' });
  return { sb: sb, doc: doc, $: doc.getElementById, calls: calls, logged: logged, replaced: replaced, api: sb.NewsletterSignup };
}
function flush() { return new Promise(function (r) { setTimeout(r, 0); }); }
function submit(env) { var prevented = false; env.$('signup-form').fire('submit', { preventDefault: function () { prevented = true; } }); return prevented; }

// ── 1. Pure parts ──
var api = boot({ url: '' }).api;

check('isConfigured: empty string is not configured', api.isConfigured('') === false);
check('isConfigured: blanks only are not configured', api.isConfigured('   ') === false);
check('isConfigured: undefined is not configured', api.isConfigured(undefined) === false);
check('isConfigured: http is refused', api.isConfigured('http://script.google.com/macros/s/x/exec') === false);
check('isConfigured: javascript: is refused', api.isConfigured('javascript:alert(1)') === false);
check('isConfigured: a URL with a space is refused', api.isConfigured('https://script.google.com/a b') === false);
check('isConfigured: the Apps Script /exec URL is accepted', api.isConfigured(URL_OK) === true);
check('isConfigured: surrounding blanks are ignored', api.isConfigured('  ' + URL_OK + '  ') === true);
eq('initialView: empty URL shows the mailto fallback', api.initialView(''), 'fallback');
eq('initialView: missing URL shows the mailto fallback', api.initialView(undefined), 'fallback');
eq('initialView: a real URL shows the form', api.initialView(URL_OK), 'form');

eq('normalizeEmail trims and lowercases', api.normalizeEmail('  Pat.Doe@Example.COM \n'), 'pat.doe@example.com');
['name@example.com', 'first.last+news@mail.example.com', '  Name@Example.com ', 'a_b-c@example.co.uk', "o'neil@example.com", 'x@example.museum']
  .forEach(function (e) { check('isValidEmail accepts ' + JSON.stringify(e), api.isValidEmail(e) === true); });
['', '   ', 'name', 'name@', '@example.com', 'name@example', 'name@example.c', 'na me@example.com', 'name@@example.com',
  'name@.example.com', 'name@example..com', 'name@-example.com', '<x>@example.com', 'a@b,c.com', 'a@example.com;b@example.com',
  new Array(250).join('a') + '@example.com', null, undefined]
  .forEach(function (e) { check('isValidEmail refuses ' + JSON.stringify(e === undefined ? 'undefined' : e), api.isValidEmail(e) === false); });

eq('subscribePayload: normalised body', api.subscribePayload({ email: ' Pat@Example.com ', name: '  Pat   Q ', website: '' }),
  { action: 'subscribe', email: 'pat@example.com', name: 'Pat Q', website: '', source: 'newsletter-page' });
eq('subscribePayload: name is cut to 80 characters', api.subscribePayload({ email: 'a@example.com', name: new Array(101).join('n') }).name.length, 80);
eq('subscribePayload: missing fields become empty strings', api.subscribePayload({}),
  { action: 'subscribe', email: '', name: '', website: '', source: 'newsletter-page' });
eq('subscribePayload: the honeypot is sent exactly as typed', api.subscribePayload({ email: 'a@example.com', website: ' http://spam ' }).website, ' http://spam ');

function sm(r) { return api.subscribeMessage(r); }
check('subscribe ok -> "You\'re on the list."', sm({ ok: true, status: 'subscribed' }).kind === 'ok' && sm({ ok: true, status: 'subscribed' }).text.indexOf("You're on the list.") === 0);
check('subscribe ok without a status still says on the list', sm({ ok: true }).text.indexOf("You're on the list.") === 0);
eq('subscribe already', sm({ ok: true, status: 'already' }), { kind: 'ok', text: "You're already on the list." });
check('subscribe resubscribed', sm({ ok: true, status: 'resubscribed' }).text.indexOf("You're back on the list.") === 0);
check('invalid-email marks the email field', sm({ ok: false, code: 'invalid-email' }).field === 'email' && sm({ ok: false, code: 'invalid-email' }).kind === 'error');
check('rate-limited asks to try later and offers the chapter email', /try again later/.test(sm({ ok: false, code: 'rate-limited', error: 'x' }).text) && !!sm({ ok: false, code: 'rate-limited' }).mailto);
check('held: an address an officer removed is not added, and says who to email', sm({ ok: true, status: 'held' }).kind === 'error' && /can't be added/.test(sm({ ok: true, status: 'held' }).text) && /get back on/.test(sm({ ok: true, status: 'held' }).mailto.after));
check('network error offers the chapter email', /couldn't reach/.test(sm({ ok: false, code: 'network' }).text) && !!sm({ ok: false, code: 'network' }).mailto);
check('bot gets the generic error and is not told why', /Something went wrong/.test(sm({ ok: false, code: 'bot' }).text) && !/bot/i.test(JSON.stringify(sm({ ok: false, code: 'bot' }))));
check('null reply gets the generic error', sm(null).kind === 'error' && /Something went wrong/.test(sm(null).text));
check('ok:false with no code gets the generic error', /Something went wrong/.test(sm({ ok: false, error: 'Unknown action' }).text));
check('the gateway\'s own error text is never shown', JSON.stringify(sm({ ok: false, code: 'zzz', error: 'Exception: secret detail' })).indexOf('secret') === -1);

function um(r) { return api.unsubscribeMessage(r); }
check('unsubscribed', um({ ok: true, status: 'unsubscribed' }).title === "You're unsubscribed." && um({ ok: true, status: 'unsubscribed' }).resubscribe === true);
check('already unsubscribed', um({ ok: true, status: 'already' }).title === "You're already unsubscribed.");
check('unknown-token: link did not work, no retry', /didn't work/.test(um({ ok: false, code: 'unknown-token' }).title) && !um({ ok: false, code: 'unknown-token' }).retry && !!um({ ok: false, code: 'unknown-token' }).mailto);
check('network: retry offered', um({ ok: false, code: 'network' }).retry === true && /not unsubscribed yet/.test(um({ ok: false, code: 'network' }).text));
check('not-configured: points to the chapter email', um({ ok: false, code: 'not-configured' }).mailto.before === 'Email ');
check('anything else: retry offered', um({ ok: false, code: 'bad-reply' }).retry === true && um(null).retry === true);

var allText = [];
[{ ok: true, status: 'subscribed' }, { ok: true, status: 'already' }, { ok: true, status: 'resubscribed' }, { ok: true, status: 'held' }, { ok: false, code: 'invalid-email' },
  { ok: false, code: 'rate-limited' }, { ok: false, code: 'network' }, { ok: false, code: 'bot' }, null]
  .forEach(function (r) { allText.push(JSON.stringify(sm(r))); });
[{ ok: true, status: 'unsubscribed' }, { ok: true, status: 'already' }, { ok: false, code: 'unknown-token' }, { ok: false, code: 'network' },
  { ok: false, code: 'not-configured' }, null]
  .forEach(function (r) { allText.push(JSON.stringify(um(r))); });
allText.push(JSON.stringify(api.CONFIRM_UNSUBSCRIBE));
check('no message uses an em dash', allText.join('').indexOf('\u2014') === -1);

eq('readParam: plain', api.readParam('?unsubscribe=abc12345', 'unsubscribe'), 'abc12345');
eq('readParam: among others, percent-decoded', api.readParam('?a=1&unsubscribe=abc%2Bdef&b=2', 'unsubscribe'), 'abc+def');
eq('readParam: a literal + stays a +', api.readParam('?unsubscribe=ab+cd', 'unsubscribe'), 'ab+cd');
eq('readParam: no value', api.readParam('?unsubscribe', 'unsubscribe'), '');
eq('readParam: absent', api.readParam('?x=1', 'unsubscribe'), null);
eq('readParam: empty search', api.readParam('', 'unsubscribe'), null);
eq('readParam: broken percent code comes back raw', api.readParam('?unsubscribe=%E0%A4%A', 'unsubscribe'), '%E0%A4%A');
eq('readParam: does not match a longer name', api.readParam('?unsubscribed=1', 'unsubscribe'), null);
eq('stripParam: only param', api.stripParam('?unsubscribe=abc', 'unsubscribe'), '');
eq('stripParam: keeps the others in order', api.stripParam('?a=1&unsubscribe=abc&b=2', 'unsubscribe'), '?a=1&b=2');
eq('stripParam: removes every copy', api.stripParam('?unsubscribe=1&unsubscribe=2', 'unsubscribe'), '');
eq('stripParam: nothing to strip', api.stripParam('?a=1', 'unsubscribe'), '?a=1');
eq('stripParam: empty', api.stripParam('', 'unsubscribe'), '');

check('validToken: UUID', api.validToken('0f8fad5b-d9cb-469f-a165-70867728950e'));
check('validToken: hex', api.validToken('9b2f4c0e7a1d4e5f8a9b0c1d2e3f4a5b'));
check('validToken: base64url and base64', api.validToken('AbC_dEf-123456') && api.validToken('AbC+dEf/123456=='));
check('validToken: too short', !api.validToken('abc'));
check('validToken: too long', !api.validToken(new Array(300).join('a')));
check('validToken: markup', !api.validToken('abcdefgh<script>'));
check('validToken: spaces', !api.validToken('abcd efgh ijkl'));
check('validToken: not a string', !api.validToken(null) && !api.validToken(12345678));
check('the script never calls console', !/console\./.test(SRC));

// ── 2. Page wiring ──
var scenarios = [];
function scenario(name, fn) { scenarios.push({ name: name, fn: fn }); }

scenario('fallback before the URL is set', function () {
  var env = boot({ url: '' });
  check('no URL: form stays hidden', env.$('signup-form').hidden === true);
  check('no URL: mailto line stays visible', env.$('signup-fallback').hidden === false);
  check('no URL: submit handler is not attached', !(env.$('signup-form').listeners.submit || []).length);
  check('no URL: nothing is fetched', env.calls.length === 0);
  check('no URL: no unsubscribe notice without the param', env.$('unsubscribe-notice').children.length === 0);
  var env2 = boot({ url: undefined });
  check('config missing entirely: form stays hidden', env2.$('signup-form').hidden === true && env2.$('signup-fallback').hidden === false);
});

scenario('form shows once the URL is set', function () {
  var env = boot({ url: '  ' + URL_OK + ' ' });
  check('URL set: form shown', env.$('signup-form').hidden === false);
  check('URL set: mailto line hidden', env.$('signup-fallback').hidden === true);
});

scenario('invalid email is caught before sending', function () {
  var env = boot({ url: URL_OK });
  env.$('signup-email').value = 'not-an-email';
  check('submit is prevented', submit(env) === true);
  check('invalid: nothing fetched', env.calls.length === 0);
  check('invalid: email marked aria-invalid', env.$('signup-email').getAttribute('aria-invalid') === 'true');
  check('invalid: focus moves to the email box', env.doc.activeElement === env.$('signup-email'));
  check('invalid: message shown', /valid email/.test(env.$('signup-status').textContent));
  check('invalid: error box class', env.$('signup-status').children[0].className === 'signup-msg signup-msg--error');
  env.$('signup-email').fire('input');
  check('typing clears aria-invalid', env.$('signup-email').getAttribute('aria-invalid') === null);
});

scenario('subscribe happy path', function () {
  var release;
  var hold = new Promise(function (r) { release = r; });
  var env = boot({ url: URL_OK, replies: [{ hold: hold }] });
  env.$('signup-email').value = ' Pat@Example.com ';
  env.$('signup-name').value = 'Pat';
  submit(env);
  check('one request sent', env.calls.length === 1);
  var c = env.calls[0] || { init: { headers: {} }, body: {} };
  eq('sent to the gateway URL', c.url, URL_OK);
  eq('POST', c.init.method, 'POST');
  eq('text/plain body (no preflight)', c.init.headers['Content-Type'], 'text/plain;charset=utf-8');
  eq('body', c.body, { action: 'subscribe', email: 'pat@example.com', name: 'Pat', website: '', source: 'newsletter-page' });
  check('sending: button disabled', env.doc.button.disabled === true);
  eq('sending: button label', env.doc.button.textContent, 'Subscribing\u2026');
  check('sending: status says so', /Signing you up/.test(env.$('signup-status').textContent));
  submit(env);
  check('a second press while sending sends nothing', env.calls.length === 1);
  release({ json: function () { return Promise.resolve({ ok: true, status: 'subscribed' }); } });
  return flush().then(flush).then(function () {
    check('done: button enabled again', env.doc.button.disabled === false);
    eq('done: button label restored', env.doc.button.textContent, 'Subscribe');
    check('done: success message', env.$('signup-status').textContent.indexOf("You're on the list.") === 0);
    check('done: ok box class', env.$('signup-status').children[0].className === 'signup-msg signup-msg--ok');
    check('done: form cleared', env.$('signup-form').resets === 1);
  });
});

function replyCase(label, reply, test) {
  scenario(label, function () {
    var env = boot({ url: URL_OK, replies: [reply] });
    env.$('signup-email').value = 'pat@example.com';
    submit(env);
    return flush().then(flush).then(function () { test(env); });
  });
}
replyCase('already on the list', { json: { ok: true, status: 'already' } }, function (env) {
  eq('already: message', env.$('signup-status').textContent, "You're already on the list.");
});
replyCase('server says invalid email', { json: { ok: false, code: 'invalid-email', error: 'Bad email' } }, function (env) {
  check('server invalid: aria-invalid', env.$('signup-email').getAttribute('aria-invalid') === 'true');
  check('server invalid: form not cleared', env.$('signup-form').resets === 0 && env.$('signup-email').value === 'pat@example.com');
});
replyCase('rate limited', { json: { ok: false, code: 'rate-limited', error: 'Slow down' } }, function (env) {
  check('rate-limited: message', /try again later/.test(env.$('signup-status').textContent));
  check('rate-limited: button usable again', env.doc.button.disabled === false);
});
replyCase('network failure', { reject: true }, function (env) {
  var box = env.$('signup-status');
  check('network: message', /couldn't reach/.test(box.textContent));
  var link = box.find(function (n) { return n.tagName === 'a'; });
  check('network: mailto link to the chapter email', !!link && link.href.indexOf('mailto:sotheta@mailbox.sc.edu') === 0 && link.textContent === 'sotheta@mailbox.sc.edu');
  check('network: button usable again', env.doc.button.disabled === false);
});
replyCase('reply that is not JSON', { notJson: true }, function (env) {
  check('not JSON: generic message', /Something went wrong/.test(env.$('signup-status').textContent));
});

scenario('no fetch in this browser', function () {
  var env = boot({ url: URL_OK, noFetch: true });
  env.$('signup-email').value = 'pat@example.com';
  submit(env);
  return flush().then(function () {
    check('no fetch: network message, no crash', /couldn't reach/.test(env.$('signup-status').textContent));
  });
});

var TOKEN = '0f8fad5b-d9cb-469f-a165-70867728950e';
function noTokenLogged(env, label) {
  check(label + ': token never logged', env.logged.join('\n').indexOf(TOKEN) === -1 && env.logged.length === 0, env.logged);
}

function pressUnsubscribe(env) {
  var btn = env.$('unsubscribe-notice').find(function (n) { return n.tagName === 'button'; });
  if (btn) btn.fire('click');
  return btn;
}

scenario('unsubscribe: success', function () {
  var env = boot({ url: URL_OK, search: '?utm=x&unsubscribe=' + TOKEN, hash: '#top', replies: [{ json: { ok: true, status: 'unsubscribed' } }] });
  check('unsubscribe: nothing sent on page load (mail filters open links)', env.calls.length === 0);
  var ask = env.$('unsubscribe-notice');
  check('unsubscribe: asks first', ask.textContent.indexOf('Unsubscribe from newsletter emails?') === 0);
  eq('unsubscribe: address bar keeps the token until the press', env.replaced, []);
  var btn = pressUnsubscribe(env);
  check('unsubscribe: an Unsubscribe button', !!btn && btn.textContent === 'Unsubscribe' && btn.type === 'button' && /btn-primary/.test(btn.className));
  check('unsubscribe: one request', env.calls.length === 1);
  check('unsubscribe: focus moves to the notice', env.doc.activeElement === ask);
  eq('unsubscribe: body', env.calls[0] && env.calls[0].body, { action: 'unsubscribe', token: TOKEN });
  check('unsubscribe: pending message', /Taking you off/.test(env.$('unsubscribe-notice').textContent));
  check('unsubscribe: the form still works alongside', env.$('signup-form').hidden === false);
  return flush().then(flush).then(function () {
    var box = env.$('unsubscribe-notice');
    check('unsubscribe: confirmation shown', box.textContent.indexOf("You're unsubscribed.") === 0);
    check('unsubscribe: notice class', box.children[0].className === 'signup-notice signup-notice--ok');
    var link = box.find(function (n) { return n.tagName === 'a'; });
    check('unsubscribe: sign-up-again link', !!link && link.href === '#subscribe');
    eq('unsubscribe: token dropped, other params and hash kept', env.replaced, ['/newsletter?utm=x#top']);
    noTokenLogged(env, 'unsubscribe');
  });
});

scenario('unsubscribe: already', function () {
  var env = boot({ url: URL_OK, search: '?unsubscribe=' + TOKEN, replies: [{ json: { ok: true, status: 'already' } }] });
  pressUnsubscribe(env);
  return flush().then(flush).then(function () {
    check('already: message', env.$('unsubscribe-notice').textContent.indexOf("You're already unsubscribed.") === 0);
    eq('already: address bar cleaned', env.replaced, ['/newsletter']);
  });
});

scenario('unsubscribe: unknown token', function () {
  var env = boot({ url: URL_OK, search: '?unsubscribe=' + TOKEN, replies: [{ json: { ok: false, code: 'unknown-token', error: 'No such token' } }] });
  pressUnsubscribe(env);
  return flush().then(flush).then(function () {
    var box = env.$('unsubscribe-notice');
    check('unknown: message', /didn't work/.test(box.textContent));
    check('unknown: no retry button', !box.find(function (n) { return n.tagName === 'button'; }));
    eq('unknown: address bar cleaned', env.replaced, ['/newsletter']);
    noTokenLogged(env, 'unknown');
  });
});

scenario('unsubscribe: malformed token is not sent', function () {
  var env = boot({ url: URL_OK, search: '?unsubscribe=%3Cscript%3E' });
  check('malformed: nothing fetched', env.calls.length === 0);
  check('malformed: no Unsubscribe button', !env.$('unsubscribe-notice').find(function (n) { return n.tagName === 'button'; }));
  check('malformed: link did not work', /didn't work/.test(env.$('unsubscribe-notice').textContent));
  eq('malformed: address bar cleaned', env.replaced, ['/newsletter']);
});

scenario('unsubscribe: before the URL is set', function () {
  var env = boot({ url: '', search: '?unsubscribe=' + TOKEN });
  check('not configured: nothing fetched', env.calls.length === 0);
  var box = env.$('unsubscribe-notice');
  check('not configured: points to the chapter email', /take you off the list/.test(box.textContent) && box.textContent.indexOf('sotheta@mailbox.sc.edu') !== -1);
  eq('not configured: address bar cleaned', env.replaced, ['/newsletter']);
  check('not configured: form still hidden', env.$('signup-form').hidden === true);
});

scenario('unsubscribe: network failure, then Try again', function () {
  var env = boot({ url: URL_OK, search: '?unsubscribe=' + TOKEN, replies: [{ reject: true }, { json: { ok: true, status: 'unsubscribed' } }] });
  pressUnsubscribe(env);
  return flush().then(flush).then(function () {
    var box = env.$('unsubscribe-notice');
    check('network: not unsubscribed yet', /not unsubscribed yet/.test(box.textContent));
    eq('network: token kept in the address bar, so a reload still offers Unsubscribe', env.replaced, []);
    var btn = box.find(function (n) { return n.tagName === 'button'; });
    check('network: Try again button', !!btn && btn.textContent === 'Try again' && btn.type === 'button');
    if (btn) btn.fire('click');
    check('retry: second request with the same token', env.calls.length === 2 && env.calls[1].body.token === TOKEN);
    check('retry: focus moves to the notice', env.doc.activeElement === box);
    return flush().then(flush).then(function () {
      check('retry: confirmation shown', box.textContent.indexOf("You're unsubscribed.") === 0);
      eq('retry: token dropped once it worked', env.replaced, ['/newsletter']);
      noTokenLogged(env, 'retry');
    });
  });
});

function retryKeepsToken(label, reply) {
  scenario('unsubscribe: ' + label + ' keeps the token', function () {
    var env = boot({ url: URL_OK, search: '?unsubscribe=' + TOKEN, replies: [reply] });
    pressUnsubscribe(env);
    return flush().then(flush).then(function () {
      var box = env.$('unsubscribe-notice');
      check(label + ': not unsubscribed yet', /not unsubscribed yet/.test(box.textContent));
      check(label + ': Try again button', !!box.find(function (n) { return n.tagName === 'button' && n.textContent === 'Try again'; }));
      eq(label + ': token kept in the address bar', env.replaced, []);
      noTokenLogged(env, label);
    });
  });
}
retryKeepsToken('busy', { json: { ok: false, code: 'busy', error: 'We are busy.' } });
retryKeepsToken('server-error', { json: { ok: false, code: 'server-error', error: 'Something went wrong.' } });
retryKeepsToken('a reply that is not JSON', { notJson: true });

scenario('no unsubscribe param: address bar untouched', function () {
  var env = boot({ url: URL_OK, search: '?a=1' });
  eq('no param: no replaceState', env.replaced, []);
  check('no param: nothing fetched', env.calls.length === 0);
});

// ── 3. Markup and config ──
function markupChecks() {
  var html = read('newsletter.html');
  var form = (html.match(/<form id="signup-form"[\s\S]*?<\/form>/) || [''])[0];
  check('page: form starts hidden and novalidate', /<form id="signup-form"[^>]*\bnovalidate\b[^>]*\bhidden\b/.test(form));
  var email = (form.match(/<input id="signup-email"[^>]*>/) || [''])[0];
  check('page: email input type=email', /type="email"/.test(email));
  check('page: email input autocomplete=email', /autocomplete="email"/.test(email));
  check('page: email input required', /\brequired\b/.test(email));
  check('page: email input has a label', /<label for="signup-email">/.test(form));
  check('page: first name input with a label', /<label for="signup-name">/.test(form) && /<input id="signup-name"[^>]*autocomplete="given-name"/.test(form));
  var hp = (form.match(/<input id="signup-website"[^>]*>/) || [''])[0];
  check('page: honeypot named website', /name="website"/.test(hp));
  check('page: honeypot tabindex -1, autocomplete off, aria-hidden', /tabindex="-1"/.test(hp) && /autocomplete="off"/.test(hp) && /aria-hidden="true"/.test(hp));
  check('page: honeypot wrapper is hidden from people', /<div class="signup-hp" aria-hidden="true">/.test(form));
  check('page: Subscribe button', /<button type="submit" class="btn-primary signup-submit">Subscribe<\/button>/.test(form));
  check('page: status is an aria-live region', /<div id="signup-status"[^>]*role="status"[^>]*aria-live="polite"/.test(html));
  check('page: unsubscribe notice is an aria-live region', /<div id="unsubscribe-notice"[^>]*role="status"[^>]*aria-live="polite"/.test(html));
  check('page: unsubscribe notice starts empty (it takes no space until it has a message)', /<div id="unsubscribe-notice"[^>]*><\/div>/.test(html));
  var noscript = (html.match(/<noscript>[\s\S]*?<\/noscript>/g) || []).filter(function (n) { return /unsubscribe/i.test(n); })[0] || '';
  var nsText = noscript.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  check('page: a noscript note for people who came to unsubscribe', nsText === "Came here to unsubscribe? This page needs JavaScript for that. Reply to any newsletter email, or email sotheta@mailbox.sc.edu, and we'll take you off the list.", nsText);
  check('page: the noscript note links the chapter email', /<a href="mailto:sotheta@mailbox\.sc\.edu[^"]*">sotheta@mailbox\.sc\.edu<\/a>/.test(noscript));
  check('page: the noscript note sits right after the unsubscribe notice, outside it',
    /<div id="unsubscribe-notice"[^>]*><\/div>\s*(<!--[\s\S]*?-->\s*)?<noscript>/.test(html));
  check('page: no em dash in the noscript note', noscript.indexOf('—') === -1 && noscript.indexOf('&mdash;') === -1);
  check('page: fallback mailto line', /<p id="signup-fallback"[^>]*>Email <a href="mailto:sotheta@mailbox\.sc\.edu[^"]*">sotheta@mailbox\.sc\.edu<\/a> to get on the list\.<\/p>/.test(html));
  check('page: section anchor #subscribe', /<section id="subscribe"/.test(html) && /href="#subscribe"/.test(html));
  var ci = html.indexOf('/js/newsletter-config.js?v='), si = html.indexOf('/js/newsletter-signup.js?v=');
  check('page: config loads before the sign-up script', ci !== -1 && si !== -1 && ci < si);
  check('page: design.css is bumped past v=1', /css\/design\.css\?v=([2-9]|\d\d+)"/.test(html));
  check('page: archive code still there', html.indexOf("firebase.database().ref('newsletters')") !== -1 && html.indexOf('id="newsletter-grid"') !== -1);
  check('page: no em dash in the new section', ((html.match(/<section id="subscribe"[\s\S]*?<\/section>/) || [''])[0]).indexOf('\u2014') === -1);

  var cfg = read('js/newsletter-config.js');
  var cs = { window: {} };
  vm.runInContext(cfg, vm.createContext(cs));
  var u = cs.window.NEWSLETTER_GATEWAY_URL;
  check('config: NEWSLETTER_GATEWAY_URL is a string', typeof u === 'string');
  check('config: empty, or an https URL', u === '' || api.isConfigured(u), u);

  var emails = [];
  ['newsletter.html', 'js/newsletter-config.js', 'js/newsletter-signup.js', 'scripts/newsletter-signup-tests.js'].forEach(function (f) {
    (read(f).match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []).forEach(function (e) { emails.push(e.toLowerCase()); });
  });
  // The chapter's two addresses, or a made-up one on an example domain (including the broken ones tested above).
  var allowed = /^(sotheta@mailbox\.sc\.edu|thetatauusc@gmail\.com)$|@[^@]*example[^@]*$/;
  var bad = emails.filter(function (e) { return !allowed.test(e); });
  check('no real email addresses besides the chapter ones', bad.length === 0, bad);
}

// ── Run ──
scenarios.reduce(function (p, s) {
  return p.then(function () { return s.fn(); }).catch(function (err) { check(s.name + ' threw', false, String(err && err.stack || err)); });
}, Promise.resolve()).then(function () {
  markupChecks();
  lines.forEach(function (l) { console.log(l); });
  console.log('');
  console.log(fail ? fail + ' FAILED, ' + pass + ' passed' : 'All ' + pass + ' tests passed');
  process.exit(fail ? 1 : 0);
});
