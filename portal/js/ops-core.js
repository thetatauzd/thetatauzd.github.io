/**
 * OpsCore — pure functions for chapter operations. No DOM, no Firebase.
 *
 * Everything the chapter tracks (demerits, standing, buy-outs, dues balances,
 * late fees, service requirements, pledge readiness) is COMPUTED here from
 * stored facts plus the settings in `settings/`. Change a rule in one place,
 * every page and export follows. `portal/ops-tests.html` checks these against
 * real rows from the F26 Theta Tau Tracker sheet — run it after any change.
 *
 * Schema and rules are documented in portal/docs/ops-schema.md.
 */
(function (global) {
  'use strict';

  var SCHEMA_VERSION = 2;

  /** Capabilities the database rules understand. Positions map onto these. */
  var PERMS = ['finance', 'attendance', 'standards', 'service', 'pledges', 'settings', 'admin'];

  /**
   * Default settings, seeded from the Fall 2026 bylaws, the Standards Board
   * procedures and the F26 Tracker's Config tab. Everything here is editable
   * on the Settings page; these only apply when a node is missing.
   */
  var DEFAULTS = {
    positions: {
      regent:                  { label: 'Regent',                  group: 'officer', order: 1,  perms: { settings: true, standards: true } },
      vice_regent:             { label: 'Vice-Regent',             group: 'officer', order: 2,  perms: { settings: true, attendance: true } },
      scribe:                  { label: 'Scribe',                  group: 'officer', order: 3,  perms: { attendance: true } },
      treasurer:               { label: 'Treasurer',               group: 'officer', order: 4,  perms: { finance: true, settings: true } },
      corresponding_secretary: { label: 'Corresponding Secretary', group: 'officer', order: 5,  perms: {} },
      marshal:                 { label: 'Marshal',                 group: 'officer', order: 6,  perms: { pledges: true } },
      standards_chair:         { label: 'Standards Chair',         group: 'officer', order: 7,  perms: { standards: true, attendance: true, settings: true } },
      standards_rep:           { label: 'Standards Class Rep',     group: 'board',   order: 8,  perms: {} },
      academic_chair:          { label: 'Academic Chair',          group: 'chair',   order: 20, perms: {} },
      brotherhood_chair:       { label: 'Brotherhood Chair',       group: 'chair',   order: 21, perms: {} },
      community_service_chair: { label: 'Community Service Chair', group: 'chair',   order: 22, perms: { service: true } },
      dei_chair:               { label: 'DEI Chair',               group: 'chair',   order: 23, perms: {} },
      fundraising_chair:       { label: 'Fundraising Chair',       group: 'chair',   order: 24, perms: {} },
      intramural_chair:        { label: 'Intramural Chair',        group: 'chair',   order: 25, perms: {} },
      outreach_chair:          { label: 'Outreach Chair',          group: 'chair',   order: 26, perms: {} },
      philanthropy_chair:      { label: 'Philanthropy Chair',      group: 'chair',   order: 27, perms: {} },
      professional_development_chair: { label: 'Professional Development Chair', group: 'chair', order: 28, perms: {} },
      public_relations_chair:  { label: 'Public Relations Chair',  group: 'chair',   order: 29, perms: {} },
      recruitment_chair:       { label: 'Recruitment Chair',       group: 'chair',   order: 30, perms: {} },
      social_chair:            { label: 'Social Chair',            group: 'chair',   order: 31, perms: {} },
      tailgate_chair:          { label: 'Tailgate Chair',          group: 'chair',   order: 32, perms: {} },
      technology_chair:        { label: 'Technology Chair',        group: 'chair',   order: 33, perms: { settings: true } },
      alumni_chair:            { label: 'Alumni Chair',            group: 'chair',   order: 34, perms: {} },
      family_chair:            { label: 'Family Weekend Chair',    group: 'chair',   order: 35, perms: {} }
    },
    statuses: {
      pending:   { label: 'Pending approval', order: 0, countsAsActive: false, chargedDues: false, votes: false },
      active:    { label: 'Active',           order: 1, countsAsActive: true,  chargedDues: true,  votes: true },
      coop:      { label: 'Co-op',            order: 2, countsAsActive: false, chargedDues: false, votes: false },
      abroad:    { label: 'Abroad',           order: 3, countsAsActive: false, chargedDues: false, votes: false },
      inactive:  { label: 'Inactive',         order: 4, countsAsActive: false, chargedDues: false, votes: false },
      pnm:       { label: 'PNM (pledge)',     order: 5, countsAsActive: false, chargedDues: false, votes: false },
      alumnus:   { label: 'Alumni',           order: 6, countsAsActive: false, chargedDues: false, votes: false },
      graduated: { label: 'Graduated',        order: 7, countsAsActive: false, chargedDues: false, votes: false }
    },
    eventTypes: {
      chapter:      { label: 'Chapter Meeting',   order: 1, unexcused: 2, excused: 0, freePerTerm: 2, source: 'Bylaws Art. II Sec. 11: two absences from weekly meetings per semester' },
      voting:       { label: 'Voting Chapter',    order: 2, unexcused: 5, excused: 0, freePerTerm: 0, source: 'Standards procedures: chapter session where candidates are voted on' },
      rush:         { label: 'Rush Event',        order: 3, unexcused: 2, excused: 0, freePerTerm: 0, source: 'Standards procedures: attendance required at every Recruitment event' },
      initiation:   { label: 'Initiation',        order: 4, unexcused: 7, excused: 2, freePerTerm: 0, source: 'Standards procedures: excused still costs 2' },
      philanthropy: { label: 'Philanthropy Event',order: 5, unexcused: 7, excused: 2, freePerTerm: 0, source: 'Standards procedures: excused still costs 2' },
      committee:    { label: 'Committee Meeting', order: 6, unexcused: 1, excused: 0, freePerTerm: 0, source: 'Standards procedures' },
      pledge:       { label: 'Pledge Meeting',    order: 7, unexcused: 0, excused: 0, freePerTerm: 0, source: 'PNM meetings; tracked by the Marshal' },
      other:        { label: 'Other',             order: 8, unexcused: 0, excused: 0, freePerTerm: 0, source: 'Optional events. Credit attendance with an adjustment.' }
    },
    policy: {
      warningThreshold: 7,
      badStandingThreshold: 10,
      service: { hoursRequired: 12, eventsRequired: 3, perHourShort: 1, perEventShort: 2, pnmHours: 8, pnmEvents: 3, extraHourErases: 1 },
      buyout:  { base: 50, baseDemerits: 10, step: 25, stepDemerits: 5, cap: 125 },
      dues:    { amount: 250, pnmAmount: 295, earlyAlumAmount: 90, graceDays: 1, lateLadder: [5, 5], lateAfterLadder: 10, demeritsIfLate: 0 },
      attendance: { excuseHoursBefore: 24, sicknessNeedsNote: true, defaultEventTime: '19:00' },
      quorum:  { business: 0.5, membership: 0.6667 },
      pledge:  { minWeeks: 8, initiationPct: 90, initiationMinActiveFraction: 0.6667, bidPct: 75, depledgePct: 50, flagStdDevs: 2, nationalExam: true, chapterExam: true, pinningFee: 30, initiationFee: 90 },
      gpa:     { member: 2.5, officer: 2.5 }
    }
  };

  // ── Small helpers ──

  function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
  function clone(v) { return JSON.parse(JSON.stringify(v)); }

  /** Deep-merge defaults under stored settings (stored wins). */
  function withDefaults(stored) {
    var out = clone(DEFAULTS);
    function merge(dst, src) {
      Object.keys(src || {}).forEach(function (k) {
        if (src[k] === undefined || src[k] === null) return;      // nothing stored: keep the default
        if (isObj(src[k]) && isObj(dst[k])) merge(dst[k], src[k]);
        else dst[k] = src[k];
      });
    }
    merge(out, stored || {});
    return out;
  }

  function values(obj) { return Object.keys(obj || {}).map(function (k) { var v = obj[k]; if (isObj(v)) v.key = k; return v; }); }
  function sortByOrder(list) { return list.slice().sort(function (a, b) { return (a.order || 0) - (b.order || 0) || String(a.label).localeCompare(String(b.label)); }); }

  /** Firebase-safe key from free text ("Jorge Naranjo Jr." → "jorge_naranjo_jr"). */
  function nameKey(name) {
    return String(name == null ? '' : name).toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  }
  /** Digits-only roll number ("415X!" → "415"). Office suffixes are dropped. */
  function rollKey(roll) {
    var m = String(roll == null ? '' : roll).match(/\d+/);
    return m ? String(parseInt(m[0], 10)) : '';
  }

  function money(n) {
    var v = Math.round((Number(n) || 0) * 100) / 100;
    var s = '$' + Math.abs(v).toFixed(2).replace(/\.00$/, '');
    return v < 0 ? '-' + s : s;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  /** Parse 'YYYY-MM-DD', 'M/D/YYYY', ISO or epoch ms into a Date at local midnight (or null). */
  function toDate(v) {
    if (v == null || v === '') return null;
    if (v instanceof Date) return isNaN(v) ? null : v;
    if (typeof v === 'number') return new Date(v);
    var s = String(v).trim();
    var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) return new Date(+m[3], +m[1] - 1, +m[2]);
    var d = new Date(s);
    return isNaN(d) ? null : d;
  }
  function ymd(d) {
    d = toDate(d); if (!d) return '';
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function fmtDate(v) {
    var d = toDate(v); if (!d) return '—';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function daysBetween(a, b) { return Math.floor((toDate(b) - toDate(a)) / 86400000); }

  // ── People: statuses, positions, permissions, legacy role ──

  function permsFor(positions, settings) {
    var s = withDefaults(settings);
    var out = {};
    Object.keys(positions || {}).forEach(function (p) {
      if (!positions[p]) return;
      var def = s.positions[p];
      Object.keys((def && def.perms) || {}).forEach(function (k) { if (def.perms[k]) out[k] = true; });
    });
    return out;
  }

  /**
   * The single `role` string the older pages and rules still key on.
   * admin is set directly; everything else is derived from status + positions.
   */
  function legacyRole(user) {
    if (!user) return 'pending';
    if (user.role === 'admin') return 'admin';
    var st = user.status || (user.role === 'pending' ? 'pending' : 'active');
    if (st === 'pending') return 'pending';
    if (st === 'pnm') return 'pnm';
    var p = user.positions || {};
    if (p.standards_chair) return 'standards';
    if (p.regent) return 'regent';
    if (p.recruitment_chair) return 'rush_chair';
    return 'brother';
  }

  function isActiveStatus(status, settings) {
    var s = withDefaults(settings);
    var def = s.statuses[status || 'active'];
    return !!(def && def.countsAsActive);
  }
  function isChargedStatus(status, settings) {
    var s = withDefaults(settings);
    var def = s.statuses[status || 'active'];
    return !!(def && def.chargedDues);
  }

  /** Upgrade a legacy users/{uid} record (role only) to status + positions + perms. */
  function upgradeUser(user, settings) {
    var u = clone(user || {});
    var role = u.role || 'pending';
    if (!u.status) u.status = role === 'pending' ? 'pending' : 'active';
    if (!u.positions) {
      u.positions = {};
      if (role === 'standards') u.positions.standards_chair = true;
      if (role === 'regent') u.positions.regent = true;
      if (role === 'rush_chair') u.positions.recruitment_chair = true;
    }
    u.perms = permsFor(u.positions, settings);
    if (role === 'admin') u.perms.admin = true;
    u.role = role === 'admin' ? 'admin' : legacyRole(u);
    return u;
  }

  // ── Demerits & standing ──

  /**
   * This person's mark for an event, or null. Roll call writes a mark for
   * everyone on the roll that night, so NO mark means "was not on roll call"
   * (PNM, co-op, abroad, inactive, joined later) and the event is skipped.
   */
  function markFor(attendance, eventId, uid) {
    var ev = attendance && attendance[eventId];
    return ev && ev[uid] ? ev[uid] : null;
  }

  /**
   * Compute one brother's demerit picture for a term.
   * facts = { events, attendance, excuses (this uid's), adjustments (this uid's),
   *           rollover (this uid's, {points}), ledger (this uid's), service (this uid's), standingOverride }
   */
  /**
   * eventId → true for every event this person has an approved excuse for.
   * Built from their excuse records when readable (self, Standards) or from
   * facts.excusedEvents (the reason-free excuseFlags mirror other officers read).
   * "late" / "leaveEarly" requests never excuse an absence: those people are marked present.
   */
  function excusedMap(facts) {
    var out = {};
    values(facts.excuses).forEach(function (x) {
      if (x.status === 'approved' && x.eventId && (x.kind || 'absent') === 'absent') out[x.eventId] = true;
    });
    Object.keys(facts.excusedEvents || {}).forEach(function (eid) { if (facts.excusedEvents[eid]) out[eid] = true; });
    return out;
  }

  function computeDemerits(uid, facts, settings, opts) {
    var s = withDefaults(settings);
    opts = opts || {};
    var asOf = toDate(opts.asOf) || new Date();
    var events = facts.events || {};
    var excused = excusedMap(facts);

    var byType = {};
    Object.keys(events).forEach(function (eid) {
      var ev = events[eid];
      if (!ev || !ev.recorded) return;
      var type = s.eventTypes[ev.type] ? ev.type : 'other';
      var mark = markFor(facts.attendance, eid, uid);
      if (!mark || mark.present) return;
      var t = byType[type] || (byType[type] = { unexcused: 0, excused: 0, unexcusedEvents: [], excusedEvents: [] });
      if (excused[eid]) { t.excused++; t.excusedEvents.push(eid); }
      else { t.unexcused++; t.unexcusedEvents.push(eid); }
    });

    var attendanceDemerits = 0, chapterDemerits = 0, otherDemerits = 0, chapterAbsences = 0;
    var perType = {};
    Object.keys(byType).forEach(function (type) {
      var def = s.eventTypes[type];
      var t = byType[type];
      var chargeable = Math.max(0, t.unexcused - (def.freePerTerm || 0));
      var d = chargeable * (def.unexcused || 0) + t.excused * (def.excused || 0);
      perType[type] = { label: def.label, unexcused: t.unexcused, excused: t.excused, free: def.freePerTerm || 0, demerits: d,
        unexcusedEvents: t.unexcusedEvents, excusedEvents: t.excusedEvents };
      attendanceDemerits += d;
      if (type === 'chapter') { chapterDemerits += d; chapterAbsences = t.unexcused; }
      else otherDemerits += d;
    });

    // Unpaid charges past due that carry demerits.
    var paymentDemerits = 0, paymentItems = [];
    var led = ledgerSummary(facts.ledger, s, { asOf: asOf });
    led.charges.forEach(function (c) {
      if (c.settled || c.waived || !c.demeritsIfLate) return;
      if (c.onPlan) return;
      if (c.dueDate && daysBetween(c.dueDate, asOf) > (s.policy.dues.graceDays || 0)) {
        paymentDemerits += c.demeritsIfLate;
        paymentItems.push({ item: c.item, demerits: c.demeritsIfLate });
      }
    });

    var adjustmentsTotal = 0;
    values(facts.adjustments).forEach(function (a) { adjustmentsTotal += Number(a.points) || 0; });
    var rolloverPoints = facts.rollover ? (Number(facts.rollover.points) || 0) : 0;

    var svc = serviceSummary(facts.service, s, { pnm: opts.pnm });
    var serviceCredit = -(svc.extraHours * (s.policy.service.extraHourErases || 0));

    var total = rolloverPoints + attendanceDemerits + paymentDemerits + adjustmentsTotal + serviceCredit;
    var standing = computeStanding(total, s, facts.standingOverride);
    return {
      uid: uid,
      chapterAbsences: chapterAbsences,
      chapterDemerits: chapterDemerits,
      otherEventDemerits: otherDemerits,
      attendanceDemerits: attendanceDemerits,
      paymentDemerits: paymentDemerits,
      paymentItems: paymentItems,
      adjustmentsTotal: adjustmentsTotal,
      rolloverPoints: rolloverPoints,
      serviceCredit: serviceCredit,
      total: total,
      standing: standing,                 // 'good' | 'warning' | 'bad'
      buyout: standing === 'bad' ? buyoutFor(total, s) : 0,
      perType: perType,
      service: svc,
      serviceShortfallNext: svc.shortfallDemerits
    };
  }

  /**
   * The same numbers as computeDemerits, as dated lines a brother can read:
   * what was carried in, every absence (including the free ones and what an
   * excused absence still cost), every adjustment, late-fee demerits and the
   * extra-service credit, with a running total. Sum of points === computeDemerits().total.
   */
  function demeritTimeline(uid, facts, settings, opts) {
    var s = withDefaults(settings);
    opts = opts || {};
    var asOf = toDate(opts.asOf) || new Date();
    var lines = [];
    var ro = facts.rollover ? (Number(facts.rollover.points) || 0) : 0;
    if (ro || facts.rollover) lines.push({ date: null, order: 0, kind: 'rollover', label: 'Carried in from ' + ((facts.rollover && facts.rollover.from) || 'last term'), detail: (facts.rollover && facts.rollover.note) || '', points: ro });

    var excused = excusedMap(facts);
    var events = facts.events || {};
    var ids = Object.keys(events).filter(function (eid) { return events[eid] && events[eid].recorded; })
      .sort(function (a, b) { return String(events[a].date || '').localeCompare(String(events[b].date || '')) || a.localeCompare(b); });
    var freeUsed = {};
    ids.forEach(function (eid) {
      var ev = events[eid];
      var type = s.eventTypes[ev.type] ? ev.type : 'other';
      var def = s.eventTypes[type];
      var mark = markFor(facts.attendance, eid, uid);
      if (!mark || mark.present) return;
      if (excused[eid]) {
        lines.push({ date: ev.date || null, order: 1, kind: 'excused', eventId: eid, label: 'Excused absence: ' + ev.title, detail: def.excused ? 'An excused ' + def.label.toLowerCase() + ' still costs ' + def.excused : def.label, points: def.excused || 0 });
        return;
      }
      var free = def.freePerTerm || 0;
      var used = freeUsed[type] || 0;
      if (used < free) {
        freeUsed[type] = used + 1;
        lines.push({ date: ev.date || null, order: 1, kind: 'free', eventId: eid, label: 'Absent: ' + ev.title, detail: 'Free absence ' + (used + 1) + ' of ' + free, points: 0 });
      } else {
        lines.push({ date: ev.date || null, order: 1, kind: 'absence', eventId: eid, label: 'Absent: ' + ev.title, detail: 'Unexcused ' + def.label.toLowerCase(), points: def.unexcused || 0 });
      }
    });

    values(facts.adjustments).forEach(function (a) {
      var pts = Number(a.points) || 0;
      lines.push({ date: a.date || (a.createdAt ? ymd(a.createdAt) : null), order: 2, kind: pts < 0 ? 'credit' : 'adjustment', label: a.reason || (pts < 0 ? 'Credit' : 'Demerits'), detail: 'Standards' + (a.enteredBy || a.createdByName ? ' · ' + (a.enteredBy || a.createdByName) : ''), points: pts });
    });

    var led = ledgerSummary(facts.ledger, s, { asOf: asOf });
    led.charges.forEach(function (c) {
      if (c.settled || c.waived || !c.demeritsIfLate || c.onPlan) return;
      if (c.dueDate && daysBetween(c.dueDate, asOf) > (s.policy.dues.graceDays || 0)) {
        lines.push({ date: c.dueDate, order: 3, kind: 'payment', label: 'Unpaid past due: ' + c.item, detail: 'Removed once it is paid', points: c.demeritsIfLate });
      }
    });

    var svc = serviceSummary(facts.service, s, { pnm: opts.pnm });
    var credit = -(svc.extraHours * (s.policy.service.extraHourErases || 0));
    if (credit) lines.push({ date: ymd(asOf), order: 4, kind: 'credit', label: 'Extra service hours', detail: svc.extraHours + ' h past the ' + svc.hoursRequired + ' required', points: credit });

    lines.sort(function (a, b) {
      if (!a.date && b.date) return -1; if (a.date && !b.date) return 1;
      return String(a.date || '').localeCompare(String(b.date || '')) || a.order - b.order;
    });
    var running = 0;
    lines.forEach(function (l) { running += l.points; l.running = running; });
    return { lines: lines, total: running };
  }

  /** Free absences for one event type (the bylaws' two chapter meetings): { allowed, used, left }. */
  function freeAbsences(dem, settings, type) {
    var s = withDefaults(settings);
    type = type || 'chapter';
    var allowed = (s.eventTypes[type] && s.eventTypes[type].freePerTerm) || 0;
    var t = dem && dem.perType && dem.perType[type];
    var used = t ? Math.min(t.unexcused, allowed) : 0;
    return { allowed: allowed, used: used, left: Math.max(0, allowed - used) };
  }

  /** When an event starts, as a Date (events carry a date and an optional 'HH:MM' time). */
  function eventStart(ev, settings) {
    var d = toDate(ev && ev.date); if (!d) return null;
    var t = String((ev && ev.time) || withDefaults(settings).policy.attendance.defaultEventTime || '19:00').match(/^(\d{1,2}):(\d{2})/);
    var out = new Date(d.getTime());
    out.setHours(t ? +t[1] : 19, t ? +t[2] : 0, 0, 0);
    return out;
  }

  /**
   * Bylaws Art. II Sec. 11: excuses at least N hours ahead.
   * → { onTime, after, hoursAhead } where `after` means the event had already started.
   */
  function excuseTiming(ev, submittedAt, settings) {
    var start = eventStart(ev, settings);
    if (!start) return { onTime: true, after: false, hoursAhead: null };
    var need = withDefaults(settings).policy.attendance.excuseHoursBefore || 0;
    var when = submittedAt instanceof Date ? submittedAt.getTime() : (Number(submittedAt) || Date.now());
    var ahead = (start.getTime() - when) / 3600000;
    return { onTime: ahead >= need, after: ahead < 0, hoursAhead: Math.round(ahead * 10) / 10 };
  }

  /** Every date on a weekday (0 = Sunday) between two dates inclusive, minus `skip` dates. */
  function weeklyDates(start, end, weekday, skip) {
    var a = toDate(start), b = toDate(end), out = [];
    if (!a || !b || b < a) return out;
    var skipSet = {};
    (skip || []).forEach(function (d) { var k = ymd(d); if (k) skipSet[k] = true; });
    var d = new Date(a.getTime());
    while (d.getDay() !== Number(weekday)) d.setDate(d.getDate() + 1);
    for (; d <= b; d.setDate(d.getDate() + 7)) { var k = ymd(d); if (!skipSet[k]) out.push(k); }
    return out;
  }

  /** Sunday that starts the week a date falls in ('YYYY-MM-DD'); the service form's "week". */
  function weekOf(date) {
    var d = toDate(date); if (!d) return '';
    var s = new Date(d.getTime()); s.setDate(s.getDate() - s.getDay());
    return ymd(s);
  }

  function computeStanding(total, settings, override) {
    if (override && override.override) return override.override;
    var p = withDefaults(settings).policy;
    if (total >= p.badStandingThreshold) return 'bad';
    if (total >= p.warningThreshold) return 'warning';
    return 'good';
  }

  function buyoutFor(total, settings) {
    var b = withDefaults(settings).policy.buyout;
    if (total < b.baseDemerits) return 0;
    var steps = Math.floor((total - b.baseDemerits) / b.stepDemerits);
    return Math.min(b.cap, b.base + steps * b.step);
  }

  // ── Service hours ──

  function serviceSummary(entries, settings, opts) {
    var p = withDefaults(settings).policy.service;
    opts = opts || {};
    var hoursRequired = opts.pnm ? p.pnmHours : p.hoursRequired;
    var eventsRequired = opts.pnm ? p.pnmEvents : p.eventsRequired;
    var approved = 0, pending = 0, events = {};
    var list = values(entries);
    list.forEach(function (e) {
      var h = Number(e.hours) || 0;
      if (e.status === 'approved') {
        approved += h;
        // The Service Chair ticks "counts as a service event" when approving. Two
        // entries for the same event on the same day count once.
        if (e.countsAsEvent) events[nameKey(e.eventName) + '|' + (e.date || '')] = true;
      }
      else if (e.status === 'pending') pending += h;
    });
    var distinctEvents = Object.keys(events).filter(Boolean).length;
    var hoursShort = Math.max(0, hoursRequired - approved);
    var eventsShort = Math.max(0, eventsRequired - distinctEvents);
    return {
      approvedHours: approved, pendingHours: pending, distinctEvents: distinctEvents,
      hoursRequired: hoursRequired, eventsRequired: eventsRequired,
      hoursShort: hoursShort, eventsShort: eventsShort,
      extraHours: Math.max(0, approved - hoursRequired),
      met: hoursShort === 0 && eventsShort === 0,
      shortfallDemerits: hoursShort * p.perHourShort + eventsShort * p.perEventShort,
      entries: list
    };
  }

  // ── Finances ──

  /**
   * Late fee for one charge as of a date. The bylaws ladder: `lateLadder`
   * per week for the first weeks, then `lateAfterLadder` every week after,
   * starting the day after the due date plus `graceDays`. Accrual stops when
   * the charge is settled or waived, and pauses while a payment plan is open.
   */
  function lateFeeFor(charge, settings, asOf) {
    var d = withDefaults(settings).policy.dues;
    if (!charge.accruesLate || !charge.dueDate) return 0;
    var stop = toDate(asOf) || new Date();
    if (charge.settledAt && toDate(charge.settledAt) < stop) stop = toDate(charge.settledAt);
    if (charge.waivedAt && toDate(charge.waivedAt) < stop) stop = toDate(charge.waivedAt);
    if (charge.planAt && toDate(charge.planAt) < stop) {
      // Plan pauses accrual from the day it was arranged; resumes if its own due date passes.
      if (!charge.planDueDate || toDate(charge.planDueDate) >= stop) stop = toDate(charge.planAt);
    }
    var lateDays = daysBetween(charge.dueDate, stop) - (d.graceDays || 0);
    if (lateDays <= 0) return 0;
    var weeks = Math.floor((lateDays - 1) / 7) + 1;
    var fee = 0;
    for (var w = 1; w <= weeks; w++) {
      fee += w <= (d.lateLadder || []).length ? Number(d.lateLadder[w - 1]) || 0 : Number(d.lateAfterLadder) || 0;
    }
    return fee;
  }

  /**
   * Roll a brother's ledger entries into charges with what has been paid,
   * waived or planned against each, plus the computed late fee and balance.
   */
  function ledgerSummary(entries, settings, opts) {
    opts = opts || {};
    var asOf = toDate(opts.asOf) || new Date();
    var list = values(entries).filter(function (e) { return e && e.type; });
    var charges = {};
    list.filter(function (e) { return e.type === 'charge'; }).forEach(function (c) {
      charges[c.key] = {
        key: c.key, item: c.item || 'Charge', amount: Number(c.amount) || 0, dueDate: c.dueDate || null, date: c.date || null,
        accruesLate: c.accruesLate !== false, demeritsIfLate: Number(c.demeritsIfLate) || 0,
        paid: 0, waived: 0, waivedAt: null, planAt: null, planDueDate: null, settledAt: null, onPlan: false, history: [], reversed: false
      };
    });
    // Reversals cancel a specific entry.
    var reversed = {};
    list.filter(function (e) { return e.type === 'reversal' && e.reverses; }).forEach(function (r) { reversed[r.reverses] = true; });
    Object.keys(charges).forEach(function (k) { if (reversed[k]) charges[k].reversed = true; });

    list.filter(function (e) { return e.type !== 'charge' && e.type !== 'reversal' && !reversed[e.key]; })
      .sort(function (a, b) { return (toDate(a.date) || 0) - (toDate(b.date) || 0); })
      .forEach(function (e) {
        var c = e.chargeId && charges[e.chargeId];
        if (!c) return;
        var amt = Number(e.amount) || 0;
        if (e.type === 'payment') {
          c.paid += amt;
          if (!c.settledAt && c.paid + c.waived >= c.amount - 0.005) c.settledAt = e.date || ymd(asOf);
        } else if (e.type === 'waiver') {
          c.waived += amt || (c.amount - c.paid);
          c.waivedAt = c.waivedAt || e.date || ymd(asOf);
          if (!c.settledAt && c.paid + c.waived >= c.amount - 0.005) c.settledAt = c.waivedAt;
        } else if (e.type === 'plan') {
          c.planAt = e.date || ymd(asOf);
          c.planDueDate = e.planDueDate || null;
        }
        c.history.push(e);
      });

    var totalCharged = 0, totalPaid = 0, totalWaived = 0, totalLate = 0, balance = 0;
    var out = [];
    Object.keys(charges).forEach(function (k) {
      var c = charges[k];
      if (c.reversed) return;
      c.settled = c.paid + c.waived >= c.amount - 0.005;
      c.onPlan = !!c.planAt && !c.settled && (!c.planDueDate || toDate(c.planDueDate) >= asOf);
      c.lateFee = c.settled ? lateFeeFor(c, settings, c.settledAt) : lateFeeFor(c, settings, asOf);
      c.remaining = Math.max(0, c.amount - c.paid - c.waived);
      c.isLate = !c.settled && !c.onPlan && !!c.dueDate && daysBetween(c.dueDate, asOf) > (withDefaults(settings).policy.dues.graceDays || 0);
      c.status = c.settled ? (c.waived >= c.amount - 0.005 ? 'waived' : 'paid') : (c.onPlan ? 'plan' : (c.isLate ? 'late' : 'unpaid'));
      totalCharged += c.amount; totalPaid += c.paid; totalWaived += c.waived; totalLate += c.lateFee;
      balance += c.remaining + (c.settled ? 0 : c.lateFee);
      out.push(c);
    });
    out.sort(function (a, b) { return (toDate(a.dueDate || a.date) || 0) - (toDate(b.dueDate || b.date) || 0); });
    return { charges: out, totalCharged: totalCharged, totalPaid: totalPaid, totalWaived: totalWaived, lateFees: totalLate, balance: Math.round(balance * 100) / 100 };
  }

  // ── Pledges ──

  function pledgeReadiness(pledge, serviceEntries, settings, opts) {
    var p = withDefaults(settings).policy.pledge;
    var asOf = toDate((opts || {}).asOf) || new Date();
    var svc = serviceSummary(serviceEntries, settings, { pnm: true });
    var weeks = pledge && pledge.startDate ? Math.floor(daysBetween(pledge.startDate, asOf) / 7) : 0;
    var checks = [
      { key: 'hours',  label: svc.hoursRequired + ' service hours',  ok: svc.hoursShort === 0, value: svc.approvedHours + '/' + svc.hoursRequired },
      { key: 'events', label: svc.eventsRequired + ' service events', ok: svc.eventsShort === 0, value: svc.distinctEvents + '/' + svc.eventsRequired },
      { key: 'weeks',  label: p.minWeeks + ' weeks pledging',        ok: weeks >= p.minWeeks, value: weeks + '/' + p.minWeeks }
    ];
    if (p.nationalExam) checks.push({ key: 'nationalExam', label: 'National exam', ok: !!(pledge && pledge.nationalExam && pledge.nationalExam.passed), value: '' });
    if (p.chapterExam)  checks.push({ key: 'chapterExam',  label: 'Chapter exam',  ok: !!(pledge && pledge.chapterExam && pledge.chapterExam.passed), value: '' });
    return { checks: checks, ready: checks.every(function (c) { return c.ok; }), weeks: weeks, service: svc };
  }

  // ── Quorum ──

  function quorum(activeCount, kind, settings) {
    var q = withDefaults(settings).policy.quorum;
    var frac = kind === 'membership' ? q.membership : q.business;
    return Math.ceil(activeCount * frac);
  }

  global.OpsCore = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    PERMS: PERMS,
    DEFAULTS: DEFAULTS,
    withDefaults: withDefaults,
    values: values,
    sortByOrder: sortByOrder,
    nameKey: nameKey,
    rollKey: rollKey,
    money: money,
    esc: esc,
    toDate: toDate,
    ymd: ymd,
    fmtDate: fmtDate,
    daysBetween: daysBetween,
    permsFor: permsFor,
    legacyRole: legacyRole,
    isActiveStatus: isActiveStatus,
    isChargedStatus: isChargedStatus,
    upgradeUser: upgradeUser,
    computeDemerits: computeDemerits,
    demeritTimeline: demeritTimeline,
    freeAbsences: freeAbsences,
    excusedMap: excusedMap,
    eventStart: eventStart,
    excuseTiming: excuseTiming,
    weeklyDates: weeklyDates,
    weekOf: weekOf,
    computeStanding: computeStanding,
    buyoutFor: buyoutFor,
    serviceSummary: serviceSummary,
    lateFeeFor: lateFeeFor,
    ledgerSummary: ledgerSummary,
    pledgeReadiness: pledgeReadiness,
    quorum: quorum
  };
})(typeof window !== 'undefined' ? window : this);
