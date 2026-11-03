/**
 * PortalPhotos — picture uploads without Firebase Storage (the chapter stays on
 * the free plan). A photo is shrunk in the browser to a JPEG of roughly 150–200 KB
 * and saved as text under
 *
 *   proof/{kind}/{term}/{uid}/{photoId} = { data: 'data:image/jpeg;base64,…', w, h, bytes, createdAt }
 *
 * kind is 'excuse' (read by the brother + Standards) or 'service' (the brother +
 * the Service Chair). Requests only store the photo ids, so lists stay small and a
 * picture is downloaded only when someone opens it. Old terms are cleared from
 * Semester Setup.
 */
(function (global) {
  'use strict';

  var MAX_SIDE = 1600;          // longest edge in pixels
  var MAX_CHARS = 280000;       // ≈ 210 KB of JPEG; the database rule allows 400000
  var db = function () { return firebase.database(); };

  function readImage(file) {
    return new Promise(function (resolve, reject) {
      if (!file || !/^image\//.test(file.type || '')) return reject(new Error('That file is not a picture. Take a photo or a screenshot instead.'));
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('This browser could not open that picture. Try a JPG, PNG or a screenshot.')); };
      img.src = url;
    });
  }

  /** File → { data, w, h, bytes } small enough to store. */
  function compress(file) {
    return readImage(file).then(function (img) {
      var side = MAX_SIDE, quality = 0.72, out = null;
      for (var attempt = 0; attempt < 7; attempt++) {
        var scale = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight));
        var w = Math.max(1, Math.round(img.naturalWidth * scale)), h = Math.max(1, Math.round(img.naturalHeight * scale));
        var canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        var ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);      // screenshots with transparency
        ctx.drawImage(img, 0, 0, w, h);
        var data = canvas.toDataURL('image/jpeg', quality);
        out = { data: data, w: w, h: h, bytes: Math.round(data.length * 0.75) };
        if (data.length <= MAX_CHARS) return out;
        if (quality > 0.5) quality -= 0.12; else side = Math.round(side * 0.8);
      }
      return out;
    });
  }

  /**
   * Turn a <input type="file"> + preview box into a small photo picker.
   * Returns { photos(): [{data,w,h,bytes}], clear(), busy(): bool }.
   */
  function picker(input, preview, opts) {
    opts = opts || {};
    var max = opts.max || 3, list = [], working = 0;
    function render() {
      preview.innerHTML = list.map(function (p, i) {
        return '<span class="photo-chip"><img src="' + p.data + '" alt="Photo ' + (i + 1) + '"><button type="button" class="photo-chip-x" data-i="' + i + '" aria-label="Remove photo">×</button></span>';
      }).join('') + (working ? '<span class="photo-chip photo-chip--busy">Shrinking…</span>' : '');
      preview.querySelectorAll('.photo-chip-x').forEach(function (b) {
        b.addEventListener('click', function () { list.splice(+this.getAttribute('data-i'), 1); render(); });
      });
      if (opts.onChange) opts.onChange(list);
    }
    input.addEventListener('change', function () {
      var files = Array.prototype.slice.call(input.files || []).slice(0, Math.max(0, max - list.length));
      input.value = '';
      if (!files.length) { if (opts.onError) opts.onError('Up to ' + max + ' photos.'); return; }
      working += files.length; render();
      files.reduce(function (chain, f) {
        return chain.then(function () { return compress(f); }).then(function (p) { list.push(p); })
          .catch(function (err) { if (opts.onError) opts.onError(err.message); })
          .then(function () { working--; render(); });
      }, Promise.resolve());
    });
    return { photos: function () { return list.slice(); }, clear: function () { list = []; render(); }, busy: function () { return working > 0; } };
  }

  /** Save photos; resolves with their ids (to store on the request). */
  function save(kind, term, uid, photos) {
    var ids = [], updates = {};
    (photos || []).forEach(function (p) {
      var id = db().ref().push().key; ids.push(id);
      updates['proof/' + kind + '/' + term + '/' + uid + '/' + id] = { data: p.data, w: p.w, h: p.h, bytes: p.bytes, createdAt: new Date().toISOString() };
    });
    if (!ids.length) return Promise.resolve(ids);
    return db().ref().update(updates).then(function () { return ids; });
  }

  function load(kind, term, uid, id) {
    return db().ref('proof/' + kind + '/' + term + '/' + uid + '/' + id).once('value').then(function (s) { return s.val(); });
  }

  /** Buttons that fetch a photo only when pressed. Call wire(container) after inserting. */
  function buttonsHtml(kind, term, uid, ids) {
    ids = ids || [];
    if (!ids.length) return '';
    return '<div class="photo-row">' + ids.map(function (id, i) {
      return '<button type="button" class="photo-btn" data-kind="' + kind + '" data-term="' + term + '" data-uid="' + uid + '" data-id="' + id + '">Photo ' + (i + 1) + '</button>';
    }).join('') + '</div>';
  }
  function wire(container) {
    container.querySelectorAll('.photo-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        var btn = this;
        if (btn._img) return view(btn._img);
        btn.disabled = true; btn.textContent = 'Loading…';
        load(btn.getAttribute('data-kind'), btn.getAttribute('data-term'), btn.getAttribute('data-uid'), btn.getAttribute('data-id')).then(function (p) {
          btn.disabled = false;
          if (!p || !p.data) { btn.textContent = 'Photo removed'; return; }
          btn._img = p.data;
          btn.classList.add('photo-btn--loaded');
          btn.innerHTML = '<img src="' + p.data + '" alt="Attached photo">';
        }).catch(function (err) { btn.disabled = false; btn.textContent = 'Could not load'; btn.title = err.message || ''; });
      });
    });
  }
  /** Load every photo button inside a container (used when a reviewer opens one request). */
  function loadAll(container) { container.querySelectorAll('.photo-btn:not(.photo-btn--loaded)').forEach(function (b) { b.click(); }); }

  function view(dataUrl) {
    var o = document.createElement('div');
    o.className = 'photo-overlay';
    o.innerHTML = '<img src="' + dataUrl + '" alt="Attached photo">';
    o.addEventListener('click', function () { o.remove(); });
    document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { o.remove(); document.removeEventListener('keydown', esc); } });
    document.body.appendChild(o);
  }

  global.PortalPhotos = { compress: compress, picker: picker, save: save, load: load, buttonsHtml: buttonsHtml, wire: wire, loadAll: loadAll, view: view };
})(typeof window !== 'undefined' ? window : this);
