/**
 * PortalSync: "Refresh from sheet". Copies the chapter Tracker sheet into the site for one term.
 *
 *   PortalSync.refresh(profile, opts)    → Promise<summary>; rejects with an Error (err.code says why: not-admin,
 *                                          site-mode, locked, gateway, old-gateway, missing-tab, wrong-term, shrink, …)
 *   PortalSync.refreshIfStale(profile, { page }) → Promise<summary|null>; null when no refresh was needed or
 *                                          allowed (not an admin, the site is the record, the copy is complete and
 *                                          under a day old, or another refresh is running). Rejects only when a
 *                                          refresh failed. Only officer preview pages call it, where the banner
 *                                          shows the refresh running; page 'home' is refused, because a refresh
 *                                          cut off by leaving the page leaves a half-written copy.
 *   PortalSync.termSettings(settings, term) → Promise<settings> with the sheet's own rules for that term laid
 *                                          over them (settings/sheetPolicy), while the sheet is the record.
 *   PortalSync.gatewayVersion()          → Promise<number|null> (the deployed Gateway.gs export version).
 *   opts: { term, dryRun (build and report, write nothing), allowShrink, auto, onProgress(text) }
 *
 * Rules it keeps:
 *  - Admins only, and only while OpsMode says the sheet is the record (settings/mode/source 'sheet' or missing).
 *  - One refresh at a time: settings/mode/syncing is a lock taken in a transaction, with syncingAt/syncingBy.
 *    A lock older than LOCK_MS is stale and may be taken over.
 *  - settings/mode/copyIncomplete is set (and confirmed by the server) before the first write and cleared
 *    with lastSyncAt only after everything is written, so a refresh that failed or was cut off partway shows
 *    in the banner (OpsMode.banner) and is retried at the next admin visit (OpsMode.isStale).
 *  - Nothing is written when the export is unsafe: an old gateway, an empty or missing tab, dates from
 *    another semester, or a node that would shrink to under half or to nothing (that one an admin may allow).
 *  - Each copied term node (SheetSyncCore.NODES) is replaced WHOLE, so rows removed or fixed on the sheet are
 *    removed or fixed here. A node whose facts did not change is left alone. The ledger is append-only by
 *    rule except an admin clearing a whole term, so it is cleared, then written entry by entry.
 *  - The mismatch report and unmatched names go only to imports/ (admins read it). Saved aliases live in
 *    settings/sheetAliases (names only). The sheet's numbers for the term go to settings/sheetPolicy.
 *
 * Load after firebase-config.js, ops-core.js and ops-mode.js. It loads js/sheet-sync-core.js itself when needed.
 * Plain ES5.
 */
(function (global) {
  'use strict';

  /** Same deployment as My Tracker (js/tracker.js). The owner redeploys Gateway.gs as a new version of it. */
  var GATEWAY_URL = 'https://script.google.com/macros/s/AKfycbzEprjKfxyqZkDCxMvUEEXkkBKaarDWQlCd1YLeTKjdm-djAxnE5dlrlpwMRfdxRWNR/exec';
  var LOCK_MS = 10 * 60 * 1000;
  var CHUNK = 300;
  var RETRY_AFTER_FAIL_MS = 10 * 60 * 1000;   // refreshIfStale waits this long after a failed automatic try

  var coreUrl = (function () {
    try {
      var src = document.currentScript && document.currentScript.src;
      if (src && /sheet-sync\.js/.test(src)) return src.replace(/sheet-sync\.js/, 'sheet-sync-core.js');
    } catch (e) {}
    return 'js/sheet-sync-core.js?v=32';
  })();

  function db() { return firebase.database(); }
  function fail(code, msg) { var e = new Error(msg); e.code = code; return e; }
  function isAdmin(p) { return !!p && p.role === 'admin'; }
  function nameOf(p) { return (p && (p.name || p.email)) || ''; }
  function val(path) { return db().ref(path).once('value').then(function (s) { return s.val(); }); }
  function guessTerm() { var d = new Date(); return (d.getMonth() >= 6 ? 'F' : 'S') + String(d.getFullYear()).slice(2); }
  function minutesAgo(ms) { var m = Math.max(0, Math.round((Date.now() - ms) / 60000)); return m < 1 ? 'just now' : (m === 1 ? '1 minute ago' : m + ' minutes ago'); }

  var corePromise = null;
  /** SheetSyncCore, loading js/sheet-sync-core.js the first time it is needed. */
  function ensureCore() {
    if (global.SheetSyncCore) return Promise.resolve(global.SheetSyncCore);
    if (corePromise) return corePromise;
    corePromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = coreUrl;
      s.onload = function () { if (global.SheetSyncCore) resolve(global.SheetSyncCore); else { corePromise = null; reject(fail('core', 'Could not load the sheet mapper.')); } };
      s.onerror = function () { corePromise = null; reject(fail('core', 'Could not load js/sheet-sync-core.js. Check your connection and try again.')); };
      document.head.appendChild(s);
    });
    return corePromise;
  }

  // ── Gateway ──

  function callGateway() {
    var user = firebase.auth().currentUser;
    if (!user) return Promise.reject(fail('auth', 'You are signed out. Sign in again and retry.'));
    return user.getIdToken().then(function (idToken) {
      return fetch(GATEWAY_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ idToken: idToken, action: 'exportAll' }) });
    }).then(function (r) {
      return r.json();
    }, function () {
      throw fail('gateway', 'Could not reach the Tracker gateway. Check your connection and try again.');
    }).then(function (d) {
      if (!d || d.ok === false) throw fail('gateway', 'The Tracker gateway said: ' + ((d && d.error) || 'no answer') + '.');
      return d;
    }, function (err) {
      if (err && err.code) throw err;
      throw fail('gateway', 'The Tracker gateway sent something that is not JSON. Check that the deployment is set to Anyone.');
    });
  }

  /** The deployed gateway's export version (2 = this site; null or 1 = needs redeploying). No sign-in needed. */
  function gatewayVersion() {
    return fetch(GATEWAY_URL + '?action=ping').then(function (r) { return r.json(); }).then(function (d) {
      return d && d.ok ? (Number(d.version) || 1) : null;
    }).catch(function () { return null; });
  }

  // ── Lock (settings/mode/syncing) ──

  function lockHeld(m, now) {
    return !!m && m.syncing === true && typeof m.syncingAt === 'number' && (now || Date.now()) - m.syncingAt < LOCK_MS;
  }

  function acquire(profile) {
    var token = { at: Date.now(), by: profile.uid };
    var why = null;
    return db().ref('settings/mode').transaction(function (cur) {
      var c = cur || {};
      why = null;
      if (c.source === 'site') { why = { site: true }; return; }
      if (lockHeld(c, token.at)) { why = { by: c.syncingByName || 'another admin', at: c.syncingAt }; return; }
      var next = {};
      Object.keys(c).forEach(function (k) { next[k] = c[k]; });
      next.syncing = true; next.syncingAt = token.at; next.syncingBy = token.by; next.syncingByName = nameOf(profile);
      return next;
    }, undefined, false).then(function (r) {
      if (r && r.committed) return token;
      if (why && why.site) throw fail('site-mode', 'The site is the record now, so Refresh from sheet is off.');
      if (why) throw fail('locked', 'Another refresh is running (started ' + minutesAgo(why.at) + ' by ' + why.by + '). Wait a few minutes and try again.');
      throw fail('lock', 'Could not start the refresh. Try again.');
    });
  }

  /**
   * Let go of our lock. done = { at } also records the finished copy (lastSyncAt/By/ByName) and clears
   * copyIncomplete. Without done (a failure) copyIncomplete stays as it is.
   */
  function release(token, profile, done) {
    return db().ref('settings/mode').transaction(function (cur) {
      if (cur === null) return null;                                   // not cached yet: the server answers with the real value
      if (cur.syncingBy !== token.by || cur.syncingAt !== token.at) return;   // not ours any more
      var next = {};
      Object.keys(cur).forEach(function (k) {
        if (k === 'syncingAt' || k === 'syncingBy' || k === 'syncingByName' || (done && k === 'copyIncomplete')) return;
        next[k] = cur[k];
      });
      next.syncing = false;
      if (done) { next.lastSyncAt = done.at; next.lastSyncBy = profile.uid; next.lastSyncByName = nameOf(profile); }
      return next;
    }, undefined, false).then(function (r) { return !!(r && r.committed); }).catch(function () { return false; });
  }

  // ── Writes ──

  function chunkedUpdate(updates) {
    var keys = Object.keys(updates), chain = Promise.resolve();
    for (var i = 0; i < keys.length; i += CHUNK) {
      (function (slice) {
        chain = chain.then(function () {
          var part = {};
          slice.forEach(function (k) { part[k] = updates[k]; });
          return db().ref().update(part);
        });
      })(keys.slice(i, i + CHUNK));
    }
    return chain;
  }

  function isEmpty(v) { return !v || typeof v !== 'object' || !Object.keys(v).length; }

  /** Replace one term node whole. The ledger: clear the term (the only removal its rules allow), then add each entry. */
  function writeNode(name, term, current, next) {
    var path = name + '/' + term;
    if (name !== 'ledger') return db().ref(path).set(isEmpty(next) ? null : next);
    var updates = {};
    Object.keys(next || {}).forEach(function (uid) {
      Object.keys(next[uid] || {}).forEach(function (id) { updates[path + '/' + uid + '/' + id] = next[uid][id]; });
    });
    return (current ? db().ref(path).set(null) : Promise.resolve()).then(function () { return chunkedUpdate(updates); });
  }

  // ── Refresh ──

  function refresh(profile, opts) {
    opts = opts || {};
    var say = typeof opts.onProgress === 'function' ? opts.onProgress : function () {};
    if (!isAdmin(profile)) return Promise.reject(fail('not-admin', 'Only admins can refresh from the sheet.'));
    var M = global.OpsMode;
    if (!M || !global.OpsCore) return Promise.reject(fail('setup', 'This page is missing js/ops-mode.js or js/ops-core.js.'));

    var S = null, token = null, started = Date.now(), iso = new Date(started).toISOString();
    var term = '', built = null, settingsRaw = null, wroteSomething = false, flagged = null;
    /** Before the first write: mark the copy unfinished, and wait until the server has the mark. */
    function beforeWrite() {
      if (!flagged) flagged = db().ref('settings/mode/copyIncomplete').set(true).then(function () { wroteSomething = true; });
      return flagged;
    }

    return Promise.all([ensureCore(), M.load(true)]).then(function (r) {
      S = r[0];
      if (!M.isSheet(r[1])) throw fail('site-mode', 'The site is the record now, so Refresh from sheet is off.');
      if (opts.dryRun) return null;
      return acquire(profile).then(function (t) { token = t; });
    }).then(function () {
      say('Reading the Tracker sheet…');
      return Promise.all([callGateway(), val('users'), val('settings')]);
    }).then(function (r) {
      var exp = r[0], users = r[1] || {};
      settingsRaw = r[2] || {};
      term = String(opts.term || settingsRaw.currentTerm || guessTerm()).toUpperCase();
      var settings = global.OpsCore.withDefaults({ positions: settingsRaw.positions, statuses: settingsRaw.statuses, eventTypes: settingsRaw.eventTypes, policy: settingsRaw.policy });
      say('Matching names and checking totals…');
      built = S.build(exp, { term: term, users: users, aliases: settingsRaw.sheetAliases || {}, settings: settings, asOf: new Date(started) });
      if (opts.dryRun) return summary(S, built, { dryRun: true, at: iso, profile: profile, opts: opts });
      return save(S, profile, opts, term, built, settingsRaw, iso, say, beforeWrite).then(function (res) {
        say('Done.');
        return release(token, profile, { at: Date.now() }).then(function () {
          token = null;
          return summary(S, built, { at: iso, profile: profile, opts: opts, changed: res.changed, before: res.before });
        });
      });
    }).catch(function (err) {
      var msg = (err && err.message) || String(err);
      var code = (err && err.code) || 'error';
      var cleanup = Promise.resolve();
      if (token) {
        var t = token; token = null;
        cleanup = release(t, profile, null).then(function () {
          return db().ref('imports').push({ kind: 'sheetSync', term: term || '', at: iso, by: profile.uid, byName: nameOf(profile), status: wroteSomething ? 'partial' : 'failed',
            auto: !!opts.auto, code: code, error: msg.slice(0, 500) }).catch(function () {});
        });
      }
      return cleanup.then(function () {
        if (wroteSomething && code !== 'shrink') err.message = msg + ' Part of the copy may be new and part old. Refresh again.';
        throw err;
      });
    });
  }

  /** beforeWrite() → Promise: runs before every write; the first call marks the copy unfinished. */
  function save(S, profile, opts, term, built, settingsRaw, iso, say, beforeWrite) {
    var nodes = S.stamp(built.nodes, profile, iso);
    return Promise.all(S.NODES.map(function (n) { return val(n + '/' + term); }).concat([val('terms/' + term)])).then(function (cur) {
      var before = {};
      S.NODES.forEach(function (n, i) { before[n] = S.countNode(n, cur[i]); });
      var shrunk = S.guard(before, built.counts);
      if (shrunk.length && !opts.allowShrink) {
        var noRollover = !built.rolloverTab && shrunk.some(function (s) { return s.node === 'rollover'; }), prev = S.prevTerm(term);
        throw fail('shrink', 'The new copy is much smaller than the one on the site (' + shrunk.map(function (s) { return s.label.toLowerCase() + ' ' + s.before + ' to ' + s.after; }).join(', ') +
          '). That usually means a tab came back empty or half empty, or was renamed.' +
          (noRollover ? ' No roll-over tab was copied: the sheet needs a tab with "Rollover" in its name' + (prev ? ', like "' + prev + ' Rollover Demerits"' : '') +
            ' ("Check without saving" lists a tab that was skipped).' : '') + ' Nothing was changed.');
      }
      var changed = {}, chain = Promise.resolve();
      S.NODES.forEach(function (n, i) {
        chain = chain.then(function () {
          if (S.sameNode(cur[i], built.nodes[n])) { changed[n] = false; return; }
          changed[n] = true;
          say('Saving ' + S.NODE_LABELS[n].toLowerCase() + '…');
          return beforeWrite().then(function () { return writeNode(n, term, cur[i], nodes[n]); });
        });
      });
      var termRec = cur[S.NODES.length];
      return chain.then(function () {
        var up = {};
        if (!S.sameNode(settingsRaw.sheetPolicy, built.sheetPolicy)) up['settings/sheetPolicy'] = built.sheetPolicy;
        if (!settingsRaw.currentTerm) up['settings/currentTerm'] = term;
        if (!termRec) up['terms/' + term] = { label: term, status: 'active', source: 'sheet', createdBy: profile.uid, createdByName: nameOf(profile), createdAt: iso };
        if (!Object.keys(up).length) return null;
        return beforeWrite().then(function () { return db().ref().update(up); });
      }).then(function () {
        say('Saving the report…');
        var c = built.comparison;
        var changedCount = Object.keys(changed).filter(function (k) { return changed[k]; }).length;
        var report = S.normalize({
          term: term, at: iso, by: profile.uid, byName: nameOf(profile), auto: !!opts.auto, exportedAt: built.exportedAt, exportVersion: built.exportVersion,
          counts: built.counts, before: before, changed: changed, compared: c.compared, matching: c.matching,
          mismatches: c.mismatches.slice(0, 300), notCompared: c.notCompared.slice(0, 300), serviceDiffs: c.service.slice(0, 300),
          unmatched: built.unmatched.slice(0, 300), ignored: built.ignored.slice(0, 300), rosterDiffs: built.rosterDiffs.slice(0, 300), warnings: built.warnings,
          rolloverTab: built.rolloverTab || ''
        });
        return Promise.all([
          db().ref('imports/sheetSync').set(report),
          db().ref('imports').push({ kind: 'sheetSync', term: term, at: iso, by: profile.uid, byName: nameOf(profile), status: 'done', auto: !!opts.auto,
            counts: built.counts, changedNodes: changedCount, mismatches: c.mismatches.length, unmatched: built.unmatched.length }),
          db().ref('changeLog/' + term).push({ type: 'sheetSync', where: 'sheet', detail: changedCount ? 'Refreshed the copy from the Tracker sheet (' + changedCount + ' parts changed)' : 'Refreshed the copy from the Tracker sheet (no changes)',
            by: profile.uid, byName: nameOf(profile), at: iso }).catch(function () {})
        ]);
      }).then(function () { return { changed: changed, before: before }; });
    });
  }

  function summary(S, built, o) {
    var c = built.comparison;
    var changed = o.changed || null;
    return {
      ok: true, dryRun: !!o.dryRun, term: built.term, at: o.at, byName: nameOf(o.profile), auto: !!(o.opts && o.opts.auto),
      counts: built.counts, before: o.before || null, changed: changed,
      changedNodes: changed ? Object.keys(changed).filter(function (k) { return changed[k]; }).length : null,
      compared: c.compared, matching: c.matching, mismatches: c.mismatches.length, unmatched: built.unmatched.length, warnings: built.warnings.length,
      report: {
        term: built.term, at: o.at, byName: nameOf(o.profile), dryRun: !!o.dryRun, counts: built.counts, changed: changed, compared: c.compared, matching: c.matching,
        mismatches: c.mismatches, notCompared: c.notCompared, serviceDiffs: c.service, unmatched: built.unmatched, ignored: built.ignored,
        rosterDiffs: built.rosterDiffs, warnings: built.warnings, exportedAt: built.exportedAt, exportVersion: built.exportVersion,
        rolloverTab: built.rolloverTab || ''
      }
    };
  }

  // ── Automatic refresh on preview pages ──

  var autoRun = null;
  function recentFailure() {
    try { var t = Number(global.sessionStorage.getItem('portalSyncFailedAt')); return t && Date.now() - t < RETRY_AFTER_FAIL_MS; } catch (e) { return false; }
  }
  function noteFailure(on) {
    try { if (on) global.sessionStorage.setItem('portalSyncFailedAt', String(Date.now())); else global.sessionStorage.removeItem('portalSyncFailedAt'); } catch (e) {}
  }

  /**
   * Refresh the copy when it is missing, unfinished (copyIncomplete) or more than a day old. For officer
   * preview pages only (opts.page 'home' is refused): the portal home is left within seconds, and a refresh
   * cut off partway leaves a half-written copy until the next try.
   */
  function refreshIfStale(profile, opts) {
    opts = opts || {};
    if (!isAdmin(profile) || !global.OpsMode || opts.page === 'home') return Promise.resolve(null);
    if (autoRun) return autoRun;
    var M = global.OpsMode;
    autoRun = M.load(true).then(function (mode) {
      if (!M.isSheet(mode) || !M.isStale(mode) || recentFailure()) return null;
      if (typeof M.isSyncing === 'function' ? M.isSyncing(mode) : lockHeld(mode)) return null;   // a live lock: that refresh will finish
      return refresh(profile, { auto: true }).then(function (s) { noteFailure(false); return s; }, function (err) {
        if (err && (err.code === 'locked' || err.code === 'site-mode')) return null;
        noteFailure(true);
        throw err;
      });
    });
    return autoRun;
  }

  // ── The sheet's rules for pages that compute totals ──

  function termSettings(settings, term) {
    var M = global.OpsMode;
    return (M ? M.load() : Promise.resolve(null)).then(function (mode) {
      return Promise.all([ensureCore(), val('settings/sheetPolicy')]).then(function (r) {
        var sp = r[1];
        term = term || (settings && settings.currentTerm);
        // Same rule as PortalOps.termSettings: the sheet's numbers keep applying to the term the sheet
        // owned after the switch; a policy with no term applies only while the sheet is the record.
        if (M && !M.isSheet(mode) && !(sp && sp.term && sp.term === term)) return settings;
        return r[0].termSettings(settings, sp, term);
      });
    });
  }

  global.PortalSync = {
    GATEWAY_URL: GATEWAY_URL,
    LOCK_MS: LOCK_MS,
    refresh: refresh,
    refreshIfStale: refreshIfStale,
    termSettings: termSettings,
    gatewayVersion: gatewayVersion,
    ensureCore: ensureCore
  };
})(window);
