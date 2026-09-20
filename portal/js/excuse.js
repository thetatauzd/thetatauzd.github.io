/**
 * Request an excuse — replaces the Excused Absence Google Form. A brother (or
 * PNM) ticks the events a reason covers, says whether they are missing it,
 * arriving late or leaving early, explains, and can attach photos. Standards
 * rules on each request from the Standards Board; an approved request turns an
 * absence at that event into an excused one automatically.
 */
(function (global) {
  'use strict';

  var C = global.OpsCore;
  var esc = C.esc, fmtDate = C.fmtDate;
  var me = null, term = null, facts = null, S = null, photoPicker = null;
  var picked = {}, kind = 'absent';

  function $(id) { return document.getElementById(id); }
  function setStatus(msg, k) { var el = $('x-status'); el.textContent = msg || ''; el.className = 'status-line' + (k ? ' ' + k : ''); }
  function pill(t, cls) { return '<span class="count-pill ' + (cls || '') + '">' + esc(t) + '</span>'; }
  function statusCls(s) { return s === 'approved' ? 'good' : (s === 'denied' ? 'bad' : 'warn'); }
  var KIND_LABEL = { absent: 'Missing it', late: 'Arriving late', leaveEarly: 'Leaving early' };

  function reload() {
    return PortalOps.loadMyFacts(term, me.uid).then(function (f) { facts = f; S = f.settings; render(); });
  }

  /** Latest request per event, so a denied one can be asked again but a pending/approved one cannot. */
  function latestByEvent() {
    var out = {};
    C.values(facts.excuses).forEach(function (x) {
      if (!x.eventId) return;
      if (!out[x.eventId] || (x.submittedAt || 0) > (out[x.eventId].submittedAt || 0)) out[x.eventId] = x;
    });
    return out;
  }

  function render() {
    var p = S.policy.attendance;
    $('x-term').textContent = term;
    $('x-rule').textContent = 'Send it at least ' + p.excuseHoursBefore + ' hours before the event. Standards decides every request and you will see the answer here. Two chapter meetings a term can be missed without an excuse.';

    // Events: everything not yet recorded, plus the last two weeks for late requests.
    var today = C.ymd(new Date()), cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 14);
    var latest = latestByEvent();
    var list = C.values(facts.events).filter(function (ev) {
      if (ev.type === 'pledge' && me.status !== 'pnm') return false;
      if (!ev.date) return !ev.recorded;
      return C.toDate(ev.date) >= cutoff;
    }).sort(function (a, b) { return String(a.date || '9999').localeCompare(String(b.date || '9999')); });
    $('x-events').innerHTML = list.length ? list.map(function (ev) {
      var def = S.eventTypes[ev.type] || S.eventTypes.other;
      var x = latest[ev.key];
      var locked = x && x.status !== 'denied';
      var past = ev.date && ev.date < today;
      var stakes = def.unexcused ? 'unexcused ' + def.unexcused + (def.excused ? ' · excused ' + def.excused : '') : 'no demerits';
      return '<li class="' + (locked ? 'is-locked' : '') + '"><label><input type="checkbox" class="x-ev" data-id="' + esc(ev.key) + '"' + (picked[ev.key] ? ' checked' : '') + (locked ? ' disabled' : '') + '>' +
        '<span class="pick-main"><strong>' + esc(ev.title) + '</strong><span class="pick-sub">' + esc(ev.date ? fmtDate(ev.date) : 'date to be set') + (ev.time ? ' · ' + esc(ev.time) : '') + ' · ' + esc(def.label) + ' · ' + esc(stakes) + '</span></span>' +
        (locked ? pill(x.status, statusCls(x.status)) : (past ? pill('already happened', 'warn') : '')) + '</label></li>';
    }).join('') : '<li class="section-empty">No upcoming events are scheduled yet. Use the box below.</li>';
    $('x-events').querySelectorAll('.x-ev').forEach(function (cb) {
      cb.addEventListener('change', function () { picked[this.getAttribute('data-id')] = this.checked; renderTiming(); });
    });

    // My requests
    var dem = C.computeDemerits(me.uid, facts, S, { pnm: me.status === 'pnm' });
    var free = C.freeAbsences(dem, S);
    $('x-free').textContent = free.left + ' of ' + free.allowed + ' free chapter absences left';
    var mine = C.values(facts.excuses).sort(function (a, b) { return (b.submittedAt || 0) - (a.submittedAt || 0); });
    $('x-mine').innerHTML = mine.length ? mine.map(function (x) {
      var ev = x.eventId ? (facts.events[x.eventId] || { title: x.eventId }) : { title: x.eventText || 'Unlisted event', date: x.eventDate };
      return '<div class="req-card"><div class="req-head"><strong>' + esc(ev.title) + '</strong> ' + pill(x.status, statusCls(x.status)) + '</div>' +
        '<div class="pick-sub">' + esc(ev.date ? fmtDate(ev.date) : '') + ' · ' + esc(KIND_LABEL[x.kind || 'absent']) + (x.time ? ' around ' + esc(x.time) : '') + (x.lateSubmission ? ' · sent inside the ' + p.excuseHoursBefore + '-hour window' : '') + '</div>' +
        '<div class="req-body">' + esc(x.reason || '') + '</div>' +
        (x.reviewNote ? '<div class="req-note">Standards: ' + esc(x.reviewNote) + '</div>' : '') +
        PortalPhotos.buttonsHtml('excuse', term, me.uid, x.photoIds) +
        (x.status === 'pending' ? '<button type="button" class="btn-text x-withdraw" data-id="' + esc(x.key) + '">Take this request back</button>' : '') + '</div>';
    }).join('') : '<p class="section-empty">Nothing sent this term.</p>';
    PortalPhotos.wire($('x-mine'));
    $('x-mine').querySelectorAll('.x-withdraw').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = this.getAttribute('data-id');
        if (!confirm('Take this request back? Standards will no longer see it.')) return;
        PortalOps.withdrawExcuse(term, me.uid, id, facts.excuses[id]).then(reload).catch(function (err) { alert(err.message || 'Could not remove it.'); });
      });
    });
    renderTiming();
  }

  function targets() {
    var t = Object.keys(picked).filter(function (k) { return picked[k] && facts.events[k]; }).map(function (k) { return { eventId: k }; });
    if ($('x-unlisted').checked && $('x-event-text').value.trim()) t.push({ eventText: $('x-event-text').value.trim(), eventDate: $('x-event-date').value || null });
    return t;
  }

  function renderTiming() {
    var hours = S.policy.attendance.excuseHoursBefore;
    var late = targets().filter(function (t) {
      var ev = t.eventId ? facts.events[t.eventId] : { date: t.eventDate };
      return !C.excuseTiming(ev, Date.now(), S).onTime;
    }).map(function (t) { return t.eventId ? facts.events[t.eventId].title : t.eventText; });
    var el = $('x-timing');
    if (!targets().length) { el.textContent = ''; return; }
    el.innerHTML = late.length
      ? '<strong style="color:#8a5a00;">Heads up:</strong> ' + esc(late.join(', ')) + (late.length === 1 ? ' is' : ' are') + ' less than ' + hours + ' hours away (or already happened). You can still send it; Standards decides case by case.'
      : 'On time: more than ' + hours + ' hours ahead.';
  }

  function send() {
    var t = targets(), reason = $('x-reason').value.trim();
    if (!t.length) return setStatus('Tick at least one event, or name the one that is not listed.', 'error');
    if (!reason) return setStatus('Say what is keeping you from it.', 'error');
    if (photoPicker.busy()) return setStatus('Hang on, your photo is still being prepared.', 'error');
    var btn = $('btn-send'); btn.disabled = true; setStatus('Sending…');
    PortalPhotos.save('excuse', term, me.uid, photoPicker.photos()).then(function (ids) {
      var base = { kind: kind, time: kind === 'absent' ? null : ($('x-time').value || null), category: $('x-category').value, reason: reason,
        photoIds: ids.length ? ids : null, name: me.name || '' };
      return PortalOps.submitExcuses(term, me.uid, base, t, S, facts.events);
    }).then(function () {
      setStatus(t.length === 1 ? 'Sent to Standards.' : 'Sent ' + t.length + ' requests to Standards.', 'success');
      picked = {}; $('x-reason').value = ''; $('x-unlisted').checked = false; $('x-unlisted-row').classList.add('hidden'); $('x-event-text').value = '';
      photoPicker.clear();
      return reload();
    }).catch(function (err) { setStatus(err.message || 'Could not send. Try again.', 'error'); })
      .then(function () { btn.disabled = false; });
  }

  function init() {
    PortalAuth.requireAuth({ page: 'excuse' }).then(function (profile) {
      if (!profile) return;
      me = profile; PortalAuth.initNav(profile);
      return PortalOps.loadSettings();
    }).then(function (s) {
      if (!s) return;
      term = PortalOps.currentTerm();
      photoPicker = PortalPhotos.picker($('x-photos'), $('x-preview'), { max: 3, onError: function (m) { setStatus(m, 'error'); } });
      $('x-kind').querySelectorAll('button').forEach(function (b) {
        b.addEventListener('click', function () {
          kind = this.getAttribute('data-v');
          $('x-kind').querySelectorAll('button').forEach(function (o) { o.classList.toggle('selected', o === b); });
          $('x-time-row').classList.toggle('hidden', kind === 'absent');
          $('x-time-label').textContent = kind === 'late' ? 'About when will you get there?' : 'About when do you need to leave?';
        });
      });
      $('x-unlisted').addEventListener('change', function () { $('x-unlisted-row').classList.toggle('hidden', !this.checked); renderTiming(); });
      $('x-event-text').addEventListener('input', renderTiming);
      $('x-event-date').addEventListener('change', renderTiming);
      $('x-category').addEventListener('change', function () { $('x-sick-hint').classList.toggle('hidden', this.value !== 'sick'); });
      $('btn-send').addEventListener('click', send);
      return reload().then(function () { $('page-status').classList.add('hidden'); $('page-body').classList.remove('hidden'); });
    }).catch(function (err) { $('page-status').textContent = (err && err.message) || 'Could not load.'; });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(typeof window !== 'undefined' ? window : this);
