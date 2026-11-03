/**
 * Portal Links editor (admins). Edits portalLinks/ which the home page renders
 * through js/portal-links-core.js. The whole set is saved at once.
 */
(function (global) {
  'use strict';

  var L = global.PortalLinks;
  var me = null, model = [];      // [{ key, title, links: [{ key, label, url, icon, audience, hidden }] }]

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function setStatus(msg, kind) { var el = $('pl-status'); el.textContent = msg || ''; el.className = 'status-line' + (kind ? ' ' + kind : ''); }
  function newKey(prefix) { return prefix + '_' + Math.random().toString(36).slice(2, 8); }

  function toModel(sections) {
    return L.sorted(sections).map(function (sec) {
      return { key: sec.key, title: sec.title || '', links: L.sorted(sec.links).map(function (l) { return { key: l.key, label: l.label || '', url: l.url || '', icon: l.icon || 'link', audience: l.audience || 'all', hidden: !!l.hidden }; }) };
    });
  }
  function toSections() {
    var out = {};
    model.forEach(function (sec, i) {
      var links = {};
      sec.links.forEach(function (l, j) { links[l.key] = { label: l.label.trim(), url: l.url.trim(), icon: l.icon, audience: l.audience, hidden: !!l.hidden, order: j + 1 }; });
      out[sec.key] = { title: sec.title.trim(), order: i + 1, links: links };
    });
    return out;
  }

  function move(arr, i, d) { var j = i + d; if (j < 0 || j >= arr.length) return; var t = arr[i]; arr[i] = arr[j]; arr[j] = t; }

  function render() {
    var iconOpts = Object.keys(L.ICONS).sort();
    $('pl-sections').innerHTML = model.map(function (sec, si) {
      return '<div class="req-card" data-si="' + si + '"><div class="req-actions" style="margin:0 0 0.5rem;">' +
        '<input class="field s-title" value="' + esc(sec.title) + '" placeholder="Section title" style="font-weight:600; max-width:280px;">' +
        '<button type="button" class="btn-text s-up" title="Move section up">↑</button><button type="button" class="btn-text s-down" title="Move section down">↓</button>' +
        '<button type="button" class="btn-text s-del" style="color:#c62828;">remove section</button></div>' +
        '<div class="table-scroll"><table class="admin-table"><thead><tr><th></th><th>Label</th><th>Link</th><th>Icon</th><th>Who sees it</th><th>Hide</th><th></th></tr></thead><tbody>' +
        sec.links.map(function (l, li) {
          var bad = l.url && !L.safeUrl(l.url);
          return '<tr data-li="' + li + '"><td style="white-space:nowrap;"><button type="button" class="btn-text l-up">↑</button><button type="button" class="btn-text l-down">↓</button></td>' +
            '<td><input class="field l-label" value="' + esc(l.label) + '" style="margin:0; min-width:150px;"></td>' +
            '<td><input class="field l-url" value="' + esc(l.url) + '" placeholder="https://… or a portal page like tracker" style="margin:0; min-width:220px;' + (bad ? ' border-color:#c62828;' : '') + '"></td>' +
            '<td style="white-space:nowrap;"><span class="l-icon-preview" style="display:inline-block; width:22px; height:22px; vertical-align:middle; color:#8B0000;">' + L.iconSvg(l.icon) + '</span> <select class="field l-icon" style="margin:0; max-width:120px;">' + iconOpts.map(function (k) { return '<option' + (k === l.icon ? ' selected' : '') + '>' + esc(k) + '</option>'; }).join('') + '</select></td>' +
            '<td><select class="field l-aud" style="margin:0;">' + Object.keys(L.AUDIENCES).map(function (k) { return '<option value="' + k + '"' + (k === l.audience ? ' selected' : '') + '>' + esc(L.AUDIENCES[k]) + '</option>'; }).join('') + '</select></td>' +
            '<td><input type="checkbox" class="l-hidden"' + (l.hidden ? ' checked' : '') + '></td>' +
            '<td><button type="button" class="btn-text l-del" style="color:#c62828;">remove</button></td></tr>';
        }).join('') + '</tbody></table></div>' +
        '<button type="button" class="btn ghost btn-small l-add" style="margin-top:0.5rem;">+ Add a link</button></div>';
    }).join('') || '<p class="section-empty">No sections. Add one below.</p>';

    $('pl-sections').querySelectorAll('[data-si]').forEach(function (card) {
      var si = +card.getAttribute('data-si'), sec = model[si];
      card.querySelector('.s-title').addEventListener('input', function () { sec.title = this.value; preview(); });
      card.querySelector('.s-up').addEventListener('click', function () { move(model, si, -1); render(); });
      card.querySelector('.s-down').addEventListener('click', function () { move(model, si, 1); render(); });
      card.querySelector('.s-del').addEventListener('click', function () { if (confirm('Remove the "' + sec.title + '" section and its links?')) { model.splice(si, 1); render(); } });
      card.querySelector('.l-add').addEventListener('click', function () { sec.links.push({ key: newKey('l'), label: '', url: '', icon: 'link', audience: 'all', hidden: false }); render(); });
      card.querySelectorAll('tr[data-li]').forEach(function (tr) {
        var li = +tr.getAttribute('data-li'), l = sec.links[li];
        tr.querySelector('.l-label').addEventListener('input', function () { l.label = this.value; preview(); });
        tr.querySelector('.l-url').addEventListener('input', function () { l.url = this.value; this.style.borderColor = l.url && !L.safeUrl(l.url) ? '#c62828' : ''; preview(); });
        tr.querySelector('.l-icon').addEventListener('change', function () { l.icon = this.value; tr.querySelector('.l-icon-preview').innerHTML = L.iconSvg(l.icon); preview(); });
        tr.querySelector('.l-aud').addEventListener('change', function () { l.audience = this.value; preview(); });
        tr.querySelector('.l-hidden').addEventListener('change', function () { l.hidden = this.checked; preview(); });
        tr.querySelector('.l-up').addEventListener('click', function () { move(sec.links, li, -1); render(); });
        tr.querySelector('.l-down').addEventListener('click', function () { move(sec.links, li, 1); render(); });
        tr.querySelector('.l-del').addEventListener('click', function () { sec.links.splice(li, 1); render(); });
      });
    });
    preview();
  }

  function preview() {
    var as = $('pl-as').value;
    var fake = as === 'admin' ? { role: 'admin' } : (as === 'pnm' ? { role: 'pnm', status: 'pnm' } : (as === 'officer' ? { role: 'brother', status: 'active', perms: { finance: true } } : { role: 'brother', status: 'active' }));
    L.render($('pl-preview'), toSections(), fake);
    $('pl-preview').querySelectorAll('a').forEach(function (a) { a.addEventListener('click', function (e) { e.preventDefault(); }); });
  }

  function save() {
    var problems = [];
    model.forEach(function (sec) {
      if (!sec.title.trim()) problems.push('A section has no title.');
      sec.links.forEach(function (l) {
        if (!l.label.trim()) problems.push('A link in "' + sec.title + '" has no label.');
        if (!L.safeUrl(l.url)) problems.push('"' + (l.label || 'A link') + '" needs a link that starts with https:// (or a portal page name like tracker).');
      });
    });
    var cal = $('pl-calendar').value.trim();
    if (cal && !/^https:\/\/calendar\.google\.com\//.test(cal)) problems.push('The calendar link must start with https://calendar.google.com/');
    if (problems.length) return setStatus(problems[0], 'error');
    var btn = $('btn-save'); btn.disabled = true; setStatus('Saving…');
    firebase.database().ref('portalLinks').set({ sections: toSections(), calendarUrl: cal || null, updatedBy: me.uid, updatedByName: me.name || '', updatedAt: new Date().toISOString() })
      .then(function () { setStatus('Saved. The home page shows the new links now.', 'success'); $('pl-default-note').classList.add('hidden'); })
      .catch(function (err) { setStatus(err.message || 'Could not save.', 'error'); })
      .then(function () { btn.disabled = false; });
  }

  function init() {
    PortalAuth.requireAdmin().then(function (profile) {
      if (!profile) return;
      me = profile; PortalAuth.initNav(profile);
      return L.load();
    }).then(function (cfg) {
      if (!cfg) return;
      model = toModel(cfg.sections);
      $('pl-calendar').value = cfg.calendarUrl || '';
      var note = $('pl-default-note');
      note.textContent = cfg.isDefault ? 'Showing the built-in set. It becomes yours to edit the first time you save.' : '';
      note.classList.toggle('hidden', !cfg.isDefault);
      $('btn-add-section').addEventListener('click', function () { model.push({ key: newKey('s'), title: 'New section', links: [] }); render(); });
      $('btn-save').addEventListener('click', save);
      $('btn-reset').addEventListener('click', function () { if (confirm('Replace what is on screen with the built-in links? Nothing is saved until you press Save.')) { model = toModel(L.DEFAULT); render(); } });
      $('pl-as').addEventListener('change', preview);
      render();
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(typeof window !== 'undefined' ? window : this);
