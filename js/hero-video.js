/*
 * hero-video.js: plays the muted campus video behind the home hero.
 * - Starts only after the page has loaded, so the hero photo (the LCP image) is never delayed.
 * - Never starts for visitors who ask for reduced motion or have data saver on: they keep the photo.
 * - Phones get the 720px file, larger screens the 1080px one.
 * - The photo stays underneath; the video fades in once frames are actually playing.
 * - A pause/play button (WCAG 2.2.2) appears once the video runs. A pause is remembered for the visit.
 * Plain ES5 in an IIFE.
 */
(function () {
  var video = document.querySelector('.hero-video');
  if (!video || typeof video.play !== 'function') return;
  var btn = document.querySelector('.hero-video-toggle');
  var mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if ((mq && mq.matches) || (conn && conn.saveData)) return;

  var KEY = 'tt-hero-video-paused';
  function storedPause() { try { return window.sessionStorage.getItem(KEY) === '1'; } catch (e) { return false; } }
  function storePause(on) { try { window.sessionStorage.setItem(KEY, on ? '1' : '0'); } catch (e) {} }

  function setButton(playing) {
    if (!btn) return;
    btn.hidden = false;
    btn.setAttribute('aria-label', playing ? 'Pause the background video' : 'Play the background video');
    btn.firstChild.innerHTML = playing ? '&#10074;&#10074;' : '&#9654;';
  }
  function play() {
    var p = video.play();
    if (p && typeof p.then === 'function') p.then(function () { setButton(true); }, function () { setButton(false); });
  }

  function start() {
    var small = window.matchMedia && window.matchMedia('(max-width: 599.98px)').matches;
    video.src = small ? video.getAttribute('data-src-small') : video.getAttribute('data-src-large');
    video.muted = true;               // muted and playsinline are required for autoplay on phones
    video.preload = 'auto';
    video.addEventListener('playing', function () { video.classList.add('is-playing'); setButton(true); });
    video.addEventListener('pause', function () { setButton(false); });
    if (storedPause()) { setButton(false); return; }
    play();
  }

  if (btn) {
    btn.addEventListener('click', function () {
      if (video.paused) { storePause(false); play(); }
      else { storePause(true); video.pause(); }
    });
  }
  // Someone switching reduced motion on mid-visit gets the photo back.
  if (mq) {
    var onChange = function () { if (mq.matches) { video.pause(); video.classList.remove('is-playing'); } };
    if (mq.addEventListener) mq.addEventListener('change', onChange); else if (mq.addListener) mq.addListener(onChange);
  }

  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start);
})();
