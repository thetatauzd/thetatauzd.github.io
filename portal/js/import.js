/**
 * Refresh from sheet (portal/import.html). Admin only.
 *
 * While the Tracker sheet is the record (OpsMode), this page runs PortalSync.refresh: it copies the sheet into
 * the site for the current term, replacing each copied node whole, and shows the report it saves in
 * imports/sheetSync (admins only): what was copied, every brother whose site total differs from the sheet's
 * DemeritDashboard, and the sheet names that matched no portal account, with a picker that saves an alias
 * (settings/sheetAliases, names only).
 *
 * The old one-time import is gone. It keyed rows by row number, could not correct the append-only ledger and
 * never removed deleted rows. The refresh does all of that safely, so the move to the site later is: refresh
 * one last time, then switch settings/mode/source to 'site'. From then on this page changes nothing.
 * Plain ES5.
 */
(function (global) {
  'use strict';

  var db = firebase.database();
  var C = global.OpsCore;
  var esc = C.esc;

  var me = null, users = {}, aliases = {}, mode = null, rawMode = {}, report = null, busy = false, gatewayV = undefined;
  var PART_LABELS = { rollover: 'roll-over', attendance: 'attendance', payment: 'payments', standards: 'standards adjustments', serviceCredit: 'service credit', total: 'total' };

  function $(id) { return document.getElementById(id); }
  function show(id, on) { var el = $(id); if (el) el.classList.toggle('hidden', !on); }
  function status(msg, kind) { var el = $('sync-status'); el.textContent = msg || ''; el.className = 'status-line' + (kind ? ' ' + kind : ''); }
  function nameOf(uid) { var u = users[uid]; return u ? (u.name || u.email || uid) : (uid || ''); }
  function isSheet() { return global.OpsMode.isSheet(mode); }
  function term() { return PortalOps.currentTerm(); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function fmt(n) { n = Number(n) || 0; return String(Math.round(n * 100) / 100); }
  /** A list saved in the database comes back as an array, or as an object with number keys. */
  function list(v) { return Array.isArray(v) ? v : (v && typeof v === 'object' ? Object.keys(v).sort(function (a, b) { return a - b; }).map(function (k) { return v[k]; }) : []); }

  // ── The top card ──

  function renderFacts() {
    var M = global.OpsMode;
    var held = typeof M.isSyncing === 'function' ? M.isSyncing(mode)
      : !!(rawMode && rawMode.syncing === true && typeof rawMode.syncingAt === 'number' && Date.now() - rawMode.syncingAt < PortalSync.LOCK_MS);
    var last = mode && mode.lastSyncAt ? M.when(mode.lastSyncAt) + (mode.lastSyncByName ? ' by ' + mode.lastSyncByName : '') : 'Never';
    if (mode && mode.copyIncomplete && !held && !busy) {   // while a refresh runs, the flag is its own and the Now line says so
      last = mode.lastSyncAt ? last + '. A refresh after that one stopped partway, so part of the copy may be older than the rest. Refresh again.'
        : 'None finished. A refresh stopped partway, so the copy is incomplete. Refresh again.';
    } else if (mode && mode.lastSyncAt && Date.now() - mode.lastSyncAt > (M.STALE_MS || 86400000)) last += ' (more than a day old)';   // age only: isStale is also true for an unfinished copy
    var gw = gatewayV === undefined ? 'Checking…'
      : (gatewayV >= 2 ? 'Up to date' : (gatewayV === null ? 'Could not reach it' : 'Old version. Redeploy Gateway.gs as a new version of the existing deployment (portal/apps-script/README.md, "Redeploy").'));
    $('sync-facts').innerHTML =
      '<dt>Term</dt><dd>' + esc(term()) + ' <span class="step-hint" style="margin:0;">(from Chapter Settings)</span></dd>' +
      '<dt>Last copy</dt><dd>' + esc(last) + '</dd>' +
      (held ? '<dt>Now</dt><dd><strong>' + esc((rawMode.syncingByName || 'An admin') + ' is refreshing (started ' + M.when(rawMode.syncingAt) + ').') + '</strong></dd>' : '') +
      '<dt>Gateway</dt><dd' + (gatewayV !== undefined && !(gatewayV >= 2) ? ' class="standing-bad"' : '') + '>' + esc(gw) + '</dd>';
    var sheet = isSheet();
    show('sec-refresh-actions', sheet);
    show('site-mode-note', !sheet);
    $('btn-refresh').disabled = busy || held;
    $('btn-check').disabled = busy || held;
  }

  // ── The report ──

  function diffText(m) {
    return list(m.parts).map(function (p) {
      if (p === 'total') return 'total ' + fmt(m.sheet.total) + ' on the sheet, ' + fmt(m.site.total) + ' here';
      if (p === 'serviceCredit') return 'service credit ' + fmt(m.site.serviceCredit) + ' here (the sheet gives none)';
      return PART_LABELS[p] + ' ' + fmt(m.sheet[p]) + ' on the sheet, ' + fmt(m.site[p]) + ' here';
    }).join('; ');
  }

  function renderReport(r, dry) {
    report = r;
    if (!r) { show('card-report', false); return; }
    show('card-report', true);
    $('report-title').textContent = dry ? 'Check only. Nothing was saved.' : 'Last refresh';
    var when = r.at ? global.OpsMode.when(Date.parse(r.at)) : '';
    $('report-sub').textContent = (dry ? 'This is what a refresh would copy into ' : 'Copied into ') + (r.term || '') + (when ? ' ' + when : '') + (r.byName ? ' by ' + r.byName : '') + (r.auto ? ' (on its own, when a preview page was opened)' : '') + '.';

    // Comparison
    var mism = list(r.mismatches), notC = list(r.notCompared), compared = r.compared || 0;
    var sum = compared
      ? (mism.length ? (compared - mism.length) + ' of ' + compared + ' brothers on the DemeritDashboard have the same total here. ' + plural(mism.length, 'differs', 'differ') + '.'
                     : 'All ' + compared + ' brothers on the DemeritDashboard have the same total here.')
      : 'No DemeritDashboard row matched a portal account, so nothing could be checked.';
    if (notC.length) sum += ' ' + plural(notC.length, 'dashboard name has', 'dashboard names have') + ' no portal account, so ' + (notC.length === 1 ? 'it was' : 'they were') + ' not checked (see the names below).';
    $('cmp-summary').textContent = sum;
    $('cmp-summary').className = mism.length ? 'standing-bad' : (compared ? 'standing-good' : '');
    show('cmp-hint', mism.length > 0);
    show('cmp-table-wrap', mism.length > 0);
    $('tbody-mismatch').innerHTML = mism.map(function (m) {
      return '<tr><td>' + esc(m.name) + (m.uid && users[m.uid] && users[m.uid].name !== m.name ? '<br><span class="step-hint" style="margin:0;">account: ' + esc(nameOf(m.uid)) + '</span>' : '') + '</td>' +
        '<td>' + esc(fmt(m.sheet.total)) + '</td><td>' + esc(fmt(m.site.total)) + '</td><td>' + esc(diffText(m)) + '</td></tr>';
    }).join('');
    var svc = list(r.serviceDiffs);
    show('svc-details', svc.length > 0);
    $('svc-count').textContent = svc.length;
    $('tbody-svc').innerHTML = svc.map(function (s) {
      return '<tr><td>' + esc(s.name) + '</td><td>' + esc(fmt(s.sheet.hours)) + ' h, ' + esc(fmt(s.sheet.events)) + '</td><td>' + esc(fmt(s.site.hours)) + ' h, ' + esc(fmt(s.site.events)) + '</td></tr>';
    }).join('');

    renderUnmatched(r);

    // Counts
    var counts = r.counts || {}, before = r.before || {}, changed = r.changed || null;
    $('tbody-counts').innerHTML = SheetSyncCore.NODES.map(function (n) {
      var chip = changed ? (changed[n] ? '<span class="count-pill warn">updated</span>' : '<span class="count-pill good">no change</span>') : '<span class="count-pill">check only</span>';
      return '<tr><td>' + esc(SheetSyncCore.NODE_LABELS[n]) + '</td><td>' + esc(counts[n] || 0) + '</td><td>' + (r.before ? esc(before[n] || 0) : '') + '</td><td>' + chip + '</td></tr>';
    }).join('');
    show('th-before', !!r.before);
    // Where the roll-over came from (only a tab for the term before is copied; a skipped one is in the Notes).
    var ro = $('rollover-line');
    if (ro) {
      ro.textContent = r.rolloverTab ? 'Roll-over demerits come from the sheet tab "' + r.rolloverTab + '".'
        : (r.rolloverTab === '' ? 'No roll-over tab was copied. The Notes say why when the sheet has one for another term.' : '');
      show('rollover-line', !!ro.textContent);
    }

    // Roster vs User Management
    var rd = list(r.rosterDiffs);
    show('roster-details', rd.length > 0);
    $('roster-count').textContent = rd.length;
    $('tbody-roster').innerHTML = rd.map(function (d) {
      return '<tr><td>' + esc(d.name || nameOf(d.uid)) + '</td><td>' + esc(d.sheet || 'Not on the Roster') + '</td><td>' + esc(d.site) + '</td></tr>';
    }).join('');

    // Notes
    var w = list(r.warnings);
    show('warn-details', w.length > 0);
    $('warn-count').textContent = w.length;
    $('list-warnings').innerHTML = w.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('');
  }

  function accountOptions() {
    return Object.keys(users).filter(function (uid) { return users[uid] && users[uid].role !== 'pending' && users[uid].status !== 'pending'; })
      .sort(function (a, b) { return String(nameOf(a)).localeCompare(String(nameOf(b))); })
      .map(function (uid) {
        var u = users[uid];
        return '<option value="' + esc(uid) + '">' + esc(nameOf(uid)) + (u.rollNumber ? ' (#' + esc(C.rollKey(u.rollNumber)) + ')' : '') + '</option>';
      }).join('');
  }

  function unmatchedRow(u, opts) {
    var saved = aliases[u.key];
    var tabs = list(u.tabs).map(function (t) { return t.replace(/_/g, ' '); }).join(', ');
    return '<tr data-key="' + esc(u.key) + '" data-name="' + esc(u.name) + '"><td>' + esc(u.name) + (u.ambiguous ? '<br><span class="step-hint" style="margin:0;">This name could be more than one person (two accounts, or a roll number that points elsewhere), so its rows are left out. Pick the right account.</span>' : '') + '</td>' +
      '<td>' + esc(u.roll || '') + '</td><td>' + esc(tabs) + '</td>' +
      '<td><select class="field alias-select" style="max-width:260px;"><option value="">Pick an account…</option><option value="__ignore">No portal account (stop asking)</option>' + opts + '</select></td>' +
      '<td><button type="button" class="btn btn-small alias-save">Save</button><span class="step-hint alias-note" style="display:block;margin:0.2rem 0 0;">' +
      (saved ? esc(saved.ignore ? 'Saved as no account.' : 'Saved as ' + nameOf(saved.uid) + '.') + ' Used from the next refresh.' : '') + '</span></td></tr>';
  }

  function renderUnmatched(r) {
    var all = list(r.unmatched);
    var withData = all.filter(function (u) { return u.hasData; }), rosterOnly = all.filter(function (u) { return !u.hasData; });
    var opts = accountOptions();
    $('unmatched-summary').textContent = all.length
      ? plural(withData.length, 'name has', 'names have') + ' rows this term but no portal account' + (rosterOnly.length ? ', and ' + plural(rosterOnly.length, 'Roster name has', 'Roster names have') + ' nothing this term' : '') + '. Their rows are left out of the copy until you match them.'
      : 'Every name on the sheet matched a portal account.';
    show('unmatched-wrap', withData.length > 0);
    $('tbody-unmatched').innerHTML = withData.map(function (u) { return unmatchedRow(u, opts); }).join('');
    show('roster-only-details', rosterOnly.length > 0);
    $('roster-only-count').textContent = rosterOnly.length;
    $('tbody-roster-only').innerHTML = rosterOnly.map(function (u) { return unmatchedRow(u, opts); }).join('');
    var ign = list(r.ignored);
    show('ignored-line', ign.length > 0);
    $('ignored-line').textContent = ign.length ? 'Saved as having no portal account: ' + ign.map(function (x) { return x.name; }).join(', ') + '.' : '';
  }

  function onAliasSave(btn) {
    var tr = btn.closest('tr'), sel = tr.querySelector('.alias-select'), note = tr.querySelector('.alias-note');
    var key = tr.getAttribute('data-key'), name = tr.getAttribute('data-name'), v = sel.value;
    if (!v) { note.textContent = 'Pick an account first.'; return; }
    if (!/^[a-z0-9_]{1,80}$/.test(key)) { note.textContent = 'This name cannot be saved.'; return; }
    var rec = v === '__ignore' ? { name: name, ignore: true } : { name: name, uid: v };
    btn.disabled = true;
    db.ref('settings/sheetAliases/' + key).set(rec).then(function () {
      aliases[key] = rec;
      note.textContent = (rec.ignore ? 'Saved as no account.' : 'Saved as ' + nameOf(v) + '.') + ' Used from the next refresh.';
      renderAliases();
    }).catch(function (err) { note.textContent = 'Could not save: ' + (err.message || err); })
      .then(function () { btn.disabled = false; });
  }

  // ── Saved aliases ──

  function renderAliases() {
    var keys = Object.keys(aliases).sort(function (a, b) { return String(aliases[a].name).localeCompare(String(aliases[b].name)); });
    show('aliases-empty', !keys.length);
    show('aliases-wrap', keys.length > 0);
    $('tbody-aliases').innerHTML = keys.map(function (k) {
      var a = aliases[k];
      var target = a.ignore ? 'No portal account' : (users[a.uid] ? nameOf(a.uid) : 'An account that no longer exists');
      return '<tr data-key="' + esc(k) + '"><td>' + esc(a.name || k) + '</td><td>' + esc(target) + '</td><td><button type="button" class="btn-text alias-remove">Remove</button></td></tr>';
    }).join('');
  }

  function onAliasRemove(btn) {
    var key = btn.closest('tr').getAttribute('data-key');
    var a = aliases[key];
    if (!a || !confirm('Stop matching "' + (a.name || key) + '"? The next refresh treats it as unmatched again.')) return;
    btn.disabled = true;
    db.ref('settings/sheetAliases/' + key).set(null).then(function () { delete aliases[key]; renderAliases(); if (report) renderUnmatched(report); })
      .catch(function (err) { alert('Could not remove it: ' + (err.message || err)); btn.disabled = false; });
  }

  // ── Running a refresh ──

  function run(dryRun, allowShrink) {
    if (busy) return;
    busy = true; renderFacts();
    status(dryRun ? 'Checking the sheet…' : 'Starting…');
    PortalSync.refresh(me, { dryRun: dryRun, allowShrink: !!allowShrink, onProgress: function (t) { status(t); } }).then(function (s) {
      busy = false;
      if (dryRun) {
        status('Checked. Nothing was saved. ' + checkLine(s), s.mismatches || s.unmatched ? '' : 'success');
        renderReport(s.report, true);
        renderFacts();
        return;
      }
      status((s.changedNodes ? 'Copied. ' + plural(s.changedNodes, 'part') + ' changed. ' : 'Copied. Nothing had changed on the sheet. ') + checkLine(s), s.mismatches ? '' : 'success');
      return Promise.all([loadMode(), loadReport()]).then(function () { renderFacts(); renderReport(report, false); });
    }).catch(function (err) {
      busy = false; renderFacts();
      if (err && err.code === 'shrink' && !dryRun && confirm(err.message + '\n\nCopy it anyway?')) { run(false, true); return; }
      status((err && err.message) || 'The refresh failed.', 'error');
    });
  }

  function checkLine(s) {
    var parts = [];
    if (s.compared) parts.push(s.matching + ' of ' + s.compared + ' totals match the sheet');
    if (s.unmatched) parts.push(plural(s.unmatched, 'name', 'names') + ' not matched');
    return parts.length ? parts.join(', ') + '.' : '';
  }

  // ── Loading ──

  function loadMode() {
    return Promise.all([global.OpsMode.load(true), db.ref('settings/mode').once('value')]).then(function (r) { mode = r[0]; rawMode = r[1].val() || {}; });
  }
  function loadReport() {
    return db.ref('imports/sheetSync').once('value').then(function (s) { report = s.val(); }).catch(function () { report = null; });
  }

  function init() {
    PortalAuth.requireAdmin().then(function (profile) {
      if (!profile) return null;
      me = profile;
      PortalAuth.initNav(profile);
      return Promise.all([
        PortalOps.loadSettings(true), PortalOps.loadUsers(), loadMode(), loadReport(),
        db.ref('settings/sheetAliases').once('value').then(function (s) { aliases = s.val() || {}; }),
        PortalSync.ensureCore()
      ]);
    }).then(function (r) {
      if (!r) return;
      users = r[1] || {};
      renderFacts();
      renderReport(report, false);
      renderAliases();
      $('btn-refresh').addEventListener('click', function () { run(false, false); });
      $('btn-check').addEventListener('click', function () { run(true, false); });
      document.addEventListener('click', function (e) {
        var t = e.target;
        if (t.classList.contains('alias-save')) onAliasSave(t);
        if (t.classList.contains('alias-remove')) onAliasRemove(t);
      });
      // Another admin's refresh (or one started on a preview page) shows here as it happens.
      db.ref('settings/mode').on('value', function (s) {
        var v = s.val() || {};
        var finished = rawMode && v.lastSyncAt && v.lastSyncAt !== rawMode.lastSyncAt;
        rawMode = v; mode = global.OpsMode._normalise ? global.OpsMode._normalise(v) : mode;
        renderFacts();
        if (finished && !busy) loadReport().then(function () { renderReport(report, false); });
      }, function () {});
      PortalSync.gatewayVersion().then(function (v) { gatewayV = v; renderFacts(); });
    }).catch(function (err) {
      status('Could not load this page: ' + ((err && err.message) || err), 'error');
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(typeof window !== 'undefined' ? window : this);
