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

  // localStorage rather than sessionStorage: phones kill background tabs and
  // reopen the page fresh, which wipes sessionStorage and dropped brothers out
  // of the session. Every access is guarded — private mode can throw.
  function store() { try { return window.localStorage; } catch (e) { return null; } }

  function saveVotingSession() {
    if (!sessionId) return;
    try { store().setItem(STORAGE_KEY, JSON.stringify({ sid: sessionId })); } catch (e) {}
  }

  function clearVotingSession() {
    try { store().removeItem(STORAGE_KEY); } catch (e) {}
  }

  function getSavedVotingSession() {
    try {
      var raw = store().getItem(STORAGE_KEY);
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
      if (poll.status === 'open') renderChangeVote(poll, myVote, container);
      else renderChangeVote(poll, myVote, document.createElement('div'));
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

      // Self-paced quiz over a slide deck: one candidate per screen, same
      // flow as the scorecard but with these options as the buttons.
      if (poll.candidates && poll.candidates.length) {
        startQuiz(poll, container, choices, 'option');
        return;
      }

      // Polls built from a slide deck show that candidate's card above the
      // picker. Either way the vote is two-step: pick, then lock in.
      if (poll.rosterIndex !== null && roster[poll.rosterIndex]) {
        var cand = roster[poll.rosterIndex];
        container.appendChild(buildCandidateCard(cand, poll.name));
        renderLockIn(container, poll, { candidateName: cand.name });
        return;
      }
      renderLockIn(container, poll, {});
      return;
    }

    // Yes/No/Abstain types: same two-step picker.
    renderLockIn(container, poll, {});
  }

  // ── Tap to vote, pre-select while up next, change while open ──
  // OPEN poll: one tap casts. UPCOMING candidate: tapping just highlights a
  // pick (kept on the phone); the moment Standards opens the poll it is sent
  // automatically. After any vote on a single-choice poll a Change vote
  // button lets the brother resubmit while the poll is still open.

  var changingVote = false;

  function pendingKey(pollId) { return (sessionId && pollId) ? 'pending_' + sessionId + '_' + pollId : null; }
  function loadPending(pollId) {
    try { var raw = store().getItem(pendingKey(pollId)); return raw ? JSON.parse(raw).choice : null; } catch (e) { return null; }
  }
  function savePending(pollId, choice) { try { store().setItem(pendingKey(pollId), JSON.stringify({ choice: choice })); } catch (e) {} }
  function clearPending(pollId) { try { store().removeItem(pendingKey(pollId)); } catch (e) {} }

  function capitalize(v) { return String(v).charAt(0).toUpperCase() + String(v).slice(1); }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function(c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function isSingleChoice(poll) {
    return !(poll && poll.candidates && poll.candidates.length > 1);
  }

  /** What a single-choice poll offers, how to label it, and how to colour it. */
  function choiceSpec(poll) {
    var t = poll.type;
    if (t === 'ranked' || t === 'rush_prelim') {
      return { kind: 'score', values: SCORE_CHOICES, label: function(v) { return v; },
        tone: function(v) { return v.charAt(0) === '+' ? 'good' : (v.charAt(0) === '-' ? 'bad' : ''); } };
    }
    var yn = function(v) { var l = String(v).toLowerCase(); return l === 'yes' ? 'good' : (l === 'no' ? 'bad' : ''); };
    if (t === 'regular') {
      var opts = (poll.options && poll.options.length) ? poll.options : ((sessionMeta && sessionMeta.voteOptions) || []);
      return { kind: 'option', values: opts, label: function(v) { return v; }, tone: yn };
    }
    if (t === 'pnm_depledge') return { kind: 'option', values: ['yes', 'no'], label: capitalize, tone: yn };
    return { kind: 'option', values: ['yes', 'no', 'abstain'], label: capitalize, tone: yn };
  }

  /** The button label that corresponds to a stored vote value. */
  function choiceFromVote(spec, vote) {
    var v = vote;
    if (v && typeof v === 'object') { var ks = Object.keys(v); v = ks.length ? v[ks[0]] : null; }
    if (v === null || v === undefined) return null;
    if (spec.kind === 'score') { var n = Number(v); return n > 0 ? '+' + n : String(n); }
    return String(v);
  }

  /** After a vote on a single-choice poll: say what went in and offer Change vote. */
  function renderChangeVote(poll, myVote, container) {
    var confirmEl = document.getElementById('vote-confirm');
    if (!isSingleChoice(poll)) {
      if (confirmEl) confirmEl.textContent = 'Your vote has been recorded. You cannot change it.';
      return;
    }
    var spec = choiceSpec(poll);
    var label = choiceFromVote(spec, myVote);
    if (confirmEl) {
      confirmEl.innerHTML = label !== null
        ? 'Your vote is in: <strong class="' + spec.tone(label) + '">' + escapeHtml(spec.label(label)) + '</strong>. You can change it while the poll is open.'
        : 'Your vote has been recorded. You can change it while the poll is open.';
    }
    var change = document.createElement('button');
    change.type = 'button';
    change.className = 'btn btn-change lockin-keep';
    change.textContent = 'Change vote';
    change.addEventListener('click', function() {
      if (label !== null) savePending(poll.pollId, label);
      changingVote = true;
      if (confirmEl) confirmEl.classList.add('hidden');
      voteUIRendered = false;
      renderVoteOptions(poll, false, null);
      voteUIRendered = true;
    });
    container.appendChild(change);
  }

  function renderLockIn(container, poll, opts) {
    opts = opts || {};
    var spec = choiceSpec(poll);
    if (!spec.values.length) {
      container.innerHTML = '<p style="color:#c62828;">No vote options configured for this session.</p>';
      return;
    }
    var preload = opts.mode === 'preload';
    var name = opts.candidateName || '__single';
    var saved = loadPending(poll.pollId);
    var choice = (saved !== null && spec.values.indexOf(saved) !== -1) ? saved : null;

    var wrap = document.createElement('div');
    wrap.className = 'lockin-wrap';
    container.appendChild(wrap);

    function valueFor(v) {
      if (spec.kind === 'score') {
        if (opts.candidateName) { var b = {}; b[PortalDb.ballotKey(opts.candidateName)] = parseInt(v, 10); return b; }
        return parseInt(v, 10);
      }
      return v;
    }

    function cast(v, group, btn) {
      if (group) group.querySelectorAll('.quiz-score').forEach(function(b) { b.disabled = true; });
      if (btn) btn.classList.add('voted');
      submitVote(valueFor(v), function(ok) {
        if (ok) { clearPending(poll.pollId); return; }
        if (group) group.querySelectorAll('.quiz-score').forEach(function(b) { b.disabled = false; });
        if (btn) btn.classList.remove('voted');
      });
    }

    function buttons(onPick) {
      quizKind = spec.kind;
      quizChoices = spec.values;
      scorecardState = {};
      if (choice !== null) scorecardState[name] = choice;
      var group = buildChoiceButtons(name, onPick);
      group.querySelectorAll('.quiz-score').forEach(function(b) { b.textContent = spec.label(b.textContent); });
      return group;
    }

    function note(cls, html) {
      var el = document.createElement('div');
      el.className = cls;
      el.innerHTML = html;
      wrap.appendChild(el);
    }

    // ── OPEN: a pre-selected pick sends itself; otherwise one tap casts. ──
    if (!preload) {
      var wasChanging = changingVote;
      changingVote = false;
      if (choice !== null && !wasChanging) {
        note('lockin-preload lockin-casting', '<strong>Sending your vote:</strong> ' + escapeHtml(spec.label(choice)) + '…');
        cast(choice, null, null);
        return;
      }
      wrap.appendChild(buttons(function(v, btn, group) { cast(v, group, btn); }));
      var hint = document.createElement('p');
      hint.className = 'lockin-hint';
      hint.textContent = wasChanging ? 'Tap your new vote. It replaces the one you sent.' : 'Tap to cast your vote.';
      wrap.appendChild(hint);
      return;
    }

    // ── UPCOMING: tap to pre-select; it is sent when the poll opens. ──
    function render() {
      wrap.innerHTML = '';
      if (choice === null) {
        note('lockin-preload', '<strong>Voting has not opened yet.</strong> Tap your pick now and it will be sent for you the moment Standards opens the poll.');
      } else {
        note('lockin-preload lockin-selected', '<strong>Selected: ' + escapeHtml(spec.label(choice)) + '.</strong> It will be sent automatically when the poll opens. Tap another to change.');
      }
      wrap.appendChild(buttons(function(v) {
        choice = v;
        savePending(poll.pollId, v);
        render();
      }));
    }
    render();
  }

  /**
   * Quiz-style scorecard: one candidate per screen, tapping a score advances to
   * the next, then a review screen submits the whole ballot at once. Ratings are
   * held locally until submit so brothers can go back and change any answer.
   */
  var quizIndex = 0;
  var quizNames = [];
  var quizChoices = [];        // button labels: scores or the session's options
  var quizKind = 'score';      // 'score' → numeric ballot, 'option' → option string

  var SCORE_CHOICES = ['-2', '-1', '0', '+1', '+2'];

  function quizVerb() { return quizKind === 'score' ? 'rated' : 'answered'; }
  function quizSubmitLabel() { return quizKind === 'score' ? 'Submit All Ratings' : 'Submit All Votes'; }
  function ballotValue(choice) { return quizKind === 'score' ? parseInt(choice, 10) : choice; }

  /** One button per choice; scores get the +/- colouring, options share the row evenly. */
  function buildChoiceButtons(name, onPick) {
    var group = document.createElement('div');
    group.className = 'quiz-scores' + (quizKind === 'option' ? ' quiz-options' : '');
    if (quizKind === 'option') group.style.gridTemplateColumns = 'repeat(' + quizChoices.length + ', 1fr)';
    quizChoices.forEach(function(s) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'vote-btn quiz-score';
      if (quizKind === 'score') {
        if (s.charAt(0) === '+') btn.classList.add('ranked-plus');
        else if (s.charAt(0) === '-') btn.classList.add('ranked-minus');
      }
      if (scorecardState[name] === s) btn.classList.add('voted');
      btn.textContent = s;
      btn.addEventListener('click', function() { onPick(s, btn, group); });
      group.appendChild(btn);
    });
    return group;
  }

  // Ratings live only in memory until submit. On a phone, a backgrounded tab
  // can be killed mid-quiz — with 170+ candidates that is a lot to lose — so
  // progress is mirrored to sessionStorage per poll and restored on reload.
  function quizStorageKey() {
    return (sessionId && currentPoll) ? 'quiz_' + sessionId + '_' + currentPoll.pollId : null;
  }

  function saveQuizProgress() {
    var key = quizStorageKey();
    if (!key) return;
    try {
      store().setItem(key, JSON.stringify({ index: quizIndex, state: scorecardState }));
    } catch (e) {}
    reportQuizProgress();
  }

  // Standards sees who has started but not submitted. Throttled so a fast
  // tapper does not write on every step.
  var progressTimer = null;
  function reportQuizProgress() {
    var uid = firebase.auth().currentUser && firebase.auth().currentUser.uid;
    if (!uid || !sessionId || !currentPoll || !quizNames.length) return;
    clearTimeout(progressTimer);
    progressTimer = setTimeout(function() {
      db.ref('sessions/' + sessionId + '/polls/' + currentPoll.pollId + '/progress/' + uid)
        .set({ answered: ratedCount(), total: quizNames.length, at: firebase.database.ServerValue.TIMESTAMP })
        .catch(function() {});
    }, 800);
  }

  function loadQuizProgress() {
    var key = quizStorageKey();
    if (!key) return null;
    try {
      var raw = store().getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function clearQuizProgress() {
    var key = quizStorageKey();
    if (!key) return;
    try { store().removeItem(key); } catch (e) {}
  }

  function candidateByName(name) {
    for (var i = 0; i < roster.length; i++) {
      if (roster[i] && roster[i].name === name) return roster[i];
    }
    return null;
  }

  /** Photo + number + name + slide info, laid out like the rushee slide. */
  // Rush events in the order the chapter runs them; anything else keeps slide order after these.
  var EVENT_ORDER = ['info night', 'pd workshop', 'speed dating', 'passion pitch', 'professional dinner'];

  function orderEvents(events) {
    function rank(e) {
      var label = String(e.label || '').toLowerCase();
      for (var i = 0; i < EVENT_ORDER.length; i++) {
        if (label.indexOf(EVENT_ORDER[i]) !== -1) return i;
      }
      return EVENT_ORDER.length;
    }
    return events.map(function(e, i) { return { e: e, r: rank(e), i: i }; })
      .sort(function(a, b) { return (a.r - b.r) || (a.i - b.i); })
      .map(function(x) { return x.e; });
  }

  function buildCandidateCard(cand, fallbackName) {
    var card = document.createElement('div');
    card.className = 'candidate-card';

    // Always render the photo box, so the layout below it never shifts.
    if (cand && cand.photo) {
      var img = document.createElement('img');
      img.className = 'candidate-photo';
      img.src = cand.photo;
      img.alt = cand.name || '';
      card.appendChild(img);
    } else {
      var empty = document.createElement('div');
      empty.className = 'candidate-photo candidate-photo--empty';
      empty.textContent = 'No photo';
      card.appendChild(empty);
    }

    var body = document.createElement('div');
    body.className = 'candidate-body';

    var heading = document.createElement('h3');
    heading.className = 'candidate-name';
    heading.textContent = (cand && cand.number ? '#' + cand.number + '  ' : '') +
      ((cand && cand.name) || fallbackName || '');
    body.appendChild(heading);

    if (cand) {
      // GPA always shows so a blank one reads as N/A rather than vanishing.
      var facts = [
        ['GPA', cand.gpa || 'N/A'],
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
        orderEvents(cand.events).forEach(function(e) {
          // Decks uploaded before the parser fix carry the GPA line as an event.
          if (/^gpa\b/i.test(e.label || '')) return;
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

  /**
   * Standards-paced polls carry one candidate each. While that poll is still
   * upcoming (or already closed) the waiting screen shows the candidate's card
   * so the room can look them over — just without any way to vote yet.
   */
  var WAITING_DEFAULT = 'Waiting for Standards to open a poll. This page will update automatically.';

  function renderWaitingCandidate(poll, status) {
    var box = document.getElementById('waiting-candidate');
    var msg = document.getElementById('waiting-msg');
    if (!box) return;
    var idx = (poll && typeof poll.rosterIndex === 'number') ? poll.rosterIndex : null;
    var cand = (idx !== null && roster[idx]) ? roster[idx] : null;
    box.innerHTML = '';
    if (!cand) {
      box.classList.add('hidden');
      if (msg) msg.textContent = WAITING_DEFAULT;
      return;
    }
    box.appendChild(buildCandidateCard(cand, poll.name));
    if (status !== 'closed') renderLockIn(box, poll, { mode: 'preload', candidateName: cand.name });
    box.classList.remove('hidden');
    // "Up next" would just repeat the card while this poll is upcoming; after a
    // close it points at the following candidate, which is worth keeping.
    var nextEl = document.getElementById('waiting-next');
    if (nextEl && status !== 'closed') nextEl.classList.add('hidden');
    if (msg) {
      msg.textContent = status === 'closed'
        ? 'Voting on this candidate is closed.'
        : 'Up now. Voting opens when Standards opens the poll.';
    }
  }

  function renderScorecard(poll, container) {
    startQuiz(poll, container, SCORE_CHOICES, 'score');
  }

  function startQuiz(poll, container, choices, kind) {
    quizChoices = choices;
    quizKind = kind;
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

    // Pick up where a killed tab or reload left off, if the candidate list
    // is the same one the saved progress was for.
    var saved = loadQuizProgress();
    if (saved && saved.state) {
      var sameList = quizNames.every(function(n) { return n in saved.state; }) &&
                     Object.keys(saved.state).length === quizNames.length;
      if (sameList) {
        scorecardState = saved.state;
        quizIndex = Math.min(Math.max(0, saved.index | 0), quizNames.length);
      }
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
    renderLockIn(container, poll, { candidateName: name });
  }

  function ratedCount() {
    return quizNames.filter(function(n) { return scorecardState[n] !== null; }).length;
  }

  function renderQuizStep() {
    var host = document.getElementById('quiz-host');
    if (!host) return;
    saveQuizProgress();
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
      '  ·  ' + ratedCount() + ' ' + quizVerb();
    host.appendChild(counter);

    host.appendChild(buildCandidateCard(cand, name));

    host.appendChild(buildChoiceButtons(name, function(s) {
      scorecardState[name] = s;
      quizIndex++;
      renderQuizStep();
    }));

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

    var hint = document.createElement('p');
    hint.className = 'quiz-step-hint';
    hint.textContent = 'Nothing is counted until you submit on the review screen at the end.';
    host.appendChild(hint);
  }

  function renderQuizReview(host) {
    var rated = ratedCount();
    var total = quizNames.length;

    var h = document.createElement('p');
    h.className = 'quiz-counter';
    h.textContent = 'Review — ' + rated + ' of ' + total + ' ' + quizVerb();
    host.appendChild(h);

    // Plenty of brothers stopped here thinking they were done. Say it plainly.
    var callout = document.createElement('div');
    callout.className = 'quiz-submit-callout';
    callout.innerHTML = '<strong>One more step.</strong> Nothing is counted until you tap <strong>' +
      quizSubmitLabel() + '</strong> at the bottom of this list.';
    host.appendChild(callout);

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
      right.textContent = scorecardState[name] === null ? 'not ' + quizVerb() : scorecardState[name];

      row.appendChild(left);
      row.appendChild(right);
      row.addEventListener('click', function() { quizIndex = i; renderQuizStep(); });
      list.appendChild(row);
    });
    host.appendChild(list);

    var submitBtn = document.createElement('button');
    submitBtn.type = 'button';
    submitBtn.className = 'btn btn-primary quiz-submit-btn';
    submitBtn.id = 'btn-submit-scorecard';
    submitBtn.textContent = quizSubmitLabel() + (rated < total ? '' : ' ✓');
    submitBtn.addEventListener('click', submitScorecard);
    host.appendChild(submitBtn);

    if (rated < total) {
      var note = document.createElement('p');
      note.style.cssText = 'text-align:center; color:#b26a00; font-size:0.9rem; margin-top:0.5rem;';
      note.textContent = 'Tap any row above to answer the ' + (total - rated) + ' still missing.';
      host.appendChild(note);
    }
  }

  function submitScorecard() {
    var keys = Object.keys(scorecardState);
    var unrated = keys.filter(function(k) { return scorecardState[k] === null; });
    if (unrated.length > 0) {
      var errorEl = document.getElementById('vote-error');
      if (errorEl) {
        errorEl.textContent = 'You must answer for all ' + keys.length + ' candidates. ' + unrated.length + ' remaining.';
        errorEl.classList.remove('hidden');
      }
      return;
    }
    var ballot = {};
    keys.forEach(function(name) {
      ballot[PortalDb.ballotKey(name)] = ballotValue(scorecardState[name]);
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
        submitBtn.textContent = quizSubmitLabel();
      }
    });
  }

  function submitVote(vote, doneCb) {
    var uid = firebase.auth().currentUser && firebase.auth().currentUser.uid;
    var errorEl = document.getElementById('vote-error');

    function fail(message) {
      if (errorEl) {
        errorEl.textContent = message;
        errorEl.classList.remove('hidden');
      }
      if (doneCb) doneCb(false);
    }

    // Every exit must report back, or the button stays on "Submitting…".
    if (!uid) return fail('Your sign-in expired. Reload the page and sign in again.');
    if (!sessionId || !currentPoll) return fail('Lost the session. Reload and rejoin with the code.');

    var updates = {};
    updates['sessions/' + sessionId + '/polls/' + currentPoll.pollId + '/votes/' + uid] = {
      vote: vote,
      votedAt: firebase.database.ServerValue.TIMESTAMP
    };
    updates['sessions/' + sessionId + '/polls/' + currentPoll.pollId + '/hasVoted/' + uid] = true;

    // An invalid key makes update() throw before it returns a promise, which
    // .catch() never sees. Trap that too.
    var write;
    try {
      write = db.ref().update(updates);
    } catch (err) {
      return fail(err.message || 'Failed to submit vote.');
    }

    write.then(function() {
      if (errorEl) errorEl.classList.add('hidden');
      clearQuizProgress();
      renderVoteOptions(currentPoll, true, vote);
      if (doneCb) doneCb(true);
    }).catch(function(err) {
      fail(err.message || 'Failed to submit vote.');
    });
  }

  // ── Listener management ──

  function detachPollListener() {
    if (currentPollListener) { currentPollListener(); currentPollListener = null; }
  }

  function detachAllListeners() {
    detachPollListener();
    if (presenceOff) presenceOff();
    if (presenceListener) { presenceListener(); presenceListener = null; }
    if (metaListener) { metaListener(); metaListener = null; }
    if (sessionId) {
      db.ref('sessions/' + sessionId + '/currentPollIndex').off();
      db.ref('sessions/' + sessionId + '/pollOrder').off();
    }
  }

  function resetToCodeEntry() {
    // Leaving on purpose: drop our presence entry right away.
    var leavingUid = firebase.auth().currentUser && firebase.auth().currentUser.uid;
    if (sessionId && leavingUid && !disconnected) {
      db.ref('sessions/' + sessionId + '/connectedBrothers/' + leavingUid).remove().catch(function() {});
    }
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
        // A dropped connection also removes this entry (onDisconnect). Give the
        // reconnect a moment to put it back before calling it a kick.
        setTimeout(function() {
          if (disconnected) return;
          ref.once('value').then(function(again) {
            if (again.exists() || disconnected) return;
            disconnected = true;
            detachAllListeners();
            clearVotingSession();
            showStep('step-kicked');
          }).catch(function() {});
        }, 3000);
      }
    }, function() {});
    presenceListener = function() { ref.off('value', cb); };
  }

  // ── Presence ──
  // Joining adds the brother to the session's participant list and they stay
  // there — a sleeping phone or a dropped signal only flips their `online`
  // flag (server-side, via onDisconnect), it never removes them. So the
  // voted/total count on Standards and Regent is stable, and Standards
  // decides who has actually left (Kick, or Remove offline).
  var presenceOff = null;

  function setupPresence(sid, uid) {
    if (presenceOff) presenceOff();
    var meRef = db.ref('sessions/' + sid + '/connectedBrothers/' + uid);
    var infoRef = db.ref('.info/connected');
    var kickAttached = false;
    var TS = firebase.database.ServerValue.TIMESTAMP;
    var cb = infoRef.on('value', function(snap) {
      if (!snap.val() || disconnected) return;
      meRef.onDisconnect().update({ online: false, lastSeen: TS }).then(function() {
        return meRef.once('value');
      }).then(function(cur) {
        var v = cur.val();
        if (v && typeof v === 'object') return meRef.update({ online: true, lastSeen: TS });
        return meRef.set({ joinedAt: TS, online: true, lastSeen: TS });
      }).then(function() {
        if (!kickAttached) { kickAttached = true; listenForKick(sid, uid); }
      }).catch(function(err) {
        debugMsg('Presence write failed: ' + err.message);
      });
    });
    presenceOff = function() {
      infoRef.off('value', cb);
      meRef.onDisconnect().cancel().catch(function() {});
      presenceOff = null;
    };
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

    // Brothers get only the poll's public fields plus their own ballot. The
    // fixed fields are read once and only `status` is watched live, so no
    // phone ever downloads other people's votes (the rules block it too).
    var base = 'sessions/' + sessionId + '/polls/' + pollId;
    var FIELDS = ['name', 'type', 'candidates', 'options', 'rosterIndex', 'useRoster', 'threshold', 'minimumScore'];
    var cancelled = false;
    var statusRef = null, statusCb = null;
    currentPollListener = function() {
      cancelled = true;
      if (statusRef && statusCb) statusRef.off('value', statusCb);
    };

    Promise.all(FIELDS.map(function(f) {
      return db.ref(base + '/' + f).once('value').then(function(s) { return s.val(); });
    })).then(function(vals) {
      if (cancelled || disconnected) return;
      var p = {};
      FIELDS.forEach(function(f, i) { p[f] = vals[i]; });
      if (p.type == null && p.name == null) {
        debugMsg('Poll data not found.');
        showStep('step-waiting');
        return;
      }
      statusRef = db.ref(base + '/status');
      statusCb = statusRef.on('value', function(snap) {
        if (cancelled || disconnected) return;
        handlePollState(pollId, p, snap.val() || 'closed');
      }, function(err) {
        debugMsg('Error listening to poll: ' + err.message);
        showStep('step-waiting');
      });
    }).catch(function(err) {
      debugMsg('Error loading poll: ' + err.message);
      showStep('step-waiting');
    });
  }

  function handlePollState(pollId, p, status) {
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
        status: status
      };

      if (status !== 'open') {
        debugMsg('');
        updatePollCounter();
        showNextUp(document.getElementById('waiting-next'));
        showStep('step-waiting');
        renderWaitingCandidate(currentPoll, status);
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

      // Session title (what Standards typed) sits above the individual poll name.
      var sessionTitleEl = document.getElementById('session-title');
      if (sessionTitleEl) {
        var st = sessionMeta && sessionMeta.sessionTitle;
        sessionTitleEl.textContent = st || '';
        sessionTitleEl.classList.toggle('hidden', !st || st === p.name);
      }
      var typeLabelEl = document.getElementById('poll-type-label');
      if (typeLabelEl) {
        var labels = {
          rush_prelim:  'Rate each candidate -2 to +2',
          ranked:       'Rate each candidate -2 to +2',
          rush_bid:     'Yes / No / Abstain',
          motion:       'Yes / No / Abstain',
          pnm_vote:     'Yes / No / Abstain',
          pnm_depledge: 'Yes / No',
          regular:      ''
        };
        typeLabelEl.textContent = labels[p.type] != null ? labels[p.type] : p.type;
      }

      var uid = firebase.auth().currentUser && firebase.auth().currentUser.uid;
      if (uid) {
        db.ref('sessions/' + sessionId + '/polls/' + pollId + '/votes/' + uid).once('value').then(function(vSnap) {
          var my = vSnap.val();
          renderVoteOptions(currentPoll, !!my, my && my.vote);
        }).catch(function() {
          renderVoteOptions(currentPoll, false, null);
        });
      } else {
        renderVoteOptions(currentPoll, false, null);
      }
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
      // The roster (with photos) can arrive well after the poll rendered on a
      // slow connection — a 170-candidate deck is a few MB. Bring the photos
      // in WITHOUT resetting anything the brother has already done.
      if (roster.length && currentPoll && currentPoll.status !== 'open') {
        renderWaitingCandidate(currentPoll, currentPoll.status);
      }
      if (roster.length && currentPoll && currentPoll.status === 'open') {
        if (document.getElementById('quiz-host')) {
          renderQuizStep();          // redraw the current step in place
        } else {
          var myUid = firebase.auth().currentUser && firebase.auth().currentUser.uid;
          var votedRef = myUid && db.ref('sessions/' + sid + '/polls/' + currentPoll.pollId + '/hasVoted/' + myUid);
          (votedRef ? votedRef.once('value') : Promise.resolve(null)).then(function(s) {
            if (s && s.val()) return;   // already voted; never show fresh options
            voteUIRendered = false;
            renderVoteOptions(currentPoll, false, null);
            voteUIRendered = true;
          }).catch(function() {});
        }
      }
    }).catch(function() {
      rosterLoaded = true;
    });

    if (uid) {
      setupPresence(sid, uid);

      if (!unloadHandlerAdded) {
        unloadHandlerAdded = true;
        window.addEventListener('beforeunload', function() {
          var curSid = sessionId;
          var curUid = firebase.auth().currentUser && firebase.auth().currentUser.uid;
          if (curSid && curUid && !disconnected) {
            // Closing or reloading the tab: mark offline, never remove — a
            // reload comes straight back and Standards decides who has left.
            db.ref('sessions/' + curSid + '/connectedBrothers/' + curUid).update({ online: false });
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
