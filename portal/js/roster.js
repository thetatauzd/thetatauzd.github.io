/**
 * Chapter roll lookup, used to autofill sign-up.
 *
 * Talks to the roster Apps Script gateway (portal/apps-script/RosterGateway.gs),
 * which is bound to the brother list spreadsheet. A brother types their roll
 * number or their name and the other fills itself in, so roll numbers in the
 * portal match the chapter roll instead of being typed from memory.
 *
 * The gateway only ever returns a name and a roll number — never phone or email —
 * and only one exact match per call.
 *
 * Registration still creates a PENDING account: this makes sign-up accurate, it
 * does not grant access. An admin still approves.
 */
(function (global) {
  'use strict';

  var ROSTER_GATEWAY_URL = 'https://script.google.com/macros/s/AKfycbycpuIGNkqEf5wCsRiIHdrUtVJh_WDkBF-c-Dc5SKC0FOcWzpROykVoTVIp8VSDWnLd/exec';

  function isConfigured() {
    return !!ROSTER_GATEWAY_URL;
  }

  /**
   * Apps Script does not answer CORS preflight, so this goes out as a plain-text
   * body to stay a "simple" request. The gateway parses it as JSON.
   */
  function call(payload) {
    var user = firebase.auth().currentUser;
    if (!user) return Promise.reject(new Error('Sign in first.'));

    return user.getIdToken().then(function (idToken) {
      var body = JSON.stringify(Object.assign({ idToken: idToken, action: 'lookup' }, payload));
      return fetch(ROSTER_GATEWAY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: body
      });
    }).then(function (res) {
      return res.json();
    }).then(function (data) {
      if (!data || data.ok === false) {
        throw new Error((data && data.error) || 'Lookup failed.');
      }
      return data;
    });
  }

  function byRollNumber(rollNumber) {
    if (!isConfigured() || !String(rollNumber || '').trim()) {
      return Promise.resolve({ found: false });
    }
    return call({ rollNumber: rollNumber });
  }

  function byName(name) {
    if (!isConfigured() || !String(name || '').trim()) {
      return Promise.resolve({ found: false });
    }
    return call({ name: name });
  }

  /**
   * Wire two inputs together. Filling one looks up the other and fills it in,
   * but never overwrites something already typed — a brother who goes by a
   * different name than the roll lists keeps what they entered.
   */
  function attachAutofill(opts) {
    var nameInput = opts.nameInput;
    var rollInput = opts.rollInput;
    var statusEl = opts.statusEl;
    if (!nameInput || !rollInput || !isConfigured()) return;

    var busy = false;

    function say(msg, kind) {
      if (!statusEl) return;
      statusEl.textContent = msg || '';
      statusEl.style.color = kind === 'error' ? '#c62828'
        : (kind === 'ok' ? '#2e7d32' : '#666');
      statusEl.classList.toggle('hidden', !msg);
    }

    function norm(v) {
      return String(v || '').replace(/\s+/g, ' ').trim().toLowerCase();
    }

    function lookup(fromRoll) {
      if (busy) return;
      var query = fromRoll ? rollInput.value : nameInput.value;
      var target = fromRoll ? nameInput : rollInput;
      if (!String(query || '').trim()) return;

      busy = true;
      say('Checking the chapter roll…');

      (fromRoll ? byRollNumber(query) : byName(query))
        .then(function (res) {
          if (res.found) {
            var incoming = fromRoll ? res.name : res.rollNumber;
            var existing = String(target.value || '').trim();

            if (!existing) {
              target.value = incoming;
              say('Matched ' + res.name + ' (roll #' + res.rollNumber + ').', 'ok');
            } else if (norm(existing) === norm(incoming)) {
              say('Matched ' + res.name + ' (roll #' + res.rollNumber + ').', 'ok');
            } else {
              // Google pre-fills the name box, and a brother may go by something
              // other than what the roll lists. Say what the roll has rather than
              // overwriting what they typed.
              say('Roll #' + res.rollNumber + ' is listed as ' + res.name +
                  '. Keep what you entered if that is you.', 'ok');
            }
          } else if (res.ambiguous) {
            say('More than one brother has that name — enter your roll number instead.', 'error');
          } else {
            say(fromRoll
              ? "That roll number isn't on the chapter roll. Check it, or just type your name."
              : "Couldn't find that name on the roll. Enter your roll number instead.", 'error');
          }
        })
        .catch(function (err) {
          // Autofill is a convenience; never block someone from registering.
          console.warn('Roster lookup failed', err);
          say('');
        })
        .finally(function () { busy = false; });
    }

    rollInput.addEventListener('blur', function () { lookup(true); });
    nameInput.addEventListener('blur', function () { lookup(false); });
    rollInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); rollInput.blur(); }
    });
  }

  global.PortalRoster = {
    isConfigured: isConfigured,
    byRollNumber: byRollNumber,
    byName: byName,
    attachAutofill: attachAutofill
  };
})(typeof window !== 'undefined' ? window : this);
