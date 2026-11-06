/**
 * Newsletters admin: publish/list/delete chapter newsletters, and email the subscriber list.
 * Only admin can access. Newsletters link out to a Google Drive file (no Firebase
 * Storage — keeps this project on the free Spark plan; see portal/README.md).
 * Metadata lives in Realtime Database under "newsletters" (public read).
 *
 * Email subscribers: people sign up on the public Newsletters page. The list lives in a
 * chapter Google Sheet behind a small Apps Script (portal/apps-script), never in Firebase
 * or this repository. Its /exec address is window.NEWSLETTER_GATEWAY_URL, set in
 * js/newsletter-config.js (empty until the script is deployed). This page asks the script:
 *   status -> { active, unsubscribed, newSinceLastSend, quotaLeft, issues: { <newsletterId>: { sent, total } } }
 *   notify -> { sent, total, alreadySent, remaining, quotaLeft, done, failed }
 * with the admin's Firebase ID token; the script checks the role is admin. Gmail lets the
 * chapter account send about 100 emails a day, so notify sends what it can and remembers who
 * has the issue. Pressing the button again carries on where it stopped.
 */
(function (global) {
  'use strict';

  var db = firebase.database();

  var BUTTON_LABEL = 'Email subscribers';
  var DAILY_NOTE = '(Gmail lets the chapter account send about 100 a day)';
  // MAX_REFUSALS_IN_A_ROW in NewsletterGateway.gs: the script stops a press after this many
  // refusals with nothing sent between them, because then Gmail is refusing every email.
  var REFUSALS_IN_A_ROW = 5;
  var NOT_DEPLOYED = 'The newsletter email script is not deployed yet, so there is no list to email. ' +
    'Once it is, its address goes in js/newsletter-config.js.';

  var issues = {};        // the latest newsletters snapshot, by id
  var busy = {};          // id -> button label while checking or sending
  var notes = {};         // id -> { text, type }: the last result for that issue
  var lastStatus = null;  // the last status reply from the script
  var rowControls = {};   // id -> { btn, note } in the table
  var offer = null;       // { id, item, btn, note } under the publish form

  function setStatus(message, type) {
    var el = document.getElementById('nl-status');
    if (!el) return;
    el.textContent = message || '';
    el.className = 'newsletter-form-status' + (type ? ' ' + type : '');
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function num(v) {
    var n = Number(v);
    return isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  function plural(n, word) {
    return n === 1 ? word : word + 's';
  }

  // ── The newsletter script ──────────────────────────────────────────────────

  function gatewayUrl() {
    return String(global.NEWSLETTER_GATEWAY_URL || '').trim();
  }

  /** The script only emails https links to Google Drive or this site. Same check here, before asking. */
  function emailableLink(url) {
    return /^https:\/\/(drive\.google\.com|(www\.)?thetatauzd\.org)(\/|\?|#|$)/i.test(String(url || '').trim());
  }

  function gatewayError(message, code) {
    var err = new Error(message);
    err.code = code || 'error';
    return err;
  }

  /**
   * Apps Script does not answer CORS preflight requests, so this is a plain-text POST with a JSON
   * body (a "simple" request), the same as portal/js/tracker.js. Resolves with the reply when it
   * says ok: true, and rejects with a readable message otherwise.
   */
  function callGateway(payload) {
    var url = gatewayUrl();
    if (!url) return Promise.reject(gatewayError(NOT_DEPLOYED, 'not-deployed'));
    var user = firebase.auth().currentUser;
    if (!user) return Promise.reject(gatewayError('You are signed out. Sign in again.', 'signed-out'));
    return user.getIdToken().then(function (idToken) {
      var body = {};
      for (var k in payload) {
        if (Object.prototype.hasOwnProperty.call(payload, k)) body[k] = payload[k];
      }
      body.idToken = idToken;
      return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(body)
      }).then(null, function () {
        throw gatewayError('Could not reach the newsletter script. Check your connection and try again.', 'network');
      });
    }).then(function (res) {
      return res.json().then(null, function () {
        throw gatewayError('The newsletter script sent back something unexpected. It may need to be redeployed.', 'bad-reply');
      });
    }).then(function (data) {
      if (!data || data.ok !== true) {
        throw gatewayError((data && data.error) || 'The newsletter script turned that down.', data && data.code);
      }
      return data;
    });
  }

  // ── Summary line ───────────────────────────────────────────────────────────

  function setSummary(text, type) {
    var box = document.getElementById('nl-subscribers-summary');
    if (!box) return;
    box.textContent = text;
    box.className = 'nl-subscribers-summary' + (type ? ' ' + type : '');
  }

  /** True once any issue has been emailed, so "new since the last email" means something. */
  function hasSent(s) {
    return !!(s && s.issues && Object.keys(s.issues).length);
  }

  function summaryText(s) {
    var active = num(s.active);
    var unsub = num(s.unsubscribed);
    var quota = num(s.quotaLeft);
    var fresh = num(s.newSinceLastSend);
    return active + ' active ' + plural(active, 'subscriber') + '. ' +
      unsub + ' unsubscribed. ' +
      (hasSent(s) && fresh ? fresh + ' signed up since the last email. ' : '') +
      'Gmail can send ' + quota + ' more ' + plural(quota, 'email') + ' today.';
  }

  function applyStatus(s) {
    lastStatus = s;
    setSummary(summaryText(s), '');
    Object.keys(issues).forEach(paintIssue);
    if (offer) paintIssue(offer.id);
  }

  function loadStatus() {
    if (!gatewayUrl()) {
      setSummary(NOT_DEPLOYED, 'muted');
      return Promise.resolve(null);
    }
    return callGateway({ action: 'status' }).then(function (s) {
      applyStatus(s);
      return s;
    }, function (err) {
      setSummary('Could not load the subscriber list. ' + err.message, 'error');
      return null;
    });
  }

  // ── Per-issue button and note ──────────────────────────────────────────────

  /** How many active subscribers do not have this issue yet, by the last status reply. */
  function pendingFor(s, id) {
    var active = num(s.active);
    var issue = s.issues && s.issues[id];
    if (!issue) return active;
    var total = issue.total === undefined || issue.total === null ? active : num(issue.total);
    return Math.max(0, total - num(issue.sent));
  }

  function countNote(id) {
    var issue = lastStatus && lastStatus.issues && lastStatus.issues[id];
    if (!issue || !num(issue.sent)) return null;
    var sent = num(issue.sent);
    if (issue.total === undefined || issue.total === null) return { text: 'Emailed to ' + sent + '.', type: '' };
    return { text: 'Emailed to ' + sent + ' of ' + num(issue.total) + '.', type: '' };
  }

  function controlsFor(id) {
    var list = [];
    if (rowControls[id]) list.push(rowControls[id]);
    if (offer && offer.id === id) list.push(offer);
    return list;
  }

  function paintIssue(id) {
    var label = busy[id];
    var note = notes[id] || countNote(id);
    controlsFor(id).forEach(function (c) {
      c.btn.disabled = !!label;
      c.btn.textContent = label || BUTTON_LABEL;
      c.note.textContent = note ? note.text : '';
      c.note.className = 'nl-mail-note' + (note && note.type ? ' ' + note.type : '');
    });
  }

  function setBusy(id, label) {
    if (label) busy[id] = label; else delete busy[id];
    paintIssue(id);
  }

  function setNote(id, text, type) {
    if (text) notes[id] = { text: text, type: type || '' }; else delete notes[id];
    paintIssue(id);
  }

  function stillToGo(remaining, quotaLeft) {
    if (quotaLeft > 0) return remaining + ' still to go: press again to send the rest.';
    return remaining + ' still to go: press again tomorrow ' + DAILY_NOTE + '.';
  }

  /** Every address still to go was refused, so pressing again would only be refused again. */
  function fixRefused(n, quotaLeft) {
    var one = n === 1;
    return 'Gmail turned down ' + (one ? 'the 1 address' : 'the ' + n + ' addresses') + ' still to go. ' +
      'Fix ' + (one ? 'it' : 'them') + ' in the Subscribers tab (the Apps Script log names the ' + (one ? 'row' : 'rows') + '), ' +
      'or set ' + (one ? 'its' : 'their') + ' status to removed, then press again' +
      (quotaLeft > 0 ? '.' : ' tomorrow ' + DAILY_NOTE + '.');
  }

  function resultText(r) {
    var sent = num(r.sent);
    var remaining = num(r.remaining);
    var failed = num(r.failed);
    var quotaLeft = num(r.quotaLeft);
    // badAddresses (version 2 of the script): refusals whose error named the address, so the row
    // is at fault. The rest of failed is Gmail refusing everything. An older script does not send
    // it; then the counts are the only clue.
    var known = r.badAddresses !== undefined && r.badAddresses !== null;
    var bad = known ? Math.min(num(r.badAddresses), failed) : failed;
    var gmail = known ? failed - bad : 0;
    // Addresses Gmail refused stay on the list and are tried again on the next press.
    var refused = bad ? ' Gmail turned down ' + bad + ' ' + (bad === 1 ? 'address' : 'addresses') +
      ': check the Subscribers tab for typos (the Apps Script log names the rows).' : '';
    if (r.done) return sent > 0 ? 'Sent ' + sent + '. Everyone has it.' : 'Everyone has it.';
    if (!remaining) return 'Sent ' + sent + '. Press again to make sure everyone has it.' + refused;
    // Every address still to go was refused as a bad address: fixing those rows is the way on.
    // Without badAddresses, that is the likely reading only when some email went out or fewer than
    // REFUSALS_IN_A_ROW were refused (nothing sent and that many refused means Gmail refused them all).
    var onlyBadLeft = known ? (bad > 0 && remaining <= bad && !gmail)
      : (failed > 0 && remaining <= failed && (sent > 0 || failed < REFUSALS_IN_A_ROW));
    if (onlyBadLeft) return (sent ? 'Sent ' + sent + '. ' : 'Nothing sent. ') + fixRefused(remaining, quotaLeft);
    if (!sent && !quotaLeft) return 'Nothing sent. Today\'s Gmail limit is used up. ' + stillToGo(remaining, 0);
    // Quota left but Gmail refused sends that were not about one address (its limit can run out
    // before the number it reports does, or the account is restricted), so the press stopped.
    if (!sent || gmail) {
      return (sent ? 'Sent ' + sent + ', then Gmail stopped taking emails.' : 'Nothing sent: Gmail is not taking emails right now.') + refused + ' ' +
        remaining + ' still to go: try again in a while, or tomorrow ' + DAILY_NOTE + '.';
    }
    return 'Sent ' + sent + '.' + refused + ' ' + stillToGo(remaining, quotaLeft);
  }

  /**
   * Check the list, confirm with the admin, then ask the script to email this issue.
   * item is { title, fileURL } for newsletters/{id}. Resolves when the button is free again.
   */
  function emailSubscribers(id, item) {
    if (busy[id]) return Promise.resolve();
    if (!gatewayUrl()) {
      setNote(id, NOT_DEPLOYED, 'error');
      return Promise.resolve();
    }
    if (!item || !emailableLink(item.fileURL)) {
      setNote(id, 'This issue\'s link is not an https Google Drive or thetatauzd.org link, so it cannot be emailed. ' +
        'Delete it and publish it again with a Google Drive link.', 'error');
      return Promise.resolve();
    }
    var title = String(item.title || 'this newsletter');
    setNote(id, null);
    setBusy(id, 'Checking...');
    return callGateway({ action: 'status' }).then(function (s) {
      applyStatus(s);
      var active = num(s.active);
      var pending = pendingFor(s, id);
      var quota = num(s.quotaLeft);
      if (!active) { setNote(id, 'No one has subscribed yet.', ''); return; }
      if (!pending) { setNote(id, 'Everyone has it.', 'success'); return; }
      if (!quota) {
        setNote(id, 'Today\'s Gmail limit is used up. ' + stillToGo(pending, 0), '');
        return;
      }
      var question = 'Email ' + pending + ' ' + plural(pending, 'subscriber') + ' about ' + title + '?';
      var fresh = num(s.newSinceLastSend);
      if (hasSent(s) && fresh) {
        question += '\n\n' + fresh + ' ' + (fresh === 1 ? 'person' : 'people') + ' signed up since the last email. ' +
          'If that looks too high, check the Subscribers tab for fake sign-ups first.';
      }
      if (pending > quota) {
        question += '\n\nGmail lets the chapter account send ' + quota + ' more today. ' +
          'The rest go out when you press again tomorrow.';
      }
      if (!global.confirm(question)) return;
      setBusy(id, 'Sending...');
      return callGateway({
        action: 'notify',
        newsletterId: id,
        title: String(item.title || ''),
        url: String(item.fileURL || '').trim()
      }).then(function (r) {
        setNote(id, resultText(r), r.done ? 'success' : '');
        return loadStatus();
      });
    }).then(null, function (err) {
      setNote(id, 'Could not email subscribers. ' + err.message, 'error');
    }).then(function () {
      setBusy(id, null);
    });
  }

  function makeEmailButton(id, getItem) {
    var btn = el('button', 'btn-email-subscribers', BUTTON_LABEL);
    btn.type = 'button';
    btn.setAttribute('data-email-id', id);
    btn.addEventListener('click', function () {
      emailSubscribers(id, getItem());
    });
    return btn;
  }

  // ── After publishing: offer the button for the new issue ───────────────────

  function hideOffer() {
    var box = document.getElementById('nl-notify-offer');
    offer = null;
    if (!box) return;
    box.innerHTML = '';
    box.className = 'nl-notify-offer hidden';
  }

  function showOffer(id, item) {
    var box = document.getElementById('nl-notify-offer');
    if (!box || !id) return;
    box.innerHTML = '';
    box.className = 'nl-notify-offer';
    var btn = makeEmailButton(id, function () { return issues[id] || item; });
    var note = el('div', 'nl-mail-note');
    box.appendChild(el('p', 'nl-offer-text', 'Let the email list know about this issue.'));
    box.appendChild(btn);
    box.appendChild(note);
    offer = { id: id, item: item, btn: btn, note: note };
    paintIssue(id);
  }

  // ── The table ──────────────────────────────────────────────────────────────

  function renderNewsletters(newsletters) {
    var tbody = document.getElementById('newsletters-admin-tbody');
    issues = newsletters || {};
    rowControls = {};
    if (!tbody) return;
    tbody.innerHTML = '';
    var ids = Object.keys(issues).sort(function (a, b) {
      return new Date(issues[b].date || 0) - new Date(issues[a].date || 0);
    });
    ids.forEach(function (id) {
      var item = issues[id];
      var tr = document.createElement('tr');
      var uploadedAt = item.uploadedAt ? new Date(item.uploadedAt).toLocaleDateString() : '—';

      var titleTd = el('td');
      titleTd.appendChild(document.createTextNode(item.title || ''));
      var note = el('div', 'nl-mail-note');
      titleTd.appendChild(note);
      tr.appendChild(titleTd);
      tr.appendChild(el('td', '', item.date || ''));
      tr.appendChild(el('td', '', uploadedAt));

      var actions = el('td', 'actions');
      var view = el('a', '', 'View');
      view.href = item.fileURL || '';
      view.target = '_blank';
      view.rel = 'noopener';
      view.style.marginRight = '0.5rem';
      actions.appendChild(view);

      var btn = makeEmailButton(id, function () { return issues[id]; });
      actions.appendChild(btn);

      var del = el('button', 'btn-delete-newsletter', 'Delete');
      del.type = 'button';
      del.setAttribute('data-id', id);
      del.setAttribute('data-title', item.title || '');
      del.addEventListener('click', function () {
        var title = this.getAttribute('data-title');
        if (!confirm('Delete "' + title + '"? This removes it from the public page immediately (the file itself stays in Drive; delete it there separately if you want it fully gone).')) return;
        db.ref('newsletters/' + id).remove().catch(function (err) {
          alert(err.message || 'Failed to delete newsletter.');
        });
      });
      actions.appendChild(del);
      tr.appendChild(actions);
      tbody.appendChild(tr);

      rowControls[id] = { btn: btn, note: note };
      paintIssue(id);
    });
  }

  // ── Publish ────────────────────────────────────────────────────────────────

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
      setStatus('That doesn\'t look like a valid link. It should start with https://', 'error');
      return;
    }
    if (fileURL.indexOf('drive.google.com') === -1) {
      // Not a hard block, other hosts work fine too. Just a nudge.
      if (!confirm('That link doesn\'t look like a Google Drive link. Publish it anyway?')) return;
    }

    submitBtn.disabled = true;
    setStatus('Publishing…');
    hideOffer();

    var profile = global.PortalAuth && global.PortalAuth.getAuth().currentUser;
    var record = {
      title: title,
      date: date,
      description: description,
      fileURL: fileURL,
      uploadedBy: (profile && profile.email) || '',
      uploadedAt: new Date().toISOString()
    };
    var newRef = db.ref('newsletters').push(record);
    newRef
      .then(function () {
        setStatus('Newsletter published.', 'success');
        document.getElementById('newsletter-form').reset();
        showOffer(newRef.key, record);
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

      loadStatus();
    });
  }

  // For scripts/newsletters-admin-tests.js.
  global.PortalNewsletters = {
    emailSubscribers: emailSubscribers,
    loadStatus: loadStatus,
    emailableLink: emailableLink,
    resultText: resultText,
    summaryText: summaryText
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(typeof window !== 'undefined' ? window : this);
