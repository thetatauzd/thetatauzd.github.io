/**
 * Family Tree page — the chapter's big/little lineage, drawn from
 * familyTree/members (facts) by FamilyTreeCore (layout). Every member can look;
 * holders of the `tree` capability (exec by default) can edit. Photos are small
 * JPEG data URLs under familyTree/photos/{memberId} (no Firebase Storage).
 *
 * Phone first: one finger pans, two fingers pinch, a tap opens the person card
 * as a bottom sheet. Export draws the same tree on a canvas and hands over a PNG.
 */
(function (global) {
  'use strict';

  var T = global.FamilyTreeCore, C = global.OpsCore, esc = C.esc;
  var db = global.PortalOps.db;
  var me = null, canEdit = false, isAdmin = false;
  var members = {}, photos = {}, meta = {}, photosLoaded = false;
  var classes = T.DEFAULT_CLASSES;
  var fullIdx = null, idx = null, lay = null;           // fullIdx = everyone; idx/lay = what is drawn (a family or all)
  var familyFilter = '', selectedId = null, editing = null;
  var view = { tx: 0, ty: 0, s: 1 };
  var G = { unit: 168, nodeW: 150, nodeH: 46, rowH: 112, photoR: 25, padX: 60, padY: 30, labelW: 96 };
  var COLORS = { gold: { fill: '#E6B800', text: '#3a2a00', sub: '#5a4400' }, maroon: { fill: '#8B0000', text: '#fff', sub: '#f3d9d9' } };

  function $(id) { return document.getElementById(id); }
  function setStatus(id, text, cls) { var el = $(id); if (!el) return; el.textContent = text || ''; el.className = 'status-line ' + (cls || ''); }
  function initials(name) { return (name || '').split(/\s+/).map(function (w) { return w.charAt(0); }).join('').slice(0, 2).toUpperCase(); }
  function colorOf(id) { var root = T.rootOf(fullIdx, id); return COLORS[(fullIdx.byId[root] && fullIdx.byId[root].color) || 'gold'] || COLORS.gold; }
  function subLine(m) { return [m.major, m.roll != null ? '#' + m.roll : ''].filter(Boolean).join(' · '); }

  // ── Data ──

  function load() {
    db.ref('familyTree/meta').on('value', function (s) {
      meta = s.val() || {};
      classes = Array.isArray(meta.classes) && meta.classes.length ? meta.classes : T.DEFAULT_CLASSES;
    });
    db.ref('familyTree/members').on('value', function (s) {
      members = s.val() || {};
      rebuild(true);
      if (!photosLoaded) loadPhotos();
    }, function (err) { $('ft-summary').textContent = 'Could not load the tree: ' + err.message; });
  }
  function loadPhotos() {
    photosLoaded = true;
    db.ref('familyTree/photos').once('value').then(function (s) { photos = s.val() || {}; draw(); if (selectedId) showCard(selectedId); })
      .catch(function () { photosLoaded = false; });
  }

  // ── Build & draw ──

  function rebuild(keepView) {
    fullIdx = T.index(members, classes);
    var ids = fullIdx.list.map(function (m) { return m.id; });
    if (familyFilter && fullIdx.byId[familyFilter]) ids = [familyFilter].concat(T.descendants(fullIdx, familyFilter));
    var subset = {};
    ids.forEach(function (id) { subset[id] = members[id]; });
    idx = T.index(subset, classes);
    if (familyFilter && idx.byId[familyFilter]) idx.byId[familyFilter].bigId = '';   // the family root is drawn as a root
    idx.roots = idx.list.filter(function (m) { return !m.bigId; }).map(function (m) { return m.id; });
    lay = T.layout(idx, classes);
    fillFamilySelect();
    summary();
    var empty = !fullIdx.list.length;
    $('ft-empty').classList.toggle('hidden', !empty);
    $('ft-stage').classList.toggle('hidden', empty);
    $('ft-import-row').classList.toggle('hidden', !(empty && isAdmin));
    draw();
    if (!keepView || !view.fitted) fit();
  }

  function summary() {
    var st = T.stats(fullIdx, classes);
    var txt = st.members + ' brothers · ' + st.families + ' families · ' + st.classes + ' pledge classes';
    if (st.photos) txt += ' · ' + st.photos + ' photos';
    if (familyFilter && fullIdx.byId[familyFilter]) {
      var f = T.families(fullIdx).filter(function (x) { return x.rootId === familyFilter; })[0];
      if (f) txt = f.name + ': ' + f.size + ' brothers · ' + txt;
    }
    if (canEdit) txt += ' · you can edit';
    $('ft-summary').textContent = txt;
  }

  function fillFamilySelect() {
    var sel = $('ft-family');
    var fams = T.families(fullIdx).slice().sort(function (a, b) { return b.size - a.size || a.name.localeCompare(b.name); });
    var cur = sel.value;
    sel.innerHTML = '<option value="">Whole chapter</option>' + fams.map(function (f) {
      return '<option value="' + esc(f.rootId) + '">' + esc(f.name) + ' (' + f.size + ')</option>';
    }).join('');
    sel.value = familyFilter || cur || '';
    if (sel.value !== familyFilter) sel.value = '';
  }

  /** Pixel position of a node's pill (top-left) from layout units. */
  function pt(id) {
    var p = lay.pos[id];
    return { x: G.padX + G.labelW + p.x * G.unit - G.nodeW / 2, y: G.padY + p.row * G.rowH + (G.rowH - G.nodeH) - 8, row: p.row };
  }
  function contentSize() {
    return { w: G.padX * 2 + G.labelW + (lay.width + 0.5) * G.unit, h: G.padY * 2 + lay.rows * G.rowH };
  }

  function draw() {
    var svg = $('ft-svg');
    if (!lay) { svg.innerHTML = ''; return; }
    var size = contentSize();
    var parts = [];
    // Row bands and class labels (labels redrawn in the pinned column too)
    for (var r = 0; r < lay.rows; r++) {
      parts.push('<rect class="ft-band ' + (r % 2 ? 'odd' : 'even') + '" x="0" y="' + (G.padY + r * G.rowH) + '" width="' + size.w + '" height="' + G.rowH + '"/>');
    }
    // Family names above each root
    lay.families.forEach(function (f) {
      var p = pt(f.rootId);
      parts.push('<text class="ft-famname" x="' + (p.x + G.nodeW / 2) + '" y="' + (p.y - (idx.byId[f.rootId].hasPhoto ? G.photoR * 2 + 14 : 14)) + '" text-anchor="middle">' + esc(f.name) + '</text>');
    });
    // Lines big → little (elbows), co-big dashed
    idx.list.forEach(function (m) {
      if (m.bigId && idx.byId[m.bigId]) parts.push(line(m.bigId, m.id, false));
      if (m.big2Id && idx.byId[m.big2Id]) parts.push(line(m.big2Id, m.id, true));
    });
    // Nodes
    idx.list.forEach(function (m) {
      var p = pt(m.id), col = colorOf(m.id), ph = photos[m.id];
      var cls = 'ft-node' + (m.id === selectedId ? ' selected' : '');
      var g = '<g class="' + cls + '" data-id="' + esc(m.id) + '" transform="translate(' + p.x + ',' + p.y + ')">';
      if (ph && ph.data) {
        g += '<circle class="ft-photo-ring" cx="' + (G.nodeW / 2) + '" cy="' + (-G.photoR + 10) + '" r="' + (G.photoR + 2) + '"/>' +
             '<image href="' + ph.data + '" x="' + (G.nodeW / 2 - G.photoR) + '" y="' + (-G.photoR * 2 + 10) + '" width="' + (G.photoR * 2) + '" height="' + (G.photoR * 2) + '" preserveAspectRatio="xMidYMid slice" style="clip-path:circle(50%)"/>';
      }
      g += '<rect class="ft-pill" x="0" y="0" width="' + G.nodeW + '" height="' + G.nodeH + '" rx="' + (G.nodeH / 2) + '" fill="' + col.fill + '"/>' +
           '<text class="ft-name" x="' + (G.nodeW / 2) + '" y="19" text-anchor="middle" fill="' + col.text + '">' + esc(clip(m.name, 20)) + '</text>' +
           '<text class="ft-sub" x="' + (G.nodeW / 2) + '" y="35" text-anchor="middle" fill="' + col.sub + '">' + esc(clip(subLine(m), 24)) + '</text>';
      var sg = T.signText(m.offices);
      if (sg) g += '<text class="ft-mark" x="' + (G.nodeW - 6) + '" y="' + (G.nodeH + 2) + '" text-anchor="end">' + esc(sg) + '</text>';
      g += '</g>';
      parts.push(g);
    });
    svg.setAttribute('width', size.w); svg.setAttribute('height', size.h);
    svg.innerHTML = '<g id="ft-world" transform="' + transform() + '">' + parts.join('') + '</g>';
    drawLabels();
    applyView();
  }
  function clip(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  function line(bigId, litId, dashed) {
    var a = pt(bigId), b = pt(litId), hasPhoto = !!(photos[litId] && photos[litId].data);
    var x1 = a.x + G.nodeW / 2, y1 = a.y + G.nodeH;
    var x2 = b.x + G.nodeW / 2, y2 = b.y - (hasPhoto ? G.photoR * 2 - 10 : 0);
    var d;
    if (a.row === b.row) {                                   // a little in the same class sits beside their big
      var yy = a.y + G.nodeH / 2;
      d = 'M' + (a.x + G.nodeW) + ',' + yy + ' L' + b.x + ',' + yy;
    } else {
      var ym = y2 - 18;
      d = 'M' + x1 + ',' + y1 + ' L' + x1 + ',' + ym + ' L' + x2 + ',' + ym + ' L' + x2 + ',' + y2;
    }
    return '<path class="ft-line' + (dashed ? ' cobig' : '') + '" d="' + d + '"/>';
  }

  /** Class labels live in HTML so they stay readable at any zoom: placed per row in applyView. */
  function drawLabels() {
    var box = $('ft-rowlabels');
    var html = '';
    for (var r = 0; r < lay.rows; r++) html += '<div class="ft-rowlabel" data-row="' + r + '">' + esc(classes[r] || '') + '</div>';
    box.innerHTML = html;
  }
  function placeLabels() {
    var els = $('ft-rowlabels').children, s = view.s;
    var font = Math.max(8, Math.min(15, G.rowH * s * 0.62));
    for (var i = 0; i < els.length; i++) {
      var r = +els[i].getAttribute('data-row');
      els[i].style.top = (view.ty + (G.padY + r * G.rowH) * s) + 'px';
      els[i].style.height = (G.rowH * s) + 'px';
      els[i].style.fontSize = font + 'px';
      els[i].style.lineHeight = (font * 1.05) + 'px';
    }
  }

  // ── View (pan & zoom) ──

  function transform() { return 'translate(' + view.tx + ',' + view.ty + ') scale(' + view.s + ')'; }
  function applyView() {
    var w = $('ft-world'); if (w) w.setAttribute('transform', transform());
    placeLabels();
  }
  function stageSize() { var st = $('ft-stage'); return { w: st.clientWidth, h: st.clientHeight }; }
  /** The stage takes whatever height is left under the toolbar (which wraps differently on each phone). */
  function sizeStage() {
    var st = $('ft-stage');
    st.style.height = Math.max(320, window.innerHeight - st.getBoundingClientRect().top - (window.innerWidth < 768 ? 8 : 16)) + 'px';
  }
  function fit() {
    if (!lay) return;
    sizeStage();
    var size = contentSize(), st = stageSize();
    var s = Math.min(st.w / size.w, st.h / size.h, 1.2);
    view.s = Math.max(s, 0.08);
    view.tx = Math.max(0, (st.w - size.w * view.s) / 2); view.ty = Math.max(0, (st.h - size.h * view.s) / 2);
    view.fitted = true;
    applyView();
  }
  function zoomAt(factor, cx, cy) {
    var ns = Math.min(3, Math.max(0.08, view.s * factor));
    view.tx = cx - (cx - view.tx) * (ns / view.s); view.ty = cy - (cy - view.ty) * (ns / view.s);
    view.s = ns; applyView();
  }
  function centerOn(id, scale) {
    var p = pt(id), st = stageSize();
    view.s = scale || Math.max(view.s, 1);
    view.tx = st.w / 2 - (p.x + G.nodeW / 2) * view.s; view.ty = st.h / 2 - (p.y + G.nodeH / 2) * view.s;
    applyView();
  }

  function wireStage() {
    var st = $('ft-stage'), pointers = {}, start = null, pinch = null, moved = false;
    st.addEventListener('pointerdown', function (e) {
      if (e.target.closest('.ft-zoom')) return;
      pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
      st.setPointerCapture(e.pointerId);
      var ids = Object.keys(pointers);
      if (ids.length === 1) { start = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty, target: e.target }; moved = false; }
      else if (ids.length === 2) { var a = pointers[ids[0]], b = pointers[ids[1]]; pinch = { d: dist(a, b), s: view.s, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, tx: view.tx, ty: view.ty }; }
    });
    st.addEventListener('pointermove', function (e) {
      if (!pointers[e.pointerId]) return;
      pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
      var ids = Object.keys(pointers);
      if (ids.length >= 2 && pinch) {
        var a = pointers[ids[0]], b = pointers[ids[1]], r = st.getBoundingClientRect();
        var f = dist(a, b) / (pinch.d || 1), mx = (a.x + b.x) / 2 - r.left, my = (a.y + b.y) / 2 - r.top;
        var ns = Math.min(3, Math.max(0.08, pinch.s * f));
        var px = pinch.mx - r.left, py = pinch.my - r.top;
        view.tx = mx - (px - pinch.tx) * (ns / pinch.s); view.ty = my - (py - pinch.ty) * (ns / pinch.s); view.s = ns;
        moved = true; applyView();
      } else if (start) {
        var dx = e.clientX - start.x, dy = e.clientY - start.y;
        if (Math.abs(dx) + Math.abs(dy) > 6) moved = true;
        view.tx = start.tx + dx; view.ty = start.ty + dy; applyView();
      }
    });
    function up(e) {
      var wasTap = start && !moved && Object.keys(pointers).length === 1;
      delete pointers[e.pointerId];
      if (!Object.keys(pointers).length) { pinch = null; }
      if (wasTap) {
        var node = start.target && start.target.closest ? start.target.closest('.ft-node') : null;
        if (node) select(node.getAttribute('data-id')); else if (!editing) closePanel();
      }
      if (!Object.keys(pointers).length) start = null;
    }
    st.addEventListener('pointerup', up); st.addEventListener('pointercancel', up);
    st.addEventListener('wheel', function (e) {
      e.preventDefault();
      var r = st.getBoundingClientRect();
      zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    $('ft-zoom-in').addEventListener('click', function () { var s = stageSize(); zoomAt(1.3, s.w / 2, s.h / 2); });
    $('ft-zoom-out').addEventListener('click', function () { var s = stageSize(); zoomAt(1 / 1.3, s.w / 2, s.h / 2); });
    $('ft-fit').addEventListener('click', fit);
    window.addEventListener('resize', function () { sizeStage(); if (view.fitted) fit(); });
    sizeStage();
    setTimeout(function () { var h = $('ft-hint'); if (h) h.classList.add('fade'); }, 6000);
  }
  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  // ── Selection & person card ──

  function select(id, keepFilter) {
    if (!fullIdx.byId[id]) return;
    if (!keepFilter && familyFilter && !idx.byId[id]) { familyFilter = ''; $('ft-family').value = ''; rebuild(true); }
    selectedId = id;
    document.querySelectorAll('.ft-node.selected').forEach(function (n) { n.classList.remove('selected'); });
    var node = document.querySelector('.ft-node[data-id="' + id + '"]');
    if (node) { node.classList.add('selected'); node.parentNode.appendChild(node); }
    showCard(id);                                            // open first: on a desktop the page narrows to make room
    centerOn(id, Math.max(view.s, window.innerWidth < 768 ? 0.9 : 1));
  }

  function personLink(m) { return m ? '<button type="button" class="ft-link" data-go="' + esc(m.id) + '">' + esc(m.name) + '</button>' : '<span class="ft-muted">—</span>'; }
  function list(arr) { return arr.length ? arr.map(personLink).join(', ') : '<span class="ft-muted">none yet</span>'; }

  function showCard(id) {
    editing = null;
    var m = fullIdx.byId[id]; if (!m) return;
    var rel = T.relations(fullIdx, id), ph = photos[id], col = colorOf(id);
    var fam = T.families(fullIdx).filter(function (f) { return f.rootId === rel.rootId; })[0];
    var html = '<div class="ft-card-head">' +
      (ph && ph.data ? '<img class="ft-card-photo" src="' + ph.data + '" alt="">' : '<div class="ft-card-photo ft-card-initials" style="background:' + col.fill + ';color:' + col.text + '">' + esc(initials(m.name)) + '</div>') +
      '<div><h2>' + esc(m.name) + '</h2>' +
      (T.signs(m.offices).length ? '<p class="ft-signs">' + T.signs(m.offices).map(function (s) { return '<span class="ft-mark-chip" title="' + esc(s.label) + '">' + esc(s.sign) + '</span> ' + esc(s.label); }).join(' · ') + '</p>' : '') +
      (m.fullName && m.fullName !== m.name ? '<p class="ft-card-full">' + esc(m.fullName) + '</p>' : '') +
      '<p class="ft-card-sub">' + esc([m.major, m.minor ? 'minor ' + m.minor : '', m.roll != null ? 'Roll #' + m.roll : '', m.pledgeClass ? m.pledgeClass + ' class' : '', m.grad ? 'grad ' + m.grad : ''].filter(Boolean).join(' · ')) + '</p>' +
      (m.roles ? '<p class="ft-card-sub">Exec: ' + esc(m.roles) + '</p>' : '') +
      (m.linkedin ? '<a class="ft-linkedin" href="' + esc(m.linkedin) + '" target="_blank" rel="noopener">LinkedIn ↗</a>' : '') +
      '</div></div>';
    if (m.note) html += '<p class="ft-note">' + esc(m.note) + '</p>';
    html += '<dl class="ft-rel">' +
      '<dt>Big</dt><dd>' + personLink(rel.big) + (rel.big2 ? ' &amp; ' + personLink(rel.big2) : '') + '</dd>' +
      (rel.grandBig ? '<dt>Grand-big</dt><dd>' + personLink(rel.grandBig) + '</dd>' : '') +
      '<dt>Littles</dt><dd>' + list(rel.littles) + '</dd>' +
      (rel.grandLittles.length ? '<dt>Grand-littles</dt><dd>' + list(rel.grandLittles) + '</dd>' : '') +
      (rel.twins.length ? '<dt>Twins</dt><dd>' + list(rel.twins) + '</dd>' : '') +
      '<dt>Family</dt><dd><button type="button" class="ft-link" data-family="' + esc(rel.rootId) + '">' + esc(fam ? fam.name : '') + '</button>' + (fam ? ' <span class="ft-muted">(' + fam.size + ')</span>' : '') + '</dd>' +
      '</dl>';
    if (canEdit) {
      html += '<div class="req-actions"><button type="button" class="btn btn-small" id="ft-edit">Edit</button>' +
        '<button type="button" class="btn ghost btn-small" id="ft-add-little">+ Add a little</button></div>';
    }
    openPanel(html);
    var body = $('ft-panel-body');
    body.querySelectorAll('[data-go]').forEach(function (b) { b.addEventListener('click', function () { select(this.getAttribute('data-go')); }); });
    body.querySelectorAll('[data-family]').forEach(function (b) { b.addEventListener('click', function () { setFamily(this.getAttribute('data-family')); }); });
    if (canEdit) {
      $('ft-edit').addEventListener('click', function () { showEditor(id); });
      $('ft-add-little').addEventListener('click', function () { showEditor(null, { bigId: id, pledgeClass: classes[Math.min(classes.length - 1, T.classIndex(m.pledgeClass, classes) + 1)] }); });
    }
  }

  function setFamily(rootId) {
    familyFilter = rootId || '';
    $('ft-family').value = familyFilter;
    view.fitted = false;
    rebuild(false);
    if (selectedId && idx.byId[selectedId]) { var n = document.querySelector('.ft-node[data-id="' + selectedId + '"]'); if (n) n.classList.add('selected'); }
  }

  function openPanel(html) {
    $('ft-panel-body').innerHTML = html;
    $('ft-panel-body').scrollTop = 0;
    $('ft-panel').classList.remove('hidden');
    $('ft-backdrop').classList.toggle('hidden', window.innerWidth >= 768);
    document.body.classList.add('ft-panel-open');          // desktop: the page makes room so the toolbar stays reachable
  }
  function closePanel() {
    editing = null;
    $('ft-panel').classList.add('hidden'); $('ft-backdrop').classList.add('hidden');
    document.body.classList.remove('ft-panel-open');
    if (selectedId) { var n = document.querySelector('.ft-node[data-id="' + selectedId + '"]'); if (n) n.classList.remove('selected'); }
    selectedId = null;
  }

  // ── Editor ──

  function personPicker(id, label, value, excludeId) {
    var cur = value && fullIdx.byId[value] ? fullIdx.byId[value] : null;
    return '<label class="field-label" for="' + id + '-q">' + label + '</label>' +
      '<div class="ft-picker" id="' + id + '" data-value="' + esc(value || '') + '" data-exclude="' + esc(excludeId || '') + '">' +
      '<input class="field" id="' + id + '-q" autocomplete="off" placeholder="Type a name…" value="' + esc(cur ? cur.name : '') + '">' +
      '<button type="button" class="ft-picker-clear" aria-label="Clear">×</button>' +
      '<div class="ft-search-results hidden"></div></div>';
  }
  function wirePicker(id) {
    var box = $(id), q = $(id + '-q'), res = box.querySelector('.ft-search-results');
    function render() {
      var hits = T.search(fullIdx, q.value, 8).filter(function (m) { return m.id !== box.getAttribute('data-exclude'); });
      res.innerHTML = hits.map(function (m) { return '<button type="button" data-pick="' + esc(m.id) + '"><b>' + esc(m.name) + '</b> <span>' + esc([m.pledgeClass, m.roll != null ? '#' + m.roll : ''].filter(Boolean).join(' · ')) + '</span></button>'; }).join('') || '<div class="ft-muted ft-nohit">No one by that name</div>';
      res.classList.toggle('hidden', !q.value.trim());
      res.querySelectorAll('[data-pick]').forEach(function (b) { b.addEventListener('click', function () { box.setAttribute('data-value', this.getAttribute('data-pick')); q.value = fullIdx.byId[this.getAttribute('data-pick')].name; res.classList.add('hidden'); }); });
    }
    q.addEventListener('input', function () { box.setAttribute('data-value', ''); render(); });
    q.addEventListener('focus', function () { if (q.value.trim() && !box.getAttribute('data-value')) render(); });
    box.querySelector('.ft-picker-clear').addEventListener('click', function () { q.value = ''; box.setAttribute('data-value', ''); res.classList.add('hidden'); });
  }

  function showEditor(id, preset) {
    var m = id ? Object.assign({}, fullIdx.byId[id]) : Object.assign({ name: '', pledgeClass: classes[classes.length - 1] }, preset || {});
    editing = id || 'new';
    var isRoot = !m.bigId;
    var classOpts = classes.map(function (c) { return '<option' + (c === m.pledgeClass ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('') + '<option value="__new">+ New class (' + esc(T.nextClass(classes)) + ')</option>';
    var ph = id ? photos[id] : null;
    var html = '<h2>' + (id ? 'Edit ' + esc(m.name) : 'Add a brother') + '</h2>' +
      '<label class="field-label" for="fe-name">Name</label><input class="field" id="fe-name" maxlength="80" value="' + esc(m.name || '') + '">' +
      '<div class="ft-two"><div><label class="field-label" for="fe-roll">Roll #</label><input class="field" id="fe-roll" inputmode="numeric" value="' + esc(m.roll != null ? m.roll : '') + '"></div>' +
      '<div><label class="field-label" for="fe-class">Pledge class</label><select class="field" id="fe-class">' + classOpts + '</select></div></div>' +
      '<label class="field-label" for="fe-major">Major</label><input class="field" id="fe-major" maxlength="60" value="' + esc(m.major || '') + '">' +
      '<details class="ft-more"><summary>Brother List details (full name, minor, graduation, exec roles)</summary>' +
      '<label class="field-label" for="fe-fullname">Full name (as on the Brother List)</label><input class="field" id="fe-fullname" maxlength="80" value="' + esc(m.fullName || '') + '">' +
      '<div class="ft-two"><div><label class="field-label" for="fe-minor">Minor(s)</label><input class="field" id="fe-minor" maxlength="60" value="' + esc(m.minor || '') + '"></div>' +
      '<div><label class="field-label" for="fe-grad">Graduation</label><input class="field" id="fe-grad" maxlength="20" placeholder="May 2027" value="' + esc(m.grad || '') + '"></div></div>' +
      '<label class="field-label" for="fe-roles">Exec roles (text, e.g. Regent - 2024)</label><input class="field" id="fe-roles" maxlength="120" value="' + esc(m.roles || '') + '"></details>' +
      personPicker('fe-big', 'Big', m.bigId, id) +
      personPicker('fe-big2', 'Co-big (only if two people share a little)', m.big2Id, id) +
      '<div class="ft-photo-row"><div class="ft-card-photo ft-card-initials" id="fe-photo-preview"' + (ph && ph.data ? ' style="background-image:url(' + ph.data + ')"' : '') + '>' + (ph && ph.data ? '' : esc(initials(m.name))) + '</div>' +
      '<div><label class="btn ghost btn-small photo-add">Choose photo<input type="file" id="fe-photo" accept="image/*" class="visually-hidden"></label> ' +
      '<button type="button" class="btn ghost btn-small' + (ph ? '' : ' hidden') + '" id="fe-photo-remove">Remove photo</button><p class="step-hint">Square crop, shrunk to 192 px. Any phone photo works.</p></div></div>' +
      '<label class="field-label" for="fe-linkedin">LinkedIn (optional)</label><input class="field" id="fe-linkedin" placeholder="https://www.linkedin.com/in/…" value="' + esc(m.linkedin || '') + '">' +
      '<p class="field-label">Offices held (official signs: X! now, XX! past)</p><div class="ft-offices">' + T.OFFICES.map(function (o) {
        var v = (m.offices || {})[o.key] || '';
        var opts = Object.keys(T.OFFICE_LEVELS).map(function (k) { var lv = T.OFFICE_LEVELS[k], sg = ''; for (var i = 0; i < lv[0]; i++) sg += o.sign; return '<option value="' + k + '"' + (v === k ? ' selected' : '') + '>' + sg + '! ' + (lv[1] || 'now ').trim().toLowerCase() + '</option>'; }).join('');
        return '<label><span>' + esc(o.label) + '</span><select class="field fe-office" data-office="' + o.key + '"><option value="">—</option>' + opts + '</select></label>';
      }).join('') + '</div>' +
      '<div class="' + (isRoot ? '' : 'hidden') + '" id="fe-root-fields"><label class="field-label" for="fe-color">Family colour</label><select class="field" id="fe-color"><option value="gold"' + (m.color !== 'maroon' ? ' selected' : '') + '>Gold</option><option value="maroon"' + (m.color === 'maroon' ? ' selected' : '') + '>Maroon</option></select></div>' +
      '<div class="' + (isRoot ? '' : 'hidden') + '" id="fe-family-wrap"><label class="field-label" for="fe-family">Family name (shown above the root)</label><input class="field" id="fe-family" maxlength="60" value="' + esc(m.familyName || '') + '"></div>' +
      '<label class="field-label" for="fe-note">Note (optional)</label><input class="field" id="fe-note" maxlength="140" value="' + esc(m.note || '') + '">' +
      '<div class="req-actions"><button type="button" class="btn" id="fe-save">Save</button><button type="button" class="btn ghost btn-small" id="fe-cancel">Cancel</button>' +
      (id ? '<button type="button" class="btn danger btn-small" id="fe-delete">Remove</button>' : '') + '</div>' +
      '<p class="status-line" id="fe-status"></p>';
    openPanel(html);
    wirePicker('fe-big'); wirePicker('fe-big2');
    var newPhoto = null, removePhoto = false;
    $('fe-class').addEventListener('change', function () {
      if (this.value !== '__new') return;
      var name = prompt('Name of the new pledge class', T.nextClass(classes));
      if (!name || !name.trim()) { this.value = m.pledgeClass || classes[0]; return; }
      name = name.trim();
      if (classes.indexOf(name) === -1) {
        classes = classes.concat([name]);
        db.ref('familyTree/meta').update({ classes: classes, updatedBy: me.uid, updatedAt: new Date().toISOString() });
      }
      var opt = document.createElement('option'); opt.textContent = name; opt.selected = true;
      this.insertBefore(opt, this.lastElementChild);
    });
    $('fe-photo').addEventListener('change', function () {
      var f = this.files && this.files[0]; this.value = '';
      if (!f) return;
      setStatus('fe-status', 'Shrinking the photo…');
      squareThumb(f).then(function (data) {
        newPhoto = data; removePhoto = false;
        var pv = $('fe-photo-preview'); pv.style.backgroundImage = 'url(' + data + ')'; pv.textContent = '';
        $('fe-photo-remove').classList.remove('hidden'); setStatus('fe-status', '');
      }).catch(function (err) { setStatus('fe-status', err.message, 'error'); });
    });
    $('fe-photo-remove').addEventListener('click', function () {
      newPhoto = null; removePhoto = true;
      var pv = $('fe-photo-preview'); pv.style.backgroundImage = ''; pv.textContent = initials($('fe-name').value);
      this.classList.add('hidden');
    });
    $('fe-cancel').addEventListener('click', function () { if (id) showCard(id); else closePanel(); });
    $('fe-save').addEventListener('click', function () {
      var rec = {
        name: $('fe-name').value, roll: $('fe-roll').value.trim(), pledgeClass: $('fe-class').value, major: $('fe-major').value,
        bigId: $('fe-big').getAttribute('data-value'), big2Id: $('fe-big2').getAttribute('data-value'),
        linkedin: $('fe-linkedin').value, note: $('fe-note').value, offices: {},
        fullName: $('fe-fullname').value, minor: $('fe-minor').value, grad: $('fe-grad').value, roles: $('fe-roles').value, nickname: m.nickname || '',
        familyName: $('fe-family').value, color: $('fe-color').value,
        hasPhoto: newPhoto ? true : (removePhoto ? false : !!m.hasPhoto)
      };
      document.querySelectorAll('.fe-office').forEach(function (sel) { if (sel.value) rec.offices[sel.getAttribute('data-office')] = sel.value; });
      if (rec.bigId) { rec.familyName = ''; rec.color = ''; }       // only a root carries family fields
      if (rec.pledgeClass === '__new') rec.pledgeClass = m.pledgeClass || '';
      var errs = T.validate(fullIdx, id || '', rec);
      if (errs.length) return setStatus('fe-status', errs.join(' '), 'error');
      var clean = T.cleanRecord(rec);
      var key = id || db.ref('familyTree/members').push().key;
      var updates = {};
      updates['familyTree/members/' + key] = clean;
      if (newPhoto) updates['familyTree/photos/' + key] = { data: newPhoto, w: T.LIMITS.photoSide, h: T.LIMITS.photoSide, bytes: Math.round(newPhoto.length * 0.75), createdAt: new Date().toISOString(), by: me.uid };
      else if (removePhoto) updates['familyTree/photos/' + key] = null;
      updates['familyTree/history/' + db.ref().push().key] = history(id ? 'edit' : 'add', key, clean.name, id ? T.cleanRecord(fullIdx.byId[id]) : null, clean);
      var b = this; b.disabled = true; setStatus('fe-status', 'Saving…');
      db.ref().update(updates).then(function () {
        if (newPhoto) photos[key] = { data: newPhoto }; else if (removePhoto) delete photos[key];
        selectedId = key; editing = null;
        setTimeout(function () { if (fullIdx.byId[key]) { select(key, true); } }, 150);
      }).catch(function (err) { b.disabled = false; setStatus('fe-status', 'Could not save: ' + err.message, 'error'); });
    });
    if (id) $('fe-delete').addEventListener('click', function () {
      var rel = T.relations(fullIdx, id);
      var msg = 'Remove ' + m.name + ' from the tree?' + (rel.littles.length ? ' Their ' + rel.littles.length + ' little(s) will be attached to ' + (rel.big ? rel.big.name : 'no one (they become family roots)') + '.' : '');
      if (!confirm(msg)) return;
      var updates = {};
      updates['familyTree/members/' + id] = null;
      updates['familyTree/photos/' + id] = null;
      rel.littles.forEach(function (l) { updates['familyTree/members/' + l.id + '/bigId'] = m.bigId || null; });
      fullIdx.list.forEach(function (x) { if (x.big2Id === id) updates['familyTree/members/' + x.id + '/big2Id'] = null; });
      updates['familyTree/history/' + db.ref().push().key] = history('delete', id, m.name, T.cleanRecord(m), null);
      db.ref().update(updates).then(function () { delete photos[id]; closePanel(); }).catch(function (err) { setStatus('fe-status', 'Could not remove: ' + err.message, 'error'); });
    });
  }
  function history(action, memberId, name, before, after) {
    return { action: action, memberId: memberId, name: name || '', before: before || null, after: after || null, by: me.uid, byName: me.name || me.email || '', at: new Date().toISOString() };
  }

  /** Any picture → square 192 px JPEG data URL small enough for the rules. */
  function squareThumb(file) {
    return global.PortalPhotos.compress(file).then(function (p) {
      return new Promise(function (resolve, reject) {
        var img = new Image();
        img.onload = function () {
          var side = T.LIMITS.photoSide, s = Math.min(img.width, img.height);
          var c = document.createElement('canvas'); c.width = side; c.height = side;
          var ctx = c.getContext('2d');
          ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, side, side);
          var q = 0.84, data = c.toDataURL('image/jpeg', q);
          while (data.length > T.LIMITS.photoChars && q > 0.3) { q -= 0.1; data = c.toDataURL('image/jpeg', q); }
          resolve(data);
        };
        img.onerror = function () { reject(new Error('Could not read that picture.')); };
        img.src = p.data;
      });
    });
  }

  // ── Search, family, me ──

  function wireToolbar() {
    var q = $('ft-search'), res = $('ft-search-results');
    function render() {
      var hits = T.search(fullIdx, q.value, 10);
      res.innerHTML = hits.map(function (m) { return '<button type="button" data-pick="' + esc(m.id) + '"><b>' + esc(m.name) + '</b> <span>' + esc([m.pledgeClass, m.roll != null ? '#' + m.roll : '', m.major].filter(Boolean).join(' · ')) + '</span></button>'; }).join('') || '<div class="ft-muted ft-nohit">No one by that name</div>';
      res.classList.toggle('hidden', !q.value.trim());
      res.querySelectorAll('[data-pick]').forEach(function (b) { b.addEventListener('click', function () { res.classList.add('hidden'); q.value = ''; select(this.getAttribute('data-pick')); }); });
    }
    q.addEventListener('input', render);
    q.addEventListener('keydown', function (e) { if (e.key === 'Enter') { var first = res.querySelector('[data-pick]'); if (first) first.click(); } if (e.key === 'Escape') res.classList.add('hidden'); });
    document.addEventListener('click', function (e) { if (!e.target.closest('.ft-search-wrap')) res.classList.add('hidden'); });
    $('ft-family').addEventListener('change', function () { setFamily(this.value); });
    $('ft-me').addEventListener('click', function () {
      var hit = null;
      if (me.rollNumber) hit = fullIdx.list.filter(function (m) { return String(m.roll) === String(parseInt(me.rollNumber, 10)); })[0];
      if (!hit && me.name) hit = T.search(fullIdx, me.name, 1)[0];
      if (hit) select(hit.id); else $('ft-summary').textContent = 'You are not in the tree yet' + (canEdit ? ' — press + Add brother.' : ' — ask an officer to add you.');
    });
    $('ft-export').addEventListener('click', showExport);
    $('ft-add').addEventListener('click', function () { showEditor(null, {}); });
  }

  // ── Export (PNG) ──

  function showExport() {
    var famName = familyFilter && fullIdx.byId[familyFilter] ? T.families(fullIdx).filter(function (f) { return f.rootId === familyFilter; })[0].name : '';
    var html = '<h2>Export a picture</h2>' +
      '<label class="field-label" for="fx-title">Title</label><input class="field" id="fx-title" value="' + esc(meta.title || 'Theta Tau Zeta Delta Family Tree') + '">' +
      '<label class="field-label" for="fx-scope">What</label><select class="field" id="fx-scope"><option value="all">Whole chapter</option>' + (famName ? '<option value="family" selected>' + esc(famName) + ' only</option>' : '') + '</select>' +
      '<div class="ft-two"><div><label class="field-label" for="fx-bg">Background</label><select class="field" id="fx-bg"><option value="#fbf8f3">Cream</option><option value="#ffffff">White</option><option value="#8B0000">Maroon</option><option value="#1b1b1b">Black</option></select></div>' +
      '<div><label class="field-label" for="fx-photos">Photos</label><select class="field" id="fx-photos"><option value="1">Include</option><option value="0">Pills only</option></select></div></div>' +
      '<div class="req-actions"><button type="button" class="btn" id="fx-go">Make the picture</button>' + (canEdit ? '<button type="button" class="btn ghost btn-small" id="fx-backup">Download a backup file</button>' : '') + '</div>' +
      '<p class="status-line" id="fx-status"></p><p class="step-hint">Big trees are drawn as large as this phone or computer allows. On an iPhone, press and hold the picture to save it.</p>';
    openPanel(html);
    $('fx-go').addEventListener('click', function () {
      var b = this; b.disabled = true; setStatus('fx-status', 'Drawing…');
      renderPng({ title: $('fx-title').value, scope: $('fx-scope').value, bg: $('fx-bg').value, photos: $('fx-photos').value === '1' })
        .then(function (blob) { b.disabled = false; setStatus('fx-status', ''); deliver(blob); })
        .catch(function (err) { b.disabled = false; setStatus('fx-status', 'Could not draw it: ' + err.message, 'error'); });
    });
    if (canEdit) $('fx-backup').addEventListener('click', function () {
      var out = { source: 'Brother Portal family tree backup', exportedAt: new Date().toISOString(), classes: classes, members: members, photos: photos };
      var blob = new Blob([JSON.stringify(out)], { type: 'application/json' });
      var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'family-tree-backup-' + new Date().toISOString().slice(0, 10) + '.json'; document.body.appendChild(a); a.click(); a.remove();
    });
  }

  function renderPng(o) {
    var scopeIdx = idx, scopeLay = lay;
    if (o.scope === 'all' && familyFilter) { scopeIdx = T.index(members, classes); scopeLay = T.layout(scopeIdx, classes); }
    var pad = 40, titleH = o.title ? 90 : 0;
    var w = G.padX * 2 + G.labelW + (scopeLay.width + 0.5) * G.unit, h = G.padY * 2 + scopeLay.rows * G.rowH + titleH;
    var ios = /iPhone|iPad/i.test(navigator.userAgent);
    var k = 2, cap = ios ? 15e6 : 100e6, maxSide = 16000;   // iOS Safari refuses canvases past ~16 M pixels; browsers cap a side near 16k
    if (w * h * k * k > cap) k = Math.sqrt(cap / (w * h));
    k = Math.min(k, maxSide / w, maxSide / h);
    var c = document.createElement('canvas'); c.width = Math.floor(w * k); c.height = Math.floor(h * k);
    var ctx = c.getContext('2d'); ctx.scale(k, k);
    var dark = o.bg === '#8B0000' || o.bg === '#1b1b1b';
    ctx.fillStyle = o.bg; ctx.fillRect(0, 0, w, h);
    if (o.title) { ctx.fillStyle = dark ? '#fff' : '#8B0000'; ctx.font = '700 40px Poppins, Arial, sans-serif'; ctx.textAlign = 'center'; ctx.fillText(o.title, w / 2, 58); }
    ctx.translate(0, titleH);
    var P = function (id) { var p = scopeLay.pos[id]; return { x: G.padX + G.labelW + p.x * G.unit - G.nodeW / 2, y: G.padY + p.row * G.rowH + (G.rowH - G.nodeH) - 8, row: p.row }; };
    for (var r = 0; r < scopeLay.rows; r++) {
      ctx.fillStyle = dark ? (r % 2 ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.02)') : (r % 2 ? 'rgba(0,0,0,0.055)' : 'rgba(0,0,0,0.0)');
      ctx.fillRect(0, G.padY + r * G.rowH, w, G.rowH);
      ctx.fillStyle = dark ? '#fff' : '#222'; ctx.font = '600 18px Georgia, serif'; ctx.textAlign = 'left';
      ctx.fillText(classes[r] || '', pad / 2, G.padY + r * G.rowH + G.rowH / 2 + 6);
    }
    var withPhotos = o.photos ? Object.keys(photos).filter(function (id) { return scopeIdx.byId[id] && photos[id].data; }) : [];
    return Promise.all(withPhotos.map(function (id) { return new Promise(function (res) { var im = new Image(); im.onload = function () { res([id, im]); }; im.onerror = function () { res(null); }; im.src = photos[id].data; }); }))
      .then(function (imgs) {
        var img = {}; imgs.forEach(function (x) { if (x) img[x[0]] = x[1]; });
        ctx.strokeStyle = dark ? 'rgba(255,255,255,0.8)' : '#333'; ctx.lineWidth = 1.6;
        scopeIdx.list.forEach(function (m) {
          [[m.bigId, false], [m.big2Id, true]].forEach(function (e) {
            if (!e[0] || !scopeIdx.byId[e[0]]) return;
            var a = P(e[0]), b = P(m.id), hp = !!img[m.id];
            ctx.setLineDash(e[1] ? [6, 5] : []);
            ctx.beginPath();
            if (a.row === b.row) { var yy = a.y + G.nodeH / 2; ctx.moveTo(a.x + G.nodeW, yy); ctx.lineTo(b.x, yy); }
            else { var x1 = a.x + G.nodeW / 2, x2 = b.x + G.nodeW / 2, y2 = b.y - (hp ? G.photoR * 2 - 10 : 0), ym = y2 - 18; ctx.moveTo(x1, a.y + G.nodeH); ctx.lineTo(x1, ym); ctx.lineTo(x2, ym); ctx.lineTo(x2, y2); }
            ctx.stroke();
          });
        });
        ctx.setLineDash([]);
        scopeLay.families.forEach(function (f) {
          var p = P(f.rootId); ctx.fillStyle = dark ? '#ffd966' : '#8B0000'; ctx.font = '700 13px Poppins, Arial, sans-serif'; ctx.textAlign = 'center';
          ctx.fillText(f.name, p.x + G.nodeW / 2, p.y - (img[f.rootId] ? G.photoR * 2 + 14 : 14));
        });
        scopeIdx.list.forEach(function (m) {
          var p = P(m.id), col = colorOf(m.id);
          if (img[m.id]) {
            var cx = p.x + G.nodeW / 2, cy = p.y - G.photoR + 10;
            ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, G.photoR, 0, Math.PI * 2); ctx.closePath(); ctx.clip();
            ctx.drawImage(img[m.id], cx - G.photoR, cy - G.photoR, G.photoR * 2, G.photoR * 2); ctx.restore();
            ctx.beginPath(); ctx.arc(cx, cy, G.photoR + 1, 0, Math.PI * 2); ctx.strokeStyle = o.bg; ctx.lineWidth = 2; ctx.stroke(); ctx.strokeStyle = dark ? 'rgba(255,255,255,0.8)' : '#333'; ctx.lineWidth = 1.6;
          }
          roundRect(ctx, p.x, p.y, G.nodeW, G.nodeH, G.nodeH / 2); ctx.fillStyle = col.fill; ctx.fill();
          ctx.fillStyle = col.text; ctx.font = '700 13px Poppins, Arial, sans-serif'; ctx.textAlign = 'center'; ctx.fillText(clip(m.name, 20), p.x + G.nodeW / 2, p.y + 19);
          ctx.fillStyle = col.sub; ctx.font = '500 10.5px Poppins, Arial, sans-serif'; ctx.fillText(clip(subLine(m), 24), p.x + G.nodeW / 2, p.y + 35);
          var sg = T.signText(m.offices);
          if (sg) { ctx.fillStyle = col.fill === COLORS.gold.fill ? '#8B0000' : '#E6B800'; ctx.font = '900 14px Georgia, serif'; ctx.textAlign = 'right'; ctx.fillText(sg, p.x + G.nodeW - 4, p.y + G.nodeH + 2); }
        });
        return new Promise(function (res, rej) { c.toBlob(function (b) { b ? res(b) : rej(new Error('the picture is too big for this device — try one family')); }, 'image/png'); });
      });
  }
  function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }

  function deliver(blob) {
    var name = 'theta-tau-family-tree-' + new Date().toISOString().slice(0, 10) + '.png';
    var file = null;
    try { file = new File([blob], name, { type: 'image/png' }); } catch (e) { file = null; }
    if (file && navigator.canShare && navigator.canShare({ files: [file] }) && /iPhone|iPad|Android/i.test(navigator.userAgent)) {
      navigator.share({ files: [file], title: 'Family tree' }).catch(function () { showImage(blob, name); });
      return;
    }
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
    if (/iPhone|iPad/i.test(navigator.userAgent)) showImage(blob, name);
  }
  function showImage(blob) {
    var url = URL.createObjectURL(blob);
    var o = document.createElement('div'); o.className = 'photo-overlay';
    o.innerHTML = '<img src="' + url + '" alt="Family tree"><p class="ft-overlay-hint">Press and hold the picture to save it. Tap outside to close.</p>';
    o.addEventListener('click', function (e) { if (e.target === o) o.remove(); });
    document.body.appendChild(o);
  }

  // ── First-time import & restore (admin) ──

  function writeSeed(seed, label) {
    var mem = seed.members || {}, ph = seed.photos || {};
    var ids = Object.keys(mem);
    if (!ids.length) return Promise.reject(new Error('That file has no members in it.'));
    var updates = {};
    ids.forEach(function (id) { updates['familyTree/members/' + id] = T.cleanRecord(Object.assign({}, mem[id], { hasPhoto: !!ph[id] })); });
    updates['familyTree/meta'] = { classes: seed.classes || T.DEFAULT_CLASSES, importedAt: new Date().toISOString(), importedBy: me.uid, source: seed.source || label };
    updates['familyTree/history/' + db.ref().push().key] = history('import', '', label, null, { members: ids.length, photos: Object.keys(ph).length });
    var photoIds = Object.keys(ph).filter(function (id) { return mem[id] && ph[id] && ph[id].data; });
    return db.ref().update(updates).then(function () {
      var chunks = [];
      for (var i = 0; i < photoIds.length; i += 40) chunks.push(photoIds.slice(i, i + 40));
      return chunks.reduce(function (p, chunk, n) {
        return p.then(function () {
          setStatus('ft-import-status', 'Saving photos… ' + Math.min(photoIds.length, (n + 1) * 40) + ' of ' + photoIds.length);
          var u = {};
          chunk.forEach(function (id) { u['familyTree/photos/' + id] = { data: ph[id].data, w: ph[id].w || T.LIMITS.photoSide, h: ph[id].h || T.LIMITS.photoSide, bytes: ph[id].bytes || 0, createdAt: new Date().toISOString(), by: me.uid }; });
          return db.ref().update(u);
        });
      }, Promise.resolve());
    }).then(function () { photosLoaded = false; loadPhotos(); });
  }
  function wireImport() {
    $('ft-import').addEventListener('click', function () {
      if (!confirm('Import the 2026 Canva poster (about 480 brothers and their photos)? This only works while the tree is empty.')) return;
      var b = this; b.disabled = true; setStatus('ft-import-status', 'Downloading the poster data…');
      fetch('data/family-tree-seed.json', { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error('seed file missing (' + r.status + ')'); return r.json(); })
        .then(function (seed) { setStatus('ft-import-status', 'Saving ' + Object.keys(seed.members).length + ' brothers…'); return writeSeed(seed, 'Canva poster'); })
        .then(function () { setStatus('ft-import-status', 'Done. Check the names flagged in the officer guide.', 'success'); })
        .catch(function (err) { b.disabled = false; setStatus('ft-import-status', 'Import failed: ' + err.message, 'error'); });
    });
    $('ft-restore').addEventListener('change', function () {
      var f = this.files && this.files[0]; this.value = '';
      if (!f) return;
      var rd = new FileReader();
      rd.onload = function () {
        var seed; try { seed = JSON.parse(rd.result); } catch (e) { return setStatus('ft-import-status', 'That is not a backup file.', 'error'); }
        if (!confirm('Restore ' + Object.keys(seed.members || {}).length + ' brothers from this file?')) return;
        setStatus('ft-import-status', 'Restoring…');
        writeSeed(seed, f.name).then(function () { setStatus('ft-import-status', 'Restored.', 'success'); }).catch(function (err) { setStatus('ft-import-status', 'Restore failed: ' + err.message, 'error'); });
      };
      rd.readAsText(f);
    });
  }

  // ── Start ──

  global.PortalAuth.requireAuth({ page: 'family-tree' }).then(function (profile) {
    if (!profile) return;
    me = profile;
    global.PortalAuth.initNav(profile);
    isAdmin = profile.role === 'admin';
    canEdit = global.PortalAuth.hasPerm(profile, 'tree');
    $('ft-add').classList.toggle('hidden', !canEdit);
    $('ft-empty-text').textContent = isAdmin ? 'Nobody has been added to the family tree. Import the Canva poster once, then exec keeps it up to date here.' : 'Nobody has been added to the family tree yet. An admin imports the poster first.';
    $('ft-panel-close').addEventListener('click', closePanel);
    $('ft-backdrop').addEventListener('click', closePanel);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !editing) closePanel(); });
    wireStage(); wireToolbar(); wireImport();
    load();
  });
})(typeof window !== 'undefined' ? window : this);
