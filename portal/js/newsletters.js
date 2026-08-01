/**
 * Newsletters admin: publish/list/delete chapter newsletters.
 * Only admin can access. Newsletters link out to a Google Drive file (no Firebase
 * Storage — keeps this project on the free Spark plan; see portal/README.md).
 * Metadata lives in Realtime Database under "newsletters" (public read).
 */
(function (global) {
  'use strict';

  var db = firebase.database();

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  function setStatus(message, type) {
    var el = document.getElementById('nl-status');
    if (!el) return;
    el.textContent = message || '';
    el.className = 'newsletter-form-status' + (type ? ' ' + type : '');
  }

  function renderNewsletters(newsletters) {
    var tbody = document.getElementById('newsletters-admin-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    var ids = Object.keys(newsletters || {}).sort(function (a, b) {
      return new Date(newsletters[b].date || 0) - new Date(newsletters[a].date || 0);
    });
    ids.forEach(function (id) {
      var item = newsletters[id];
      var tr = document.createElement('tr');
      var uploadedAt = item.uploadedAt ? new Date(item.uploadedAt).toLocaleDateString() : '—';
      tr.innerHTML =
        '<td>' + escapeHtml(item.title) + '</td>' +
        '<td>' + escapeHtml(item.date) + '</td>' +
        '<td>' + uploadedAt + '</td>' +
        '<td class="actions">' +
        '<a href="' + item.fileURL + '" target="_blank" rel="noopener" style="margin-right:0.5rem;">View</a>' +
        '<button type="button" class="btn-delete-newsletter" data-id="' + id + '" data-title="' + escapeHtml(item.title) + '">Delete</button>' +
        '</td>';
      tbody.appendChild(tr);
    });
    tbody.querySelectorAll('.btn-delete-newsletter').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = this.getAttribute('data-id');
        var title = this.getAttribute('data-title');
        if (!confirm('Delete "' + title + '"? This removes it from the public page immediately (the file itself stays in Drive — delete it there separately if you want it fully gone).')) return;
        db.ref('newsletters/' + id).remove().catch(function (err) {
          alert(err.message || 'Failed to delete newsletter.');
        });
      });
    });
  }

  function handlePublish(e) {
    e.preventDefault();
    var titleEl = document.getElementById('nl-title');
    var dateEl = document.getElementById('nl-date');
    var descEl = document.getElementById('nl-description');
    var linkEl = document.getElementById('nl-link');
    var submitBtn = document.getElementById('nl-submit');

    var title = titleEl.value.trim();
    var date = dateEl.value;
    var description = descEl.value.trim();
    var fileURL = linkEl.value.trim();

    if (!title || !date || !fileURL) {
      setStatus('Title, issue date, and a Drive link are all required.', 'error');
      return;
    }
    if (!/^https?:\/\//i.test(fileURL)) {
      setStatus('That doesn\'t look like a valid link — it should start with https://', 'error');
      return;
    }
    if (fileURL.indexOf('drive.google.com') === -1) {
      // Not a hard block — other hosts work fine too — just a nudge.
      if (!confirm('That link doesn\'t look like a Google Drive link. Publish it anyway?')) return;
    }

    submitBtn.disabled = true;
    setStatus('Publishing…');

    var profile = global.PortalAuth && global.PortalAuth.getAuth().currentUser;
    db.ref('newsletters').push({
      title: title,
      date: date,
      description: description,
      fileURL: fileURL,
      uploadedBy: (profile && profile.email) || '',
      uploadedAt: new Date().toISOString()
    })
      .then(function () {
        setStatus('Newsletter published.', 'success');
        document.getElementById('newsletter-form').reset();
      })
      .catch(function (err) {
        console.error('Newsletter publish failed', err);
        setStatus(err.message || 'Failed to publish. Please try again.', 'error');
      })
      .finally(function () {
        submitBtn.disabled = false;
      });
  }

  function init() {
    PortalAuth.requireAdmin().then(function (profile) {
      if (!profile) return;
      PortalAuth.initNav(profile);

      db.ref('newsletters').on('value', function (snap) {
        renderNewsletters(snap.val());
      });

      var form = document.getElementById('newsletter-form');
      if (form) form.addEventListener('submit', handlePublish);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(typeof window !== 'undefined' ? window : this);
