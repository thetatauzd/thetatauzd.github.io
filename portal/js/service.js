/**
 * Service Hours — the Community Service Chair's page: review submissions,
 * track everyone's progress against the requirement, keep the event list,
 * and credit hours in bulk for events the committee ran.
 */
(function (global) {
  'use strict';

  var C = global.OpsCore;
  var esc = C.esc, fmtDate = C.fmtDate;
  var me = null, S = null, term = null, all = null;
  var bkSel = {};

  function $(id) { return document.getElementById(id); }
  function setStatus(id, msg, kind) { var el = $(id); el.textContent = msg || ''; el.className = 'status-line' + (kind ? ' ' + kind : ''); }
  function name(uid) { var d = all.directory[uid]; return d ? d.name : uid; }
  function pill(t, cls) { return '<span class="count-pill ' + (cls || '') + '">' + esc(t) + '</span>'; }
  function isPnm(uid) { return (all.directory[uid] || {}).status === 'pnm'; }

  function reload() {
    return PortalOps.loadTermFacts(term, ['service', 'serviceEvents']).then(function (f) { all = f; S = f.settings; renderAll(); });
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
        '<div class="step-hint" style="margin:0.25rem 0;">' + (e.photoUrl ? '<a href="' + esc(e.photoUrl) + '" target="_blank" rel="noopener">Photo</a> · ' : '') + (e.vouchedBy ? 'Vouched by ' + esc(e.vouchedBy) : (e.photoUrl ? '' : 'No photo or voucher')) + (e.description ? ' · ' + esc(e.description) : '') + '</div>' +
        '<div class="add-row" style="align-items:center;"><input class="field rv-hours" data-id="' + esc(e.id) + '" type="number" step="0.25" value="' + esc(e.hours) + '" style="max-width:90px;" title="Adjust hours before approving">' +
        '<input class="field rv-note" data-id="' + esc(e.id) + '" placeholder="Note (optional)" style="max-width:280px;">' +
        '<button type="button" class="btn btn-primary btn-small rv-act" data-uid="' + esc(e.uid) + '" data-id="' + esc(e.id) + '" data-v="approved" style="margin:0;">Approve</button>' +
        '<button type="button" class="btn danger btn-small rv-act" data-uid="' + esc(e.uid) + '" data-id="' + esc(e.id) + '" data-v="denied" style="margin:0;">Deny</button></div></div>';
    }).join('') : '<p class="section-empty">All caught up.</p>';
    $('rv-list').querySelectorAll('.rv-act').forEach(function (b) {
      b.addEventListener('click', function () {
        var uid = this.getAttribute('data-uid'), id = this.getAttribute('data-id'), v = this.getAttribute('data-v');
        var hours = parseFloat(document.querySelector('.rv-hours[data-id="' + id + '"]').value);
        var note = document.querySelector('.rv-note[data-id="' + id + '"]').value.trim();
        var upd = { status: v, reviewedBy: me.uid, reviewedByName: me.name || '', reviewedAt: new Date().toISOString(), reviewNote: note };
        if (v === 'approved' && hours > 0) upd.hours = hours;
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
      return '<tr><td>' + esc(r.name) + '</td><td>' + r.s.approvedHours + '</td><td>' + (r.s.pendingHours || '—') + '</td><td>' + r.s.distinctEvents + ' / ' + r.s.eventsRequired + '</td><td>' + (r.s.met ? pill('met', 'good') : pill(r.s.hoursShort + ' h' + (r.s.eventsShort ? ' · ' + r.s.eventsShort + ' ev' : ''), 'warn')) + '</td><td>' + (r.s.shortfallDemerits ? '+' + r.s.shortfallDemerits : '0') + '</td></tr>';
    }).join('') : '<tr><td colspan="6" class="section-empty">Nobody matches.</td></tr>';
  }

  // ── Events ──

  function renderEvents() {
    var evs = C.values(all.serviceEvents).sort(function (a, b) { return String(b.date || '').localeCompare(String(a.date || '')); });
    $('ev-tbody').innerHTML = evs.length ? evs.map(function (e) { return '<tr><td>' + esc(e.name) + (e.countsForPledges === false ? ' ' + pill('brothers only') : '') + '</td><td>' + esc(fmtDate(e.date)) + '</td><td>' + esc(e.hoursDefault || '') + '</td></tr>'; }).join('') : '<tr><td colspan="3" class="section-empty">No events yet.</td></tr>';
    $('bk-event').innerHTML = '<option value="">Pick an event…</option>' + evs.map(function (e) { return '<option value="' + esc(e.key) + '" data-hours="' + esc(e.hoursDefault || '') + '" data-date="' + esc(e.date || '') + '">' + esc(e.name) + '</option>'; }).join('');
  }
  function addEvent() {
    var nm = $('ev-name').value.trim(), date = $('ev-date').value, hours = parseFloat($('ev-hours').value) || 0;
    if (!nm) return setStatus('ev-status', 'Name the event.', 'error');
    var key = C.nameKey(nm) + (date ? '_' + date.replace(/-/g, '') : '');
    PortalOps.db.ref('serviceEvents/' + term + '/' + key).set(Object.assign({ name: nm, date: date || null, hoursDefault: hours, countsForPledges: $('ev-pledges').checked }, PortalOps.audit(me)))
      .then(function () { setStatus('ev-status', 'Added.', 'success'); $('ev-name').value = ''; return reload(); })
      .catch(function (err) { setStatus('ev-status', err.message || 'Failed.', 'error'); });
  }

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
    var sel = $('bk-event'), key = sel.value, opt = sel.options[sel.selectedIndex];
    var hours = parseFloat($('bk-hours').value), date = $('bk-date').value;
    var uids = Object.keys(bkSel).filter(function (u) { return bkSel[u]; });
    if (!key) return setStatus('bk-status', 'Pick the event.', 'error');
    if (!(hours > 0)) return setStatus('bk-status', 'Enter the hours.', 'error');
    if (!uids.length) return setStatus('bk-status', 'Pick who attended.', 'error');
    var evName = opt.textContent;
    var updates = {}, now = new Date().toISOString();
    uids.forEach(function (uid) {
      updates['service/' + term + '/' + uid + '/' + key] = { hours: hours, eventName: evName, eventId: key, date: date || opt.getAttribute('data-date') || C.ymd(new Date()), status: 'approved', submittedAt: firebase.database.ServerValue.TIMESTAMP, reviewedBy: me.uid, reviewedByName: me.name || '', reviewedAt: now, reviewNote: 'Credited by the Service Chair', description: '' };
    });
    if (!confirm('Credit ' + hours + ' h for "' + evName + '" to ' + uids.length + ' people?')) return;
    PortalOps.db.ref().update(updates).then(function () {
      setStatus('bk-status', 'Credited ' + uids.length + '.', 'success'); bkSel = {};
      PortalOps.logChange(term, 'service', key, 'Credited ' + hours + 'h for ' + evName + ' to ' + uids.length + ' people', me); return reload();
    }).catch(function (err) { setStatus('bk-status', err.message || 'Failed.', 'error'); });
  }

  function renderAll() { renderReview(); renderProgress(); renderEvents(); renderBulkList(); }

  function init() {
    PortalAuth.requirePerm(['service', 'standards']).then(function (profile) {
      if (!profile) return;
      me = profile; PortalAuth.initNav(profile);
      return PortalOps.loadSettings();
    }).then(function (s) {
      if (!s) return;
      term = PortalOps.currentTerm();
      $('ev-date').value = C.ymd(new Date()); $('bk-date').value = C.ymd(new Date());
      $('btn-add-ev').addEventListener('click', addEvent);
      $('btn-bulk').addEventListener('click', bulkCredit);
      $('bk-search').addEventListener('input', renderBulkList);
      $('bk-none').addEventListener('click', function () { bkSel = {}; renderBulkList(); });
      $('bk-event').addEventListener('change', function () { var o = this.options[this.selectedIndex]; if (o && o.getAttribute('data-hours')) $('bk-hours').value = o.getAttribute('data-hours'); if (o && o.getAttribute('data-date')) $('bk-date').value = o.getAttribute('data-date'); });
      $('pg-search').addEventListener('input', renderProgress);
      $('pg-filter').addEventListener('change', renderProgress);
      return reload();
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(typeof window !== 'undefined' ? window : this);
