/**
 * Regent display board: current poll name, real-time list of brothers who have NOT voted, X/Y counter, "Poll complete" banner.
 * Uses shallow listen on hasVoted; reads connectedBrothers for roster. Reads users for names (Regent can read users per rules).
 */
(function(global) {
  'use strict';

  var sessionId = null;
  var currentPollId = null;
  var currentPollType = null;
  var unsubHasVoted = null;
  var unsubConnected = null;
  var unsubPoll = null;
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

  function renderBoard(connectedUids, hasVotedMap) {
    var votedCount = Object.keys(hasVotedMap || {}).length;
    var total = (connectedUids || []).length;
    var notVoted = (connectedUids || []).filter(function(uid) {
      return !(hasVotedMap || {})[uid];
    });
    loadUserNames(notVoted, function() {
      var listEl = document.getElementById('regent-not-voted');
      var counterEl = document.getElementById('regent-counter');
      var bannerEl = document.getElementById('regent-banner-complete');
      if (counterEl) counterEl.textContent = votedCount + ' / ' + total;
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

  function listenToHasVoted(sid) {
    var hasVotedRef = PortalDb.hasVotedRef(sid, currentPollId);
    if (unsubHasVoted) unsubHasVoted();
    unsubHasVoted = hasVotedRef.on('value', function(snap) {
      var voted = snap.val() || {};
      var connectedRef = PortalDb.connectedBrothersRef(sid);
      if (!connectedRef) return renderBoard([], voted);
      connectedRef.once('value', function(cSnap) {
        var conn = cSnap.val() || {};
        renderBoard(Object.keys(conn), voted);
      });
    });
  }

  function renderClosedVoteBoard() {
    var listEl = document.getElementById('regent-not-voted');
    var counterEl = document.getElementById('regent-counter');
    var bannerEl = document.getElementById('regent-banner-complete');
    if (counterEl) counterEl.textContent = '';
    if (listEl) listEl.innerHTML = '<li style="font-style:italic; color:#999;">Closed vote — details hidden</li>';
    if (bannerEl) bannerEl.classList.add('hidden');
  }

  function startListening(sid) {
    sessionId = sid;
    var pollOrderRef = PortalDb.sessionPollOrderRef(sid);
    var idxRef = PortalDb.sessionCurrentPollIndexRef(sid);
    if (!pollOrderRef || !idxRef) return;

    function updateCurrentPoll() {
      Promise.all([idxRef.once('value'), pollOrderRef.once('value')]).then(function(results) {
        var idx = results[0].val();
        var order = results[1].val();
        if (typeof idx !== 'number' || !Array.isArray(order) || !order[idx]) {
          document.getElementById('regent-poll-name').textContent = '—';
          document.getElementById('regent-type-label').textContent = '';
          if (unsubHasVoted) {
            unsubHasVoted();
            unsubHasVoted = null;
          }
          currentPollId = null;
          return;
        }
        currentPollId = order[idx];
        PortalDb.pollRef(sid, currentPollId).once('value').then(function(snap) {
          var p = snap.val();
          document.getElementById('regent-poll-name').textContent = (p && p.name) || '—';
          document.getElementById('regent-type-label').textContent = (p && p.type) || '';

          currentPollType = (p && p.type) || '';

          if (currentPollType === 'pnm_depledge') {
            if (unsubHasVoted) { unsubHasVoted(); unsubHasVoted = null; }
            renderClosedVoteBoard();
            return;
          }

          listenToHasVoted(sid);
        });
      });
    }
    idxRef.on('value', updateCurrentPoll);
    pollOrderRef.on('value', updateCurrentPoll);
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
