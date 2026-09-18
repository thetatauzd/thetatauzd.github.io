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
      return '<tr' + (C.isActiveStatus(r.status, S) ? '' : ' class="row-muted"') + '><td><strong>' + esc(r.name) + '</strong>' + (C.isActiveStatus(r.status, S) ? '' : ' ' + pill(r.status)) + '</td><td>' + esc(r.roll) + '</td>' +
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

  function renderExcuses() {
    var list = [];
    Object.keys(all.excuses || {}).forEach(function (uid) {
      Object.keys(all.excuses[uid]).forEach(function (id) { var x = all.excuses[uid][id]; list.push(Object.assign({ uid: uid, id: id }, x)); });
    });
    list.sort(function (a, b) { return (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) || (b.submittedAt || 0) - (a.submittedAt || 0); });
    var pending = list.filter(function (x) { return x.status === 'pending'; }).length;
    $('exc-count').textContent = pending ? pending + ' pending' : 'none pending';
    $('exc-list').innerHTML = list.length ? list.slice(0, 80).map(function (x) {
      var ev = (all.events || {})[x.eventId] || { title: x.eventId };
      var typeDef = S.eventTypes[ev.type] || S.eventTypes.other;
      var flags = (x.lateSubmission ? pill('inside ' + S.policy.attendance.excuseHoursBefore + 'h window', 'warn') + ' ' : '') + (x.hasDoctorNote ? pill("doctor's note", 'good') + ' ' : '') + (x.category ? pill(x.category) : '');
      var actions = x.status === 'pending'
        ? '<div class="add-row" style="margin-top:0.4rem; align-items:center;"><input class="field exc-note" data-id="' + esc(x.id) + '" placeholder="Note back to the brother (optional)" style="max-width:320px;">' +
          '<button type="button" class="btn btn-primary btn-small exc-act" data-uid="' + esc(x.uid) + '" data-id="' + esc(x.id) + '" data-v="approved" style="margin:0;">Approve</button>' +
          '<button type="button" class="btn danger btn-small exc-act" data-uid="' + esc(x.uid) + '" data-id="' + esc(x.id) + '" data-v="denied" style="margin:0;">Deny</button></div>'
        : '<div class="step-hint" style="margin:0.3rem 0 0;">' + esc(x.status) + (x.reviewedByName ? ' by ' + esc(x.reviewedByName) : '') + (x.reviewNote ? ' — ' + esc(x.reviewNote) : '') + '</div>';
      return '<div class="cand" style="padding:0.6rem 0.8rem;"><div style="display:flex; gap:0.75rem; align-items:baseline; flex-wrap:wrap;"><strong>' + esc(name(x.uid)) + '</strong> <span>' + esc(ev.title) + '</span> <span style="color:#999; font-size:0.85rem;">' + esc(typeDef.label) + (ev.date ? ' · ' + C.fmtDate(ev.date) : '') + '</span> ' + pill(x.status, x.status === 'approved' ? 'good' : (x.status === 'denied' ? 'bad' : 'warn')) + '</div>' +
        '<div style="margin:0.3rem 0;">' + flags + '</div><div style="font-size:0.92rem;">' + esc(x.reason || '') + '</div>' + actions + '</div>';
    }).join('') : '<p class="section-empty">No excuse requests this term.</p>';
    $('exc-list').querySelectorAll('.exc-act').forEach(function (b) {
      b.addEventListener('click', function () {
        var uid = this.getAttribute('data-uid'), id = this.getAttribute('data-id'), v = this.getAttribute('data-v');
        var noteEl = document.querySelector('.exc-note[data-id="' + id + '"]');
        var upd = { status: v, reviewedBy: me.uid, reviewedByName: me.name || '', reviewedAt: new Date().toISOString(), reviewNote: noteEl ? noteEl.value.trim() : '' };
        PortalOps.db.ref('excuses/' + term + '/' + uid + '/' + id).update(upd).then(function () {
          PortalOps.logChange(term, 'excuse', uid, v + ' excuse for ' + name(uid), me);
          return reload();
        }).catch(function (err) { alert(err.message || 'Failed.'); });
      });
    });
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
      $('btn-export-json').addEventListener('click', exportJson);
      return reload();
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(typeof window !== 'undefined' ? window : this);
