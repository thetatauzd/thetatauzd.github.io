/**
 * Attendance — the Scribe's page (also Standards). Create events for the term
 * and take attendance for one event at a time, mirroring the tracker sheet's
 * Take_Attendance tab. Marks are written by PortalOps.saveAttendance so both
 * the per-event and per-brother shapes stay in step.
 */
(function (global) {
  'use strict';

  var C = global.OpsCore;
  var esc = C.esc;
  var me = null, S = null, term = null;
  var events = {}, directory = {}, attendance = {}, flags = {};
  var selected = null;       // eventId
  var marks = {};            // uid -> bool for the selected event (unsaved)

  function $(id) { return document.getElementById(id); }
  function setStatus(id, msg, kind) { var el = $(id); el.textContent = msg || ''; el.className = 'status-line' + (kind ? ' ' + kind : ''); }

  function activeUids() {
    return Object.keys(directory).filter(function (uid) { return C.isActiveStatus(directory[uid].status, S); })
      .sort(function (a, b) {
        var da = directory[a], db_ = directory[b];
        var ra = parseInt(C.rollKey(da.rollNumber) || '99999', 10), rb = parseInt(C.rollKey(db_.rollNumber) || '99999', 10);
        return (ra - rb) || String(da.name).localeCompare(String(db_.name));
      });
  }

  // ── Events ──

  function renderEvents() {
    $('ev-term').textContent = term;
    var list = C.values(events).sort(function (a, b) { return String(b.date || '').localeCompare(String(a.date || '')) || String(a.title).localeCompare(String(b.title)); });
    $('ev-tbody').innerHTML = list.length ? list.map(function (ev) {
      var typeDef = S.eventTypes[ev.type] || S.eventTypes.other;
      var att = attendance[ev.key] || {};
      var present = Object.keys(att).filter(function (u) { return att[u].present; }).length;
      var cls = ev.key === selected ? ' style="background:#fffde7;"' : '';
      return '<tr class="ev-row" data-id="' + esc(ev.key) + '"' + cls + ' style="cursor:pointer;"><td><strong>' + esc(ev.title) + '</strong></td><td>' + esc(C.fmtDate(ev.date)) + '</td><td>' + esc(typeDef.label) + '</td><td>' +
        (ev.recorded ? present + ' / ' + Object.keys(att).length : '<span style="color:#999;">not taken</span>') + '</td></tr>';
    }).join('') : '<tr><td colspan="4" class="section-empty">No events yet. Add the first one below.</td></tr>';
    $('ev-tbody').querySelectorAll('.ev-row').forEach(function (tr) { tr.addEventListener('click', function () { select(this.getAttribute('data-id')); }); });
  }

  function renderTypeSelect() {
    var types = C.sortByOrder(C.values(S.eventTypes)).filter(function (t) { return t.key !== 'pledge'; });
    $('ed-type').innerHTML = types.map(function (t) { return '<option value="' + esc(t.key) + '">' + esc(t.label) + '</option>'; }).join('');
    $('ev-type').innerHTML = types.map(function (t) { return '<option value="' + esc(t.key) + '">' + esc(t.label) + '</option>'; }).join('');
    $('ev-type').addEventListener('change', typeHint); typeHint();
  }
  function typeHint() {
    var t = S.eventTypes[$('ev-type').value]; if (!t) return;
    $('ev-type-hint').textContent = 'Unexcused: ' + t.unexcused + ' demerit' + (t.unexcused === 1 ? '' : 's') + ' · Excused: ' + t.excused + (t.freePerTerm ? ' · First ' + t.freePerTerm + ' unexcused absences per term are free' : '') + (t.source ? ' · ' + t.source : '');
  }

  function addEvent() {
    var title = $('ev-title').value.trim(), date = $('ev-date').value, type = $('ev-type').value, time = $('ev-time').value;
    if (!title) return setStatus('ev-status', 'Give the event a title.', 'error');
    var key = C.nameKey(title) || 'event';
    var base = key, n = 2;
    while (events[key]) { key = base + '_' + (n++); }
    var ev = Object.assign({ title: title, date: date || null, time: time || null, type: type, recorded: false, notes: '' }, PortalOps.audit(me));
    PortalOps.db.ref('events/' + term + '/' + key).set(ev).then(function () {
      setStatus('ev-status', 'Added.', 'success'); $('ev-title').value = '';
      PortalOps.logChange(term, 'event', key, 'Added event "' + title + '" (' + type + ')', me);
    }).catch(function (err) { setStatus('ev-status', err.message || 'Failed.', 'error'); });
  }

  // ── Taking attendance ──

  function select(eventId) {
    selected = eventId; marks = {};
    var ev = events[eventId]; if (!ev) return;
    var existing = attendance[eventId] || {};
    activeUids().forEach(function (uid) { marks[uid] = existing[uid] ? !!existing[uid].present : (ev.recorded ? false : null); });
    Object.keys(existing).forEach(function (uid) { if (!(uid in marks)) marks[uid] = !!existing[uid].present; });   // people since gone inactive
    var typeDef = S.eventTypes[ev.type] || S.eventTypes.other;
    $('take-title').textContent = ev.title;
    $('take-sub').textContent = (ev.date ? C.fmtDate(ev.date) + ' · ' : '') + typeDef.label + (ev.recorded ? ' · recorded' : ' · not yet recorded');
    $('take-worth').textContent = 'Worth: ' + typeDef.unexcused + ' unexcused / ' + typeDef.excused + ' excused' + (typeDef.freePerTerm ? ' · first ' + typeDef.freePerTerm + ' unexcused chapter absences per term are free' : '') + '. Anyone not marked present counts as absent once you save.';
    $('take-tools').classList.remove('hidden');
    $('ed-title').value = ev.title || ''; $('ed-date').value = ev.date || ''; $('ed-time').value = ev.time || ''; $('ed-type').value = ev.type || 'other';
    renderList(); renderEvents();
  }

  function renderList() {
    var q = ($('take-search').value || '').trim().toLowerCase();
    var uids = Object.keys(marks).sort(function (a, b) {
      var da = directory[a] || {}, db_ = directory[b] || {};
      var ra = parseInt(C.rollKey(da.rollNumber) || '99999', 10), rb = parseInt(C.rollKey(db_.rollNumber) || '99999', 10);
      return (ra - rb) || String(da.name || '').localeCompare(String(db_.name || ''));
    });
    var present = 0;
    $('take-list').innerHTML = uids.map(function (uid) {
      var d = directory[uid] || { name: uid };
      var m = marks[uid];
      if (m === true) present++;
      var hide = q && String(d.name || '').toLowerCase().indexOf(q) === -1;
      var fl = (flags[selected] || {})[uid] || '';
      var badge = fl === 'approved' ? '<span class="att-badge e" title="Excuse approved by Standards">E</span>'
        : (fl === 'pending' ? '<span class="att-badge q" title="Excuse waiting on Standards">?</span>'
        : (/^(late|early)_approved$/.test(fl) ? '<span class="att-badge l" title="Approved to ' + (fl.indexOf('late') === 0 ? 'arrive late' : 'leave early') + '">L</span>'
        : (/^(late|early)_pending$/.test(fl) ? '<span class="att-badge q" title="Late / leaving early request waiting on Standards">?</span>' : '')));
      return '<li data-uid="' + esc(uid) + '"' + (hide ? ' class="hidden"' : '') + '>' +
        '<span class="bro-name">' + esc(d.name || uid) + (d.rollNumber ? ' <span style="color:#999; font-size:0.8rem;">#' + esc(C.rollKey(d.rollNumber)) + '</span>' : '') + badge + (C.isActiveStatus(d.status, S) ? '' : ' <span class="count-pill">' + esc(d.status) + '</span>') + '</span>' +
        '<span class="option-presets" style="margin:0; gap:0.3rem;">' +
        '<button type="button" class="option-preset-btn good mark-btn' + (m === true ? ' selected' : '') + '" data-uid="' + esc(uid) + '" data-v="1" style="padding:0.3rem 0.7rem;">Present</button>' +
        '<button type="button" class="option-preset-btn bad mark-btn' + (m === false ? ' selected' : '') + '" data-uid="' + esc(uid) + '" data-v="0" style="padding:0.3rem 0.7rem;">Absent</button></span></li>';
    }).join('');
    $('take-list').querySelectorAll('.mark-btn').forEach(function (b) {
      b.addEventListener('click', function () { marks[this.getAttribute('data-uid')] = this.getAttribute('data-v') === '1'; renderList(); });
    });
    var ev = events[selected] || {};
    var active = activeUids().length;
    var q1 = C.quorum(active, ev.type === 'voting' ? 'membership' : 'business', S);
    $('take-count').textContent = present + ' present of ' + uids.length;
    var qEl = $('take-quorum');
    qEl.textContent = 'Quorum ' + q1 + ' (' + (ev.type === 'voting' ? 'two-thirds' : 'half') + ' of ' + active + ' active)';
    qEl.className = 'count-pill ' + (present >= q1 ? 'good' : 'warn');
  }

  function saveAttendance() {
    if (!selected) return;
    var toSave = {};
    Object.keys(marks).forEach(function (uid) { toSave[uid] = marks[uid] === true; });
    var btn = $('btn-save-att'); btn.disabled = true; setStatus('take-status', 'Saving…');
    PortalOps.saveAttendance(term, selected, toSave, me).then(function () {
      setStatus('take-status', 'Saved.', 'success');
      var present = Object.keys(toSave).filter(function (u) { return toSave[u]; }).length;
      PortalOps.logChange(term, 'attendance', selected, 'Recorded ' + present + ' present / ' + (Object.keys(toSave).length - present) + ' absent for "' + (events[selected] || {}).title + '"', me);
    }).catch(function (err) { setStatus('take-status', err.message || 'Failed.', 'error'); }).finally(function () { btn.disabled = false; });
  }

  function saveEventEdit() {
    if (!selected) return;
    var title = $('ed-title').value.trim(); if (!title) return setStatus('ed-status', 'Give it a title.', 'error');
    var patch = { title: title, date: $('ed-date').value || null, time: $('ed-time').value || null, type: $('ed-type').value, updatedBy: me.uid, updatedAt: new Date().toISOString() };
    PortalOps.db.ref('events/' + term + '/' + selected).update(patch).then(function () {
      setStatus('ed-status', 'Saved.', 'success');
      PortalOps.logChange(term, 'event', selected, 'Edited event "' + title + '" (' + patch.type + ', ' + (patch.date || 'no date') + ')', me);
      select(selected);
    }).catch(function (err) { setStatus('ed-status', err.message || 'Failed.', 'error'); });
  }
  function deleteEvent() {
    if (!selected) return;
    var ev = events[selected] || {};
    var msg = ev.recorded ? 'Remove "' + ev.title + '" AND the attendance taken for it? Demerits from it disappear.' : 'Remove "' + ev.title + '"?';
    if (!confirm(msg)) return;
    var updates = {}, id = selected;
    updates['events/' + term + '/' + id] = null;
    updates['attendance/' + term + '/' + id] = null;
    Object.keys(attendance[id] || {}).forEach(function (uid) { updates['myAttendance/' + term + '/' + uid + '/' + id] = null; });
    PortalOps.db.ref().update(updates).then(function () {
      PortalOps.logChange(term, 'event', id, 'Removed event "' + ev.title + '"' + (ev.recorded ? ' and its attendance' : ''), me);
      selected = null; marks = {}; $('take-tools').classList.add('hidden'); $('take-title').textContent = 'Take attendance'; $('take-sub').textContent = 'Pick an event on the left.';
    }).catch(function (err) { setStatus('ed-status', err.message || 'Failed.', 'error'); });
  }

  // ── Init ──

  function init() {
    PortalAuth.requirePerm(['attendance', 'standards']).then(function (profile) {
      if (!profile) return;
      me = profile; PortalAuth.initNav(profile);
      return Promise.all([PortalOps.loadSettings(), PortalOps.loadDirectory()]);
    }).then(function (r) {
      if (!r) return;
      S = r[0]; directory = r[1]; term = PortalOps.currentTerm();
      renderTypeSelect();
      $('ev-date').value = C.ymd(new Date());
      $('btn-add-event').addEventListener('click', addEvent);
      $('btn-save-att').addEventListener('click', saveAttendance);
      $('btn-all-present').addEventListener('click', function () { Object.keys(marks).forEach(function (u) { marks[u] = true; }); renderList(); });
      $('btn-all-absent').addEventListener('click', function () { Object.keys(marks).forEach(function (u) { marks[u] = false; }); renderList(); });
      $('take-search').addEventListener('input', renderList);
      $('btn-ed-save').addEventListener('click', saveEventEdit);
      $('btn-ed-delete').addEventListener('click', deleteEvent);
      PortalOps.db.ref('excuseFlags/' + term).on('value', function (s) { flags = s.val() || {}; if (selected) renderList(); }, function () {});
      PortalOps.db.ref('events/' + term).on('value', function (s) { events = s.val() || {}; renderEvents(); });
      PortalOps.db.ref('attendance/' + term).on('value', function (s) { attendance = s.val() || {}; renderEvents(); });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(typeof window !== 'undefined' ? window : this);
