/**
 * Member record — everything the site knows about one person for a term, on one
 * page. Opened by clicking a name on an officer page (member?uid=…). Each section
 * appears only if the database rules let the viewer read it, so the Treasurer sees
 * money, the Service Chair sees hours, Standards sees demerits and excuses, and so on.
 */
(function (global) {
  'use strict';

  var C = global.OpsCore;
  var esc = C.esc, money = C.money, fmtDate = C.fmtDate;
  var me = null, S = null, uid = null, term = null, person = null;

  function $(id) { return document.getElementById(id); }
  function pill(t, cls) { return '<span class="count-pill ' + (cls || '') + '">' + esc(t) + '</span>'; }
  function statusCls(s) { return s === 'approved' ? 'good' : (s === 'denied' ? 'bad' : 'warn'); }
  function show(id, on) { $(id).classList.toggle('hidden', !on); }
  /** Read a path; null when the rules say no. */
  function read(path) { return PortalOps.db.ref(path).once('value').then(function (s) { return { ok: true, val: s.val() }; }).catch(function () { return { ok: false, val: null }; }); }

  function load() {
    var t = term;
    return Promise.all([
      read('events/' + t), read('myAttendance/' + t + '/' + uid), read('excuses/' + t + '/' + uid), read('excuseFlags/' + t),
      read('adjustments/' + t + '/' + uid), read('rollover/' + t + '/' + uid), read('ledger/' + t + '/' + uid),
      read('service/' + t + '/' + uid), read('standing/' + t + '/' + uid), read('statusHistory/' + uid)
    ]).then(function (r) { render({ events: r[0], att: r[1], excuses: r[2], flags: r[3], adj: r[4], rollover: r[5], ledger: r[6], service: r[7], standing: r[8], history: r[9] }); });
  }

  function render(d) {
    var isPnm = person.status === 'pnm';
    var attendance = {};
    Object.keys(d.att.val || {}).forEach(function (eid) { attendance[eid] = {}; attendance[eid][uid] = d.att.val[eid]; });
    var excusedEvents = {};
    Object.keys(d.flags.val || {}).forEach(function (eid) { if ((d.flags.val[eid] || {})[uid] === 'approved') excusedEvents[eid] = true; });
    var facts = { events: d.events.val || {}, attendance: attendance, excuses: d.excuses.val || {}, excusedEvents: excusedEvents, adjustments: d.adj.val || {},
      rollover: d.rollover.val, ledger: d.ledger.val || {}, service: d.service.val || {}, standingOverride: d.standing.val };

    var canStanding = d.att.ok && d.adj.ok;
    var tiles = [];
    if (canStanding) {
      var dem = C.computeDemerits(uid, facts, S, { pnm: isPnm });
      tiles.push(['Demerits', dem.total], ['Standing', dem.standing === 'bad' ? 'Bad' : (dem.standing === 'warning' ? 'Warning' : 'Good')], ['Buy-out', dem.buyout ? money(dem.buyout) : '—']);
      var tl = C.demeritTimeline(uid, facts, S, { pnm: isPnm });
      $('m-timeline').innerHTML = tl.lines.length ? '<li class="tl-head"><span>Date</span><span>What happened</span><span class="tl-pts">Change</span><span class="tl-run">Total</span></li>' + tl.lines.map(function (l) {
        var cls = l.points > 0 ? 'plus' : (l.points < 0 ? 'minus' : 'zero');
        return '<li><span class="tl-date">' + esc(l.date ? fmtDate(l.date).replace(/, \d{4}$/, '') : 'Start') + '</span><span>' + esc(l.label) + (l.detail ? '<span class="tl-detail">' + esc(l.detail) + '</span>' : '') + '</span><span class="tl-pts ' + cls + '">' + (l.points > 0 ? '+' : '') + l.points + '</span><span class="tl-run">' + l.running + '</span></li>';
      }).join('') : '<li class="section-empty">Nothing this term.</li>';
      var free = C.freeAbsences(dem, S);
      $('m-free').textContent = free.left + ' of ' + free.allowed + ' free chapter absences left';
      var excMap = C.excusedMap(facts);
      var evs = C.values(facts.events).filter(function (e) { return e.recorded; }).sort(function (a, b) { return String(a.date || '').localeCompare(String(b.date || '')); });
      $('m-att').innerHTML = evs.length ? evs.map(function (ev) {
        var m = attendance[ev.key] && attendance[ev.key][uid];
        var cell = !m ? '<span style="color:#999;">not on roll call</span>' : (m.present ? pill('Present', 'good') : (excMap[ev.key] ? pill('Excused', 'good') : pill('Absent', 'bad')));
        return '<tr><td>' + esc(ev.title) + '</td><td>' + esc(fmtDate(ev.date)) + '</td><td>' + esc((S.eventTypes[ev.type] || S.eventTypes.other).label) + '</td><td>' + cell + '</td></tr>';
      }).join('') : '<tr><td colspan="4" class="section-empty">No attendance taken yet.</td></tr>';
    }
    show('sec-timeline', canStanding); show('sec-attendance', canStanding);

    show('sec-excuses', d.excuses.ok);
    if (d.excuses.ok) {
      var xs = C.values(d.excuses.val).sort(function (a, b) { return (b.submittedAt || 0) - (a.submittedAt || 0); });
      $('m-excuses').innerHTML = xs.length ? xs.map(function (x) {
        var ev = x.eventId ? (facts.events[x.eventId] || { title: x.eventId }) : { title: x.eventText || 'Unlisted event', date: x.eventDate };
        return '<div class="req-card"><div class="req-head"><strong>' + esc(ev.title) + '</strong>' + pill(x.status, statusCls(x.status)) + (x.lateSubmission ? pill('late', 'warn') : '') + '</div><div class="pick-sub">' + esc(ev.date ? fmtDate(ev.date) : '') + (x.kind && x.kind !== 'absent' ? ' · ' + (x.kind === 'late' ? 'arriving late' : 'leaving early') : '') + '</div><div class="req-body">' + esc(x.reason || '') + '</div>' +
          (x.reviewNote ? '<div class="req-note">' + esc(x.reviewedByName || 'Standards') + ': ' + esc(x.reviewNote) + '</div>' : '') + PortalPhotos.buttonsHtml('excuse', term, uid, x.photoIds) + '</div>';
      }).join('') : '<p class="section-empty">None this term.</p>';
      PortalPhotos.wire($('m-excuses'));
    }

    show('sec-ledger', d.ledger.ok);
    if (d.ledger.ok) {
      var led = C.ledgerSummary(facts.ledger, S);
      tiles.push(['Balance', money(led.balance)]);
      $('m-balance').textContent = money(led.balance) + ' due';
      $('m-ledger').innerHTML = led.charges.length ? led.charges.map(function (c) {
        var label = c.status === 'plan' ? 'Payment plan' : c.status.charAt(0).toUpperCase() + c.status.slice(1);
        return '<tr><td>' + esc(c.item) + '</td><td>' + money(c.amount) + '</td><td>' + esc(fmtDate(c.dueDate)) + '</td><td>' + esc(label) + (c.lateFee && !c.settled ? ' <span style="color:#c62828; font-size:0.78rem;">+' + money(c.lateFee) + ' late</span>' : '') + '</td><td>' + (c.settled ? '—' : money(c.remaining + c.lateFee)) + '</td></tr>';
      }).join('') : '<tr><td colspan="5" class="section-empty">Nothing charged this term.</td></tr>';
    }

    show('sec-service', d.service.ok);
    if (d.service.ok) {
      var svc = C.serviceSummary(facts.service, S, { pnm: isPnm });
      tiles.push(['Service', svc.approvedHours + ' / ' + svc.hoursRequired + ' h']);
      $('m-svc').textContent = svc.approvedHours + ' h · ' + svc.distinctEvents + ' of ' + svc.eventsRequired + ' events';
      var canEdit = PortalOps.hasPerm(me, 'service');
      var es = svc.entries.sort(function (a, b) { return String(b.date || '').localeCompare(String(a.date || '')); });
      $('m-service').innerHTML = es.length ? es.map(function (e) {
        return '<div class="req-card"><div class="req-head"><strong>' + esc(e.eventName || '') + '</strong>' + pill(e.hours + ' h') + pill(e.status, statusCls(e.status)) + '</div><div class="pick-sub">' + esc(fmtDate(e.date)) + (e.vouchedBy ? ' · vouched by ' + esc(e.vouchedBy) : '') + (e.reviewedByName ? ' · ' + esc(e.reviewedByName) : '') + '</div>' +
          (e.reviewNote ? '<div class="req-note">' + esc(e.reviewNote) + '</div>' : '') + PortalPhotos.buttonsHtml('service', term, uid, e.photoIds) +
          (canEdit && e.status === 'approved' ? '<div class="req-actions"><label class="check-line" style="margin:0;"><input type="checkbox" class="sv-ev" data-id="' + esc(e.key) + '"' + (e.countsAsEvent ? ' checked' : '') + '> counts as a service event</label><input class="field sv-h" data-id="' + esc(e.key) + '" type="number" step="0.25" min="0" value="' + esc(e.hours) + '" style="max-width:90px;"><button type="button" class="btn ghost btn-small sv-save" data-id="' + esc(e.key) + '">Save</button></div>' : (e.countsAsEvent ? pill('service event', 'good') : '')) + '</div>';
      }).join('') : '<p class="section-empty">Nothing logged this term.</p>';
      PortalPhotos.wire($('m-service'));
      $('m-service').querySelectorAll('.sv-save').forEach(function (b) {
        b.addEventListener('click', function () {
          var id = this.getAttribute('data-id');
          var hours = parseFloat($('m-service').querySelector('.sv-h[data-id="' + id + '"]').value);
          var counts = $('m-service').querySelector('.sv-ev[data-id="' + id + '"]').checked;
          if (!(hours >= 0)) return;
          PortalOps.db.ref('service/' + term + '/' + uid + '/' + id).update({ hours: hours, countsAsEvent: counts, updatedBy: me.uid, updatedAt: new Date().toISOString() }).then(function () {
            PortalOps.logChange(term, 'service', uid, 'Edited an approved entry for ' + person.name + ': ' + hours + 'h' + (counts ? ', service event' : ''), me);
            $('m-svc-status').textContent = 'Saved.'; $('m-svc-status').className = 'status-line success';
            return load();
          }).catch(function (err) { $('m-svc-status').textContent = err.message || 'Failed.'; $('m-svc-status').className = 'status-line error'; });
        });
      });
    }

    show('sec-status', d.history.ok);
    if (d.history.ok) {
      var hs = C.values(d.history.val).sort(function (a, b) { return String(b.at || '').localeCompare(String(a.at || '')); });
      $('m-status').innerHTML = hs.length ? '<div class="vgroups">' + hs.map(function (h) {
        var from = (S.statuses[h.from] || {}).label || h.from || '—', to = (S.statuses[h.to] || {}).label || h.to;
        return '<div class="vgroup"><span class="vg-label">' + esc(fmtDate(h.effective || h.at).replace(/, \d{4}$/, '')) + '</span><span class="vg-names">' + esc(from) + ' → <strong>' + esc(to) + '</strong>' + (h.byName ? ' · ' + esc(h.byName) : '') + '</span></div>';
      }).join('') + '</div>' : '<p class="section-empty">No changes recorded.</p>';
    }

    $('m-tiles').innerHTML = tiles.map(function (t) { return '<div class="stat-tile"><div class="stat-label">' + esc(t[0]) + '</div><div class="stat-value">' + esc(t[1]) + '</div></div>'; }).join('');
    $('m-scope').textContent = tiles.length ? 'You see the parts of this record your position covers.' : 'Your position does not cover any part of this record.';
  }

  function init() {
    PortalAuth.requirePerm(['standards', 'finance', 'attendance', 'service', 'pledges', 'settings']).then(function (profile) {
      if (!profile) return;
      me = profile; PortalAuth.initNav(profile);
      return Promise.all([PortalOps.loadSettings(), PortalOps.loadDirectory(), PortalOps.db.ref('terms').once('value').then(function (s) { return s.val() || {}; }).catch(function () { return {}; })]);
    }).then(function (r) {
      if (!r) return;
      S = r[0];
      uid = new URLSearchParams(location.search).get('uid');
      person = r[1][uid];
      if (!person) { $('page-status').textContent = 'That person is not in the directory.'; return; }
      term = PortalOps.currentTerm();
      var terms = r[2]; terms[term] = terms[term] || true;
      $('m-term').innerHTML = Object.keys(terms).sort().reverse().map(function (t) { return '<option' + (t === term ? ' selected' : '') + '>' + esc(t) + '</option>'; }).join('');
      $('m-term').addEventListener('change', function () { term = this.value; load(); });
      $('m-name').textContent = person.name || uid;
      var positions = Object.keys(person.positions || {}).map(function (p) { return (S.positions[p] || {}).label || p; });
      $('m-sub').textContent = [(person.rollNumber ? 'Roll #' + C.rollKey(person.rollNumber) : ''), (S.statuses[person.status] || {}).label || person.status, positions.join(', ')].filter(Boolean).join(' · ');
      return load().then(function () { $('page-status').classList.add('hidden'); $('page-body').classList.remove('hidden'); });
    }).catch(function (err) { $('page-status').textContent = (err && err.message) || 'Could not load.'; });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(typeof window !== 'undefined' ? window : this);
