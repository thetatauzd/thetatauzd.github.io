/**
 * PortalSync: "Refresh from sheet". Copies the chapter Tracker sheet into the site for one term.
 *
 *   PortalSync.refresh(profile, opts)    → Promise<summary>; rejects with an Error (err.code says why: not-admin,
 *                                          site-mode, locked, taken-over, left-page, gateway, gateway-timeout,
 *                                          old-gateway, missing-tab, wrong-term, shrink, …)
 *   PortalSync.refreshIfStale(profile, { page, onProgress }) → Promise<summary|null>; null when no refresh was
 *                                          needed or allowed (not an admin, the site is the record, the copy is
 *                                          complete and under a day old, or another refresh is running). Rejects
 *                                          only when a refresh failed. Only officer preview pages call it, where the
 *                                          banner shows the refresh running; page 'home' is refused, because a
 *                                          refresh cut off by leaving the page leaves a half-written copy.
 *   PortalSync.termSettings(settings, term) → Promise<settings> with the sheet's own rules for that term laid
 *                                          over them (settings/sheetPolicy), while the sheet is the record.
 *   PortalSync.gatewayVersion()          → Promise<number|null> (the deployed Gateway.gs export version).
 *   opts: { term, dryRun (build and report, write nothing), allowShrink, auto, onProgress(text) }
 *   auto is refreshIfStale's run: it never takes over a lock. Without auto (a button press) the run may take
 *   over the same admin's own lock once it is TAKEOVER_MS old (see the lock rules below).
 *
 * Rules it keeps:
 *  - Admins only, and only while OpsMode says the sheet is the record (settings/mode/source 'sheet' or missing).
 *  - One refresh at a time: settings/mode/syncing is a lock taken in a transaction, with syncingAt/syncingBy.
 *    A lock older than LOCK_MS is stale and may be taken over.
 *  - The lock is let go only by the run itself (done or failed), by its page on pagehide, by the same admin's
 *    takeover (below), or by age (LOCK_MS). While a refresh runs the page asks before leaving (beforeunload),
 *    and on pagehide it lets go of the lock itself (best effort, a conditional release like the normal one) and
 *    logs the run as stopped ('left-page'). A page that is killed, or whose connection drops, keeps the lock:
 *    the server never lets go on its own, because a dropped connection can come back while the run is still
 *    writing, and a second refresh started in the gap would then get the first run's later writes on top of
 *    its finished copy.
 *  - A live lock held by the same admin that this page did not take is that admin's own refresh from another
 *    page or tab that was cut off (or is still running there). A button press takes it over once the lock is
 *    TAKEOVER_MS old: a refresh takes about 10 seconds (half a minute on a slow day), so a 2-minute-old lock
 *    is almost surely dead, and the admin waits 2 minutes instead of 10. Another admin's live lock still
 *    gives 'locked', and refreshIfStale never takes over.
 *  - A run confirms the lock is still its own (syncingAt/By are its token) before EVERY write of the copy:
 *    the first one in the transaction that marks the copy unfinished, then before each node, each ledger
 *    chunk, the settings it writes and its report. A run that was taken over (or whose page was left) stops
 *    there with 'taken-over' ('left-page') and writes nothing more, not even copyIncomplete (see takenOver).
 *    A write already sent when the lock changed hands can still land, so at most one write per run can race
 *    a takeover. The same checks stop a run ('site-mode') when the site became the record while it ran, and a
 *    watch on settings/mode drops the page handlers as soon as another refresh holds the lock. A final release
 *    that does not commit fails the run ('release'): the copy is saved but stays marked unfinished.
 *  - The gateway call gives up after GATEWAY_TIMEOUT_MS (Apps Script stops a run at 6 minutes), so a request
 *    that never answers ends with 'gateway-timeout' and the lock is released like any other failure.
 *  - settings/mode/copyIncomplete is set (and confirmed by the server) before the first write and cleared
 *    with lastSyncAt only after everything is written, so a refresh that failed or was cut off partway shows
 *    in the banner (OpsMode.banner) and is retried at the next admin visit (OpsMode.isStale). The mark is set
 *    in a transaction that first checks the lock is still this run's.
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
  /** A button press may take over the same admin's own live lock once it is this old (a refresh takes ~10 s). */
  var TAKEOVER_MS = 2 * 60 * 1000;
  /** Apps Script stops a run at 6 minutes; give up on the gateway half a minute after that. */
  var GATEWAY_TIMEOUT_MS = 390 * 1000;
  var CHUNK = 300;
  var RETRY_AFTER_FAIL_MS = 10 * 60 * 1000;   // refreshIfStale waits this long after a failed automatic try

  var coreUrl = (function () {
    try {
      var src = document.currentScript && document.currentScript.src;
      if (src && /sheet-sync\.js/.test(src)) return src.replace(/sheet-sync\.js/, 'sheet-sync-core.js');
    } catch (e) {}
    return 'js/sheet-sync-core.js?v=35';
  })();

  function db() { return firebase.database(); }
  function fail(code, msg) { var e = new Error(msg); e.code = code; return e; }
  function isAdmin(p) { return !!p && p.role === 'admin'; }
  function nameOf(p) { return (p && (p.name || p.email)) || ''; }
  function val(path) { return db().ref(path).once('value').then(function (s) { return s.val(); }); }
  function guessTerm() { var d = new Date(); return (d.getMonth() >= 6 ? 'F' : 'S') + String(d.getFullYear()).slice(2); }
  function minutesAgo(ms) { var m = Math.max(0, Math.round((Date.now() - ms) / 60000)); return m < 1 ? 'just now' : (m === 1 ? '1 minute ago' : m + ' minutes ago'); }
  function inAbout(ms) { var s = Math.max(1, Math.ceil(ms / 1000)); return s < 60 ? 'in ' + s + ' seconds' : (s <= 90 ? 'in a minute' : 'in ' + Math.ceil(s / 60) + ' minutes'); }
  function copyOf(o) { var n = {}; Object.keys(o || {}).forEach(function (k) { n[k] = o[k]; }); return n; }

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

  /** p, or a 'gateway-timeout' rejection after ms (onTimeout runs first, to abort the request). */
  function withTimeout(p, ms, onTimeout) {
    return new Promise(function (resolve, reject) {
      var over = false;
      var t = setTimeout(function () {
        over = true;
        try { if (onTimeout) onTimeout(); } catch (e) {}
        reject(fail('gateway-timeout', 'The Tracker gateway did not answer in ' + String(Math.round(ms / 6000) / 10) + ' minutes (Apps Script stops a run at 6). ' +
          'Nothing was changed. Try again; if it keeps happening, check the Gateway.gs executions in Apps Script.'));
      }, ms);
      p.then(function (v) { if (over) return; clearTimeout(t); resolve(v); }, function (e) { if (over) return; clearTimeout(t); reject(e); });
    });
  }

  function callGateway() {
    var user = firebase.auth().currentUser;
    if (!user) return Promise.reject(fail('auth', 'You are signed out. Sign in again and retry.'));
    return user.getIdToken().then(function (idToken) {
      var ctl = null;
      try { if (typeof AbortController === 'function') ctl = new AbortController(); } catch (e) { ctl = null; }
      var init = { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ idToken: idToken, action: 'exportAll' }) };
      if (ctl) init.signal = ctl.signal;
      var req = fetch(GATEWAY_URL, init).then(function (r) {
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
      return withTimeout(req, GATEWAY_TIMEOUT_MS, function () { if (ctl) ctl.abort(); });
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

  /** This page's refresh while it holds the lock: { token, profile, auto, iso, term(), wrote(), left, ended }. */
  var active = null;

  /**
   * Take the lock. takeOver (a button press, never refreshIfStale): a live lock held by the same admin that
   * this page did not take may be taken over once it is TAKEOVER_MS old. token.tookOver = { at } says so.
   */
  function acquire(profile, takeOver) {
    var token = { at: Date.now(), by: profile.uid, tookOver: null };
    var why = null;
    return db().ref('settings/mode').transaction(function (cur) {
      var c = cur || {};
      why = null; token.tookOver = null;
      if (c.source === 'site') { why = { site: true }; return; }
      if (lockHeld(c, token.at)) {
        var mine = !!c.syncingBy && c.syncingBy === profile.uid;
        var here = mine && !!active && !!active.token && active.token.at === c.syncingAt;
        var age = token.at - c.syncingAt;
        if (!mine || here || !takeOver || age < TAKEOVER_MS) { why = { by: c.syncingByName || 'another admin', at: c.syncingAt, mine: mine, here: here, wait: TAKEOVER_MS - age, takeOver: takeOver }; return; }
        token.tookOver = { at: c.syncingAt };
      }
      var next = copyOf(c);
      next.syncing = true; next.syncingAt = token.at; next.syncingBy = token.by; next.syncingByName = nameOf(profile);
      return next;
    }, undefined, false).then(function (r) {
      if (r && r.committed) return token;
      if (why && why.site) throw fail('site-mode', 'The site is the record now, so Refresh from sheet is off.');
      if (why && why.here) throw fail('locked', 'A refresh is already running on this page. Wait for it to finish.');
      if (why && why.mine && why.takeOver) {
        throw fail('locked', 'A refresh you started ' + minutesAgo(why.at) + ' on another page or tab still holds the lock. If that page is still open, ' +
          'let it finish there. If you closed it, press Refresh again ' + inAbout(why.wait) + ' and this page takes it over.');
      }
      if (why) throw fail('locked', 'Another refresh is running (started ' + minutesAgo(why.at) + ' by ' + why.by + '). Wait a few minutes and try again.');
      throw fail('lock', 'Could not start the refresh. Try again.');
    });
  }

  /**
   * Let go of our lock. done = { at } also records the finished copy (lastSyncAt/By/ByName) and clears
   * copyIncomplete. Without done (a failure) copyIncomplete stays as it is. A lock that is not ours any more
   * (taken over) is left alone.
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
    }, undefined, false).then(function (r) { return !!(r && r.committed); }, function () { return false; });
  }

  /** The lock is this run's: syncingAt/By are its token (the same test as release). */
  function ours(cur, token) { return !!cur && cur.syncingBy === token.by && cur.syncingAt === token.at; }

  function leftPage() { return fail('left-page', 'The page was left while the refresh ran, so it stopped.'); }
  function siteNow(wrote) {
    return fail('site-mode', 'The site became the record while this refresh ran, so it stopped' + (wrote ? ' and wrote nothing more.' : '. Nothing was changed.'));
  }

  /**
   * The lock is not this run's any more: the error that stops it. wrote = it had written part of the copy.
   * Either way the run writes nothing more, and in particular it leaves settings/mode/copyIncomplete alone:
   *  - It set the mark itself before its first write, and only a run that finishes a whole copy clears it.
   *  - If the run that took over is still going, the mark is that run's now: it clears it only after it has
   *    rewritten every node that differs from the sheet, the ones this run wrote included.
   *  - If that run (or a later one) already finished, its finished copy is newer than anything this run
   *    knows, and setting the mark again would overwrite that newer state.
   *  - If it failed, the mark is still set and the banner and refreshIfStale already treat the copy as
   *    unfinished.
   * So whenever setting the mark would be safe (nobody running, no newer finished copy), it is set already,
   * and whenever it is not set, setting it would overwrite a newer finished copy.
   */
  function takenOver(wrote) {
    return wrote
      ? fail('taken-over', 'Another refresh took over this one partway, so it stopped and wrote nothing more. The refresh that took over makes the whole copy again.')
      : fail('taken-over', 'Another refresh took over this one before it wrote anything, so it stopped. Nothing was changed.');
  }

  /**
   * Before the first write: mark the copy unfinished, in a transaction that first checks the lock is still
   * ours (another refresh took it over: stop before writing). Resolves once the server has the mark.
   */
  function markUnfinished(run) {
    if (run.left) return Promise.reject(leftPage());
    var marked = false, site = false;
    return db().ref('settings/mode').transaction(function (cur) {
      marked = false; site = false;
      if (cur === null) return null;                                   // not cached yet: the server answers with the real value
      if (cur.source === 'site') { site = true; return; }              // the switch to the site happened meanwhile
      if (!ours(cur, run.token)) return;                               // not ours any more
      var next = copyOf(cur);
      next.copyIncomplete = true;
      marked = true;
      return next;
    }, undefined, false).then(function (r) {
      if (site) throw siteNow(false);
      if (!(r && r.committed && marked)) throw takenOver(false);
    });
  }

  /**
   * Before every later write (each node, each ledger chunk, the settings, the report): stop unless the lock
   * is still ours and the page was not left. wrote = the run has written part of the copy already.
   */
  function stillOurs(run, wrote) {
    if (run.left) return Promise.reject(leftPage());
    return val('settings/mode').then(function (cur) {
      if (run.left) throw leftPage();
      if (cur && cur.source === 'site') throw siteNow(wrote);
      if (!ours(cur, run.token)) throw takenOver(wrote);
    });
  }

  // ── Leaving the page while a refresh runs ──

  function onBeforeUnload(e) {
    if (!active || !active.token || active.ended || active.lost) return undefined;
    var msg = 'A refresh from the Tracker sheet is running. Leaving now stops it partway.';
    if (e) { if (typeof e.preventDefault === 'function') e.preventDefault(); e.returnValue = msg; }
    return msg;
  }

  /**
   * The page is going away: let go of the lock and log the run (best effort: a page that is killed runs no
   * code, and then the lock stays until the same admin takes it over or it is LOCK_MS old). If the page comes
   * back (back/forward cache), the run stops at its next write ('left-page').
   */
  function onPageHide() {
    var run = active;
    if (!run || !run.token || run.ended || run.left || run.lost) return;
    run.left = true;
    try { release(run.token, run.profile, null); } catch (e) {}
    try {
      Promise.resolve(db().ref('imports').push({ kind: 'sheetSync', term: run.term() || '', at: run.iso, by: run.profile.uid, byName: nameOf(run.profile),
        status: run.wrote() ? 'partial' : 'failed', auto: !!run.auto, code: 'left-page', error: 'The page was closed or left while the refresh ran.' })).catch(function () {});
    } catch (e) {}
  }

  function dropHandlers() {
    if (typeof global.removeEventListener !== 'function') return;
    global.removeEventListener('beforeunload', onBeforeUnload);
    global.removeEventListener('pagehide', onPageHide);
  }

  /**
   * Right after taking the lock: the page handlers, plus a watch on settings/mode. When another refresh takes
   * the lock (run.lost), the handlers go at once: leaving then stops nothing of ours, and pagehide must not log
   * this run as 'left-page'. The run itself stops at its next write (stillOurs).
   */
  function guard(run) {
    active = run;
    if (typeof global.addEventListener === 'function') {
      global.addEventListener('beforeunload', onBeforeUnload);
      global.addEventListener('pagehide', onPageHide);
    }
    try {
      run.watch = db().ref('settings/mode');
      run.onMode = function (snap) {
        var v = snap && snap.val ? snap.val() : null;
        if (run.ended || run.lost || !v || ours(v, run.token)) return;
        run.lost = true;
        if (active === run) dropHandlers();
      };
      run.watch.on('value', run.onMode, function () {});
    } catch (e) { run.watch = null; }
  }

  /** The run is over (done or failed): drop the page handlers and the watch, and let go of the lock. */
  function finish(run, done) {
    run.ended = true;
    if (run.watch) { try { run.watch.off('value', run.onMode); } catch (e) {} run.watch = null; }
    if (active === run) active = null;
    if (!active) dropHandlers();
    return release(run.token, run.profile, done);
  }

  // ── Writes ──

  /** Write updates CHUNK paths at a time; before() → Promise runs before each chunk (it rejects to stop). */
  function chunkedUpdate(updates, before) {
    var keys = Object.keys(updates), chain = Promise.resolve();
    for (var i = 0; i < keys.length; i += CHUNK) {
      (function (slice) {
        chain = chain.then(function () { return before(); }).then(function () {
          var part = {};
          slice.forEach(function (k) { part[k] = updates[k]; });
          return db().ref().update(part);
        });
      })(keys.slice(i, i + CHUNK));
    }
    return chain;
  }

  function isEmpty(v) { return !v || typeof v !== 'object' || !Object.keys(v).length; }

  /**
   * Replace one term node whole. The ledger: clear the term (the only removal its rules allow), then add each
   * entry, CHUNK at a time. check() → Promise runs before each of the ledger's writes after its first (the
   * caller checked just before that one), so a run taken over between two chunks stops there.
   */
  function writeNode(name, term, current, next, check) {
    var path = name + '/' + term;
    if (name !== 'ledger') return db().ref(path).set(isEmpty(next) ? null : next);
    var updates = {};
    Object.keys(next || {}).forEach(function (uid) {
      Object.keys(next[uid] || {}).forEach(function (id) { updates[path + '/' + uid + '/' + id] = next[uid][id]; });
    });
    var first = true;
    function before() { if (first) { first = false; return Promise.resolve(); } return check(); }
    return (current ? before().then(function () { return db().ref(path).set(null); }) : Promise.resolve()).then(function () { return chunkedUpdate(updates, before); });
  }

  // ── Refresh ──

  function refresh(profile, opts) {
    opts = opts || {};
    var say = typeof opts.onProgress === 'function' ? opts.onProgress : function () {};
    if (!isAdmin(profile)) return Promise.reject(fail('not-admin', 'Only admins can refresh from the sheet.'));
    var M = global.OpsMode;
    if (!M || !global.OpsCore) return Promise.reject(fail('setup', 'This page is missing js/ops-mode.js or js/ops-core.js.'));

    var S = null, run = null, started = Date.now(), iso = new Date(started).toISOString();
    var term = '', built = null, settingsRaw = null, wroteSomething = false, flagged = null;
    /**
     * Before every write of the copy. The first marks the copy unfinished (if the lock is still ours) and waits
     * until the server has the mark; every later one first checks the lock is still ours.
     */
    function beforeWrite() {
      if (!flagged) { flagged = markUnfinished(run).then(function () { wroteSomething = true; }); return flagged; }
      return flagged.then(check);
    }
    /** The lock is still ours (before a write inside a node, and before the report). */
    function check() { return stillOurs(run, wroteSomething); }
    function tookOverAt() { return run && run.token.tookOver ? run.token.tookOver.at : null; }

    return Promise.all([ensureCore(), M.load(true)]).then(function (r) {
      S = r[0];
      if (!M.isSheet(r[1])) throw fail('site-mode', 'The site is the record now, so Refresh from sheet is off.');
      if (opts.dryRun) return null;
      return acquire(profile, !opts.auto).then(function (t) {
        run = { token: t, profile: profile, auto: !!opts.auto, iso: iso, left: false, ended: false,
          term: function () { return term; }, wrote: function () { return wroteSomething; } };
        guard(run);
      });
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
      return save(S, profile, opts, term, built, settingsRaw, iso, say, beforeWrite, check, tookOverAt()).then(function (res) {
        say('Done.');
        return finish(run, { at: Date.now() }).then(function (released) {
          // Not released: the lock changed hands after the last check, or the release failed. The copy is
          // saved, but it is not recorded as finished (copyIncomplete stays), so the next refresh redoes it.
          if (!released) throw fail('release', 'The copy was saved, but the refresh could not record that it finished (another refresh took over, or the connection dropped). The next refresh tidies it up.');
          return summary(S, built, { at: iso, profile: profile, opts: opts, changed: res.changed, before: res.before });
        });
      });
    }).catch(function (err) {
      var msg = (err && err.message) || String(err);
      var code = (err && err.code) || 'error';
      var cleanup = Promise.resolve();
      if (run && !run.ended) {
        var r = run;
        cleanup = finish(r, null).then(function () {
          if (r.left) return null;   // the pagehide handler logged it already
          return db().ref('imports').push({ kind: 'sheetSync', term: term || '', at: iso, by: profile.uid, byName: nameOf(profile), status: wroteSomething ? 'partial' : 'failed',
            auto: !!opts.auto, code: code, error: msg.slice(0, 500), tookOverLockAt: tookOverAt() }).catch(function () {});
        });
      }
      return cleanup.then(function () {
        // Taken over: the copy is the other refresh's job now (takenOver says so), so no "Refresh again".
        if (wroteSomething && code !== 'shrink' && code !== 'taken-over' && code !== 'release' && code !== 'site-mode') err.message = msg + ' Part of the copy may be new and part old. Refresh again.';
        throw err;
      });
    });
  }

  /**
   * beforeWrite() → Promise: runs before every node and before the settings write; the first call marks the
   * copy unfinished, every later one checks the lock is still ours.
   * check() → Promise: checks the lock is still ours, before each later write inside a node (the ledger's
   * chunks) and before the report and log rows. Both reject ('taken-over') when the lock is not ours any more.
   */
  function save(S, profile, opts, term, built, settingsRaw, iso, say, beforeWrite, check, tookOverLockAt) {
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
          return beforeWrite().then(function () { return writeNode(n, term, cur[i], nodes[n], check); });
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
        return check();
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
            counts: built.counts, changedNodes: changedCount, mismatches: c.mismatches.length, unmatched: built.unmatched.length, tookOverLockAt: tookOverLockAt || null }),
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
   * cut off partway leaves a half-written copy until the next try. opts.onProgress(text) gets the same steps
   * as a button press. It never takes over a lock, not even the same admin's own.
   */
  function refreshIfStale(profile, opts) {
    opts = opts || {};
    if (!isAdmin(profile) || !global.OpsMode || opts.page === 'home') return Promise.resolve(null);
    if (autoRun) return autoRun;
    var M = global.OpsMode;
    autoRun = M.load(true).then(function (mode) {
      if (!M.isSheet(mode) || !M.isStale(mode) || recentFailure()) return null;
      if (typeof M.isSyncing === 'function' ? M.isSyncing(mode) : lockHeld(mode)) return null;   // a live lock: that refresh will finish
      return refresh(profile, { auto: true, onProgress: opts.onProgress }).then(function (s) { noteFailure(false); return s; }, function (err) {
        if (err && (err.code === 'locked' || err.code === 'taken-over' || err.code === 'site-mode')) return null;   // another refresh has it
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
    TAKEOVER_MS: TAKEOVER_MS,
    GATEWAY_TIMEOUT_MS: GATEWAY_TIMEOUT_MS,
    refresh: refresh,
    refreshIfStale: refreshIfStale,
    termSettings: termSettings,
    gatewayVersion: gatewayVersion,
    ensureCore: ensureCore
  };
})(window);
