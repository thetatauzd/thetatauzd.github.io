/**
 * Standards session control.
 * Session types: ranked (scorecard +2/-2) or regular (custom options).
 * Poll types within a session: ranked, regular, rush_bid, motion, pnm_vote, pnm_depledge, rush_prelim.
 * Features: real-time queue, active poll display, connected brothers list with kick, end session + history snapshot.
 */
(function() {
  'use strict';

  var db = firebase.database();
  var sessionId = null;
  var accessCode = null;
  var sessionType = null;   // 'ranked' | 'regular'
  var voteOptions = [];     // vote option strings for regular sessions
  var pollOrder = [];
  var pollsMeta = {};
  var currentIndex = 0;
  var voterDebounce = null;
  var nameCache = {};
  var connectedCount = 0;      // everyone who joined (participants)
  var onlineCount = 0;         // of those, connected right now

  function isOnline(uid) {
    var v = connectedBrothersData[uid];
    return !(v && typeof v === 'object' && v.online === false);
  }
  var connectedBrothersData = {};
  var cachedVotedCount = 0;
  var cachedVotedMap = {};
  var activePollListeners = [];
  var sessionListeners = [];

  function $(id) { return document.getElementById(id); }

  // ── Session persistence ──

  function saveSession() {
    if (sessionId && accessCode) {
      sessionStorage.setItem('standards_session', JSON.stringify({
        sid: sessionId, code: accessCode, type: sessionType, opts: voteOptions
      }));
    }
  }

  function clearSavedSession() {
    sessionStorage.removeItem('standards_session');
  }

  function getSavedSession() {
    try {
      var raw = sessionStorage.getItem('standards_session');
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function getName(uid, cb) {
    if (nameCache[uid]) return cb(nameCache[uid]);
    db.ref('users/' + uid + '/name').once('value', function(s) {
      nameCache[uid] = s.val() || uid.substring(0, 8);
      cb(nameCache[uid]);
    });
  }

  function typeLabel(t) {
    if (!t) return '';
    return {
      ranked: 'Ranked Scorecard',
      regular: 'Regular Vote',
      rush_prelim: 'Rush Prelim',
      rush_bid: 'Rush Bid',
      motion: 'Motion',
      pnm_vote: 'PNM Vote',
      pnm_depledge: 'PNM De-pledge'
    }[t] || t;
  }

  function showReconnect(show) {
    $('reconnect-banner').classList.toggle('hidden', !show);
  }

  // ── Panel visibility ──

  function showSessionPanels() {
    ['panel-active-poll', 'panel-queue', 'panel-results', 'panel-connected'].forEach(function(id) {
      $(id).classList.remove('hidden');
    });
    $('session-active-info').classList.remove('hidden');
    $('active-code').textContent = accessCode;
    $('active-session-type').textContent = typeLabel(sessionType);
    $('link-open-regent').href = 'regent#' + sessionId;
    $('btn-create-session').disabled = true;

    // The whole setup flow goes away while a session is live.
    $('panel-setup').classList.add('hidden');
    $('bar-title').textContent = typeLabel(sessionType) + ' session';
    db.ref('sessions/' + sessionId + '/meta/sessionTitle').once('value').then(function(snap) {
      if (snap.val()) $('bar-title').textContent = snap.val();
    }).catch(function() {});

    // Show correct add-poll form
    if (sessionType === 'ranked') {
      $('add-ranked-form').classList.remove('hidden');
      $('add-regular-form').classList.add('hidden');
    } else {
      $('add-ranked-form').classList.add('hidden');
      $('add-regular-form').classList.remove('hidden');
    }
  }

  function hideSessionPanels() {
    ['panel-active-poll', 'panel-queue', 'panel-results', 'panel-connected', 'panel-next-round'].forEach(function(id) {
      $(id).classList.add('hidden');
    });
    $('session-active-info').classList.add('hidden');
    sessionRoster = null;
    $('btn-create-session').disabled = false;
    $('add-ranked-form').classList.add('hidden');
    $('add-regular-form').classList.add('hidden');

    $('panel-setup').classList.remove('hidden');
    resetSetup();
  }

  // ── Session type & options picker ──

  var selectedSessionType = null;
  var selectedPreset = null;

  function initTypePicker() {
    var btns = $('session-type-picker').querySelectorAll('.session-type-btn');
    btns.forEach(function(btn) {
      btn.addEventListener('click', function() {
        btns.forEach(function(b) { b.classList.remove('selected'); });
        btn.classList.add('selected');
        selectedSessionType = btn.getAttribute('data-type');
        refreshSetupSteps();
      });
    });

    var presetBtns = $('option-presets').querySelectorAll('.option-preset-btn');
    presetBtns.forEach(function(btn) {
      btn.addEventListener('click', function() {
        presetBtns.forEach(function(b) { b.classList.remove('selected'); });
        btn.classList.add('selected');
        selectedPreset = btn.getAttribute('data-preset');
        $('custom-options-group').classList.toggle('hidden', selectedPreset !== 'custom');
        refreshSetupSteps();
      });
    });
    $('custom-options-text').addEventListener('input', refreshSetupSteps);
  }

  // ── Setup flow: each step appears once the one before it is answered ──

  var ballotSource = null;   // 'slides' | 'manual'

  var BALLOT_HINTS = {
    slides: 'Every candidate comes straight off the deck — photo, number and info included.',
    manual: 'You will type poll names into the queue once the room is open. Good for motions and one-off votes.'
  };

  function initBallotPicker() {
    var wrap = $('ballot-presets');
    if (!wrap) return;
    var btns = wrap.querySelectorAll('.option-preset-btn');
    btns.forEach(function(btn) {
      btn.addEventListener('click', function() {
        btns.forEach(function(b) { b.classList.remove('selected'); });
        btn.classList.add('selected');
        ballotSource = btn.getAttribute('data-source');
        $('ballot-hint').textContent = BALLOT_HINTS[ballotSource] || '';
        $('slides-setup').classList.toggle('hidden', ballotSource !== 'slides');
        refreshSetupSteps();
      });
    });
  }

  function optionsChosen() {
    if (selectedSessionType !== 'regular') return true;
    if (!selectedPreset) return false;
    return getVoteOptionsFromUI().length >= 2;
  }

  function setupSummary() {
    var bits = [typeLabel(selectedSessionType)];
    if (selectedSessionType === 'regular') bits.push(getVoteOptionsFromUI().join(' / '));
    if (ballotSource === 'slides') {
      bits.push(parsedRoster.length + ' candidate' + (parsedRoster.length === 1 ? '' : 's') + ' from the deck');
      bits.push(slidesPacing === 'self' ? 'self-paced quiz' : 'you open each candidate');
    } else {
      bits.push('polls added by hand');
    }
    return 'Opening: ' + bits.join(' · ');
  }

  function refreshSetupSteps() {
    var type = selectedSessionType;
    var isRegular = type === 'regular';
    var n = 1;

    $('regular-options-setup').classList.toggle('hidden', !isRegular);
    if (isRegular) n++;

    var showBallot = !!type && optionsChosen();
    $('step-ballot').classList.toggle('hidden', !showBallot);
    if (showBallot) $('step-ballot-num').textContent = ++n;

    var slidesReady = ballotSource === 'slides' && parsedRoster.length > 0;
    var showPacing = showBallot && slidesReady;
    $('slides-pacing').classList.toggle('hidden', !showPacing);
    if (showPacing) $('step-pacing-num').textContent = ++n;

    var showLaunch = showBallot && (ballotSource === 'manual' || slidesReady);
    $('step-launch').classList.toggle('hidden', !showLaunch);
    if (showLaunch) {
      $('step-launch-num').textContent = ++n;
      $('slides-title-group').classList.toggle('hidden', ballotSource !== 'slides');
      $('setup-summary').textContent = setupSummary();
    }
  }

  function resetSetup() {
    selectedSessionType = null;
    selectedPreset = null;
    ballotSource = null;
    parsedRoster = [];
    ['session-type-picker', 'option-presets', 'ballot-presets'].forEach(function(id) {
      $(id).querySelectorAll('.selected').forEach(function(b) { b.classList.remove('selected'); });
    });
    $('custom-options-group').classList.add('hidden');
    $('custom-options-text').value = '';
    $('slides-setup').classList.add('hidden');
    $('slides-file').value = '';
    $('slides-title').value = '';
    $('session-code').value = '';
    $('ballot-hint').textContent = '';
    slidesStatus('');
    renderRosterReview();
    refreshSetupSteps();
  }

  // ── Candidate slide deck ──

  var parsedRoster = [];
  var slidesPacing = 'self';   // 'self' = one quiz poll, 'standards' = one poll per candidate

  var PACING_HINTS = {
    self: 'One poll holding everyone. Brothers go through the candidates at their own speed, can go back, and submit all their answers at the end.',
    standards: 'One poll per candidate. Nobody can vote ahead — you open each candidate and close them when the room has voted.'
  };

  function initPacingPicker() {
    var wrap = $('pacing-presets');
    if (!wrap) return;
    var btns = wrap.querySelectorAll('.option-preset-btn');
    btns.forEach(function(btn) {
      btn.addEventListener('click', function() {
        btns.forEach(function(b) { b.classList.remove('selected'); });
        btn.classList.add('selected');
        slidesPacing = btn.getAttribute('data-pacing') || 'self';
        var hint = $('pacing-hint');
        if (hint) hint.textContent = PACING_HINTS[slidesPacing] || '';
        refreshSetupSteps();
      });
    });
  }

  function slidesStatus(msg, kind) {
    var el = $('slides-status');
    if (!el) return;
    el.textContent = msg || '';
    el.style.color = kind === 'error' ? '#c62828' : (kind === 'ok' ? '#2e7d32' : '#666');
  }

  function renderRosterReview() {
    var review = $('slides-review');
    var list = $('slides-list');
    if (!review || !list) return;

    if (!parsedRoster.length) {
      review.classList.add('hidden');
      list.innerHTML = '';
      return;
    }
    review.classList.remove('hidden');

    var kb = Math.round(PortalSlides.estimateSize(parsedRoster) / 1024);
    $('slides-count').textContent = parsedRoster.length + ' candidates · ' + kb + ' KB';

    list.innerHTML = '';
    parsedRoster.forEach(function(c, i) {
      var row = document.createElement('div');
      row.className = 'slide-row';

      var img = document.createElement('img');
      if (c.photo) img.src = c.photo;
      img.alt = '';

      var num = document.createElement('span');
      num.className = 'num';
      num.textContent = '#' + c.number;

      var nameInput = document.createElement('input');
      nameInput.className = 'nm';
      nameInput.value = c.name || '';
      nameInput.placeholder = 'Name missing — type it here';
      nameInput.addEventListener('input', function() {
        parsedRoster[i].name = nameInput.value.trim();
      });

      var meta = document.createElement('span');
      meta.className = 'meta';
      var bits = [];
      if (c.gpa) bits.push('GPA ' + c.gpa);
      if (c.major) bits.push(c.major);
      meta.textContent = bits.join(' · ');

      var del = document.createElement('button');
      del.type = 'button';
      del.title = 'Remove this candidate';
      del.textContent = '✕';
      del.addEventListener('click', function() {
        parsedRoster.splice(i, 1);
        renderRosterReview();
        refreshSetupSteps();
      });

      row.appendChild(img);
      row.appendChild(num);
      row.appendChild(nameInput);
      row.appendChild(meta);
      row.appendChild(del);

      if (c.warnings && c.warnings.length) {
        var w = document.createElement('span');
        w.className = 'slide-warn';
        w.textContent = '⚠';
        w.title = c.warnings.join(', ');
        row.insertBefore(w, del);
      }
      list.appendChild(row);
    });
  }

  function initSlideUpload() {
    var input = $('slides-file');
    if (!input) return;

    input.addEventListener('change', function() {
      var file = input.files && input.files[0];
      if (!file) return;
      parsedRoster = [];
      renderRosterReview();
      slidesStatus('Reading deck…');

      PortalSlides.parseDeck(file, {
        onProgress: function(done, total) {
          slidesStatus('Reading slide ' + done + ' of ' + total + '…');
        }
      }).then(function(candidates) {
        parsedRoster = candidates;
        renderRosterReview();
        var missing = candidates.filter(function(c) { return !c.name; }).length;
        if (!candidates.length) {
          slidesStatus('No candidate slides found in that deck.', 'error');
        } else if (missing) {
          slidesStatus(candidates.length + ' candidates found. ' + missing +
            ' have no name — fill them in or remove them below.', 'error');
        } else {
          slidesStatus(candidates.length + ' candidates ready.', 'ok');
        }
        refreshSetupSteps();
      }).catch(function(err) {
        console.error('Slide parse failed', err);
        slidesStatus(err.message || 'Could not read that file.', 'error');
        refreshSetupSteps();
      });
    });

    var clear = $('btn-slides-clear');
    if (clear) {
      clear.addEventListener('click', function() {
        parsedRoster = [];
        input.value = '';
        slidesStatus('');
        renderRosterReview();
        refreshSetupSteps();
      });
    }
  }

  /**
   * After a session is created with a deck attached, save the roster and build
   * its polls: one scorecard poll covering everyone for ranked sessions, or one
   * poll per candidate for regular sessions.
   */
  function attachRosterToSession(sid, type, opts) {
    var roster = parsedRoster.slice();
    if (!roster.length) return Promise.resolve();

    // Whatever Standards typed is the heading brothers see; fall back only if blank.
    var title = (($('slides-title') && $('slides-title').value) || '').trim();

    return PortalDb.saveRoster(sid, roster, function(done, total) {
      slidesStatus('Uploading candidate ' + done + ' of ' + total + '…');
    }).then(function() {
      var updates = {};
      var newOrder = [];

      // Per-candidate polls are titled with the candidate; the session title
      // rides along so the voting screen can show it above them.
      function candidateTitle(c) {
        return '#' + c.number + ' ' + c.name;
      }

      if (slidesPacing === 'standards') {
        // One poll per candidate, so Standards controls the pace.
        roster.forEach(function(c, i) {
          var pid = db.ref('sessions/' + sid + '/polls').push().key;
          var poll = {
            name: candidateTitle(c),
            type: type === 'ranked' ? 'ranked' : 'regular',
            useRoster: true,
            rosterIndex: i,
            status: 'upcoming'
          };
          if (type === 'ranked') {
            poll.candidates = [c.name];
            poll.minimumScore = 0;
          } else {
            poll.options = opts || [];
          }
          updates['sessions/' + sid + '/polls/' + pid] = poll;
          newOrder.push(pid);
        });
      } else {
        // One quiz poll holding every candidate; brothers page through it
        // themselves and submit a single ballot at the end.
        var pollId = db.ref('sessions/' + sid + '/polls').push().key;
        var quiz = {
          name: title || (type === 'ranked' ? 'Scorecard' : 'Vote'),
          type: type === 'ranked' ? 'ranked' : 'regular',
          candidates: roster.map(function(c) { return c.name; }),
          useRoster: true,
          status: 'upcoming'
        };
        if (type === 'ranked') quiz.minimumScore = 0;
        else quiz.options = opts || [];
        updates['sessions/' + sid + '/polls/' + pollId] = quiz;
        newOrder.push(pollId);
      }

      updates['sessions/' + sid + '/pollOrder'] = newOrder;
      if (title) updates['sessions/' + sid + '/meta/sessionTitle'] = title;
      return db.ref().update(updates);
    }).then(function() {
      slidesStatus('Deck uploaded — ' + roster.length + ' candidates queued.', 'ok');
    });
  }

  function getVoteOptionsFromUI() {
    if (selectedPreset === 'yes_no_idk') return ['Yes', 'No', "I Don't Know"];
    if (selectedPreset === 'yes_no') return ['Yes', 'No'];
    if (selectedPreset === 'custom') {
      var raw = ($('custom-options-text').value || '').trim();
      return raw.split('\n').map(function(s) { return s.trim(); }).filter(Boolean);
    }
    return [];
  }

  // ── Session ──

  function rejoinSession(sid, code, type, opts) {
    sessionId = sid;
    accessCode = code;
    sessionType = type || 'regular';
    voteOptions = opts || [];
    pollOrder = [];
    pollsMeta = {};
    currentIndex = 0;
    saveSession();
    showSessionPanels();
    startListeners();
  }

  function createSession() {
    var code = ($('session-code').value || '').toUpperCase().replace(/\s/g, '');
    if (!code) { alert('Enter an access code.'); return; }
    if (!selectedSessionType) { alert('Select a session type.'); return; }

    if (selectedSessionType === 'regular') {
      var opts = getVoteOptionsFromUI();
      if (opts.length < 2) { alert('Regular vote needs at least 2 options.'); return; }
    }
    if (!ballotSource) { alert('Choose whether the ballot comes from slides or is added by hand.'); return; }
    if (ballotSource === 'slides' && !parsedRoster.length) { alert('Upload the slide deck first, or switch to adding polls by hand.'); return; }

    var uid = firebase.auth().currentUser && firebase.auth().currentUser.uid;
    if (!uid) return;

    $('btn-create-session').disabled = true;

    db.ref('sessionByCode/' + code).once('value').then(function(snap) {
      var existingSid = snap.val();
      if (existingSid) {
        return db.ref('sessions/' + existingSid + '/meta/status').once('value').then(function(statusSnap) {
          if (statusSnap.val() === 'ended') {
            return createNewSession(code, uid);
          }
          // Rejoin existing session — read its type and options
          return db.ref('sessions/' + existingSid + '/meta').once('value').then(function(metaSnap) {
            var meta = metaSnap.val() || {};
            rejoinSession(existingSid, code, meta.sessionType, meta.voteOptions);
          });
        });
      }
      return createNewSession(code, uid);
    }).catch(function(err) {
      alert('Failed: ' + err.message);
      $('btn-create-session').disabled = false;
    });
  }

  function createNewSession(code, uid) {
    var type = selectedSessionType;
    var opts = type === 'regular' ? getVoteOptionsFromUI() : null;
    var sid = db.ref('sessions').push().key;
    var meta = {
      accessCode: code,
      createdBy: uid,
      createdAt: firebase.database.ServerValue.TIMESTAMP,
      status: 'active',
      sessionType: type
    };
    if (opts) meta.voteOptions = opts;

    var updates = {};
    updates['sessionByCode/' + code] = sid;
    updates['sessions/' + sid + '/meta'] = meta;
    updates['sessions/' + sid + '/currentPollIndex'] = 0;
    updates['sessions/' + sid + '/pollOrder'] = [];

    return db.ref().update(updates).then(function() {
      return ballotSource === 'slides' ? attachRosterToSession(sid, type, opts) : null;
    }).then(function() {
      rejoinSession(sid, code, type, opts);
    }).catch(function(err) {
      alert('Failed: ' + err.message);
      $('btn-create-session').disabled = false;
    });
  }

  function buildSessionSnapshot(sid, code, cb) {
    var snapshot = {
      accessCode: code,
      endedAt: new Date().toISOString(),
      sessionType: sessionType || null,
      voteOptions: voteOptions || null,
      polls: {}
    };

    db.ref('sessions/' + sid + '/meta').once('value').then(function(metaSnap) {
      var meta = metaSnap.val() || {};
      snapshot.createdAt = meta.createdAt || null;
      snapshot.createdBy = meta.createdBy || null;
      snapshot.sessionType = meta.sessionType || snapshot.sessionType;
      snapshot.voteOptions = meta.voteOptions || snapshot.voteOptions;
      snapshot.sessionTitle = meta.sessionTitle || null;

      return db.ref('sessions/' + sid + '/pollOrder').once('value');
    }).then(function(orderSnap) {
      var order = orderSnap.val() || [];
      if (order.length === 0) return cb(snapshot);

      var remaining = order.length;
      order.forEach(function(pid) {
        db.ref('sessions/' + sid + '/polls/' + pid).once('value').then(function(pSnap) {
          var p = pSnap.val();
          if (p) {
            var votes = p.votes || {};
            var agg = p.aggregation || PortalDb.computeAggregation(p.type, votes, p.candidates);
            var pollSnap = {
              name: p.name || null, type: p.type || null,
              threshold: p.threshold != null ? p.threshold : null,
              minimumScore: p.minimumScore != null ? p.minimumScore : null,
              candidates: p.candidates || null,
              options: p.options || null,
              rosterIndex: (typeof p.rosterIndex === 'number') ? p.rosterIndex : null,
              round: p.round || 1,
              aggregation: agg, result: computeResult(p, agg), voters: {}
            };

            var uids = Object.keys(votes);
            if (uids.length === 0) {
              snapshot.polls[pid] = pollSnap;
            } else {
              var namesDone = 0;
              uids.forEach(function(uid) {
                getName(uid, function(n) {
                  // Store the ballot exactly as cast (storage-safe keys); the
                  // history page decodes it to real names when displaying.
                  pollSnap.voters[uid] = { name: n, vote: votes[uid].vote };
                  if (++namesDone === uids.length) {
                    snapshot.polls[pid] = pollSnap;
                    if (--remaining === 0) cb(snapshot);
                  }
                });
              });
              return;
            }
          }
          if (--remaining === 0) cb(snapshot);
        }).catch(function() {
          if (--remaining === 0) cb(snapshot);
        });
      });
    }).catch(function() {
      cb(snapshot);
    });
  }

  function computeResult(poll, agg) {
    var type = poll.type;

    if (type === 'ranked' || type === 'rush_prelim') {
      return 'See leaderboard';
    }

    if (type === 'regular') {
      if (agg.candidateOptions) return 'See results table';
      var oc = agg.optionCounts || {};
      var parts = Object.keys(oc).map(function(k) { return k + ': ' + oc[k]; });
      return parts.join(' | ') || 'No votes';
    }

    if (type === 'rush_bid' || type === 'motion' || type === 'pnm_vote') {
      var total = (agg.yes || 0) + (agg.no || 0);
      var pct = total ? Math.round(100 * agg.yes / total) : 0;
      return pct + '% yes (' + (agg.yes || 0) + '/' + (agg.no || 0) + '/' + (agg.abstain || 0) + ')';
    }

    if (type === 'pnm_depledge') {
      var dtotal = (agg.yes || 0) + (agg.no || 0);
      var dpct = dtotal ? Math.round(100 * agg.yes / dtotal) : 0;
      return dpct + '% voted yes to de-pledge';
    }

    return '';
  }

  // ── End session ──

  function endSession() {
    if (!sessionId) return;
    if (!confirm('End this session? Brothers will be disconnected and voting will stop.')) return;

    $('btn-end-session').disabled = true;
    $('btn-end-session').textContent = 'Ending...';

    // Show ending overlay
    var overlay = document.createElement('div');
    overlay.className = 'ending-overlay';
    overlay.id = 'ending-overlay';
    overlay.innerHTML = '<div class="ending-box"><div class="spinner"></div><h3>Ending session...</h3><p>Saving history and disconnecting brothers.</p></div>';
    document.body.appendChild(overlay);

    var savingSid = sessionId;
    var savingCode = accessCode;

    detachActivePollListeners();
    detachSessionListeners();

    var immediateUpdates = {};
    immediateUpdates['sessions/' + savingSid + '/meta/status'] = 'ended';
    if (savingCode) {
      immediateUpdates['sessionByCode/' + savingCode] = null;
    }
    immediateUpdates['sessions/' + savingSid + '/connectedBrothers'] = null;

    db.ref().update(immediateUpdates).then(function() {
      sessionId = null;
      accessCode = null;
      sessionType = null;
      voteOptions = [];
      pollOrder = [];
      pollsMeta = {};
      currentIndex = 0;
      connectedBrothersData = {};
      connectedCount = 0;
      clearSavedSession();
      hideSessionPanels();
      $('btn-end-session').disabled = false;
      $('btn-end-session').textContent = 'End session';

      buildSessionSnapshot(savingSid, savingCode, function(snapshot) {
        var clean = JSON.parse(JSON.stringify(snapshot));
        db.ref('sessionHistory/' + savingSid).set(clean).then(function() {
          var ov = $('ending-overlay');
          if (ov) ov.remove();
          window.location.href = 'history';
        }).catch(function(err) {
          var ov = $('ending-overlay');
          if (ov) ov.remove();
          alert('Warning: session ended but history failed to save — ' + err.message);
        });
      });
    }).catch(function(err) {
      var ov = $('ending-overlay');
      if (ov) ov.remove();
      alert('Failed to end session: ' + err.message);
      $('btn-end-session').disabled = false;
      $('btn-end-session').textContent = 'End session';
    });
  }

  // ── Add poll ──

  function addRankedPoll() {
    if (!sessionId) { alert('Create a session first.'); return; }
    var name = ($('ranked-poll-name').value || '').trim() || 'Ranked Scorecard';
    var raw = ($('ranked-candidates').value || '').trim();
    if (!raw) { alert('Enter candidate names.'); return; }

    var candidates = raw.split(/[\n,]+/).map(function(s) { return s.trim(); }).filter(Boolean);
    if (candidates.length < 1) { alert('Enter at least one candidate name.'); return; }

    var minScore = parseInt($('ranked-min-score').value, 10) || 0;

    var pollId = db.ref('sessions/' + sessionId + '/polls').push().key;
    var data = {
      name: name,
      type: 'ranked',
      candidates: candidates,
      minimumScore: minScore,
      status: 'upcoming'
    };

    var newOrder = pollOrder.slice();
    newOrder.push(pollId);

    var updates = {};
    updates['sessions/' + sessionId + '/polls/' + pollId] = data;
    updates['sessions/' + sessionId + '/pollOrder'] = newOrder;

    db.ref().update(updates).then(function() {
      $('ranked-poll-name').value = '';
      $('ranked-candidates').value = '';
    }).catch(function(err) {
      alert('Failed to add poll: ' + err.message);
    });
  }

  function addRegularPoll() {
    if (!sessionId) { alert('Create a session first.'); return; }
    var name = ($('regular-poll-name').value || '').trim();
    if (!name) { alert('Enter a poll name.'); return; }

    var pollId = db.ref('sessions/' + sessionId + '/polls').push().key;
    var data = {
      name: name,
      type: 'regular',
      status: 'upcoming'
    };

    var newOrder = pollOrder.slice();
    newOrder.push(pollId);

    var updates = {};
    updates['sessions/' + sessionId + '/polls/' + pollId] = data;
    updates['sessions/' + sessionId + '/pollOrder'] = newOrder;

    db.ref().update(updates).then(function() {
      $('regular-poll-name').value = '';
    }).catch(function(err) {
      alert('Failed to add poll: ' + err.message);
    });
  }

  function batchAddRegularPolls() {
    if (!sessionId) { alert('Create a session first.'); return; }
    var raw = ($('batch-names').value || '').trim();
    if (!raw) { alert('Enter at least one name.'); return; }

    var names = raw.split('\n').map(function(s) { return s.trim(); }).filter(Boolean);
    if (names.length === 0) { alert('No valid names found.'); return; }

    var newOrder = pollOrder.slice();
    var updates = {};

    names.forEach(function(name) {
      var pollId = db.ref('sessions/' + sessionId + '/polls').push().key;
      updates['sessions/' + sessionId + '/polls/' + pollId] = {
        name: name,
        type: 'regular',
        status: 'upcoming'
      };
      newOrder.push(pollId);
    });

    updates['sessions/' + sessionId + '/pollOrder'] = newOrder;

    db.ref().update(updates).then(function() {
      $('batch-names').value = '';
      alert(names.length + ' polls added to queue.');
    }).catch(function(err) {
      alert('Failed to batch add: ' + err.message);
    });
  }

  // ── Queue rendering ──

  function renderQueue() {
    var container = $('poll-queue-list');
    if (!container) return;

    var qc = $('queue-count');
    if (qc) qc.textContent = pollOrder.length ? pollOrder.length + (pollOrder.length === 1 ? ' poll' : ' polls') : '';
    refreshNextRoundPanel();

    if (pollOrder.length === 0) {
      container.innerHTML = '<p class="queue-empty">Nothing queued yet. Add your first poll below.</p>';
      var addDetails = $('add-polls-details');
      if (addDetails) addDetails.open = true;
      return;
    }

    var hasAnyMeta = false;
    for (var k in pollsMeta) {
      if (pollsMeta.hasOwnProperty(k)) { hasAnyMeta = true; break; }
    }

    container.innerHTML = pollOrder.map(function(pid, i) {
      var meta = pollsMeta[pid];
      if (!meta && hasAnyMeta) return '';
      var name = (meta && meta.name) ? meta.name : 'Loading...';
      var type = (meta && meta.type) ? typeLabel(meta.type) : '';
      var status = (meta && meta.status) ? meta.status : 'upcoming';
      var isPast = i < currentIndex;
      var isCurrent = (i === currentIndex);
      var cls = 'queue-item' + (isPast ? ' past' : '') + (isCurrent ? ' current' : '');

      // Only allow management of upcoming polls that haven't started
      var canManage = !isCurrent && !isPast && status === 'upcoming';
      var canUp   = canManage && i > currentIndex + 1;
      var canDown = canManage && i < pollOrder.length - 1;

      var roundBadge = (meta && meta.round > 1) ? '<span class="qi-round">Round ' + meta.round + '</span>' : '';
      var actions = '<div class="qi-actions">';
      actions += '<button class="qi-btn" data-action="up"   data-idx="' + i + '"' + (canUp   ? '' : ' disabled') + '>↑</button>';
      actions += '<button class="qi-btn" data-action="down" data-idx="' + i + '"' + (canDown ? '' : ' disabled') + '>↓</button>';
      actions += '<button class="qi-btn qi-remove" data-action="remove" data-idx="' + i + '" data-pid="' + pid + '"' + (canManage ? '' : ' disabled') + '>✕</button>';
      actions += '<span class="poll-status ' + status + '">' + status + '</span>';
      actions += '</div>';

      return '<div class="' + cls + '">' +
        '<span class="qi-main" data-action="jump" data-idx="' + i + '" title="Jump to this poll">' +
        '<span class="qi-name">' + (i + 1) + '. ' + name + '</span>' +
        (type ? '<span class="qi-type">' + type + '</span>' : '') + roundBadge + '</span>' +
        actions +
        '</div>';
    }).filter(Boolean).join('');

    // Event delegation for all queue buttons
    container.onclick = function(e) {
      var btn = e.target.closest('[data-action]');
      if (!btn || btn.disabled) return;
      var action = btn.getAttribute('data-action');
      var idx = parseInt(btn.getAttribute('data-idx'), 10);
      if (action === 'jump') {
        jumpToPoll(idx);
      } else if (action === 'remove') {
        removePollFromQueue(btn.getAttribute('data-pid'), idx);
      } else if (action === 'up') {
        movePollInQueue(idx, idx - 1);
      } else if (action === 'down') {
        movePollInQueue(idx, idx + 1);
      }
    };
  }

  // Jump the room to any poll in the queue. A closed one shows Reopen once it
  // is on screen; an open one left behind stays open, so ask first.
  function jumpToPoll(idx) {
    if (!sessionId || idx === currentIndex || idx < 0 || idx >= pollOrder.length) return;
    var cur = getCurrentPollData();
    if (cur && cur.status === 'open' &&
        !confirm('The current poll is still open. Jump anyway? (Close it first if brothers are mid-vote.)')) return;
    db.ref('sessions/' + sessionId + '/currentPollIndex').set(idx).catch(function(err) {
      alert('Failed to jump: ' + err.message);
    });
  }

  function removePollFromQueue(pid, idx) {
    if (!sessionId || !pid) return;
    if (!confirm('Remove "' + ((pollsMeta[pid] && pollsMeta[pid].name) || 'this poll') + '" from the queue?')) return;
    var newOrder = pollOrder.filter(function(p) { return p !== pid; });
    var updates = {};
    updates['sessions/' + sessionId + '/pollOrder'] = newOrder;
    updates['sessions/' + sessionId + '/polls/' + pid] = null;
    db.ref().update(updates).catch(function(err) { alert('Failed to remove: ' + err.message); });
  }

  function movePollInQueue(fromIdx, toIdx) {
    if (!sessionId || toIdx < 0 || toIdx >= pollOrder.length) return;
    // Don't allow moving into or before the current poll position
    if (toIdx <= currentIndex) return;
    var newOrder = pollOrder.slice();
    var tmp = newOrder[fromIdx];
    newOrder[fromIdx] = newOrder[toIdx];
    newOrder[toIdx] = tmp;
    db.ref('sessions/' + sessionId + '/pollOrder').set(newOrder).catch(function(err) {
      alert('Failed to reorder: ' + err.message);
    });
  }

  // ── Next round ──
  // After a round closes, Standards builds the next one from the candidates who
  // made the cut: % Yes for regular votes, total score for ranked ones. Rows
  // can be kept or dropped by hand before the polls are created.

  var nrCandidates = [];
  var nrPacing = 'self';
  var nrKind = 'score';       // 'score' | 'yes' | 'manual'
  var sessionRoster = null;

  function pollRound(p) { return (p && p.round) ? p.round : 1; }

  function latestRound() {
    var r = 1;
    pollOrder.forEach(function(pid) { r = Math.max(r, pollRound(pollsMeta[pid])); });
    return r;
  }

  function isCandidatePoll(p) {
    return !!p && ((p.candidates && p.candidates.length) || typeof p.rosterIndex === 'number');
  }

  // The polls the next round is judged on: every closed candidate poll in the
  // latest round. Nothing until that round has at least one closed poll.
  function sourcePolls() {
    var round = latestRound();
    return pollOrder.map(function(pid) { return pollsMeta[pid]; })
      .filter(function(p) { return isCandidatePoll(p) && pollRound(p) === round && p.status === 'closed'; });
  }

  function refreshNextRoundPanel() {
    var panel = $('panel-next-round');
    if (!panel || !sessionId) return;
    var src = sourcePolls();
    panel.classList.toggle('hidden', src.length === 0);
    if (src.length && !$('nr-builder').classList.contains('hidden')) return;
    var intro = $('nr-intro');
    if (intro && src.length) {
      intro.textContent = 'Round ' + latestRound() + ' has ' + src.length + ' closed poll' + (src.length === 1 ? '' : 's') +
        '. Build round ' + (latestRound() + 1) + ' from the candidates who made the cut; it is added to this session\'s queue.';
    }
  }

  function candidateDisplayName(p) {
    if (p.candidates && p.candidates.length === 1) return p.candidates[0];
    if (sessionRoster && typeof p.rosterIndex === 'number' && sessionRoster[p.rosterIndex]) return sessionRoster[p.rosterIndex].name;
    return String(p.name || '').replace(/^#\d+\s+/, '');
  }

  function rosterIndexFor(name, fallback) {
    if (typeof fallback === 'number') return fallback;
    if (!sessionRoster) return null;
    for (var i = 0; i < sessionRoster.length; i++) if (sessionRoster[i] && sessionRoster[i].name === name) return i;
    return null;
  }

  function collectRoundResults() {
    var rows = [];
    var kind = 'manual';
    sourcePolls().forEach(function(p) {
      var agg = p.aggregation || PortalDb.computeAggregation(p.type, p.votes || {}, p.candidates);
      if (p.type === 'ranked' || p.type === 'rush_prelim') {
        kind = 'score';
        var cs = PortalDb.decodeAggregation(agg, p.candidates).candidateScores || {};
        Object.keys(cs).forEach(function(name) {
          rows.push({ name: name, rosterIndex: rosterIndexFor(name, p.candidates && p.candidates.length === 1 ? p.rosterIndex : undefined),
            metric: cs[name].total || 0, voters: cs[name].count || 0 });
        });
      } else if (p.type === 'regular' && agg.candidateOptions) {
        var data = PortalDb.candidateOptionRows(agg, p.candidates, p.options);
        if (data.hasYesNo) kind = 'yes';
        data.rows.forEach(function(r) {
          rows.push({ name: r.name, rosterIndex: rosterIndexFor(r.name), metric: data.hasYesNo ? r.yesPct : null, voters: r.voters });
        });
      } else if (p.type === 'regular') {
        var oc = agg.optionCounts || {}, yes = 0, no = 0, total = 0;
        Object.keys(oc).forEach(function(k) {
          var l = k.toLowerCase(); total += oc[k];
          if (l === 'yes') yes = oc[k]; else if (l === 'no') no = oc[k];
        });
        var hasYN = Object.keys(oc).some(function(k) { return k.toLowerCase() === 'yes'; }) || Object.keys(oc).some(function(k) { return k.toLowerCase() === 'no'; });
        if (hasYN) kind = 'yes';
        var nm = candidateDisplayName(p);
        rows.push({ name: nm, rosterIndex: rosterIndexFor(nm, p.rosterIndex), metric: hasYN ? ((yes + no) ? Math.round(100 * yes / (yes + no)) : 0) : null, voters: total });
      }
    });
    rows.sort(function(a, b) { return ((b.metric || 0) - (a.metric || 0)) || a.name.localeCompare(b.name); });
    return { kind: kind, rows: rows };
  }

  function openRoundBuilder() {
    var load = sessionRoster ? Promise.resolve(sessionRoster) : PortalDb.getRoster(sessionId).then(function(r) { sessionRoster = r || []; return sessionRoster; });
    load.catch(function() { sessionRoster = []; }).then(function() {
      var res = collectRoundResults();
      nrKind = res.kind;
      nrCandidates = res.rows;
      var cutoff = $('nr-cutoff'), label = $('nr-cutoff-label');
      if (nrKind === 'yes') { label.textContent = 'Advance at % Yes of at least'; cutoff.value = 50; cutoff.disabled = false; }
      else if (nrKind === 'score') {
        var src = sourcePolls()[0];
        label.textContent = 'Advance at a total score of at least'; cutoff.value = (src && src.minimumScore != null) ? src.minimumScore : 0; cutoff.disabled = false;
      } else { label.textContent = 'No Yes/No or score data — pick by hand'; cutoff.value = ''; cutoff.disabled = true; }
      applyRoundCutoff();
      $('nr-builder').classList.remove('hidden');
      $('btn-build-round').classList.add('hidden');
    });
  }

  function applyRoundCutoff() {
    var cut = parseInt($('nr-cutoff').value, 10);
    nrCandidates.forEach(function(c) {
      c.passed = nrKind === 'manual' ? true : (c.metric != null && !isNaN(cut) && c.metric >= cut);
      if (c.keep === undefined || !c.touched) c.keep = c.passed;
    });
    renderRoundList();
  }

  function renderRoundList() {
    var list = $('nr-list');
    list.innerHTML = '';
    nrCandidates.forEach(function(c, i) {
      var row = document.createElement('label');
      row.className = 'nr-row ' + (c.passed ? 'pass' : 'fail');
      var cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = !!c.keep;
      cb.addEventListener('change', function() { c.keep = cb.checked; c.touched = true; updateRoundSummary(); });
      var nm = document.createElement('span');
      nm.className = 'nr-name';
      nm.textContent = (typeof c.rosterIndex === 'number' && sessionRoster && sessionRoster[c.rosterIndex] && sessionRoster[c.rosterIndex].number
        ? '#' + sessionRoster[c.rosterIndex].number + ' ' : '') + c.name;
      var m = document.createElement('span');
      m.className = 'nr-metric';
      m.textContent = c.metric == null ? '—' : (nrKind === 'yes' ? c.metric + '% yes' : c.metric + ' pts') + ' · ' + c.voters + ' votes';
      row.appendChild(cb); row.appendChild(nm); row.appendChild(m);
      list.appendChild(row);
    });
    updateRoundSummary();
  }

  function updateRoundSummary() {
    var keep = nrCandidates.filter(function(c) { return c.keep; }).length;
    var s = $('nr-summary');
    s.textContent = keep + ' of ' + nrCandidates.length + ' advance to round ' + (latestRound() + 1) +
      ' as ' + (nrPacing === 'self' ? 'one self-paced quiz' : keep + ' polls you open one by one') +
      ' (' + typeLabel(sessionType) + (sessionType === 'regular' && voteOptions.length ? ', ' + voteOptions.join(' / ') : '') + '). Untick anyone to drop them.';
    $('btn-create-round').disabled = keep === 0;
    $('btn-create-round').textContent = 'Create round ' + (latestRound() + 1) + ' (' + keep + ')';
  }

  function createNextRound() {
    var keep = nrCandidates.filter(function(c) { return c.keep; });
    if (!keep.length || !sessionId) return;
    var round = latestRound() + 1;
    var type = sessionType === 'ranked' ? 'ranked' : 'regular';
    var updates = {};
    var newOrder = pollOrder.slice();
    var cutoffVal = parseInt($('nr-cutoff').value, 10);

    if (nrPacing === 'self') {
      var pid = db.ref('sessions/' + sessionId + '/polls').push().key;
      var quiz = { name: 'Round ' + round, type: type, candidates: keep.map(function(c) { return c.name; }),
        useRoster: true, round: round, status: 'upcoming' };
      if (type === 'ranked') quiz.minimumScore = isNaN(cutoffVal) ? 0 : cutoffVal;
      else quiz.options = voteOptions || [];
      updates['sessions/' + sessionId + '/polls/' + pid] = quiz;
      newOrder.push(pid);
    } else {
      keep.forEach(function(c) {
        var pid2 = db.ref('sessions/' + sessionId + '/polls').push().key;
        var num = (typeof c.rosterIndex === 'number' && sessionRoster && sessionRoster[c.rosterIndex]) ? sessionRoster[c.rosterIndex].number : null;
        var poll = { name: (num ? '#' + num + ' ' : '') + c.name, type: type, useRoster: true, round: round, status: 'upcoming' };
        if (typeof c.rosterIndex === 'number') poll.rosterIndex = c.rosterIndex;
        if (type === 'ranked') { poll.candidates = [c.name]; poll.minimumScore = isNaN(cutoffVal) ? 0 : cutoffVal; }
        else poll.options = voteOptions || [];
        updates['sessions/' + sessionId + '/polls/' + pid2] = poll;
        newOrder.push(pid2);
      });
    }
    updates['sessions/' + sessionId + '/pollOrder'] = newOrder;
    $('btn-create-round').disabled = true;
    db.ref().update(updates).then(function() {
      closeRoundBuilder();
      alert('Round ' + round + ' added to the queue with ' + keep.length + ' candidate' + (keep.length === 1 ? '' : 's') + '. Use the queue to jump to it.');
    }).catch(function(err) {
      $('btn-create-round').disabled = false;
      alert('Failed to create the round: ' + err.message);
    });
  }

  function closeRoundBuilder() {
    $('nr-builder').classList.add('hidden');
    $('btn-build-round').classList.remove('hidden');
    nrCandidates = [];
    refreshNextRoundPanel();
  }

  function initNextRound() {
    if (!$('btn-build-round')) return;
    $('btn-build-round').addEventListener('click', openRoundBuilder);
    $('btn-cancel-round').addEventListener('click', closeRoundBuilder);
    $('btn-create-round').addEventListener('click', createNextRound);
    $('nr-cutoff').addEventListener('input', applyRoundCutoff);
    var btns = $('nr-pacing').querySelectorAll('.option-preset-btn');
    btns.forEach(function(btn) {
      btn.addEventListener('click', function() {
        btns.forEach(function(b) { b.classList.remove('selected'); });
        btn.classList.add('selected');
        nrPacing = btn.getAttribute('data-pacing') || 'self';
        updateRoundSummary();
      });
    });
  }

  // ── Active poll display ──

  function getCurrentPollId() {
    return pollOrder[currentIndex] || null;
  }

  function getCurrentPollData() {
    var pid = getCurrentPollId();
    return pid ? (pollsMeta[pid] || null) : null;
  }

  function detachActivePollListeners() {
    activePollListeners.forEach(function(off) { off(); });
    activePollListeners = [];
    cachedVotedCount = 0;
  }

  function detachSessionListeners() {
    sessionListeners.forEach(function(off) { off(); });
    sessionListeners = [];
  }

  function attachActivePollListeners() {
    detachActivePollListeners();
    var pollId = getCurrentPollId();
    if (!pollId || !sessionId) return;

    var hasVotedRef = db.ref('sessions/' + sessionId + '/polls/' + pollId + '/hasVoted');
    var hasVotedCb = hasVotedRef.on('value', function(snap) {
      cachedVotedMap = snap.val() || {};
      cachedVotedCount = Object.keys(cachedVotedMap).length;
      updateVoteCount();
      renderConnectedList();
    });
    activePollListeners.push(function() { hasVotedRef.off('value', hasVotedCb); });

    var votesRef = db.ref('sessions/' + sessionId + '/polls/' + pollId + '/votes');
    var votesCb = votesRef.on('value', function() { updateResults(); });
    activePollListeners.push(function() { votesRef.off('value', votesCb); });
  }

  function renderActivePoll() {
    var meta = getCurrentPollData();

    var total = pollOrder.length;
    var single = total <= 1;
    var isLast = currentIndex >= total - 1;
    var prevBtn = $('btn-prev-poll'), openBtn = $('btn-open-poll'),
        closeBtn = $('btn-close-poll'), nextBtn = $('btn-next-poll');
    function show(el, on) { el.classList.toggle('hidden', !on); }

    if (!meta) {
      $('ap-counter').textContent = '';
      $('ap-name').textContent = total ? 'All polls completed' : 'No polls yet';
      $('ap-type').textContent = '';
      $('ap-status').textContent = '';
      $('ap-status').className = 'poll-status hidden';
      $('ap-vote-text').textContent = '0 / 0 voted';
      $('ap-bar-fill').style.width = '0%';
      $('ap-hint').textContent = total
        ? 'Every poll has run. Export the results or end the session above.'
        : 'Add a poll in the queue below and it will show up here.';
      show(prevBtn, total > 0); prevBtn.disabled = currentIndex <= 0;
      show(openBtn, false); show(closeBtn, false); show(nextBtn, false);
      $('ap-threshold-row').classList.add('hidden');
      $('results-summary').innerHTML = '';
      var tb = $('results-voters').querySelector('tbody');
      if (tb) tb.innerHTML = '';
      detachActivePollListeners();
      return;
    }

    $('ap-counter').textContent = single ? '' : 'Poll ' + (currentIndex + 1) + ' of ' + total;
    $('ap-name').textContent = meta.name || '—';
    $('ap-type').textContent = typeLabel(meta.type);
    var status = meta.status || 'upcoming';
    $('ap-status').textContent = status;
    $('ap-status').className = 'poll-status ' + status;

    // One main action per state: Open → Close → Next. Reopening a closed poll
    // stays possible but is demoted to a small secondary button.
    // Set classes first: assigning className would wipe a 'hidden' set before it.
    openBtn.className = status === 'closed' ? 'btn reopen' : 'btn btn-primary now-main';
    openBtn.textContent = status === 'closed' ? 'Reopen' : 'Open poll';
    nextBtn.className = status === 'closed' ? 'btn btn-primary now-main' : 'btn secondary now-side';
    nextBtn.textContent = status === 'closed' ? 'Next poll →' : 'Skip →';
    nextBtn.disabled = isLast;
    prevBtn.disabled = currentIndex <= 0;
    show(prevBtn, !single);
    show(openBtn, status !== 'open');
    show(closeBtn, status === 'open');
    // Nothing to move on to after the last poll, so drop the button rather
    // than parking a big disabled one there; the hint already says it's last.
    show(nextBtn, !single && status !== 'open' && !isLast);

    var hints = {
      upcoming: 'Brothers see this the moment you open it.',
      open: 'Brothers are voting. Close it when the room is done — results lock in then.',
      closed: isLast ? 'Results are locked. That was the last poll.' : 'Results are locked. Move on when you are ready.'
    };
    $('ap-hint').textContent = hints[status] || '';
    $('results-heading').textContent = status === 'open' ? 'Live results' : 'Results';
    renderWaitingOn();

    var type = meta.type;
    if (type === 'ranked' || type === 'rush_prelim') {
      $('ap-threshold').value = meta.minimumScore != null ? meta.minimumScore : 0;
      $('ap-threshold-row').classList.remove('hidden');
    } else {
      $('ap-threshold-row').classList.add('hidden');
    }

    attachActivePollListeners();
  }

  function updateVoteCount() {
    var total = connectedCount;
    // Count votes from people still in the session against the session size;
    // votes from brothers removed since are still counted in the result, and
    // are called out separately so the bar never reads 50 / 45.
    var votedIn = Object.keys(cachedVotedMap).filter(function(uid) { return !!connectedBrothersData[uid]; }).length;
    var extra = cachedVotedCount - votedIn;
    $('ap-vote-text').textContent = votedIn + ' / ' + total + ' voted' +
      (total && onlineCount < total ? ' · ' + (total - onlineCount) + ' offline' : '') +
      (extra > 0 ? ' · +' + extra + ' from removed' : '');
    $('ap-bar-fill').style.width = (total > 0) ? Math.min(100, Math.round(votedIn / total * 100)) + '%' : '0%';
    renderWaitingOn();
  }

  // Who is in the room but has not submitted yet — so Standards knows whether
  // to hold the poll open. Self-paced quizzes also show how far along each is.
  function renderWaitingOn() {
    var el = $('ap-waiting');
    if (!el) return;
    var meta = getCurrentPollData();
    if (!meta || meta.status !== 'open') { el.textContent = ''; return; }
    var progress = meta.progress || {};
    var waiting = Object.keys(connectedBrothersData).filter(function(uid) { return !cachedVotedMap[uid]; });
    if (!waiting.length) {
      el.textContent = connectedCount ? 'Everyone connected has voted.' : '';
      return;
    }
    var shown = waiting.slice(0, 15);
    var pending = shown.length;
    var labels = new Array(shown.length);
    shown.forEach(function(uid, i) {
      getName(uid, function(n) {
        var pr = progress[uid];
        labels[i] = n + (pr && pr.total ? ' (' + pr.answered + '/' + pr.total + ')' : '') + (isOnline(uid) ? '' : ' · offline');
        if (--pending === 0) {
          el.textContent = 'Waiting on ' + waiting.length + ': ' + labels.join(', ') +
            (waiting.length > shown.length ? ', and ' + (waiting.length - shown.length) + ' more' : '');
        }
      });
    });
  }

  // ── Connected brothers list + kick ──

  function renderConnectedList() {
    var list = $('connected-list');
    if (!list) return;
    var q = (($('connected-search') && $('connected-search').value) || '').trim().toLowerCase();
    var uids = Object.keys(connectedBrothersData);
    if (uids.length === 0) {
      list.innerHTML = '<li style="color:#999;">No brothers connected yet.</li>';
      return;
    }
    // Alphabetical once names are known; unknown names sink to the bottom.
    uids.sort(function(a, b) { return (nameCache[a] || '~').localeCompare(nameCache[b] || '~'); });
    list.innerHTML = '';
    uids.forEach(function(uid) {
      var li = document.createElement('li');
      var nameSpan = document.createElement('span');
      nameSpan.className = 'bro-name';
      nameSpan.textContent = nameCache[uid] || 'Loading...';

      function applyFilter() {
        var n = (nameCache[uid] || '').toLowerCase();
        li.classList.toggle('hidden', !!q && n.indexOf(q) === -1);
      }
      getName(uid, function(n) { nameSpan.textContent = n; applyFilter(); });

      var dot = document.createElement('span');
      dot.className = 'bro-status ' + (isOnline(uid) ? 'online' : 'offline');
      dot.title = isOnline(uid) ? 'Online' : 'Offline (phone asleep, closed, or no signal)';
      li.appendChild(dot);

      var voted = document.createElement('span');
      voted.className = 'bro-voted';
      voted.textContent = cachedVotedMap[uid] ? '✓ voted' : (isOnline(uid) ? '' : 'offline');
      if (!isOnline(uid) && !cachedVotedMap[uid]) voted.classList.add('is-off');

      var kickBtn = document.createElement('button');
      kickBtn.className = 'btn-kick';
      kickBtn.textContent = 'Kick';
      kickBtn.addEventListener('click', function() {
        kickBrother(uid, nameSpan.textContent);
      });

      li.appendChild(nameSpan);
      li.appendChild(voted);
      li.appendChild(kickBtn);
      list.appendChild(li);
      applyFilter();
    });
  }

  // Drop everyone whose phone is not connected right now. Standards uses this
  // after a break, so the voted/total count only counts people in the room.
  function removeOffline() {
    if (!sessionId) return;
    var offline = Object.keys(connectedBrothersData).filter(function(uid) { return !isOnline(uid); });
    if (!offline.length) return;
    if (!confirm('Remove ' + offline.length + ' offline brother' + (offline.length === 1 ? '' : 's') + ' from the session? Anyone who comes back can rejoin with the code.')) return;
    var updates = {};
    offline.forEach(function(uid) { updates['sessions/' + sessionId + '/connectedBrothers/' + uid] = null; });
    db.ref().update(updates).catch(function(err) { alert('Failed to remove: ' + err.message); });
  }

  function kickBrother(uid, name) {
    if (!sessionId) return;
    if (!confirm('Kick ' + name + ' from the session?')) return;
    db.ref('sessions/' + sessionId + '/connectedBrothers/' + uid).remove().catch(function(err) {
      alert('Failed to kick: ' + err.message);
    });
  }

  // ── Poll controls ──

  function openPoll() {
    var pollId = getCurrentPollId();
    if (!pollId) { alert('No poll selected.'); return; }
    db.ref('sessions/' + sessionId + '/polls/' + pollId + '/status').set('open').catch(function(err) {
      alert('Failed to open: ' + err.message);
    });
  }

  function closePoll(autoAdvance) {
    var pollId = getCurrentPollId();
    if (!pollId) { alert('No poll selected.'); return; }

    var ref = db.ref('sessions/' + sessionId + '/polls/' + pollId);
    ref.once('value').then(function(snap) {
      var p = snap.val();
      if (!p) throw new Error('Poll not found.');
      var votes = p.votes || {};
      var agg = PortalDb.computeAggregation(p.type, votes, p.candidates);
      return ref.update({ status: 'closed', aggregation: agg });
    }).then(function() {
      if (autoAdvance && currentIndex + 1 < pollOrder.length) {
        db.ref('sessions/' + sessionId + '/currentPollIndex').set(currentIndex + 1);
      }
    }).catch(function(err) {
      alert('Close failed: ' + err.message);
    });
  }

  function nextPoll() {
    if (currentIndex + 1 >= pollOrder.length) {
      alert('No more polls in the queue.');
      return;
    }
    var meta = getCurrentPollData();
    if (meta && meta.status === 'open') {
      closePoll(true);
    } else {
      db.ref('sessions/' + sessionId + '/currentPollIndex').set(currentIndex + 1);
    }
  }

  function prevPoll() {
    if (currentIndex <= 0) {
      alert('Already at the first poll.');
      return;
    }
    db.ref('sessions/' + sessionId + '/currentPollIndex').set(currentIndex - 1);
  }

  function saveThreshold() {
    var pollId = getCurrentPollId();
    var meta = getCurrentPollData();
    if (!pollId || !meta) return;
    var val = parseInt($('ap-threshold').value, 10);
    if (meta.type === 'ranked' || meta.type === 'rush_prelim') {
      db.ref('sessions/' + sessionId + '/polls/' + pollId + '/minimumScore').set(val);
    }
  }

  // ── Results ──

  function updateResults() {
    var pollId = getCurrentPollId();
    if (!pollId || !sessionId) return;

    db.ref('sessions/' + sessionId + '/polls/' + pollId).once('value', function(snap) {
      var p = snap.val();
      if (!p) return;
      var votes = p.votes || {};
      var agg = p.aggregation || PortalDb.computeAggregation(p.type, votes, p.candidates);
      var summary = $('results-summary');
      var leaderboard = $('results-leaderboard');
      var voterTable = $('voters-details');
      leaderboard.classList.add('hidden');
      leaderboard.innerHTML = '';

      if (p.type === 'ranked' || p.type === 'rush_prelim') {
        renderRankedResults(p, agg, summary, leaderboard);
        voterTable.classList.add('hidden');
        return;
      }
      voterTable.classList.remove('hidden');

      if (p.type === 'regular' && agg.candidateOptions) {
        var optRows = PortalDb.candidateOptionRows(agg, p.candidates, p.options);
        summary.innerHTML = optRows.rows.length + ' candidates &middot; ' + (agg.totalVoters || 0) + ' voters';
        leaderboard.innerHTML = PortalDb.candidateOptionTableHtml(agg, p.candidates, p.options, 'leaderboard-table');
        leaderboard.classList.remove('hidden');
      } else if (p.type === 'regular') {
        var oc = agg.optionCounts || {};
        var totalVoters = agg.totalVoters || 0;
        var parts = Object.keys(oc).map(function(k) {
          return '<span style="margin-right:1rem;">' + k + ': <strong>' + oc[k] + '</strong></span>';
        });
        summary.innerHTML = parts.join('') + '<span style="color:#888; margin-left:0.5rem;">(' + totalVoters + ' voters)</span>';
      } else if (p.type === 'rush_bid' || p.type === 'motion' || p.type === 'pnm_vote') {
        var total = (agg.yes || 0) + (agg.no || 0);
        var pct = total ? Math.round(100 * agg.yes / total) : 0;
        var thresh = p.threshold != null ? p.threshold : 75;
        var pass = pct >= thresh;
        summary.innerHTML = '<span style="color:' + (pass ? '#2e7d32' : '#c62828') + '">' +
          'Yes: ' + agg.yes + ' &middot; No: ' + agg.no + ' &middot; Abstain: ' + (agg.abstain || 0) +
          ' &mdash; ' + pct + '% Yes (need ' + thresh + '%) &mdash; <strong>' + (pass ? 'PASS' : 'FAIL') + '</strong></span>';
      } else if (p.type === 'pnm_depledge') {
        var dt = (agg.yes || 0) + (agg.no || 0);
        var dp = dt ? Math.round(100 * agg.yes / dt) : 0;
        var depledge = dp > 50;
        summary.innerHTML = '<span style="color:' + (depledge ? '#c62828' : '#2e7d32') + '">' +
          'Yes (de-pledge): ' + agg.yes + ' &middot; No (stay): ' + agg.no +
          ' &mdash; ' + dp + '% &mdash; <strong>' + (depledge ? 'DE-PLEDGE' : 'REMAIN') + '</strong></span>';
      } else {
        summary.innerHTML = '';
      }

      var tbody = voterTable.querySelector('tbody');
      if (!tbody) return;
      var uids = Object.keys(votes);
      if (voterDebounce) clearTimeout(voterDebounce);
      voterDebounce = setTimeout(function() {
        tbody.innerHTML = '';
        uids.forEach(function(uid) {
          var row = tbody.insertRow();
          var nc = row.insertCell(0);
          var vc = row.insertCell(1);
          var v = PortalDb.decodeBallot(votes[uid].vote, (getCurrentPollData() || {}).candidates);
          vc.textContent = typeof v === 'object' ? JSON.stringify(v) : v;
          getName(uid, function(n) { nc.textContent = n; });
        });
      }, 500);
    });
  }

  function renderRankedResults(poll, agg, summaryEl, leaderboardEl) {
    var cs = PortalDb.decodeAggregation(agg, poll.candidates).candidateScores || {};
    var sorted = Object.keys(cs).map(function(name) {
      return { name: name, score: cs[name].total, voters: cs[name].count };
    }).sort(function(a, b) { return b.score - a.score; });

    var minScore = poll.minimumScore != null ? poll.minimumScore : 0;

    summaryEl.innerHTML = sorted.length + ' candidates &middot; ' + (agg.totalVoters || 0) + ' voters &middot; min score: ' + minScore;

    var html = '<table class="leaderboard-table"><thead><tr><th>#</th><th>Name</th><th>Score</th><th>Status</th></tr></thead><tbody>';
    sorted.forEach(function(c, i) {
      var passes = c.score >= minScore;
      html += '<tr><td>' + (i + 1) + '</td><td>' + c.name + '</td><td>' + c.score + '</td>' +
        '<td style="color:' + (passes ? '#2e7d32' : '#c62828') + '; font-weight:600;">' + (passes ? 'PASS' : 'Below cutoff') + '</td></tr>';
    });
    html += '</tbody></table>';
    leaderboardEl.innerHTML = html;
    leaderboardEl.classList.remove('hidden');
  }

  // ── Export ──

  function exportExcel() {
    if (!sessionId || pollOrder.length === 0) { alert('No polls to export.'); return; }
    if (typeof XLSX === 'undefined') { alert('SheetJS not loaded.'); return; }

    buildSessionSnapshot(sessionId, accessCode, function(snapshot) {
      var wb = XLSX.utils.book_new();
      var overviewRows = [['Poll', 'Type', 'Yes', 'No', 'Abstain', 'Yes %']];
      var pollSheets = [];

      pollOrder.forEach(function(pid, i) {
        var p = snapshot.polls[pid];
        if (!p) return;
        var agg = p.aggregation || {};
        var voters = p.voters || {};
        var voterKeys = Object.keys(voters);
        var isRanked = p.type === 'ranked' || p.type === 'rush_prelim';

        // ── Overview row ──
        var isCandidateQuiz = p.type === 'regular' && !!agg.candidateOptions;
        if (isRanked) {
          overviewRows.push([p.name || '', typeLabel(p.type), '—', '—', '—', 'Ranked (see tab)']);
        } else if (isCandidateQuiz) {
          overviewRows.push([p.name || '', typeLabel(p.type), '—', '—', '—', 'Per candidate (see tab)']);
        } else if (p.type === 'regular') {
          var oc = agg.optionCounts || {};
          var ocKeys = Object.keys(oc).map(function(k) { return k.toLowerCase(); });
          var isYN = ocKeys.indexOf('yes') !== -1 && ocKeys.indexOf('no') !== -1;
          if (isYN) {
            var yes = 0, no = 0, abstain = 0;
            Object.keys(oc).forEach(function(k) {
              var l = k.toLowerCase();
              if (l === 'yes') yes = oc[k];
              else if (l === 'no') no = oc[k];
              else abstain += oc[k];
            });
            var total = yes + no;
            var pct = total ? Math.round(100 * yes / total) : 0;
            overviewRows.push([p.name || '', typeLabel(p.type), yes, no, abstain, pct + '%']);
          } else {
            var breakdown = Object.keys(oc).map(function(k) { return k + ': ' + oc[k]; }).join(', ');
            overviewRows.push([p.name || '', typeLabel(p.type), breakdown, '', '', '—']);
          }
        } else {
          var yes = agg.yes || 0, no = agg.no || 0, abstain = agg.abstain || 0;
          var total = yes + no;
          var pct = total ? Math.round(100 * yes / total) : 0;
          var abstainCell = p.type === 'pnm_depledge' ? '—' : abstain;
          overviewRows.push([p.name || '', typeLabel(p.type), yes, no, abstainCell, pct + '%']);
        }

        // ── Individual poll sheet ──
        var pollRows;
        if (isRanked) {
          var cs = PortalDb.decodeAggregation(agg, p.candidates).candidateScores || {};
          var sorted = Object.keys(cs)
            .map(function(n) { return { name: n, score: cs[n].total || 0 }; })
            .sort(function(a, b) { return b.score - a.score; });
          pollRows = [['Poll: ' + (p.name || '')], ['Type: ' + typeLabel(p.type)], [],
            ['Rank', 'Candidate', 'Score']];
          sorted.forEach(function(c, idx) { pollRows.push([idx + 1, c.name, c.score]); });
        } else if (isCandidateQuiz) {
          var cq = PortalDb.candidateOptionRows(agg, p.candidates, p.options);
          pollRows = [['Poll: ' + (p.name || '')], ['Type: ' + typeLabel(p.type)], [],
            ['Rank', 'Candidate'].concat(cq.options).concat(cq.hasYesNo ? ['% Yes'] : [])];
          cq.rows.forEach(function(r, idx) {
            pollRows.push([idx + 1, r.name].concat(cq.options.map(function(o) { return r.counts[o] || 0; }))
              .concat(cq.hasYesNo ? [r.yesPct + '%'] : []));
          });
        } else {
          pollRows = [['Poll: ' + (p.name || '')], ['Type: ' + typeLabel(p.type)], [],
            ['Brother', 'Vote']];
          voterKeys.forEach(function(uid) {
            var v = voters[uid].vote;
            pollRows.push([voters[uid].name, typeof v === 'object' ? JSON.stringify(v) : v]);
          });
        }
        pollSheets.push({
          name: (i + 1) + '. ' + (p.name || 'Poll').substring(0, 25),
          rows: pollRows
        });
      });

      // Overview goes first, individual tabs follow
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(overviewRows), 'Overview');
      pollSheets.forEach(function(sheet) {
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheet.rows), sheet.name);
      });

      XLSX.writeFile(wb, 'session_' + (accessCode || 'results') + '.xlsx');
    });
  }

  // ── Real-time listeners ──

  function onErr(label) {
    return function(err) {
      console.error('Firebase listener error [' + label + ']:', err.message);
    };
  }

  function startListeners() {
    if (!sessionId) return;

    var idxRef = db.ref('sessions/' + sessionId + '/currentPollIndex');
    var idxCb = idxRef.on('value', function(s) {
      var newIdx = typeof s.val() === 'number' ? s.val() : 0;
      var changed = newIdx !== currentIndex;
      currentIndex = newIdx;
      renderQueue();
      if (changed) renderActivePoll();
    }, onErr('currentPollIndex'));
    sessionListeners.push(function() { idxRef.off('value', idxCb); });

    var orderRef = db.ref('sessions/' + sessionId + '/pollOrder');
    var orderCb = orderRef.on('value', function(s) {
      pollOrder = s.val() || [];
      renderQueue();
      renderActivePoll();
    }, onErr('pollOrder'));
    sessionListeners.push(function() { orderRef.off('value', orderCb); });

    var pollsRef = db.ref('sessions/' + sessionId + '/polls');
    var pollsCb = pollsRef.on('value', function(s) {
      pollsMeta = s.val() || {};
      renderQueue();
      renderActivePoll();
    }, onErr('polls'));
    sessionListeners.push(function() { pollsRef.off('value', pollsCb); });

    var connRef = db.ref('sessions/' + sessionId + '/connectedBrothers');
    var connCb = connRef.on('value', function(s) {
      connectedBrothersData = s.val() || {};
      connectedCount = Object.keys(connectedBrothersData).length;
      onlineCount = Object.keys(connectedBrothersData).filter(isOnline).length;
      $('connected-count').textContent = connectedCount;
      $('bar-connected').textContent = connectedCount + ' in session · ' + onlineCount + ' online';
      var offBtn = $('btn-remove-offline');
      if (offBtn) {
        var off = connectedCount - onlineCount;
        offBtn.textContent = 'Remove offline' + (off ? ' (' + off + ')' : '');
        offBtn.disabled = off === 0;
      }
      renderConnectedList();
      updateVoteCount();
    }, onErr('connectedBrothers'));
    sessionListeners.push(function() { connRef.off('value', connCb); });

    var infoRef = db.ref('.info/connected');
    var infoCb = infoRef.on('value', function(s) {
      showReconnect(!s.val());
    });
    sessionListeners.push(function() { infoRef.off('value', infoCb); });
  }

  // ── Init ──

  function init() {
    PortalAuth.requireStandards().then(function(profile) {
      if (!profile) return;
      PortalAuth.initNav(profile);

      initTypePicker();
      initBallotPicker();
      initNextRound();
      if ($('connected-search')) $('connected-search').addEventListener('input', renderConnectedList);
      if ($('btn-remove-offline')) $('btn-remove-offline').addEventListener('click', removeOffline);
      initSlideUpload();
      initPacingPicker();
      refreshSetupSteps();

      $('btn-create-session').addEventListener('click', createSession);
      $('btn-end-session').addEventListener('click', endSession);

      // Ranked form
      $('btn-add-ranked').addEventListener('click', addRankedPoll);
      $('ranked-poll-name').addEventListener('keydown', function(e) {
        if (e.key === 'Enter') { e.preventDefault(); addRankedPoll(); }
      });

      // Regular form
      $('btn-add-regular').addEventListener('click', addRegularPoll);
      $('regular-poll-name').addEventListener('keydown', function(e) {
        if (e.key === 'Enter') { e.preventDefault(); addRegularPoll(); }
      });
      $('btn-toggle-batch').addEventListener('click', function() {
        var g = $('batch-group');
        var visible = !g.classList.contains('hidden');
        g.classList.toggle('hidden');
        this.textContent = visible ? '+ Add several at once' : '− Hide';
      });
      $('btn-batch-add').addEventListener('click', batchAddRegularPolls);

      $('btn-open-poll').addEventListener('click', openPoll);
      $('btn-close-poll').addEventListener('click', function() { closePoll(true); });
      $('btn-next-poll').addEventListener('click', nextPoll);
      $('btn-prev-poll').addEventListener('click', prevPoll);
      $('btn-save-threshold').addEventListener('click', saveThreshold);
      $('btn-export-excel').addEventListener('click', exportExcel);

      // Rejoin saved session
      var saved = getSavedSession();
      if (saved && saved.sid) {
        db.ref('sessions/' + saved.sid + '/meta/status').once('value').then(function(snap) {
          if (snap.val() && snap.val() !== 'ended') {
            rejoinSession(saved.sid, saved.code, saved.type, saved.opts);
          } else {
            clearSavedSession();
          }
        }).catch(function() {
          clearSavedSession();
        });
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
