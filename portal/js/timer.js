/**
 * Synchronized event timer – Firebase-synced countdown with admin/rush_chair controls.
 * All clients listen to timers/active and render locally via requestAnimationFrame.
 * Only admin / rush_chair can write to timers/active.
 */
(function(global) {
  'use strict';

  var db = firebase.database();
  var timerRef = db.ref('timers/active');
  var offsetRef = db.ref('.info/serverTimeOffset');

  var serverOffset = 0;
  offsetRef.on('value', function(snap) {
    serverOffset = snap.val() || 0;
  });

  function serverNow() {
    return Date.now() + serverOffset;
  }

  // ── DOM refs ──
  var idleEl       = document.getElementById('timer-idle');
  var activeEl     = document.getElementById('timer-active');
  var controlsEl   = document.getElementById('timer-controls');
  var displayEl    = document.getElementById('timer-display');
  var countdownEl  = document.getElementById('timer-countdown');
  var titleDisplay = document.getElementById('timer-title-display');
  var roundDisplay = document.getElementById('timer-round-display');
  var phaseLabel   = document.getElementById('timer-phase-label');

  var titleInput   = document.getElementById('timer-title-input');
  var durMinInput  = document.getElementById('timer-dur-min');
  var durSecInput  = document.getElementById('timer-dur-sec');
  var switchInput  = document.getElementById('timer-switch-sec');
  var repeatCheck  = document.getElementById('timer-repeat');

  var btnStart  = document.getElementById('btn-timer-start');
  var btnPause  = document.getElementById('btn-timer-pause');
  var btnResume = document.getElementById('btn-timer-resume');
  var btnReset  = document.getElementById('btn-timer-reset');
  var btnStop   = document.getElementById('btn-timer-stop');

  var isAdmin = false;
  var animFrameId = null;
  var currentData = null;
  var lastBeepPhase = null;
  var audioCtx = null;

  // ── Audio ──
  function beep(freq, durationMs) {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      var osc = audioCtx.createOscillator();
      var gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.frequency.value = freq || 880;
      gain.gain.value = 0.3;
      osc.start();
      osc.stop(audioCtx.currentTime + (durationMs || 300) / 1000);
    } catch(e) { /* ignore audio errors */ }
  }

  function tripleBeep() {
    beep(880, 150);
    setTimeout(function() { beep(880, 150); }, 200);
    setTimeout(function() { beep(1100, 300); }, 400);
  }

  // ── Rendering ──
  function formatTime(totalSeconds) {
    var s = Math.max(0, Math.ceil(totalSeconds));
    var m = Math.floor(s / 60);
    var sec = s % 60;
    return m + ':' + (sec < 10 ? '0' : '') + sec;
  }

  function renderFrame() {
    if (!currentData || !currentData.status) {
      showIdle();
      return;
    }

    var data = currentData;
    var status = data.status;

    if (status === 'idle' || status === 'stopped') {
      showIdle();
      return;
    }

    showActive();

    titleDisplay.textContent = data.title || 'Event Timer';
    roundDisplay.textContent = 'Round ' + (data.round || 1);

    var phase = data.currentPhase || 'main';
    var phaseDuration = (phase === 'switching') ? (data.switchingTime || 0) : (data.duration || 0);

    var remaining;
    if (status === 'paused') {
      remaining = phaseDuration - (data.elapsed || 0);
    } else if (status === 'running') {
      var elapsedSinceStart = (serverNow() - data.startedAt) / 1000;
      remaining = phaseDuration - (data.elapsed || 0) - elapsedSinceStart;
    } else {
      remaining = phaseDuration;
    }

    if (remaining < 0) remaining = 0;
    countdownEl.textContent = formatTime(remaining);

    displayEl.className = 'timer-display-area';
    if (phase === 'switching') {
      displayEl.classList.add('timer-phase-switching');
      phaseLabel.textContent = 'Switch Tables!';
    } else {
      displayEl.classList.add('timer-phase-main');
      phaseLabel.textContent = 'Main Timer';
    }

    if (status === 'paused') displayEl.classList.add('timer-paused');

    // Phase transition beep
    var beepKey = phase + '-' + data.round;
    if (beepKey !== lastBeepPhase) {
      if (lastBeepPhase !== null) tripleBeep();
      lastBeepPhase = beepKey;
    }

    // Admin: phase auto-transition
    if (isAdmin && status === 'running' && remaining <= 0) {
      handlePhaseEnd(data);
      return;
    }

    if (status === 'running' || status === 'paused') {
      animFrameId = requestAnimationFrame(renderFrame);
    }
  }

  function handlePhaseEnd(data) {
    if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }

    var phase = data.currentPhase || 'main';
    if (phase === 'main' && data.switchingTime > 0) {
      timerRef.update({
        currentPhase: 'switching',
        elapsed: 0,
        startedAt: firebase.database.ServerValue.TIMESTAMP
      });
    } else if (phase === 'switching' || (phase === 'main' && !data.switchingTime)) {
      if (data.repeat) {
        timerRef.update({
          currentPhase: 'main',
          elapsed: 0,
          round: (data.round || 1) + 1,
          startedAt: firebase.database.ServerValue.TIMESTAMP
        });
      } else {
        timerRef.update({ status: 'stopped', elapsed: 0 });
      }
    }
  }

  function showIdle() {
    idleEl.classList.remove('hidden');
    activeEl.classList.add('hidden');
    if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }
  }

  function showActive() {
    idleEl.classList.add('hidden');
    activeEl.classList.remove('hidden');
  }

  // ── Controls ──
  function getInputDuration() {
    var m = parseFloat(durMinInput.value) || 0;
    var s = parseInt(durSecInput.value, 10) || 0;
    return Math.max(1, Math.round(m * 60) + s);
  }

  function onStart() {
    var dur = getInputDuration();
    var sw = parseInt(switchInput.value, 10) || 0;
    timerRef.set({
      title: titleInput.value.trim() || 'Event Timer',
      duration: dur,
      switchingTime: sw,
      currentPhase: 'main',
      startedAt: firebase.database.ServerValue.TIMESTAMP,
      elapsed: 0,
      round: 1,
      status: 'running',
      repeat: !!repeatCheck.checked,
      createdBy: firebase.auth().currentUser ? firebase.auth().currentUser.uid : ''
    });
  }

  function onPause() {
    if (!currentData || currentData.status !== 'running') return;
    var elapsedSinceStart = (serverNow() - currentData.startedAt) / 1000;
    var totalElapsed = (currentData.elapsed || 0) + elapsedSinceStart;
    timerRef.update({ status: 'paused', elapsed: totalElapsed });
  }

  function onResume() {
    if (!currentData || currentData.status !== 'paused') return;
    timerRef.update({
      status: 'running',
      startedAt: firebase.database.ServerValue.TIMESTAMP
    });
  }

  function onReset() {
    if (!currentData) return;
    timerRef.update({
      currentPhase: 'main',
      elapsed: 0,
      round: 1,
      status: 'paused',
      startedAt: firebase.database.ServerValue.TIMESTAMP
    });
  }

  function onStop() {
    timerRef.update({ status: 'stopped', elapsed: 0 });
  }

  function updateControlState(data) {
    if (!isAdmin) return;
    var st = data ? data.status : null;
    var running = st === 'running';
    var paused  = st === 'paused';

    btnStart.classList.toggle('hidden', running || paused);
    btnPause.classList.toggle('hidden', !running);
    btnResume.classList.toggle('hidden', !paused);

    var inputs = controlsEl.querySelectorAll('input[type="text"], input[type="number"]');
    for (var i = 0; i < inputs.length; i++) {
      inputs[i].disabled = running || paused;
    }
    repeatCheck.disabled = running || paused;
  }

  // ── Firebase listener ──
  function startListening() {
    timerRef.on('value', function(snap) {
      currentData = snap.val();
      if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }
      lastBeepPhase = currentData ? (currentData.currentPhase || 'main') + '-' + (currentData.round || 1) : null;

      if (isAdmin) {
        updateControlState(currentData);
        if (currentData) {
          titleInput.value = currentData.title || '';
          var dur = currentData.duration || 120;
          durMinInput.value = Math.floor(dur / 60);
          durSecInput.value = dur % 60;
          switchInput.value = currentData.switchingTime || 0;
          repeatCheck.checked = !!currentData.repeat;
        }
      }

      renderFrame();
    });
  }

  // ── Init ──
  function init() {
    PortalAuth.requireAuth().then(function(profile) {
      if (!profile) return;
      PortalAuth.initNav(profile);

      isAdmin = (profile.role === 'admin' || profile.role === 'rush_chair');
      if (isAdmin) {
        controlsEl.classList.remove('hidden');
        btnStart.addEventListener('click', onStart);
        btnPause.addEventListener('click', onPause);
        btnResume.addEventListener('click', onResume);
        btnReset.addEventListener('click', onReset);
        btnStop.addEventListener('click', onStop);
      }

      startListening();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(typeof window !== 'undefined' ? window : this);
