/*
 * newsletter-signup.js: "Get the next issue by email" and the unsubscribe link on newsletter.html.
 *
 * It talks to the newsletter Apps Script at window.NEWSLETTER_GATEWAY_URL (js/newsletter-config.js).
 * Requests are a POST with a text/plain body holding JSON, so the browser sends no CORS preflight
 * (Apps Script cannot answer one). Replies are JSON: { ok: true, ... } or { ok: false, code, error }.
 *
 * - URL not set (''): the form stays hidden and the page keeps its mailto line. That line is also
 *   what shows when JavaScript is off.
 * - ?unsubscribe=<token>: shows an Unsubscribe button under the hero. Pressing it sends
 *   { action: 'unsubscribe', token } and shows the result. Once the answer is final (unsubscribed,
 *   already, or a link that does not work) the token is dropped from the address bar. While the
 *   message offers Try again (network, busy, server error, a reply that is not ours) it stays, so a
 *   reload still shows the Unsubscribe button.
 *   Nothing is sent on page load, because mail filters open links in emails to scan them.
 *   The token is never logged or stored.
 *
 * The pure parts (URL check, email check, request body, reply -> message, query string helpers) are
 * exported as window.NewsletterSignup for scripts/newsletter-signup-tests.js. Plain ES5 in an IIFE.
 */
(function (global) {
  'use strict';

  var CONTACT = 'sotheta@mailbox.sc.edu';
  var NAME_MAX = 80;
  var EMAIL_MAX = 254;
  var TIMEOUT_MS = 25000;  // Apps Script can take several seconds to wake up

  // ── Pure helpers (tested in node) ──────────────────────────────────────────

  function str(v) { return v === null || v === undefined ? '' : String(v); }
  function trim(v) { return str(v).replace(/^\s+|\s+$/g, ''); }

  /** Only a plain https URL turns the form on. '' (not deployed yet) or anything else keeps the fallback. */
  function isConfigured(url) {
    return typeof url === 'string' && /^https:\/\/[^\s"'<>]+$/.test(trim(url));
  }

  /** Which block the sign-up section shows: 'form' or 'fallback' (the mailto line). */
  function initialView(url) {
    return isConfigured(url) ? 'form' : 'fallback';
  }

  function normalizeEmail(v) {
    return trim(v).toLowerCase();
  }

  // Loose on purpose: something before one @, a dotted domain after it, no spaces or brackets.
  // The gateway has the final say and answers invalid-email for anything it refuses.
  var EMAIL_RE = /^[^\s@<>()\[\]\\,;:"]+@[^\s@<>()\[\]\\,;:"]+\.[^\s@<>()\[\]\\,;:".]{2,}$/;

  function isValidEmail(v) {
    var e = normalizeEmail(v);
    if (!e || e.length > EMAIL_MAX || !EMAIL_RE.test(e)) return false;
    var domain = e.slice(e.indexOf('@') + 1);
    return domain.indexOf('..') === -1 && domain.charAt(0) !== '.' && domain.charAt(0) !== '-';
  }

  function cleanName(v) {
    return trim(str(v).replace(/\s+/g, ' ')).slice(0, NAME_MAX);
  }

  /** The subscribe request body. website is the honeypot and is sent exactly as typed. */
  function subscribePayload(fields) {
    fields = fields || {};
    return {
      action: 'subscribe',
      email: normalizeEmail(fields.email),
      name: cleanName(fields.name),
      website: str(fields.website),
      source: 'newsletter-page'
    };
  }

  /** Tokens come from the gateway. Accept the URL-safe and base64 alphabets; anything else is a broken link. */
  function validToken(t) {
    return typeof t === 'string' && /^[A-Za-z0-9._~+\/=-]{8,256}$/.test(t);
  }

  // A message is { kind: 'ok' | 'error' | 'pending' | 'ask', title?, text, field?, retry?, confirm?, resubscribe?, mailto? }.
  // mailto: { before, after } puts a link to the chapter email between the two strings.
  // confirm: the label of a button that does the action (retry: a 'Try again' button that repeats it).
  var MAIL_JOIN = { before: 'Or email ', after: ' to get on the list.' };
  var MAIL_LEAVE = { before: 'Or email ', after: " and we'll take you off the list." };

  function subscribeMessage(reply) {
    if (reply && reply.ok === true) {
      if (reply.status === 'already') return { kind: 'ok', text: "You're already on the list." };
      if (reply.status === 'resubscribed') {
        return { kind: 'ok', text: "You're back on the list. We'll email you when the next issue is posted." };
      }
      if (reply.status === 'held') {
        // An officer took this address off the list, so the form cannot put it back.
        return { kind: 'error', text: "That address can't be added from this page.", mailto: { before: 'Email ', after: ' to get back on the list.' } };
      }
      return { kind: 'ok', text: "You're on the list. We'll email you when the next issue is posted." };
    }
    var code = reply && reply.code;
    if (code === 'invalid-email') {
      return { kind: 'error', field: 'email', text: 'Please enter a valid email address, like name@example.com.' };
    }
    if (code === 'rate-limited') {
      return { kind: 'error', text: 'Too many sign-ups right now. Please try again later.', mailto: MAIL_JOIN };
    }
    if (code === 'network') {
      return { kind: 'error', text: "We couldn't reach the sign-up list. Check your connection and try again.", mailto: MAIL_JOIN };
    }
    // 'bot', an unknown code or a reply that is not ours: say as little as possible.
    return { kind: 'error', text: "Something went wrong, so you're not on the list yet. Please try again.", mailto: MAIL_JOIN };
  }

  /** Shown first for an unsubscribe link: nothing is sent until the person presses the button. */
  var CONFIRM_UNSUBSCRIBE = {
    kind: 'ask',
    title: 'Unsubscribe from newsletter emails?',
    text: "Press Unsubscribe and we'll stop emailing you about new issues.",
    confirm: 'Unsubscribe'
  };

  function unsubscribeMessage(reply) {
    if (reply && reply.ok === true) {
      if (reply.status === 'already') {
        return { kind: 'ok', title: "You're already unsubscribed.", text: "You won't get any more newsletter emails from us.", resubscribe: true };
      }
      return { kind: 'ok', title: "You're unsubscribed.", text: "You won't get any more newsletter emails from us.", resubscribe: true };
    }
    var code = reply && reply.code;
    if (code === 'unknown-token') {
      return { kind: 'error', title: "That unsubscribe link didn't work.", text: 'It may be old or cut short.', mailto: MAIL_LEAVE };
    }
    if (code === 'not-configured') {
      return { kind: 'error', title: "We can't unsubscribe you from this page yet.",
        text: '', mailto: { before: 'Email ', after: " and we'll take you off the list." } };
    }
    if (code === 'network') {
      return { kind: 'error', title: "We couldn't reach the list.", text: "You're not unsubscribed yet. Check your connection and try again.",
        retry: true, mailto: MAIL_LEAVE };
    }
    return { kind: 'error', title: 'Something went wrong.', text: "You're not unsubscribed yet. Please try again.", retry: true, mailto: MAIL_LEAVE };
  }

  function safeDecode(s) {
    try { return decodeURIComponent(s); } catch (e) { return s; }
  }

  // '+' is left as '+' (not a space): a base64 token may contain it, and no token contains a space.
  function splitQuery(search) {
    var q = str(search).replace(/^\?/, '');
    return q ? q.split('&') : [];
  }
  function keyOf(part) {
    var eq = part.indexOf('=');
    return safeDecode(eq === -1 ? part : part.slice(0, eq));
  }

  /** Value of one query parameter: null when absent, '' when present with no value. */
  function readParam(search, name) {
    var parts = splitQuery(search);
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i] || keyOf(parts[i]) !== name) continue;
      var eq = parts[i].indexOf('=');
      return eq === -1 ? '' : safeDecode(parts[i].slice(eq + 1));
    }
    return null;
  }

  /** The query string without any copy of one parameter: '' or '?a=1&b=2'. */
  function stripParam(search, name) {
    var parts = splitQuery(search), kept = [];
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] && keyOf(parts[i]) !== name) kept.push(parts[i]);
    }
    return kept.length ? '?' + kept.join('&') : '';
  }

  // ── Transport ──────────────────────────────────────────────────────────────

  /** Always resolves, never rejects: a gateway reply, or { ok: false, code: 'network' | 'bad-reply' }. */
  function post(url, payload) {
    return new Promise(function (resolve) {
      var settled = false;
      function finish(reply) { if (!settled) { settled = true; clearTimeout(timer); resolve(reply); } }
      var timer = setTimeout(function () { finish({ ok: false, code: 'network' }); }, TIMEOUT_MS);
      if (typeof global.fetch !== 'function') { finish({ ok: false, code: 'network' }); return; }
      global.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload)
      }).then(function (res) {
        return res.json().then(function (data) {
          finish(data && typeof data === 'object' ? data : { ok: false, code: 'bad-reply' });
        }, function () {
          finish({ ok: false, code: 'bad-reply' });
        });
      }, function () {
        finish({ ok: false, code: 'network' });
      });
    });
  }

  // ── Page wiring ────────────────────────────────────────────────────────────

  function make(tag, className, text) {
    var n = document.createElement(tag);
    if (className) n.className = className;
    if (text) n.textContent = text;
    return n;
  }

  function mailLink() {
    var a = make('a', '', CONTACT);
    a.href = 'mailto:' + CONTACT + '?subject=' + encodeURIComponent('Newsletter email list');
    return a;
  }

  /** Builds one message box from the message object. Text only goes in through textContent. */
  function renderMessage(box, msg, baseClass, onAction) {
    box.innerHTML = '';
    if (!msg) return;
    var wrap = make('div', baseClass + ' ' + baseClass + '--' + msg.kind);
    var p = make('p');
    if (msg.title) p.appendChild(make('strong', '', msg.title));
    if (msg.text) p.appendChild(document.createTextNode((msg.title ? ' ' : '') + msg.text));
    if (p.firstChild) wrap.appendChild(p);
    if (msg.mailto) {
      var m = make('p');
      m.appendChild(document.createTextNode(msg.mailto.before));
      m.appendChild(mailLink());
      m.appendChild(document.createTextNode(msg.mailto.after));
      wrap.appendChild(m);
    }
    if (msg.resubscribe) {
      var r = make('p'), a = make('a', '', 'Changed your mind? Sign up again.');
      a.href = '#subscribe';
      r.appendChild(a);
      wrap.appendChild(r);
    }
    var label = msg.confirm || (msg.retry ? 'Try again' : '');
    if (label && onAction) {
      var b = make('button', (msg.confirm ? 'btn-primary' : 'btn-secondary') + ' signup-retry', label);
      b.type = 'button';
      b.addEventListener('click', onAction);
      wrap.appendChild(b);
    }
    box.appendChild(wrap);
  }

  function setupForm(url) {
    var form = document.getElementById('signup-form');
    var fallback = document.getElementById('signup-fallback');
    var status = document.getElementById('signup-status');
    if (!form || !status) return;
    if (initialView(url) !== 'form') return;  // keep the mailto line

    var emailEl = document.getElementById('signup-email');
    var nameEl = document.getElementById('signup-name');
    var hpEl = document.getElementById('signup-website');  // honeypot: people never see or fill it
    if (!emailEl) return;
    var button = form.querySelector('button[type="submit"]');
    var idleLabel = button ? button.textContent : '';
    var busy = false;

    form.hidden = false;
    if (fallback) fallback.hidden = true;

    function setBusy(on) {
      busy = on;
      if (!button) return;
      button.disabled = on;
      button.textContent = on ? 'Subscribing\u2026' : idleLabel;
    }
    function markEmail(bad) {
      if (bad) emailEl.setAttribute('aria-invalid', 'true');
      else emailEl.removeAttribute('aria-invalid');
    }

    emailEl.addEventListener('input', function () { markEmail(false); });

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (busy) return;
      var payload = subscribePayload({ email: emailEl.value, name: nameEl ? nameEl.value : '', website: hpEl ? hpEl.value : '' });
      if (!isValidEmail(payload.email)) {
        markEmail(true);
        renderMessage(status, subscribeMessage({ ok: false, code: 'invalid-email' }), 'signup-msg');
        emailEl.focus();
        return;
      }
      markEmail(false);
      setBusy(true);
      renderMessage(status, { kind: 'pending', text: 'Signing you up\u2026' }, 'signup-msg');
      post(url, payload).then(function (reply) {
        setBusy(false);
        var msg = subscribeMessage(reply);
        renderMessage(status, msg, 'signup-msg');
        if (msg.kind === 'ok') {
          form.reset();
        } else if (msg.field === 'email') {
          markEmail(true);
          emailEl.focus();
        }
      });
    });
  }

  function dropTokenFromAddressBar() {
    try {
      var loc = global.location;
      global.history.replaceState(global.history.state, '', loc.pathname + stripParam(loc.search, 'unsubscribe') + loc.hash);
    } catch (e) { /* file:// or an old browser: nothing to clean */ }
  }

  function handleUnsubscribe(url) {
    var token = readParam(global.location && global.location.search, 'unsubscribe');
    if (token === null) return;
    var box = document.getElementById('unsubscribe-notice');
    if (!box) { dropTokenFromAddressBar(); return; }

    function show(msg) { renderMessage(box, msg, 'signup-notice', msg.confirm || msg.retry ? send : null); }

    function send() {
      show({ kind: 'pending', text: 'Taking you off the newsletter list\u2026' });
      try { box.focus(); } catch (e) { /* the button that had focus is gone; keep it in the notice */ }
      post(url, { action: 'unsubscribe', token: token }).then(function (reply) {
        var msg = unsubscribeMessage(reply);
        show(msg);
        // A final answer: the link has done its job. With Try again on screen the token stays in
        // the address bar, so a reload (or coming back later) still offers Unsubscribe.
        if (!msg.retry) dropTokenFromAddressBar();
      });
    }

    if (!isConfigured(url)) { show(unsubscribeMessage({ ok: false, code: 'not-configured' })); dropTokenFromAddressBar(); return; }
    if (!validToken(token)) { show(unsubscribeMessage({ ok: false, code: 'unknown-token' })); dropTokenFromAddressBar(); return; }
    show(CONFIRM_UNSUBSCRIBE);
  }

  function init() {
    var url = trim(global.NEWSLETTER_GATEWAY_URL);
    setupForm(url);
    handleUnsubscribe(url);
  }

  global.NewsletterSignup = {
    CONTACT: CONTACT,
    isConfigured: isConfigured,
    initialView: initialView,
    normalizeEmail: normalizeEmail,
    isValidEmail: isValidEmail,
    subscribePayload: subscribePayload,
    subscribeMessage: subscribeMessage,
    unsubscribeMessage: unsubscribeMessage,
    CONFIRM_UNSUBSCRIBE: CONFIRM_UNSUBSCRIBE,
    validToken: validToken,
    readParam: readParam,
    stripParam: stripParam,
    post: post,
    init: init
  };

  if (typeof document !== 'undefined' && document.getElementById) {
    if (document.readyState !== 'loading') init();
    else document.addEventListener('DOMContentLoaded', init);
  }
})(typeof window !== 'undefined' ? window : this);
