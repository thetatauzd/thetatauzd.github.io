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
  var roster = [];              // candidates parsed from an uploaded slide deck
  var rosterLoaded = false;

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
  // Prevents re-rendering vote buttons every time someone else votes (aggregation updates)
  var voteUIRendered = false;

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
      var choices = poll.options && poll.options.length
        ? poll.options
        : ((sessionMeta && sessionMeta.voteOptions) || []);
      if (choices.length === 0) {
        container.innerHTML = '<p style="color:#c62828;">No vote options configured for this session.</p>';
        return;
      }

      // Polls built from a slide deck show that candidate's card above the options.
      if (poll.rosterIndex !== null && roster[poll.rosterIndex]) {
        container.appendChild(buildCandidateCard(roster[poll.rosterIndex], poll.name));
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

  /**
   * Quiz-style scorecard: one candidate per screen, tapping a score advances to
   * the next, then a review screen submits the whole ballot at once. Ratings are
   * held locally until submit so brothers can go back and change any answer.
   */
  var quizIndex = 0;
  var quizNames = [];

  function candidateByName(name) {
    for (var i = 0; i < roster.length; i++) {
      if (roster[i] && roster[i].name === name) return roster[i];
    }
    return null;
  }

  /** Photo + number + name + slide info, laid out like the rushee slide. */
  function buildCandidateCard(cand, fallbackName) {
    var card = document.createElement('div');
    card.className = 'candidate-card';

    if (cand && cand.photo) {
      var img = document.createElement('img');
      img.className = 'candidate-photo';
      img.src = cand.photo;
      img.alt = cand.name || '';
      card.appendChild(img);
    }

    var body = document.createElement('div');
    body.className = 'candidate-body';

    var heading = document.createElement('h3');
    heading.className = 'candidate-name';
    heading.textContent = (cand && cand.number ? '#' + cand.number + '  ' : '') +
      ((cand && cand.name) || fallbackName || '');
    body.appendChild(heading);

    if (cand) {
      var facts = [
        ['GPA', cand.gpa],
        ['Major', cand.major],
        ['Class', cand.classStanding],
        ['Heard via', cand.heardVia]
      ].filter(function(f) { return f[1]; });

      if (facts.length) {
        var dl = document.createElement('div');
        dl.className = 'candidate-facts';
        facts.forEach(function(f) {
          var row = document.createElement('div');
          row.innerHTML = '<span class="cf-label"></span><span class="cf-value"></span>';
          row.querySelector('.cf-label').textContent = f[0];
          row.querySelector('.cf-value').textContent = f[1];
          dl.appendChild(row);
        });
        body.appendChild(dl);
      }

      if (cand.events && cand.events.length) {
        var ev = document.createElement('div');
        ev.className = 'candidate-events';
        cand.events.forEach(function(e) {
          var chip = document.createElement('span');
          chip.className = 'ev-chip' + (e.attended ? ' ev-yes' : '');
          chip.textContent = e.label;
          ev.appendChild(chip);
        });
        body.appendChild(ev);
      }
    }

    card.appendChild(body);
    return card;
  }

  function renderScorecard(poll, container) {
    quizNames = poll.candidates || [];
    if (quizNames.length === 0) {
      container.innerHTML = '<p>No candidates listed for this poll.</p>';
      return;
    }
    scorecardState = {};
    quizNames.forEach(function(n) { scorecardState[n] = null; });
    quizIndex = 0;

    // Standards-paced sessions put one candidate in each poll — there is nothing
    // to page through, so a tap is the vote.
    if (quizNames.length === 1) {
      renderSingleScorecard(poll, container, quizNames[0]);
      return;
    }

    var host = document.createElement('div');
    host.id = 'quiz-host';
    container.appendChild(host);
    renderQuizStep();
  }

  function renderSingleScorecard(poll, container, name) {
    var cand = (poll.rosterIndex !== null && roster[poll.rosterIndex])
      ? roster[poll.rosterIndex]
      : candidateByName(name);

    container.appendChild(buildCandidateCard(cand, name));

    var group = document.createElement('div');
    group.className = 'quiz-scores';
    ['-2', '-1', '0', '+1', '+2'].forEach(function(s) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'vote-btn quiz-score';
      if (s.charAt(0) === '+') btn.classList.add('ranked-plus');
      else if (s.charAt(0) === '-') btn.classList.add('ranked-minus');
      btn.textContent = s;
      btn.addEventListener('click', function() {
        group.querySelectorAll('.quiz-score').forEach(function(b) { b.disabled = true; });
        btn.classList.add('voted');
        var ballot = {};
        ballot[name] = parseInt(s, 10);
        submitVote(ballot, function(success) {
          if (!success) {
            group.querySelectorAll('.quiz-score').forEach(function(b) { b.disabled = false; });
            btn.classList.remove('voted');
          }
        });
      });
      group.appendChild(btn);
    });
    container.appendChild(group);
  }

  function ratedCount() {
    return quizNames.filter(function(n) { return scorecardState[n] !== null; }).length;
  }

  function renderQuizStep() {
    var host = document.getElementById('quiz-host');
    if (!host) return;
    host.innerHTML = '';

    if (quizIndex >= quizNames.length) {
      renderQuizReview(host);
      return;
    }

    var name = quizNames[quizIndex];
    var cand = candidateByName(name);

    var bar = document.createElement('div');
    bar.className = 'quiz-progress';
    var fill = document.createElement('div');
    fill.className = 'quiz-progress-fill';
    fill.style.width = Math.round((quizIndex / quizNames.length) * 100) + '%';
    bar.appendChild(fill);
    host.appendChild(bar);

    var counter = document.createElement('p');
    counter.className = 'quiz-counter';
    counter.textContent = (quizIndex + 1) + ' of ' + quizNames.length +
      '  ·  ' + ratedCount() + ' rated';
    host.appendChild(counter);

    host.appendChild(buildCandidateCard(cand, name));

    var scores = ['-2', '-1', '0', '+1', '+2'];
    var group = document.createElement('div');
    group.className = 'quiz-scores';
    scores.forEach(function(s) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'vote-btn quiz-score';
      if (s.charAt(0) === '+') btn.classList.add('ranked-plus');
      else if (s.charAt(0) === '-') btn.classList.add('ranked-minus');
      if (scorecardState[name] === s) btn.classList.add('voted');
      btn.textContent = s;
      btn.addEventListener('click', function() {
        scorecardState[name] = s;
        quizIndex++;
        renderQuizStep();
      });
      group.appendChild(btn);
    });
    host.appendChild(group);

    var nav = document.createElement('div');
    nav.className = 'quiz-nav';

    var back = document.createElement('button');
    back.type = 'button';
    back.className = 'quiz-nav-btn';
    back.textContent = '← Back';
    back.disabled = quizIndex === 0;
    back.addEventListener('click', function() {
      if (quizIndex > 0) { quizIndex--; renderQuizStep(); }
    });
    nav.appendChild(back);

    var skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'quiz-nav-btn';
    skip.textContent = 'Skip →';
    skip.addEventListener('click', function() { quizIndex++; renderQuizStep(); });
    nav.appendChild(skip);

    var review = document.createElement('button');
    review.type = 'button';
    review.className = 'quiz-nav-btn';
    review.textContent = 'Review all';
    review.addEventListener('click', function() {
      quizIndex = quizNames.length;
      renderQuizStep();
    });
    nav.appendChild(review);

    host.appendChild(nav);
  }

  function renderQuizReview(host) {
    var rated = ratedCount();
    var total = quizNames.length;

    var h = document.createElement('p');
    h.className = 'quiz-counter';
    h.textContent = 'Review — ' + rated + ' of ' + total + ' rated';
    host.appendChild(h);

    var list = document.createElement('div');
    list.className = 'quiz-review-list';
    quizNames.forEach(function(name, i) {
      var cand = candidateByName(name);
      var row = document.createElement('button');
      row.type = 'button';
      row.className = 'quiz-review-row' + (scorecardState[name] === null ? ' unrated' : '');

      var left = document.createElement('span');
      left.className = 'qr-name';
      left.textContent = (cand && cand.number ? '#' + cand.number + ' ' : '') + name;

      var right = document.createElement('span');
      right.className = 'qr-score';
      right.textContent = scorecardState[name] === null ? 'not rated' : scorecardState[name];

      row.appendChild(left);
      row.appendChild(right);
      row.addEventListener('click', function() { quizIndex = i; renderQuizStep(); });
      list.appendChild(row);
    });
    host.appendChild(list);

    var submitBtn = document.createElement('button');
    submitBtn.type = 'button';
    submitBtn.className = 'btn btn-primary';
    submitBtn.id = 'btn-submit-scorecard';
    submitBtn.style.cssText = 'display:block; margin:1rem auto 0; padding:0.75rem 2rem; font-size:1.1rem;';
    submitBtn.textContent = 'Submit All Ratings';
    submitBtn.addEventListener('click', submitScorecard);
    host.appendChild(submitBtn);

    if (rated < total) {
      var note = document.createElement('p');
      note.style.cssText = 'text-align:center; color:#b26a00; font-size:0.9rem; margin-top:0.5rem;';
      note.textContent = 'Tap any row above to rate the ' + (total - rated) + ' still missing.';
      host.appendChild(note);
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
    voteUIRendered = false;

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
        options: p.options || null,
        rosterIndex: (typeof p.rosterIndex === 'number') ? p.rosterIndex : null,
        useRoster: !!p.useRoster,
        threshold: p.threshold != null ? p.threshold : 75,
        minimumScore: p.minimumScore != null ? p.minimumScore : 0,
        status: p.status || 'closed'
      };

      if (p.status !== 'open') {
        debugMsg('');
        updatePollCounter();
        showNextUp(document.getElementById('waiting-next'));
        showStep('step-waiting');
        // Reset so buttons render fresh if poll re-opens
        voteUIRendered = false;
        return;
      }

      // ── Poll is open ──
      showStep('step-vote');
      updatePollCounter();

      // Only set up the vote UI once per poll opening.
      // Subsequent listener fires (other people voting, aggregation changes) are ignored here.
      if (voteUIRendered) return;
      voteUIRendered = true;

      document.getElementById('poll-title').textContent = p.name || 'Poll';
      var typeLabelEl = document.getElementById('poll-type-label');
      if (typeLabelEl) {
        var labels = {
          rush_prelim:  'Rate each candidate +2 to -2',
          ranked:       'Rate each candidate +2 to -2',
          rush_bid:     'Yes / No / Abstain',
          motion:       'Yes / No / Abstain',
          pnm_vote:     'Yes / No / Abstain',
          pnm_depledge: 'Yes / No',
          regular:      ''
        };
        typeLabelEl.textContent = labels[p.type] != null ? labels[p.type] : p.type;
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

    // Load the slide-deck roster once per session, if this session has one.
    // Photos live here, so it is fetched a single time rather than per poll.
    rosterLoaded = false;
    roster = [];
    PortalDb.getRoster(sid).then(function(list) {
      roster = list || [];
      rosterLoaded = true;
      // A poll may have rendered before the roster arrived — redraw so photos appear.
      if (roster.length && currentPoll && currentPoll.status === 'open') {
        voteUIRendered = false;
        renderVoteOptions(currentPoll, false, null);
        voteUIRendered = true;
      }
    }).catch(function() {
      rosterLoaded = true;
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
