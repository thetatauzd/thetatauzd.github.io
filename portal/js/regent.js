/**
 * Regent display board: current poll name, real-time list of brothers who have NOT voted,
 * X/Y counter, "Poll complete" banner.
 * Uses a generation counter to prevent async races when polls change rapidly.
 */
(function(global) {
  'use strict';

  var sessionId = null;
  var currentPollId = null;
  var currentPollType = null;
  var unsubHasVoted = null;
  var unsubConnected = null;
  var idxRef = null;
  var pollOrderRef = null;
  var idxCb = null;
  var orderCb = null;
  var updateGeneration = 0;
  var userNames = {};

  function loadUserNames(uids, cb) {
    if (!firebase.database) return cb();
    var db = firebase.database();
    var loaded = 0;
    uids.forEach(function(uid) {
      if (userNames[uid]) {
        if (++loaded === uids.length) cb();
        return;
      }
      db.ref('users/' + uid).child('name').once('value', function(s) {
        userNames[uid] = s.val() || uid;
        if (++loaded === uids.length) cb();
      });
    });
    if (uids.length === 0) cb();
  }

  function showLiveBoard() {
    var w = document.getElementById('regent-waiting-open');
    var l = document.getElementById('regent-live-board');
    if (w) w.classList.add('hidden');
    if (l) l.classList.remove('hidden');
  }

  function showWaitingForOpen() {
    var w = document.getElementById('regent-waiting-open');
    var l = document.getElementById('regent-live-board');
    if (w) w.classList.remove('hidden');
    if (l) l.classList.add('hidden');
  }

  function renderBoard(connectedUids, hasVotedMap) {
    showLiveBoard();
    var votedCount = Object.keys(hasVotedMap || {}).length;
    var total = (connectedUids || []).length;
    var notVoted = (connectedUids || []).filter(function(uid) {
      return !(hasVotedMap || {})[uid];
    });
    loadUserNames(notVoted, function() {
      var listEl = document.getElementById('regent-not-voted');
      var counterEl = document.getElementById('regent-counter');
      var bannerEl = document.getElementById('regent-banner-complete');
      var headingEl = document.getElementById('regent-not-voted-heading');
      if (counterEl) counterEl.textContent = votedCount + ' / ' + total;
      if (headingEl) headingEl.textContent = notVoted.length > 0 ? 'Still need to vote (' + notVoted.length + '):' : '';
      if (listEl) {
        listEl.innerHTML = notVoted.map(function(uid) {
          return '<li>' + (userNames[uid] || uid) + '</li>';
        }).join('');
      }
      if (bannerEl) {
        bannerEl.classList.toggle('hidden', total === 0 || votedCount < total);
      }
    });
  }

  function clearBoard() {
    var listEl = document.getElementById('regent-not-voted');
    var counterEl = document.getElementById('regent-counter');
    var bannerEl = document.getElementById('regent-banner-complete');
    if (counterEl) counterEl.textContent = '';
    if (listEl) listEl.innerHTML = '';
    if (bannerEl) bannerEl.classList.add('hidden');
  }

  function listenToHasVoted(sid) {
    if (unsubHasVoted) unsubHasVoted();
    var hasVotedRef = PortalDb.hasVotedRef(sid, currentPollId);
    if (!hasVotedRef) { unsubHasVoted = null; return; }
    var cb = hasVotedRef.on('value', function(snap) {
      var voted = snap.val() || {};
      var connectedRef = PortalDb.connectedBrothersRef(sid);
      if (!connectedRef) return renderBoard([], voted);
      connectedRef.once('value', function(cSnap) {
        var conn = cSnap.val() || {};
        renderBoard(Object.keys(conn), voted);
      });
    });
    unsubHasVoted = function() { hasVotedRef.off('value', cb); };
  }

  function renderClosedVoteBoard() {
    var listEl = document.getElementById('regent-not-voted');
    var counterEl = document.getElementById('regent-counter');
    var bannerEl = document.getElementById('regent-banner-complete');
    if (counterEl) counterEl.textContent = '';
    if (listEl) listEl.innerHTML = '<li style="font-style:italic; color:#999;">Closed vote — details hidden</li>';
    if (bannerEl) bannerEl.classList.add('hidden');
  }

  var metaStatusRef = null;
  var metaStatusCb = null;

  function listenForSessionEnd(sid) {
    if (metaStatusRef && metaStatusCb) metaStatusRef.off('value', metaStatusCb);
    metaStatusRef = firebase.database().ref('sessions/' + sid + '/meta/status');
    metaStatusCb = metaStatusRef.on('value', function(snap) {
      if (snap.val() === 'ended') {
        var board = document.getElementById('regent-board');
        var ended = document.getElementById('regent-session-ended');
        if (board) board.classList.add('hidden');
        if (ended) ended.classList.remove('hidden');
      }
    });
  }

  function startListening(sid) {
    sessionId = sid;

    if (idxRef && idxCb) idxRef.off('value', idxCb);
    if (pollOrderRef && orderCb) pollOrderRef.off('value', orderCb);

    listenForSessionEnd(sid);

    pollOrderRef = PortalDb.sessionPollOrderRef(sid);
    idxRef = PortalDb.sessionCurrentPollIndexRef(sid);
    if (!pollOrderRef || !idxRef) return;

    function updateCurrentPoll() {
      var gen = ++updateGeneration;

      Promise.all([idxRef.once('value'), pollOrderRef.once('value')]).then(function(results) {
        if (gen !== updateGeneration) return; // stale callback

        var idx = results[0].val();
        var order = results[1].val();
        if (typeof idx !== 'number' || !Array.isArray(order) || !order[idx]) {
          document.getElementById('regent-poll-name').textContent = '—';
          document.getElementById('regent-type-label').textContent = '';
          if (unsubHasVoted) { unsubHasVoted(); unsubHasVoted = null; }
          currentPollId = null;
          currentPollType = null;
          clearBoard();
          return;
        }

        currentPollId = order[idx];
        PortalDb.pollRef(sid, currentPollId).on('value', function(snap) {
          if (gen !== updateGeneration) return;

          var p = snap.val();
          document.getElementById('regent-poll-name').textContent = (p && p.name) || '—';
          currentPollType = (p && p.type) || '';

          var headingEl = document.getElementById('regent-heading');
          if (p && p.status !== 'open') {
            if (headingEl) headingEl.textContent = 'Next poll';
            if (unsubHasVoted) { unsubHasVoted(); unsubHasVoted = null; }
            showWaitingForOpen();
            return;
          }
          if (headingEl) headingEl.textContent = 'Current poll';

          if (currentPollType === 'pnm_depledge') {
            if (unsubHasVoted) { unsubHasVoted(); unsubHasVoted = null; }
            showLiveBoard();
            renderClosedVoteBoard();
            return;
          }

          listenToHasVoted(sid);
        });
      });
    }

    idxCb = idxRef.on('value', updateCurrentPoll);
    orderCb = pollOrderRef.on('value', updateCurrentPoll);
    updateCurrentPoll();

    if (unsubConnected) unsubConnected();
    unsubConnected = PortalDb.onConnectedBrothers(sid, function() {
      if (currentPollType === 'pnm_depledge') return;
      if (currentPollId && PortalDb.hasVotedRef(sid, currentPollId)) {
        PortalDb.hasVotedRef(sid, currentPollId).once('value', function(snap) {
          var voted = snap.val() || {};
          PortalDb.connectedBrothersRef(sid).once('value', function(cSnap) {
            var conn = cSnap.val() || {};
            renderBoard(Object.keys(conn), voted);
          });
        });
      }
    });
  }

  function init() {
    PortalAuth.requireRegent().then(function(profile) {
      if (!profile) return;
      PortalAuth.initNav(profile);

      var board = document.getElementById('regent-board');
      var joinBox = document.getElementById('regent-join');
      var hash = (window.location.hash || '').replace(/^#/, '');

      function connectToSession(sid) {
        sessionId = sid;
        if (board) board.classList.remove('hidden');
        if (joinBox) joinBox.classList.add('hidden');
        startListening(sid);
      }

      if (hash) {
        connectToSession(hash);
      }

      var joinBtn = document.getElementById('btn-regent-join');
      var codeInput = document.getElementById('regent-code');
      var joinErr = document.getElementById('regent-join-error');

      function joinByCode() {
        var code = (codeInput.value || '').toUpperCase().replace(/\s/g, '');
        if (!code) { joinErr.textContent = 'Enter a code.'; joinErr.classList.remove('hidden'); return; }
        joinErr.classList.add('hidden');
        firebase.database().ref('sessionByCode/' + code).once('value').then(function(snap) {
          var sid = snap.val();
          if (!sid) { joinErr.textContent = 'No session found for "' + code + '".'; joinErr.classList.remove('hidden'); return; }
          window.location.hash = sid;
          connectToSession(sid);
        }).catch(function(err) {
          joinErr.textContent = 'Error: ' + err.message; joinErr.classList.remove('hidden');
        });
      }

      if (joinBtn) joinBtn.addEventListener('click', joinByCode);
      if (codeInput) codeInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') joinByCode(); });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(typeof window !== 'undefined' ? window : this);
