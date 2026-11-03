/**
 * OpsMode: who owns the tracker data right now.
 *
 * While settings/mode/source is 'sheet' (and whenever nothing is stored there), the chapter Tracker
 * sheet is the source of truth. The site shows a read-only copy made by "Refresh from sheet" (import.html),
 * brothers keep submitting through the Google Forms below, and no page writes tracker data: anything
 * written on the site would be replaced at the next refresh. An admin sets source to 'site' at the
 * cut-over (planned for Spring 2027); from then on the site's own pages and forms are the record.
 *
 * Node (readable by every approved member, writable by admins and settings holders):
 *   settings/mode = { source: 'sheet'|'site', forms: { excuse, service }, lastSyncAt, lastSyncBy,
 *                     lastSyncByName, syncing, syncingAt, copyIncomplete }
 * copyIncomplete is set before a refresh writes anything and cleared only after it finishes, so a
 * refresh that stopped partway is visible and is retried.
 * Depends on firebase-config.js. Plain ES5.
 */
(function (global) {
  'use strict';

  /** The chapter's Google Forms (same links as the portal home before Chapter Ops). */
  var FORMS = {
    excuse: 'https://docs.google.com/forms/d/e/1FAIpQLSeSfcDvaUI_R1Q1Mxvc2lhzC2yfzgaWraVsN-dKWc6OS9coOg/viewform',
    service: 'https://forms.gle/t7JE3kjKJ42rEM5Y9'
  };
  /** A copy older than this is refreshed on its own when an admin opens a preview page. */
  var STALE_MS = 24 * 60 * 60 * 1000;
  /** A refresh lock older than this is treated as dead (same as PortalSync.LOCK_MS). */
  var LOCK_MS = 10 * 60 * 1000;

  var cache = null;

  function normalise(v) {
    v = v || {};
    var forms = v.forms || {};
    return {
      source: v.source === 'site' ? 'site' : 'sheet',
      forms: { excuse: forms.excuse || FORMS.excuse, service: forms.service || FORMS.service },
      lastSyncAt: typeof v.lastSyncAt === 'number' ? v.lastSyncAt : null,
      lastSyncBy: v.lastSyncBy || null,
      lastSyncByName: v.lastSyncByName || null,
      syncing: v.syncing === true,
      syncingAt: typeof v.syncingAt === 'number' ? v.syncingAt : null,
      copyIncomplete: v.copyIncomplete === true
    };
  }

  /** Promise of the current mode. Cached per page load unless force. A read failure means 'sheet'. */
  function load(force) {
    if (cache && !force) return Promise.resolve(cache);
    return firebase.database().ref('settings/mode').once('value').then(function (s) {
      cache = normalise(s.val());
      return cache;
    }, function () {
      cache = normalise(null);
      return cache;
    });
  }

  /** True while the Tracker sheet is the source of truth (the default). */
  function isSheet(mode) { return !mode || mode.source !== 'site'; }

  /** The Google Form for 'excuse' or 'service'. */
  function formUrl(kind, mode) {
    var forms = (mode && mode.forms) || FORMS;
    return forms[kind] || FORMS[kind];
  }

  /** True when the copy is missing, unfinished, or older than a day. */
  function isStale(mode, now) {
    if (!mode || !mode.lastSyncAt || mode.copyIncomplete) return true;
    return (now || Date.now()) - mode.lastSyncAt > STALE_MS;
  }

  /** True while a refresh really holds the lock (a lock older than LOCK_MS is dead). */
  function isSyncing(mode, now) {
    return !!(mode && mode.syncing && mode.syncingAt && (now || Date.now()) - mode.syncingAt < LOCK_MS);
  }

  /** "today at 3:40 PM", "yesterday at 9:05 AM" or "Nov 2 at 9:05 AM". */
  function when(ms) {
    if (!ms) return 'never';
    var d = new Date(ms), now = new Date();
    var time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    var day = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (ms >= day) return 'today at ' + time;
    if (ms >= day - 86400000) return 'yesterday at ' + time;
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' at ' + time;
  }

  /**
   * Fill `el` with the preview notice for a page that shows the sheet copy.
   * opts.what: optional words for what the page shows, e.g. 'attendance'.
   */
  function banner(el, mode, opts) {
    if (!el) return;
    opts = opts || {};
    if (!isSheet(mode)) { el.hidden = true; el.textContent = ''; return; }
    var copied = mode && mode.lastSyncAt
      ? 'Copied from the Tracker sheet ' + when(mode.lastSyncAt) + (mode.lastSyncByName ? ' by ' + mode.lastSyncByName : '') + '.'
      : 'Nothing has been copied from the Tracker sheet yet.';
    // While a refresh holds the lock, copyIncomplete is that refresh's own mark, not one that stopped.
    if (mode && mode.copyIncomplete && !isSyncing(mode)) copied += ' The last refresh stopped partway, so some numbers may be missing until an admin refreshes again.';
    el.hidden = false;
    el.className = (el.className ? el.className + ' ' : '') + 'ops-mode-banner';
    el.setAttribute('role', 'note');
    el.innerHTML = '';
    var strong = document.createElement('strong');
    strong.textContent = 'Preview. ';
    el.appendChild(strong);
    el.appendChild(document.createTextNode(copied + ' The Tracker sheet is still the record this semester: make changes there' +
      (opts.what ? ' (' + opts.what + ')' : '') + ', and they show here after the next refresh.'));
  }

  global.OpsMode = {
    FORMS: FORMS,
    STALE_MS: STALE_MS,
    LOCK_MS: LOCK_MS,
    load: load,
    isSheet: isSheet,
    formUrl: formUrl,
    isStale: isStale,
    isSyncing: isSyncing,
    when: when,
    banner: banner,
    _normalise: normalise
  };
})(window);
