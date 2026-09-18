/**
 * Admin panel: approve registrations, set membership status, assign positions
 * (which grant permissions), edit roll numbers, delete accounts.
 * Reads the users node; writes go through PortalOps.saveUser so users/,
 * directory/ and the sign-up roster stay in step.
 */
(function(global) {
  'use strict';

  var db = firebase.database();
  var C = global.OpsCore;
  var settings = null;
  var users = {};
  var me = null;

  var esc = C.esc;
  function $(id) { return document.getElementById(id); }

  function statusSelect(uid, status) {
    var list = C.sortByOrder(C.values(settings.statuses)).filter(function(s) { return s.key !== 'pending'; });
    return '<select class="status-select" data-uid="' + uid + '">' + list.map(function(s) {
      return '<option value="' + s.key + '"' + (status === s.key ? ' selected' : '') + '>' + esc(s.label) + '</option>';
    }).join('') + '</select>';
  }

  function positionChips(positions) {
    var keys = Object.keys(positions || {}).filter(function(k) { return positions[k]; });
    var defs = keys.map(function(k) { return settings.positions[k] || { label: k, order: 999 }; });
    defs = C.sortByOrder(defs);
    return defs.map(function(d) { return '<span class="pos-chip">' + esc(d.label) + '</span>'; }).join('');
  }

  function accessCell(u) {
    var perms = Object.keys(u.perms || {}).filter(function(k) { return u.perms[k]; });
    var out = '';
    if (u.role === 'admin') out += '<span class="perm admin">admin</span>';
    perms.filter(function(p) { return p !== 'admin'; }).forEach(function(p) { out += '<span class="perm">' + esc(p) + '</span>'; });
    if (!out) out = '<span class="perm">member</span>';
    return out;
  }

  function memberRow(uid, u) {
    var tr = document.createElement('tr');
    tr.setAttribute('data-uid', uid);
    if (!C.isActiveStatus(u.status, settings)) tr.classList.add('row-muted');
    tr.innerHTML =
      '<td><span class="member-name">' + esc(u.name || '—') + '</span><span class="member-email">' + esc(u.email || '') + '</span></td>' +
      '<td><input type="text" class="roll-input" data-uid="' + uid + '" value="' + esc(u.rollNumber || '') + '" placeholder="—"><span class="roll-saved hidden" data-for="' + uid + '">saved</span></td>' +
      '<td>' + statusSelect(uid, u.status || 'active') + '</td>' +
      '<td><div class="pos-chips">' + positionChips(u.positions) + '<button type="button" class="pos-edit" data-uid="' + uid + '">' + (Object.keys(u.positions || {}).length ? 'Edit' : '+ Add') + '</button></div></td>' +
      '<td class="access-cell">' + accessCell(u) + '</td>' +
      '<td><button type="button" class="btn-delete-user" data-uid="' + uid + '" data-name="' + esc(u.name || u.email || uid) + '" style="background:#c62828;color:#fff;border:none;border-radius:4px;padding:0.3rem 0.6rem;font-size:0.8rem;cursor:pointer;">Delete</button></td>';
    return tr;
  }

  function pendingRow(uid, u) {
    var tr = document.createElement('tr');
    tr.innerHTML =
      '<td>' + esc(u.name || '—') + '</td><td>' + esc(u.email || '—') + '</td>' +
      '<td><input type="text" class="roll-input" data-uid="' + uid + '" value="' + esc(u.rollNumber || '') + '" placeholder="—"><span class="roll-saved hidden" data-for="' + uid + '">saved</span></td>' +
      '<td><select class="approve-as" data-uid="' + uid + '"><option value="active">Active brother</option><option value="pnm">PNM (pledge)</option><option value="alumnus">Alumnus</option></select></td>' +
      '<td><button type="button" class="btn btn-primary btn-small btn-approve" data-uid="' + uid + '" style="margin:0 0.25rem 0 0;">Approve</button>' +
      '<button type="button" class="btn-delete-user" data-uid="' + uid + '" data-name="' + esc(u.name || u.email || uid) + '" style="background:#c62828;color:#fff;border:none;border-radius:4px;padding:0.3rem 0.6rem;font-size:0.8rem;cursor:pointer;">Delete</button></td>';
    return tr;
  }

  function matchesFilter(u, q, f) {
    var hay = ((u.name || '') + ' ' + (u.rollNumber || '') + ' ' + Object.keys(u.positions || {}).join(' ') + ' ' + (u.email || '')).toLowerCase();
    if (q && hay.indexOf(q) === -1) return false;
    var hasPos = Object.keys(u.positions || {}).some(function(k) { return u.positions[k]; });
    if (f === 'positions') return hasPos || u.role === 'admin';
    if (f === 'active') return u.status === 'active';
    if (f === 'pnm') return u.status === 'pnm';
    if (f === 'other') return ['inactive', 'coop', 'alumnus', 'graduated'].indexOf(u.status) !== -1;
    return true;
  }

  function render() {
    var pendingBody = $('tbody-pending'), memBody = $('tbody-members');
    pendingBody.innerHTML = ''; memBody.innerHTML = '';
    var q = ($('member-search').value || '').trim().toLowerCase();
    var f = $('member-filter').value;
    var uids = Object.keys(users).sort(function(a, b) {
      return ((users[a].name || '').toLowerCase()).localeCompare((users[b].name || '').toLowerCase());
    });
    var pending = 0, members = 0, needsUpgrade = 0;
    uids.forEach(function(uid) {
      var u = users[uid] || {};
      if (!u.status || !u.positions || !u.perms) needsUpgrade++;
      var st = u.status || (u.role === 'pending' ? 'pending' : 'active');
      if (st === 'pending') { pending++; pendingBody.appendChild(pendingRow(uid, u)); return; }
      if (!matchesFilter(u, q, f)) return;
      members++;
      memBody.appendChild(memberRow(uid, u));
    });
    $('count-pending').textContent = pending;
    $('count-members').textContent = members;
    $('card-pending').classList.toggle('hidden', pending === 0);
    if (members === 0) memBody.innerHTML = '<tr><td colspan="6" class="section-empty">No one matches.</td></tr>';
    $('card-migrate').style.display = needsUpgrade ? '' : 'none';
    $('migrate-count').textContent = needsUpgrade;
    wire();
  }

  // ── Row actions ──

  function flash(uid) {
    var flag = document.querySelector('.roll-saved[data-for="' + uid + '"]');
    if (flag) { flag.classList.remove('hidden'); setTimeout(function() { flag.classList.add('hidden'); }, 1500); }
  }

  function wire() {
    document.querySelectorAll('.roll-input').forEach(function(input) {
      var uid = input.getAttribute('data-uid');
      var original = input.value;
      function save() {
        var val = C.rollKey(input.value) || input.value.trim();
        if (val === original) return;
        PortalOps.saveUser(uid, { rollNumber: val }, me).then(function() { original = val; input.value = val; flash(uid); })
          .catch(function(err) { input.value = original; alert(err.message || 'Failed to save roll number.'); });
      }
      input.addEventListener('blur', save);
      input.addEventListener('keydown', function(e) { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
    });

    document.querySelectorAll('.status-select').forEach(function(sel) {
      sel.addEventListener('change', function() {
        var uid = this.getAttribute('data-uid');
        var patch = { status: this.value };
        if (this.value === 'inactive' || this.value === 'coop') patch.inactiveSince = new Date().toISOString().slice(0, 10);
        PortalOps.saveUser(uid, patch, me).catch(function(err) { alert(err.message || 'Failed to update status.'); });
      });
    });

    document.querySelectorAll('.pos-edit').forEach(function(btn) {
      btn.addEventListener('click', function(e) { e.stopPropagation(); openPositions(this.getAttribute('data-uid'), this); });
    });

    document.querySelectorAll('.btn-approve').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var uid = this.getAttribute('data-uid');
        var as = document.querySelector('.approve-as[data-uid="' + uid + '"]').value;
        btn.disabled = true;
        PortalOps.saveUser(uid, { status: as }, me).catch(function(err) { btn.disabled = false; alert(err.message || 'Failed to approve.'); });
      });
    });

    document.querySelectorAll('.btn-delete-user').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var uid = this.getAttribute('data-uid');
        var name = this.getAttribute('data-name');
        if (!confirm('Delete "' + name + '"? Their account record is removed; ledger and attendance history stay. This cannot be undone.')) return;
        var updates = {}; updates['users/' + uid] = null; updates['directory/' + uid] = null;
        db.ref().update(updates).catch(function(err) { alert(err.message || 'Failed to delete user.'); });
      });
    });
  }

  // ── Positions popover ──

  var openPanel = null;
  function closePanel() { if (openPanel) { openPanel.remove(); openPanel = null; } }
  document.addEventListener('click', function(e) { if (openPanel && !openPanel.contains(e.target)) closePanel(); });

  function openPositions(uid, anchor) {
    closePanel();
    var u = users[uid] || {};
    var current = Object.assign({}, u.positions || {});
    var panel = document.createElement('div');
    panel.className = 'pos-panel';
    var groups = { officer: 'Officers', board: 'Boards', chair: 'Committee chairs' };
    var defs = C.sortByOrder(C.values(settings.positions));
    var html = '<strong>' + esc(u.name || '') + '</strong>';
    Object.keys(groups).forEach(function(g) {
      var list = defs.filter(function(d) { return (d.group || 'chair') === g; });
      if (!list.length) return;
      html += '<h5>' + groups[g] + '</h5>';
      list.forEach(function(d) {
        html += '<label><input type="checkbox" value="' + esc(d.key) + '"' + (current[d.key] ? ' checked' : '') + '> ' + esc(d.label) +
          (Object.keys(d.perms || {}).length ? ' <span class="access-cell">(' + Object.keys(d.perms).filter(function(k) { return d.perms[k]; }).join(', ') + ')</span>' : '') + '</label>';
      });
    });
    html += '<div style="margin-top:0.5rem; display:flex; gap:0.5rem;"><button type="button" class="btn btn-primary btn-small" id="pos-save" style="margin:0;">Save</button><button type="button" class="btn secondary btn-small" id="pos-cancel" style="margin:0;">Cancel</button></div>';
    panel.innerHTML = html;
    var rect = anchor.getBoundingClientRect();
    panel.style.top = (window.scrollY + rect.bottom + 4) + 'px';
    panel.style.left = Math.max(8, Math.min(window.scrollX + rect.left, window.innerWidth - 290)) + 'px';
    document.body.appendChild(panel);
    openPanel = panel;
    panel.querySelector('#pos-cancel').addEventListener('click', closePanel);
    panel.querySelector('#pos-save').addEventListener('click', function() {
      var positions = {};
      panel.querySelectorAll('input[type=checkbox]').forEach(function(cb) { if (cb.checked) positions[cb.value] = true; });
      PortalOps.saveUser(uid, { positions: positions }, me).then(closePanel).catch(function(err) { alert(err.message || 'Failed to save positions.'); });
    });
  }

  // ── Init ──

  function init() {
    PortalAuth.requireAdmin().then(function(profile) {
      if (!profile) return;
      me = profile;
      PortalAuth.initNav(profile);
      return PortalOps.loadSettings();
    }).then(function(s) {
      if (!s) return;
      settings = s;
      $('member-search').addEventListener('input', render);
      $('member-filter').addEventListener('change', render);
      $('btn-migrate').addEventListener('click', function() {
        var b = this; b.disabled = true; $('migrate-status').textContent = 'Upgrading…';
        PortalOps.migrateUsers(me).then(function(n) { $('migrate-status').textContent = 'Upgraded ' + n + ' records.'; })
          .catch(function(err) { b.disabled = false; $('migrate-status').textContent = 'Failed: ' + err.message; });
      });
      db.ref('users').on('value', function(snap) { users = snap.val() || {}; render(); });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(typeof window !== 'undefined' ? window : this);
