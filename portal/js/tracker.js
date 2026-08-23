/**
 * Theta Tau Tracker client.
 *
 * Talks to the Apps Script gateway (portal/apps-script/Code.gs), which reads the
 * Tracker spreadsheet and returns ONLY the signed-in brother's own row. The
 * brother's Firebase ID token is what proves who they are; the gateway hands it
 * to the Realtime Database, so the database rules do the verifying.
 *
 * Set GATEWAY_URL below to the /exec URL from the Apps Script deployment.
 */
(function (global) {
  'use strict';

  // Paste the Apps Script web-app /exec URL here.
  var GATEWAY_URL = '';

  var cached = null;

  function isConfigured() {
    return !!GATEWAY_URL;
  }

  function money(n) {
    var v = Number(n) || 0;
    return '$' + v.toFixed(2).replace(/\.00$/, '');
  }

  /**
   * Apps Script does not answer CORS preflight requests, so this is sent as a
   * plain-text body to keep it a "simple" request. The gateway parses it as JSON.
   */
  function callGateway(payload) {
    return firebase.auth().currentUser.getIdToken().then(function (idToken) {
      var body = JSON.stringify(Object.assign({ idToken: idToken }, payload || {}));
      return fetch(GATEWAY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: body
      });
    }).then(function (res) {
      return res.json();
    }).then(function (data) {
      if (!data || data.ok === false) {
        throw new Error((data && data.error) || 'Tracker is unavailable.');
      }
      return data;
    });
  }

  function load(force) {
    if (cached && !force) return Promise.resolve(cached);
    if (!isConfigured()) {
      return Promise.reject(new Error('Tracker is not connected yet.'));
    }
    return callGateway({ action: 'me' }).then(function (data) {
      cached = data;
      return data;
    });
  }

  /** Look up a name from a roll number during sign-up. */
  function lookupRoll(rollNumber) {
    if (!isConfigured()) return Promise.resolve({ found: false });
    return callGateway({ action: 'lookupRoll', rollNumber: rollNumber });
  }

  // ── Portal home tiles ──────────────────────────────────────────────────────

  function renderHomeStats() {
    var grid = document.getElementById('stat-grid');
    var status = document.getElementById('stat-status');
    if (!grid || !status) return;

    if (!isConfigured()) {
      status.textContent = 'Theta Tau Tracker is not connected yet.';
      return;
    }

    status.textContent = 'Loading your tracker…';

    load().then(function (data) {
      var balance = data.payments.balanceDue;
      setTile('stat-balance', money(balance), balance > 0 ? 'stat-owing' : 'stat-clear');
      setTile('stat-demerits', String(data.demerits.summary.total));

      var svc = document.getElementById('stat-service');
      if (svc) {
        if (data.serviceHours && data.serviceHours.available) {
          setTile('stat-service', String(data.serviceHours.confirmed));
        } else {
          svc.classList.add('hidden');   // no Service_Hours tab yet
        }
      }

      grid.classList.remove('hidden');
      status.innerHTML = '<a href="tracker">See full tracker →</a>';
    }).catch(function (err) {
      status.textContent = err.message || 'Could not load your tracker.';
    });
  }

  function setTile(id, value, cls) {
    var tile = document.getElementById(id);
    if (!tile) return;
    var el = tile.querySelector('.stat-value');
    if (el) el.textContent = value;
    tile.classList.remove('stat-owing', 'stat-clear');
    if (cls) tile.classList.add(cls);
  }

  // ── Tracker page ───────────────────────────────────────────────────────────

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function renderTrackerPage() {
    var status = document.getElementById('tracker-status');
    var body = document.getElementById('tracker-body');
    if (!status || !body) return;

    if (!isConfigured()) {
      status.textContent = 'The Theta Tau Tracker has not been connected yet. ' +
        'An admin needs to deploy the Apps Script gateway and paste its URL into portal/js/tracker.js.';
      return;
    }

    status.textContent = 'Loading…';

    load(true).then(function (data) {
      status.textContent = '';
      body.classList.remove('hidden');
      renderPayments(data.payments);
      renderDemerits(data.demerits);
      renderService(data.serviceHours);
    }).catch(function (err) {
      status.textContent = err.message || 'Could not load your tracker.';
    });
  }

  function renderPayments(p) {
    var el = document.getElementById('pay-summary');
    if (el) {
      el.innerHTML =
        '<div class="stat-tile ' + (p.balanceDue > 0 ? 'stat-owing' : 'stat-clear') + '">' +
          '<span class="stat-label">Balance due</span>' +
          '<span class="stat-value">' + money(p.balanceDue) + '</span></div>' +
        '<div class="stat-tile"><span class="stat-label">Paid to date</span>' +
          '<span class="stat-value">' + money(p.totalPaid) + '</span></div>';
    }

    var tbody = document.getElementById('pay-tbody');
    if (!tbody) return;
    if (!p.items.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="section-empty">Nothing charged to you yet.</td></tr>';
      return;
    }
    tbody.innerHTML = p.items.map(function (i) {
      var waived = /^waived$/i.test(i.status || '');
      var cls = i.paid ? 'is-paid' : (waived ? 'is-waived' : 'is-unpaid');
      return '<tr class="' + (i.paid || waived ? 'row-paid' : 'row-owing') + '">' +
        '<td>' + esc(i.item || '—') + '</td>' +
        '<td>' + money(i.amount) + '</td>' +
        '<td><span class="pay-status ' + cls + '">' + esc(i.status) + '</span></td>' +
        '<td>' + esc(i.dueDate || '—') + '</td>' +
        '<td>' + esc(i.datePaid || '—') + '</td>' +
      '</tr>';
    }).join('');
  }

  function renderDemerits(d) {
    var s = d.summary;
    var el = document.getElementById('dem-summary');
    if (el) {
      var parts = [
        ['Total', s.total],
        ['Rollover', s.rollover],
        ['Attendance', s.attendance],
        ['Payments', s.payment],
        ['Standards', s.standards]
      ];
      el.innerHTML = parts.map(function (p) {
        return '<div class="stat-tile"><span class="stat-label">' + esc(p[0]) + '</span>' +
               '<span class="stat-value">' + (Number(p[1]) || 0) + '</span></div>';
      }).join('');
    }

    var tbody = document.getElementById('dem-tbody');
    if (!tbody) return;
    if (!d.adjustments.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="section-empty">No standards adjustments on record.</td></tr>';
      return;
    }
    tbody.innerHTML = d.adjustments.map(function (a) {
      return '<tr>' +
        '<td>' + esc(a.date || '—') + '</td>' +
        '<td>' + esc(a.reason || '—') + '</td>' +
        '<td>' + (a.change > 0 ? '+' : '') + (Number(a.change) || 0) + '</td>' +
        '<td>' + esc(a.enteredBy || '—') + '</td>' +
      '</tr>';
    }).join('');
  }

  function renderService(sv) {
    var card = document.getElementById('card-service');
    if (!card) return;
    if (!sv || !sv.available) { card.classList.add('hidden'); return; }
    card.classList.remove('hidden');

    var total = document.getElementById('svc-total');
    if (total) total.textContent = sv.confirmed;

    var tbody = document.getElementById('svc-tbody');
    if (!tbody) return;
    tbody.innerHTML = sv.entries.length
      ? sv.entries.map(function (e) {
          return '<tr><td>' + esc(e.event || '—') + '</td><td>' + esc(e.date || '—') +
                 '</td><td>' + (Number(e.hours) || 0) + '</td><td>' +
                 (e.confirmed ? 'Confirmed' : 'Pending') + '</td></tr>';
        }).join('')
      : '<tr><td colspan="4" class="section-empty">No service hours logged yet.</td></tr>';
  }

  global.PortalTracker = {
    isConfigured: isConfigured,
    load: load,
    lookupRoll: lookupRoll,
    renderHomeStats: renderHomeStats,
    renderTrackerPage: renderTrackerPage
  };
})(typeof window !== 'undefined' ? window : this);
