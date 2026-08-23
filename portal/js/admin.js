/**
 * Admin panel: approve pending registrations, set roles, edit roll numbers.
 * Users are split into Pending / Exec / Brothers so the list stays readable
 * as the chapter grows. Only admin can access. Reads/writes the users node.
 */
(function(global) {
  'use strict';

  var db = firebase.database();

  // Every role the security rules and portal nav actually understand. Keep this
  // in sync with firebase-database.rules.json — regent and standards were missing
  // here for a while, which meant they could only be set in the Firebase console.
  var ROLES = [
    { value: 'pending',    label: 'pending' },
    { value: 'brother',    label: 'brother' },
    { value: 'rush_chair', label: 'rush chair' },
    { value: 'standards',  label: 'standards' },
    { value: 'regent',     label: 'regent' },
    { value: 'admin',      label: 'admin' }
  ];

  var EXEC_ROLES = ['admin', 'regent', 'standards', 'rush_chair'];

  function escapeHtml(str) {
    var d = document.createElement('div');
    d.textContent = str == null ? '' : String(str);
    return d.innerHTML;
  }

  function sectionOf(role) {
    if (role === 'pending') return 'pending';
    if (EXEC_ROLES.indexOf(role) !== -1) return 'exec';
    return 'brothers';
  }

  function roleSelect(uid, role) {
    return '<select data-uid="' + uid + '" class="role-select">' +
      ROLES.map(function(r) {
        return '<option value="' + r.value + '"' +
          (role === r.value ? ' selected' : '') + '>' + r.label + '</option>';
      }).join('') +
      '</select>';
  }

  function buildRow(uid, u) {
    var tr = document.createElement('tr');
    tr.innerHTML =
      '<td>' + escapeHtml(u.name || '—') + '</td>' +
      '<td>' + escapeHtml(u.email || '—') + '</td>' +
      '<td><input type="text" class="roll-input" data-uid="' + uid + '" value="' +
        escapeHtml(u.rollNumber || '') + '" placeholder="—"><span class="roll-saved hidden" data-for="' + uid + '">saved</span></td>' +
      '<td>' + roleSelect(uid, u.role) + '</td>' +
      '<td>' +
        (u.role === 'pending'
          ? '<button type="button" class="btn btn-primary btn-approve" data-uid="' + uid + '" style="margin-right:0.25rem;">Approve</button>'
          : '') +
        '<button type="button" class="btn-delete-user" data-uid="' + uid + '" data-name="' +
          escapeHtml(u.name || u.email || uid) +
          '" style="background:#c62828;color:#fff;border:none;border-radius:4px;padding:0.3rem 0.6rem;font-size:0.8rem;cursor:pointer;">Delete</button>' +
      '</td>';
    return tr;
  }

  function renderUsers(users) {
    var bodies = {
      pending: document.getElementById('tbody-pending'),
      exec: document.getElementById('tbody-exec'),
      brothers: document.getElementById('tbody-brothers')
    };
    if (!bodies.pending || !bodies.exec || !bodies.brothers) return;

    Object.keys(bodies).forEach(function(k) { bodies[k].innerHTML = ''; });

    var counts = { pending: 0, exec: 0, brothers: 0 };
    var uids = Object.keys(users || {}).sort(function(a, b) {
      var na = ((users[a] && users[a].name) || '').toLowerCase();
      var nb = ((users[b] && users[b].name) || '').toLowerCase();
      return na < nb ? -1 : na > nb ? 1 : 0;
    });

    uids.forEach(function(uid) {
      var u = users[uid] || {};
      var sec = sectionOf(u.role);
      counts[sec]++;
      bodies[sec].appendChild(buildRow(uid, u));
    });

    Object.keys(bodies).forEach(function(k) {
      var label = document.getElementById('count-' + k);
      if (label) label.textContent = '(' + counts[k] + ')';
      if (counts[k] === 0) {
        var tr = document.createElement('tr');
        tr.innerHTML = '<td colspan="5" class="section-empty">None</td>';
        bodies[k].appendChild(tr);
      }
    });

    // A pending section with nobody in it is just noise.
    var pendingCard = document.getElementById('card-pending');
    if (pendingCard) pendingCard.classList.toggle('hidden', counts.pending === 0);

    wireRowActions();
  }

  function wireRowActions() {
    document.querySelectorAll('.role-select').forEach(function(sel) {
      sel.addEventListener('change', function() {
        var uid = this.getAttribute('data-uid');
        db.ref('users/' + uid + '/role').set(this.value).catch(function(err) {
          alert(err.message || 'Failed to update role.');
        });
      });
    });

    document.querySelectorAll('.roll-input').forEach(function(input) {
      var uid = input.getAttribute('data-uid');
      var original = input.value;

      function save() {
        var val = input.value.trim();
        if (val === original) return;
        db.ref('users/' + uid + '/rollNumber').set(val).then(function() {
          original = val;
          var flag = document.querySelector('.roll-saved[data-for="' + uid + '"]');
          if (flag) {
            flag.classList.remove('hidden');
            setTimeout(function() { flag.classList.add('hidden'); }, 1500);
          }
        }).catch(function(err) {
          input.value = original;
          alert(err.message || 'Failed to save roll number.');
        });
      }

      input.addEventListener('blur', save);
      input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      });
    });

    document.querySelectorAll('.btn-approve').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var uid = this.getAttribute('data-uid');
        btn.disabled = true;
        db.ref('users/' + uid + '/role').set('brother').catch(function(err) {
          btn.disabled = false;
          alert(err.message || 'Failed to approve.');
        });
      });
    });

    document.querySelectorAll('.btn-delete-user').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var uid = this.getAttribute('data-uid');
        var name = this.getAttribute('data-name');
        if (!confirm('Delete user "' + name + '"? This cannot be undone.')) return;
        db.ref('users/' + uid).remove().catch(function(err) {
          alert(err.message || 'Failed to delete user.');
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
