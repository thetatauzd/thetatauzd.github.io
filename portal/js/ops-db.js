/**
 * PortalOps — Firebase glue for chapter operations. Depends on ops-core.js,
 * firebase-config.js and auth.js. Pages call these; all math lives in OpsCore.
 *
 * Node layout is documented in portal/docs/ops-schema.md.
 */
(function (global) {
  'use strict';

  var db = firebase.database();
  var C = global.OpsCore;
  var settingsCache = null;
  var termCache = null;

  // ── Settings & term ──

  /** Full settings (stored values over defaults). Cached per page load unless force. */
  function loadSettings(force) {
    if (settingsCache && !force) return Promise.resolve(settingsCache);
    return db.ref('settings').once('value').then(function (s) {
      var v = s.val() || {};
      termCache = v.currentTerm || null;
      settingsCache = C.withDefaults({ positions: v.positions, statuses: v.statuses, eventTypes: v.eventTypes, policy: v.policy });
      settingsCache.currentTerm = termCache || guessTerm();
      return settingsCache;
    });
  }
  function guessTerm() {
    var d = new Date();
    return (d.getMonth() >= 6 ? 'F' : 'S') + String(d.getFullYear()).slice(2);
  }
  function currentTerm() { return termCache || (settingsCache && settingsCache.currentTerm) || guessTerm(); }

  /** Write one settings group (positions|statuses|eventTypes|policy) with a history row. */
  function saveSettings(group, value, profile, note) {
    return db.ref('settings/' + group).once('value').then(function (s) {
      var before = s.val();
      var updates = {};
      updates['settings/' + group] = value;
      updates['settings/history/' + db.ref().push().key] = {
        group: group, before: before == null ? null : before, after: value,
        changedBy: profile.uid, changedByName: profile.name || profile.email || '', changedAt: new Date().toISOString(), note: note || ''
      };
      return db.ref().update(updates);
    }).then(function () { settingsCache = null; });
  }

  // ── Audit helpers ──

  function audit(profile) {
    return { createdBy: profile.uid, createdByName: profile.name || profile.email || '', createdAt: new Date().toISOString() };
  }
  function logChange(term, type, where, detail, profile) {
    return db.ref('changeLog/' + term).push({ type: type, where: where, detail: detail, by: profile.uid, byName: profile.name || '', at: new Date().toISOString() }).catch(function () {});
  }

  // ── People ──

  /** Everyone, keyed by uid (officers only — rules gate this). */
  function loadUsers() { return db.ref('users').once('value').then(function (s) { return s.val() || {}; }); }
  /** Names/roll/status/positions for every non-pending member; readable by any member. */
  function loadDirectory() { return db.ref('directory').once('value').then(function (s) { return s.val() || {}; }); }

  function directoryEntry(u) {
    return { name: u.name || '', rollNumber: u.rollNumber || '', status: u.status || 'active', positions: u.positions || {}, sortOrder: u.sortOrder || 0 };
  }

  /**
   * Save membership fields for one user. Recomputes perms and the legacy role
   * and mirrors the public part into directory/ in the same write.
   * patch may contain: name, rollNumber, status, positions, sortOrder, inactiveSince, notes
   */
  function saveUser(uid, patch, profile) {
    return Promise.all([loadSettings(), db.ref('users/' + uid).once('value')]).then(function (r) {
      var settings = r[0];
      var cur = r[1].val() || {};
      var next = Object.assign({}, cur, patch || {});
      if (!next.positions) next.positions = {};
      if (!next.status) next.status = cur.role === 'pending' ? 'pending' : 'active';
      next.perms = C.permsFor(next.positions, settings);
      if (cur.role === 'admin' || next.role === 'admin') { next.role = 'admin'; next.perms.admin = true; }
      else next.role = C.legacyRole(next);
      next.updatedBy = profile.uid;
      next.updatedAt = new Date().toISOString();
      var updates = {};
      updates['users/' + uid] = next;
      if (next.status === 'pending') updates['directory/' + uid] = null;
      else updates['directory/' + uid] = directoryEntry(next);
      // Roster lookup for sign-up autofill.
      var rk = C.rollKey(next.rollNumber);
      if (rk && next.name) {
        updates['roster/' + rk] = { name: next.name };
        updates['rosterByName/' + C.nameKey(next.name)] = { roll: rk, name: next.name };
      }
      return db.ref().update(updates).then(function () { return next; });
    });
  }

  /** One-time upgrade of legacy user records (role only) to status/positions/perms. Idempotent. */
  function migrateUsers(profile) {
    return Promise.all([loadSettings(), loadUsers()]).then(function (r) {
      var settings = r[0], users = r[1];
      var updates = {}, count = 0;
      Object.keys(users).forEach(function (uid) {
        var u = users[uid];
        if (u.status && u.positions && u.perms) return;
        var up = C.upgradeUser(u, settings);
        up.updatedBy = profile.uid; up.updatedAt = new Date().toISOString();
        updates['users/' + uid] = up;
        if (up.status !== 'pending') updates['directory/' + uid] = directoryEntry(up);
        var rk = C.rollKey(up.rollNumber);
        if (rk && up.name) {
          updates['roster/' + rk] = { name: up.name };
          updates['rosterByName/' + C.nameKey(up.name)] = { roll: rk, name: up.name };
        }
        count++;
      });
      updates['meta/schemaVersion'] = C.SCHEMA_VERSION;
      return db.ref().update(updates).then(function () { return count; });
    });
  }

  function hasPerm(profile, perm) {
    if (!profile) return false;
    if (profile.role === 'admin') return true;
    return !!(profile.perms && profile.perms[perm]);
  }

  // ── Facts ──

  function val(ref) { return ref.once('value').then(function (s) { return s.val() || {}; }); }

  /** What a brother can read about themselves for a term. */
  function loadMyFacts(term, uid) {
    return Promise.all([
      loadSettings(),
      val(db.ref('events/' + term)),
      val(db.ref('myAttendance/' + term + '/' + uid)),
      val(db.ref('excuses/' + term + '/' + uid)),
      val(db.ref('adjustments/' + term + '/' + uid)),
      db.ref('rollover/' + term + '/' + uid).once('value').then(function (s) { return s.val(); }),
      val(db.ref('ledger/' + term + '/' + uid)),
      val(db.ref('service/' + term + '/' + uid)),
      db.ref('standing/' + term + '/' + uid).once('value').then(function (s) { return s.val(); })
    ]).then(function (r) {
      // Re-shape my per-event marks into the attendance[event][uid] shape OpsCore expects.
      var attendance = {};
      Object.keys(r[2]).forEach(function (eid) { attendance[eid] = {}; attendance[eid][uid] = r[2][eid]; });
      return { settings: r[0], events: r[1], attendance: attendance, excuses: r[3], adjustments: r[4], rollover: r[5], ledger: r[6], service: r[7], standingOverride: r[8] };
    });
  }

  /** Everything an officer dashboard needs for a term (rules decide which subtrees resolve). */
  function loadTermFacts(term, wanted) {
    var w = wanted || ['events', 'attendance', 'excuses', 'adjustments', 'rollover', 'ledger', 'service', 'standing', 'serviceEvents'];
    return Promise.all([loadSettings(), loadDirectory()].concat(w.map(function (n) {
      return db.ref(n + '/' + term).once('value').then(function (s) { return s.val() || {}; }).catch(function () { return {}; });
    }))).then(function (r) {
      var out = { settings: r[0], directory: r[1] };
      w.forEach(function (n, i) { out[n] = r[i + 2]; });
      return out;
    });
  }

  /** Slice term-wide facts down to one uid for OpsCore.computeDemerits. */
  function factsFor(term, uid, all) {
    return {
      events: all.events, attendance: all.attendance,
      excuses: (all.excuses || {})[uid], adjustments: (all.adjustments || {})[uid], rollover: (all.rollover || {})[uid],
      ledger: (all.ledger || {})[uid], service: (all.service || {})[uid], standingOverride: (all.standing || {})[uid]
    };
  }

  // ── Writes used by more than one page ──

  /** Mark attendance for one event: writes the event map and each brother's mirror in one update. */
  function saveAttendance(term, eventId, marks, profile) {
    var updates = {};
    var now = new Date().toISOString();
    Object.keys(marks).forEach(function (uid) {
      var m = { present: !!marks[uid], markedBy: profile.uid, markedAt: now };
      updates['attendance/' + term + '/' + eventId + '/' + uid] = m;
      updates['myAttendance/' + term + '/' + uid + '/' + eventId] = m;
    });
    updates['events/' + term + '/' + eventId + '/recorded'] = true;
    updates['events/' + term + '/' + eventId + '/recordedAt'] = now;
    return db.ref().update(updates);
  }

  function addLedgerEntry(term, uid, entry, profile, key) {
    var ref = key ? db.ref('ledger/' + term + '/' + uid + '/' + key) : db.ref('ledger/' + term + '/' + uid).push();
    return ref.set(Object.assign({}, entry, audit(profile)));
  }

  /** JSON snapshot of a whole term (officers) for backup or moving elsewhere. */
  function exportTermJson(term) {
    var nodes = ['events', 'attendance', 'excuses', 'adjustments', 'rollover', 'standing', 'ledger', 'service', 'serviceEvents', 'changeLog'];
    return Promise.all(nodes.map(function (n) { return db.ref(n + '/' + term).once('value').then(function (s) { return s.val(); }).catch(function () { return null; }); }))
      .then(function (r) {
        var out = { schemaVersion: C.SCHEMA_VERSION, term: term, exportedAt: new Date().toISOString() };
        nodes.forEach(function (n, i) { out[n] = r[i]; });
        return out;
      });
  }

  global.PortalOps = {
    db: db,
    loadSettings: loadSettings, saveSettings: saveSettings, currentTerm: currentTerm,
    audit: audit, logChange: logChange,
    loadUsers: loadUsers, loadDirectory: loadDirectory, saveUser: saveUser, migrateUsers: migrateUsers, hasPerm: hasPerm,
    loadMyFacts: loadMyFacts, loadTermFacts: loadTermFacts, factsFor: factsFor,
    saveAttendance: saveAttendance, addLedgerEntry: addLedgerEntry, exportTermJson: exportTermJson
  };
})(typeof window !== 'undefined' ? window : this);
