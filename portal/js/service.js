/**
 * Service Hours — the Community Service Chair's page: review submissions,
 * track everyone's progress against the requirement, see each week's hours,
 * and credit hours in bulk for events the committee ran. Service events are
 * not kept on the site: a name is typed wherever one is needed.
 */
(function (global) {
  'use strict';

  var C = global.OpsCore;
  var esc = C.esc, fmtDate = C.fmtDate;
  var me = null, S = null, term = null, all = null;
  var bkSel = {}, weekStart = null;

  function $(id) { return document.getElementById(id); }
  function setStatus(id, msg, kind) { var el = $(id); el.textContent = msg || ''; el.className = 'status-line' + (kind ? ' ' + kind : ''); }
  function name(uid) { var d = all.directory[uid]; return d ? d.name : uid; }
  function pill(t, cls) { return '<span class="count-pill ' + (cls || '') + '">' + esc(t) + '</span>'; }
  function isPnm(uid) { return (all.directory[uid] || {}).status === 'pnm'; }

  function reload() {
    return PortalOps.loadTermFacts(term, ['service']).then(function (f) { all = f; S = f.settings; renderAll(); });
  }
  function people(filterFn) {
    return Object.keys(all.directory).filter(function (uid) { var d = all.directory[uid]; return d.status !== 'pending' && (!filterFn || filterFn(d)); })
      .sort(function (a, b) { return name(a).localeCompare(name(b)); });
  }

  // ── Review queue ──

  function renderReview() {
    var list = [];
    Object.keys(all.service || {}).forEach(function (uid) { Object.keys(all.service[uid]).forEach(function (id) { list.push(Object.assign({ uid: uid, id: id }, all.service[uid][id])); }); });
    var pending = list.filter(function (e) { return e.status === 'pending'; }).sort(function (a, b) { return (a.submittedAt || 0) - (b.submittedAt || 0); });
    $('rv-count').textContent = pending.length ? pending.length + ' pending' : 'nothing pending';
    $('rv-list').innerHTML = pending.length ? pending.map(function (e) {
      return '<div class="cand" style="padding:0.6rem 0.8rem;"><div style="display:flex; gap:0.75rem; align-items:baseline; flex-wrap:wrap;"><strong>' + esc(name(e.uid)) + '</strong>' + (isPnm(e.uid) ? ' ' + pill('PNM') : '') + ' <span>' + esc(e.eventName || '') + '</span> <span style="color:#999; font-size:0.85rem;">' + esc(fmtDate(e.date)) + '</span> ' + pill(e.hours + ' h', 'warn') + '</div>' +
        '<div class="step-hint" style="margin:0.25rem 0;">' + (e.photoUrl ? '<a href="' + esc(e.photoUrl) + '" target="_blank" rel="noopener">Photo link</a> · ' : '') + (e.vouchedBy ? 'Vouched by ' + esc(e.vouchedBy) : ((e.photoIds || []).length || e.photoUrl ? '' : 'No photo or voucher')) + (e.description ? ' · ' + esc(e.description) : '') + '</div>' +
        PortalPhotos.buttonsHtml('service', term, e.uid, e.photoIds) +
        '<div class="add-row" style="align-items:center;"><input class="field rv-hours" data-id="' + esc(e.id) + '" type="number" step="0.25" value="' + esc(e.hours) + '" style="max-width:90px;" title="Adjust hours before approving">' +
        '<label class="check-line" style="margin:0;"><input type="checkbox" class="rv-counts" data-id="' + esc(e.id) + '"> service event</label>' +
        '<input class="field rv-note" data-id="' + esc(e.id) + '" placeholder="Note (optional)" style="max-width:280px;">' +
        '<button type="button" class="btn btn-primary btn-small rv-act" data-uid="' + esc(e.uid) + '" data-id="' + esc(e.id) + '" data-v="approved" style="margin:0;">Approve</button>' +
        '<button type="button" class="btn danger btn-small rv-act" data-uid="' + esc(e.uid) + '" data-id="' + esc(e.id) + '" data-v="denied" style="margin:0;">Deny</button></div></div>';
    }).join('') : '<p class="section-empty">All caught up.</p>';
    PortalPhotos.wire($('rv-list'));
    if (pending.length <= 12) PortalPhotos.loadAll($('rv-list'));
    $('rv-list').querySelectorAll('.rv-act').forEach(function (b) {
      b.addEventListener('click', function () {
        var uid = this.getAttribute('data-uid'), id = this.getAttribute('data-id'), v = this.getAttribute('data-v');
        var hours = parseFloat(document.querySelector('.rv-hours[data-id="' + id + '"]').value);
        var note = document.querySelector('.rv-note[data-id="' + id + '"]').value.trim();
        var upd = { status: v, reviewedBy: me.uid, reviewedByName: me.name || '', reviewedAt: new Date().toISOString(), reviewNote: note };
        if (v === 'approved' && hours > 0) upd.hours = hours;
        if (v === 'approved') upd.countsAsEvent = document.querySelector('.rv-counts[data-id="' + id + '"]').checked;
        PortalOps.db.ref('service/' + term + '/' + uid + '/' + id).update(upd).then(function () {
          PortalOps.logChange(term, 'service', uid, v + ' ' + (upd.hours || '') + 'h for ' + name(uid), me); return reload();
        }).catch(function (err) { alert(err.message || 'Failed.'); });
      });
    });
  }

  // ── Progress ──

  function renderProgress() {
    var q = ($('pg-search').value || '').trim().toLowerCase(), f = $('pg-filter').value;
    $('pg-term').textContent = term;
    var uids = people(function (d) { return f === 'pnm' ? d.status === 'pnm' : C.isActiveStatus(d.status, S); });
    var rows = uids.map(function (uid) { var s = C.serviceSummary((all.service || {})[uid], S, { pnm: isPnm(uid) }); return { uid: uid, name: name(uid), s: s }; });
    var met = rows.filter(function (r) { return r.s.met; }).length;
    $('pg-req').textContent = (f === 'pnm' ? S.policy.service.pnmHours + ' h / ' + S.policy.service.pnmEvents : S.policy.service.hoursRequired + ' h / ' + S.policy.service.eventsRequired) + ' events';
    $('pg-met').textContent = met; $('pg-short').textContent = rows.length - met;
    $('pg-total').textContent = rows.reduce(function (t, r) { return t + r.s.approvedHours; }, 0);
    var shown = rows.filter(function (r) {
      if (q && r.name.toLowerCase().indexOf(q) === -1) return false;
      if (f === 'short') return !r.s.met;
      if (f === 'met') return r.s.met;
      return true;
    }).sort(function (a, b) { return (a.s.approvedHours - b.s.approvedHours) || a.name.localeCompare(b.name); });
    $('pg-tbody').innerHTML = shown.length ? shown.map(function (r) {
      return '<tr><td><a href="member?uid=' + encodeURIComponent(r.uid) + '">' + esc(r.name) + '</a></td><td>' + r.s.approvedHours + '</td><td>' + (r.s.pendingHours || '—') + '</td><td>' + r.s.distinctEvents + ' / ' + r.s.eventsRequired + '</td><td>' + (r.s.met ? pill('met', 'good') : pill(r.s.hoursShort + ' h' + (r.s.eventsShort ? ' · ' + r.s.eventsShort + ' ev' : ''), 'warn')) + '</td><td>' + (r.s.shortfallDemerits ? '+' + r.s.shortfallDemerits : '0') + '</td></tr>';
    }).join('') : '<tr><td colspan="6" class="section-empty">Nobody matches.</td></tr>';
  }

  // ── Week board ──

  function renderWeek() {
    if (!weekStart) weekStart = C.weekOf(new Date());
    var end = C.toDate(weekStart); end.setDate(end.getDate() + 6);
    $('wk-label').textContent = C.fmtDate(weekStart).replace(/, \d{4}$/, '') + ' – ' + C.fmtDate(end).replace(/, \d{4}$/, '');
    var rows = [];
    Object.keys(all.service || {}).forEach(function (uid) {
      var hours = 0, what = {};
      C.values(all.service[uid]).forEach(function (e) {
        if (e.status !== 'approved' || C.weekOf(e.date) !== weekStart) return;
        hours += Number(e.hours) || 0; what[e.eventName || ''] = true;
      });
      if (hours) rows.push({ name: name(uid), hours: hours, what: Object.keys(what).join(', ') });
    });
    rows.sort(function (a, b) { return b.hours - a.hours || a.name.localeCompare(b.name); });
    var rank = 0, last = null;
    $('wk-tbody').innerHTML = rows.length ? rows.map(function (r, i) {
      if (r.hours !== last) { rank = i + 1; last = r.hours; }
      return '<tr><td>' + rank + '</td><td>' + esc(r.name) + '</td><td>' + r.hours + '</td><td style="color:#666; font-size:0.85rem;">' + esc(r.what) + '</td></tr>';
    }).join('') : '<tr><td colspan="4" class="section-empty">No approved hours this week.</td></tr>';
  }
  function shiftWeek(days) { var d = C.toDate(weekStart); d.setDate(d.getDate() + days); weekStart = C.ymd(d); renderWeek(); }

  // ── Bulk credit ──

  function renderBulkList() {
    var q = ($('bk-search').value || '').trim().toLowerCase();
    $('bk-list').innerHTML = people(function (d) { return C.isActiveStatus(d.status, S) || d.status === 'pnm'; }).map(function (uid) {
      var hide = q && name(uid).toLowerCase().indexOf(q) === -1;
      return '<li' + (hide ? ' class="hidden"' : '') + '><label style="display:flex; gap:0.5rem; align-items:center; width:100%; cursor:pointer;"><input type="checkbox" class="bk-cb" data-uid="' + esc(uid) + '"' + (bkSel[uid] ? ' checked' : '') + '><span class="bro-name">' + esc(name(uid)) + '</span>' + (isPnm(uid) ? pill('PNM') : '') + '</label></li>';
    }).join('');
    $('bk-list').querySelectorAll('.bk-cb').forEach(function (cb) { cb.addEventListener('change', function () { bkSel[this.getAttribute('data-uid')] = this.checked; $('bk-count').textContent = Object.keys(bkSel).filter(function (u) { return bkSel[u]; }).length + ' selected'; }); });
    $('bk-count').textContent = Object.keys(bkSel).filter(function (u) { return bkSel[u]; }).length + ' selected';
  }
  function bulkCredit() {
    var evName = $('bk-event').value.trim();
    var hours = parseFloat($('bk-hours').value), date = $('bk-date').value || C.ymd(new Date());
    var key = 'bulk_' + C.nameKey(evName) + '_' + date.replace(/-/g, '');
    var uids = Object.keys(bkSel).filter(function (u) { return bkSel[u]; });
    if (!evName) return setStatus('bk-status', 'Name the event.', 'error');
    if (!(hours > 0)) return setStatus('bk-status', 'Enter the hours.', 'error');
    if (!uids.length) return setStatus('bk-status', 'Pick who attended.', 'error');
    var updates = {}, now = new Date().toISOString();
    uids.forEach(function (uid) {
      updates['service/' + term + '/' + uid + '/' + key] = { hours: hours, eventName: evName, date: date, week: C.weekOf(date), countsAsEvent: $('bk-counts').checked, name: name(uid), status: 'approved', submittedAt: firebase.database.ServerValue.TIMESTAMP, reviewedBy: me.uid, reviewedByName: me.name || '', reviewedAt: now, reviewNote: 'Credited by the Service Chair', description: '' };
    });
    if (!confirm('Credit ' + hours + ' h for "' + evName + '" to ' + uids.length + ' people?')) return;
    PortalOps.db.ref().update(updates).then(function () {
      setStatus('bk-status', 'Credited ' + uids.length + '.', 'success'); bkSel = {};
      PortalOps.logChange(term, 'service', key, 'Credited ' + hours + 'h for ' + evName + ' to ' + uids.length + ' people', me); return reload();
    }).catch(function (err) { setStatus('bk-status', err.message || 'Failed.', 'error'); });
  }

  function renderAll() { renderReview(); renderProgress(); renderWeek(); renderBulkList(); }

  function init() {
    PortalAuth.requirePerm(['service', 'standards']).then(function (profile) {
      if (!profile) return;
      me = profile; PortalAuth.initNav(profile);
      return PortalOps.loadSettings();
    }).then(function (s) {
      if (!s) return;
      term = PortalOps.currentTerm();
      $('bk-date').value = C.ymd(new Date());
      $('wk-prev').addEventListener('click', function () { shiftWeek(-7); });
      $('wk-next').addEventListener('click', function () { shiftWeek(7); });
      $('btn-bulk').addEventListener('click', bulkCredit);
      $('bk-search').addEventListener('input', renderBulkList);
      $('bk-none').addEventListener('click', function () { bkSel = {}; renderBulkList(); });
      $('pg-search').addEventListener('input', renderProgress);
      $('pg-filter').addEventListener('change', renderProgress);
      return reload();
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(typeof window !== 'undefined' ? window : this);
