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
  var connectedCount = 0;
  var connectedBrothersData = {};
  var cachedVotedCount = 0;
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
    $('active-session-type').textContent = '(' + typeLabel(sessionType) + ')';
    $('link-open-regent').href = 'regent.html#' + sessionId;
    $('btn-create-session').disabled = true;
    $('session-code').disabled = true;

    // Hide session type picker and options when active
    $('session-type-picker').classList.add('hidden');
    var regOpts = $('regular-options-setup');
    if (regOpts) regOpts.classList.add('hidden');

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
    ['panel-active-poll', 'panel-queue', 'panel-results', 'panel-connected'].forEach(function(id) {
      $(id).classList.add('hidden');
    });
    $('session-active-info').classList.add('hidden');
    $('btn-create-session').disabled = false;
    $('session-code').disabled = false;
    $('session-code').value = '';

    $('session-type-picker').classList.remove('hidden');
    $('add-ranked-form').classList.add('hidden');
    $('add-regular-form').classList.add('hidden');
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
        $('regular-options-setup').classList.toggle('hidden', selectedSessionType !== 'regular');
      });
    });

    var presetBtns = $('option-presets').querySelectorAll('.option-preset-btn');
    presetBtns.forEach(function(btn) {
      btn.addEventListener('click', function() {
        presetBtns.forEach(function(b) { b.classList.remove('selected'); });
        btn.classList.add('selected');
        selectedPreset = btn.getAttribute('data-preset');
        $('custom-options-group').classList.toggle('hidden', selectedPreset !== 'custom');
      });
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
              aggregation: agg, result: computeResult(p, agg), voters: {}
            };

            var uids = Object.keys(votes);
            if (uids.length === 0) {
              snapshot.polls[pid] = pollSnap;
            } else {
              var namesDone = 0;
              uids.forEach(function(uid) {
                getName(uid, function(n) {
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
          window.location.href = 'history.html';
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

    if (pollOrder.length === 0) {
      container.innerHTML = '<p class="queue-empty">No polls added yet. Add one below.</p>';
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

      var actions = '<div class="qi-actions">';
      actions += '<button class="qi-btn" data-action="up"   data-idx="' + i + '"' + (canUp   ? '' : ' disabled') + '>↑</button>';
      actions += '<button class="qi-btn" data-action="down" data-idx="' + i + '"' + (canDown ? '' : ' disabled') + '>↓</button>';
      actions += '<button class="qi-btn qi-remove" data-action="remove" data-idx="' + i + '" data-pid="' + pid + '"' + (canManage ? '' : ' disabled') + '>✕</button>';
      actions += '<span class="poll-status ' + status + '">' + status + '</span>';
      actions += '</div>';

      return '<div class="' + cls + '">' +
        '<span><span class="qi-name">' + (i + 1) + '. ' + name + '</span>' +
        (type ? '<span class="qi-type">' + type + '</span>' : '') + '</span>' +
        actions +
        '</div>';
    }).filter(Boolean).join('');

    // Event delegation for all queue buttons
    container.onclick = function(e) {
      var btn = e.target.closest('[data-action]');
      if (!btn || btn.disabled) return;
      var action = btn.getAttribute('data-action');
      var idx = parseInt(btn.getAttribute('data-idx'), 10);
      if (action === 'remove') {
        removePollFromQueue(btn.getAttribute('data-pid'), idx);
      } else if (action === 'up') {
        movePollInQueue(idx, idx - 1);
      } else if (action === 'down') {
        movePollInQueue(idx, idx + 1);
      }
    };
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
      cachedVotedCount = Object.keys(snap.val() || {}).length;
      updateVoteCount();
    });
    activePollListeners.push(function() { hasVotedRef.off('value', hasVotedCb); });

    var votesRef = db.ref('sessions/' + sessionId + '/polls/' + pollId + '/votes');
    var votesCb = votesRef.on('value', function() { updateResults(); });
    activePollListeners.push(function() { votesRef.off('value', votesCb); });
  }

  function renderActivePoll() {
    var meta = getCurrentPollData();

    if (!meta) {
      $('ap-name').textContent = pollOrder.length ? 'All polls completed' : 'No polls in queue';
      $('ap-type').textContent = '';
      $('ap-status').textContent = '';
      $('ap-status').className = 'poll-status';
      $('ap-vote-text').textContent = '0 / 0 voted';
      $('ap-bar-fill').style.width = '0%';
      $('ap-threshold-row').classList.add('hidden');
      $('results-summary').innerHTML = '';
      var tb = $('results-voters').querySelector('tbody');
      if (tb) tb.innerHTML = '';
      detachActivePollListeners();
      return;
    }

    $('ap-name').textContent = meta.name || '—';
    $('ap-type').textContent = typeLabel(meta.type);
    var status = meta.status || 'upcoming';
    $('ap-status').textContent = status;
    $('ap-status').className = 'poll-status ' + status;

    $('btn-open-poll').disabled = (status === 'open');
    $('btn-close-poll').disabled = (status !== 'open');

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
    var voted = cachedVotedCount;
    var total = connectedCount;
    $('ap-vote-text').textContent = voted + ' / ' + total + ' voted';
    $('ap-bar-fill').style.width = (total > 0) ? Math.min(100, Math.round(voted / total * 100)) + '%' : '0%';
  }

  // ── Connected brothers list + kick ──

  function renderConnectedList() {
    var list = $('connected-list');
    if (!list) return;
    var uids = Object.keys(connectedBrothersData);
    if (uids.length === 0) {
      list.innerHTML = '<li style="color:#999;">No brothers connected yet.</li>';
      return;
    }
    list.innerHTML = '';
    uids.forEach(function(uid) {
      var li = document.createElement('li');
      var nameSpan = document.createElement('span');
      nameSpan.className = 'bro-name';
      nameSpan.textContent = 'Loading...';
      getName(uid, function(n) { nameSpan.textContent = n; });

      var kickBtn = document.createElement('button');
      kickBtn.className = 'btn-kick';
      kickBtn.textContent = 'Kick';
      kickBtn.addEventListener('click', function() {
        kickBrother(uid, nameSpan.textContent);
      });

      li.appendChild(nameSpan);
      li.appendChild(kickBtn);
      list.appendChild(li);
    });
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
      var voterTable = $('results-voters');
      leaderboard.classList.add('hidden');
      leaderboard.innerHTML = '';

      if (p.type === 'ranked' || p.type === 'rush_prelim') {
        renderRankedResults(p, agg, summary, leaderboard);
        voterTable.classList.add('hidden');
        return;
      }
      voterTable.classList.remove('hidden');

      if (p.type === 'regular') {
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
          var v = votes[uid].vote;
          vc.textContent = typeof v === 'object' ? JSON.stringify(v) : v;
          getName(uid, function(n) { nc.textContent = n; });
        });
      }, 500);
    });
  }

  function renderRankedResults(poll, agg, summaryEl, leaderboardEl) {
    var cs = agg.candidateScores || {};
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
        if (isRanked) {
          overviewRows.push([p.name || '', typeLabel(p.type), '—', '—', '—', 'Ranked (see tab)']);
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
          var cs = agg.candidateScores || {};
          var sorted = Object.keys(cs)
            .map(function(n) { return { name: n, score: cs[n].total || 0 }; })
            .sort(function(a, b) { return b.score - a.score; });
          pollRows = [['Poll: ' + (p.name || '')], ['Type: ' + typeLabel(p.type)], [],
            ['Rank', 'Candidate', 'Score']];
          sorted.forEach(function(c, idx) { pollRows.push([idx + 1, c.name, c.score]); });
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
      $('connected-count').textContent = connectedCount;
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
        this.textContent = visible ? '+ Batch add multiple' : '- Hide batch add';
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
