/**
 * One-time import of the F26 Theta Tau Tracker sheet into the portal.
 * Admin only. Reads the whole workbook through Gateway.gs `exportAll`,
 * matches rows to portal accounts, and writes term-scoped facts. Keys are
 * deterministic (imp_*) so re-running overwrites rather than duplicates.
 */
(function(global) {
  'use strict';

  var db = firebase.database();
  var C = global.OpsCore;
  var GATEWAY_URL = 'https://script.google.com/macros/s/AKfycbzEprjKfxyqZkDCxMvUEEXkkBKaarDWQlCd1YLeTKjdm-djAxnE5dlrlpwMRfdxRWNR/exec';

  var me = null, settings = null, users = {}, data = null;
  var byRoll = {}, byName = {};        // uid lookups from portal accounts
  var manual = {};                     // sheet name -> uid picked by hand
  var esc = C.esc;
  function $(id) { return document.getElementById(id); }
  function status(id, msg, kind) { var el = $(id); el.textContent = msg || ''; el.className = 'status-line' + (kind ? ' ' + kind : ''); }

  function callGateway(payload) {
    return firebase.auth().currentUser.getIdToken().then(function(idToken) {
      return fetch(GATEWAY_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(Object.assign({ idToken: idToken }, payload)) });
    }).then(function(r) { return r.json(); }).then(function(d) {
      if (!d || d.ok === false) throw new Error((d && d.error) || 'Gateway failed.');
      return d;
    });
  }

  // ── Matching ──

  function indexUsers() {
    byRoll = {}; byName = {};
    Object.keys(users).forEach(function(uid) {
      var u = users[uid];
      var rk = C.rollKey(u.rollNumber); if (rk) byRoll[rk] = uid;
      var nk = C.nameKey(u.name); if (nk) byName[nk] = uid;
    });
  }
  function uidFor(name, roll) {
    var rk = C.rollKey(roll);
    if (rk && byRoll[rk]) return byRoll[rk];
    var nk = C.nameKey(name);
    if (nk && byName[nk]) return byName[nk];
    if (manual[nk]) return manual[nk];
    return null;
  }
  function rows(tab) { return (data && data.tabs && data.tabs[tab] && data.tabs[tab].rows) || []; }
  function col(row, names) {
    for (var i = 0; i < names.length; i++) { var k = Object.keys(row).find(function(h) { return h.toLowerCase() === names[i].toLowerCase(); }); if (k !== undefined) return row[k]; }
    return undefined;
  }
  function num(v) { var n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? 0 : n; }
  function bool(v) { return v === true || /^(true|yes|y|1|approved|confirmed)$/i.test(String(v || '').trim()); }
  function ymd(v) { return C.ymd(v) || ''; }

  var STATUS_MAP = { active: 'active', inactive: 'inactive', 'co-op': 'coop', coop: 'coop', alumnus: 'alumnus', alumni: 'alumnus', graduated: 'graduated', pnm: 'pnm' };

  function renderMatching() {
    var tb = $('tbody-unmatched'); tb.innerHTML = '';
    var roster = rows('Roster');
    var matched = 0, unmatched = 0;
    var options = Object.keys(users).sort(function(a, b) { return (users[a].name || '').localeCompare(users[b].name || ''); })
      .map(function(uid) { return '<option value="' + uid + '">' + esc(users[uid].name || users[uid].email) + (users[uid].rollNumber ? ' (#' + esc(users[uid].rollNumber) + ')' : '') + '</option>'; }).join('');
    roster.forEach(function(r) {
      var name = col(r, ['Brother Name', 'Name']); var roll = col(r, ['Roll Number', 'Roll #', 'Roll']);
      if (!name) return;
      if (uidFor(name, roll)) { matched++; return; }
      unmatched++;
      var tr = document.createElement('tr');
      tr.innerHTML = '<td>' + esc(name) + '</td><td>' + esc(C.rollKey(roll)) + '</td><td>' + esc(col(r, ['Status']) || '') + '</td>' +
        '<td><select class="field match-select" data-name="' + esc(C.nameKey(name)) + '" style="max-width:280px;"><option value="">No account (roster only)</option>' + options + '</select></td>';
      tb.appendChild(tr);
    });
    tb.querySelectorAll('.match-select').forEach(function(sel) {
      sel.addEventListener('change', function() { if (this.value) manual[this.getAttribute('data-name')] = this.value; else delete manual[this.getAttribute('data-name')]; updateSummary(); });
    });
    if (!unmatched) tb.innerHTML = '<tr><td colspan="4" class="section-empty">Everyone on the roster matched a portal account.</td></tr>';
    updateSummary();
    function updateSummary() {
      var m = Object.keys(manual).length;
      $('match-summary').textContent = matched + ' matched automatically' + (m ? ', ' + m + ' matched by hand' : '') + ', ' + (unmatched - m) + ' without an account (kept for sign-up autofill).';
    }
  }

  function renderOptions() {
    var tabs = ['Roster', 'Config', 'Event_Info', 'Attendance', 'Payments_Fines', 'Standards_Adjustments', 'Rollover', 'Service_Log', 'Excuses'];
    var labels = { Roster: 'Roster → member status, roll-call order, sign-up roster', Config: 'Config → settings (only if none exist)', Event_Info: 'Event_Info → events', Attendance: 'Attendance → attendance marks', Payments_Fines: 'Payments_Fines → ledger', Standards_Adjustments: 'Standards_Adjustments → adjustments', Rollover: 'Rollover demerits → rollover', Service_Log: 'Service_Log → service entries', Excuses: 'Excuses → excuse requests' };
    $('imp-options').innerHTML = tabs.map(function(t) {
      var n = rows(t).length;
      return '<label><input type="checkbox" class="imp-opt" value="' + t + '"' + (n ? ' checked' : ' disabled') + '> ' + esc(labels[t]) + ' <span class="count-pill">' + n + ' rows</span></label>';
    }).join('');
  }

  // ── Fetch ──

  function fetchSheet() {
    status('fetch-status', 'Reading the sheet through the gateway…');
    $('btn-fetch').disabled = true;
    callGateway({ action: 'exportAll' }).then(function(d) {
      data = d;
      var counts = $('tab-counts'); counts.innerHTML = '';
      Object.keys(d.tabs).forEach(function(t) { counts.innerHTML += '<dt>' + esc(t) + (d.tabs[t].tab ? ' (' + esc(d.tabs[t].tab) + ')' : '') + '</dt><dd>' + d.tabs[t].rows.length + ' rows</dd>'; });
      status('fetch-status', 'Fetched ' + Object.keys(d.tabs).length + ' tabs.', 'success');
      indexUsers(); renderMatching(); renderOptions();
      $('step-match').classList.remove('hidden'); $('step-apply').classList.remove('hidden');
      $('apply-term').textContent = term();
    }).catch(function(err) { status('fetch-status', err.message || 'Failed.', 'error'); })
      .finally(function() { $('btn-fetch').disabled = false; });
  }

  function term() { return (($('imp-term').value || '').trim().toUpperCase()) || PortalOps.currentTerm(); }
  function prevTerm() { return (($('imp-prev').value || '').trim().toUpperCase()) || ''; }

  // ── Apply ──

  var log = [];
  function say(msg) { log.push(msg); var el = $('apply-log'); el.style.display = ''; el.textContent = log.join('\n'); el.scrollTop = el.scrollHeight; }

  function chunkedUpdate(updates) {
    var keys = Object.keys(updates);
    var chains = Promise.resolve();
    for (var i = 0; i < keys.length; i += 300) {
      (function(slice) {
        chains = chains.then(function() {
          var part = {}; slice.forEach(function(k) { part[k] = updates[k]; });
          return db.ref().update(part);
        });
      })(keys.slice(i, i + 300));
    }
    return chains.then(function() { return keys.length; });
  }

  function eventTypeKey(label) {
    var l = String(label || '').toLowerCase().trim();
    var hit = Object.keys(settings.eventTypes).find(function(k) { return settings.eventTypes[k].label.toLowerCase() === l; });
    if (hit) return hit;
    if (/voting/.test(l)) return 'voting';
    if (/chapter/.test(l)) return 'chapter';
    if (/rush/.test(l)) return 'rush';
    if (/initiation/.test(l)) return 'initiation';
    if (/philanthropy/.test(l)) return 'philanthropy';
    if (/committee/.test(l)) return 'committee';
    return 'other';
  }
  function eventKey(title) { return C.nameKey(title); }

  function apply() {
    var T = term(), P = prevTerm();
    var opts = {}; document.querySelectorAll('.imp-opt:checked').forEach(function(cb) { opts[cb.value] = true; });
    if (!confirm('Import the selected tabs into term ' + T + '? Imported records are overwritten on re-run, never duplicated.')) return;
    $('btn-apply').disabled = true; log = []; status('apply-status', 'Importing…');
    var counts = {}, unmatchedRows = [];
    var updates = {};
    var now = new Date().toISOString();
    var audit = { createdBy: me.uid, createdByName: me.name || '', createdAt: now, imported: true };

    var chain = Promise.resolve();

    // Roster → users (status, sortOrder, roll), roster nodes.
    if (opts.Roster) chain = chain.then(function() {
      var n = 0, rosterOnly = 0;
      var seq = Promise.resolve();
      rows('Roster').forEach(function(r) {
        var name = col(r, ['Brother Name', 'Name']); if (!name) return;
        var roll = C.rollKey(col(r, ['Roll Number', 'Roll #', 'Roll']));
        var st = STATUS_MAP[String(col(r, ['Status']) || 'active').toLowerCase().trim()] || 'active';
        var uid = uidFor(name, roll);
        if (roll) { updates['roster/' + roll] = { name: name }; updates['rosterByName/' + C.nameKey(name)] = { roll: roll, name: name }; }
        if (!uid) { rosterOnly++; unmatchedRows.push({ tab: 'Roster', name: name, roll: roll }); return; }
        var patch = { status: st, sortOrder: num(col(r, ['Sort Order'])) || 0 };
        if (roll && !C.rollKey(users[uid].rollNumber)) patch.rollNumber = roll;
        var inactiveSince = ymd(col(r, ['Inactive Since'])); if (inactiveSince) patch.inactiveSince = inactiveSince;
        seq = seq.then(function() { return PortalOps.saveUser(uid, patch, me); }).then(function(u) { users[uid] = u; n++; });
      });
      return seq.then(function() { counts.Roster = n; say('Roster: ' + n + ' accounts updated, ' + rosterOnly + ' kept as roster-only.'); indexUsers(); });
    });

    // Config → settings only when empty.
    if (opts.Config) chain = chain.then(function() {
      return db.ref('settings/policy').once('value').then(function(s) {
        if (s.exists()) { say('Config: settings already exist, left untouched.'); return; }
        var et = C.withDefaults({}).eventTypes, pol = C.withDefaults({}).policy;
        rows('Config').forEach(function(r) {
          var type = col(r, ['Event Type']);
          if (type) {
            var k = eventTypeKey(type);
            if (et[k]) { et[k].unexcused = num(col(r, ['Unexcused Demerits'])); et[k].excused = num(col(r, ['Excused Demerits'])); et[k].freePerTerm = num(col(r, ['Free Absences Per Semester'])); if (col(r, ['Source'])) et[k].source = String(col(r, ['Source'])); }
          }
          var setting = String(col(r, ['Setting']) || '').toLowerCase(), v = num(col(r, ['Value']));
          if (!setting) return;
          if (setting === 'warning threshold') pol.warningThreshold = v;
          if (setting === 'bad standing threshold') pol.badStandingThreshold = v;
          if (setting === 'service events required') pol.service.eventsRequired = v;
          if (setting === 'demerits per hour short') pol.service.perHourShort = v;
          if (setting === 'demerits per event short') pol.service.perEventShort = v;
          if (setting === 'buy-out base amount') pol.buyout.base = v;
          if (setting === 'buy-out base demerits') pol.buyout.baseDemerits = v;
          if (setting === 'buy-out step amount') pol.buyout.step = v;
          if (setting === 'buy-out step demerits') pol.buyout.stepDemerits = v;
          if (setting === 'buy-out cap') pol.buyout.cap = v;
          // "Service Hours Required" is deliberately NOT taken: the owner set 12 (sheet says 8).
        });
        updates['settings/eventTypes'] = et; updates['settings/policy'] = pol; updates['settings/currentTerm'] = T;
        say('Config: seeded event types and policy (service hours kept at ' + pol.service.hoursRequired + ').');
        counts.Config = 1;
      });
    });

    // Event_Info → events
    var eventInfo = {};
    if (opts.Event_Info) chain = chain.then(function() {
      var n = 0;
      rows('Event_Info').forEach(function(r) {
        var title = col(r, ['Event Title']); if (!title) return;
        var k = eventKey(title);
        var ev = { title: String(title), date: ymd(col(r, ['Event Date'])) || null, type: eventTypeKey(col(r, ['Event Type'])), recorded: bool(col(r, ['Attendance Recorded'])), notes: String(col(r, ['Notes']) || ''), createdBy: me.uid, createdByName: me.name || '', createdAt: now, imported: true };
        eventInfo[k] = ev; updates['events/' + T + '/' + k] = ev; n++;
      });
      counts.Event_Info = n; say('Event_Info: ' + n + ' events.');
    });

    // Attendance → attendance + myAttendance (recorded events only)
    if (opts.Attendance) chain = chain.then(function() {
      var marks = 0, skipped = 0;
      var headers = (data.tabs.Attendance.headers || []).filter(function(h) { return h && !/^brother name$/i.test(h) && !/^roll/i.test(h); });
      rows('Attendance').forEach(function(r) {
        var name = col(r, ['Brother Name', 'Name']); if (!name) return;
        var uid = uidFor(name, col(r, ['Roll Number'])); if (!uid) { skipped++; unmatchedRows.push({ tab: 'Attendance', name: name }); return; }
        headers.forEach(function(h) {
          var v = r[h]; if (v === '' || v === undefined || v === null) return;
          var k = eventKey(h);
          if (eventInfo[k] && !eventInfo[k].recorded) return;
          var m = { present: bool(v), markedBy: me.uid, markedAt: now, imported: true };
          updates['attendance/' + T + '/' + k + '/' + uid] = m;
          updates['myAttendance/' + T + '/' + uid + '/' + k] = m;
          marks++;
        });
      });
      counts.Attendance = marks; say('Attendance: ' + marks + ' marks (' + skipped + ' rows without an account skipped).');
    });

    // Payments_Fines → ledger
    if (opts.Payments_Fines) chain = chain.then(function() {
      var n = 0, skipped = 0;
      rows('Payments_Fines').forEach(function(r, i) {
        var name = col(r, ['Brother Name', 'Name']); if (!name) return;
        var uid = uidFor(name, col(r, ['Roll Number'])); if (!uid) { skipped++; unmatchedRows.push({ tab: 'Payments_Fines', name: name }); return; }
        var item = String(col(r, ['Item', 'Item / Fine', 'Fine']) || 'Charge');
        var amount = num(col(r, ['Amount', 'Amount Owed']));
        var st = String(col(r, ['Payment Status', 'Status']) || 'Unpaid').toLowerCase();
        var due = ymd(col(r, ['Due Date'])) || null;
        var paidOn = ymd(col(r, ['Date Paid'])) || due || ymd(now);
        var base = 'ledger/' + T + '/' + uid + '/imp_' + C.nameKey(item) + '_' + i;
        updates[base] = Object.assign({ type: 'charge', item: item, amount: amount, dueDate: due, date: due, accruesLate: false, demeritsIfLate: num(col(r, ['Demerits If Unpaid/Late', 'Demerits If Unpaid', 'Demerits'])), note: String(col(r, ['Notes']) || '') }, audit);
        if (st === 'paid') updates[base + '_pay'] = Object.assign({ type: 'payment', chargeId: 'imp_' + C.nameKey(item) + '_' + i, amount: amount, date: paidOn, method: 'imported' }, audit);
        else if (st === 'waived') updates[base + '_waive'] = Object.assign({ type: 'waiver', chargeId: 'imp_' + C.nameKey(item) + '_' + i, amount: amount, date: paidOn }, audit);
        else if (/plan/.test(st)) updates[base + '_plan'] = Object.assign({ type: 'plan', chargeId: 'imp_' + C.nameKey(item) + '_' + i, date: ymd(now), planDueDate: null, note: 'Payment plan (from sheet)' }, audit);
        n++;
      });
      counts.Payments_Fines = n; say('Payments_Fines: ' + n + ' charges (' + skipped + ' without an account skipped).');
    });

    // Standards_Adjustments → adjustments
    if (opts.Standards_Adjustments) chain = chain.then(function() {
      var n = 0, skipped = 0;
      rows('Standards_Adjustments').forEach(function(r, i) {
        var name = col(r, ['Brother Name', 'Name']); if (!name) return;
        var uid = uidFor(name, col(r, ['Roll Number'])); if (!uid) { skipped++; unmatchedRows.push({ tab: 'Standards_Adjustments', name: name }); return; }
        updates['adjustments/' + T + '/' + uid + '/imp_' + i] = Object.assign({ points: num(col(r, ['Demerit Change', 'Change'])), reason: String(col(r, ['Reason']) || ''), enteredBy: String(col(r, ['Entered By']) || ''), date: ymd(col(r, ['Date'])) || null, note: String(col(r, ['Notes']) || '') }, audit);
        n++;
      });
      counts.Standards_Adjustments = n; say('Standards_Adjustments: ' + n + ' entries (' + skipped + ' skipped).');
    });

    // Rollover → rollover
    if (opts.Rollover) chain = chain.then(function() {
      var n = 0, skipped = 0;
      rows('Rollover').forEach(function(r) {
        var name = col(r, ['Name', 'Brother Name']); if (!name) return;
        var uid = uidFor(name, col(r, ['Roll Number'])); if (!uid) { skipped++; unmatchedRows.push({ tab: 'Rollover', name: name }); return; }
        updates['rollover/' + T + '/' + uid] = Object.assign({ points: num(col(r, ['Demerits'])), from: P || (data.tabs.Rollover.tab || ''), note: 'Imported from ' + (data.tabs.Rollover.tab || 'sheet') }, audit);
        n++;
      });
      counts.Rollover = n; say('Rollover: ' + n + ' carry-ins (' + skipped + ' skipped).');
    });

    // Service_Log → service
    if (opts.Service_Log) chain = chain.then(function() {
      var n = 0;
      rows('Service_Log').forEach(function(r, i) {
        var name = col(r, ['Brother Name', 'Name']); if (!name) return;
        var uid = uidFor(name, col(r, ['Roll Number'])); if (!uid) { unmatchedRows.push({ tab: 'Service_Log', name: name }); return; }
        var ev = String(col(r, ['Event', 'Event Title']) || '');
        updates['service/' + T + '/' + uid + '/imp_' + i] = { hours: num(col(r, ['Hours', 'Service Hours'])), eventName: ev, eventId: C.nameKey(ev), date: ymd(col(r, ['Date'])) || null, status: bool(col(r, ['Confirmed', 'Status'])) ? 'approved' : 'pending', submittedAt: now, imported: true, reviewedBy: bool(col(r, ['Confirmed', 'Status'])) ? me.uid : null };
        n++;
      });
      counts.Service_Log = n; say('Service_Log: ' + n + ' entries.');
    });

    // Excuses → excuses
    if (opts.Excuses) chain = chain.then(function() {
      var n = 0;
      rows('Excuses').forEach(function(r, i) {
        var name = col(r, ['Brother Name', 'Name']); if (!name) return;
        var uid = uidFor(name, col(r, ['Roll Number'])); if (!uid) { unmatchedRows.push({ tab: 'Excuses', name: name }); return; }
        var st = String(col(r, ['Excuse Status', 'Status']) || 'pending').toLowerCase();
        updates['excuses/' + T + '/' + uid + '/imp_' + i] = { eventId: eventKey(col(r, ['Event Title', 'Event'])), reason: String(col(r, ['Reason / Notes', 'Reason']) || ''), status: st === 'approved' ? 'approved' : (st === 'denied' ? 'denied' : 'pending'), reviewedBy: String(col(r, ['Approved By']) || ''), submittedAt: now, imported: true };
        n++;
      });
      counts.Excuses = n; say('Excuses: ' + n + ' entries.');
    });

    chain.then(function() {
      return db.ref('terms/' + T).once('value').then(function(s) {
        if (!s.exists()) updates['terms/' + T] = { label: T, status: 'active', createdBy: me.uid, createdAt: now };
        updates['settings/currentTerm'] = T;
      });
    }).then(function() {
      say('Writing ' + Object.keys(updates).length + ' records…');
      return chunkedUpdate(updates);
    }).then(function(n) {
      var id = db.ref('imports').push().key;
      var rec = { at: now, by: me.uid, byName: me.name || '', term: T, counts: counts, unmatched: unmatchedRows.slice(0, 200), records: n };
      return db.ref('imports/' + id).set(rec).then(function() { return PortalOps.logChange(T, 'import', 'sheet', 'Imported ' + n + ' records from the Tracker sheet', me); });
    }).then(function() {
      status('apply-status', 'Done. Check My Tracker for two brothers against the sheet\'s Dashboard.', 'success');
      say('Done.');
    }).catch(function(err) {
      status('apply-status', 'Failed: ' + (err.message || err), 'error'); say('ERROR ' + (err.message || err));
    }).finally(function() { $('btn-apply').disabled = false; });
  }

  function init() {
    PortalAuth.requireAdmin().then(function(profile) {
      if (!profile) return;
      me = profile; PortalAuth.initNav(profile);
      return Promise.all([PortalOps.loadSettings(), PortalOps.loadUsers()]);
    }).then(function(r) {
      if (!r) return;
      settings = r[0]; users = r[1];
      $('imp-term').value = PortalOps.currentTerm();
      $('btn-fetch').addEventListener('click', fetchSheet);
      $('btn-apply').addEventListener('click', apply);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(typeof window !== 'undefined' ? window : this);
