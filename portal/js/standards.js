/**
 * Standards session control – real-time queue, active poll, connected list with kick, end session.
 */
(function() {
  'use strict';

  var db = firebase.database();
  var sessionId = null;
  var accessCode = null;
  var pollOrder = [];
  var pollsMeta = {};
  var currentIndex = 0;
  var voterDebounce = null;
  var nameCache = {};
  var connectedCount = 0;
  var connectedBrothersData = {};
  var activePollListeners = [];
  var sessionListeners = [];

  function $(id) { return document.getElementById(id); }

  function saveSession() {
    if (sessionId && accessCode) {
      sessionStorage.setItem('standards_session', JSON.stringify({ sid: sessionId, code: accessCode }));
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

  function showSessionPanels() {
    ['panel-active-poll', 'panel-queue', 'panel-results', 'panel-connected'].forEach(function(id) {
      $(id).classList.remove('hidden');
    });
    $('session-active-info').classList.remove('hidden');
    $('active-code').textContent = accessCode;
    $('link-open-regent').href = 'regent.html#' + sessionId;
    $('btn-create-session').disabled = true;
    $('session-code').disabled = true;
  }

  function hideSessionPanels() {
    ['panel-active-poll', 'panel-queue', 'panel-results', 'panel-connected'].forEach(function(id) {
      $(id).classList.add('hidden');
    });
    $('session-active-info').classList.add('hidden');
    $('btn-create-session').disabled = false;
    $('session-code').disabled = false;
    $('session-code').value = '';
  }

  // ── Session ──

  function rejoinSession(sid, code) {
    sessionId = sid;
    accessCode = code;
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
          rejoinSession(existingSid, code);
        });
      }
      return createNewSession(code, uid);
    }).catch(function(err) {
      alert('Failed: ' + err.message);
      $('btn-create-session').disabled = false;
    });
  }

  function createNewSession(code, uid) {
    var sid = db.ref('sessions').push().key;
    var updates = {};
    updates['sessionByCode/' + code] = sid;
    updates['sessions/' + sid + '/meta'] = { accessCode: code, createdBy: uid, createdAt: firebase.database.ServerValue.TIMESTAMP, status: 'active' };
    updates['sessions/' + sid + '/currentPollIndex'] = 0;
    updates['sessions/' + sid + '/pollOrder'] = [];

    return db.ref().update(updates).then(function() {
      rejoinSession(sid, code);
    }).catch(function(err) {
      alert('Failed: ' + err.message);
      $('btn-create-session').disabled = false;
    });
  }

  function buildSessionSnapshot(sid, code, cb) {
    var snapshot = {
      accessCode: code,
      endedAt: new Date().toISOString(),
      polls: {}
    };

    db.ref('sessions/' + sid + '/meta').once('value').then(function(metaSnap) {
      var meta = metaSnap.val() || {};
      snapshot.createdAt = meta.createdAt || null;
      snapshot.createdBy = meta.createdBy || null;

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
              inviteSpots: p.inviteSpots != null ? p.inviteSpots : null,
              pledgeSpots: p.pledgeSpots != null ? p.pledgeSpots : null,
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
    if (type === 'rush_bid' || type === 'motion' || type === 'pnm_vote') {
      var total = (agg.yes || 0) + (agg.no || 0);
      var pct = total ? Math.round(100 * agg.yes / total) : 0;
      var thresh = poll.threshold != null ? poll.threshold : 75;
      return pct >= thresh ? 'PASS (' + pct + '%)' : 'FAIL (' + pct + '%)';
    } else if (type === 'pnm_depledge') {
      var dtotal = (agg.yes || 0) + (agg.no || 0);
      var dpct = dtotal ? Math.round(100 * agg.yes / dtotal) : 0;
      return dpct > 50 ? 'DE-PLEDGE (' + dpct + '% voted yes)' : 'REMAIN (' + dpct + '% voted yes)';
    } else if (type === 'rush_prelim') {
      return 'See leaderboard';
    }
    return '';
  }

  function endSession() {
    if (!sessionId) return;
    if (!confirm('End this session? Brothers will be disconnected and voting will stop.')) return;

    $('btn-end-session').disabled = true;
    $('btn-end-session').textContent = 'Ending...';

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
          console.log('Session history saved.');
        }).catch(function(err) {
          console.error('Failed to save session history:', err.message);
          alert('Warning: session ended but history failed to save — ' + err.message);
        });
      });
    }).catch(function(err) {
      alert('Failed to end session: ' + err.message);
      $('btn-end-session').disabled = false;
      $('btn-end-session').textContent = 'End session';
    });
  }

  // ── Add poll ──

  function addPoll() {
    if (!sessionId) { alert('Create a session first.'); return; }
    var type = $('new-poll-type').value;

    if (type === 'rush_prelim') {
      return addRushPrelimPoll();
    }

    var name = ($('new-poll-name').value || '').trim();
    if (!name) { alert('Enter a name.'); return; }

    var threshold = parseInt($('new-poll-threshold').value, 10);
    var data = {
      name: name,
      type: type,
      status: 'upcoming'
    };

    if (type === 'rush_bid' || type === 'motion' || type === 'pnm_vote') {
      data.threshold = isNaN(threshold) ? 75 : threshold;
    }
    if (type === 'pnm_depledge') {
      data.threshold = 50;
    }
    var pollId = db.ref('sessions/' + sessionId + '/polls').push().key;
    var newOrder = pollOrder.slice();
    newOrder.push(pollId);

    var updates = {};
    updates['sessions/' + sessionId + '/polls/' + pollId] = data;
    updates['sessions/' + sessionId + '/pollOrder'] = newOrder;

    db.ref().update(updates).then(function() {
      $('new-poll-name').value = '';
    }).catch(function(err) {
      alert('Failed to add poll: ' + err.message);
    });
  }

  function addRushPrelimPoll() {
    var name = ($('new-poll-name').value || '').trim() || 'Rush Prelim';
    var raw = ($('new-poll-candidates').value || '').trim();
    if (!raw) { alert('Enter candidate names.'); return; }

    var candidates = raw.split(/[\n,]+/).map(function(s) { return s.trim(); }).filter(Boolean);
    if (candidates.length < 1) { alert('Enter at least one candidate name.'); return; }

    var minScore = parseInt($('new-poll-min-score').value, 10) || 0;

    var pollId = db.ref('sessions/' + sessionId + '/polls').push().key;
    var data = {
      name: name,
      type: 'rush_prelim',
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
      $('new-poll-name').value = '';
      $('new-poll-candidates').value = '';
    }).catch(function(err) {
      alert('Failed to add poll: ' + err.message);
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
      if (!meta && hasAnyMeta) {
        return '';
      }
      var name = (meta && meta.name) ? meta.name : 'Loading...';
      var type = (meta && meta.type) ? typeLabel(meta.type) : '';
      var status = (meta && meta.status) ? meta.status : 'upcoming';
      var isPast = (status === 'closed' && i < currentIndex);
      var isCurrent = (i === currentIndex);
      var cls = 'queue-item' + (isPast ? ' past' : '') + (isCurrent ? ' current' : '');

      return '<div class="' + cls + '">' +
        '<span><span class="qi-name">' + (i + 1) + '. ' + name + '</span>' +
        (type ? '<span class="qi-type">' + type + '</span>' : '') + '</span>' +
        '<span class="poll-status ' + status + '">' + status + '</span>' +
        '</div>';
    }).filter(Boolean).join('');
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
    var hasVotedCb = hasVotedRef.on('value', function() { updateVoteCount(); });
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
    if (type === 'rush_prelim') {
      $('ap-threshold').value = meta.minimumScore != null ? meta.minimumScore : 0;
      $('ap-threshold-unit').textContent = 'min score';
      $('ap-threshold-row').classList.remove('hidden');
    } else if (type === 'pnm_depledge') {
      $('ap-threshold').value = 50;
      $('ap-threshold-unit').textContent = '%';
      $('ap-threshold-row').classList.add('hidden');
    } else {
      $('ap-threshold').value = meta.threshold != null ? meta.threshold : 75;
      $('ap-threshold-unit').textContent = '%';
      $('ap-threshold-row').classList.remove('hidden');
    }

    attachActivePollListeners();
  }

  function updateVoteCount() {
    var pollId = getCurrentPollId();
    if (!pollId || !sessionId) return;
    db.ref('sessions/' + sessionId + '/polls/' + pollId + '/hasVoted').once('value', function(snap) {
      var voted = Object.keys(snap.val() || {}).length;
      var total = Math.max(voted, connectedCount);
      $('ap-vote-text').textContent = voted + ' / ' + total + ' voted';
      $('ap-bar-fill').style.width = total ? (voted / total * 100) + '%' : '0%';
    });
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
    if (meta.type === 'rush_prelim') {
      db.ref('sessions/' + sessionId + '/polls/' + pollId + '/minimumScore').set(val);
    } else {
      db.ref('sessions/' + sessionId + '/polls/' + pollId + '/threshold').set(val);
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
      var flags = $('results-flags');
      var voterTable = $('results-voters');
      leaderboard.classList.add('hidden');
      leaderboard.innerHTML = '';
      flags.classList.add('hidden');
      flags.innerHTML = '';

      if (p.type === 'rush_prelim') {
        renderRushPrelimResults(p, agg, summary, leaderboard);
        voterTable.classList.add('hidden');
        return;
      }
      voterTable.classList.remove('hidden');

      if (p.type === 'rush_bid' || p.type === 'motion' || p.type === 'pnm_vote') {
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

      if (p.type === 'pnm_vote' && p.status === 'closed') {
        renderPnmFlags(flags);
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

  function renderRushPrelimResults(poll, agg, summaryEl, leaderboardEl) {
    var cs = agg.candidateScores || {};
    var sorted = Object.keys(cs).map(function(name) {
      return { name: name, score: cs[name].total, voters: cs[name].count };
    }).sort(function(a, b) { return b.score - a.score; });

    var inviteSpots = poll.inviteSpots || 50;
    var minScore = poll.minimumScore != null ? poll.minimumScore : 0;

    summaryEl.innerHTML = sorted.length + ' candidates &middot; ' + (agg.totalVoters || 0) + ' voters &middot; Top ' + inviteSpots + ' invited (min score: ' + minScore + ')';

    var html = '<table class="leaderboard-table"><thead><tr><th>#</th><th>Name</th><th>Score</th><th>Status</th></tr></thead><tbody>';
    sorted.forEach(function(c, i) {
      var invited = i < inviteSpots && c.score >= minScore;
      var cutoff = (i === inviteSpots - 1) ? ' leaderboard-cutoff' : '';
      html += '<tr class="' + cutoff + '"><td>' + (i + 1) + '</td><td>' + c.name + '</td><td>' + c.score + '</td>' +
        '<td style="color:' + (invited ? '#2e7d32' : '#c62828') + '; font-weight:600;">' + (invited ? 'INVITED' : 'Below cutoff') + '</td></tr>';
    });
    html += '</tbody></table>';
    leaderboardEl.innerHTML = html;
    leaderboardEl.classList.remove('hidden');
  }

  function renderPnmFlags(flagsEl) {
    var pnmPolls = [];
    pollOrder.forEach(function(pid) {
      var m = pollsMeta[pid];
      if (m && m.type === 'pnm_vote' && m.status === 'closed' && m.aggregation) {
        var a = m.aggregation;
        var total = (a.yes || 0) + (a.no || 0);
        var pct = total ? (a.yes / total * 100) : 0;
        pnmPolls.push({ pid: pid, name: m.name, pct: pct });
      }
    });
    if (pnmPolls.length < 2) return;

    var mean = pnmPolls.reduce(function(s, p) { return s + p.pct; }, 0) / pnmPolls.length;
    var variance = pnmPolls.reduce(function(s, p) { return s + Math.pow(p.pct - mean, 2); }, 0) / pnmPolls.length;
    var stddev = Math.sqrt(variance);
    var threshold = mean - 2 * stddev;

    var flagged = pnmPolls.filter(function(p) { return p.pct < threshold; });
    if (flagged.length === 0) return;

    var html = '<strong style="color:#e65100;">Flagged PNMs</strong> (2+ std devs below mean of ' +
      Math.round(mean) + '%, cutoff: ' + Math.round(threshold) + '%)<br>';
    flagged.forEach(function(f) {
      html += '<div class="flag-item"><span>' + f.name + ' (' + Math.round(f.pct) + '%)</span>' +
        '<button type="button" class="btn-create-depledge" data-name="' + f.name + '">Create de-pledge vote</button></div>';
    });
    flagsEl.innerHTML = html;
    flagsEl.classList.remove('hidden');

    flagsEl.querySelectorAll('.btn-create-depledge').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var name = this.getAttribute('data-name');
        createDepledgePoll(name);
      });
    });
  }

  function createDepledgePoll(name) {
    if (!sessionId) return;
    if (!confirm('Create a de-pledge vote for "' + name + '"?')) return;
    var pollId = db.ref('sessions/' + sessionId + '/polls').push().key;
    var data = { name: 'De-pledge: ' + name, type: 'pnm_depledge', threshold: 50, status: 'upcoming' };
    var newOrder = pollOrder.slice();
    newOrder.push(pollId);
    var updates = {};
    updates['sessions/' + sessionId + '/polls/' + pollId] = data;
    updates['sessions/' + sessionId + '/pollOrder'] = newOrder;
    db.ref().update(updates).catch(function(err) { alert('Failed: ' + err.message); });
  }

  // ── Export ──

  function exportExcel() {
    if (!sessionId || pollOrder.length === 0) { alert('No polls to export.'); return; }
    if (typeof XLSX === 'undefined') { alert('SheetJS not loaded.'); return; }

    buildSessionSnapshot(sessionId, accessCode, function(snapshot) {
      var wb = XLSX.utils.book_new();
      var summaryRows = [['Poll', 'Type', 'Result', 'Yes', 'No', 'Abstain', 'Voters']];

      pollOrder.forEach(function(pid, i) {
        var p = snapshot.polls[pid];
        if (!p) return;
        var agg = p.aggregation || {};
        var voters = p.voters || {};
        var voterKeys = Object.keys(voters);

        summaryRows.push([
          p.name || '', typeLabel(p.type), p.result || '',
          agg.yes || 0, agg.no || 0, agg.abstain || 0, voterKeys.length
        ]);

        var pollRows;
        if (p.type === 'rush_prelim') {
          var cs = agg.candidateScores || {};
          var sorted = Object.keys(cs).map(function(n) { return { name: n, score: cs[n].total }; })
            .sort(function(a, b) { return b.score - a.score; });
          pollRows = [
            ['Poll: ' + (p.name || '')], ['Type: Rush Prelim'],
            ['Invite spots: ' + (p.inviteSpots || 50)], [],
            ['Rank', 'Candidate', 'Score', 'Status']
          ];
          sorted.forEach(function(c, idx) {
            var invited = idx < (p.inviteSpots || 50) && c.score >= (p.minimumScore || 0);
            pollRows.push([idx + 1, c.name, c.score, invited ? 'INVITED' : 'Below cutoff']);
          });
        } else {
          pollRows = [
            ['Poll: ' + (p.name || '')], ['Type: ' + typeLabel(p.type)],
            ['Result: ' + (p.result || '')], [], ['Brother', 'Vote']
          ];
          voterKeys.forEach(function(uid) {
            var v = voters[uid].vote;
            pollRows.push([voters[uid].name, typeof v === 'object' ? JSON.stringify(v) : v]);
          });
        }
        var sheetName = (i + 1) + '. ' + (p.name || 'Poll').substring(0, 25);
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(pollRows), sheetName);
      });

      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summaryRows), 'Summary');
      XLSX.writeFile(wb, 'session_' + (accessCode || 'results') + '.xlsx');
    });
  }

  // ── Real-time listeners ──

  function onErr(label) {
    return function(err) {
      console.error('Firebase listener error [' + label + ']:', err.message);
      alert('Firebase error (' + label + '): ' + err.message + '\nMake sure you deployed the latest firebase rules.');
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

  // ── Type toggle for add-poll form ──

  function updateTypeFields() {
    var type = $('new-poll-type').value;
    var isRushPrelim = type === 'rush_prelim';
    var hasThreshold = type === 'rush_bid' || type === 'motion' || type === 'pnm_vote';

    $('name-group').classList.toggle('hidden', false);
    $('threshold-group').classList.toggle('hidden', !hasThreshold);
    $('min-score-group').classList.toggle('hidden', !isRushPrelim);
    $('candidates-group').classList.toggle('hidden', !isRushPrelim);

    if (type === 'pnm_depledge') {
      $('new-poll-name').placeholder = 'e.g. De-pledge: John Smith';
    } else if (isRushPrelim) {
      $('new-poll-name').placeholder = 'e.g. Rush Round 1 Prelim';
    } else if (isRushBid) {
      $('new-poll-name').placeholder = 'e.g. John Smith';
    } else if (type === 'pnm_vote') {
      $('new-poll-name').placeholder = 'e.g. Jane Doe';
    } else {
      $('new-poll-name').placeholder = 'e.g. Budget Motion';
    }
  }

  // ── Init ──

  function init() {
    PortalAuth.requireStandards().then(function(profile) {
      if (!profile) return;
      PortalAuth.initNav(profile);

      $('btn-create-session').addEventListener('click', createSession);
      $('btn-end-session').addEventListener('click', endSession);
      $('btn-add-poll').addEventListener('click', addPoll);
      $('new-poll-name').addEventListener('keydown', function(e) {
        if (e.key === 'Enter') { e.preventDefault(); addPoll(); }
      });
      $('btn-open-poll').addEventListener('click', openPoll);
      $('btn-close-poll').addEventListener('click', function() { closePoll(true); });
      $('btn-next-poll').addEventListener('click', nextPoll);
      $('btn-prev-poll').addEventListener('click', prevPoll);
      $('btn-save-threshold').addEventListener('click', saveThreshold);
      $('btn-export-excel').addEventListener('click', exportExcel);
      $('new-poll-type').addEventListener('change', updateTypeFields);
      updateTypeFields();

      var saved = getSavedSession();
      if (saved && saved.sid) {
        db.ref('sessions/' + saved.sid + '/meta/status').once('value').then(function(snap) {
          if (snap.val() && snap.val() !== 'ended') {
            rejoinSession(saved.sid, saved.code);
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
