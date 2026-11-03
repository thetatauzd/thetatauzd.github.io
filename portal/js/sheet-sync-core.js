/**
 * SheetSyncCore: turns the Tracker sheet export (Gateway.gs `exportAll`, version 2) into the site's copy of
 * one term. Pure: no DOM, no Firebase. Needs ops-core.js (OpsCore). js/sheet-sync.js (PortalSync) writes
 * what this returns. Tests: portal/sync-tests.html, or `node scripts/sync-tests.js`.
 *
 * What it promises:
 *  - Keys come from content (event title, item + due date, date + reason, event + date), never from row
 *    numbers. The same sheet always gives the same copy, and a row deleted on the sheet is simply absent
 *    from the next copy.
 *  - It follows the sheet's own rules for a sheet-owned term, so site totals equal the sheet's
 *    DemeritDashboard (formulas checked 2026-11-02):
 *      rates and thresholds from Demerit_Rules; free absences only for Chapter Meeting; service hours
 *      required from Demerit_Rules (8) and no extra-hour credit; payment rows as they are (no late-fee
 *      ladder; demerits only for Unpaid and Late rows); on a recorded event a blank Attendance cell is an
 *      absence for a brother who is Active on the Roster; events on or after a brother's Inactive Since
 *      date are skipped; an approved excuse charges the excused rate.
 *    sheetPolicy holds those numbers; termSettings() lays them over the site settings.
 *  - It recomputes every brother's total with OpsCore and compares it with DemeritDashboard.
 *  - Unmatched names and the comparison are for the admin-only report. Nothing personal goes elsewhere, and
 *    Event_Info Notes are not copied (every member can read events/).
 *  - It never guesses who a row belongs to (makeMatcher): a row that could be two people is left out.
 *  - It refuses (nothing is written) an export that is missing a copied tab ('missing-tab') or whose dates
 *    belong to another semester ('wrong-term'), and copies a roll-over tab only for the term before.
 */
(function (global) {
  'use strict';

  var C = global.OpsCore;
  var EXPORT_VERSION = 2;

  /** Term nodes the copy replaces whole, in write order. */
  var NODES = ['events', 'attendance', 'myAttendance', 'excuseFlags', 'excuses', 'adjustments', 'rollover', 'service', 'ledger'];
  var NODE_LABELS = {
    events: 'Events', attendance: 'Attendance marks', myAttendance: 'Each brother\'s own attendance copy',
    excuseFlags: 'Excuse flags (no reasons)', excuses: 'Excuse requests', adjustments: 'Standards adjustments',
    rollover: 'Roll-over demerits', service: 'Service hours', ledger: 'Payments and fines'
  };
  /** How deep the records sit under nodeName/{term}: 1 = {id: record}, 2 = {a: {b: record}}. */
  var DEPTH = { events: 1, rollover: 1, attendance: 2, myAttendance: 2, excuseFlags: 2, excuses: 2, adjustments: 2, service: 2, ledger: 2 };
  /** Fields the runner stamps on every record. They are ignored when deciding whether a node changed. */
  var AUDIT = { createdBy: 1, createdByName: 1, createdAt: 1, markedBy: 1, markedAt: 1 };

  var REASON_MAX = 4000;   // excuses/$id .validate
  var HOURS_MAX = 200;     // service/$id .validate

  // ── Small helpers ──

  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
  function text(v) { return v === null || v === undefined ? '' : String(v).replace(/\s+/g, ' ').trim(); }
  function isBlank(v) { return text(v) === ''; }
  function isTrue(v) { return v === true || /^true$/i.test(text(v)); }
  function num(v) {
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    var n = parseFloat(text(v).replace(/[^0-9.\-]/g, ''));
    return isNaN(n) ? 0 : n;
  }
  function lower(v) { return text(v).toLowerCase(); }

  /** Value of the first header that matches one of `names` (case and spacing ignored). */
  function col(row, names) {
    if (!row) return undefined;
    var keys = Object.keys(row);
    for (var i = 0; i < names.length; i++) {
      var want = lower(names[i]);
      for (var k = 0; k < keys.length; k++) if (lower(keys[k]) === want) return row[keys[k]];
    }
    return undefined;
  }
  /** Value of the first header that contains a fragment ("S26 Service Rollover Demerits" → 'rollover'). */
  function colLike(row, frags) {
    if (!row) return undefined;
    var keys = Object.keys(row);
    for (var i = 0; i < frags.length; i++) {
      for (var k = 0; k < keys.length; k++) if (lower(keys[k]).indexOf(lower(frags[i])) !== -1) return row[keys[k]];
    }
    return undefined;
  }

  /** Sorted-key JSON, so two objects with the same content compare equal. */
  function canon(v) {
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    if (isObj(v)) return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + canon(v[k]); }).join(',') + '}';
    return JSON.stringify(v === undefined ? null : v);
  }

  /** What Firebase would store: no null or undefined values, no empty objects. */
  function normalize(v) {
    if (v === null || v === undefined) return undefined;
    if (Array.isArray(v)) { var a = v.map(normalize).filter(function (x) { return x !== undefined; }); return a.length ? a : undefined; }
    if (isObj(v)) {
      var out = {}, any = false;
      Object.keys(v).forEach(function (k) { var x = normalize(v[k]); if (x !== undefined) { out[k] = x; any = true; } });
      return any ? out : undefined;
    }
    if (typeof v === 'number' && !isFinite(v)) return undefined;
    return v;
  }

  /** The same value without the audit fields the runner stamps. */
  function strip(v) {
    if (Array.isArray(v)) return v.map(strip);
    if (!isObj(v)) return v;
    var out = {};
    Object.keys(v).forEach(function (k) { if (!AUDIT[k]) out[k] = strip(v[k]); });
    return out;
  }

  /** True when the stored node and the new copy hold the same facts (audit fields ignored). */
  function sameNode(a, b) { return canon(normalize(strip(a)) || null) === canon(normalize(strip(b)) || null); }

  /** Firebase-safe key from text. Never empty, never all digits (Firebase would turn the parent into an array). */
  function safeKey(s, max) {
    var k = C.nameKey(s).slice(0, max || 60).replace(/_+$/, '');
    if (!k) k = 'x';
    if (/^\d+$/.test(k)) k = 'n' + k;
    return k;
  }

  // ── Dates ──

  var MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function mkDate(y, m, d) {
    if (!(y > 1900 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return '';
    var dt = new Date(y, m - 1, d);
    if (dt.getMonth() !== m - 1) return '';
    return y + '-' + pad(m) + '-' + pad(d);
  }

  /**
   * 'YYYY-MM-DD' or ''. Accepts what the gateway and the sheet produce: 2026-09-10, 9/10/2026, Sep 10, 2026,
   * a Sheets day number, a Date, and the Service_Hours week labels ("Aug 16-22", "Aug 30-Sep 5"), which
   * take their first day and the term's year. Anything else is '' (never a guess).
   */
  function parseDate(v, year) {
    if (v === null || v === undefined || v === '') return '';
    if (v instanceof Date) return isNaN(v) ? '' : C.ymd(v);
    if (typeof v === 'number') {
      if (v > 20000 && v < 80000) { var b = new Date(1899, 11, 30); b.setDate(b.getDate() + Math.floor(v)); return C.ymd(b); }
      return '';
    }
    var s = text(v), m;
    if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return mkDate(+m[1], +m[2], +m[3]);
    if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/))) return mkDate(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[1], +m[2]);
    m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s*[-–]\s*(?:[A-Za-z]{3,9}\.?\s+)?\d{1,2})?(?:,?\s+(\d{4}))?$/);
    if (m) {
      var mon = MONTHS[m[1].slice(0, 3).toLowerCase()];
      var y = m[3] ? +m[3] : year;
      if (mon && y) return mkDate(y, mon, +m[2]);
    }
    return '';
  }
  function compact(ymd) { return ymd ? ymd.replace(/-/g, '') : 'nodate'; }

  /** 'F26' → 2026. */
  function termYear(term) { var m = String(term || '').match(/(\d{2})$/); return m ? 2000 + +m[1] : null; }
  /** The term before: F26 → S26, S27 → F26. */
  function prevTerm(term) {
    var m = String(term || '').toUpperCase().match(/^([FS])(\d{2})$/);
    if (!m) return '';
    return m[1] === 'F' ? 'S' + m[2] : 'F' + pad(+m[2] - 1);
  }

  // ── The export ──

  function tab(exp, names) {
    var tabs = (exp && exp.tabs) || {};
    for (var i = 0; i < names.length; i++) {
      var t = tabs[names[i]];
      if (t && (t.found !== false) && (t.rows || t.headers)) return { key: names[i], tab: t.tab || names[i], headers: t.headers || [], rows: t.rows || [] };
    }
    return { key: '', tab: '', headers: [], rows: [] };
  }

  /** Tabs whose rows become a copied node. The gateway sends each key with found: false when the tab is gone. */
  var COPIED_TABS = ['Attendance', 'Payments_Fines', 'Excuses', 'Standards_Adjustments', 'Service_Hours'];

  function listText(list) { return list.length < 2 ? list.join('') : list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1]; }

  /**
   * Is this export safe to copy? An old gateway (version 1: Config + Service_Log, no DemeritDashboard), an
   * empty Roster or a copied tab the sheet no longer has (renamed or deleted) would give a wrong or empty
   * copy, so the refresh stops before writing anything.
   */
  function checkExport(exp) {
    if (!exp || !exp.tabs) return { ok: false, code: 'empty', error: 'The gateway sent nothing back. Nothing was changed.' };
    var t = exp.tabs;
    if (!t.DemeritDashboard && !(exp.version >= EXPORT_VERSION)) {
      return { ok: false, code: 'old-gateway', error: 'The Tracker gateway is an old version (it does not send Demerit_Rules, Service_Hours or DemeritDashboard). ' +
        'Redeploy portal/apps-script/Gateway.gs as a new version of the existing deployment (see the README there), then try again. Nothing was changed.' };
    }
    if (!tab(exp, ['Roster']).rows.length) return { ok: false, code: 'no-roster', error: 'The sheet\'s Roster tab came back empty, so the copy would be empty. Nothing was changed.' };
    if (!tab(exp, ['Demerit_Rules', 'Config']).rows.length) return { ok: false, code: 'no-rules', error: 'The sheet\'s Demerit_Rules tab came back empty, so the site would not know the rates. Nothing was changed.' };
    if (!tab(exp, ['Event_Info']).rows.length) return { ok: false, code: 'no-events', error: 'The sheet\'s Event_Info tab came back empty. Nothing was changed.' };
    if (!tab(exp, ['DemeritDashboard', 'Dashboard']).rows.length) return { ok: false, code: 'no-dashboard', error: 'The sheet\'s DemeritDashboard tab came back empty, so the copy could not be checked. Nothing was changed.' };
    // Only a key that is present with found: false counts (the gateway looked and the tab was not there).
    var missing = COPIED_TABS.filter(function (k) { return t[k] && t[k].found === false; });
    if (missing.length) {
      return { ok: false, code: 'missing-tab', error: 'The sheet has no tab named ' + listText(missing) + ' (renamed or deleted?), so the copy would lose everything from ' +
        (missing.length === 1 ? 'it' : 'them') + '. Give the tab its old name back, then refresh again. Nothing was changed.' };
    }
    return { ok: true };
  }

  // ── Does the export belong to the term? ──

  var MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /** The months a term covers: F26 = Jul to Dec 2026, S27 = Jan to Jun 2027. null for a code that is not F## or S##. */
  function termWindow(term) {
    var m = String(term || '').toUpperCase().match(/^([FS])(\d{2})$/);
    if (!m) return null;
    var y = 2000 + +m[2];
    return m[1] === 'F' ? { from: y + '-07-01', to: y + '-12-31', label: 'Fall ' + y } : { from: y + '-01-01', to: y + '-06-30', label: 'Spring ' + y };
  }

  /**
   * The roll-over tab for the term before `term`. Gateways from 2026-11 send every roll-over tab in Rollovers:
   * take the one named for that term, else one with no term in its name, else the last (which the caller then
   * refuses with a note). Older gateways send only Rollover.
   */
  function pickRollover(tabs, term) {
    var list = tabs && tabs.Rollovers, want = prevTerm(term);
    if (Object.prototype.toString.call(list) === '[object Array]' && list.length) {
      var hit = null, bare = null;
      list.forEach(function (t) {
        var tt = tabTerm(t && t.tab);
        if (tt && tt === want && !hit) hit = t;
        if (!tt && !bare) bare = t;
      });
      return hit || bare || list[list.length - 1];
    }
    return tabs ? tabs.Rollover : null;
  }

  /** The term a tab name starts with: "S26 Rollover Demerits" or "Spring 2026 Rollover" → 'S26'. '' when none. */
  function tabTerm(name) {
    var s = text(name), m;
    if ((m = s.match(/^([FS])(\d{2})\b/i))) return m[1].toUpperCase() + m[2];
    if ((m = s.match(/^(spring|fall)\s*'?(?:20)?(\d{2})\b/i))) return m[1].charAt(0).toUpperCase() + m[2];
    return '';
  }

  /**
   * The refresh overwrites the site's term with whatever the sheet holds, so a sheet that has moved on to
   * another semester must not be copied. Uses the Event_Info dates that carry their own year (else the
   * Payments_Fines due dates). With at least 3 of them, more than half outside the term → { code: 'wrong-term' }.
   * An admin cannot copy it anyway.
   */
  function checkTerm(exp, term) {
    var w = termWindow(term);
    if (!w) return { ok: true };
    function datesOf(key, cols) {
      var out = [];
      tab(exp, [key]).rows.forEach(function (r) { var d = parseDate(col(r, cols)); if (d) out.push(d); });
      return out;
    }
    var dates = datesOf('Event_Info', ['Event Date', 'Date']);
    if (dates.length < 3) dates = datesOf('Payments_Fines', ['Due Date']);
    if (dates.length < 3) return { ok: true };
    var outside = dates.filter(function (d) { return d < w.from || d > w.to; });
    if (outside.length * 2 <= dates.length) return { ok: true };
    dates.sort();
    function month(d) { return MONTH_NAMES[+d.slice(5, 7) - 1] + ' ' + d.slice(0, 4); }
    var first = month(dates[0]), last = month(dates[dates.length - 1]);
    return { ok: false, code: 'wrong-term', error: 'The Tracker sheet\'s dates run ' + (first === last ? 'in ' + first : 'from ' + first + ' to ' + last) +
      ', but the site\'s term is ' + String(term).toUpperCase() + ' (' + w.label + '), so the sheet seems to hold another semester. Nothing was changed. ' +
      'If the chapter has moved on to a new semester, the site\'s current term has to move on first (see the semester checklist).' };
  }

  // ── Matching sheet names to portal accounts (the importer's rules, plus saved aliases) ──

  // The sheet's tabs spell names differently ("Tommy" on one tab, "Thomas" on the Roster, a middle name on a
  // third). After roll number, a saved alias and an exact name: the Roster's own spelling (linked through
  // its roll number), then first + last name with common nicknames.
  var NICKNAMES = { tommy: 'thomas', tom: 'thomas', zach: 'zachary', zack: 'zachary', abby: 'abigail', mike: 'michael', matt: 'matthew',
    sam: 'samantha', sami: 'samantha', chris: 'christopher', will: 'william', bill: 'william', nick: 'nicholas', alex: 'alexander',
    ben: 'benjamin', dan: 'daniel', danny: 'daniel', jake: 'jacob', josh: 'joshua', kate: 'katherine', katie: 'katherine', liz: 'elizabeth',
    maddie: 'madeleine', max: 'maxwell', nate: 'nathan', pat: 'patrick', rob: 'robert', bob: 'robert', greg: 'gregory', jon: 'jonathan' };
  var AMBIGUOUS = '\u0000two';

  function looseKey(name) {
    var parts = C.nameKey(name).split('_').filter(function (p) { return p && !/^(jr|sr|ii|iii|iv)$/.test(p) && p.length > 1; });
    if (parts.length < 2) return '';
    return (NICKNAMES[parts[0]] || parts[0]) + '_' + parts[parts.length - 1];
  }

  /** An account that can be matched: approved (a pending sign-up can type any name and roll). */
  function isMember(u) { return !!u && u.role !== 'pending' && u.status !== 'pending'; }

  /**
   * users: { uid: { name, rollNumber, role, status } }. rosterRows: the Roster tab. aliases: settings/sheetAliases,
   * { nameKey: { name, uid } | { name, ignore: true } }. → { match(name, roll) → { uid, how } }
   * how: roll | alias | name | roster | loose | ignored | ambiguous | none.
   *
   * A wrong match files one brother's excuse reasons and fines under another brother's account, which that
   * brother can read, so whenever two answers disagree the row is 'ambiguous' (left out, listed for the admin,
   * settled by a saved alias), never a guess:
   *  - Pending accounts are never matched.
   *  - A saved alias to an account comes first: it is the admin's own answer for that spelling.
   *  - A roll number comes next, unless the name points at a different account.
   *  - Then an 'ignore' alias, the exact name, the Roster's spelling and a loose first + last name. The last two
   *    only when no known roll number (the row's, or the Roster's for that name) contradicts the account's,
   *    and a loose name only when one Roster person has it.
   */
  function makeMatcher(users, rosterRows, aliases) {
    users = users || {}; aliases = aliases || {};
    var byRoll = {}, byName = {}, byLoose = {}, viaRoster = {}, members = {}, rosterRoll = {}, looseOwners = {};
    function add(map, k, uid) { if (!k) return; map[k] = map[k] && map[k] !== uid ? AMBIGUOUS : uid; }
    function get(map, k) { var v = k ? map[k] : null; return v && v !== AMBIGUOUS ? v : null; }
    function ambiguous(map, k) { return !!k && map[k] === AMBIGUOUS; }
    Object.keys(users).forEach(function (uid) {
      var u = users[uid] || {};
      if (!isMember(u)) return;
      members[uid] = true;
      add(byRoll, C.rollKey(u.rollNumber), uid);
      add(byName, C.nameKey(u.name), uid);
      add(byLoose, looseKey(u.name), uid);
    });
    (rosterRows || []).forEach(function (r) {
      var name = col(r, ['Brother Name', 'Name']), rr = C.rollKey(col(r, ['Roll Number', 'Roll #', 'Roll'])), uid = get(byRoll, rr);
      if (isBlank(name)) return;
      var rn = C.nameKey(name);
      if (rr && !rosterRoll[rn]) rosterRoll[rn] = rr;
      add(looseOwners, looseKey(name), rn);   // two Roster people with this first + last name: never guess
      if (!uid) return;
      add(viaRoster, rn, uid);
      add(viaRoster, looseKey(name), uid);
    });
    /** True when a known roll number for this row says it is not account uid. */
    function otherRoll(uid, rk, nk) {
      var want = rk || rosterRoll[nk], have = C.rollKey(users[uid] && users[uid].rollNumber);
      return !!(want && have && want !== have);
    }
    function match(name, roll) {
      var rk = C.rollKey(roll), nk = C.nameKey(name), lk = looseKey(name), uid;
      var al = (nk && aliases[nk]) || null;
      if (al && al.uid && members[al.uid]) return { uid: al.uid, how: 'alias' };
      if ((uid = get(byRoll, rk))) {
        var named = get(byName, nk) || get(viaRoster, nk) || get(byLoose, lk);
        if (!named || named === uid) return { uid: uid, how: 'roll' };
        // The roll number says one account and the name another: only a saved alias decides.
        return al && al.ignore ? { uid: null, how: 'ignored' } : { uid: null, how: 'ambiguous' };
      }
      if (al && al.ignore) return { uid: null, how: 'ignored' };
      if ((uid = get(byName, nk))) return { uid: uid, how: 'name' };
      var clash = false;
      if ((uid = get(viaRoster, nk))) { if (!otherRoll(uid, rk, nk)) return { uid: uid, how: 'roster' }; clash = true; }
      var loose = clash ? null : (get(viaRoster, lk) || get(byLoose, lk));
      if (loose && ambiguous(looseOwners, lk)) clash = true;
      else if (loose) { if (!otherRoll(loose, rk, nk)) return { uid: loose, how: 'loose' }; clash = true; }
      var two = clash || ambiguous(byRoll, rk) || ambiguous(byName, nk) || ambiguous(viaRoster, nk) || ambiguous(viaRoster, lk) || ambiguous(byLoose, lk);
      return { uid: null, how: two ? 'ambiguous' : 'none' };
    }
    return { match: match };
  }

  // ── The sheet's policy ──

  var STATUS_MAP = { active: 'active', inactive: 'inactive', 'co-op': 'coop', coop: 'coop', 'co op': 'coop', alumnus: 'alumnus', alumni: 'alumnus',
    alum: 'alumnus', graduated: 'graduated', pnm: 'pnm', pledge: 'pnm', abroad: 'abroad', 'study abroad': 'abroad' };

  function typeKeyFor(label, settings) {
    var l = lower(label);
    var types = (settings && settings.eventTypes) || C.DEFAULTS.eventTypes;
    var keys = Object.keys(types);
    for (var i = 0; i < keys.length; i++) if (lower(types[keys[i]] && types[keys[i]].label) === l) return keys[i];
    if (/voting/.test(l)) return 'voting';
    if (/chapter/.test(l)) return 'chapter';
    if (/rush/.test(l)) return 'rush';
    if (/initiation/.test(l)) return 'initiation';
    if (/philanthropy/.test(l)) return 'philanthropy';
    if (/committee/.test(l)) return 'committee';
    if (/pledge/.test(l)) return 'pledge';
    if (l === 'other') return 'other';
    return 't_' + safeKey(label, 40);
  }

  var SETTING_PATHS = {
    'warning threshold': ['warningThreshold'],
    'bad standing threshold': ['badStandingThreshold'],
    'service hours required': ['service', 'hoursRequired'],
    'service events required': ['service', 'eventsRequired'],
    'demerits per hour short': ['service', 'perHourShort'],
    'demerits per event short': ['service', 'perEventShort'],
    'buy-out base amount': ['buyout', 'base'],
    'buy-out base demerits': ['buyout', 'baseDemerits'],
    'buy-out step amount': ['buyout', 'step'],
    'buy-out step demerits': ['buyout', 'stepDemerits'],
    'buy-out cap': ['buyout', 'cap']
  };

  /**
   * Demerit_Rules → { policy: { term, eventTypes, policy }, labelToKey }. Only numbers. The sheet's dashboard
   * applies free absences to Chapter Meeting only and gives no extra-hour credit, so the policy says so too.
   */
  function readPolicy(rows, term, settings, warn) {
    var types = {}, labelToKey = {}, policy = { service: { extraHourErases: 0 }, buyout: {} }, extra = 0;
    rows.forEach(function (r) {
      var label = text(col(r, ['Event Type']));
      if (label && !labelToKey[label.toLowerCase()]) {
        var k = typeKeyFor(label, settings);
        if (types[k]) k = 't_' + safeKey(label, 40);
        var free = num(col(r, ['Free Absences Per Semester', 'Free Absences']));
        var def = { unexcused: num(col(r, ['Unexcused Demerits', 'Unexcused'])), excused: num(col(r, ['Excused Demerits', 'Excused'])), freePerTerm: k === 'chapter' ? free : 0 };
        if (k !== 'chapter' && free) warn('Demerit_Rules gives "' + label + '" ' + free + ' free absences, but the sheet\'s dashboard only applies free absences to Chapter Meeting, so the site does the same.');
        if (k === 'chapter' && def.excused) warn('Demerit_Rules charges ' + def.excused + ' for an excused Chapter Meeting. The sheet\'s dashboard counts that oddly (it divides by the unexcused rate), so totals may differ.');
        var src = text(col(r, ['Source']));
        if (src) def.source = src.slice(0, 300);
        if (!C.DEFAULTS.eventTypes[k]) { def.label = label.slice(0, 60); def.order = 40 + (++extra); }
        types[k] = def;
        labelToKey[label.toLowerCase()] = k;
      }
      var setting = lower(col(r, ['Setting'])), value = col(r, ['Value']);
      var path = SETTING_PATHS[setting];
      if (path && !isBlank(value)) {
        if (path.length === 1) policy[path[0]] = num(value);
        else policy[path[0]][path[1]] = num(value);
      }
    });
    return { policy: { term: term, eventTypes: types, policy: policy }, labelToKey: labelToKey };
  }

  /** Deep merge `src` over `dst` (src wins, null skipped). */
  function overlay(dst, src) {
    Object.keys(src || {}).forEach(function (k) {
      if (src[k] === undefined || src[k] === null) return;
      if (isObj(src[k]) && isObj(dst[k])) overlay(dst[k], src[k]);
      else dst[k] = clone(src[k]);
    });
    return dst;
  }

  /**
   * Settings to compute a sheet-owned term with: the site settings with the sheet's policy laid over them.
   * sheetPolicy = settings/sheetPolicy ({ term, eventTypes, policy }). Applies only to its own term.
   */
  function termSettings(settings, sheetPolicy, term) {
    var out = C.withDefaults(settings || {});
    if (!sheetPolicy || (term && sheetPolicy.term && sheetPolicy.term !== term)) return out;
    overlay(out.eventTypes, sheetPolicy.eventTypes);
    overlay(out.policy, sheetPolicy.policy);
    return out;
  }

  // ── Keys ──

  /**
   * Give each item a key from its content: base, then base_2, base_3 for true duplicates, in the order of
   * their content (not their row), so moving rows around never changes a key.
   */
  function keyed(items, baseOf) {
    var groups = {}, out = [];
    items.forEach(function (it) { var b = baseOf(it); (groups[b] = groups[b] || []).push(it); });
    Object.keys(groups).forEach(function (b) {
      var g = groups[b].map(function (it) { return { it: it, c: canon(it.rec) }; });
      g.sort(function (x, y) { return x.c < y.c ? -1 : (x.c > y.c ? 1 : 0); });
      g.forEach(function (x, i) { out.push({ key: i ? b + '_' + (i + 1) : b, it: x.it }); });
    });
    return out;
  }

  // ── Build ──

  /**
   * The whole copy for one term.
   * exp: the gateway export. ctx: { term, users, aliases, settings (site settings), asOf }.
   * → { term, nodes: {events…ledger}, sheetPolicy, counts, unmatched, ignored, rosterDiffs,
   *     comparison: { compared, matching, mismatches, notCompared, service }, warnings, exportedAt,
   *     rolloverTab (the sheet tab the roll-over came from, '' when none was copied) }
   * Throws when the export is not safe to copy (see checkExport and checkTerm); err.code says why.
   */
  function build(exp, ctx) {
    ctx = ctx || {};
    var ok = checkExport(exp);
    if (!ok.ok) { var e = new Error(ok.error); e.code = ok.code; throw e; }
    var term = String(ctx.term || '').toUpperCase();
    if (!/^[A-Z0-9_-]{1,12}$/.test(term)) { var te = new Error('Pick a term code like F26 first.'); te.code = 'term'; throw te; }
    var fits = checkTerm(exp, term);
    if (!fits.ok) { var we = new Error(fits.error); we.code = fits.code; throw we; }
    var users = ctx.users || {}, aliases = ctx.aliases || {};
    var asOf = C.toDate(ctx.asOf) || new Date();
    var year = termYear(term) || asOf.getFullYear();
    var warnings = [];
    function warn(msg) { if (warnings.length < 200 && warnings.indexOf(msg) === -1) warnings.push(msg); }

    var nodes = {};
    NODES.forEach(function (n) { nodes[n] = {}; });

    // People
    var rosterT = tab(exp, ['Roster']);
    var matcher = makeMatcher(users, rosterT.rows, aliases);
    var people = {};     // nameKey → { name, roll, missed: {tab: true}, hasData, ambiguous, ignored }: rows that matched no account
    var clash = {};      // uid → true: two Roster rows landed on this account, so this run matches it only through an alias
    function who(tabName, name, roll, hasData) {
      var nk = C.nameKey(name);
      if (!nk) return null;
      var m = matcher.match(name, roll);
      if (m.uid && clash[m.uid] && m.how !== 'alias') m = aliases[nk] && aliases[nk].ignore ? { uid: null, how: 'ignored' } : { uid: null, how: 'ambiguous' };
      if (m.uid) return m.uid;
      var p = people[nk] || (people[nk] = { name: text(name), roll: '', missed: {}, hasData: false, ambiguous: false, ignored: false });
      if (!p.roll && C.rollKey(roll)) p.roll = C.rollKey(roll);
      p.missed[tabName] = true;
      if (hasData) p.hasData = true;
      if (m.how === 'ambiguous') p.ambiguous = true;
      if (m.how === 'ignored') p.ignored = true;
      return null;
    }

    var roster = {};     // nameKey → { name, roll, status, active, inactiveSince }
    var rosterUids = {};
    rosterT.rows.forEach(function (r) {
      var name = text(col(r, ['Brother Name', 'Name']));
      if (!name) return;
      var roll = C.rollKey(col(r, ['Roll Number', 'Roll #', 'Roll']));
      var status = text(col(r, ['Status']));
      var nk = C.nameKey(name);
      if (roster[nk]) { warn('The Roster lists "' + name + '" twice. The sheet uses the first row.'); return; }
      roster[nk] = { name: name, roll: roll, status: status, active: /^active$/i.test(status), inactiveSince: parseDate(col(r, ['Inactive Since']), year) };
      var uid = who('Roster', name, roll, false);
      if (uid) {
        if (rosterUids[uid]) {
          // Two people on the Roster cannot share one account: copying either could file one brother's rows under the other.
          warn('Roster rows "' + rosterUids[uid] + '" and "' + name + '" both match the same portal account, so neither is copied (unless a name match is saved for it). Check their roll numbers on the Roster and on User Management, or pick an account for each under "Names the site could not match".');
          clash[uid] = true;
        } else rosterUids[uid] = name;
        roster[nk].uid = uid;
      }
    });
    // Rows matched before the clash was seen: match them again, so they too are left out and listed.
    Object.keys(roster).forEach(function (nk) {
      var rr = roster[nk];
      if (!rr.uid || !clash[rr.uid]) return;
      var again = who('Roster', rr.name, rr.roll, false);
      if (again) rr.uid = again; else delete rr.uid;
    });

    // Policy
    var pol = readPolicy(tab(exp, ['Demerit_Rules', 'Config']).rows, term, ctx.settings, warn);
    var sheetPolicy = pol.policy;
    function unrated() {
      if (!sheetPolicy.eventTypes.sheet_unrated) sheetPolicy.eventTypes.sheet_unrated = { label: 'Not on Demerit_Rules', order: 99, unexcused: 0, excused: 0, freePerTerm: 0 };
      return 'sheet_unrated';
    }

    // Events
    var eventByTitle = {}, usedKeys = {};
    tab(exp, ['Event_Info']).rows.forEach(function (r) {
      var title = text(col(r, ['Event Title', 'Title']));
      if (!title) return;
      var t = title.toLowerCase();
      if (eventByTitle[t]) { warn('Event_Info lists "' + title + '" twice. The sheet uses the first row, and so does the site.'); return; }
      var base = safeKey(title), key = base, n = 1;
      while (usedKeys[key]) key = base + '_' + (++n);
      usedKeys[key] = true;
      var typeLabel = text(col(r, ['Event Type', 'Type']));
      var type = pol.labelToKey[typeLabel.toLowerCase()];
      if (!type) { type = unrated(); warn('Event "' + title + '" has type "' + (typeLabel || 'blank') + '", which is not on Demerit_Rules. The sheet charges nothing for it, and so does the site.'); }
      var def = sheetPolicy.eventTypes[type];
      var su = col(r, ['Unexcused Demerits']), se = col(r, ['Excused Demerits']);
      if ((!isBlank(su) && num(su) !== def.unexcused) || (!isBlank(se) && num(se) !== def.excused)) {
        warn('Event "' + title + '" shows ' + num(su) + ' / ' + num(se) + ' demerits on Event_Info but Demerit_Rules says ' + def.unexcused + ' / ' + def.excused + ' for ' + (typeLabel || 'its type') + '. The site uses Demerit_Rules.');
      }
      var ev = { title: title.slice(0, 120), type: type, recorded: isTrue(col(r, ['Attendance Recorded', 'Recorded'])), source: 'sheet' };
      var date = parseDate(col(r, ['Event Date', 'Date']), year);
      if (date) ev.date = date;
      else if (!isBlank(col(r, ['Event Date', 'Date']))) warn('Event "' + title + '" has a date the site cannot read: "' + text(col(r, ['Event Date', 'Date'])) + '".');
      if (typeLabel) ev.sheetType = typeLabel.slice(0, 60);
      // Event_Info Notes stay on the sheet: every member can read events/{term}, and officers' notes there can name people.
      nodes.events[key] = ev;
      eventByTitle[t] = { key: key, ev: ev };
    });

    // Attendance: the sheet's Attendance_Demerits formula, cell by cell.
    var attT = tab(exp, ['Attendance']);
    var eventCols = (attT.headers || []).filter(function (h) { return text(h) && !/^brother name$|^name$|^roll/i.test(text(h)); });
    var attOwner = {};
    attT.rows.forEach(function (r) {
      var name = text(col(r, ['Brother Name', 'Name']));
      if (!name) return;
      var ro = roster[C.nameKey(name)] || null;
      var marks = [];
      eventCols.forEach(function (h) {
        var hit = eventByTitle[text(h).toLowerCase()];
        if (!hit || !hit.ev.recorded) return;
        if (ro && ro.inactiveSince && hit.ev.date && hit.ev.date >= ro.inactiveSince) return;
        var v = r[h], present;
        if (isBlank(v)) {
          if (!(ro && ro.active)) return;            // not Active on the Roster: no mark, not on roll call
          present = false;                           // the sheet counts a blank as absent
        } else {
          present = isTrue(v);
          if (!present && !(v === false || /^false$/i.test(text(v)))) warn('Attendance for "' + name + '" at "' + h + '" says "' + text(v) + '". The sheet counts anything but TRUE as absent, and so does the site.');
        }
        marks.push({ key: hit.key, present: present });
      });
      var uid = who('Attendance', name, ro && ro.roll, marks.length > 0);
      if (!uid || !marks.length) return;
      if (attOwner[uid]) warn('Attendance rows "' + attOwner[uid] + '" and "' + name + '" both match the same portal account. The later row wins.');
      attOwner[uid] = name;
      marks.forEach(function (m) {
        (nodes.attendance[m.key] = nodes.attendance[m.key] || {})[uid] = { present: m.present };
        (nodes.myAttendance[uid] = nodes.myAttendance[uid] || {})[m.key] = { present: m.present };
      });
    });

    // Excuses (reasons stay behind the excuses rules: the brother, Standards and admins)
    var excuseItems = [], flagRank = { approved: 3, pending: 2, denied: 1 };
    tab(exp, ['Excuses']).rows.forEach(function (r) {
      var name = text(col(r, ['Brother Name', 'Name']));
      if (!name) return;
      var uid = who('Excuses', name, col(r, ['Roll Number']), true);
      if (!uid) return;
      var title = text(col(r, ['Event Title', 'Event']));
      var raw = lower(col(r, ['Excuse Status', 'Status']));
      var status = raw === 'approved' ? 'approved' : (raw === 'denied' ? 'denied' : 'pending');
      var hit = eventByTitle[title.toLowerCase()];
      var rec = { kind: 'absent', status: status, source: 'sheet', lateSubmission: false, afterEvent: false };
      if (hit) rec.eventId = hit.key;
      else { rec.eventText = (title || 'Not given').slice(0, 120); warn('An excuse names the event "' + (title || 'blank') + '", which is not on Event_Info. It cannot excuse an absence on the sheet or on the site.'); }
      var reason = text(col(r, ['Reason / Notes', 'Reason', 'Notes']));
      if (reason.length > REASON_MAX) { reason = reason.slice(0, REASON_MAX); warn('An excuse reason was longer than ' + REASON_MAX + ' characters and was shortened in the copy.'); }
      if (reason) rec.reason = reason;
      var by = text(col(r, ['Approved By', 'Reviewed By']));
      if (by) rec.reviewedByName = by.slice(0, 80);
      excuseItems.push({ uid: uid, rec: rec });
      if (hit) {
        var fl = nodes.excuseFlags[hit.key] = nodes.excuseFlags[hit.key] || {};
        if (!fl[uid] || flagRank[status] > flagRank[fl[uid]]) fl[uid] = status;
      }
    });
    keyed(excuseItems, function (it) { return it.uid + '|x_' + (it.rec.eventId || safeKey(it.rec.eventText, 40)); }).forEach(function (k) {
      (nodes.excuses[k.it.uid] = nodes.excuses[k.it.uid] || {})[k.key.split('|')[1]] = k.it.rec;
    });

    // Standards adjustments
    var adjItems = [];
    tab(exp, ['Standards_Adjustments']).rows.forEach(function (r) {
      var name = text(col(r, ['Brother Name', 'Name']));
      if (!name) return;
      var change = col(r, ['Demerit Change', 'Change', 'Points']);
      var reason = text(col(r, ['Reason']));
      if (isBlank(change) && !reason) return;
      var uid = who('Standards_Adjustments', name, col(r, ['Roll Number']), true);
      if (!uid) return;
      var rec = { points: num(change), reason: (reason || 'Adjustment').slice(0, 300), source: 'sheet' };
      var date = parseDate(col(r, ['Date']), year);
      if (date) rec.date = date;
      var by = text(col(r, ['Entered By']));
      if (by) rec.enteredBy = by.slice(0, 80);
      var note = text(col(r, ['Notes']));
      if (note) rec.note = note.slice(0, 500);
      adjItems.push({ uid: uid, rec: rec });
    });
    keyed(adjItems, function (it) { return it.uid + '|sa_' + compact(it.rec.date) + '_' + safeKey(it.rec.reason, 40); }).forEach(function (k) {
      (nodes.adjustments[k.it.uid] = nodes.adjustments[k.it.uid] || {})[k.key.split('|')[1]] = k.it.rec;
    });

    // Roll-over (the sheet takes the first row for a name). Only a tab for the term before this one is copied.
    var ro = pickRollover(exp.tabs, term), rolloverTab = '';
    if (ro && ro.found !== false && ro.rows) {
      var roName = text(ro.tab) || 'Rollover', roTerm = tabTerm(ro.tab), carryFrom = prevTerm(term);
      if (roTerm && carryFrom && roTerm !== carryFrom) {
        warn('The roll-over tab "' + roName + '" is for ' + roTerm + ', but ' + term + ' carries demerits in from ' + carryFrom + ', so the tab was not copied. ' +
          'Rename it, or remove the tab that does not belong to this term.');
      } else {
        rolloverTab = roName;
        var fromTerm = roTerm || carryFrom;
        ro.rows.forEach(function (r) {
          var name = text(col(r, ['Name', 'Brother Name']));
          if (!name) return;
          var uid = who('Rollover', name, col(r, ['Roll Number', 'Roll']), true);
          if (!uid) return;
          if (nodes.rollover[uid]) { warn('The roll-over tab lists "' + name + '" twice. The sheet uses the first row.'); return; }
          var rec = { points: num(col(r, ['Demerits', 'Points'])), source: 'sheet', note: 'From the sheet tab "' + roName + '"' };
          if (fromTerm) rec.from = fromTerm.toUpperCase();
          nodes.rollover[uid] = rec;
        });
      }
    }

    // Service hours (each row as it is; Confirmed TRUE = approved)
    var svcItems = [];
    tab(exp, ['Service_Hours', 'Service_Log']).rows.forEach(function (r) {
      var name = text(col(r, ['Brother Name', 'Name']));
      if (!name) return;
      var uid = who('Service_Hours', name, col(r, ['Roll Number']), true);
      if (!uid) return;
      var event = text(col(r, ['Event', 'Event Title', 'Event Name'])) || 'Service';
      var hours = num(col(r, ['Hours', 'Service Hours']));
      if (hours < 0 || hours > HOURS_MAX) { warn('Service row "' + event + '" for "' + name + '" has ' + hours + ' hours. The site only stores 0 to ' + HOURS_MAX + ', so it was left out.'); return; }
      var rawDate = col(r, ['Date', 'Week']);
      var rec = { eventName: event.slice(0, 120), hours: hours, status: isTrue(col(r, ['Confirmed', 'Approved'])) ? 'approved' : 'pending', countsAsEvent: true, source: 'sheet' };
      var date = parseDate(rawDate, year);
      if (date) { rec.date = date; rec.week = C.weekOf(date); }
      if (!isBlank(rawDate) && !/^\d{4}-\d{2}-\d{2}$/.test(text(rawDate))) rec.dateText = text(rawDate).slice(0, 40);
      svcItems.push({ uid: uid, rec: rec });
    });
    keyed(svcItems, function (it) { return it.uid + '|sv_' + compact(it.rec.date) + '_' + safeKey(it.rec.eventName, 40); }).forEach(function (k) {
      (nodes.service[k.it.uid] = nodes.service[k.it.uid] || {})[k.key.split('|')[1]] = k.it.rec;
    });

    // Payments and fines: each row as it is. No late-fee ladder; demerits only for Unpaid and Late, like the sheet.
    var payItems = [], asOfYmd = C.ymd(asOf), grace = C.withDefaults(ctx.settings || {}).policy.dues.graceDays || 0;
    tab(exp, ['Payments_Fines']).rows.forEach(function (r) {
      var name = text(col(r, ['Brother Name', 'Name']));
      if (!name) return;
      var uid = who('Payments_Fines', name, col(r, ['Roll Number']), true);
      if (!uid) return;
      var item = text(col(r, ['Item', 'Item / Fine', 'Fine'])) || 'Charge';
      var statusText = text(col(r, ['Payment Status', 'Status']));
      var st = statusText.toLowerCase();
      var due = parseDate(col(r, ['Due Date']), year);
      var paidOn = parseDate(col(r, ['Date Paid']), year);
      var dem = num(col(r, ['Demerits If Unpaid/Late', 'Demerits If Unpaid', 'Demerits']));
      var counts = st === 'unpaid' || st === 'late';
      if (dem && !counts && st !== 'paid' && st !== 'waived' && st !== 'payment plan') warn('Payment "' + item + '" for "' + name + '" has status "' + (statusText || 'blank') + '". The sheet only charges demerits for Unpaid and Late, so the site charges none for it.');
      if (dem && counts && (!due || C.daysBetween(due, asOfYmd) <= grace)) warn('Payment "' + item + '" for "' + name + '" is ' + statusText + ' with ' + dem + ' demerits. The sheet counts them now; the site counts them only once the due date has passed' + (due ? '' : ', and this row has no due date') + '.');
      var rec = { type: 'charge', item: item.slice(0, 120), amount: num(col(r, ['Amount', 'Amount Owed'])), accruesLate: false, demeritsIfLate: counts ? dem : 0, sheetStatus: (statusText || 'Unpaid').slice(0, 40), source: 'sheet' };
      if (due) { rec.dueDate = due; rec.date = due; }
      var note = text(col(r, ['Notes']));
      if (note) rec.note = note.slice(0, 500);
      payItems.push({ uid: uid, rec: rec, st: st, paidOn: paidOn });
    });
    keyed(payItems, function (it) { return it.uid + '|sh_' + safeKey(it.rec.item, 40) + '_' + compact(it.rec.dueDate); }).forEach(function (k) {
      var uid = k.it.uid, id = k.key.split('|')[1], rec = k.it.rec, led = nodes.ledger[uid] = nodes.ledger[uid] || {};
      led[id] = rec;
      var when = k.it.paidOn || rec.dueDate;
      if (k.it.st === 'paid') led[id + '_pay'] = { type: 'payment', item: rec.item, chargeId: id, amount: rec.amount, date: when, method: 'sheet', note: 'Paid (from the sheet)', source: 'sheet' };
      else if (k.it.st === 'waived') led[id + '_waive'] = { type: 'waiver', item: rec.item, chargeId: id, amount: rec.amount, date: when, note: 'Waived (from the sheet)', source: 'sheet' };
      else if (k.it.st === 'payment plan' || k.it.st === 'plan') led[id + '_plan'] = { type: 'plan', item: rec.item, chargeId: id, date: rec.dueDate, note: 'Payment plan (from the sheet)', source: 'sheet' };
    });

    NODES.forEach(function (n) { nodes[n] = normalize(nodes[n]) || {}; });
    sheetPolicy = normalize(sheetPolicy);

    // Compare with the sheet's own DemeritDashboard.
    var settingsForTerm = termSettings(ctx.settings, sheetPolicy, term);
    var comparison = compare(tab(exp, ['DemeritDashboard', 'Dashboard']).rows, nodes, settingsForTerm, asOf, function (name, roll) { return who('DemeritDashboard', name, roll, true); });

    // Roster status against the portal (fixed on User Management, never by the copy).
    var rosterDiffs = [];
    Object.keys(roster).forEach(function (nk) {
      var rr = roster[nk];
      if (!rr.uid) return;
      var want = STATUS_MAP[lower(rr.status)] || '';
      var have = (users[rr.uid] && users[rr.uid].status) || 'active';
      if (want && want !== have) rosterDiffs.push({ uid: rr.uid, name: rr.name, sheet: rr.status, site: have });
    });
    Object.keys(users).forEach(function (uid) {
      var u = users[uid] || {};
      if (rosterUids[uid] || u.role === 'pending' || (u.status || 'active') !== 'active') return;
      rosterDiffs.push({ uid: uid, name: u.name || '', sheet: '', site: 'active' });
    });
    rosterDiffs.sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });

    var unmatched = [], ignored = [];
    Object.keys(people).forEach(function (nk) {
      var p = people[nk];
      if (p.ignored) { ignored.push({ key: nk, name: p.name }); return; }
      var row = { key: nk, name: p.name, roll: p.roll, tabs: Object.keys(p.missed).sort(), hasData: p.hasData };
      if (p.ambiguous) row.ambiguous = true;
      unmatched.push(row);
    });
    unmatched.sort(function (a, b) { return (b.hasData - a.hasData) || a.name.localeCompare(b.name); });
    ignored.sort(function (a, b) { return a.name.localeCompare(b.name); });

    var counts = {};
    NODES.forEach(function (n) { counts[n] = countNode(n, nodes[n]); });

    return {
      term: term, nodes: nodes, sheetPolicy: sheetPolicy, counts: counts,
      unmatched: unmatched, ignored: ignored, rosterDiffs: rosterDiffs, comparison: comparison,
      warnings: warnings, exportedAt: text(exp.exportedAt), exportVersion: exp.version || 1, rolloverTab: rolloverTab
    };
  }

  // ── The comparison ──

  function close(a, b) { return Math.abs((Number(a) || 0) - (Number(b) || 0)) < 0.001; }

  /** One brother's facts out of the copied nodes, in the shape OpsCore.computeDemerits takes. */
  function factsFor(uid, nodes) {
    var excusedEvents = {};
    Object.keys(nodes.excuseFlags || {}).forEach(function (eid) { if ((nodes.excuseFlags[eid] || {})[uid] === 'approved') excusedEvents[eid] = true; });
    return clone({
      events: nodes.events || {}, attendance: nodes.attendance || {}, excusedEvents: excusedEvents,
      excuses: (nodes.excuses || {})[uid] || {}, adjustments: (nodes.adjustments || {})[uid] || {},
      rollover: (nodes.rollover || {})[uid] || null, ledger: (nodes.ledger || {})[uid] || {}, service: (nodes.service || {})[uid] || {}
    });
  }

  /**
   * Every DemeritDashboard row against the site's own computation from the copy.
   * → { compared, matching, mismatches: [{ uid, name, sheet, site, parts }], notCompared: [{ name, roll }],
   *     service: [{ uid, name, sheet: { hours, events }, site: { hours, events } }] }
   */
  function compare(dashRows, nodes, settings, asOf, uidOf) {
    var out = { compared: 0, matching: 0, mismatches: [], notCompared: [], service: [] };
    var seen = {};
    (dashRows || []).forEach(function (r) {
      var name = text(col(r, ['Brother Name', 'Name']));
      if (!name) return;
      var roll = C.rollKey(col(r, ['Roll Number', 'Roll']));
      var uid = uidOf(name, roll);
      if (!uid) { out.notCompared.push({ name: name, roll: roll }); return; }
      if (seen[uid]) return;
      seen[uid] = true;
      var d = C.computeDemerits(uid, factsFor(uid, nodes), settings, { asOf: asOf });
      var sheet = {
        total: num(col(r, ['Total Demerits', 'Total'])), rollover: num(colLike(r, ['rollover'])), attendance: num(col(r, ['Attendance Demerits'])),
        payment: num(col(r, ['Payment/Fine Demerits', 'Payment Demerits'])), standards: num(col(r, ['Standards Adjustments', 'Standards']))
      };
      var site = { total: d.total, rollover: d.rolloverPoints, attendance: d.attendanceDemerits, payment: d.paymentDemerits, standards: d.adjustmentsTotal };
      if (d.serviceCredit) site.serviceCredit = d.serviceCredit;
      out.compared++;
      var parts = ['rollover', 'attendance', 'payment', 'standards'].filter(function (p) { return !close(sheet[p], site[p]); });
      if (d.serviceCredit) parts.push('serviceCredit');
      if (close(sheet.total, site.total) && !parts.length) out.matching++;
      else out.mismatches.push({ uid: uid, name: name, roll: roll, sheet: sheet, site: site, parts: parts.length ? parts : ['total'] });
      var sh = col(r, ['Service Hours']), se = col(r, ['Service Events']);
      if (!isBlank(sh) || !isBlank(se)) {
        var s = d.service || {};
        if (!close(num(sh), s.approvedHours) || !close(num(se), s.distinctEvents)) {
          out.service.push({ uid: uid, name: name, sheet: { hours: num(sh), events: num(se) }, site: { hours: s.approvedHours || 0, events: s.distinctEvents || 0 } });
        }
      }
    });
    out.mismatches.sort(function (a, b) { return a.name.localeCompare(b.name); });
    return out;
  }

  // ── For the runner ──

  /** How many records a node holds (events: events; attendance: marks; ledger: entries …). */
  function countNode(name, v) {
    if (!isObj(v)) return 0;
    if ((DEPTH[name] || 1) === 1) return Object.keys(v).length;
    var n = 0;
    Object.keys(v).forEach(function (k) { if (isObj(v[k])) n += Object.keys(v[k]).length; });
    return n;
  }

  /**
   * Nodes the new copy would shrink to less than half (from 20 records or more), or empty (from any number;
   * the roll-over tab, for one, simply goes missing from the export when it is renamed). A half-empty export
   * is far more likely than half the term vanishing from the sheet, so the runner asks before writing those.
   */
  function guard(before, after) {
    var out = [];
    NODES.forEach(function (n) {
      var b = (before && before[n]) || 0, a = (after && after[n]) || 0;
      if ((b >= 20 && a < b / 2) || (b > 0 && a === 0)) out.push({ node: n, label: NODE_LABELS[n], before: b, after: a });
    });
    return out;
  }

  /** The copy with audit fields: who made the copy and when (records keep the sheet's own facts unchanged). */
  function stamp(nodes, profile, iso) {
    var out = clone(nodes) || {};
    var by = (profile && profile.uid) || '', byName = (profile && (profile.name || profile.email)) || '';
    function rec(r) { if (isObj(r)) { r.createdBy = by; r.createdByName = byName; r.createdAt = iso; } }
    function mark(m) { if (isObj(m)) { m.markedBy = by; m.markedAt = iso; } }
    function each(obj, depth, fn) {
      Object.keys(obj || {}).forEach(function (k) { if (depth === 1) fn(obj[k]); else each(obj[k], depth - 1, fn); });
    }
    each(out.events, 1, rec);
    each(out.rollover, 1, rec);
    ['excuses', 'adjustments', 'service', 'ledger'].forEach(function (n) { each(out[n], 2, rec); });
    each(out.attendance, 2, mark);
    each(out.myAttendance, 2, mark);
    return out;
  }

  global.SheetSyncCore = {
    EXPORT_VERSION: EXPORT_VERSION,
    NODES: NODES,
    NODE_LABELS: NODE_LABELS,
    COPIED_TABS: COPIED_TABS,
    build: build,
    checkExport: checkExport,
    checkTerm: checkTerm,
    termWindow: termWindow,
    tabTerm: tabTerm,
    pickRollover: pickRollover,
    makeMatcher: makeMatcher,
    looseKey: looseKey,
    parseDate: parseDate,
    termYear: termYear,
    prevTerm: prevTerm,
    termSettings: termSettings,
    compare: compare,
    factsFor: factsFor,
    countNode: countNode,
    guard: guard,
    stamp: stamp,
    strip: strip,
    normalize: normalize,
    sameNode: sameNode,
    canon: canon,
    safeKey: safeKey
  };
})(typeof window !== 'undefined' ? window : this);
