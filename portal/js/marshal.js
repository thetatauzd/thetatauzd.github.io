/**
 * Marshal — pledge classes, PNM meeting attendance, exams and initiation
 * readiness against the bylaws (hours, events, weeks, exams).
 */
(function (global) {
  'use strict';

  var C = global.OpsCore;
  var esc = C.esc, fmtDate = C.fmtDate;
  var me = null, S = null, term = null;
  var classes = {}, pledges = {}, directory = {}, service = {}, pledgeAtt = {};
  var classId = null, meetingId = null, marks = {};

  function $(id) { return document.getElementById(id); }
  function setStatus(id, msg, kind) { var el = $(id); el.textContent = msg || ''; el.className = 'status-line' + (kind ? ' ' + kind : ''); }
  function name(uid) { var d = directory[uid]; return d ? d.name : uid; }
  function pill(t, cls) { return '<span class="count-pill ' + (cls || '') + '">' + esc(t) + '</span>'; }

  function reload() {
    return Promise.all([
      PortalOps.loadSettings(), PortalOps.loadDirectory(),
      PortalOps.db.ref('pledgeClasses').once('value'), PortalOps.db.ref('pledges').once('value'),
      PortalOps.db.ref('service/' + PortalOps.currentTerm()).once('value').then(function (s) { return s.val() || {}; }).catch(function () { return {}; })
    ]).then(function (r) {
      S = r[0]; directory = r[1]; classes = r[2].val() || {}; pledges = r[3].val() || {}; service = r[4]; term = PortalOps.currentTerm();
      if (!classId || !classes[classId]) { var ids = Object.keys(classes).sort(); classId = ids[ids.length - 1] || null; }
      return classId ? PortalOps.db.ref('pledgeAttendance/' + classId).once('value').then(function (s) { pledgeAtt = s.val() || {}; }) : null;
    }).then(renderAll);
  }

  function classMembers() { return Object.keys(pledges).filter(function (u) { return pledges[u].classId === classId && !pledges[u].depledgedAt; }); }
  function meetings() { var c = classes[classId] || {}; return C.sortByOrder(C.values(c.meetings || {}).map(function (m) { m.order = m.order || parseInt(String(m.key).replace(/\D/g, ''), 10) || 0; return m; })); }

  function renderClassSelect() {
    var ids = Object.keys(classes).sort();
    $('pc-select').innerHTML = ids.length ? ids.map(function (id) { return '<option value="' + esc(id) + '"' + (id === classId ? ' selected' : '') + '>' + esc(classes[id].label || id) + '</option>'; }).join('') : '<option value="">No pledge class yet</option>';
    var c = classes[classId];
    $('pc-info').innerHTML = c ? 'Started ' + esc(fmtDate(c.startDate)) + (c.targetInitiation ? ' · initiation ' + esc(fmtDate(c.targetInitiation)) : '') + ' · ' + meetings().length + ' meetings · ' + classMembers().length + ' PNMs' : '';
  }

  function renderPool() {
    var pool = Object.keys(directory).filter(function (u) { return directory[u].status === 'pnm'; }).sort(function (a, b) { return name(a).localeCompare(name(b)); });
    $('pnm-pool').innerHTML = pool.length ? pool.map(function (u) {
      var p = pledges[u]; var inClass = p && p.classId === classId && !p.depledgedAt;
      return '<li><span class="bro-name">' + esc(name(u)) + '</span>' + (inClass ? pill('in class', 'good') : (p && p.depledgedAt ? pill('de-pledged', 'bad') : '')) +
        (inClass ? '' : '<button type="button" class="btn ghost btn-small pool-add" data-uid="' + esc(u) + '" style="margin:0;"' + (classId ? '' : ' disabled') + '>Add</button>') + '</li>';
    }).join('') : '<li class="section-empty">No PNM accounts yet. Approve them as PNM on User Management.</li>';
    $('pnm-pool').querySelectorAll('.pool-add').forEach(function (b) {
      b.addEventListener('click', function () {
        var uid = this.getAttribute('data-uid'); var c = classes[classId];
        PortalOps.db.ref('pledges/' + uid).update({ classId: classId, startDate: c.startDate || C.ymd(new Date()), depledgedAt: null, updatedBy: me.uid, updatedAt: new Date().toISOString() }).then(reload).catch(function (err) { alert(err.message || 'Failed.'); });
      });
    });
  }

  function renderReadiness() {
    var members = classMembers().sort(function (a, b) { return name(a).localeCompare(name(b)); });
    var p = S.policy;
    $('rd-rules').textContent = 'Requirements: ' + p.service.pnmHours + ' service hours, ' + p.service.pnmEvents + ' events, ' + p.pledge.minWeeks + ' weeks' + (p.pledge.nationalExam ? ', national exam' : '') + (p.pledge.chapterExam ? ', chapter exam' : '') + '. Initiation needs ' + p.pledge.initiationPct + '% favorable with at least ' + Math.round(p.pledge.initiationMinActiveFraction * 100) + '% of active brothers voting.';
    var ready = 0;
    var mts = meetings();
    $('rd-tbody').innerHTML = members.length ? members.map(function (uid) {
      var pl = pledges[uid] || {};
      var r = C.pledgeReadiness(pl, service[uid], S);
      if (r.ready) ready++;
      var attended = mts.filter(function (m) { return pledgeAtt[m.key] && pledgeAtt[m.key][uid] && pledgeAtt[m.key][uid].present; }).length;
      var recorded = mts.filter(function (m) { return pledgeAtt[m.key]; }).length;
      function chk(key) { var c = r.checks.find(function (x) { return x.key === key; }); return c ? pill(c.value || (c.ok ? '✓' : '·'), c.ok ? 'good' : 'warn') : '—'; }
      return '<tr><td><strong>' + esc(name(uid)) + '</strong>' + (pl.initiatedAt ? ' ' + pill('initiated', 'good') : '') + '</td><td>' + chk('hours') + '</td><td>' + chk('events') + '</td><td>' + chk('weeks') + '</td>' +
        '<td><label><input type="checkbox" class="exam" data-uid="' + esc(uid) + '" data-e="nationalExam"' + (pl.nationalExam && pl.nationalExam.passed ? ' checked' : '') + '></label></td>' +
        '<td><label><input type="checkbox" class="exam" data-uid="' + esc(uid) + '" data-e="chapterExam"' + (pl.chapterExam && pl.chapterExam.passed ? ' checked' : '') + '></label></td>' +
        '<td>' + attended + ' / ' + recorded + '</td><td>' + (r.ready ? pill('Ready', 'good') : pill('Not yet', 'warn')) + '</td>' +
        '<td><button type="button" class="btn-text act" data-a="initiate" data-uid="' + esc(uid) + '">initiated</button> · <button type="button" class="btn-text act" data-a="depledge" data-uid="' + esc(uid) + '">de-pledge</button></td></tr>';
    }).join('') : '<tr><td colspan="9" class="section-empty">No PNMs in this class yet.</td></tr>';
    $('rd-count').textContent = members.length ? ready + ' of ' + members.length + ' ready' : '';
    $('rd-tbody').querySelectorAll('.exam').forEach(function (cb) {
      cb.addEventListener('change', function () {
        var uid = this.getAttribute('data-uid'), e = this.getAttribute('data-e');
        PortalOps.db.ref('pledges/' + uid + '/' + e).set(this.checked ? { passed: true, date: C.ymd(new Date()), enteredBy: me.uid } : null).then(reload).catch(function (err) { alert(err.message || 'Failed.'); });
      });
    });
    $('rd-tbody').querySelectorAll('.act').forEach(function (b) {
      b.addEventListener('click', function () {
        var uid = this.getAttribute('data-uid'), a = this.getAttribute('data-a');
        var field = a === 'initiate' ? 'initiatedAt' : 'depledgedAt';
        if (!confirm((a === 'initiate' ? 'Mark ' + name(uid) + ' as initiated? An admin then changes their status to active on User Management.' : 'Mark ' + name(uid) + ' as de-pledged?'))) return;
        var upd = {}; upd[field] = C.ymd(new Date()); upd.updatedBy = me.uid; upd.updatedAt = new Date().toISOString();
        PortalOps.db.ref('pledges/' + uid).update(upd).then(reload).catch(function (err) { alert(err.message || 'Failed.'); });
      });
    });
  }

  function renderMeetings() {
    var mts = meetings();
    $('ma-meeting').innerHTML = mts.length ? mts.map(function (m) { return '<option value="' + esc(m.key) + '"' + (m.key === meetingId ? ' selected' : '') + '>' + esc(m.title) + (m.date ? ' · ' + fmtDate(m.date) : '') + (pledgeAtt[m.key] ? ' ✓' : '') + '</option>'; }).join('') : '<option value="">No meetings defined</option>';
    if (!meetingId || !mts.some(function (m) { return m.key === meetingId; })) meetingId = mts.length ? mts[0].key : null;
    $('ma-meeting').value = meetingId || '';
    var existing = (pledgeAtt[meetingId] || {});
    marks = {}; classMembers().forEach(function (u) { marks[u] = existing[u] ? !!existing[u].present : false; });
    $('ma-list').innerHTML = Object.keys(marks).sort(function (a, b) { return name(a).localeCompare(name(b)); }).map(function (u) {
      return '<li><span class="bro-name">' + esc(name(u)) + '</span><span class="option-presets" style="margin:0; gap:0.3rem;">' +
        '<button type="button" class="option-preset-btn good mk' + (marks[u] ? ' selected' : '') + '" data-uid="' + esc(u) + '" data-v="1" style="padding:0.3rem 0.7rem;">Present</button>' +
        '<button type="button" class="option-preset-btn bad mk' + (!marks[u] ? ' selected' : '') + '" data-uid="' + esc(u) + '" data-v="0" style="padding:0.3rem 0.7rem;">Absent</button></span></li>';
    }).join('') || '<li class="section-empty">Add PNMs to the class first.</li>';
    $('ma-list').querySelectorAll('.mk').forEach(function (b) { b.addEventListener('click', function () { marks[this.getAttribute('data-uid')] = this.getAttribute('data-v') === '1'; renderMeetings(); }); });
  }
  function saveMeeting() {
    if (!meetingId) return;
    var updates = {}, now = new Date().toISOString();
    Object.keys(marks).forEach(function (u) { updates['pledgeAttendance/' + classId + '/' + meetingId + '/' + u] = { present: !!marks[u], markedBy: me.uid, markedAt: now }; });
    PortalOps.db.ref().update(updates).then(function () { setStatus('ma-status', 'Saved.', 'success'); return reload(); }).catch(function (err) { setStatus('ma-status', err.message || 'Failed.', 'error'); });
  }

  function createClass() {
    var label = $('pc-label').value.trim(), start = $('pc-start').value;
    if (!label || !start) return setStatus('pc-status', 'Label and start date are required.', 'error');
    var meetingsObj = {};
    $('pc-meetings').value.split('\n').map(function (l) { return l.trim(); }).filter(Boolean).forEach(function (line, i) {
      var parts = line.split(','); var title = parts[0].trim(); var date = (parts[1] || '').trim();
      meetingsObj['m' + i] = { title: title, date: C.ymd(date) || null, order: i };
    });
    var id = C.nameKey(label) || 'pc_' + Date.now();
    PortalOps.db.ref('pledgeClasses/' + id).set(Object.assign({ label: label, termId: term, startDate: start, targetInitiation: $('pc-init').value || null, meetings: meetingsObj }, PortalOps.audit(me)))
      .then(function () { classId = id; setStatus('pc-status', 'Created.', 'success'); return reload(); }).catch(function (err) { setStatus('pc-status', err.message || 'Failed.', 'error'); });
  }

  function renderAll() { renderClassSelect(); renderPool(); renderReadiness(); renderMeetings(); }

  function init() {
    PortalAuth.requirePerm(['pledges', 'standards']).then(function (profile) {
      if (!profile) return;
      me = profile; PortalAuth.initNav(profile);
      $('pc-start').value = C.ymd(new Date());
      $('pc-select').addEventListener('change', function () { classId = this.value || null; meetingId = null; reload(); });
      $('ma-meeting').addEventListener('change', function () { meetingId = this.value; renderMeetings(); });
      $('btn-pc-create').addEventListener('click', createClass);
      $('btn-ma-save').addEventListener('click', saveMeeting);
      return reload();
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(typeof window !== 'undefined' ? window : this);
