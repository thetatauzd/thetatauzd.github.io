/**
 * Chapter Settings — every number the site computes from, editable with
 * history: policy groups, event types, positions (and what they can do),
 * member statuses, and the term rollover wizard.
 */
(function (global) {
  'use strict';

  var C = global.OpsCore;
  var esc = C.esc;
  var me = null, S = null, term = null;

  function $(id) { return document.getElementById(id); }
  function setStatus(id, msg, kind) { var el = $(id); el.textContent = msg || ''; el.className = 'status-line' + (kind ? ' ' + kind : ''); }

  // ── Policy groups: a schema drives the form ──

  var GROUPS = [
    { key: 'standing', title: 'Standing', source: 'Standards Board procedures XV', fields: [
      ['warningThreshold', 'Warning at (demerits)', 'int'], ['badStandingThreshold', 'Bad standing at (demerits)', 'int']] },
    { key: 'service', title: 'Service', source: 'Standards Board procedures XI–XIII; hours set by the chapter', fields: [
      ['service.hoursRequired', 'Brother hours per term', 'num'], ['service.eventsRequired', 'Brother events per term', 'int'],
      ['service.pnmHours', 'PNM hours', 'num'], ['service.pnmEvents', 'PNM events', 'int'],
      ['service.perHourShort', 'Demerits per hour short (next term)', 'num'], ['service.perEventShort', 'Demerits per event short (next term)', 'num'],
      ['service.extraHourErases', 'Demerits erased per extra hour', 'num']] },
    { key: 'buyout', title: 'Buy-out fine', source: 'Standards Board procedures XV.ii', fields: [
      ['buyout.base', 'Base amount ($)', 'num'], ['buyout.baseDemerits', 'At demerits', 'int'], ['buyout.step', 'Step amount ($)', 'num'], ['buyout.stepDemerits', 'Per further demerits', 'int'], ['buyout.cap', 'Cap ($)', 'num']] },
    { key: 'dues', title: 'Dues and late fees', source: 'Bylaws Art. V Sec. 1', fields: [
      ['dues.amount', 'Brother dues ($)', 'num'], ['dues.pnmAmount', 'PNM dues ($)', 'num'], ['dues.earlyAlumAmount', 'Early alumnus dues ($)', 'num'],
      ['dues.graceDays', 'Days after due date before late', 'int'], ['dues.lateLadder', 'Late fee per week, first weeks ($, comma-separated)', 'list'], ['dues.lateAfterLadder', 'Late fee per week after that ($)', 'num'],
      ['dues.demeritsIfLate', 'Demerits for unpaid dues past due', 'int']] },
    { key: 'attendance', title: 'Attendance', source: 'Bylaws Art. II Sec. 11', fields: [
      ['attendance.excuseHoursBefore', 'Excuse must arrive (hours before)', 'int'], ['attendance.sicknessNeedsNote', "Sickness needs a doctor's note", 'bool']] },
    { key: 'quorum', title: 'Quorum', source: 'Bylaws Art. III Sec. 13', fields: [
      ['quorum.business', 'Business (fraction of active)', 'num'], ['quorum.membership', 'Membership / elections / bylaws (fraction)', 'num']] },
    { key: 'pledge', title: 'Pledging', source: 'Bylaws Art. II Sec. 5–8', fields: [
      ['pledge.minWeeks', 'Minimum weeks', 'int'], ['pledge.bidPct', 'Bid: % favorable', 'num'], ['pledge.initiationPct', 'Initiation: % favorable', 'num'], ['pledge.initiationMinActiveFraction', 'Initiation: fraction of active brothers voting', 'num'],
      ['pledge.depledgePct', 'De-pledge: % favorable', 'num'], ['pledge.flagStdDevs', 'Flag PNMs this many std. dev. below mean', 'num'],
      ['pledge.nationalExam', 'National exam required', 'bool'], ['pledge.chapterExam', 'Chapter exam required', 'bool'], ['pledge.pinningFee', 'Pinning fee ($)', 'num'], ['pledge.initiationFee', 'Initiation fee ($)', 'num']] },
    { key: 'gpa', title: 'GPA', source: 'Bylaws Art. II Sec. 2, Art. III Sec. 1', fields: [['gpa.member', 'Members', 'num'], ['gpa.officer', 'Officers', 'num']] }
  ];

  function get(obj, path) { return path.split('.').reduce(function (o, k) { return o == null ? undefined : o[k]; }, obj); }
  function set(obj, path, v) { var ks = path.split('.'); var o = obj; ks.slice(0, -1).forEach(function (k) { o = o[k] = o[k] || {}; }); o[ks[ks.length - 1]] = v; }

  function renderPolicy() {
    var p = S.policy;
    $('policy-groups').innerHTML = GROUPS.map(function (g) {
      var inputs = g.fields.map(function (f) {
        var v = get(p, f[0]); var id = 'pf-' + f[0].replace(/\./g, '-');
        var input = f[2] === 'bool' ? '<label style="display:flex; gap:0.4rem; align-items:center; margin-top:1.2rem;"><input type="checkbox" id="' + id + '"' + (v ? ' checked' : '') + '> yes</label>'
          : '<input id="' + id + '" class="field" ' + (f[2] === 'list' ? 'value="' + esc((v || []).join(', ')) + '"' : 'type="number" step="' + (f[2] === 'int' ? '1' : 'any') + '" value="' + esc(v) + '"') + '>';
        return '<div style="flex:1 1 200px;"><label class="field-label" for="' + id + '">' + esc(f[1]) + '</label>' + input + '</div>';
      }).join('');
      return '<section class="setup-step"><h3>' + esc(g.title) + ' <span class="step-hint" style="margin:0; font-weight:400;">' + esc(g.source) + '</span></h3><div class="add-row">' + inputs + '</div>' +
        '<div class="add-row" style="align-items:center; margin-top:0.5rem;"><button type="button" class="btn btn-primary btn-small pol-save" data-g="' + g.key + '" style="margin:0;">Save ' + esc(g.title.toLowerCase()) + '</button><span class="status-line" id="pol-status-' + g.key + '" style="margin:0;"></span></div></section>';
    }).join('');
    $('policy-groups').querySelectorAll('.pol-save').forEach(function (b) { b.addEventListener('click', function () { savePolicyGroup(this.getAttribute('data-g')); }); });
  }

  function savePolicyGroup(gkey) {
    var g = GROUPS.find(function (x) { return x.key === gkey; });
    var next = JSON.parse(JSON.stringify(S.policy));
    var changes = [];
    g.fields.forEach(function (f) {
      var el = $('pf-' + f[0].replace(/\./g, '-'));
      var v;
      if (f[2] === 'bool') v = el.checked;
      else if (f[2] === 'list') v = el.value.split(',').map(function (x) { return parseFloat(x); }).filter(function (x) { return !isNaN(x); });
      else { v = f[2] === 'int' ? parseInt(el.value, 10) : parseFloat(el.value); if (isNaN(v)) v = get(S.policy, f[0]); }
      if (JSON.stringify(v) !== JSON.stringify(get(S.policy, f[0]))) changes.push(f[1] + ': ' + JSON.stringify(get(S.policy, f[0])) + ' → ' + JSON.stringify(v));
      set(next, f[0], v);
    });
    if (!changes.length) return setStatus('pol-status-' + gkey, 'Nothing changed.');
    var note = prompt('Why is this changing? (kept in the history)\n\n' + changes.join('\n'), '');
    if (note === null) return;
    PortalOps.saveSettings('policy', next, me, note).then(function () { setStatus('pol-status-' + gkey, 'Saved.', 'success'); return reload(); })
      .catch(function (err) { setStatus('pol-status-' + gkey, err.message || 'Failed.', 'error'); });
  }

  // ── Event types ──

  function renderEventTypes() {
    var list = C.sortByOrder(C.values(S.eventTypes));
    $('et-tbody').innerHTML = list.map(function (t) {
      return '<tr data-key="' + esc(t.key) + '"><td><code>' + esc(t.key) + '</code></td><td><input class="field et-label" value="' + esc(t.label) + '" style="max-width:180px; padding:0.3rem 0.4rem;"></td>' +
        '<td><input class="field et-un" type="number" step="1" value="' + esc(t.unexcused) + '" style="max-width:70px; padding:0.3rem 0.4rem;"></td><td><input class="field et-ex" type="number" step="1" value="' + esc(t.excused) + '" style="max-width:70px; padding:0.3rem 0.4rem;"></td>' +
        '<td><input class="field et-free" type="number" step="1" value="' + esc(t.freePerTerm || 0) + '" style="max-width:70px; padding:0.3rem 0.4rem;"></td><td><input class="field et-src" value="' + esc(t.source || '') + '" style="max-width:320px; padding:0.3rem 0.4rem;"></td></tr>';
    }).join('');
  }
  function saveEventTypes() {
    var next = {};
    $('et-tbody').querySelectorAll('tr').forEach(function (tr, i) {
      var k = tr.getAttribute('data-key'); var cur = S.eventTypes[k] || {};
      next[k] = { label: tr.querySelector('.et-label').value.trim() || k, order: cur.order || (100 + i), unexcused: parseInt(tr.querySelector('.et-un').value, 10) || 0, excused: parseInt(tr.querySelector('.et-ex').value, 10) || 0, freePerTerm: parseInt(tr.querySelector('.et-free').value, 10) || 0, source: tr.querySelector('.et-src').value.trim() };
    });
    var note = prompt('Why are the event types changing? (kept in the history)', ''); if (note === null) return;
    PortalOps.saveSettings('eventTypes', next, me, note).then(function () { setStatus('et-status', 'Saved.', 'success'); return reload(); }).catch(function (err) { setStatus('et-status', err.message || 'Failed.', 'error'); });
  }
  function addEventType() {
    var label = $('et-new').value.trim(); if (!label) return;
    var key = C.nameKey(label); if (S.eventTypes[key]) return setStatus('et-status', 'That key already exists.', 'error');
    S.eventTypes[key] = { label: label, order: 50, unexcused: 0, excused: 0, freePerTerm: 0, source: '' };
    $('et-new').value = ''; renderEventTypes(); setStatus('et-status', 'Added — set its numbers and click Save event types.');
  }

  // ── Positions ──

  function renderPositions() {
    var list = C.sortByOrder(C.values(S.positions));
    var perms = C.PERMS.filter(function (p) { return p !== 'admin'; });
    $('pos-tbody').innerHTML = list.map(function (p) {
      return '<tr data-key="' + esc(p.key) + '"><td><code>' + esc(p.key) + '</code></td><td><input class="field pos-label" value="' + esc(p.label) + '" style="max-width:220px; padding:0.3rem 0.4rem;"></td>' +
        '<td><select class="field pos-group" style="max-width:120px; padding:0.3rem 0.4rem;">' + ['officer', 'board', 'chair'].map(function (g) { return '<option' + (p.group === g ? ' selected' : '') + '>' + g + '</option>'; }).join('') + '</select></td>' +
        '<td><input class="field pos-order" type="number" value="' + esc(p.order || 0) + '" style="max-width:70px; padding:0.3rem 0.4rem;"></td>' +
        '<td>' + perms.map(function (k) { return '<label style="display:inline-flex; gap:0.25rem; align-items:center; margin-right:0.6rem; font-size:0.85rem;"><input type="checkbox" class="pos-perm" data-p="' + k + '"' + ((p.perms || {})[k] ? ' checked' : '') + '> ' + k + '</label>'; }).join('') + '</td></tr>';
    }).join('');
  }
  function savePositions() {
    var next = {};
    $('pos-tbody').querySelectorAll('tr').forEach(function (tr) {
      var k = tr.getAttribute('data-key'); var perms = {};
      tr.querySelectorAll('.pos-perm').forEach(function (cb) { if (cb.checked) perms[cb.getAttribute('data-p')] = true; });
      next[k] = { label: tr.querySelector('.pos-label').value.trim() || k, group: tr.querySelector('.pos-group').value, order: parseInt(tr.querySelector('.pos-order').value, 10) || 0, perms: perms };
    });
    var note = prompt('Why are positions changing? (kept in the history)', ''); if (note === null) return;
    PortalOps.saveSettings('positions', next, me, note).then(function () {
      setStatus('pos-status', 'Saved. Re-save affected people on User Management to refresh their permissions.', 'success'); return reload();
    }).catch(function (err) { setStatus('pos-status', err.message || 'Failed.', 'error'); });
  }
  function addPosition() {
    var label = $('pos-new').value.trim(); if (!label) return;
    var key = C.nameKey(label); if (S.positions[key]) return setStatus('pos-status', 'That key already exists.', 'error');
    S.positions[key] = { label: label, group: 'chair', order: 60, perms: {} };
    $('pos-new').value = ''; renderPositions(); setStatus('pos-status', 'Added — tick what it can do and click Save positions.');
  }

  // ── Statuses ──

  function renderStatuses() {
    var list = C.sortByOrder(C.values(S.statuses));
    $('st-tbody').innerHTML = list.map(function (s) {
      var locked = s.key === 'pending' || s.key === 'active' || s.key === 'pnm';
      return '<tr data-key="' + esc(s.key) + '"><td><code>' + esc(s.key) + '</code></td><td><input class="field st-label" value="' + esc(s.label) + '" style="max-width:200px; padding:0.3rem 0.4rem;"></td>' +
        ['countsAsActive', 'chargedDues', 'votes'].map(function (f) { return '<td><input type="checkbox" class="st-' + f + '"' + (s[f] ? ' checked' : '') + (locked && f !== 'chargedDues' ? ' disabled' : '') + '></td>'; }).join('') + '</tr>';
    }).join('');
  }
  function saveStatuses() {
    var next = {};
    $('st-tbody').querySelectorAll('tr').forEach(function (tr) {
      var k = tr.getAttribute('data-key'); var cur = S.statuses[k] || {};
      next[k] = { label: tr.querySelector('.st-label').value.trim() || k, order: cur.order || 0, countsAsActive: tr.querySelector('.st-countsAsActive').checked, chargedDues: tr.querySelector('.st-chargedDues').checked, votes: tr.querySelector('.st-votes').checked };
    });
    var note = prompt('Why are statuses changing?', ''); if (note === null) return;
    PortalOps.saveSettings('statuses', next, me, note).then(function () { setStatus('st-status', 'Saved.', 'success'); return reload(); }).catch(function (err) { setStatus('st-status', err.message || 'Failed.', 'error'); });
  }

  // ── History ──

  function renderHistory() {
    PortalOps.db.ref('settings/history').limitToLast(40).once('value').then(function (s) {
      var list = C.values(s.val() || {}).sort(function (a, b) { return String(b.changedAt).localeCompare(String(a.changedAt)); });
      $('hist-list').innerHTML = list.length ? list.map(function (h) {
        return '<details class="cand"><summary><span class="cand-name">' + esc(C.fmtDate(h.changedAt)) + ' · ' + esc(h.group) + ' · ' + esc(h.changedByName || '') + (h.note ? ' — ' + esc(h.note) : '') + '</span></summary><div class="rd"><pre style="white-space:pre-wrap; font-size:0.78rem; margin:0;">' + esc(JSON.stringify(h.after, null, 1)) + '</pre></div></details>';
      }).join('') : '<p class="section-empty">No changes recorded yet.</p>';
    }).catch(function () { $('hist-list').innerHTML = '<p class="section-empty">History not readable.</p>'; });
  }

  // ── Term rollover ──

  var preview = null;
  function previewTerm() {
    var id = ($('nt-id').value || '').trim().toUpperCase();
    if (!/^[FS]\d{2}$/.test(id)) return setStatus('nt-status', 'Term code like F26 or S27.', 'error');
    if (id === term) return setStatus('nt-status', 'That is the current term.', 'error');
    setStatus('nt-status', 'Computing…');
    PortalOps.loadTermFacts(term).then(function (all) {
      var carry = [];
      Object.keys(all.directory).forEach(function (uid) {
        var d = all.directory[uid]; if (!C.isActiveStatus(d.status, S)) return;
        var r = C.computeDemerits(uid, PortalOps.factsFor(term, uid, all), S);
        if (r.serviceShortfallNext > 0) carry.push({ uid: uid, name: d.name, points: r.serviceShortfallNext, hours: r.service.approvedHours, events: r.service.distinctEvents });
      });
      var active = Object.keys(all.directory).filter(function (u) { return C.isChargedStatus(all.directory[u].status, S); }).length;
      preview = { id: id, carry: carry, active: active };
      $('nt-preview').innerHTML = '<strong>' + carry.length + '</strong> brothers would carry service shortfall demerits into ' + esc(id) + ' (' + carry.reduce(function (t, c) { return t + c.points; }, 0) + ' points total). ' +
        '<strong>' + active + '</strong> would be charged dues of ' + C.money(S.policy.dues.amount) + '.' + (carry.length ? '<div class="vgroups" style="margin-top:0.4rem;">' + carry.sort(function (a, b) { return b.points - a.points; }).slice(0, 80).map(function (c) { return '<div class="vgroup"><span class="vg-label">+' + c.points + '</span><span class="vg-names">' + esc(c.name) + ' (' + c.hours + 'h, ' + c.events + ' ev)</span></div>'; }).join('') + '</div>' : '');
      $('btn-start-term').classList.remove('hidden'); setStatus('nt-status', '');
    }).catch(function (err) { setStatus('nt-status', err.message || 'Failed.', 'error'); });
  }
  function startTerm() {
    if (!preview) return;
    var id = preview.id;
    if (!confirm('Close ' + term + ' and start ' + id + '? This writes the roll-over and dues charges shown in the preview.')) return;
    var updates = {}, now = new Date().toISOString();
    updates['terms/' + term + '/status'] = 'closed'; updates['terms/' + term + '/closedAt'] = now;
    updates['terms/' + id] = { label: $('nt-label').value.trim() || id, startDate: $('nt-start').value || null, endDate: $('nt-end').value || null, duesDueDate: $('nt-due').value || null, status: 'active', createdBy: me.uid, createdAt: now };
    updates['settings/currentTerm'] = id;
    if ($('nt-rollover').checked) preview.carry.forEach(function (c) { updates['rollover/' + id + '/' + c.uid] = { points: c.points, from: term, note: 'Service shortfall: ' + c.hours + 'h / ' + c.events + ' events in ' + term, createdBy: me.uid, createdAt: now }; });
    var chargeDues = $('nt-dues').checked && $('nt-due').value;
    var done = Promise.resolve();
    if (chargeDues) done = PortalOps.loadDirectory().then(function (dir) {
      Object.keys(dir).forEach(function (uid) {
        if (!C.isChargedStatus(dir[uid].status, S)) return;
        updates['ledger/' + id + '/' + uid + '/dues_' + id] = { type: 'charge', item: 'Dues', amount: S.policy.dues.amount, dueDate: $('nt-due').value, date: C.ymd(new Date()), accruesLate: true, demeritsIfLate: S.policy.dues.demeritsIfLate || 0, createdBy: me.uid, createdByName: me.name || '', createdAt: now };
      });
      updates['terms/' + id + '/duesChargedAt'] = now;
    });
    done.then(function () { return PortalOps.db.ref().update(updates); }).then(function () {
      PortalOps.logChange(id, 'rollover', term, 'Started ' + id + ' from ' + term + ': ' + preview.carry.length + ' roll-overs' + (chargeDues ? ', dues charged' : ''), me);
      setStatus('nt-status', 'Started ' + id + '.', 'success'); return reload();
    }).catch(function (err) { setStatus('nt-status', err.message || 'Failed.', 'error'); });
  }

  function reload() {
    return PortalOps.loadSettings(true).then(function (s) { S = s; term = PortalOps.currentTerm(); renderAll(); });
  }
  function renderAll() {
    $('term-pill').textContent = term;
    renderPolicy(); renderEventTypes(); renderPositions(); renderStatuses(); renderHistory();
  }

  function init() {
    PortalAuth.requirePerm('settings').then(function (profile) {
      if (!profile) return;
      me = profile; PortalAuth.initNav(profile);
      $('btn-et-save').addEventListener('click', saveEventTypes); $('btn-et-add').addEventListener('click', addEventType);
      $('btn-pos-save').addEventListener('click', savePositions); $('btn-pos-add').addEventListener('click', addPosition);
      $('btn-st-save').addEventListener('click', saveStatuses);
      $('btn-preview-term').addEventListener('click', previewTerm); $('btn-start-term').addEventListener('click', startTerm);
      return reload();
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(typeof window !== 'undefined' ? window : this);
