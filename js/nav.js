/*
 * nav.js: header state and mobile menu for every public page.
 * - #header gets .scrolled once the page scrolls past 8px (design.css turns it solid).
 * - The burger opens .header-menu as a modal dialog: aria-expanded, the page behind is made inert,
 *   focus moves in and stays in, Esc or the injected close button closes it and returns focus to
 *   the burger, links close it, and it closes itself when the screen widens to the desktop nav.
 * Plain ES5 in an IIFE; the only newer feature is the { passive: true } listener option.
 */
(function () {
  function ready(fn) { if (document.readyState !== 'loading') fn(); else document.addEventListener('DOMContentLoaded', fn); }
  ready(function () {
    var header = document.getElementById('header'), ticking = false;
    function update() { ticking = false; if (header) header.classList.toggle('scrolled', (window.pageYOffset || 0) > 8); }
    window.addEventListener('scroll', function () { if (!ticking) { ticking = true; window.requestAnimationFrame(update); } }, { passive: true });
    update();

    var btn = document.querySelector('.header-burger-btn'), menu = document.querySelector('.header-menu');
    if (!btn || !menu) return;
    menu.id = menu.id || 'site-menu';
    btn.setAttribute('aria-controls', menu.id); btn.setAttribute('aria-expanded', 'false'); btn.removeAttribute('aria-haspopup');
    btn.setAttribute('aria-label', 'Menu');
    menu.setAttribute('role', 'dialog'); menu.setAttribute('aria-modal', 'true'); menu.setAttribute('aria-label', 'Site menu');
    var closeBtn = document.createElement('button');
    closeBtn.type = 'button'; closeBtn.className = 'menu-close-btn'; closeBtn.setAttribute('aria-label', 'Close menu'); closeBtn.innerHTML = '&#x2715;';
    menu.insertBefore(closeBtn, menu.firstChild);

    // Everything behind the overlay: made inert while the menu is open (the menu itself is not inside these).
    var behind = [document.querySelector('.header-announcement-bar-wrapper'), document.getElementById('page'), document.querySelector('.footer')];
    function setInert(on) {
      for (var j = 0; j < behind.length; j++) {
        if (!behind[j] || behind[j].contains(menu)) continue;
        if (on) behind[j].setAttribute('inert', ''); else behind[j].removeAttribute('inert');
      }
    }
    function lockScroll(on) {
      document.body.style.overflow = on ? 'hidden' : '';
      document.documentElement.style.overflow = on ? 'hidden' : '';
    }
    function isOpen() { return menu.classList.contains('menu-open'); }
    function open() {
      menu.classList.add('menu-open'); document.body.classList.add('menu-is-open'); lockScroll(true);
      btn.setAttribute('aria-expanded', 'true'); setInert(true);
      var a = menu.querySelector('a[href]'); if (a) a.focus();
    }
    function close(restore) {
      if (!isOpen()) return;
      menu.classList.remove('menu-open'); document.body.classList.remove('menu-is-open'); lockScroll(false);
      btn.setAttribute('aria-expanded', 'false'); setInert(false);   // un-inert first: an inert button cannot take focus
      if (restore) btn.focus();
    }
    btn.addEventListener('click', function () { if (isOpen()) close(true); else open(); });
    closeBtn.addEventListener('click', function () { close(true); });
    var links = menu.querySelectorAll('a'), i;
    for (i = 0; i < links.length; i++) links[i].addEventListener('click', function () { close(false); });

    // Rotating or resizing to the desktop layout hides the burger: close the menu so the page is usable.
    var wide = window.matchMedia ? window.matchMedia('(min-width: 1024px)') : null;
    function onWide() { if (wide && wide.matches) close(false); }
    if (wide) { if (wide.addEventListener) wide.addEventListener('change', onWide); else if (wide.addListener) wide.addListener(onWide); }

    document.addEventListener('keydown', function (e) {
      if (!isOpen()) return;
      if (e.key === 'Escape' || e.key === 'Esc') { close(true); return; }
      if (e.key !== 'Tab') return;
      var f = menu.querySelectorAll('a[href], button'), first = f[0], last = f[f.length - 1], cur = document.activeElement;
      if (!menu.contains(cur)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
      else if (e.shiftKey && cur === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && cur === last) { e.preventDefault(); first.focus(); }
    });
  });
})();
