#!/usr/bin/env node
/**
 * Drives the real PortalSync runner (portal/js/sheet-sync.js) against an in-memory database and a fake
 * gateway. The fake database enforces the rules the runner depends on (firebase-database.rules.json):
 *   ledger/{term}            written only to clear it (admin, !newData.exists())
 *   ledger/{term}/{uid}/{id} only when it does not exist yet, with type, createdBy = the signed-in admin, createdAt
 *   service, excuses, excuseFlags  their .validate rules
 *   settings/mode            admins only; source is 'sheet' or 'site'
 * and Firebase's own behaviour: no overlapping paths in one update, a transaction that first runs on a cold
 * (null) cache, one connection per page with its own auth and onDisconnect queue (page.close() runs it, like a
 * closed tab or a dropped connection; the runner registers none, and the tests check that), and live listeners.
 * With db.tick on, once() is answered from the server queue too, in the same message as a listener still waiting
 * for its first value and after it: the order the real SDK (9.22.0) uses, which left the preview banner stuck.
 * db.failOn (a RegExp) makes writes to matching paths fail, db.hangOn makes them never answer (a page that
 * stopped mid-write), and db.onRead(path, conn) may return a Promise that a once() waits for (to make something
 * happen between two of a run's writes). A page can also have its own clock (offset, or fake timers
 * moved by page.clock.advance), window events (page.fire('beforeunload' | 'pagehide')), a gateway that waits for
 * a gate or never answers, and js/ops-db.js with a small fake DOM for the preview banner.
 * Uses the made-up export from portal/sync-tests.html. Never touches the live database.
 * Usage: node scripts/sync-runner-tests.js
 */
'use strict';
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var root = path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(root, rel), 'utf8'); }
function clone(v) { return v === undefined || v === null ? null : JSON.parse(JSON.stringify(v)); }

// ── The fixture, from the test page ──
var fx = (function () {
  var html = read('portal/sync-tests.html');
  var code = html.match(/<script id="sync-tests">([\s\S]*?)<\/script>/)[1];
  var sb = { console: console }; sb.window = sb;
  sb.document = { getElementById: function () { return {}; } };
  var ctx = vm.createContext(sb);
  vm.runInContext(read('portal/js/ops-core.js'), ctx);
  vm.runInContext(read('portal/js/sheet-sync-core.js'), ctx);
  vm.runInContext(code, ctx);
  if (sb.__syncTestResults.fail) { console.error('portal/sync-tests.html has failures; run node scripts/sync-tests.js first.'); process.exit(2); }
  return sb.__syncFixture;
})();

// ── A tiny Realtime Database ──
/**
 * Every page gets its own connection (conn): its own auth uid and its own onDisconnect queue, which
 * db.disconnect(conn) runs on the "server", like Firebase when a tab closes. Listeners (ref.on) get their
 * first value and every change later, from the server queue (a macrotask). With db.tick on, once() also
 * waits for the server queue, so a once() that joins a listener still waiting for its first value is
 * answered in the same server message, after the listener's callback: what the real SDK does.
 */
function FakeDb(authUid) {
  this.data = {};
  this.auth = authUid;
  this.admins = { u_admin: true, u_admin2: true };
  this.writes = [];
  this.log = [];          // { path, value } for every write, in order
  this.pushN = 0;
  this.failOn = null;
  this.hangOn = null;     // a RegExp: writes to matching paths never answer (a page that stopped mid-write)
  this.onRead = null;     // function (path, conn): a Promise to wait for before a once() reads, or null
  this.tick = false;
  this.queue = [];
  this.flushing = false;
  this.listeners = [];
  this.connN = 0;
}
FakeDb.prototype.connect = function (uid) { return { id: ++this.connN, uid: uid || this.auth, ondc: [], closed: false }; };
FakeDb.prototype.get = function (p) {
  var parts = p ? p.split('/') : [], v = this.data;
  for (var i = 0; i < parts.length; i++) { if (v === null || typeof v !== 'object' || !(parts[i] in v)) return null; v = v[parts[i]]; }
  return toArrays(clone(v));
};
/** Firebase reads an object whose keys are 0..n-1 back as an array. */
function toArrays(v) {
  if (v === null || typeof v !== 'object') return v;
  var keys = Object.keys(v);
  keys.forEach(function (k) { v[k] = toArrays(v[k]); });
  if (keys.length && keys.every(function (k, i) { return String(i) === k; })) return keys.map(function (k) { return v[k]; });
  return v;
}
function prune(v) {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'object') return v;
  var keys = Object.keys(v), any = false, out = {};
  keys.forEach(function (k) { var x = prune(v[k]); if (x !== null) { out[k] = x; any = true; } });
  return any ? out : null;
}
function snap(v) { return { val: function () { return v; }, exists: function () { return v !== null; } }; }
FakeDb.prototype.put = function (p, v) {
  var parts = p.split('/');
  if (!this.data || typeof this.data !== 'object') this.data = {};
  var o = this.data;
  for (var i = 0; i < parts.length - 1; i++) { if (!o[parts[i]] || typeof o[parts[i]] !== 'object') o[parts[i]] = {}; o = o[parts[i]]; }
  if (v === null || v === undefined) delete o[parts[parts.length - 1]]; else o[parts[parts.length - 1]] = clone(v);
  this.data = prune(this.data) || {};
};
FakeDb.prototype.allowed = function (p, oldVal, newVal, uid) {
  var a = p.split('/');
  if (!this.admins[uid]) return 'denied: not admin';
  function each(obj, fn) { var bad = null; Object.keys(obj || {}).forEach(function (u) { Object.keys(obj[u] || {}).forEach(function (k) { var r = fn(obj[u][k], u, k); if (r && !bad) bad = r; }); }); return bad; }
  if (a[0] === 'ledger') {
    if (a.length === 2) return newVal === null ? null : 'denied: the ledger term can only be cleared';
    if (a.length === 4) {
      if (oldVal !== null) return 'denied: ledger entry exists (append-only)';
      if (!newVal || !newVal.type || !newVal.createdAt || newVal.createdBy !== uid) return 'invalid ledger entry';
      return null;
    }
    return 'denied: no write rule at ' + p;
  }
  // settings/mode: admins write it; source must be 'sheet' or 'site' when it is written.
  if (a[0] === 'settings' && a[1] === 'mode') {
    var src = a.length === 2 ? (newVal && newVal.source) : (a[2] === 'source' ? newVal : undefined);
    if (src !== undefined && src !== null && src !== 'sheet' && src !== 'site') return 'invalid settings/mode/source';
  }
  if (a[0] === 'service' && a.length === 2 && newVal) return each(newVal, function (e) { return (!e.status || typeof e.hours !== 'number' || e.hours < 0 || e.hours > 200) ? 'invalid service entry' : null; });
  if (a[0] === 'excuses' && a.length === 2 && newVal) return each(newVal, function (e) { return (!e.status || (e.reason !== undefined && (typeof e.reason !== 'string' || e.reason.length > 4000))) ? 'invalid excuse' : null; });
  if (a[0] === 'excuseFlags' && a.length === 2 && newVal) return each(newVal, function (v) { return /^(late_|early_)?(pending|approved|denied)$/.test(v) ? null : 'invalid flag'; });
  return null;
};
FakeDb.prototype.write = function (map, uid) {
  var self = this, paths = Object.keys(map);
  uid = uid || self.auth;
  paths.forEach(function (a) { paths.forEach(function (b) { if (a !== b && b.indexOf(a + '/') === 0) throw new Error('Path ' + a + ' is an ancestor of ' + b); }); });
  if (self.hangOn && paths.some(function (p) { return self.hangOn.test(p); })) return new Promise(function () {});
  if (self.failOn && paths.some(function (p) { return self.failOn.test(p); })) return Promise.reject(new Error('The write failed (test)'));
  for (var i = 0; i < paths.length; i++) {
    var why = self.allowed(paths[i], self.get(paths[i]), map[paths[i]] === undefined ? null : clone(map[paths[i]]), uid);
    if (why) return Promise.reject(new Error('PERMISSION_DENIED ' + paths[i] + ': ' + why));
  }
  paths.forEach(function (p) { self.put(p, map[p]); self.writes.push(p); self.log.push({ path: p, value: clone(map[p]) }); });
  self.changed(paths);
  return Promise.resolve();
};
/** Run fn on the "server" (a macrotask), after everything already queued. */
FakeDb.prototype.later = function (fn) {
  var self = this;
  self.queue.push(fn);
  if (self.flushing) return;
  self.flushing = true;
  setTimeout(function () {
    self.flushing = false;
    var q = self.queue; self.queue = [];
    q.forEach(function (f) { f(); });
  }, 0);
};
FakeDb.prototype.changed = function (paths) {
  var self = this;
  self.listeners.forEach(function (l) {
    var hit = paths.some(function (p) { return p === l.path || p.indexOf(l.path + '/') === 0 || l.path.indexOf(p + '/') === 0 || l.path === ''; });
    if (hit) self.later(function () { if (self.listeners.indexOf(l) !== -1 && !l.conn.closed) l.cb(snap(self.get(l.path))); });
  });
};
/** The page went away: the server runs its onDisconnect writes (with that page's auth) and drops its listeners. */
FakeDb.prototype.disconnect = function (conn) {
  var self = this, ops = conn.ondc;
  conn.ondc = []; conn.closed = true;
  self.listeners = self.listeners.filter(function (l) { return l.conn !== conn; });
  return ops.reduce(function (chain, op) { return chain.then(function () { return self.write(op.map, conn.uid).catch(function (e) { op.error = e.message; }); }); }, Promise.resolve()).then(function () { return ops; });
};
FakeDb.prototype.ref = function (p, conn) {
  var self = this;
  conn = conn || { id: 0, uid: self.auth, ondc: [], closed: false };
  p = (p || '').replace(/^\/+|\/+$/g, '');
  var r = {
    key: p.split('/').pop(),
    once: function () {
      var hold = self.onRead ? self.onRead(p, conn) : null;
      if (hold) return Promise.resolve(hold).then(function () { return snap(self.get(p)); });
      if (!self.tick) { var v = self.get(p); return Promise.resolve(snap(v)); }
      return new Promise(function (resolve) { self.later(function () { resolve(snap(self.get(p))); }); });
    },
    set: function (v) { var m = {}; m[p] = v; return self.write(m, conn.uid); },
    update: function (m) { var full = {}; Object.keys(m).forEach(function (k) { full[(p ? p + '/' : '') + k] = m[k]; }); return self.write(full, conn.uid); },
    push: function (v) {
      var key = 'push' + String(++self.pushN).padStart(4, '0'), child = self.ref((p ? p + '/' : '') + key, conn);
      if (v === undefined) return child;
      var pr = child.set(v); child.then = pr.then.bind(pr); child.catch = pr.catch.bind(pr); return child;
    },
    transaction: function (fn) {
      // The SDK first runs fn on its local cache, which is cold (null) on a page that never listened here.
      var actual = self.get(p);
      var out = fn(null);
      if (out === undefined) return Promise.resolve({ committed: false, snapshot: null });
      if (JSON.stringify(actual) !== JSON.stringify(null)) { out = fn(clone(actual)); if (out === undefined) return Promise.resolve({ committed: false, snapshot: null }); }
      var m = {}; m[p] = out;
      return self.write(m, conn.uid).then(function () { return { committed: true, snapshot: null }; });
    },
    onDisconnect: function () {
      function add(map) { conn.ondc.push({ path: p, map: map }); return Promise.resolve(); }
      return {
        update: function (m) { var full = {}; Object.keys(m).forEach(function (k) { full[(p ? p + '/' : '') + k] = m[k]; }); return add(full); },
        set: function (v) { var m = {}; m[p] = v; return add(m); },
        remove: function () { var m = {}; m[p] = null; return add(m); },
        cancel: function () { conn.ondc = conn.ondc.filter(function (op) { return !(op.path === p || op.path.indexOf(p + '/') === 0); }); return Promise.resolve(); }
      };
    },
    on: function (type, cb) {
      var l = { path: p, cb: cb, conn: conn };
      self.listeners.push(l);
      self.later(function () { if (self.listeners.indexOf(l) !== -1 && !conn.closed) cb(snap(self.get(p))); });
      return cb;
    },
    off: function (type, cb) { self.listeners = self.listeners.filter(function (l) { return !(l.path === p && l.conn === conn && (!cb || l.cb === cb)); }); }
  };
  return r;
};

// ── A page's clock, timers, window events and DOM ──

/** A Date whose now() runs clock.offset ms ahead of the real one (another page, minutes later). */
function fakeDate(clock) {
  function FDate() {
    if (!(this instanceof FDate)) return Date();
    if (!arguments.length) return new Date(Date.now() + clock.offset);
    return new (Function.prototype.bind.apply(Date, [null].concat([].slice.call(arguments))))();
  }
  FDate.now = function () { return Date.now() + clock.offset; };
  FDate.parse = Date.parse; FDate.UTC = Date.UTC; FDate.prototype = Date.prototype;
  return FDate;
}
/** clock.fake: setTimeout only fires through clock.advance(ms), which also moves the clock on. */
function makeClock(c) {
  var clock = { offset: (c && c.offset) || 0, fake: !!(c && c.fake), timers: [], n: 0 };
  clock.setTimeout = function (fn, ms) {
    if (!clock.fake) return setTimeout(fn, ms);
    var t = { id: ++clock.n, at: Date.now() + clock.offset + (ms || 0), fn: fn };
    clock.timers.push(t); return t.id;
  };
  clock.clearTimeout = function (id) {
    if (!clock.fake) return clearTimeout(id);
    clock.timers = clock.timers.filter(function (t) { return t.id !== id; });
  };
  clock.advance = function (ms) {
    clock.offset += ms;
    var now = Date.now() + clock.offset;
    var due = clock.timers.filter(function (t) { return t.at <= now; }).sort(function (a, b) { return a.at - b.at; });
    clock.timers = clock.timers.filter(function (t) { return t.at > now; });
    due.forEach(function (t) { t.fn(); });
  };
  return clock;
}

function FakeEl(tag) { this.tagName = String(tag).toUpperCase(); this.className = ''; this.hidden = false; this.disabled = false; this.childNodes = []; this.attrs = {}; this.style = {}; this.handlers = {}; this._text = ''; this._html = ''; }
Object.defineProperty(FakeEl.prototype, 'innerHTML', { get: function () { return this._html; }, set: function (v) { this.childNodes = []; this._text = ''; this._html = String(v); } });
Object.defineProperty(FakeEl.prototype, 'textContent', {
  get: function () { return this._text + this.childNodes.map(function (c) { return c.textContent; }).join(' '); },
  set: function (v) { this.childNodes = []; this._html = ''; this._text = String(v); }
});
FakeEl.prototype.appendChild = function (c) { this.childNodes.push(c); return c; };
FakeEl.prototype.setAttribute = function (k, v) { this.attrs[k] = String(v); };
FakeEl.prototype.addEventListener = function (t, fn) { (this.handlers[t] = this.handlers[t] || []).push(fn); };
FakeEl.prototype.click = function () { if (this.disabled) return; (this.handlers.click || []).forEach(function (fn) { fn({}); }); };
FakeEl.prototype.all = function (tag) {
  var out = [];
  (function walk(n) { (n.childNodes || []).forEach(function (c) { if (c.tagName === tag) out.push(c); walk(c); }); })(this);
  return out;
};
FakeEl.prototype.querySelector = function (sel) { return this.all(String(sel).toUpperCase())[0] || null; };
FakeEl.prototype.querySelectorAll = function () { return []; };
FakeEl.prototype.contains = function () { return false; };

/** What the preview banner shows: its text, and the refresh button (label, disabled), if there is one. */
function bannerOf(el) {
  var b = el.querySelector('button');
  var line = el.all('SPAN').filter(function (s) { return /status-line/.test(s.className); })[0];
  return { text: el.textContent, button: b ? b.textContent : null, disabled: b ? !!b.disabled : null, msg: line ? line.textContent : '', btn: b };
}

/** Polls until cond() is true (or ms pass), letting the fake server and the page run. */
function waitFor(cond, ms) {
  var end = Date.now() + (ms || 2000);
  return new Promise(function (resolve) {
    (function poll() { if (cond() || Date.now() > end) resolve(!!cond()); else setTimeout(poll, 2); })();
  });
}
function pause(ms) { return new Promise(function (r) { setTimeout(r, ms || 20); }); }

// ── A page with the real scripts ──
/**
 * opts: { uid (the page's auth), seed, exp() (the export), db (reuse another page's database: another page or
 *         tab), clock: { offset, fake }, gate (a Promise the gateway waits for before it answers), hang (the
 *         gateway never answers), opsDb (also load js/ops-db.js, with a banner element: page.el) }
 */
function page(opts) {
  var db = opts.db || new FakeDb(opts.uid || 'u_admin');
  if (opts.seed) Object.keys(opts.seed).forEach(function (p) { db.put(p, opts.seed[p]); });
  var conn = db.connect(opts.uid || 'u_admin');
  var clock = makeClock(opts.clock);
  var gatewayCalls = { n: 0 };
  var sb = { console: console, Promise: Promise, Date: opts.clock ? fakeDate(clock) : Date, JSON: JSON, Math: Math, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout };
  sb.window = sb;
  sb.sessionStorage = (function () { var s = {}; return { getItem: function (k) { return k in s ? s[k] : null; }, setItem: function (k, v) { s[k] = String(v); }, removeItem: function (k) { delete s[k]; } }; })();
  var winHandlers = {};
  sb.addEventListener = function (t, fn) { (winHandlers[t] = winHandlers[t] || []).push(fn); };
  sb.removeEventListener = function (t, fn) { winHandlers[t] = (winHandlers[t] || []).filter(function (f) { return f !== fn; }); };
  sb.location = { reload: function () { sb.reloaded = (sb.reloaded || 0) + 1; } };
  sb.document = {
    currentScript: null,
    createElement: function (tag) { return new FakeEl(tag); },
    createTextNode: function (t) { return { nodeType: 3, textContent: String(t) }; },
    head: { appendChild: function () { throw new Error('the core should already be loaded'); } },
    getElementById: function () { return null; },
    querySelectorAll: function () { return []; }
  };
  var fdb = { ref: function (p) { return db.ref(p, conn); } };
  sb.firebase = { database: function () { return fdb; }, auth: function () { return { currentUser: { getIdToken: function () { return Promise.resolve('token'); } } }; } };
  sb.firebase.database.ServerValue = { TIMESTAMP: { '.sv': 'timestamp' } };
  sb.fetch = function (url, init) {
    gatewayCalls.n++;
    var body = init && init.body ? JSON.parse(init.body) : null;
    function answer() {
      var payload = /action=ping/.test(url) ? { ok: true, version: 2 } : (body && body.action === 'exportAll' ? (opts.exp ? opts.exp() : fx.exportV2()) : { ok: false, error: 'Unknown action' });
      return { json: function () { return Promise.resolve(JSON.parse(JSON.stringify(payload))); } };
    }
    if (opts.hang && !/action=ping/.test(url)) return new Promise(function () {});
    if (opts.gate && !/action=ping/.test(url)) return opts.gate.then(answer);
    return Promise.resolve(answer());
  };
  var ctx = vm.createContext(sb);
  var files = ['portal/js/ops-core.js'].concat(opts.opsDb ? ['portal/js/ops-db.js'] : []).concat(['portal/js/ops-mode.js', 'portal/js/sheet-sync-core.js', 'portal/js/sheet-sync.js']);
  files.forEach(function (f) { vm.runInContext(read(f), ctx, { filename: f }); });
  return {
    db: db, conn: conn, S: sb.PortalSync, gateway: gatewayCalls, win: sb, clock: clock, el: new FakeEl('div'),
    /** Fire a window event; returns the event (beforeunload: returnValue is set when the page asks first). */
    fire: function (type) {
      var e = { type: type, returnValue: undefined, defaultPrevented: false, preventDefault: function () { e.defaultPrevented = true; } };
      (winHandlers[type] || []).slice().forEach(function (fn) { var r = fn(e); if (typeof r === 'string' && e.returnValue === undefined) e.returnValue = r; });
      return e;
    },
    handlers: function (type) { return (winHandlers[type] || []).length; },
    /** The tab is closed or the connection drops: the server runs this page's onDisconnect writes. */
    close: function () { return db.disconnect(conn); }
  };
}
/** A gate the test opens by hand: the gateway answers only after gate.open(). */
function gate() { var g = {}; g.promise = new Promise(function (r) { g.open = r; }); return g; }

var ADMIN = { uid: 'u_admin', role: 'admin', name: 'Test Admin' };
var USERS = Object.assign({ u_admin: { name: 'Test Admin', rollNumber: '999', status: 'active', role: 'admin' } }, fx.users);
var BASE = { users: USERS, 'settings/currentTerm': 'F26' };
function seed(extra) { var s = {}; Object.keys(BASE).forEach(function (k) { s[k] = BASE[k]; }); Object.keys(extra || {}).forEach(function (k) { s[k] = extra[k]; }); return s; }

var pass = 0, failN = 0;
function eq(name, got, want) {
  var g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('OK   ' + name); }
  else { failN++; console.log('FAIL ' + name + '\n       got  ' + g + '\n       want ' + w); }
}
function ok(name, c) { eq(name, !!c, true); }
function codeOf(p) { return p.then(function () { return 'resolved'; }, function (e) { return e.code || e.message; }); }
/** Index in db.writes of the first write that marked the copy unfinished (settings/mode with copyIncomplete). */
function markedAt(db) {
  for (var i = 0; i < db.log.length; i++) {
    var w = db.log[i];
    if (w.path === 'settings/mode/copyIncomplete' && w.value === true) return i;
    if (w.path === 'settings/mode' && w.value && w.value.copyIncomplete === true) return i;
  }
  return -1;
}
function nodeWrites(db) { return db.writes.filter(function (p) { return /^(events|attendance|myAttendance|excuseFlags|excuses|adjustments|rollover|service|ledger)\//.test(p); }); }

var steps = [];
function test(name, fn) { steps.push({ name: name, fn: fn }); }

test('refusals', function () {
  var p1 = page({ uid: 'u_avery', seed: seed() });
  var p2 = page({ seed: seed({ 'settings/mode': { source: 'site' } }) });
  var p3 = page({ seed: seed({ 'settings/mode': { source: 'sheet', syncing: true, syncingAt: Date.now() - 60000, syncingBy: 'u_other', syncingByName: 'Other Admin' } }) });
  return Promise.all([
    codeOf(p1.S.refresh({ uid: 'u_avery', role: 'brother' })), codeOf(p2.S.refresh(ADMIN)), p2.S.refreshIfStale(ADMIN),
    codeOf(p3.S.refresh(ADMIN)), p3.S.refreshIfStale(ADMIN), p1.S.refreshIfStale({ uid: 'u_avery', role: 'brother' })
  ]).then(function (r) {
    eq('A brother cannot refresh', r[0], 'not-admin');
    eq('Nothing refreshes once the site is the record', [r[1], r[2]], ['site-mode', null]);
    eq('A running refresh (lock under 10 minutes) blocks a second one', r[3], 'locked');
    eq('refreshIfStale steps aside while another refresh runs', r[4], null);
    eq('refreshIfStale does nothing for a non-admin', r[5], null);
    eq('No refused refresh wrote anything or called the gateway', [p1.db.writes.length, p2.db.writes.length, p3.db.writes.length, p1.gateway.n + p2.gateway.n + p3.gateway.n], [0, 0, 0, 0]);
  });
});

test('first refresh replaces old imported rows whole', function () {
  var p = page({ seed: seed({
    'settings/mode': { source: 'sheet', syncing: true, syncingAt: Date.now() - 20 * 60000, syncingBy: 'u_gone', syncingByName: 'Gone Admin' },
    'ledger/F26/u_avery/imp_dues_0': { type: 'charge', item: 'Dues', amount: 250, createdBy: 'u_admin', createdAt: 'x' },
    'events/F26/old_event': { title: 'Old event', type: 'chapter', recorded: true },
    'service/F26/u_x/imp_1': { hours: 2, status: 'approved' },
    'excuses/F26/u_avery/push1': { status: 'pending', reason: 'typed on the site' }
  }) });
  var steps = [];
  return p.S.refresh(ADMIN, { onProgress: function (t) { steps.push(t); } }).then(function (s) {
    var d = p.db;
    eq('A stale lock (over 10 minutes) is taken over', s.ok, true);
    eq('Old row-number keys are gone, content keys are in', Object.keys(d.get('ledger/F26/u_avery')).sort(), ['sh_dues_20261025', 'sh_dues_20261025_pay']);
    eq('Rows that are not on the sheet vanish', [d.get('events/F26/old_event'), d.get('service/F26/u_x'), d.get('excuses/F26/u_avery/push1')], [null, null, null]);
    eq('settings/mode records the copy and lets go of the lock', (function (m) { return [m.source, m.syncing, m.lastSyncBy, m.lastSyncByName, typeof m.lastSyncAt, 'syncingAt' in m, 'syncingBy' in m]; })(d.get('settings/mode')),
      ['sheet', false, 'u_admin', 'Test Admin', 'number', false, false]);
    eq('The sheet\'s numbers for the term are saved for pages to use', [d.get('settings/sheetPolicy/term'), d.get('settings/sheetPolicy/policy/service/hoursRequired')], ['F26', 8]);
    eq('The term exists', d.get('terms/F26/status'), 'active');
    var rep = d.get('imports/sheetSync');
    eq('The report is saved under imports (admins only)', [rep.term, rep.compared, rep.matching, rep.unmatched.length, rep.unmatched[0].name, rep.changed.ledger], ['F26', 4, 4, 1, 'Jordan Lee', true]);
    var outside = JSON.stringify(Object.keys(d.data).filter(function (k) { return k !== 'imports' && k !== 'users'; }).map(function (k) { return d.data[k]; }));
    ok('Unmatched names and the comparison are stored nowhere but imports', outside.indexOf('Jordan Lee') === -1 && outside.indexOf('mismatch') === -1);
    ok('The run is logged in imports and the change log', JSON.stringify(d.get('imports')).indexOf('"status":"done"') !== -1 && !!d.get('changeLog/F26'));
    ok('Progress is reported to the page', steps[0] === 'Reading the Tracker sheet…' && steps[steps.length - 1] === 'Done.');
    eq('The ledger was cleared as a whole term, then written entry by entry', d.writes.filter(function (w) { return /^ledger\/F26$/.test(w); }).length, 1);
    var flagAt = markedAt(d), firstNode = d.writes.indexOf(nodeWrites(d)[0]);
    ok('The copy is marked unfinished before the first node is written', flagAt !== -1 && flagAt < firstNode);
    eq('... and the mark is cleared once everything is written', 'copyIncomplete' in d.get('settings/mode'), false);
    var direct = p.db.ref('ledger/F26/u_avery/sh_dues_20261025').set({ type: 'charge', createdBy: 'u_admin', createdAt: 'x' });
    return direct.then(function () { return 'written'; }, function (e) { return /append-only/.test(e.message) ? 'refused' : e.message; }).then(function (r) {
      eq('Sanity: the fake database refuses overwriting a ledger entry, like the real rules', r, 'refused');
    });
  });
});

test('same export again rewrites nothing; a deleted row is removed', function () {
  var p = page({ seed: seed() });
  var variant = null;
  p = page({ seed: seed(), exp: function () { return variant ? variant() : fx.exportV2(); } });
  return p.S.refresh(ADMIN).then(function () {
    var before = nodeWrites(p.db).length;
    return p.S.refresh(ADMIN).then(function (s2) {
      eq('Same export twice: no node is rewritten', [nodeWrites(p.db).length - before, s2.changedNodes], [0, 0]);
      variant = function () { var e = fx.exportV2(); e.tabs.Payments_Fines.rows = e.tabs.Payments_Fines.rows.filter(function (r) { return r.Item !== 'Late fee'; }); return e; };
      var mark = p.db.writes.length;
      return p.S.refresh(ADMIN).then(function (s3) {
        var w = p.db.writes.slice(mark).filter(function (x) { return /^(events|attendance|myAttendance|excuseFlags|excuses|adjustments|rollover|service|ledger)\//.test(x); });
        eq('A row deleted on the sheet: only the ledger is rewritten', [s3.changedNodes, w.every(function (x) { return /^ledger\//.test(x); })], [1, true]);
        eq('... and the deleted charge is gone', Object.keys(p.db.get('ledger/F26/u_blake')), ['sh_dues_20261025']);
      });
    });
  });
});

test('a bad export changes nothing', function () {
  var p = page({ seed: seed({ 'settings/mode': { source: 'sheet', lastSyncAt: 1000 } }), exp: function () { var e = fx.exportV2(); delete e.version; delete e.tabs.DemeritDashboard; return e; } });
  return codeOf(p.S.refresh(ADMIN)).then(function (c) {
    var m = p.db.get('settings/mode');
    eq('An old gateway is refused with a redeploy message', c, 'old-gateway');
    eq('... the lock is released and the last copy time is kept', [m.syncing, m.lastSyncAt, 'syncingAt' in m], [false, 1000, false]);
    eq('... no node was written', nodeWrites(p.db).length, 0);
    ok('... and the failure is logged for admins', JSON.stringify(p.db.get('imports')).indexOf('"status":"failed"') !== -1);
  });
});

test('a half-empty export asks first', function () {
  var half = false;
  var p = page({ seed: seed(), exp: function () {
    var e = fx.exportV2();
    if (half) {
      // Pretend 4 brothers' rows went missing from Attendance, and pad the Roster so the old copy was big.
      e.tabs.Attendance.rows = e.tabs.Attendance.rows.slice(0, 1);
    }
    return e;
  } });
  return p.S.refresh(ADMIN).then(function () {
    half = true;
    var mark = nodeWrites(p.db).length;
    return codeOf(p.S.refresh(ADMIN)).then(function (c) {
      eq('A copy that shrinks a node to under half is held back', [c, nodeWrites(p.db).length - mark], ['shrink', 0]);
      eq('... and the lock is free again', p.db.get('settings/mode/syncing'), false);
      return p.S.refresh(ADMIN, { allowShrink: true }).then(function (s) {
        eq('With the admin\'s OK it goes ahead', [s.ok, s.counts.attendance], [true, 7]);
      });
    });
  });
});

test('refreshIfStale and dry runs', function () {
  var fresh = page({ seed: seed({ 'settings/mode': { source: 'sheet', lastSyncAt: Date.now() - 3600000 } }) });
  var stale = page({ seed: seed({ 'settings/mode': { source: 'sheet', lastSyncAt: Date.now() - 2 * 86400000 } }) });
  var dry = page({ seed: seed() });
  return Promise.all([fresh.S.refreshIfStale(ADMIN), stale.S.refreshIfStale(ADMIN), dry.S.refresh(ADMIN, { dryRun: true })]).then(function (r) {
    eq('A copy under a day old is left alone (no gateway call)', [r[0], fresh.gateway.n], [null, 0]);
    eq('A copy over a day old is refreshed on its own', [r[1] && r[1].ok, r[1] && r[1].auto, stale.db.get('imports/sheetSync/auto')], [true, true, true]);
    eq('A check-only run writes nothing, not even the lock', [r[2].dryRun, r[2].report.compared, dry.db.writes.length], [true, 4, 0]);
    return stale.S.refreshIfStale(ADMIN).then(function (again) { eq('refreshIfStale runs at most once per page', again === r[1], true); });
  });
});

test('termSettings for pages', function () {
  var p = page({ seed: seed() });
  return p.S.refresh(ADMIN).then(function () {
    var settings = p.win.OpsCore.withDefaults({});
    settings.currentTerm = 'F26';
    return p.S.termSettings(settings, 'F26');
  }).then(function (ts) {
    eq('termSettings gives pages the sheet\'s numbers for the term', [ts.policy.service.hoursRequired, ts.policy.service.extraHourErases, ts.currentTerm], [8, 0, 'F26']);
  });
});

test('one brother\'s facts (loadMyFacts, My Tracker preview) use the sheet\'s numbers like loadTermFacts', function () {
  // Avery gets 10 more confirmed hours (20 in all): past the site's 12, where the site's own rule would erase demerits.
  var p = page({ seed: seed(), exp: function () {
    var e = fx.exportV2();
    e.tabs.Service_Hours.rows.push({ 'Brother Name': 'Avery Stone', 'Roll Number': 501, Event: 'Habitat build', Date: 'Sep 12', Hours: 10, Confirmed: true });
    return e;
  } });
  var P, C, UIDS = ['u_avery', 'u_blake', 'u_thomas', 'u_riley'];
  function pick(d) { return { total: d.total, standing: d.standing, credit: d.serviceCredit, next: d.serviceShortfallNext, required: d.service.hoursRequired, approved: d.service.approvedHours }; }
  function both(term) {
    return Promise.all([P.loadTermFacts(term)].concat(UIDS.map(function (u) { return P.loadMyFacts(term, u); }))).then(function (r) {
      var all = r[0];
      return UIDS.map(function (u, i) {
        return { uid: u, my: pick(C.computeDemerits(u, r[i + 1], r[i + 1].settings, {})), all: pick(C.computeDemerits(u, P.factsFor(term, u, all), all.settings, {})), settings: r[i + 1].settings };
      });
    });
  }
  return p.S.refresh(ADMIN).then(function () {
    vm.runInContext(read('portal/js/ops-db.js'), p.win, { filename: 'portal/js/ops-db.js' });
    P = p.win.PortalOps; C = p.win.OpsCore;
    return both('F26');
  }).then(function (rows) {
    eq('loadMyFacts and loadTermFacts give every brother the same total, standing, credit and shortfall', rows.map(function (x) { return JSON.stringify(x.my); }), rows.map(function (x) { return JSON.stringify(x.all); }));
    var a = rows[0];
    eq('Avery: 20 approved hours against the sheet\'s 8, no extra-hour credit, total as on the sheet\'s dashboard (0)', [a.my.approved, a.my.required, a.my.credit, a.my.total], [20, 8, 0, 0]);
    eq('loadMyFacts settings are marked as the sheet\'s and carry its policy', [a.settings.sheetRules, a.settings.policy.service.extraHourErases, a.settings.policy.service.hoursRequired], ['F26', 0, 8]);
    // After the switch to the site, the sheet's term keeps the sheet's numbers; a new term uses the site's.
    p.db.put('settings/mode/source', 'site');
    return P.loadSettings(true).then(function () { return Promise.all([both('F26'), P.loadMyFacts('S27', 'u_avery')]); });
  }).then(function (r) {
    eq('After the switch: the sheet-owned term still uses the sheet\'s numbers', [r[0][0].my.required, r[0][0].my.credit, r[0][0].my.total], [8, 0, 0]);
    eq('After the switch: a new term uses the site\'s numbers', [r[1].settings.policy.service.hoursRequired, r[1].settings.policy.service.extraHourErases, !!r[1].settings.sheetRules], [12, 1, false]);
  });
});

function modeOf(p) { var M = p.win.OpsMode; return M._normalise(p.db.get('settings/mode')); }

test('a refresh cut off partway is marked, shown and retried', function () {
  var hourAgo = Date.now() - 3600000;
  var p1 = page({ seed: seed({ 'settings/mode': { source: 'sheet', lastSyncAt: hourAgo, lastSyncByName: 'Earlier Admin' } }) });
  p1.db.failOn = /^service\//;   // events … rollover are written, then the page goes away
  return p1.S.refresh(ADMIN).then(function () { return 'resolved'; }, function (e) { return e; }).then(function (err) {
    var m = p1.db.get('settings/mode'), M = p1.win.OpsMode;
    eq('The failure is reported to the admin as a partial copy', [err instanceof Error, /Part of the copy may be new and part old/.test(err && err.message)], [true, true]);
    eq('settings/mode keeps the last good time, lets go of the lock and says the copy is unfinished', [m.lastSyncAt, m.syncing, m.copyIncomplete], [hourAgo, false, true]);
    ok('Some nodes are new (the copy really is mixed)', !!p1.db.get('events/F26') && !p1.db.get('service/F26'));
    ok('The run is logged as partial', JSON.stringify(p1.db.get('imports')).indexOf('"status":"partial"') !== -1);
    eq('OpsMode treats an unfinished copy as stale, though it is an hour old', M.isStale(modeOf(p1)), true);
    // The next admin visit (another page, same database) repairs it.
    p1.db.failOn = null;
    var p2 = page({ db: p1.db, seed: null });
    return p2.S.refreshIfStale(ADMIN).then(function (s) {
      var m2 = p2.db.get('settings/mode');
      eq('refreshIfStale retries an unfinished copy at once', [s && s.ok, s && s.auto], [true, true]);
      eq('... and the finished copy clears the mark', ['copyIncomplete' in m2, m2.lastSyncAt > hourAgo, m2.syncing], [false, true, false]);
      eq('... with every node in place', Object.keys(p2.db.get('service/F26')).sort(), ['u_avery', 'u_blake']);
    });
  });
});

test('an abandoned refresh (tab closed) is retried once its lock is dead, not before', function () {
  var hourAgo = Date.now() - 3600000;
  var live = page({ seed: seed({ 'settings/mode': { source: 'sheet', lastSyncAt: hourAgo, copyIncomplete: true, syncing: true, syncingAt: Date.now() - 60000, syncingBy: 'u_other', syncingByName: 'Other Admin' } }) });
  var dead = page({ seed: seed({ 'settings/mode': { source: 'sheet', lastSyncAt: hourAgo, copyIncomplete: true, syncing: true, syncingAt: Date.now() - 20 * 60000, syncingBy: 'u_other', syncingByName: 'Other Admin' } }) });
  return Promise.all([live.S.refreshIfStale(ADMIN), dead.S.refreshIfStale(ADMIN)]).then(function (r) {
    eq('A lock under 10 minutes old: refreshIfStale waits for that refresh', [r[0], live.gateway.n, live.db.writes.length], [null, 0, 0]);
    eq('A dead lock: the unfinished copy is made again', [r[1] && r[1].ok, 'copyIncomplete' in dead.db.get('settings/mode'), dead.db.get('settings/mode/syncing')], [true, false, false]);
  });
});

test('a complete copy already in place clears a stale mark without rewriting anything', function () {
  var p = page({ seed: seed() });
  return p.S.refresh(ADMIN).then(function () {
    p.db.put('settings/mode/copyIncomplete', true);
    return p.S.refresh(ADMIN);
  }).then(function (s) {
    eq('Same facts on the site and the sheet: no node written, mark cleared', [s.changedNodes, 'copyIncomplete' in p.db.get('settings/mode')], [0, false]);
  });
});

test('a missing tab or another semester changes nothing', function () {
  var good = page({ seed: seed() });
  return good.S.refresh(ADMIN).then(function () {
    var mark = good.db.writes.length;
    var missing = page({ db: good.db, seed: null, exp: function () { var e = fx.exportV2(); e.tabs.Excuses = { tab: '', found: false, headers: [], rows: [] }; return e; } });
    var spring = page({ db: good.db, seed: null, exp: function () {
      var e = fx.exportV2();
      e.tabs.Event_Info.rows.forEach(function (r) { if (r['Event Date']) r['Event Date'] = r['Event Date'].replace('2026-', '2027-').replace('-08-', '-01-').replace('-09-', '-02-'); });
      return e;
    } });
    return codeOf(missing.S.refresh(ADMIN)).then(function (c1) {
      return codeOf(spring.S.refresh(ADMIN, { allowShrink: true })).then(function (c2) {
        var w = good.db.writes.slice(mark), m = good.db.get('settings/mode');
        eq('A renamed Excuses tab is refused; spring dates are refused even with the admin\'s OK', [c1, c2], ['missing-tab', 'wrong-term']);
        eq('... no copied node or setting was written, and the copy is not marked unfinished', [nodeWrites({ writes: w }).length, w.indexOf('settings/sheetPolicy'), 'copyIncomplete' in m, m.syncing], [0, -1, false, false]);
        eq('... the excuses copy is still there', Object.keys(good.db.get('excuses/F26')).sort(), ['u_avery', 'u_blake', 'u_thomas']);
        ok('... and both failures are logged for admins', (JSON.stringify(good.db.get('imports')).match(/"status":"failed"/g) || []).length === 2);
      });
    });
  });
});

test('a roll-over tab that goes missing asks first, and says why', function () {
  var gone = false;
  var p = page({ seed: seed(), exp: function () { var e = fx.exportV2(); if (gone) delete e.tabs.Rollover; return e; } });
  return p.S.refresh(ADMIN).then(function (s) {
    eq('The report says which roll-over tab was used', [s.report.rolloverTab, p.db.get('imports/sheetSync/rolloverTab')], ['S26 Rollover Demerits', 'S26 Rollover Demerits']);
    gone = true;
    return p.S.refresh(ADMIN).then(function () { return null; }, function (e) { return e; });
  }).then(function (err) {
    eq('Roll-over 2 to 0 is held back', [err && err.code, /roll-over demerits 2 to 0/.test(err && err.message), /"S26 Rollover Demerits"/.test(err && err.message)], ['shrink', true, true]);
    eq('... nothing was written', p.db.get('rollover/F26/u_avery/points'), -3);
  });
});

test('refreshIfStale is not for the portal home', function () {
  var stale = page({ seed: seed({ 'settings/mode': { source: 'sheet', lastSyncAt: Date.now() - 2 * 86400000 } }) });
  return stale.S.refreshIfStale(ADMIN, { page: 'home' }).then(function (r) {
    eq('page home: no refresh, no gateway call, nothing written', [r, stale.gateway.n, stale.db.writes.length], [null, 0, 0]);
  });
});

// ── The lock never outlives its page; preview pages are never stuck ──

var ADMIN2 = { uid: 'u_admin2', role: 'admin', name: 'Second Admin' };
var USERS2 = Object.assign({ u_admin2: { name: 'Second Admin', rollNumber: '998', status: 'active', role: 'admin' } }, USERS);
function seed2(extra) { var s = seed(extra); s.users = USERS2; return s; }
function importsWith(db, re) { return Object.keys(db.get('imports') || {}).map(function (k) { return db.get('imports/' + k); }).filter(function (r) { return r && r.kind === 'sheetSync' && re.test(JSON.stringify(r)); }); }
function lockOf(db) { var m = db.get('settings/mode') || {}; return { syncing: m.syncing === true, copyIncomplete: m.copyIncomplete === true, by: m.syncingBy || null, lastSyncAt: m.lastSyncAt || null }; }
function preview(p, profile) { return p.win.PortalOps.preview({ profile: profile || ADMIN, el: p.el, what: 'demerits', onRefresh: function () { p.refreshed = (p.refreshed || 0) + 1; } }); }

test('the reported bug: an admin opens a preview page while the copy is fresh, and the button is not stuck', function () {
  // The real SDK (9.22.0) answers the listener's first value and refreshIfStale's once() in one server message,
  // listener first, so the banner was drawn with st.busy on and never drawn again: "Copying from the sheet…", disabled.
  var p = page({ opsDb: true, seed: seed({ 'settings/mode': { source: 'sheet', lastSyncAt: Date.now() - 3600000, lastSyncByName: 'Other Admin' } }) });
  p.db.tick = true;
  return preview(p).then(function () { return pause(60); }).then(function () {
    var b = bannerOf(p.el);
    eq('Fresh copy: after the quiet check the button reads "Refresh from sheet now" and works', [b.button, b.disabled, b.msg, p.gateway.n], ['Refresh from sheet now', false, '', 0]);
    ok('... the banner says when the copy was made', /Copied from the Tracker sheet .* by Other Admin/.test(b.text));
    eq('... and no refresh runs, so the page does not ask before leaving', [p.handlers('beforeunload'), p.fire('beforeunload').returnValue], [0, undefined]);
    b.btn.click();
    return waitFor(function () { return /Copied from the sheet just now/.test(bannerOf(p.el).msg); }).then(function () {
      var b2 = bannerOf(p.el);
      eq('... a press then refreshes the copy', [p.gateway.n, b2.button, b2.disabled, p.db.get('settings/mode/lastSyncBy')], [1, 'Refresh from sheet now', false, 'u_admin']);
    });
  });
});

test('a press during the quiet check on page load is kept and runs when the check ends', function () {
  var p = page({ opsDb: true, seed: seed({ 'settings/mode': { source: 'sheet', lastSyncAt: Date.now() - 3600000 } }) });
  p.db.tick = true;
  var during = null;
  return preview(p).then(function () {
    // preview() has started the quiet check (refreshIfStale): its read waits for the server.
    var b = bannerOf(p.el);
    during = { button: b.button, disabled: b.disabled, waiting: p.db.queue.length > 0 };
    b.btn.click();
    var after = bannerOf(p.el);
    during.afterClick = [after.button, after.disabled];
    return waitFor(function () { return /Copied from the sheet just now/.test(bannerOf(p.el).msg); });
  }).then(function () {
    eq('During the check the button is "Refresh from sheet now" and can be pressed', [during.waiting, during.button, during.disabled], [true, 'Refresh from sheet now', false]);
    eq('... the press shows at once', during.afterClick, ['Copying from the sheet…', true]);
    eq('... and runs as soon as the check ends (one gateway call, a new copy)', [p.gateway.n, lockOf(p.db).syncing, typeof p.db.get('settings/mode/lastSyncBy')], [1, false, 'string']);
    eq('... with the result in the banner and the button back', [bannerOf(p.el).button, bannerOf(p.el).disabled], ['Refresh from sheet now', false]);
  });
});

test('an automatic refresh shows its steps, asks before leaving, and stops asking when done', function () {
  var g = gate();
  var p = page({ opsDb: true, gate: g.promise, seed: seed({ 'settings/mode': { source: 'sheet', lastSyncAt: Date.now() - 2 * 86400000 } }) });
  var steps = [];
  return preview(p).then(function () {
    return waitFor(function () { return p.gateway.n === 1 && /Reading the Tracker sheet/.test(bannerOf(p.el).msg); });
  }).then(function () {
    var b = bannerOf(p.el);
    steps.push(b.msg);
    eq('Over a day old: the automatic refresh shows "Reading the Tracker sheet…" while the gateway works', [b.msg, b.button, b.disabled], ['Reading the Tracker sheet…', 'Copying from the sheet…', true]);
    var e = p.fire('beforeunload');
    ok('... leaving the page asks first', typeof e.returnValue === 'string' && /refresh/i.test(e.returnValue) && e.defaultPrevented);
    eq('... and it registers no onDisconnect: a dropped connection does not let go of the lock', p.conn.ondc.length, 0);
    g.open();
    return waitFor(function () { return /Copied from the sheet just now/.test(bannerOf(p.el).msg); });
  }).then(function () {
    eq('When it is done: the result shows, the lock is free and the page stops asking',
      [/Copied from the sheet just now/.test(bannerOf(p.el).msg), lockOf(p.db).syncing, p.fire('beforeunload').returnValue, p.handlers('beforeunload'), p.handlers('pagehide')],
      [true, false, undefined, 0, 0]);
  });
});

test('a page closed without its pagehide keeps the lock: the same admin takes it over after 2 minutes by pressing, another admin is still locked out', function () {
  var hourAgo = Date.now() - 3600000;
  var p1 = page({ seed: seed2({ 'settings/mode': { source: 'sheet', lastSyncAt: hourAgo, lastSyncByName: 'Earlier Admin' } }) });
  var db = p1.db, lockAt = null, TAKE = p1.S.TAKEOVER_MS;
  db.hangOn = /^service\//;   // events … rollover are written, then the page stops answering
  p1.S.refresh(ADMIN).catch(function () {});
  return waitFor(function () { var l = lockOf(db); return l.syncing && l.copyIncomplete && !!db.get('events/F26'); }).then(function () {
    lockAt = db.get('settings/mode/syncingAt');
    eq('While it runs: the lock is held, the copy is marked unfinished, and no onDisconnect is registered',
      [lockOf(db).syncing, lockOf(db).copyIncomplete, p1.conn.ondc.length], [true, true, 0]);
    return p1.close();   // the tab is closed, the browser killed or the connection lost: no pagehide code runs
  }).then(function (ops) {
    db.hangOn = null;
    var m = db.get('settings/mode'), M = p1.win.OpsMode;
    eq('Closed without pagehide: the server has nothing to run, and the lock stays as it was',
      [ops.length, m.syncing, m.syncingBy, m.syncingAt, m.copyIncomplete, m.lastSyncAt], [0, true, 'u_admin', lockAt, true, hourAgo]);
    eq('... so pages still say a refresh is running', M.isSyncing(M._normalise(m)), true);
    // A minute before the takeover limit the same admin presses; 3 minutes after the start another admin presses.
    var early = page({ db: db, clock: { offset: TAKE - 60000 } });
    var other = page({ db: db, uid: 'u_admin2', clock: { offset: 3 * 60000 } });
    return Promise.all([codeOf(early.S.refresh(ADMIN)), early.S.refreshIfStale(ADMIN), codeOf(other.S.refresh(ADMIN2)), other.S.refreshIfStale(ADMIN2)]).then(function (r) {
      eq('Under 2 minutes: the same admin\'s press gets "locked", and the automatic check steps aside', [r[0], r[1]], ['locked', null]);
      eq('3 minutes: another admin still gets "locked", and the automatic check steps aside', [r[2], r[3]], ['locked', null]);
      eq('... none of them called the gateway or changed the lock', [early.gateway.n + other.gateway.n, db.get('settings/mode/syncingAt'), db.get('settings/mode/syncing')], [0, lockAt, true]);
      var late = page({ db: db, clock: { offset: TAKE + 1000 } });
      return late.S.refresh(ADMIN);   // just past 2 minutes the same admin presses again
    }).then(function (s) {
      var m2 = db.get('settings/mode'), done = importsWith(db, /"status":"done"/);
      eq('Past 2 minutes: the same admin\'s press takes the lock over and makes the whole copy',
        [s.ok, m2.syncing, 'copyIncomplete' in m2, m2.lastSyncAt > hourAgo, done.length, done[0] && done[0].tookOverLockAt], [true, false, false, true, 1, lockAt]);
      eq('... with every node in place', Object.keys(db.get('service/F26')).sort(), ['u_avery', 'u_blake']);
    });
  });
});

test('a closed page\'s lock is dead after 10 minutes: then any admin\'s visit makes the copy again', function () {
  var hourAgo = Date.now() - 3600000;
  var p1 = page({ seed: seed2({ 'settings/mode': { source: 'sheet', lastSyncAt: hourAgo } }) });
  var db = p1.db;
  db.hangOn = /^service\//;
  p1.S.refresh(ADMIN).catch(function () {});
  return waitFor(function () { return lockOf(db).copyIncomplete && !!db.get('events/F26'); }).then(function () {
    return p1.close();
  }).then(function () {
    db.hangOn = null;
    var p2 = page({ db: db, uid: 'u_admin2', clock: { offset: p1.S.LOCK_MS + 60000 } });
    return p2.S.refreshIfStale(ADMIN2).then(function (s) {
      var m = db.get('settings/mode');
      eq('11 minutes later another admin\'s visit takes the dead lock and makes the whole copy',
        [s && s.ok, s && s.auto, m.syncing, 'copyIncomplete' in m, m.lastSyncBy], [true, true, false, false, 'u_admin2']);
      eq('... with every node in place', Object.keys(db.get('service/F26')).sort(), ['u_avery', 'u_blake']);
    });
  });
});

test('pagehide lets go of the lock itself and logs the run as stopped', function () {
  var p = page({ seed: seed2({ 'settings/mode': { source: 'sheet', lastSyncAt: 1000 } }) });
  p.db.hangOn = /^service\//;
  p.S.refresh(ADMIN).catch(function () {});
  return waitFor(function () { return lockOf(p.db).copyIncomplete; }).then(function () {
    p.fire('pagehide');
    return waitFor(function () { return !lockOf(p.db).syncing && importsWith(p.db, /left-page/).length === 1; });
  }).then(function () {
    var rec = importsWith(p.db, /left-page/)[0], m = p.db.get('settings/mode');
    eq('pagehide: the lock is let go, copyIncomplete stays', [m.syncing, 'syncingBy' in m, m.copyIncomplete, m.lastSyncAt], [false, false, true, 1000]);
    eq('... the run is logged as partial, stopped by leaving the page', [rec.status, rec.code, rec.by], ['partial', 'left-page', 'u_admin']);
    p.db.hangOn = null;
    var p2 = page({ db: p.db, uid: 'u_admin2' });
    return p2.S.refreshIfStale(ADMIN2);
  }).then(function (s) {
    eq('... so another admin\'s visit right away makes the whole copy again (no wait for the lock)',
      [s && s.ok, lockOf(p.db).syncing, lockOf(p.db).copyIncomplete, Object.keys(p.db.get('service/F26')).sort()], [true, false, false, ['u_avery', 'u_blake']]);
  });
});

test('a normal end stops asking before leaving, done or failed, and leaves the server nothing to run', function () {
  var good = page({ seed: seed() });
  var bad = page({ seed: seed({ 'settings/mode': { source: 'sheet', lastSyncAt: 1000 } }), exp: function () { var e = fx.exportV2(); delete e.version; delete e.tabs.DemeritDashboard; return e; } });
  return Promise.all([good.S.refresh(ADMIN), codeOf(bad.S.refresh(ADMIN))]).then(function (r) {
    eq('Done: no page handlers, no onDisconnect', [r[0].ok, good.conn.ondc.length, good.handlers('beforeunload'), good.handlers('pagehide')], [true, 0, 0, 0]);
    eq('Failed: the same', [r[1], bad.conn.ondc.length, bad.handlers('beforeunload'), bad.handlers('pagehide')], ['old-gateway', 0, 0, 0]);
    return Promise.all([good.close(), bad.close()]).then(function (ops) {
      eq('... so closing those pages later changes nothing', [ops[0].length, ops[1].length], [0, 0]);
    });
  });
});

test('the abandoned lock: the same admin takes it over by pressing the button, another admin is still locked out', function () {
  // Page 1 takes the lock, marks the copy unfinished, writes part of it and is abandoned: it hangs, and no
  // pagehide runs. Its lock is live for 10 minutes.
  var hourAgo = Date.now() - 3600000;
  var p1 = page({ seed: seed2({ 'settings/mode': { source: 'sheet', lastSyncAt: hourAgo, lastSyncByName: 'Earlier Admin' } }) });
  var db = p1.db, lockAt = null;
  db.hangOn = /^service\//;
  p1.S.refresh(ADMIN).catch(function () {});
  return waitFor(function () { return lockOf(db).copyIncomplete; }).then(function () {
    lockAt = db.get('settings/mode/syncingAt');
    db.hangOn = null;
    // 30 seconds later, the same admin on another page: the automatic check steps aside and a press is refused, with when to retry.
    var p2 = page({ db: db, clock: { offset: 30000 } });
    return Promise.all([p2.S.refreshIfStale(ADMIN), p2.S.refresh(ADMIN).then(function () { return null; }, function (e) { return e; })]).then(function (r) {
      eq('30 s later: refreshIfStale waits (never takes over)', [r[0], p2.gateway.n], [null, 0]);
      eq('... a press by the same admin is refused for now', r[1] && r[1].code, 'locked');
      ok('... and says it is their own refresh from another page and when a press takes it over', /you started .* on another page or tab/.test(r[1].message) && /press Refresh again in (\d+ seconds|a minute|\d+ minutes)/.test(r[1].message));
      // 3 minutes later: a second admin is still locked out, by name.
      var p3 = page({ db: db, uid: 'u_admin2', clock: { offset: 3 * 60000 } });
      return Promise.all([p3.S.refresh(ADMIN2).then(function () { return null; }, function (e) { return e; }), p3.S.refreshIfStale(ADMIN2)]);
    }).then(function (r) {
      eq('3 minutes later: another admin still gets "locked"', [r[0] && r[0].code, r[1]], ['locked', null]);
      ok('... with the usual message naming who holds it', /Another refresh is running \(started 3 minutes ago by Test Admin\)/.test(r[0] && r[0].message));
      eq('... and nothing changed', [lockOf(db).by, lockOf(db).syncing, db.get('settings/mode/syncingAt')], ['u_admin', true, lockAt]);
      // 3 minutes later, the same admin opens My Tracker preview (page 4).
      var p4 = page({ db: db, opsDb: true, clock: { offset: 3 * 60000 } });
      return preview(p4).then(function () { return waitFor(function () { return /A refresh you started on another page or tab/.test(bannerOf(p4.el).text); }); }).then(function () {
        var b = bannerOf(p4.el);
        eq('Page 4: the automatic check steps aside (no gateway call)', p4.gateway.n, 0);
        eq('... the banner says it is their own refresh and the button can be pressed', [b.button, b.disabled, /press Refresh from sheet now to take it over/.test(b.text)], ['Refresh from sheet now', false, true]);
        b.btn.click();
        return waitFor(function () { return /Copied from the sheet just now/.test(bannerOf(p4.el).msg); });
      }).then(function () {
        var m = db.get('settings/mode'), done = importsWith(db, /"status":"done"/);
        eq('Pressing it takes the lock over and finishes the copy', [p4.gateway.n, m.syncing, 'copyIncomplete' in m, m.lastSyncBy, m.lastSyncAt > hourAgo], [1, false, false, 'u_admin', true]);
        eq('... every node is in place', Object.keys(db.get('service/F26')).sort(), ['u_avery', 'u_blake']);
        eq('... and the log says which lock it took over', [done.length, done[0].tookOverLockAt], [1, lockAt]);
        // Page 1 is finally closed: it left the server nothing to run, so the new copy stays as it is.
        return p1.close().then(function (ops) {
          var m2 = db.get('settings/mode');
          eq('Page 1 closing later does not undo the new copy', [ops.length, m2.syncing, 'copyIncomplete' in m2, m2.lastSyncAt], [0, false, false, m.lastSyncAt]);
        });
      });
    });
  });
});

test('a refresh whose lock was taken over stops without writing', function () {
  var g1 = gate(), g2 = gate();
  var p1 = page({ seed: seed(), gate: g1.promise, exp: function () { var e = fx.exportV2(); e.tabs.Payments_Fines.rows = e.tabs.Payments_Fines.rows.filter(function (r) { return r.Item !== 'Late fee'; }); return e; } });
  var db = p1.db;
  var r1 = codeOf(p1.S.refresh(ADMIN));
  var p3 = null, r3 = null;
  return waitFor(function () { return p1.gateway.n === 1; }).then(function () {
    var p2 = page({ db: db, clock: { offset: 3 * 60000 } });
    return p2.S.refresh(ADMIN);      // the same admin, 3 minutes later, presses Refresh on another page
  }).then(function (s2) {
    eq('The same admin\'s press 3 minutes later takes over and finishes', [s2.ok, lockOf(db).syncing], [true, false]);
    // Page 3 also waits on the gateway while page 1 is taken over again, then gets the same export as the site has.
    p3 = page({ db: db, gate: g2.promise });
    r3 = codeOf(p3.S.refresh(ADMIN));
    return waitFor(function () { return p3.gateway.n === 1; });
  }).then(function () {
    var p4 = page({ db: db, clock: { offset: 3 * 60000 } });
    return p4.S.refresh(ADMIN);
  }).then(function () {
    var mark = db.writes.length, before = db.get('settings/mode');
    g1.open(); g2.open();
    return Promise.all([r1, r3]).then(function (codes) {
      var w = db.writes.slice(mark);
      eq('Both stopped runs say why', codes, ['taken-over', 'taken-over']);
      eq('... page 1 (its copy differs) wrote no node; page 3 (nothing to rewrite) saved no report', [nodeWrites({ writes: w }).length, w.indexOf('imports/sheetSync'), w.filter(function (x) { return /^changeLog\//.test(x); }).length], [0, -1, 0]);
      eq('... settings/mode is as the last finished copy left it', JSON.stringify(db.get('settings/mode')), JSON.stringify(before));
      eq('... and both are logged as failed', importsWith(db, /"code":"taken-over"/).map(function (r) { return r.status; }), ['failed', 'failed']);
    });
  });
});

test('a dropped connection keeps the lock: no second refresh starts in the gap, and the run finishes when it is back', function () {
  var g = gate();
  var p = page({ seed: seed2({ 'settings/mode': { source: 'sheet', lastSyncAt: 1000 } }), gate: g.promise });
  var r = p.S.refresh(ADMIN);
  return waitFor(function () { return p.gateway.n === 1; }).then(function () {
    return p.db.disconnect(p.conn);   // the server notices the drop
  }).then(function (ops) {
    p.conn.closed = false;            // the SDK reconnects; the run goes on
    eq('After the drop the server has nothing to run, and the lock is still held', [ops.length, lockOf(p.db).syncing, lockOf(p.db).by], [0, true, 'u_admin']);
    var other = page({ db: p.db, uid: 'u_admin2' });
    return Promise.all([codeOf(other.S.refresh(ADMIN2)), other.S.refreshIfStale(ADMIN2)]).then(function (o) {
      eq('... so another admin cannot start a second refresh in the gap', [o[0], o[1], other.gateway.n], ['locked', null, 0]);
      g.open();
      return r;
    });
  }).then(function (s) {
    var m = p.db.get('settings/mode');
    eq('The run finishes and records the copy', [s.ok, m.syncing, 'copyIncomplete' in m, m.lastSyncAt > 1000, 'syncingBy' in m], [true, false, false, true, false]);
  });
});

/** The fixture with n more waived fines for Avery: two ledger entries each, so the ledger is written in several chunks. */
function bigLedger(n) {
  return function () {
    var e = fx.exportV2();
    for (var i = 0; i < n; i++) e.tabs.Payments_Fines.rows.push({ 'Brother Name': 'Avery Stone', Item: 'Fine ' + i, Amount: 5, 'Due Date': '2026-09-10', 'Payment Status': 'Waived', 'Date Paid': '2026-09-11', 'Demerits If Unpaid/Late': 0 });
    return e;
  };
}
function ledgerEntries(paths) { return paths.filter(function (w) { return /^ledger\/F26\/[^/]+\/[^/]+$/.test(w); }); }

/**
 * Page 1 refreshes. Right after its first write matching `after` lands, the same admin's press on page 2,
 * 3 minutes later, takes the lock over (page 2 then waits at the gateway): page 1's next check of the lock
 * is held until page 2 has it. Then page 1 goes on, and later page 2 makes its copy.
 */
function takenOverAfter(after, exp) {
  var g2 = gate(), hold = gate(), held = false;
  var p1 = page({ seed: seed(), exp: exp });
  var db = p1.db, p2 = page({ db: db, clock: { offset: 3 * 60000 }, gate: g2.promise, exp: exp });
  var out = { db: db };
  db.onRead = function (path, conn) {
    if (held || conn !== p1.conn || path !== 'settings/mode' || !db.writes.some(function (w) { return after.test(w); })) return null;
    held = true;
    out.before = db.writes.slice();   // what page 1 wrote before the takeover
    return hold.promise;
  };
  var r1 = p1.S.refresh(ADMIN).then(function () { return null; }, function (e) { return e; });
  return waitFor(function () { return held; }).then(function () {
    out.lock1 = db.get('settings/mode/syncingAt');
    out.r2 = p2.S.refresh(ADMIN);
    return waitFor(function () { return db.get('settings/mode/syncingAt') !== out.lock1 && p2.gateway.n === 1; });
  }).then(function () {
    out.mark = db.writes.length;
    out.modeAtTakeover = db.get('settings/mode');
    hold.open();
    return r1;
  }).then(function (err) {
    out.err = err;
    out.after = db.writes.slice(out.mark);   // what page 1 wrote after the takeover (page 2 is still at the gateway)
    out.modeAfter = db.get('settings/mode');
    db.onRead = null;
    g2.open();
    return out.r2;
  }).then(function (s2) { out.s2 = s2; return out; });
}

test('a run taken over between two node writes writes nothing after the takeover', function () {
  return takenOverAfter(/^events\/F26$/).then(function (o) {
    var db = o.db, rec = importsWith(db, /"code":"taken-over"/);
    eq('Before the takeover page 1 had marked the copy and written the events, nothing else',
      [o.before.indexOf('events/F26') !== -1, nodeWrites({ writes: o.before }), o.modeAtTakeover.copyIncomplete], [true, ['events/F26'], true]);
    eq('After it: page 1 stops with "taken-over" and writes only its log row', [o.err && o.err.code, o.after.length, /^imports\/push/.test(o.after[0])], ['taken-over', 1, true]);
    ok('... it says it stopped partway and that the other refresh makes the copy (no "Refresh again")',
      !!o.err && /took over this one partway/.test(o.err.message) && /makes the whole copy again/.test(o.err.message) && !/Refresh again/.test(o.err.message));
    eq('... settings/mode is as the takeover left it: page 2\'s lock, copyIncomplete untouched', JSON.stringify(o.modeAfter), JSON.stringify(o.modeAtTakeover));
    eq('... the run is logged as partial', [rec.length, rec[0] && rec[0].status], [1, 'partial']);
    var m = db.get('settings/mode');
    eq('Page 2 then makes the whole copy and clears the mark', [o.s2.ok, m.syncing, 'copyIncomplete' in m, m.lastSyncBy, Object.keys(db.get('service/F26')).sort()], [true, false, false, 'u_admin', ['u_avery', 'u_blake']]);
  });
});

test('a run taken over between two ledger chunks writes nothing after the takeover', function () {
  return takenOverAfter(/^ledger\/F26\/[^/]+\/[^/]+$/, bigLedger(200)).then(function (o) {
    var db = o.db, rec = importsWith(db, /"code":"taken-over"/);
    var full = 0, led = db.get('ledger/F26') || {};
    Object.keys(led).forEach(function (u) { full += Object.keys(led[u]).length; });
    eq('Before the takeover page 1 had written every other node and one ledger chunk of 300 entries',
      [nodeWrites({ writes: o.before }).filter(function (w) { return !/^ledger\//.test(w); }).length, ledgerEntries(o.before).length], [8, 300]);
    eq('After it: page 1 stops with "taken-over" and writes only its log row', [o.err && o.err.code, o.after.length, ledgerEntries(o.after).length, /^imports\/push/.test(o.after[0])], ['taken-over', 1, 0, true]);
    eq('... settings/mode is as the takeover left it', JSON.stringify(o.modeAfter), JSON.stringify(o.modeAtTakeover));
    eq('... the run is logged as partial', [rec.length, rec[0] && rec[0].status], [1, 'partial']);
    var m = db.get('settings/mode');
    eq('Page 2 then rewrites the whole ledger (over 300 entries) and clears the mark', [o.s2.ok, full > 400, o.s2.counts.ledger === full, 'copyIncomplete' in m, m.syncing], [true, true, true, false, false]);
  });
});

test('a gateway that never answers times out, and the lock is let go', function () {
  var p = page({ hang: true, clock: { fake: true }, seed: seed({ 'settings/mode': { source: 'sheet', lastSyncAt: 1000 } }) });
  var S = p.S, r = codeOf(p.S.refresh(ADMIN));
  ok('The timeout is past Apps Script\'s 6 minutes and well under the 10-minute lock', S.GATEWAY_TIMEOUT_MS > 6 * 60000 && S.GATEWAY_TIMEOUT_MS < S.LOCK_MS - 60000);
  return waitFor(function () { return p.gateway.n === 1 && p.clock.timers.length > 0; }).then(function () {
    eq('While the gateway hangs: the lock is held and the page asks before leaving', [lockOf(p.db).syncing, typeof p.fire('beforeunload').returnValue], [true, 'string']);
    p.clock.advance(S.GATEWAY_TIMEOUT_MS - 1000);
    return pause(10);
  }).then(function () {
    eq('... still waiting a second before the limit', lockOf(p.db).syncing, true);
    p.clock.advance(1000);
    return r;
  }).then(function (code) {
    var m = p.db.get('settings/mode'), rec = importsWith(p.db, /gateway-timeout/)[0];
    eq('At the limit it fails with gateway-timeout', code, 'gateway-timeout');
    eq('... the lock is let go, nothing is marked unfinished, the last copy time is kept', [m.syncing, 'copyIncomplete' in m, m.lastSyncAt], [false, false, 1000]);
    eq('... the failure is logged, and the page stops asking', [rec && rec.status, p.fire('beforeunload').returnValue, p.conn.ondc.length], ['failed', undefined, 0]);
  });
});

test('a second press on the page that is refreshing is refused', function () {
  var g = gate();
  var p = page({ seed: seed(), gate: g.promise });
  var first = p.S.refresh(ADMIN);
  return waitFor(function () { return p.gateway.n === 1; }).then(function () {
    return p.S.refresh(ADMIN).then(function () { return null; }, function (e) { return e; });
  }).then(function (e) {
    eq('The second press: locked, "already running on this page"', [e && e.code, /already running on this page/.test(e && e.message)], ['locked', true]);
    g.open();
    return first;
  }).then(function (s) { eq('... and the first one finishes', [s.ok, lockOf(p.db).syncing], [true, false]); });
});

test('a refresh running when the site becomes the record stops before writing anything', function () {
  var g = gate();
  var p = page({ seed: seed({ 'settings/mode': { source: 'sheet', lastSyncAt: 1000 } }), gate: g.promise });
  var r = p.S.refresh(ADMIN).then(function () { return null; }, function (e) { return e; });
  var mark;
  return waitFor(function () { return p.gateway.n === 1; }).then(function () {
    p.db.write({ 'settings/mode/source': 'site' }, 'u_admin');   // the switch on Chapter Settings, made meanwhile
    mark = p.db.writes.length;
    g.open();
    return r;
  }).then(function (e) {
    var after = p.db.writes.slice(mark);
    eq('It stops with site-mode and writes no part of the copy', [e && e.code, nodeWrites({ writes: after }).length, p.db.get('settings/mode/copyIncomplete') === true], ['site-mode', 0, false]);
    ok('... and says the site became the record (no "Refresh again")', !!e && /site became the record/.test(e.message) && !/Refresh again/.test(e.message));
    eq('... the switch stays as it was made', p.db.get('settings/mode/source'), 'site');
  });
});

test('once another refresh takes the lock, this page stops asking before leaving and pagehide logs nothing for it', function () {
  var g = gate();
  var p = page({ seed: seed2({ 'settings/mode': { source: 'sheet', lastSyncAt: 1000 } }), gate: g.promise });
  var r = p.S.refresh(ADMIN).then(function () { return null; }, function (e) { return e; });
  return waitFor(function () { return p.gateway.n === 1; }).then(function () {
    eq('While it holds the lock the page asks before leaving', typeof p.fire('beforeunload').returnValue, 'string');
    p.db.write({ 'settings/mode/syncingAt': Date.now() + 1, 'settings/mode/syncingBy': 'u_admin2', 'settings/mode/syncingByName': 'Second Admin' }, 'u_admin2');
    return waitFor(function () { return p.handlers('beforeunload') === 0; });
  }).then(function () {
    eq('After the takeover: no prompt, no handlers left', [p.fire('beforeunload').returnValue, p.handlers('beforeunload'), p.handlers('pagehide')], [undefined, 0, 0]);
    p.fire('pagehide');
    eq('... pagehide neither logs "left-page" nor touches the new holder\'s lock', [importsWith(p.db, /left-page/).length, p.db.get('settings/mode/syncingBy')], [0, 'u_admin2']);
    g.open();
    return r;
  }).then(function (e) {
    eq('... and the run stops at its first write, writing nothing', [e && e.code, p.db.get('settings/mode/copyIncomplete') === true], ['taken-over', false]);
  });
});

steps.reduce(function (chain, s) {
  return chain.then(function () { return Promise.resolve().then(s.fn); }).catch(function (e) { failN++; console.log('FAIL ' + s.name + ' threw: ' + (e && e.stack || e)); });
}, Promise.resolve()).then(function () {
  console.log('');
  console.log(failN ? failN + ' FAILED, ' + pass + ' passed' : 'All ' + pass + ' runner tests passed');
  process.exit(failN ? 1 : 0);
});
