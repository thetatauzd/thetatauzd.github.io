/**
 * Brother voting: enter access code, see current poll, submit vote.
 * Poll types: rush_prelim/ranked (scorecard), rush_bid/motion/pnm_vote (yes/no/abstain),
 *   pnm_depledge (yes/no), regular (session-defined options).
 * Persists session in sessionStorage so page refresh auto-rejoins.
 * Detects kick (connectedBrothers/{uid} removed) and session end (meta/status = 'ended').
 */
(function() {
  'use strict';

  var db = firebase.database();
  var sessionId = null;
  var currentPoll = null;
  var currentPollListener = null;
  var presenceListener = null;
  var metaListener = null;
  var disconnected = false;
  var trackedPollId = null;
  var cachedPollOrder = [];
  var cachedPollIndex = 0;
  var sessionMeta = null;       // holds sessionType, voteOptions
  var unloadHandlerAdded = false;

  var STORAGE_KEY = 'voting_session';

  function showStep(step) {
    ['step-enter-code', 'step-waiting', 'step-vote', 'step-kicked', 'step-ended'].forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.classList.toggle('hidden', id !== step);
    });
  }

  function showJoinError(msg) {
    var el = document.getElementById('join-error');
    if (el) {
      el.textContent = msg || '';
      el.classList.toggle('hidden', !msg);
    }
  }

  function debugMsg(msg) {
    var el = document.getElementById('waiting-debug');
    if (el) el.textContent = msg;
  }

  function updatePollCounter() {
    var text = '';
    if (cachedPollOrder.length > 0) {
      text = 'Poll ' + (cachedPollIndex + 1) + ' of ' + cachedPollOrder.length;
    }
    var el1 = document.getElementById('poll-counter');
    var el2 = document.getElementById('vote-counter');
    if (el1) el1.textContent = text;
    if (el2) el2.textContent = text;
  }

  // ── Session persistence ──

  function saveVotingSession() {
    if (sessionId) {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ sid: sessionId }));
    }
  }

  function clearVotingSession() {
    sessionStorage.removeItem(STORAGE_KEY);
  }

  function getSavedVotingSession() {
    try {
      var raw = sessionStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  // ── Next up display ──

  function showNextUp(targetEl) {
    if (!targetEl || !sessionId) return;

    // If current poll is not yet open, show its name as "up next"
    if (currentPoll && currentPoll.status && currentPoll.status !== 'open') {
      targetEl.textContent = 'Up next: ' + (currentPoll.name || 'Poll');
      targetEl.classList.remove('hidden');
      return;
    }

    var nextIdx = cachedPollIndex + 1;
    if (nextIdx >= cachedPollOrder.length) {
      targetEl.textContent = '';
      targetEl.classList.add('hidden');
      return;
    }
    var nextPid = cachedPollOrder[nextIdx];
    if (!nextPid) return;
    db.ref('sessions/' + sessionId + '/polls/' + nextPid + '/name').once('value').then(function(s) {
      var name = s.val();
      if (name) {
        targetEl.textContent = 'Up next: ' + name;
        targetEl.classList.remove('hidden');
      }
    }).catch(function() {});
  }

  var scorecardState = {};

  function renderVoteOptions(poll, hasVoted, myVote) {
    var container = document.getElementById('vote-options');
    var confirmEl = document.getElementById('vote-confirm');
    var errorEl = document.getElementById('vote-error');
    if (!container) return;
    container.innerHTML = '';
    if (errorEl) errorEl.classList.add('hidden');
    if (hasVoted) {
      if (confirmEl) confirmEl.classList.remove('hidden');
      showNextUp(document.getElementById('vote-next'));
      return;
    }
    if (confirmEl) confirmEl.classList.add('hidden');
    var voteNextEl = document.getElementById('vote-next');
    if (voteNextEl) voteNextEl.classList.add('hidden');

    var type = poll.type;

    // Scorecard voting: rush_prelim (new name) and ranked (existing sessions)
    if (type === 'rush_prelim' || type === 'ranked') {
      renderScorecard(poll, container);
      return;
    }

    // Session-defined options (regular votes: Yes/No, Yes/No/IDK, custom)
    if (type === 'regular') {
      var choices = (sessionMeta && sessionMeta.voteOptions) || [];
      if (choices.length === 0) {
        container.innerHTML = '<p style="color:#c62828;">No vote options configured for this session.</p>';
        return;
      }
      choices.forEach(function(v) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'vote-btn';
        if (myVote === v) btn.classList.add('voted');
        btn.textContent = v;
        btn.addEventListener('click', function() {
          if (hasVoted) return;
          submitVote(v);
        });
        container.appendChild(btn);
      });
      return;
    }

    // Yes/No/Abstain types
    var ynaChoices = [];
    if (type === 'rush_bid' || type === 'motion' || type === 'pnm_vote') {
      ynaChoices = ['yes', 'no', 'abstain'];
    } else if (type === 'pnm_depledge') {
      ynaChoices = ['yes', 'no'];
    }

    ynaChoices.forEach(function(v) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'vote-btn';
      if (myVote === v) btn.classList.add('voted');
      btn.textContent = v.charAt(0).toUpperCase() + v.slice(1);
      btn.addEventListener('click', function() {
        if (hasVoted) return;
        submitVote(v);
      });
      container.appendChild(btn);
    });
  }

  function renderScorecard(poll, container) {
    var candidates = poll.candidates || [];
    if (candidates.length === 0) {
      container.innerHTML = '<p>No candidates listed for this poll.</p>';
      return;
    }
    scorecardState = {};
    var scores = ['+2', '+1', '0', '-1', '-2'];

    var wrapper = document.createElement('div');
    wrapper.style.cssText = 'max-height:60vh; overflow-y:auto; border:1px solid #ddd; border-radius:8px; padding:0.5rem;';

    candidates.forEach(function(name, idx) {
      scorecardState[name] = null;
      var row = document.createElement('div');
      row.style.cssText = 'display:flex; align-items:center; justify-content:space-between; padding:0.5rem 0.25rem; border-bottom:1px solid #eee; flex-wrap:wrap; gap:0.25rem;';
      if (idx === candidates.length - 1) row.style.borderBottom = 'none';

      var label = document.createElement('span');
      label.style.cssText = 'font-weight:600; min-width:120px; flex:1;';
      label.textContent = name;
      row.appendChild(label);

      var btnGroup = document.createElement('div');
      btnGroup.style.cssText = 'display:flex; gap:0.35rem; flex-wrap:wrap;';

      scores.forEach(function(s) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'vote-btn';
        btn.style.cssText = 'min-width:42px; min-height:38px; padding:0.3rem 0.5rem; font-size:0.9rem;';
        if (s.indexOf('+') === 0) btn.classList.add('ranked-plus');
        else if (s.indexOf('-') === 0) btn.classList.add('ranked-minus');
        btn.textContent = s;
        btn.addEventListener('click', function() {
          scorecardState[name] = s;
          btnGroup.querySelectorAll('.vote-btn').forEach(function(b) { b.classList.remove('voted'); });
          btn.classList.add('voted');
          updateScorecardProgress(candidates.length);
        });
        btnGroup.appendChild(btn);
      });

      row.appendChild(btnGroup);
      wrapper.appendChild(row);
    });
    container.appendChild(wrapper);

    var progress = document.createElement('p');
    progress.id = 'scorecard-progress';
    progress.style.cssText = 'text-align:center; margin:0.75rem 0 0.5rem; font-weight:600; color:#888;';
    progress.textContent = '0 / ' + candidates.length + ' rated';
    container.appendChild(progress);

    var submitBtn = document.createElement('button');
    submitBtn.type = 'button';
    submitBtn.className = 'btn btn-primary';
    submitBtn.id = 'btn-submit-scorecard';
    submitBtn.style.cssText = 'display:block; margin:0 auto; padding:0.75rem 2rem; font-size:1.1rem;';
    submitBtn.textContent = 'Submit All Ratings';
    submitBtn.addEventListener('click', function() {
      submitScorecard();
    });
    container.appendChild(submitBtn);
  }

  function updateScorecardProgress(total) {
    var rated = Object.keys(scorecardState).filter(function(k) { return scorecardState[k] !== null; }).length;
    var el = document.getElementById('scorecard-progress');
    if (el) {
      el.textContent = rated + ' / ' + total + ' rated';
      el.style.color = rated === total ? '#2e7d32' : '#888';
    }
  }

  function submitScorecard() {
    var keys = Object.keys(scorecardState);
    var unrated = keys.filter(function(k) { return scorecardState[k] === null; });
    if (unrated.length > 0) {
      var errorEl = document.getElementById('vote-error');
      if (errorEl) {
        errorEl.textContent = 'You must rate all ' + keys.length + ' candidates. ' + unrated.length + ' remaining.';
        errorEl.classList.remove('hidden');
      }
      return;
    }
    var ballot = {};
    keys.forEach(function(name) {
      ballot[name] = parseInt(scorecardState[name], 10);
    });

    var errorEl = document.getElementById('vote-error');
    var submitBtn = document.getElementById('btn-submit-scorecard');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Submitting...';
    }

    submitVote(ballot, function onDone(success) {
      if (!success && submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit All Ratings';
      }
    });
  }

  function submitVote(vote, doneCb) {
    var uid = firebase.auth().currentUser && firebase.auth().currentUser.uid;
    if (!sessionId || !currentPoll || !uid) return;
    var errorEl = document.getElementById('vote-error');

    var updates = {};
    updates['sessions/' + sessionId + '/polls/' + currentPoll.pollId + '/votes/' + uid] = {
      vote: vote,
      votedAt: firebase.database.ServerValue.TIMESTAMP
    };
    updates['sessions/' + sessionId + '/polls/' + currentPoll.pollId + '/hasVoted/' + uid] = true;

    db.ref().update(updates).then(function() {
      if (errorEl) errorEl.classList.add('hidden');
      renderVoteOptions(currentPoll, true, vote);
      if (doneCb) doneCb(true);
    }).catch(function(err) {
      if (errorEl) {
        errorEl.textContent = err.message || 'Failed to submit vote.';
        errorEl.classList.remove('hidden');
      }
      if (doneCb) doneCb(false);
    });
  }

  // ── Listener management ──

  function detachPollListener() {
    if (currentPollListener) { currentPollListener(); currentPollListener = null; }
  }

  function detachAllListeners() {
    detachPollListener();
    if (presenceListener) { presenceListener(); presenceListener = null; }
    if (metaListener) { metaListener(); metaListener = null; }
    if (sessionId) {
      db.ref('sessions/' + sessionId + '/currentPollIndex').off();
      db.ref('sessions/' + sessionId + '/pollOrder').off();
    }
  }

  function resetToCodeEntry() {
    detachAllListeners();
    sessionId = null;
    currentPoll = null;
    trackedPollId = null;
    disconnected = false;
    sessionMeta = null;
    clearVotingSession();
    showStep('step-enter-code');
    document.getElementById('access-code').value = '';
    debugMsg('');
  }

  // ── Kick detection ──

  function listenForKick(sid, uid) {
    if (!sid || !uid) return;
    var ref = db.ref('sessions/' + sid + '/connectedBrothers/' + uid);
    var hasReceivedFirst = false;
    var cb = ref.on('value', function(snap) {
      if (!hasReceivedFirst) {
        hasReceivedFirst = true;
        if (!snap.exists()) return;
        return;
      }
      if (!snap.exists() && !disconnected) {
        disconnected = true;
        detachAllListeners();
        clearVotingSession();
        showStep('step-kicked');
      }
    }, function() {});
    presenceListener = function() { ref.off('value', cb); };
  }

  // ── Session end detection ──

  function listenForSessionEnd(sid) {
    if (!sid) return;
    var ref = db.ref('sessions/' + sid + '/meta/status');
    var cb = ref.on('value', function(snap) {
      var status = snap.val();
      if (status === 'ended' && !disconnected) {
        disconnected = true;
        detachAllListeners();
        clearVotingSession();
        showStep('step-ended');
      }
    }, function() {});
    metaListener = function() { ref.off('value', cb); };
  }

  // ── Poll listening ──

  function listenToCurrentPoll(pollId) {
    detachPollListener();
    if (!pollId || !sessionId) return;

    var ref = db.ref('sessions/' + sessionId + '/polls/' + pollId);
    var cb = ref.on('value', function(snap) {
      if (disconnected) return;
      var p = snap.val();
      if (!p) {
        debugMsg('Poll data not found.');
        showStep('step-waiting');
        return;
      }

      currentPoll = {
        pollId: pollId,
        name: p.name,
        type: p.type,
        candidates: p.candidates || [],
        options: p.options || [],
        threshold: p.threshold != null ? p.threshold : 75,
        minimumScore: p.minimumScore != null ? p.minimumScore : 0,
        status: p.status || 'closed'
      };

      if (p.status !== 'open') {
        debugMsg('');
        updatePollCounter();
        showNextUp(document.getElementById('waiting-next'));
        showStep('step-waiting');
        return;
      }

      showStep('step-vote');
      updatePollCounter();
      document.getElementById('poll-title').textContent = p.name || 'Poll';
      var typeLabel = document.getElementById('poll-type-label');
      if (typeLabel) {
        var labels = {
          rush_prelim:  'Rate each candidate +2 to -2',
          ranked:       'Rate each candidate +2 to -2',
          rush_bid:     'Yes / No / Abstain',
          motion:       'Yes / No / Abstain',
          pnm_vote:     'Yes / No / Abstain',
          pnm_depledge: 'Yes / No',
          regular:      ''
        };
        typeLabel.textContent = labels[p.type] != null ? labels[p.type] : p.type;
      }

      var uid = firebase.auth().currentUser && firebase.auth().currentUser.uid;
      if (uid && p.votes && p.votes[uid]) {
        renderVoteOptions(currentPoll, true, p.votes[uid].vote);
      } else if (uid) {
        db.ref('sessions/' + sessionId + '/polls/' + pollId + '/votes/' + uid).once('value').then(function(vSnap) {
          var my = vSnap.val();
          renderVoteOptions(currentPoll, !!my, my && my.vote);
        }).catch(function() {
          renderVoteOptions(currentPoll, false, null);
        });
      } else {
        renderVoteOptions(currentPoll, false, null);
      }
    }, function(err) {
      debugMsg('Error listening to poll: ' + err.message);
      showStep('step-waiting');
    });

    currentPollListener = function() { ref.off('value', cb); };
  }

  function resolveCurrentPollId(cb) {
    Promise.all([
      db.ref('sessions/' + sessionId + '/currentPollIndex').once('value'),
      db.ref('sessions/' + sessionId + '/pollOrder').once('value')
    ]).then(function(results) {
      var idx = results[0].val();
      var order = results[1].val();
      cachedPollIndex = typeof idx === 'number' ? idx : 0;
      cachedPollOrder = Array.isArray(order) ? order : [];
      updatePollCounter();
      if (typeof idx !== 'number' || !Array.isArray(order) || !order[idx]) {
        cb(null, idx, order);
      } else {
        cb(order[idx], idx, order);
      }
    }).catch(function(err) {
      debugMsg('Error reading session: ' + err.message);
      cb(null);
    });
  }

  function startListening() {
    if (!sessionId) return;

    function onIndexOrOrderChange() {
      if (disconnected) return;
      resolveCurrentPollId(function(pollId, idx, order) {
        if (!pollId) {
          debugMsg('No polls queued yet (index=' + idx + ', polls=' + (order ? order.length : 0) + ').');
          showStep('step-waiting');
          detachPollListener();
          trackedPollId = null;
          return;
        }
        if (pollId !== trackedPollId) {
          trackedPollId = pollId;
          debugMsg('Switched to poll ' + (idx + 1) + '/' + order.length + '...');
          listenToCurrentPoll(pollId);
        }
      });
    }

    db.ref('sessions/' + sessionId + '/currentPollIndex').on('value', onIndexOrOrderChange);
    db.ref('sessions/' + sessionId + '/pollOrder').on('value', onIndexOrOrderChange);
  }

  // ── Join / rejoin session ──

  function connectToSession(sid, uid) {
    sessionId = sid;
    disconnected = false;
    saveVotingSession();
    showStep('step-waiting');
    debugMsg('Joined session. Connecting...');

    // Load session meta for vote options
    db.ref('sessions/' + sid + '/meta').once('value').then(function(snap) {
      sessionMeta = snap.val() || {};
    }).catch(function() {
      sessionMeta = {};
    });

    if (uid) {
      db.ref('sessions/' + sid + '/connectedBrothers/' + uid).set(firebase.database.ServerValue.TIMESTAMP).then(function() {
        listenForKick(sid, uid);
      }).catch(function(err) {
        debugMsg('Presence write failed: ' + err.message);
      });

      if (!unloadHandlerAdded) {
        unloadHandlerAdded = true;
        window.addEventListener('beforeunload', function() {
          var curSid = sessionId;
          var curUid = firebase.auth().currentUser && firebase.auth().currentUser.uid;
          if (curSid && curUid) {
            db.ref('sessions/' + curSid + '/connectedBrothers/' + curUid).remove();
          }
        });
      }
    }

    listenForSessionEnd(sid);
    startListening();
  }

  function joinSession(code) {
    code = (code || '').toUpperCase().replace(/\s/g, '');
    if (!code) { showJoinError('Please enter the access code.'); return; }
    showJoinError('');

    db.ref('sessionByCode/' + code).once('value').then(function(snap) {
      var sid = snap.val();
      if (!sid) {
        showJoinError('Invalid or expired code. (No session found for "' + code + '")');
        return;
      }

      db.ref('sessions/' + sid + '/meta/status').once('value').then(function(metaSnap) {
        if (metaSnap.val() === 'ended') {
          showJoinError('This session has already ended.');
          return;
        }

        var uid = firebase.auth().currentUser && firebase.auth().currentUser.uid;
        connectToSession(sid, uid);
      });
    }).catch(function(err) {
      showJoinError('Could not join: ' + (err.message || 'unknown error'));
    });
  }

  function tryAutoRejoin(uid) {
    var saved = getSavedVotingSession();
    if (!saved || !saved.sid) return false;

    db.ref('sessions/' + saved.sid + '/meta/status').once('value').then(function(snap) {
      if (snap.val() && snap.val() !== 'ended') {
        connectToSession(saved.sid, uid);
      } else {
        clearVotingSession();
      }
    }).catch(function() {
      clearVotingSession();
    });

    return true;
  }

  // ── Init ──

  function init() {
    PortalAuth.requireAuth({ redirect: true }).then(function(profile) {
      if (!profile || profile.role === 'pending') return;
      PortalAuth.initNav(profile);

      document.getElementById('btn-join').addEventListener('click', function() {
        joinSession(document.getElementById('access-code').value);
      });
      document.getElementById('access-code').addEventListener('keydown', function(e) {
        if (e.key === 'Enter') joinSession(this.value);
      });
      document.getElementById('btn-rejoin').addEventListener('click', resetToCodeEntry);
      document.getElementById('btn-rejoin-ended').addEventListener('click', resetToCodeEntry);

      var uid = firebase.auth().currentUser && firebase.auth().currentUser.uid;
      tryAutoRejoin(uid);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
