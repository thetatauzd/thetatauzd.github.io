/**
 * My Tracker — a brother's own standing, attendance, dues, service hours and
 * (for PNMs) pledge progress, computed from the portal database. Also fills
 * the three tiles on the portal home page. Nothing here talks to Google Sheets.
 */
(function (global) {
  'use strict';

  var C = global.OpsCore;
  var esc = C.esc, money = C.money, fmtDate = C.fmtDate;
  var me = null, term = null, facts = null;

  function $(id) { return document.getElementById(id); }
  function setStatus(id, msg, kind) { var el = $(id); if (!el) return; el.textContent = msg || ''; el.className = 'status-line' + (kind ? ' ' + kind : ''); }
  function pill(text, cls) { return '<span class="count-pill ' + (cls || '') + '">' + esc(text) + '</span>'; }
  function standingLabel(s) { return s === 'bad' ? 'Bad standing' : (s === 'warning' ? 'Warning' : 'Good'); }
  function standingClass(s) { return s === 'bad' ? 'bad' : (s === 'warning' ? 'warn' : 'good'); }

  function load() {
    return PortalOps.loadSettings().then(function () {
      term = PortalOps.currentTerm();
      return PortalOps.loadMyFacts(term, me.uid);
    }).then(function (f) { facts = f; return f; });
  }

  // ── Home tiles ──

  function renderHomeStats(profile) {
    var grid = $('stat-grid'), status = $('stat-status');
    if (!grid || !status) return;
    me = profile || me;
    if (!me) return;
    status.textContent = 'Loading your tracker…';
    load().then(function (f) {
      var S = f.settings;
      var dem = C.computeDemerits(me.uid, f, S, { pnm: me.status === 'pnm' });
      var led = C.ledgerSummary(f.ledger, S);
      var svc = C.serviceSummary(f.service, S, { pnm: me.status === 'pnm' });
      setTile('stat-balance', money(led.balance), led.balance > 0 ? 'stat-owing' : 'stat-clear');
      setTile('stat-demerits', String(dem.total), dem.standing === 'bad' ? 'stat-owing' : (dem.standing === 'warning' ? '' : 'stat-clear'));
      setTile('stat-service', svc.approvedHours + ' / ' + svc.hoursRequired, svc.met ? 'stat-clear' : '');
      grid.classList.remove('hidden');
      status.innerHTML = '<a href="tracker">See your full tracker →</a>';
    }).catch(function (err) { status.textContent = err.message || 'Could not load your tracker.'; });
  }
  function setTile(id, value, cls) {
    var tile = $(id); if (!tile) return;
    var v = tile.querySelector('.stat-value'); if (v) v.textContent = value;
    tile.classList.remove('stat-owing', 'stat-clear'); if (cls) tile.classList.add(cls);
  }

  // ── Full page ──

  function renderTrackerPage(profile) {
    me = profile;
    load().then(function () {
      $('tracker-status').classList.add('hidden');
      $('tracker-body').classList.remove('hidden');
      renderAll();
      wireForms();
    }).catch(function (err) { $('tracker-status').textContent = err.message || 'Could not load your tracker.'; });
  }

  function renderAll() {
    var S = facts.settings, isPnm = me.status === 'pnm';
    var dem = C.computeDemerits(me.uid, facts, S, { pnm: isPnm });
    var led = C.ledgerSummary(facts.ledger, S);
    var svc = dem.service;

    // Standing
    $('standing-term').textContent = term;
    $('st-total').textContent = dem.total;
    $('st-standing').innerHTML = '<span class="standing-' + dem.standing + '">' + standingLabel(dem.standing) + '</span>';
    $('st-buyout').textContent = dem.buyout ? money(dem.buyout) : '—';
    $('st-next').textContent = dem.serviceShortfallNext ? '+' + dem.serviceShortfallNext : '0';
    var p = S.policy;
    $('st-explain').textContent = 'Warning at ' + p.warningThreshold + ', bad standing at ' + p.badStandingThreshold + '. Extra service hours past ' + svc.hoursRequired + ' erase demerits one for one; a buy-out fine resets you to 0. Service shortfalls are added next term.';
    var kv = [['Carried in from last term', dem.rolloverPoints]];
    Object.keys(dem.perType).forEach(function (t) {
      var x = dem.perType[t];
      kv.push([x.label + ' (' + x.unexcused + ' unexcused' + (x.free ? ', ' + x.free + ' free' : '') + (x.excused ? ', ' + x.excused + ' excused' : '') + ')', x.demerits]);
    });
    kv.push(['Unpaid fees past due', dem.paymentDemerits]);
    kv.push(['Standards adjustments', dem.adjustmentsTotal]);
    if (dem.serviceCredit) kv.push(['Extra service hours', dem.serviceCredit]);
    kv.push(['Total', dem.total]);
    $('st-breakdown').innerHTML = kv.map(function (r) { return '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>'; }).join('');
    var tl = C.demeritTimeline(me.uid, facts, S, { pnm: isPnm });
    $('st-timeline').innerHTML = tl.lines.length ? '<li class="tl-head"><span>Date</span><span>What happened</span><span class="tl-pts">Change</span><span class="tl-run">Total</span></li>' + tl.lines.map(function (l) {
      var cls = l.points > 0 ? 'plus' : (l.points < 0 ? 'minus' : 'zero');
      return '<li><span class="tl-date">' + esc(l.date ? fmtDate(l.date).replace(/, \d{4}$/, '') : 'Start') + '</span><span>' + esc(l.label) + (l.detail ? '<span class="tl-detail">' + esc(l.detail) + '</span>' : '') + '</span>' +
        '<span class="tl-pts ' + cls + '">' + (l.points > 0 ? '+' : '') + l.points + '</span><span class="tl-run">' + l.running + '</span></li>';
    }).join('') : '<li class="section-empty">Nothing yet this term. You are at 0.</li>';

    // Attendance
    var free = C.freeAbsences(dem, S);
    $('att-free').textContent = free.left + ' of ' + free.allowed + ' free chapter absences left';
    var excusesByEvent = {};
    C.values(facts.excuses).forEach(function (x) { if (x.eventId && (x.kind || 'absent') === 'absent' && (!excusesByEvent[x.eventId] || (x.submittedAt || 0) > (excusesByEvent[x.eventId].submittedAt || 0))) excusesByEvent[x.eventId] = x; });
    var events = C.values(facts.events).sort(function (a, b) { return String(a.date || '').localeCompare(String(b.date || '')); });
    var rowsHtml = events.map(function (ev) {
      var mark = facts.attendance[ev.key] && facts.attendance[ev.key][me.uid];
      var x = excusesByEvent[ev.key];
      var cell;
      if (ev.recorded && !mark) cell = '<span style="color:#999;">not on roll call</span>';
      else if (!ev.recorded) cell = x ? pill('Excuse ' + x.status, x.status === 'approved' ? 'good' : (x.status === 'denied' ? 'bad' : 'warn')) : '<span style="color:#999;">upcoming</span>';
      else if (mark && mark.present) cell = pill('Present', 'good');
      else if (x && x.status === 'approved') cell = pill('Excused', 'good');
      else if (x && x.status === 'pending') cell = pill('Absent · excuse pending', 'warn');
      else cell = pill('Absent', 'bad');
      var typeDef = S.eventTypes[ev.type] || S.eventTypes.other;
      return '<tr><td>' + esc(ev.title) + '</td><td>' + esc(fmtDate(ev.date)) + '</td><td>' + esc(typeDef.label) + '</td><td>' + cell + '</td></tr>';
    });
    $('att-tbody').innerHTML = rowsHtml.length ? rowsHtml.join('') : '<tr><td colspan="4" class="section-empty">No events recorded yet this term.</td></tr>';
    $('excuse-hours').textContent = p.attendance.excuseHoursBefore;
    var mine = C.values(facts.excuses).sort(function (a, b) { return (b.submittedAt || 0) - (a.submittedAt || 0); });
    $('exc-list').innerHTML = mine.length ? '<div class="vgroups">' + mine.map(function (x) {
      var ev = facts.events[x.eventId] || { title: x.eventText || 'Unlisted event' };
      var what = x.kind === 'late' ? ' (arriving late)' : (x.kind === 'leaveEarly' ? ' (leaving early)' : '');
      return '<div class="vgroup"><span class="vg-label">' + pill(x.status, x.status === 'approved' ? 'good' : (x.status === 'denied' ? 'bad' : 'warn')) + '</span><span class="vg-names"><strong>' + esc(ev.title) + '</strong>' + esc(what) + ' — ' + esc(x.reason || '') + (x.reviewNote ? ' <em>(Standards: ' + esc(x.reviewNote) + ')</em>' : '') + '</span></div>';
    }).join('') + '</div>' : '';

    // Dues
    $('pay-balance').textContent = money(led.balance);
    $('tile-balance').classList.toggle('stat-owing', led.balance > 0);
    $('tile-balance').classList.toggle('stat-clear', led.balance <= 0);
    $('pay-late').textContent = money(led.lateFees);
    $('pay-tbody').innerHTML = led.charges.length ? led.charges.map(function (c) {
      var cls = c.status === 'paid' ? 'is-paid' : (c.status === 'waived' ? 'is-waived' : 'is-unpaid');
      var label = c.status === 'plan' ? 'Payment plan' : c.status.charAt(0).toUpperCase() + c.status.slice(1);
      return '<tr class="' + (c.settled ? 'row-paid' : '') + '"><td>' + esc(c.item) + '</td><td>' + money(c.amount) + '</td><td>' + esc(fmtDate(c.dueDate)) + '</td>' +
        '<td><span class="pay-status ' + cls + '">' + esc(label) + '</span>' + (c.lateFee && !c.settled ? ' <span style="font-size:0.78rem; color:#c62828;">+' + money(c.lateFee) + ' late</span>' : '') + '</td>' +
        '<td>' + (c.settled ? '—' : money(c.remaining + c.lateFee)) + '</td></tr>';
    }).join('') : '<tr><td colspan="5" class="section-empty">Nothing charged yet this term.</td></tr>';
    var d = p.dues;
    $('pay-explain').textContent = 'Fees are late one day after the due date: $' + (d.lateLadder || []).join(', then $') + ' per week, then $' + d.lateAfterLadder + ' per week. Talk to the Treasurer for a payment plan.';

    // Service
    $('svc-approved').textContent = svc.approvedHours + (svc.pendingHours ? ' (+' + svc.pendingHours + ' pending)' : '');
    $('svc-required').textContent = svc.hoursRequired;
    $('svc-events').textContent = svc.distinctEvents + ' / ' + svc.eventsRequired;
    $('svc-explain').textContent = svc.met ? 'Requirement met. Extra approved hours erase demerits one for one.' :
      'Still need ' + svc.hoursShort + ' hour' + (svc.hoursShort === 1 ? '' : 's') + (svc.eventsShort ? ' and ' + svc.eventsShort + ' more event' + (svc.eventsShort === 1 ? '' : 's') : '') + '. Falling short adds ' + svc.shortfallDemerits + ' demerits next term.';
    var entries = svc.entries.sort(function (a, b) { return String(b.date || '').localeCompare(String(a.date || '')); });
    $('svc-tbody').innerHTML = entries.length ? entries.map(function (e) {
      return '<tr><td>' + esc(e.eventName || '') + '</td><td>' + esc(fmtDate(e.date)) + '</td><td>' + esc(e.hours) + '</td><td>' + pill(e.status, e.status === 'approved' ? 'good' : (e.status === 'denied' ? 'bad' : 'warn')) + (e.countsAsEvent && e.status === 'approved' ? ' ' + pill('service event', 'good') : '') + (e.reviewNote ? ' <span style="font-size:0.78rem; color:#666;">' + esc(e.reviewNote) + '</span>' : '') + '</td></tr>';
    }).join('') : '<tr><td colspan="4" class="section-empty">Nothing logged yet.</td></tr>';

    // Pledge
    if (isPnm) {
      $('card-pledge').classList.remove('hidden');
      PortalOps.db.ref('pledges/' + me.uid).once('value').then(function (s) {
        var pr = C.pledgeReadiness(s.val() || {}, facts.service, S);
        $('pledge-checks').innerHTML = pr.checks.map(function (c) {
          return '<li style="display:flex; gap:0.5rem; align-items:center; padding:0.25rem 0;">' + pill(c.ok ? '✓' : '·', c.ok ? 'good' : 'warn') + '<span>' + esc(c.label) + (c.value ? ' <span style="color:#777;">' + esc(c.value) + '</span>' : '') + '</span></li>';
        }).join('') + '<li style="margin-top:0.5rem; font-weight:600;" class="standing-' + (pr.ready ? 'good' : 'warning') + '">' + (pr.ready ? 'All requirements met.' : 'Not yet ready for initiation.') + '</li>';
      }).catch(function () {});
    }
  }

  function wireForms() {}

  global.PortalTracker = { renderHomeStats: renderHomeStats, renderTrackerPage: renderTrackerPage, load: load };
})(typeof window !== 'undefined' ? window : this);
