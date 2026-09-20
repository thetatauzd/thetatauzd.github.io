/**
 * Semester Setup — the start-of-semester checklist in one place:
 *   1. start a new term (clean slate; carries service shortfalls, charges dues)
 *   2. schedule every event that can give or take demerits, in bulk
 *   3. download and clear photos from closed semesters
 * Everything operational is filed under settings/currentTerm, so "resetting"
 * the chapter is just pointing that at a new term id.
 */
(function (global) {
  'use strict';

  var C = global.OpsCore;
  var esc = C.esc, fmtDate = C.fmtDate;
  var me = null, S = null, term = null, events = {}, attendance = {}, drafts = [], preview = null;

  function $(id) { return document.getElementById(id); }
  function setStatus(id, msg, kind) { var el = $(id); el.textContent = msg || ''; el.className = 'status-line' + (kind ? ' ' + kind : ''); }
  function types() { return C.sortByOrder(C.values(S.eventTypes)).filter(function (t) { return t.key !== 'pledge'; }); }
  function worth(typeKey) { var t = S.eventTypes[typeKey] || S.eventTypes.other; return t.unexcused + ' / ' + t.excused + (t.freePerTerm ? ' · ' + t.freePerTerm + ' free' : ''); }

  // ── Summary + existing events ──

  function renderSummary() {
    $('sm-term').textContent = term; $('sm-term2').textContent = term;
    PortalOps.db.ref('terms/' + term).once('value').then(function (s) {
      var t = s.val() || {};
      var list = C.values(events), recorded = list.filter(function (e) { return e.recorded; }).length;
      $('sm-summary').textContent = (t.label || term) + (t.startDate ? ' · ' + fmtDate(t.startDate) + ' to ' + fmtDate(t.endDate) : '') + (t.duesDueDate ? ' · dues due ' + fmtDate(t.duesDueDate) : '') +
        ' · ' + list.length + ' events scheduled, attendance taken for ' + recorded + '.';
    }).catch(function () {});
  }

  function renderEvents() {
    var list = C.values(events).sort(function (a, b) { return String(a.date || '9999').localeCompare(String(b.date || '9999')) || String(a.title).localeCompare(String(b.title)); });
    $('ev-count').textContent = list.length + ' events';
    $('ev-tbody').innerHTML = list.length ? list.map(function (ev) {
      var def = S.eventTypes[ev.type] || S.eventTypes.other;
      return '<tr><td><strong>' + esc(ev.title) + '</strong></td><td>' + esc(fmtDate(ev.date)) + '</td><td>' + esc(ev.time || '') + '</td><td>' + esc(def.label) + '</td><td>' + (ev.recorded ? 'taken' : '<span style="color:#999;">not yet</span>') + '</td>' +
        '<td>' + (ev.recorded ? '' : '<button type="button" class="btn-text ev-del" data-id="' + esc(ev.key) + '">remove</button>') + '</td></tr>';
    }).join('') : '<tr><td colspan="6" class="section-empty">Nothing scheduled yet.</td></tr>';
    $('ev-tbody').querySelectorAll('.ev-del').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = this.getAttribute('data-id'), ev = events[id] || {};
        if (!confirm('Remove "' + ev.title + '" from the calendar?')) return;
        PortalOps.db.ref('events/' + term + '/' + id).remove().then(function () { PortalOps.logChange(term, 'event', id, 'Removed event "' + ev.title + '"', me); })
          .catch(function (err) { alert(err.message || 'Failed.'); });
      });
    });
    renderSummary();
  }

  // ── Draft list (bulk scheduler) ──

  function renderDrafts() {
    var opts = types();
    $('draft-tbody').innerHTML = drafts.length ? drafts.map(function (d, i) {
      return '<tr data-i="' + i + '"><td><input class="field d-title" value="' + esc(d.title) + '" style="min-width:150px; margin:0;"></td>' +
        '<td><input class="field d-date" type="date" value="' + esc(d.date || '') + '" style="margin:0;"></td>' +
        '<td><input class="field d-time" type="time" value="' + esc(d.time || '') + '" style="margin:0;"></td>' +
        '<td><select class="field d-type" style="margin:0;">' + opts.map(function (t) { return '<option value="' + esc(t.key) + '"' + (t.key === d.type ? ' selected' : '') + '>' + esc(t.label) + '</option>'; }).join('') + '</select></td>' +
        '<td class="d-worth" style="white-space:nowrap; color:#666; font-size:0.85rem;">' + esc(worth(d.type)) + '</td>' +
        '<td><button type="button" class="btn-text d-del">remove</button></td></tr>';
    }).join('') : '<tr><td colspan="6" class="section-empty">Nothing in the list. Fill in the weekly meetings above or add a row.</td></tr>';
    $('draft-tbody').querySelectorAll('tr[data-i]').forEach(function (tr) {
      var i = +tr.getAttribute('data-i');
      tr.querySelector('.d-title').addEventListener('input', function () { drafts[i].title = this.value; });
      tr.querySelector('.d-date').addEventListener('change', function () { drafts[i].date = this.value; });
      tr.querySelector('.d-time').addEventListener('change', function () { drafts[i].time = this.value; });
      tr.querySelector('.d-type').addEventListener('change', function () { drafts[i].type = this.value; tr.querySelector('.d-worth').textContent = worth(this.value); });
      tr.querySelector('.d-del').addEventListener('click', function () { drafts.splice(i, 1); renderDrafts(); });
    });
  }

  function fillWeekly() {
    var first = $('wk-first').value, last = $('wk-last').value;
    if (!first || !last) return setStatus('draft-status', 'Pick the first and last meeting dates.', 'error');
    var skip = $('wk-skip').value.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
    var dates = C.weeklyDates(first, last, $('wk-day').value, skip);
    if (!dates.length) return setStatus('draft-status', 'No dates fall on that day in that range.', 'error');
    var pattern = $('wk-title').value.trim() || 'Chapter {n}';
    var existing = C.values(events).filter(function (e) { return e.type === 'chapter'; }).length + drafts.filter(function (d) { return d.type === 'chapter'; }).length;
    var taken = {};
    C.values(events).forEach(function (e) { if (e.type === 'chapter' && e.date) taken[e.date] = true; });
    var added = 0;
    dates.forEach(function (d) {
      if (taken[d] || drafts.some(function (x) { return x.date === d && x.type === 'chapter'; })) return;
      existing++; added++;
      drafts.push({ title: pattern.replace('{n}', existing), date: d, time: $('wk-time').value || null, type: 'chapter' });
    });
    drafts.sort(function (a, b) { return String(a.date || '9999').localeCompare(String(b.date || '9999')); });
    setStatus('draft-status', added ? 'Added ' + added + ' meetings to the list. Review, then press Create.' : 'Those meetings are already scheduled.', added ? '' : 'error');
    renderDrafts();
  }

  function createDrafts() {
    var rows = drafts.filter(function (d) { return (d.title || '').trim(); });
    if (!rows.length) return setStatus('draft-status', 'The list is empty.', 'error');
    var missing = rows.filter(function (d) { return !d.date; });
    if (missing.length && !confirm(missing.length + ' events have no date yet. Create them anyway?')) return;
    var updates = {}, used = {};
    Object.keys(events).forEach(function (k) { used[k] = true; });
    rows.forEach(function (d) {
      var base = C.nameKey(d.title) || 'event', key = base, n = 2;
      while (used[key]) key = base + '_' + (n++);
      used[key] = true;
      updates['events/' + term + '/' + key] = Object.assign({ title: d.title.trim(), date: d.date || null, time: d.time || null, type: d.type || 'other', recorded: false, notes: '' }, PortalOps.audit(me));
    });
    var btn = $('btn-draft-create'); btn.disabled = true; setStatus('draft-status', 'Creating…');
    PortalOps.db.ref().update(updates).then(function () {
      PortalOps.logChange(term, 'event', 'schedule', 'Scheduled ' + rows.length + ' events from Semester Setup', me);
      drafts = []; renderDrafts(); setStatus('draft-status', 'Created ' + rows.length + ' events.', 'success');
    }).catch(function (err) { setStatus('draft-status', err.message || 'Failed.', 'error'); }).then(function () { btn.disabled = false; });
  }

  // ── New term ──

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
    var id = preview.id, old = term;
    if (!confirm('Close ' + old + ' and start ' + id + '? Everyone starts ' + id + ' at zero apart from the roll-overs in the preview.')) return;
    var updates = {}, now = new Date().toISOString();
    updates['terms/' + old + '/status'] = 'closed'; updates['terms/' + old + '/closedAt'] = now;
    updates['terms/' + id] = { label: $('nt-label').value.trim() || id, startDate: $('nt-start').value || null, endDate: $('nt-end').value || null, duesDueDate: $('nt-due').value || null, status: 'active', createdBy: me.uid, createdAt: now };
    updates['settings/currentTerm'] = id;
    if ($('nt-rollover').checked) preview.carry.forEach(function (c) { updates['rollover/' + id + '/' + c.uid] = { points: c.points, from: old, note: 'Service shortfall: ' + c.hours + 'h / ' + c.events + ' events in ' + old, createdBy: me.uid, createdAt: now }; });
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
      PortalOps.logChange(id, 'rollover', old, 'Started ' + id + ' from ' + old + ': ' + preview.carry.length + ' roll-overs' + (chargeDues ? ', dues charged' : ''), me);
      setStatus('nt-status', 'Started ' + id + '. Now schedule its events.', 'success');
      setTimeout(function () { window.location.reload(); }, 900);
    }).catch(function (err) { setStatus('nt-status', err.message || 'Failed.', 'error'); });
  }

  // ── Photos ──

  function renderPhotos() {
    if (me.role !== 'admin') { $('ph-list').innerHTML = '<p class="section-empty">Only an admin can download and clear photos.</p>'; return; }
    // Photos are filed by semester, so the list of semesters is the list of places photos can be.
    PortalOps.db.ref('terms').once('value').then(function (snap) {
      var terms = snap.val() || {};
      terms[term] = terms[term] || true;
      var list = Object.keys(terms).sort(function (a, b) { return (a.slice(1) + (a[0] === 'S' ? '0' : '1')).localeCompare(b.slice(1) + (b[0] === 'S' ? '0' : '1')); });
      $('ph-list').innerHTML = list.length ? list.map(function (t) {
        return '<div class="req-card"><div class="req-head"><strong>' + esc(t) + '</strong>' + (t === term ? ' <span class="count-pill warn">current semester</span>' : '') + '</div>' +
          '<div class="req-actions"><button type="button" class="btn secondary btn-small ph-zip" data-t="' + esc(t) + '">Download zip</button>' +
          (t === term ? '' : '<button type="button" class="btn danger btn-small ph-clear" data-t="' + esc(t) + '">Clear photos</button>') + '</div></div>';
      }).join('') : '<p class="section-empty">No photos stored.</p>';
      $('ph-list').querySelectorAll('.ph-zip').forEach(function (b) { b.addEventListener('click', function () { zipTerm(this.getAttribute('data-t'), this); }); });
      $('ph-list').querySelectorAll('.ph-clear').forEach(function (b) { b.addEventListener('click', function () { clearTerm(this.getAttribute('data-t')); }); });
    }).catch(function () { $('ph-list').innerHTML = '<p class="section-empty">Could not check stored photos.</p>'; });
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      if (global.JSZip) return resolve();
      var s = document.createElement('script'); s.src = src; s.onload = resolve; s.onerror = function () { reject(new Error('Could not load the zip library.')); };
      document.head.appendChild(s);
    });
  }

  function zipTerm(t, btn) {
    btn.disabled = true; setStatus('ph-status', 'Collecting photos for ' + t + '… this can take a minute.');
    Promise.all([
      loadScript('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js'),
      PortalOps.loadDirectory(),
      PortalOps.db.ref('proof/excuse/' + t).once('value'), PortalOps.db.ref('proof/service/' + t).once('value')
    ]).then(function (r) {
      var dir = r[1], zip = new global.JSZip(), n = 0;
      [['excuses', r[2].val()], ['service', r[3].val()]].forEach(function (pair) {
        Object.keys(pair[1] || {}).forEach(function (uid) {
          var who = C.nameKey((dir[uid] || {}).name || uid);
          Object.keys(pair[1][uid]).forEach(function (id) {
            var p = pair[1][uid][id]; if (!p || !p.data) return;
            zip.file(pair[0] + '/' + who + '/' + (p.createdAt || '').slice(0, 10) + '_' + id + '.jpg', p.data.split(',')[1], { base64: true }); n++;
          });
        });
      });
      if (!n) { setStatus('ph-status', 'No photos in ' + t + '.'); return null; }
      return zip.generateAsync({ type: 'blob' }).then(function (blob) {
        var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'theta-tau-photos-' + t + '.zip'; a.click();
        setStatus('ph-status', 'Downloaded ' + n + ' photos from ' + t + '.', 'success');
      });
    }).catch(function (err) { setStatus('ph-status', err.message || 'Failed.', 'error'); }).then(function () { btn.disabled = false; });
  }

  function clearTerm(t) {
    if (!confirm('Delete every excuse and service photo from ' + t + '? The requests themselves stay; only the pictures go. Download the zip first if you want a copy.')) return;
    var updates = {}; updates['proof/excuse/' + t] = null; updates['proof/service/' + t] = null;
    PortalOps.db.ref().update(updates).then(function () {
      PortalOps.logChange(term, 'photos', t, 'Cleared stored photos from ' + t, me);
      setStatus('ph-status', 'Cleared ' + t + '.', 'success'); renderPhotos();
    }).catch(function (err) { setStatus('ph-status', err.message || 'Failed.', 'error'); });
  }

  // ── Init ──

  function init() {
    PortalAuth.requirePerm(['settings', 'attendance']).then(function (profile) {
      if (!profile) return;
      me = profile; PortalAuth.initNav(profile);
      return PortalOps.loadSettings(true);
    }).then(function (s) {
      if (!s) return;
      S = s; term = PortalOps.currentTerm();
      if (!PortalOps.hasPerm(me, 'settings')) $('card-newterm').classList.add('hidden');
      $('wk-time').value = (S.policy.attendance.defaultEventTime || '19:00');
      $('btn-wk-fill').addEventListener('click', fillWeekly);
      $('btn-draft-add').addEventListener('click', function () { drafts.push({ title: '', date: '', time: S.policy.attendance.defaultEventTime || '19:00', type: 'rush' }); renderDrafts(); });
      $('btn-draft-clear').addEventListener('click', function () { drafts = []; renderDrafts(); setStatus('draft-status', ''); });
      $('btn-draft-create').addEventListener('click', createDrafts);
      $('btn-preview-term').addEventListener('click', previewTerm);
      $('btn-start-term').addEventListener('click', startTerm);
      renderDrafts(); renderPhotos();
      PortalOps.db.ref('events/' + term).on('value', function (snap) { events = snap.val() || {}; renderEvents(); });
      $('page-status').classList.add('hidden'); $('page-body').classList.remove('hidden');
    }).catch(function (err) { $('page-status').textContent = (err && err.message) || 'Could not load.'; });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(typeof window !== 'undefined' ? window : this);
