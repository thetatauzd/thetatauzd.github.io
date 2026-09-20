/**
 * Standards Board — the live Demerit Dashboard (the sheet's Dashboard tab,
 * computed), the excuse queue, adjustments, standing overrides and roll-over.
 */
(function (global) {
  'use strict';

  var C = global.OpsCore;
  var esc = C.esc, money = C.money;
  var me = null, S = null, term = null, all = null, rowsCache = [];

  function $(id) { return document.getElementById(id); }
  function setStatus(id, msg, kind) { var el = $(id); el.textContent = msg || ''; el.className = 'status-line' + (kind ? ' ' + kind : ''); }
  function name(uid) { var d = all.directory[uid]; return d ? d.name : uid; }
  function pill(t, cls) { return '<span class="count-pill ' + (cls || '') + '">' + esc(t) + '</span>'; }
  function standingCls(s) { return s === 'bad' ? 'bad' : (s === 'warning' ? 'warn' : 'good'); }
  function standingLabel(s) { return s === 'bad' ? 'Bad' : (s === 'warning' ? 'Warning' : 'Good'); }

  function reload() {
    return PortalOps.loadTermFacts(term).then(function (f) { all = f; S = f.settings; renderAll(); });
  }

  function computeRows(includeInactive) {
    return Object.keys(all.directory).filter(function (uid) {
      var d = all.directory[uid];
      return includeInactive ? d.status !== 'pnm' : C.isActiveStatus(d.status, S);
    }).map(function (uid) {
      var r = C.computeDemerits(uid, PortalOps.factsFor(term, uid, all), S);
      r.name = name(uid); r.roll = C.rollKey(all.directory[uid].rollNumber); r.status = all.directory[uid].status;
      return r;
    });
  }

  function renderDashboard() {
    var f = $('db-filter').value, q = ($('db-search').value || '').trim().toLowerCase();
    var rows = computeRows(f === 'all');
    rowsCache = rows;
    var active = rows.filter(function (r) { return C.isActiveStatus(r.status, S); });
    $('db-term').textContent = term;
    $('db-active').textContent = active.length;
    $('db-warn').textContent = active.filter(function (r) { return r.standing === 'warning'; }).length;
    $('db-bad').textContent = active.filter(function (r) { return r.standing === 'bad'; }).length;
    $('db-high').textContent = active.length ? Math.max.apply(null, active.map(function (r) { return r.total; })) : '—';
    var shown = rows.filter(function (r) {
      if (f === 'bad' && r.standing !== 'bad') return false;
      if (f === 'warning' && r.standing !== 'warning') return false;
      if (q && (r.name + ' ' + r.roll).toLowerCase().indexOf(q) === -1) return false;
      return true;
    }).sort(function (a, b) { return b.total - a.total || a.name.localeCompare(b.name); });
    $('db-tbody').innerHTML = shown.length ? shown.map(function (r) {
      var ov = (all.standing || {})[r.uid];
      return '<tr' + (C.isActiveStatus(r.status, S) ? '' : ' class="row-muted"') + '><td><a href="member?uid=' + encodeURIComponent(r.uid) + '"><strong>' + esc(r.name) + '</strong></a>' + (C.isActiveStatus(r.status, S) ? '' : ' ' + pill(r.status)) + '</td><td>' + esc(r.roll) + '</td>' +
        '<td>' + r.rolloverPoints + '</td><td>' + r.chapterAbsences + '</td><td>' + r.chapterDemerits + '</td><td>' + r.otherEventDemerits + '</td><td>' + r.paymentDemerits + '</td><td>' + r.adjustmentsTotal + (r.serviceCredit ? ' <span style="color:#2e7d32;">' + r.serviceCredit + '</span>' : '') + '</td>' +
        '<td><strong>' + r.total + '</strong></td><td>' + pill(standingLabel(r.standing), standingCls(r.standing)) + (ov && ov.override ? ' <span title="' + esc(ov.reason || '') + '" style="font-size:0.75rem; color:#999;">override</span>' : '') + '</td>' +
        '<td>' + (r.buyout ? money(r.buyout) : '—') + '</td><td>' + r.service.approvedHours + 'h / ' + r.service.distinctEvents + 'ev</td><td>' + (r.serviceShortfallNext ? '+' + r.serviceShortfallNext : '0') + '</td>' +
        '<td><button type="button" class="btn-text ov-btn" data-uid="' + esc(r.uid) + '">standing…</button></td></tr>';
    }).join('') : '<tr><td colspan="14" class="section-empty">Nobody matches.</td></tr>';
    $('db-tbody').querySelectorAll('.ov-btn').forEach(function (b) { b.addEventListener('click', function () { overrideStanding(this.getAttribute('data-uid')); }); });
  }

  function overrideStanding(uid) {
    var cur = (all.standing || {})[uid] || {};
    var v = prompt('Standing override for ' + name(uid) + ' — type good, warning, bad, or leave blank to remove the override:', cur.override || '');
    if (v === null) return;
    v = v.trim().toLowerCase();
    if (v && ['good', 'warning', 'bad'].indexOf(v) === -1) return alert('Use good, warning or bad.');
    var reason = v ? (prompt('Reason (kept on record):', cur.reason || '') || '') : '';
    var rec = v ? { override: v, reason: reason, setBy: me.uid, setByName: me.name || '', setAt: new Date().toISOString() } : null;
    PortalOps.db.ref('standing/' + term + '/' + uid).set(rec).then(function () {
      PortalOps.logChange(term, 'standing', uid, (v ? 'Standing override ' + v + ' for ' : 'Removed standing override for ') + name(uid) + (reason ? ': ' + reason : ''), me);
      return reload();
    }).catch(function (err) { alert(err.message || 'Failed.'); });
  }

  // ── Excuses ──
  // The queue Standards works from: what is at stake, whether it came in on time,
  // what the brother's term looks like, the reason and any photos.

  var excTab = 'pending', excGroup = 'event', excSel = {}, demCache = {};
  var KIND = { absent: 'Missing it', late: 'Arriving late', leaveEarly: 'Leaving early' };

  function allExcuses() {
    var list = [];
    Object.keys(all.excuses || {}).forEach(function (uid) {
      Object.keys(all.excuses[uid]).forEach(function (id) { list.push(Object.assign({}, all.excuses[uid][id], { uid: uid, id: id })); });
    });
    return list;
  }
  function excEvent(x) { return x.eventId ? ((all.events || {})[x.eventId] || { title: x.eventId, missing: true }) : { title: x.eventText || 'Unlisted event', date: x.eventDate, unlisted: true }; }
  function demFor(uid) { return demCache[uid] || (demCache[uid] = C.computeDemerits(uid, PortalOps.factsFor(term, uid, all), S, { pnm: (all.directory[uid] || {}).status === 'pnm' })); }

  function excuseCard(x, counts) {
    var ev = excEvent(x), def = S.eventTypes[ev.type] || S.eventTypes.other;
    var dem = demFor(x.uid), free = C.freeAbsences(dem, S);
    var stakes = ev.unlisted ? 'event not linked yet' : 'unexcused ' + def.unexcused + ' · excused ' + def.excused;
    var ctx = [
      pill(KIND[x.kind || 'absent'] + (x.time ? ' ~' + x.time : ''), x.kind && x.kind !== 'absent' ? '' : ''),
      x.afterEvent ? pill('sent after the event', 'bad') : (x.lateSubmission ? pill('inside ' + S.policy.attendance.excuseHoursBefore + ' h', 'warn') : pill('on time', 'good')),
      x.category ? pill(x.category) : '',
      x.category === 'sick' ? pill((x.photoIds || []).length ? 'photo attached' : "no doctor's note", (x.photoIds || []).length ? 'good' : 'warn') : '',
      pill(dem.total + ' demerits', dem.standing === 'bad' ? 'bad' : (dem.standing === 'warning' ? 'warn' : '')),
      ev.type === 'chapter' ? pill(free.left + ' of ' + free.allowed + ' free absences left') : '',
      pill('request ' + counts.nth + ' of ' + counts.total + ' this term'),
      (all.directory[x.uid] || {}).status === 'pnm' ? pill('PNM') : ''
    ].filter(Boolean).join(' ');
    var statusPill = pill(x.status === 'pending' ? 'to decide' : x.status, x.status === 'approved' ? 'good' : (x.status === 'denied' ? 'bad' : 'warn'));
    var linkSel = ev.unlisted ? '<select class="field exc-link" data-k="' + esc(x.uid + '|' + x.id) + '" style="max-width:260px; margin:0;"><option value="">Link to an event…</option>' +
      C.values(all.events).sort(function (a, b) { return String(a.date || '').localeCompare(String(b.date || '')); }).map(function (e) { return '<option value="' + esc(e.key) + '">' + esc(e.title) + (e.date ? ' · ' + C.fmtDate(e.date) : '') + '</option>'; }).join('') + '</select>' : '';
    var decided = x.status !== 'pending';
    return '<div class="req-card" data-k="' + esc(x.uid + '|' + x.id) + '">' +
      '<div class="req-head">' + (decided ? '' : '<input type="checkbox" class="exc-cb" data-k="' + esc(x.uid + '|' + x.id) + '"' + (excSel[x.uid + '|' + x.id] ? ' checked' : '') + '>') +
      '<strong>' + esc(name(x.uid)) + '</strong><span>' + esc(ev.title) + '</span><span class="pick-sub">' + esc(ev.date ? C.fmtDate(ev.date) : '') + (ev.unlisted ? '' : ' · ' + esc(def.label)) + ' · ' + esc(stakes) + '</span>' + statusPill + '</div>' +
      '<div class="req-context">' + ctx + '</div>' +
      '<div class="req-body">' + esc(x.reason || '') + '</div>' +
      PortalPhotos.buttonsHtml('excuse', term, x.uid, x.photoIds) +
      (decided ? '<div class="pick-sub" style="margin-top:0.35rem;">' + esc(x.status) + (x.reviewedByName ? ' by ' + esc(x.reviewedByName) : '') + (x.reviewedAt ? ' · ' + esc(C.fmtDate(x.reviewedAt)) : '') + (x.reviewNote ? ' · “' + esc(x.reviewNote) + '”' : '') + '</div>' : '') +
      '<div class="req-actions">' + linkSel +
      '<input class="field exc-note" data-k="' + esc(x.uid + '|' + x.id) + '" placeholder="Note back to them (optional)" value="' + (decided ? esc(x.reviewNote || '') : '') + '">' +
      (x.status !== 'approved' ? '<button type="button" class="btn btn-primary btn-small exc-act" data-k="' + esc(x.uid + '|' + x.id) + '" data-v="approved">' + (decided ? 'Change to approved' : 'Approve') + '</button>' : '') +
      (x.status !== 'denied' ? '<button type="button" class="btn danger btn-small exc-act" data-k="' + esc(x.uid + '|' + x.id) + '" data-v="denied">' + (decided ? 'Change to denied' : 'Deny') + '</button>' : '') +
      '</div></div>';
  }

  function renderExcuses() {
    demCache = {};
    var list = allExcuses();
    var perBrother = {};
    list.slice().sort(function (a, b) { return (a.submittedAt || 0) - (b.submittedAt || 0); }).forEach(function (x) {
      var c = perBrother[x.uid] || (perBrother[x.uid] = { total: 0, nth: {} }); c.total++; c.nth[x.id] = c.total;
    });
    var pending = list.filter(function (x) { return x.status === 'pending'; });
    $('exc-count').textContent = pending.length ? pending.length + ' to decide' : 'all caught up';
    var q = ($('exc-search').value || '').trim().toLowerCase();
    var shown = list.filter(function (x) {
      if (excTab === 'pending' && x.status !== 'pending') return false;
      if (excTab === 'decided' && x.status === 'pending') return false;
      if (q && (name(x.uid) + ' ' + excEvent(x).title + ' ' + (x.reason || '')).toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
    var groups = {}, order = [];
    shown.forEach(function (x) {
      var ev = excEvent(x);
      var key = excGroup === 'event' ? (x.eventId || 'unlisted:' + ev.title) : x.uid;
      if (!groups[key]) { groups[key] = { label: excGroup === 'event' ? ev.title : name(x.uid), sub: excGroup === 'event' ? (ev.date ? C.fmtDate(ev.date) : '') : '', sort: excGroup === 'event' ? String(ev.date || '9999') : name(x.uid), items: [] }; order.push(key); }
      groups[key].items.push(x);
    });
    order.sort(function (a, b) { return groups[a].sort.localeCompare(groups[b].sort); });
    if (excTab !== 'pending' && excGroup === 'event') order.reverse();
    $('exc-list').innerHTML = order.length ? order.map(function (k) {
      var g = groups[k];
      g.items.sort(function (a, b) { return (a.submittedAt || 0) - (b.submittedAt || 0); });
      return '<div class="group-head"><span>' + esc(g.label) + '</span><span class="pick-sub">' + esc(g.sub) + '</span>' + pill(g.items.length + (g.items.length === 1 ? ' request' : ' requests')) + '</div>' +
        g.items.map(function (x) { return excuseCard(x, { nth: perBrother[x.uid].nth[x.id], total: perBrother[x.uid].total }); }).join('');
    }).join('') : '<p class="section-empty">' + (excTab === 'pending' ? 'Nothing waiting on you.' : 'No requests match.') + '</p>';

    var box = $('exc-list');
    PortalPhotos.wire(box);
    if (excTab === 'pending' && shown.length <= 12) PortalPhotos.loadAll(box);
    box.querySelectorAll('.exc-cb').forEach(function (cb) { cb.addEventListener('change', function () { excSel[this.getAttribute('data-k')] = this.checked; renderBulkBar(); }); });
    box.querySelectorAll('.exc-act').forEach(function (b) {
      b.addEventListener('click', function () { decide([this.getAttribute('data-k')], this.getAttribute('data-v')); });
    });
    renderBulkBar();
  }

  function renderBulkBar() {
    var n = Object.keys(excSel).filter(function (k) { return excSel[k]; }).length;
    $('exc-bulk').classList.toggle('hidden', n === 0);
    $('exc-sel-count').textContent = n + ' selected';
  }

  function decide(keys, decision) {
    var byKey = {};
    allExcuses().forEach(function (x) { byKey[x.uid + '|' + x.id] = x; });
    var jobs = keys.map(function (k) {
      var x = byKey[k]; if (!x) return null;
      var noteEl = document.querySelector('.exc-note[data-k="' + k + '"]'), linkEl = document.querySelector('.exc-link[data-k="' + k + '"]');
      var patch = linkEl && linkEl.value ? { eventId: linkEl.value } : null;
      if (!x.eventId && !patch && decision === 'approved' && (x.kind || 'absent') === 'absent') return { error: name(x.uid) + ': link this request to an event first so the approval can count.' };
      return { x: x, note: noteEl ? noteEl.value.trim() : '', patch: patch };
    }).filter(Boolean);
    var bad = jobs.filter(function (j) { return j.error; });
    if (bad.length) return alert(bad[0].error);
    Promise.all(jobs.map(function (j) { return PortalOps.decideExcuse(term, j.x, decision, j.note, me, j.patch); })).then(function () {
      jobs.forEach(function (j) { PortalOps.logChange(term, 'excuse', j.x.uid, decision + ' excuse for ' + name(j.x.uid) + ' (' + excEvent(Object.assign({}, j.x, j.patch || {})).title + ')' + (j.x.status !== 'pending' ? ', was ' + j.x.status : ''), me); });
      excSel = {};
      return reload();
    }).catch(function (err) { alert(err.message || 'Failed.'); });
  }

  // ── Adjustments ──

  function renderAdjustments() {
    var sel = $('adj-uid');
    var people = Object.keys(all.directory).filter(function (u) { return all.directory[u].status !== 'pending'; })
      .sort(function (a, b) { return name(a).localeCompare(name(b)); });
    if (!sel.options.length) sel.innerHTML = people.map(function (u) { return '<option value="' + esc(u) + '">' + esc(name(u)) + (C.isActiveStatus(all.directory[u].status, S) ? '' : ' (' + esc(all.directory[u].status) + ')') + '</option>'; }).join('');
    var list = [];
    Object.keys(all.adjustments || {}).forEach(function (uid) { Object.keys(all.adjustments[uid]).forEach(function (id) { list.push(Object.assign({ uid: uid }, all.adjustments[uid][id])); }); });
    list.sort(function (a, b) { return String(b.createdAt || b.date || '').localeCompare(String(a.createdAt || a.date || '')); });
    $('adj-tbody').innerHTML = list.slice(0, 60).map(function (a) {
      return '<tr><td>' + esc(C.fmtDate(a.date)) + '</td><td>' + esc(name(a.uid)) + '</td><td>' + esc((a.points > 0 ? '+' : '') + a.points) + '</td><td>' + esc(a.reason || '') + '</td><td>' + esc(a.enteredBy || a.createdByName || '') + '</td></tr>';
    }).join('') || '<tr><td colspan="5" class="section-empty">None yet.</td></tr>';
  }

  function addAdjustment() {
    var uid = $('adj-uid').value, points = parseInt($('adj-points').value, 10), reason = $('adj-reason').value.trim(), date = $('adj-date').value || C.ymd(new Date());
    if (!uid) return setStatus('adj-status', 'Pick a brother.', 'error');
    if (isNaN(points) || points === 0) return setStatus('adj-status', 'Enter a non-zero change (negative = credit).', 'error');
    if (!reason) return setStatus('adj-status', 'Give a reason.', 'error');
    var entry = Object.assign({ points: points, reason: reason, date: date, enteredBy: me.name || '' }, PortalOps.audit(me));
    PortalOps.db.ref('adjustments/' + term + '/' + uid).push(entry).then(function () {
      setStatus('adj-status', 'Added.', 'success'); $('adj-points').value = ''; $('adj-reason').value = '';
      PortalOps.logChange(term, 'adjustment', uid, (points > 0 ? '+' : '') + points + ' for ' + name(uid) + ': ' + reason, me);
      return reload();
    }).catch(function (err) { setStatus('adj-status', err.message || 'Failed.', 'error'); });
  }

  // ── Roll-over ──

  function renderRollover() {
    var ro = all.rollover || {};
    var uids = Object.keys(ro).sort(function (a, b) { return (ro[b].points || 0) - (ro[a].points || 0) || name(a).localeCompare(name(b)); });
    $('ro-tbody').innerHTML = uids.length ? uids.map(function (uid) {
      return '<tr><td>' + esc(name(uid)) + '</td><td><input type="number" class="field ro-input" data-uid="' + esc(uid) + '" value="' + esc(ro[uid].points || 0) + '" style="max-width:90px; padding:0.25rem 0.4rem;"></td><td>' + esc(ro[uid].from || '') + '</td></tr>';
    }).join('') : '<tr><td colspan="3" class="section-empty">Nothing carried in.</td></tr>';
    $('ro-tbody').querySelectorAll('.ro-input').forEach(function (inp) {
      var uid = inp.getAttribute('data-uid'), orig = inp.value;
      inp.addEventListener('change', function () {
        var v = parseInt(inp.value, 10); if (isNaN(v) || String(v) === orig) return;
        PortalOps.db.ref('rollover/' + term + '/' + uid).update({ points: v, updatedBy: me.uid, updatedAt: new Date().toISOString() }).then(function () {
          PortalOps.logChange(term, 'rollover', uid, 'Roll-over for ' + name(uid) + ' changed ' + orig + ' → ' + v, me); orig = String(v); return reload();
        }).catch(function (err) { alert(err.message || 'Failed.'); inp.value = orig; });
      });
    });
  }

  function exportJson() {
    PortalOps.exportTermJson(term).then(function (obj) {
      var blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
      var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'chapter-ops-' + term + '.json'; a.click();
    }).catch(function (err) { alert(err.message || 'Export failed.'); });
  }

  function renderAll() { renderDashboard(); renderExcuses(); renderAdjustments(); renderRollover(); }

  function init() {
    PortalAuth.requirePerm(['standards', 'settings']).then(function (profile) {
      if (!profile) return;
      me = profile; PortalAuth.initNav(profile);
      return PortalOps.loadSettings();
    }).then(function (s) {
      if (!s) return;
      term = PortalOps.currentTerm();
      $('adj-date').value = C.ymd(new Date());
      $('db-search').addEventListener('input', renderDashboard);
      $('db-filter').addEventListener('change', renderDashboard);
      $('btn-adj').addEventListener('click', addAdjustment);
      $('exc-search').addEventListener('input', renderExcuses);
      [['exc-tab', function (v) { excTab = v; }], ['exc-group', function (v) { excGroup = v; }]].forEach(function (pair) {
        $(pair[0]).querySelectorAll('button').forEach(function (b) {
          b.addEventListener('click', function () {
            pair[1](this.getAttribute('data-v'));
            $(pair[0]).querySelectorAll('button').forEach(function (o) { o.classList.toggle('selected', o === b); });
            renderExcuses();
          });
        });
      });
      function selectedKeys() { return Object.keys(excSel).filter(function (k) { return excSel[k]; }); }
      $('btn-exc-approve-sel').addEventListener('click', function () { if (confirm('Approve ' + selectedKeys().length + ' requests?')) decide(selectedKeys(), 'approved'); });
      $('btn-exc-deny-sel').addEventListener('click', function () { if (confirm('Deny ' + selectedKeys().length + ' requests?')) decide(selectedKeys(), 'denied'); });
      $('btn-exc-clear-sel').addEventListener('click', function () { excSel = {}; renderExcuses(); });
      $('btn-export-json').addEventListener('click', exportJson);
      return reload();
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(typeof window !== 'undefined' ? window : this);
