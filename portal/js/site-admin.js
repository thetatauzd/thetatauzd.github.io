/**
 * Website settings (admin only). Everything on this page is saved under
 * "site/rush" in the Realtime Database, which the public rush page reads
 * (no sign-in needed). Pictures are stored as small JPEG data URLs in the
 * database because the project stays on the free Spark plan (no Cloud Storage).
 *
 * If nothing has ever been saved here, the public page keeps using
 * js/rush-config.js and the pictures checked into Images/rush/.
 */
(function (global) {
  'use strict';

  var db = firebase.database();
  var REF = 'site/rush';
  var MAX_IMAGE_CHARS = 190000;   // about 140 KB of JPEG; the database rule allows 200000
  var MAX_SIDE = 1000;            // posters are shown at most ~600px wide, 1000px is plenty
  var MAX_EVENTS = 10;            // the database rule accepts cards 0 to 9
  // Pictures are only ever shown if they are real JPEG data URLs (the rule checks the same).
  var JPEG_RE = /^data:image\/jpeg;base64,[A-Za-z0-9+\/]+=*$/;

  // The Fall 2026 cards that ship with the site, so the first save can start
  // from them instead of from nothing.
  var STATIC_CARDS = {
    hero: { image: '../Images/rush/f26/rush-hero.jpg', alt: 'Theta Tau Fall 2026 Rush' },
    events: [
      { title: 'Full Rush Schedule', detail: 'Every event, date and dress code in one place.', image: '../Images/rush/f26/rush-schedule.jpg', inviteOnly: false },
      { title: 'Info Nights #1 & #2', detail: 'Sept 1 & 2 · Amoco Hall · 7:30 PM', image: '../Images/rush/f26/info-night.jpg', inviteOnly: false },
      { title: 'PD Workshop', detail: 'Sept 8 · 300 Main · 7:30 PM · Business casual', image: '../Images/rush/f26/pd-workshop.jpg', inviteOnly: false },
      { title: 'Speed Dating', detail: 'Sept 10 · Swearingen Lobby · 7:00 PM', image: '../Images/rush/f26/speed-dating.jpg', inviteOnly: false },
      { title: 'Passion Pitch & PD Dinner', detail: 'Sept 14 & 15', image: '../Images/rush/f26/passion-pitch-pd-dinner.jpg', inviteOnly: true }
    ]
  };

  var state = blank();
  var dirty = false;

  function blank() {
    var cfg = global.RUSH_CONFIG || {};
    return {
      isOpen: !!cfg.isOpen,
      nextSemester: cfg.nextSemester || '',
      rushTitle: cfg.rushTitle || '',
      subtitle: 'Come find out what Theta Tau is about. Every event is open unless it says invite only.',
      ctaLine: cfg.ctaLine || '',
      rushLinkUrl: cfg.rushLinkUrl || '',
      interestFormUrl: cfg.interestFormUrl || '',
      heroImage: '',
      heroAlt: '',
      events: []
    };
  }

  function $(id) { return document.getElementById(id); }

  /** Escape text for HTML, quotes included, so it is safe inside attribute values too. */
  function esc(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /** Put a saved picture into a box, only if it is a real JPEG data URL. */
  function showPicture(box, src) {
    if (!box || !src || !JPEG_RE.test(src)) return false;
    var img = document.createElement('img');
    img.alt = '';
    img.src = src;
    box.insertBefore(img, box.firstChild);
    return true;
  }

  function say(msg, kind) {
    var el = $('site-status');
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'site-status' + (kind ? ' ' + kind : '');
  }

  function markDirty() {
    dirty = true;
    var b = $('btn-save');
    if (b) b.textContent = 'Save changes';
  }

  // ------------------------------------------------------------ pictures

  /** Shrink any picture to a JPEG data URL small enough for the database. */
  function compress(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        var scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
        var quality = 0.82;
        var out = '';
        for (var attempt = 0; attempt < 8; attempt++) {
          var c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(img.naturalWidth * scale));
          c.height = Math.max(1, Math.round(img.naturalHeight * scale));
          var ctx = c.getContext('2d');
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, c.width, c.height);
          ctx.drawImage(img, 0, 0, c.width, c.height);
          out = c.toDataURL('image/jpeg', quality);
          if (out.length <= MAX_IMAGE_CHARS) break;
          if (quality > 0.6) quality -= 0.1; else scale *= 0.85;
        }
        if (out.length > MAX_IMAGE_CHARS) reject(new Error('That picture is too detailed to shrink enough. Try a smaller one.'));
        else resolve(out);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('That file is not a picture the browser can read.')); };
      img.src = url;
    });
  }

  function fetchAsFile(path) {
    return fetch(path).then(function (r) {
      if (!r.ok) throw new Error('Could not load ' + path);
      return r.blob();
    });
  }

  // ------------------------------------------------------------ render

  function render() {
    $('f-open').checked = state.isOpen === true;
    $('f-closed').checked = state.isOpen !== true;
    $('f-title').value = state.rushTitle || '';
    $('f-next').value = state.nextSemester || '';
    $('f-subtitle').value = state.subtitle || '';
    $('f-cta').value = state.ctaLine || '';
    $('f-groupme').value = state.rushLinkUrl || '';
    $('f-interest').value = state.interestFormUrl || '';
    $('f-hero-alt').value = state.heroAlt || '';

    var hero = $('hero-preview');
    hero.textContent = '';
    if (showPicture(hero, state.heroImage)) {
      $('btn-hero-remove').classList.remove('hidden');
    } else {
      hero.innerHTML = '<span class="site-noimg">No poster saved. The page shows the Fall 2026 poster from the site files.</span>';
      $('btn-hero-remove').classList.add('hidden');
    }

    var list = $('event-list');
    if (!state.events.length) {
      list.innerHTML = '<p class="site-noimg">No event cards saved. The page shows the Fall 2026 cards from the site files. Press "Start from the Fall 2026 cards" to load them here, or add your own.</p>';
    } else {
      list.innerHTML = state.events.map(function (ev, i) {
        return '' +
          '<div class="site-event" data-i="' + i + '">' +
            '<div class="site-event-img">' +
              (ev.image && JPEG_RE.test(ev.image) ? '' : '<span class="site-noimg">No picture</span>') +
              '<label class="site-file"><input type="file" accept="image/*" data-act="image" data-i="' + i + '"><span>Choose picture</span></label>' +
            '</div>' +
            '<div class="site-event-fields">' +
              '<label>Title<input type="text" maxlength="80" value="' + esc(ev.title) + '" data-field="title" data-i="' + i + '" placeholder="Info Night"></label>' +
              '<label>Date, place, time, dress code<input type="text" maxlength="160" value="' + esc(ev.detail) + '" data-field="detail" data-i="' + i + '" placeholder="Sept 1 · Amoco Hall · 7:30 PM"></label>' +
              '<label class="site-check"><input type="checkbox" data-field="inviteOnly" data-i="' + i + '"' + (ev.inviteOnly ? ' checked' : '') + '> Invite only</label>' +
              '<div class="site-event-actions">' +
                '<button type="button" data-act="up" data-i="' + i + '"' + (i === 0 ? ' disabled' : '') + '>Move up</button>' +
                '<button type="button" data-act="down" data-i="' + i + '"' + (i === state.events.length - 1 ? ' disabled' : '') + '>Move down</button>' +
                '<button type="button" class="danger" data-act="remove" data-i="' + i + '">Remove</button>' +
              '</div>' +
            '</div>' +
          '</div>';
      }).join('');
      // Pictures go in as properties after the JPEG check, never as HTML.
      state.events.forEach(function (ev, i) {
        var box = list.querySelector('.site-event[data-i="' + i + '"] .site-event-img');
        showPicture(box, ev.image);
      });
    }
    $('add-limit').textContent = state.events.length >= MAX_EVENTS ? 'The page holds at most ' + MAX_EVENTS + ' cards.' : '';
    $('btn-add-event').disabled = state.events.length >= MAX_EVENTS;
    $('event-count').textContent = state.events.length ? '(' + state.events.length + ')' : '';
  }

  function readForm() {
    state.isOpen = $('f-open').checked;
    state.rushTitle = $('f-title').value.trim();
    state.nextSemester = $('f-next').value.trim();
    state.subtitle = $('f-subtitle').value.trim();
    state.ctaLine = $('f-cta').value.trim();
    state.rushLinkUrl = $('f-groupme').value.trim();
    state.interestFormUrl = $('f-interest').value.trim();
    state.heroAlt = $('f-hero-alt').value.trim();
  }

  // ------------------------------------------------------------ events

  function onListInput(e) {
    var t = e.target;
    var i = Number(t.getAttribute('data-i'));
    var field = t.getAttribute('data-field');
    if (!field || isNaN(i) || !state.events[i]) return;
    state.events[i][field] = t.type === 'checkbox' ? t.checked : t.value;
    markDirty();
  }

  function onListClick(e) {
    var t = e.target.closest('button[data-act]');
    if (!t) return;
    var i = Number(t.getAttribute('data-i'));
    var act = t.getAttribute('data-act');
    readForm();
    if (act === 'remove') {
      state.events.splice(i, 1);
    } else if (act === 'up' && i > 0) {
      var a = state.events[i - 1]; state.events[i - 1] = state.events[i]; state.events[i] = a;
    } else if (act === 'down' && i < state.events.length - 1) {
      var b = state.events[i + 1]; state.events[i + 1] = state.events[i]; state.events[i] = b;
    }
    markDirty();
    render();
  }

  function onListChange(e) {
    var t = e.target;
    if (t.type !== 'file' || t.getAttribute('data-act') !== 'image') return;
    var i = Number(t.getAttribute('data-i'));
    var file = t.files && t.files[0];
    if (!file || !state.events[i]) return;
    say('Shrinking picture…');
    compress(file).then(function (dataUrl) {
      readForm();
      state.events[i].image = dataUrl;
      markDirty();
      render();
      say('Picture added. Press Save changes to publish it.', 'ok');
    }).catch(function (err) { say(err.message, 'error'); });
  }

  function addEvent() {
    readForm();
    if (state.events.length >= MAX_EVENTS) { say('The page holds at most ' + MAX_EVENTS + ' cards.', 'error'); return; }
    state.events.push({ title: '', detail: '', inviteOnly: false, image: '' });
    markDirty();
    render();
    var inputs = document.querySelectorAll('#event-list input[data-field="title"]');
    if (inputs.length) inputs[inputs.length - 1].focus();
  }

  function loadStaticCards() {
    readForm();
    if (state.events.length && !confirm('Replace the ' + state.events.length + ' cards here with the Fall 2026 cards from the site files?')) return;
    say('Loading the Fall 2026 pictures…');
    var jobs = STATIC_CARDS.events.map(function (ev) {
      return fetchAsFile(ev.image).then(compress).then(function (dataUrl) {
        return { title: ev.title, detail: ev.detail, inviteOnly: ev.inviteOnly, image: dataUrl };
      });
    });
    var heroJob = fetchAsFile(STATIC_CARDS.hero.image).then(compress);
    Promise.all([heroJob, Promise.all(jobs)]).then(function (res) {
      if (!state.heroImage) { state.heroImage = res[0]; state.heroAlt = STATIC_CARDS.hero.alt; }
      state.events = res[1];
      markDirty();
      render();
      say('Loaded. Edit anything you like, then press Save changes.', 'ok');
    }).catch(function (err) { say(err.message, 'error'); });
  }

  // ------------------------------------------------------------ save / load

  function validate() {
    if (state.isOpen && !state.rushTitle) return 'Give the open rush a title (for example "Spring 2027 Rush").';
    if (!state.isOpen && !state.nextSemester) return 'Say which semester rush comes back (for example "Spring 2027").';
    var urls = [state.rushLinkUrl, state.interestFormUrl];
    for (var k = 0; k < urls.length; k++) {
      if (urls[k] && !/^https:\/\//.test(urls[k])) return 'Links must start with https://';
    }
    if (state.events.length > MAX_EVENTS) return 'The page holds at most ' + MAX_EVENTS + ' cards. Remove ' + (state.events.length - MAX_EVENTS) + '.';
    for (var i = 0; i < state.events.length; i++) {
      if (!state.events[i].title) return 'Event ' + (i + 1) + ' needs a title.';
    }
    if (state.heroImage && !JPEG_RE.test(state.heroImage)) return 'The poster picture is not a JPEG. Choose it again.';
    for (var j = 0; j < state.events.length; j++) {
      if (state.events[j].image && !JPEG_RE.test(state.events[j].image)) return 'The picture on event ' + (j + 1) + ' is not a JPEG. Choose it again.';
    }
    return '';
  }

  function save() {
    readForm();
    var problem = validate();
    if (problem) { say(problem, 'error'); return; }
    var btn = $('btn-save');
    btn.disabled = true;
    say('Saving…');
    // No name or email is saved: site/rush can be read by anyone on the internet.
    var payload = {
      isOpen: state.isOpen,
      nextSemester: state.nextSemester,
      rushTitle: state.rushTitle,
      subtitle: state.subtitle,
      ctaLine: state.ctaLine,
      rushLinkUrl: state.rushLinkUrl,
      interestFormUrl: state.interestFormUrl,
      heroImage: state.heroImage || '',
      heroAlt: state.heroAlt || '',
      events: state.events.map(function (ev) {
        return { title: ev.title || '', detail: ev.detail || '', inviteOnly: !!ev.inviteOnly, image: ev.image || '' };
      }),
      updatedAt: new Date().toISOString()
    };
    db.ref(REF).set(payload).then(function () {
      dirty = false;
      btn.textContent = 'Saved';
      say('Saved. The public rush page shows this now (phones may need a refresh).', 'ok');
      $('link-preview').href = '/rush?cb=' + Date.now();
    }).catch(function (err) {
      say(err.message || 'Save failed.', 'error');
    }).then(function () { btn.disabled = false; });
  }

  function load() {
    return db.ref(REF).once('value').then(function (snap) {
      var v = snap.val();
      if (!v) { state = blank(); $('site-source').textContent = 'Nothing saved yet: the public page is using the files in the repository.'; return; }
      state = {
        isOpen: v.isOpen === true,
        nextSemester: v.nextSemester || '',
        rushTitle: v.rushTitle || '',
        subtitle: v.subtitle || '',
        ctaLine: v.ctaLine || '',
        rushLinkUrl: v.rushLinkUrl || '',
        interestFormUrl: v.interestFormUrl || '',
        heroImage: v.heroImage || '',
        heroAlt: v.heroAlt || '',
        events: toList(v.events)
      };
      var when = v.updatedAt ? new Date(v.updatedAt).toLocaleString() : '';
      $('site-source').textContent = 'Last saved ' + when + '.';
    });
  }

  function toList(events) {
    if (!events) return [];
    if (Array.isArray(events)) return events.filter(Boolean);
    return Object.keys(events).sort(function (a, b) { return Number(a) - Number(b); }).map(function (k) { return events[k]; });
  }

  function clearSaved() {
    if (!confirm('Remove everything saved here? The public page goes back to the files in the repository (js/rush-config.js and Images/rush/).')) return;
    db.ref(REF).remove().then(function () {
      state = blank(); dirty = false;
      render();
      say('Cleared. The public page is using the repository files again.', 'ok');
      $('site-source').textContent = 'Nothing saved yet: the public page is using the files in the repository.';
    }).catch(function (err) { say(err.message, 'error'); });
  }

  function init() {
    PortalAuth.requireAdmin().then(function (profile) {
      if (!profile) return;
      PortalAuth.initNav(profile);

      ['f-open', 'f-closed', 'f-title', 'f-next', 'f-subtitle', 'f-cta', 'f-groupme', 'f-interest', 'f-hero-alt'].forEach(function (id) {
        $(id).addEventListener('input', markDirty);
        $(id).addEventListener('change', markDirty);
      });
      $('f-hero').addEventListener('change', function () {
        var file = this.files && this.files[0];
        if (!file) return;
        say('Shrinking picture…');
        compress(file).then(function (dataUrl) {
          readForm();
          state.heroImage = dataUrl;
          markDirty(); render();
          say('Poster added. Press Save changes to publish it.', 'ok');
        }).catch(function (err) { say(err.message, 'error'); });
      });
      $('btn-hero-remove').addEventListener('click', function () { readForm(); state.heroImage = ''; markDirty(); render(); });
      $('event-list').addEventListener('input', onListInput);
      $('event-list').addEventListener('click', onListClick);
      $('event-list').addEventListener('change', onListChange);
      $('btn-add-event').addEventListener('click', addEvent);
      $('btn-load-static').addEventListener('click', loadStaticCards);
      $('btn-save').addEventListener('click', save);
      $('btn-clear').addEventListener('click', clearSaved);
      window.addEventListener('beforeunload', function (e) { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

      load().then(render).catch(function (err) { say(err.message || 'Could not load the saved settings.', 'error'); render(); });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(window);
