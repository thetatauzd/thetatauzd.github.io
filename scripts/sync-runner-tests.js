#!/usr/bin/env node
/**
 * Drives the real PortalSync runner (portal/js/sheet-sync.js) against an in-memory database and a fake
 * gateway. The fake database enforces the rules the runner depends on (firebase-database.rules.json):
 *   ledger/{term}            written only to clear it (admin, !newData.exists())
 *   ledger/{term}/{uid}/{id} only when it does not exist yet, with type, createdBy = the signed-in admin, createdAt
 *   service, excuses, excuseFlags  their .validate rules
 * and Firebase's own behaviour: no overlapping paths in one update, and a transaction that first runs on a
 * cold (null) cache. db.failOn (a RegExp) makes writes to matching paths fail, like a dropped page.
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
function FakeDb(authUid) {
  this.data = {};
  this.auth = authUid;
  this.writes = [];
  this.pushN = 0;
  this.failOn = null;
}
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
FakeDb.prototype.put = function (p, v) {
  var parts = p.split('/');
  if (!this.data || typeof this.data !== 'object') this.data = {};
  var o = this.data;
  for (var i = 0; i < parts.length - 1; i++) { if (!o[parts[i]] || typeof o[parts[i]] !== 'object') o[parts[i]] = {}; o = o[parts[i]]; }
  if (v === null || v === undefined) delete o[parts[parts.length - 1]]; else o[parts[parts.length - 1]] = clone(v);
  this.data = prune(this.data) || {};
};
FakeDb.prototype.allowed = function (p, oldVal, newVal) {
  var a = p.split('/'), uid = this.auth;
  if (uid !== 'u_admin') return 'denied: not admin';
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
  if (a[0] === 'service' && a.length === 2 && newVal) return each(newVal, function (e) { return (!e.status || typeof e.hours !== 'number' || e.hours < 0 || e.hours > 200) ? 'invalid service entry' : null; });
  if (a[0] === 'excuses' && a.length === 2 && newVal) return each(newVal, function (e) { return (!e.status || (e.reason !== undefined && (typeof e.reason !== 'string' || e.reason.length > 4000))) ? 'invalid excuse' : null; });
  if (a[0] === 'excuseFlags' && a.length === 2 && newVal) return each(newVal, function (v) { return /^(late_|early_)?(pending|approved|denied)$/.test(v) ? null : 'invalid flag'; });
  return null;
};
FakeDb.prototype.write = function (map) {
  var self = this, paths = Object.keys(map);
  paths.forEach(function (a) { paths.forEach(function (b) { if (a !== b && b.indexOf(a + '/') === 0) throw new Error('Path ' + a + ' is an ancestor of ' + b); }); });
  if (self.failOn && paths.some(function (p) { return self.failOn.test(p); })) return Promise.reject(new Error('The write failed (test)'));
  for (var i = 0; i < paths.length; i++) {
    var why = self.allowed(paths[i], self.get(paths[i]), map[paths[i]] === undefined ? null : clone(map[paths[i]]));
    if (why) return Promise.reject(new Error('PERMISSION_DENIED ' + paths[i] + ': ' + why));
  }
  paths.forEach(function (p) { self.put(p, map[p]); self.writes.push(p); });
  return Promise.resolve();
};
FakeDb.prototype.ref = function (p) {
  var self = this;
  p = (p || '').replace(/^\/+|\/+$/g, '');
  var r = {
    key: p.split('/').pop(),
    once: function () { var v = self.get(p); return Promise.resolve({ val: function () { return v; }, exists: function () { return v !== null; } }); },
    set: function (v) { var m = {}; m[p] = v; return self.write(m); },
    update: function (m) { var full = {}; Object.keys(m).forEach(function (k) { full[(p ? p + '/' : '') + k] = m[k]; }); return self.write(full); },
    push: function (v) {
      var key = 'push' + String(++self.pushN).padStart(4, '0'), child = self.ref((p ? p + '/' : '') + key);
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
      return self.write(m).then(function () { return { committed: true, snapshot: null }; });
    },
    on: function () {}, off: function () {}
  };
  return r;
};

// ── A page with the real scripts ──
/** opts: { uid, seed, exp() (the export), db (reuse another page's database: a second visit) } */
function page(opts) {
  var db = opts.db || new FakeDb(opts.uid || 'u_admin');
  if (opts.seed) Object.keys(opts.seed).forEach(function (p) { db.put(p, opts.seed[p]); });
  var gatewayCalls = { n: 0 };
  var sb = { console: console, Promise: Promise, Date: Date, JSON: JSON, Math: Math, setTimeout: setTimeout };
  sb.window = sb;
  sb.sessionStorage = (function () { var s = {}; return { getItem: function (k) { return k in s ? s[k] : null; }, setItem: function (k, v) { s[k] = String(v); }, removeItem: function (k) { delete s[k]; } }; })();
  sb.document = { currentScript: null, createElement: function () { return {}; }, head: { appendChild: function () { throw new Error('the core should already be loaded'); } }, getElementById: function () { return null; } };
  sb.firebase = { database: function () { return db; }, auth: function () { return { currentUser: { getIdToken: function () { return Promise.resolve('token'); } } }; } };
  sb.firebase.database.ServerValue = { TIMESTAMP: { '.sv': 'timestamp' } };
  sb.fetch = function (url, init) {
    gatewayCalls.n++;
    var body = init && init.body ? JSON.parse(init.body) : null;
    var payload = /action=ping/.test(url) ? { ok: true, version: 2 } : (body && body.action === 'exportAll' ? (opts.exp ? opts.exp() : fx.exportV2()) : { ok: false, error: 'Unknown action' });
    return Promise.resolve({ json: function () { return Promise.resolve(JSON.parse(JSON.stringify(payload))); } });
  };
  var ctx = vm.createContext(sb);
  ['portal/js/ops-core.js', 'portal/js/ops-mode.js', 'portal/js/sheet-sync-core.js', 'portal/js/sheet-sync.js'].forEach(function (f) { vm.runInContext(read(f), ctx, { filename: f }); });
  return { db: db, S: sb.PortalSync, gateway: gatewayCalls, win: sb };
}

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
    var flagAt = d.writes.indexOf('settings/mode/copyIncomplete'), firstNode = d.writes.indexOf(nodeWrites(d)[0]);
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

steps.reduce(function (chain, s) {
  return chain.then(function () { return Promise.resolve().then(s.fn); }).catch(function (e) { failN++; console.log('FAIL ' + s.name + ' threw: ' + (e && e.stack || e)); });
}, Promise.resolve()).then(function () {
  console.log('');
  console.log(failN ? failN + ' FAILED, ' + pass + ' passed' : 'All ' + pass + ' runner tests passed');
  process.exit(failN ? 1 : 0);
});
