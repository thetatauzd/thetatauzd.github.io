/**
 * Realtime Database helpers for sessions, polls, votes, aggregation.
 *
 * Poll types:
 *   rush_prelim  — ranked scorecard (+2/+1/0/-1/-2) over a list of candidates
 *   rush_bid     — Yes/No/Abstain, 75% threshold
 *   motion       — Yes/No/Abstain, adjustable threshold
 *   pnm_vote     — Yes/No/Abstain, 75% threshold, flags outliers
 *   pnm_depledge — Yes/No only, 50% threshold
 *
 * Structure:
 *   sessionByCode/{code} = sessionId
 *   sessions/{sessionId}/meta = { accessCode, createdBy, createdAt, status }
 *   sessions/{sessionId}/currentPollIndex = number
 *   sessions/{sessionId}/pollOrder = [ pollId0, pollId1, ... ]
 *   sessions/{sessionId}/polls/{pollId} = { name, type, status, threshold?, minimumScore?, candidates? }
 *   sessions/{sessionId}/polls/{pollId}/votes/{uid} = { vote, votedAt }
 *     - rush_prelim vote is object { candidateName: score }
 *     - all others vote is a string ('yes'/'no'/'abstain')
 *   sessions/{sessionId}/polls/{pollId}/hasVoted/{uid} = true
 *   sessions/{sessionId}/polls/{pollId}/aggregation
 *     - rush_prelim: { candidateScores: { safeKey: { name, total, count } }, totalVoters }
 *       (keys are ballotKey(name) so they are legal Firebase keys; use
 *       decodeAggregation() before displaying)
 *     - yes/no types: { yes, no, abstain, totalVoters }
 *   sessions/{sessionId}/connectedBrothers/{uid} = timestamp (presence)
 *   sessionHistory/{sessionId} = snapshot saved when session ends
 *   timers/active = { startedAt, duration, status, ... }
 */
(function(global) {
  'use strict';

  const db = typeof firebase !== 'undefined' ? firebase.database() : null;

  const POLL_TYPES = {
    RANKED: 'ranked',
    REGULAR: 'regular',
    RUSH_PRELIM: 'rush_prelim',
    RUSH_BID: 'rush_bid',
    MOTION: 'motion',
    PNM_VOTE: 'pnm_vote',
    PNM_DEPLEDGE: 'pnm_depledge'
  };

  function getDb() {
    return db;
  }

  function sessionByCodeRef(code) {
    return db && code ? db.ref('sessionByCode/' + code.toUpperCase().replace(/\s/g, '')) : null;
  }

  function sessionRef(sessionId) {
    return db && sessionId ? db.ref('sessions/' + sessionId) : null;
  }

  function sessionMetaRef(sessionId) {
    var r = sessionRef(sessionId);
    return r ? r.child('meta') : null;
  }

  function sessionPollOrderRef(sessionId) {
    var r = sessionRef(sessionId);
    return r ? r.child('pollOrder') : null;
  }

  function sessionCurrentPollIndexRef(sessionId) {
    var r = sessionRef(sessionId);
    return r ? r.child('currentPollIndex') : null;
  }

  function pollRef(sessionId, pollId) {
    var r = sessionRef(sessionId);
    return r && pollId ? r.child('polls').child(pollId) : null;
  }

  function votesRef(sessionId, pollId) {
    var p = pollRef(sessionId, pollId);
    return p ? p.child('votes') : null;
  }

  function hasVotedRef(sessionId, pollId) {
    var p = pollRef(sessionId, pollId);
    return p ? p.child('hasVoted') : null;
  }

  function aggregationRef(sessionId, pollId) {
    var p = pollRef(sessionId, pollId);
    return p ? p.child('aggregation') : null;
  }

  function connectedBrothersRef(sessionId) {
    var r = sessionRef(sessionId);
    return r ? r.child('connectedBrothers') : null;
  }

  /**
   * Roster of candidates parsed from an uploaded slide deck, stored once per
   * session (not per poll) so the photos are only written and downloaded once.
   * sessions/{sessionId}/roster/{index} = { number, name, photo, gpa, ... }
   */
  function rosterRef(sessionId) {
    var r = sessionRef(sessionId);
    return r ? r.child('roster') : null;
  }

  /**
   * Write a roster in small batches. Photo thumbnails make the full payload
   * ~1-2MB, which is fine in total but should not go up as one write.
   */
  function saveRoster(sessionId, candidates, onProgress) {
    var ref = rosterRef(sessionId);
    if (!ref) return Promise.reject(new Error('Invalid session'));
    var list = candidates || [];
    var BATCH = 8;
    var chain = Promise.resolve();
    var done = 0;

    for (var start = 0; start < list.length; start += BATCH) {
      (function(from) {
        chain = chain.then(function() {
          var updates = {};
          for (var i = from; i < Math.min(from + BATCH, list.length); i++) {
            updates[String(i)] = list[i];
          }
          return ref.update(updates).then(function() {
            done = Math.min(from + BATCH, list.length);
            if (onProgress) onProgress(done, list.length);
          });
        });
      })(start);
    }
    return chain;
  }

  function getRoster(sessionId) {
    var ref = rosterRef(sessionId);
    if (!ref) return Promise.resolve([]);
    return ref.once('value').then(function(snap) {
      var val = snap.val();
      if (!val) return [];
      // Firebase returns a sparse object or an array depending on the keys.
      if (Array.isArray(val)) return val.filter(Boolean);
      return Object.keys(val)
        .sort(function(a, b) { return Number(a) - Number(b); })
        .map(function(k) { return val[k]; });
    });
  }

  function getSessionIdByCode(code) {
    return new Promise(function(resolve, reject) {
      var ref = sessionByCodeRef(code);
      if (!ref) {
        resolve(null);
        return;
      }
      ref.once('value')
        .then(function(snap) {
          resolve(snap.val() || null);
        })
        .catch(reject);
    });
  }

  function getCurrentPoll(sessionId) {
    return new Promise(function(resolve, reject) {
      var idxRef = sessionCurrentPollIndexRef(sessionId);
      var orderRef = sessionPollOrderRef(sessionId);
      if (!idxRef || !orderRef) {
        resolve(null);
        return;
      }
      Promise.all([idxRef.once('value'), orderRef.once('value')])
        .then(function(results) {
          var idx = results[0].val();
          var order = results[1].val();
          if (typeof idx !== 'number' || !Array.isArray(order) || !order[idx]) {
            resolve(null);
            return;
          }
          var pollId = order[idx];
          return pollRef(sessionId, pollId).once('value').then(function(snap) {
            var p = snap.val();
            if (!p) {
              resolve(null);
              return;
            }
            resolve({
              pollId: pollId,
              name: p.name,
              type: p.type,
              candidates: p.candidates || [],
              threshold: p.threshold != null ? p.threshold : 75,
              minimumScore: p.minimumScore != null ? p.minimumScore : 0,
              status: p.status || 'open'
            });
          });
        })
        .then(function(r) {
          if (r !== undefined) resolve(r);
        })
        .catch(reject);
    });
  }

  function onCurrentPoll(sessionId, callback) {
    var orderRef = sessionPollOrderRef(sessionId);
    var idxRef = sessionCurrentPollIndexRef(sessionId);
    if (!orderRef || !idxRef) return function() {};

    var orderSnap, idxSnap;
    function update() {
      if (orderSnap == null || idxSnap == null) return;
      var order = orderSnap.val();
      var idx = idxSnap.val();
      if (!Array.isArray(order) || typeof idx !== 'number' || !order[idx]) {
        callback(null);
        return;
      }
      var pollId = order[idx];
      pollRef(sessionId, pollId).once('value').then(function(snap) {
        var p = snap.val();
        callback(p ? {
          pollId: pollId, name: p.name, type: p.type,
          candidates: p.candidates || [],
          threshold: p.threshold != null ? p.threshold : 75,
          minimumScore: p.minimumScore != null ? p.minimumScore : 0,
          status: p.status || 'open'
        } : null);
      });
    }
    var offOrder = orderRef.on('value', function(s) {
      orderSnap = s;
      update();
    });
    var offIdx = idxRef.on('value', function(s) {
      idxSnap = s;
      update();
    });
    return function() {
      offOrder();
      offIdx();
    };
  }

  function submitVote(sessionId, pollId, uid, vote) {
    var vRef = votesRef(sessionId, pollId);
    var hRef = hasVotedRef(sessionId, pollId);
    if (!vRef || !hRef) return Promise.reject(new Error('Invalid session or poll'));
    var payload = { vote: vote, votedAt: firebase.database.ServerValue.TIMESTAMP };
    var updates = {};
    updates['sessions/' + sessionId + '/polls/' + pollId + '/votes/' + uid] = payload;
    updates['sessions/' + sessionId + '/polls/' + pollId + '/hasVoted/' + uid] = true;
    return db.ref().update(updates);
  }

  function getMyVote(sessionId, pollId, uid) {
    var ref = votesRef(sessionId, pollId);
    if (!ref) return Promise.resolve(null);
    return ref.child(uid).once('value').then(function(s) {
      return s.val();
    });
  }

  function onHasVoted(sessionId, pollId, callback) {
    var ref = hasVotedRef(sessionId, pollId);
    if (!ref) return function() {};
    return ref.on('value', function(snap) {
      callback(snap.val() || {});
    });
  }

  function onAggregation(sessionId, pollId, callback) {
    var ref = aggregationRef(sessionId, pollId);
    if (!ref) return function() {};
    return ref.on('value', function(snap) {
      callback(snap.val() || {});
    });
  }

  function setConnected(sessionId, uid, connected) {
    var ref = connectedBrothersRef(sessionId);
    if (!ref) return Promise.resolve();
    if (connected) {
      return ref.child(uid).set(firebase.database.ServerValue.TIMESTAMP);
    } else {
      return ref.child(uid).remove();
    }
  }

  function onConnectedBrothers(sessionId, callback) {
    var ref = connectedBrothersRef(sessionId);
    if (!ref) return function() {};
    return ref.on('value', function(snap) {
      var val = snap.val() || {};
      callback(Object.keys(val).length, val);
    });
  }

  /**
   * Scorecard ballots are stored as { candidate: score }. Firebase forbids
   * . # $ [ ] / in keys, so a candidate like "Jorge Naranjo Jr." made the
   * write throw synchronously and left every phone stuck on "Submitting…".
   * Ballots are written under a safe key and decoded back to the real name
   * wherever they are read. A name with none of those characters is its own
   * key, so ballots stored before this change decode unchanged.
   */
  function ballotKey(name) {
    return String(name == null ? '' : name).replace(/[.#$\[\]\/]/g, '_');
  }

  function decodeBallot(ballot, candidates) {
    if (!ballot || typeof ballot !== 'object') return ballot;
    var byKey = {};
    (candidates || []).forEach(function(c) { byKey[ballotKey(c)] = c; });
    var out = {};
    Object.keys(ballot).forEach(function(k) {
      out[byKey[k] || k] = ballot[k];
    });
    return out;
  }

  /**
   * Returns a copy of a ranked aggregation whose candidateScores are keyed by
   * the real candidate name, for display and export. Works on both the new
   * safe-keyed shape (entries carry .name) and aggregations stored before
   * this change (keyed by plain names, which were already legal keys).
   */
  function decodeAggregation(agg, candidates) {
    if (!agg || typeof agg !== 'object' || !agg.candidateScores) return agg || {};
    var byKey = {};
    (candidates || []).forEach(function(c) { byKey[ballotKey(c)] = c; });
    var cs = agg.candidateScores, out = {};
    Object.keys(cs).forEach(function(k) {
      var entry = cs[k] || {};
      out[entry.name || byKey[k] || k] = entry;
    });
    var copy = {};
    Object.keys(agg).forEach(function(k) { copy[k] = agg[k]; });
    copy.candidateScores = out;
    return copy;
  }

  /**
   * Compute aggregation from votes snapshot.
   * ranked / rush_prelim: vote is { candidateName: score }, sums scores per candidate.
   * regular: counts votes per option string.
   * rush_bid / motion / pnm_vote / pnm_depledge: counts yes/no/abstain.
   */
  function computeAggregation(pollType, votesObj, candidates) {
    var votes = votesObj || {};
    var uids = Object.keys(votes);

    if (pollType === POLL_TYPES.RANKED || pollType === POLL_TYPES.RUSH_PRELIM) {
      // This object is written straight into Firebase by closePoll(), so it
      // must be keyed by the storage-safe key (a name like "Jorge Naranjo Jr."
      // contains a "." and is an illegal key). The real name rides along in
      // each entry; decodeAggregation() restores name-keyed data for display.
      var candidateScores = {};
      (candidates || []).forEach(function(c) {
        candidateScores[ballotKey(c)] = { name: c, total: 0, count: 0 };
      });
      uids.forEach(function(uid) {
        var ballot = votes[uid].vote;
        if (typeof ballot === 'object' && ballot !== null) {
          Object.keys(ballot).forEach(function(rawKey) {
            var key = ballotKey(rawKey);
            if (!candidateScores[key]) candidateScores[key] = { name: rawKey, total: 0, count: 0 };
            candidateScores[key].total += Number(ballot[rawKey]) || 0;
            candidateScores[key].count++;
          });
        }
      });
      return { candidateScores: candidateScores, totalVoters: uids.length };
    }

    if (pollType === POLL_TYPES.REGULAR) {
      var optionCounts = {};
      uids.forEach(function(uid) {
        var v = votes[uid].vote;
        if (typeof v === 'string') {
          optionCounts[v] = (optionCounts[v] || 0) + 1;
        }
      });
      return { optionCounts: optionCounts, totalVoters: uids.length };
    }

    // yes/no/abstain vote types
    var yes = 0, no = 0, abstain = 0;
    uids.forEach(function(uid) {
      var v = votes[uid].vote;
      if (v === 'yes') yes++;
      else if (v === 'no') no++;
      else if (v === 'abstain') abstain++;
    });

    if (pollType === POLL_TYPES.PNM_DEPLEDGE) {
      return { yes: yes, no: no, abstain: 0 };
    }

    return { yes: yes, no: no, abstain: abstain };
  }

  global.PortalDb = {
    POLL_TYPES: POLL_TYPES,
    getDb: getDb,
    sessionByCodeRef: sessionByCodeRef,
    sessionRef: sessionRef,
    sessionMetaRef: sessionMetaRef,
    sessionPollOrderRef: sessionPollOrderRef,
    sessionCurrentPollIndexRef: sessionCurrentPollIndexRef,
    pollRef: pollRef,
    votesRef: votesRef,
    hasVotedRef: hasVotedRef,
    aggregationRef: aggregationRef,
    connectedBrothersRef: connectedBrothersRef,
    rosterRef: rosterRef,
    saveRoster: saveRoster,
    getRoster: getRoster,
    getSessionIdByCode: getSessionIdByCode,
    getCurrentPoll: getCurrentPoll,
    onCurrentPoll: onCurrentPoll,
    submitVote: submitVote,
    getMyVote: getMyVote,
    onHasVoted: onHasVoted,
    onAggregation: onAggregation,
    setConnected: setConnected,
    onConnectedBrothers: onConnectedBrothers,
    ballotKey: ballotKey,
    decodeBallot: decodeBallot,
    decodeAggregation: decodeAggregation,
    computeAggregation: computeAggregation
  };
})(typeof window !== 'undefined' ? window : this);
