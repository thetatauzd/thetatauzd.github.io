/**
 * Admin panel: list all users, approve pending (set role to brother), change roles.
 * Only admin can access. Reads/writes Firebase users node.
 */
(function(global) {
  'use strict';

  var db = firebase.database();

  function renderUsers(users) {
    var tbody = document.getElementById('admin-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    var uids = Object.keys(users || {});
    uids.forEach(function(uid) {
      var u = users[uid];
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td>' + (u.name || '—') + '</td>' +
        '<td>' + (u.email || '—') + '</td>' +
        '<td>' + (u.rollNumber || '—') + '</td>' +
        '<td><select data-uid="' + uid + '" class="role-select">' +
        '<option value="pending"' + (u.role === 'pending' ? ' selected' : '') + '>pending</option>' +
        '<option value="brother"' + (u.role === 'brother' ? ' selected' : '') + '>brother</option>' +
        '<option value="regent"' + (u.role === 'regent' ? ' selected' : '') + '>regent</option>' +
        '<option value="standards"' + (u.role === 'standards' ? ' selected' : '') + '>standards</option>' +
        '<option value="admin"' + (u.role === 'admin' ? ' selected' : '') + '>admin</option>' +
        '</select></td>' +
        '<td>' +
        (u.role === 'pending' ? '<button type="button" class="btn btn-primary btn-approve" data-uid="' + uid + '" style="margin-right:0.25rem;">Approve</button>' : '') +
        '<button type="button" class="btn-delete-user" data-uid="' + uid + '" data-name="' + (u.name || u.email || uid) + '" style="background:#c62828;color:#fff;border:none;border-radius:4px;padding:0.3rem 0.6rem;font-size:0.8rem;cursor:pointer;">Delete</button>' +
        '</td>';
      tbody.appendChild(tr);
    });
    tbody.querySelectorAll('.role-select').forEach(function(sel) {
      sel.addEventListener('change', function() {
        var uid = this.getAttribute('data-uid');
        var role = this.value;
        db.ref('users/' + uid + '/role').set(role).catch(function(err) {
          alert(err.message || 'Failed to update role.');
        });
      });
    });
    tbody.querySelectorAll('.btn-delete-user').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var uid = this.getAttribute('data-uid');
        var name = this.getAttribute('data-name');
        if (!confirm('Delete user "' + name + '"? This cannot be undone.')) return;
        db.ref('users/' + uid).remove().catch(function(err) {
          alert(err.message || 'Failed to delete user.');
        });
      });
    });
    tbody.querySelectorAll('.btn-approve').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var uid = this.getAttribute('data-uid');
        db.ref('users/' + uid + '/role').set('brother').then(function() {
          btn.disabled = true;
          btn.textContent = 'Approved';
        }).catch(function(err) {
          alert(err.message || 'Failed to approve.');
        });
      });
    });
  }

  function init() {
    PortalAuth.requireAdmin().then(function(profile) {
      if (!profile) return;
      PortalAuth.initNav(profile);

      db.ref('users').on('value', function(snap) {
        renderUsers(snap.val());
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(typeof window !== 'undefined' ? window : this);
