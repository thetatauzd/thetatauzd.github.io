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

  /**
   * Full settings (stored values over defaults). Cached per page load unless force.
   * Also carries .mode: settings/mode in the OpsMode shape (missing = the Tracker sheet owns the data),
   * and .sheetPolicy: the sheet's own numbers for its term (settings/sheetPolicy, see termSettings).
   */
  function loadSettings(force) {
    if (settingsCache && !force) return Promise.resolve(settingsCache);
    return db.ref('settings').once('value').then(function (s) {
      var v = s.val() || {};
      termCache = v.currentTerm || null;
      settingsCache = C.withDefaults({ positions: v.positions, statuses: v.statuses, eventTypes: v.eventTypes, policy: v.policy });
      settingsCache.currentTerm = termCache || guessTerm();
      settingsCache.mode = modeFrom(v.mode);
      settingsCache.sheetPolicy = v.sheetPolicy || null;
      return settingsCache;
    });
  }

  /** Deep merge src over dst (src wins, null skipped). Same rule as SheetSyncCore's overlay. */
  function overlay(dst, src) {
    Object.keys(src || {}).forEach(function (k) {
      if (src[k] === undefined || src[k] === null) return;
      if (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k]) && dst[k] && typeof dst[k] === 'object' && !Array.isArray(dst[k])) overlay(dst[k], src[k]);
      else dst[k] = JSON.parse(JSON.stringify(src[k]));
    });
    return dst;
  }

  /**
   * The settings to compute `term` with. While the Tracker sheet is the record, the sheet's own numbers
   * for its term (settings/sheetPolicy, written by Refresh from sheet) are laid over the site's, so preview
   * totals follow the sheet's dashboard. Otherwise, or for another term, `settings` comes back unchanged.
   * Same rule as SheetSyncCore.termSettings / PortalSync.termSettings, without loading the sync code.
   * opts.anyMode: apply them after the switch to the site too (Semester Setup closing the sheet's term).
   */
  function termSettings(settings, term, opts) {
    if (!settings) return settings;
    var sp = settings.sheetPolicy;
    term = term || settings.currentTerm;
    if (!sp || (term && sp.term && sp.term !== term)) return settings;
    // The sheet's numbers belong to the term the sheet owned, so they still apply to that term after the
    // switch to This site. A policy with no term applies only while the sheet is the record (or anyMode).
    if (!sp.term && !isReadOnly(settings.mode) && !(opts && opts.anyMode)) return settings;
    var K = global.SheetSyncCore;
    var out = K && K.termSettings ? K.termSettings(settings, sp, term) : overlay(JSON.parse(JSON.stringify(settings)), { eventTypes: sp.eventTypes, policy: sp.policy });
    out.sheetRules = sp.term || term;   // pages can say the numbers are the sheet's
    return out;
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

  // ── Who owns the tracker data (settings/mode, see js/ops-mode.js) ──
  // While the Tracker sheet is the record, every officer page is a read-only preview of the copy that
  // "Refresh from sheet" (js/sheet-sync.js) makes. Anything written here would be replaced at the next
  // refresh, so pages hide every control that writes tracker data, for admins too.

  /** settings/mode in the OpsMode shape. Missing or unreadable means the Tracker sheet. */
  function modeFrom(v) {
    v = v || {};
    return {
      source: v.source === 'site' ? 'site' : 'sheet',
      forms: v.forms || {},
      lastSyncAt: typeof v.lastSyncAt === 'number' ? v.lastSyncAt : null,
      lastSyncBy: v.lastSyncBy || null,
      lastSyncByName: v.lastSyncByName || null,
      syncing: v.syncing === true,
      syncingAt: typeof v.syncingAt === 'number' ? v.syncingAt : null,
      copyIncomplete: v.copyIncomplete === true
    };
  }

  /** True while a refresh really holds the lock: OpsMode.isSyncing (a lock older than 10 minutes is dead). */
  var LOCK_MS = 10 * 60 * 1000;
  function lockHeld(mode, now) {
    if (global.OpsMode && global.OpsMode.isSyncing) return global.OpsMode.isSyncing(mode, now);
    return !!(mode && mode.syncing && mode.syncingAt && (now || Date.now()) - mode.syncingAt < LOCK_MS);
  }
  function lockMs() { return (global.OpsMode && global.OpsMode.LOCK_MS) || LOCK_MS; }

  /** Promise of the mode. Never rejects: if it cannot be read, the sheet owns the data. */
  function loadMode(force) {
    var M = global.OpsMode;
    var p;
    try { p = M && M.load ? M.load(force) : loadSettings(force).then(function (s) { return s.mode; }); }
    catch (e) { p = Promise.reject(e); }
    return Promise.resolve(p).then(function (m) { return m || modeFrom(null); }, function () { return modeFrom(null); });
  }

  /** True while the Tracker sheet is the record (the default, and whenever the mode is unknown). */
  function isReadOnly(mode) {
    if (global.OpsMode && global.OpsMode.isSheet) return global.OpsMode.isSheet(mode);
    return !mode || mode.source !== 'site';
  }

  /** Hide every [data-write] element and show every [data-readonly] one (both use the .hidden class). */
  function lockWrites(root) {
    root = root || document;
    [].forEach.call(root.querySelectorAll('[data-write]'), function (el) { el.classList.add('hidden'); });
    [].forEach.call(root.querySelectorAll('[data-readonly]'), function (el) { el.classList.remove('hidden'); });
  }

  function isAdmin(profile) { return !!profile && profile.role === 'admin'; }
  function canSync(profile) { return isAdmin(profile) && !!global.PortalSync && typeof global.PortalSync.refresh === 'function'; }

  function drawBanner(opts, st) {
    var el = opts.el;
    if (!el) return;
    if (st.changed) {
      if (!/(^|\s)ops-mode-banner(\s|$)/.test(el.className)) el.className = (el.className ? el.className + ' ' : '') + 'ops-mode-banner';
      el.hidden = false;
      el.setAttribute('role', 'note');
      el.innerHTML = '<strong>The source of truth just changed.</strong> Reload this page before you do anything else. ' +
        '<button type="button" class="btn btn-primary btn-small">Reload</button>';
      el.querySelector('button').addEventListener('click', function () { location.reload(); });
      return;
    }
    if (!st.readOnly) { el.hidden = true; el.innerHTML = ''; return; }
    // A refresh that is running now (another admin's, or this page's) sets copyIncomplete before its first
    // write, so "stopped partway" is only true once no live lock holds it.
    var running = lockHeld(st.mode) || !!st.busy;
    var shown = running && st.mode.copyIncomplete ? Object.assign({}, st.mode, { copyIncomplete: false }) : st.mode;
    el.className = el.className.replace(/(^|\s)ops-mode-banner(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim();
    if (global.OpsMode && global.OpsMode.banner) global.OpsMode.banner(el, shown, { what: opts.what });
    else {
      el.className = (el.className ? el.className + ' ' : '') + 'ops-mode-banner';
      el.hidden = false;
      el.setAttribute('role', 'note');
      el.textContent = 'Preview. ' + (shown.copyIncomplete ? 'The last refresh stopped partway, so some numbers may be missing until an admin refreshes again. ' : '') +
        'The Tracker sheet is still the record this semester: make changes there, and they show here after the next refresh.';
    }
    watchLock(opts, st);
    var row = document.createElement('div');
    row.className = 'req-actions';
    function note(text) {
      var n = document.createElement('span');
      n.className = 'step-hint';
      n.style.margin = '0';
      n.textContent = text;
      row.appendChild(n);
    }
    if (canSync(opts.profile)) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn ghost btn-small';
      b.textContent = st.busy ? 'Copying from the sheet…' : 'Refresh from sheet now';
      b.disabled = !!st.busy;
      b.addEventListener('click', function () { sync(opts, st, false); });
      row.appendChild(b);
    }
    if (lockHeld(st.mode) && !st.busy) note('A refresh from the sheet is running now. This page updates when it is done.');
    else if (!isAdmin(opts.profile)) note('If this copy looks out of date, ask an admin to refresh it.');
    if (st.msg) {
      var m = document.createElement('span');
      m.className = 'status-line' + (st.msgKind ? ' ' + st.msgKind : '');
      m.style.margin = '0';
      m.textContent = st.msg;
      row.appendChild(m);
    }
    if (row.childNodes.length) el.appendChild(row);
  }

  /** A held lock dies quietly after LOCK_MS: redraw then, so a dead refresh stops reading as "running now". */
  function watchLock(opts, st) {
    if (typeof setTimeout !== 'function') return;
    if (st.lockTimer) { clearTimeout(st.lockTimer); st.lockTimer = null; }
    if (st.busy || !lockHeld(st.mode) || !st.mode.syncingAt) return;
    var left = Math.max(0, st.mode.syncingAt + lockMs() - Date.now()) + 1000;
    st.lockTimer = setTimeout(function () {
      st.lockTimer = null;
      if (!st.changed && st.readOnly) { try { drawBanner(opts, st); } catch (e) {} }
    }, left);
  }

  /** The copy changed: drop cached settings, then let the page reload its data (or the whole page if the term moved). */
  function refreshed(opts, st) {
    var before = currentTerm();
    settingsCache = null;
    loadSettings(true).catch(function () {}).then(function () {
      if (currentTerm() !== before) { location.reload(); return; }
      if (opts.onRefresh) opts.onRefresh();
    });
  }

  /** Run PortalSync (admins only). auto = refreshIfStale on page load; otherwise the button's full refresh. */
  function sync(opts, st, auto) {
    var S = global.PortalSync;
    if (st.busy || !canSync(opts.profile)) return;
    var fn = auto ? S.refreshIfStale : S.refresh;
    if (typeof fn !== 'function') return;
    var M = global.OpsMode;
    var showBusy = !auto || !M || !M.isStale || M.isStale(st.mode);
    st.busy = true;
    if (showBusy) {
      st.msg = !auto ? '' : (st.mode.copyIncomplete ? 'The last refresh stopped partway, so the copy is being made again.'
        : (st.mode.lastSyncAt ? 'This copy is more than a day old, so it is being refreshed.' : 'Making the first copy from the sheet.'));
      st.msgKind = '';
      drawBanner(opts, st);
    }
    function progress(text) { st.msg = String(text || ''); st.msgKind = ''; drawBanner(opts, st); }
    Promise.resolve().then(function () { return auto ? fn.call(S, opts.profile) : fn.call(S, opts.profile, { onProgress: progress }); }).then(function (summary) {
      st.busy = false;
      if (auto && !summary) { if (showBusy) { st.msg = ''; drawBanner(opts, st); } return; }
      st.msg = 'Copied from the sheet just now.' + (summary && typeof summary.compared === 'number' && summary.compared
        ? ' ' + summary.matching + ' of ' + summary.compared + ' demerit totals match the sheet' + (summary.unmatched ? ', ' + summary.unmatched + ' names not matched' : '') + '. Details: Admin menu, Refresh from sheet.'
        : '');
      st.msgKind = 'success'; st.dirty = false;
      return loadMode(true).then(function (m) {
        st.mode = m; st.seenSyncAt = m.lastSyncAt;
        drawBanner(opts, st);
        refreshed(opts, st);
      });
    }).catch(function (err) {
      st.busy = false;
      st.msg = 'Refresh failed. ' + ((err && err.message) || 'Unknown error.');
      st.msgKind = 'error';
      drawBanner(opts, st);
    });
  }

  /** The sheet became the record while this page was open in site mode: stop every control until a reload. */
  function freeze(opts) {
    lockWrites();
    [].forEach.call(document.querySelectorAll('main input, main select, main textarea, main button'), function (el) {
      if (!opts.el || !opts.el.contains(el)) el.disabled = true;
    });
  }

  /** Follow settings/mode live: redraw the banner, reload the page's data after a new copy, flag a switch. */
  function watchMode(opts, st) {
    db.ref('settings/mode').on('value', function (s) {
      var m = modeFrom(s.val());
      if (isReadOnly(m) !== st.readOnly) {
        st.changed = true;
        if (isReadOnly(m)) freeze(opts);
        drawBanner(opts, st);
        return;
      }
      if (st.changed) return;
      if (m.lastSyncAt !== st.seenSyncAt) { st.seenSyncAt = m.lastSyncAt; st.dirty = true; }
      st.mode = Object.assign({}, st.mode, { lastSyncAt: m.lastSyncAt, lastSyncBy: m.lastSyncBy, lastSyncByName: m.lastSyncByName,
        syncing: m.syncing, syncingAt: m.syncingAt, copyIncomplete: m.copyIncomplete });
      if (st.readOnly) drawBanner(opts, st);
      if (st.dirty && st.readOnly && !lockHeld(m) && !st.busy) { st.dirty = false; refreshed(opts, st); }
    }, function () {});
  }

  /**
   * Set up an officer page for the current mode. While the sheet is the record the page is a read-only
   * preview: the banner (OpsMode.banner) says when the copy was made, [data-write] parts hide,
   * [data-readonly] parts show, admins get a "Refresh from sheet now" button, and an admin's visit
   * refreshes a copy older than a day (PortalSync.refreshIfStale). A switch made while the page is open
   * shows a reload notice instead.
   *   opts: { profile, el: banner element, what: words for OpsMode.banner, onRefresh: reload the page's data }
   * Resolves { mode, readOnly }. Never rejects: an unreadable mode means read-only.
   */
  function preview(opts) {
    opts = opts || {};
    return loadMode().then(function (mode) {
      var st = { mode: mode, readOnly: isReadOnly(mode), seenSyncAt: mode.lastSyncAt, busy: false, dirty: false, changed: false, msg: '', msgKind: '' };
      if (st.readOnly) lockWrites();
      try { drawBanner(opts, st); } catch (e) {}
      try { watchMode(opts, st); } catch (e) {}
      if (st.readOnly && canSync(opts.profile)) sync(opts, st, true);
      return { mode: mode, readOnly: st.readOnly };
    });
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
   * patch may contain: name, rollNumber, status, positions, sortOrder, inactiveSince, notes,
   * and statusEffective ('YYYY-MM-DD', not stored on the user) for the status history row.
   * A status change is also appended to statusHistory/{uid}. It takes effect at the next
   * roll call: attendance only counts events where the person was marked.
   */
  function saveUser(uid, patch, profile) {
    return Promise.all([loadSettings(), db.ref('users/' + uid).once('value')]).then(function (r) {
      var settings = r[0];
      var cur = r[1].val() || {};
      var next = Object.assign({}, cur, patch || {});
      var effective = next.statusEffective || C.ymd(new Date());
      delete next.statusEffective;
      if (!next.positions) next.positions = {};
      if (!next.status) next.status = cur.role === 'pending' ? 'pending' : 'active';
      next.perms = C.permsFor(next.positions, settings);
      if (cur.role === 'admin' || next.role === 'admin') { next.role = 'admin'; next.perms.admin = true; }
      else next.role = C.legacyRole(next);
      next.updatedBy = profile.uid;
      next.updatedAt = new Date().toISOString();
      var updates = {};
      updates['users/' + uid] = next;
      var before = cur.status || (cur.role === 'pending' ? 'pending' : (cur.role ? 'active' : ''));
      if (before !== next.status) {
        if (next.status === 'inactive' && !next.inactiveSince) next.inactiveSince = effective;
        updates['statusHistory/' + uid + '/' + db.ref().push().key] = { from: before || null, to: next.status, effective: effective,
          by: profile.uid, byName: profile.name || profile.email || '', at: new Date().toISOString() };
      }
      if (next.status === 'pending') updates['directory/' + uid] = null;
      else updates['directory/' + uid] = directoryEntry(next);
      // Roster lookup for sign-up autofill.
      var rk = C.rollKey(next.rollNumber);
      if (cur.name && C.nameKey(cur.name) !== C.nameKey(next.name)) updates['rosterByName/' + C.nameKey(cur.name)] = null;   // renamed: drop the old autofill key
      if (rk && next.name) {
        updates['roster/' + rk] = { name: next.name };
        updates['rosterByName/' + C.nameKey(next.name)] = { roll: rk, name: next.name };
      }
      return db.ref().update(updates).then(function () { return next; });
    });
  }

  /**
   * True for a legacy record (role only) that migrateUsers would upgrade. A record with a status is done:
   * saveUser and upgradeUser always write status, while an empty positions or perms map is never stored
   * by the database, so a brother with no position has neither and still counts as upgraded.
   */
  function needsUpgrade(u) { return !(u && u.status); }

  /** One-time upgrade of legacy user records (role only) to status/positions/perms. Idempotent. */
  function migrateUsers(profile) {
    return Promise.all([loadSettings(), loadUsers()]).then(function (r) {
      var settings = r[0], users = r[1];
      var updates = {}, count = 0;
      Object.keys(users).forEach(function (uid) {
        var u = users[uid];
        if (!needsUpgrade(u)) return;
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

  /**
   * What a brother can read about themselves for a term. out.settings are the settings to compute that
   * term with (termSettings, the same as loadTermFacts: the sheet's own numbers for the sheet's term).
   */
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
      return { settings: termSettings(r[0], term), events: r[1], attendance: attendance, excuses: r[3], adjustments: r[4], rollover: r[5], ledger: r[6], service: r[7], standingOverride: r[8] };
    });
  }

  /** Everything an officer dashboard needs for a term (rules decide which subtrees resolve). */
  /** Nodes a demerit total depends on. A total computed without one of them is wrong, not partial. */
  var DEMERIT_NODES = ['events', 'attendance', 'excuseFlags', 'adjustments', 'rollover', 'service', 'ledger'];

  /**
   * Everything an officer page needs for a term. A node the viewer's position may not read comes back {}
   * and is listed in out.denied, so a page can tell "empty" from "not allowed". out.settings are the
   * settings to compute that term with (termSettings: the sheet's own numbers while it is the record).
   */
  function loadTermFacts(term, wanted) {
    var w = wanted || ['events', 'attendance', 'excuses', 'excuseFlags', 'adjustments', 'rollover', 'ledger', 'service', 'standing'];
    var denied = [];
    return Promise.all([loadSettings(), loadDirectory()].concat(w.map(function (n) {
      return db.ref(n + '/' + term).once('value').then(function (s) { return s.val() || {}; })
        .catch(function () { denied.push(n); return {}; });
    }))).then(function (r) {
      var out = { settings: termSettings(r[0], term), directory: r[1], denied: denied };
      w.forEach(function (n, i) { out[n] = r[i + 2]; });
      return out;
    });
  }

  /** Call before WRITING anything derived from a demerit total (rollover, buy-out). Throws if a fact is missing. */
  function requireReadable(all, nodes) {
    var missing = (nodes || DEMERIT_NODES).filter(function (n) { return !(n in all) || (all.denied || []).indexOf(n) !== -1; });
    if (missing.length) throw new Error('Your position cannot read ' + missing.join(', ') + ' for this term, so these numbers would be wrong. Ask the Standards Chair or an admin to do this step.');
  }

  /** Slice term-wide facts down to one uid for OpsCore.computeDemerits. */
  function factsFor(term, uid, all) {
    // Officers who cannot read excuse reasons still get who is excused from the flags mirror.
    var excusedEvents = {};
    Object.keys(all.excuseFlags || {}).forEach(function (eid) { if ((all.excuseFlags[eid] || {})[uid] === 'approved') excusedEvents[eid] = true; });
    return {
      events: all.events, attendance: all.attendance, excusedEvents: excusedEvents,
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

  // ── Excuses ──
  // excuses/{term}/{uid}/{id} holds the request (reason, photos: the brother and Standards only).
  // excuseFlags/{term}/{eventId}/{uid} mirrors just the state so the Scribe can show a badge
  // and other officers can compute demerits without reading anyone's reasons.

  function flagValue(kind, status) { return (kind === 'late' ? 'late_' : (kind === 'leaveEarly' ? 'early_' : '')) + status; }

  /**
   * One request per target. base = { kind, time, category, reason, photoIds, lateSubmission? }
   * targets = [{ eventId }] for listed events or [{ eventText, eventDate }] when it is not listed yet.
   */
  function submitExcuses(term, uid, base, targets, settings, events) {
    var updates = {}, now = Date.now();
    targets.forEach(function (t) {
      var key = db.ref().push().key;
      var ev = t.eventId ? (events || {})[t.eventId] : { date: t.eventDate };
      var timing = C.excuseTiming(ev || {}, now, settings);
      var entry = Object.assign({}, base, {
        eventId: t.eventId || null, eventText: t.eventId ? null : (t.eventText || ''), eventDate: t.eventId ? null : (t.eventDate || null),
        status: 'pending', submittedAt: firebase.database.ServerValue.TIMESTAMP,
        lateSubmission: !timing.onTime, afterEvent: !!timing.after
      });
      updates['excuses/' + term + '/' + uid + '/' + key] = entry;
      if (t.eventId) updates['excuseFlags/' + term + '/' + t.eventId + '/' + uid] = flagValue(base.kind, 'pending');
    });
    return db.ref().update(updates);
  }

  /** The brother takes back a request Standards has not ruled on yet. */
  function withdrawExcuse(term, uid, id, x) {
    var updates = {};
    updates['excuses/' + term + '/' + uid + '/' + id] = null;
    if (x && x.eventId) updates['excuseFlags/' + term + '/' + x.eventId + '/' + uid] = null;
    return db.ref().update(updates);
  }

  /** Standards rules on (or re-rules on) a request. patch may carry eventId to link an unlisted event. */
  function decideExcuse(term, x, decision, note, profile, patch) {
    var eventId = (patch && patch.eventId) || x.eventId;
    var upd = Object.assign({}, patch || {}, { status: decision, reviewedBy: profile.uid, reviewedByName: profile.name || '', reviewedAt: new Date().toISOString(), reviewNote: note || '' });
    var updates = {};
    Object.keys(upd).forEach(function (k) { updates['excuses/' + term + '/' + x.uid + '/' + x.id + '/' + k] = upd[k]; });
    if (eventId) updates['excuseFlags/' + term + '/' + eventId + '/' + x.uid] = flagValue(x.kind, decision);
    return db.ref().update(updates);
  }

  function addLedgerEntry(term, uid, entry, profile, key) {
    var ref = key ? db.ref('ledger/' + term + '/' + uid + '/' + key) : db.ref('ledger/' + term + '/' + uid).push();
    return ref.set(Object.assign({}, entry, audit(profile)));
  }

  /** JSON snapshot of a whole term (officers) for backup or moving elsewhere. */
  function exportTermJson(term) {
    var nodes = ['events', 'attendance', 'excuses', 'excuseFlags', 'adjustments', 'rollover', 'standing', 'ledger', 'service', 'changeLog'];
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
    loadMode: loadMode, isReadOnly: isReadOnly, lockWrites: lockWrites, preview: preview, termSettings: termSettings,
    audit: audit, logChange: logChange,
    loadUsers: loadUsers, loadDirectory: loadDirectory, saveUser: saveUser, migrateUsers: migrateUsers, needsUpgrade: needsUpgrade, hasPerm: hasPerm,
    loadMyFacts: loadMyFacts, loadTermFacts: loadTermFacts, DEMERIT_NODES: DEMERIT_NODES, requireReadable: requireReadable, factsFor: factsFor,
    saveAttendance: saveAttendance, submitExcuses: submitExcuses, withdrawExcuse: withdrawExcuse, decideExcuse: decideExcuse, flagValue: flagValue,
    addLedgerEntry: addLedgerEntry, exportTermJson: exportTermJson
  };
})(typeof window !== 'undefined' ? window : this);
