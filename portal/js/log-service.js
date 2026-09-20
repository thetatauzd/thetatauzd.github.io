/**
 * Log service hours — replaces the Service Hours Google Form. Same questions:
 * what you did, how many hours, when, a photo of you there, or who can vouch.
 * Service events are NOT kept on the site, so the event is typed in. The
 * Community Service Chair approves each entry (and may adjust the hours or
 * mark it as one of the required service events).
 */
(function (global) {
  'use strict';

  var C = global.OpsCore;
  var esc = C.esc, fmtDate = C.fmtDate;
  var me = null, term = null, facts = null, S = null, photoPicker = null;

  function $(id) { return document.getElementById(id); }
  function setStatus(msg, k) { var el = $('sv-status'); el.textContent = msg || ''; el.className = 'status-line' + (k ? ' ' + k : ''); }
  function pill(t, cls) { return '<span class="count-pill ' + (cls || '') + '">' + esc(t) + '</span>'; }
  function statusCls(s) { return s === 'approved' ? 'good' : (s === 'denied' ? 'bad' : 'warn'); }

  function reload() {
    return PortalOps.loadMyFacts(term, me.uid).then(function (f) { facts = f; S = f.settings; render(); });
  }

  function render() {
    var isPnm = me.status === 'pnm';
    var svc = C.serviceSummary(facts.service, S, { pnm: isPnm });
    $('sv-term').textContent = term;
    $('sv-rule').textContent = 'This term: ' + svc.hoursRequired + ' hours and ' + svc.eventsRequired + ' service events. The Community Service Chair approves each entry, so add a photo or name someone who can vouch.';
    $('sv-approved').textContent = svc.approvedHours + (svc.pendingHours ? ' (+' + svc.pendingHours + ')' : '');
    $('sv-left').textContent = svc.hoursShort;
    $('sv-events').textContent = svc.distinctEvents + ' / ' + svc.eventsRequired;
    $('sv-explain').textContent = svc.met ? 'Requirement met. Extra approved hours erase demerits one for one.'
      : (svc.pendingHours ? svc.pendingHours + ' hours are waiting for approval. ' : '') + 'Falling short adds demerits next term: ' + S.policy.service.perHourShort + ' per hour and ' + S.policy.service.perEventShort + ' per event.';
    var mine = svc.entries.sort(function (a, b) { return (b.submittedAt || 0) - (a.submittedAt || 0); });
    $('sv-mine').innerHTML = mine.length ? mine.map(function (e) {
      return '<div class="req-card"><div class="req-head"><strong>' + esc(e.eventName || '') + '</strong> ' + pill(e.hours + ' h', '') + ' ' + pill(e.status, statusCls(e.status)) + (e.countsAsEvent && e.status === 'approved' ? ' ' + pill('service event', 'good') : '') + '</div>' +
        '<div class="pick-sub">' + esc(fmtDate(e.date)) + (e.vouchedBy ? ' · vouched by ' + esc(e.vouchedBy) : '') + (e.requestedHours && e.requestedHours !== e.hours ? ' · you asked for ' + esc(e.requestedHours) + ' h' : '') + '</div>' +
        (e.reviewNote ? '<div class="req-note">Service Chair: ' + esc(e.reviewNote) + '</div>' : '') +
        PortalPhotos.buttonsHtml('service', term, me.uid, e.photoIds) +
        (e.status === 'pending' ? '<button type="button" class="btn-text sv-withdraw" data-id="' + esc(e.key) + '">Take this back</button>' : '') + '</div>';
    }).join('') : '<p class="section-empty">Nothing logged yet this term.</p>';
    PortalPhotos.wire($('sv-mine'));
    $('sv-mine').querySelectorAll('.sv-withdraw').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!confirm('Remove this entry?')) return;
        PortalOps.db.ref('service/' + term + '/' + me.uid + '/' + this.getAttribute('data-id')).remove().then(reload).catch(function (err) { alert(err.message || 'Could not remove it.'); });
      });
    });
  }

  function send() {
    var name = $('sv-event').value.trim(), hours = parseFloat($('sv-hours').value), date = $('sv-date').value;
    var vouch = $('sv-vouch').value.trim(), photos = photoPicker.photos();
    if (!name) return setStatus('Say which event you attended.', 'error');
    if (!(hours > 0) || hours > 24) return setStatus('Enter the hours as a number, like 2 or 1.5.', 'error');
    if (!date) return setStatus('Pick the date.', 'error');
    if (date > C.ymd(new Date())) return setStatus('That date is in the future. Log hours after you have done them.', 'error');
    if (photoPicker.busy()) return setStatus('Hang on, your photo is still being prepared.', 'error');
    if (!photos.length && !vouch) return setStatus('Add a photo, or name who can vouch for you.', 'error');
    var btn = $('btn-send'); btn.disabled = true; setStatus('Submitting…');
    PortalPhotos.save('service', term, me.uid, photos).then(function (ids) {
      return PortalOps.db.ref('service/' + term + '/' + me.uid).push({
        eventName: name, hours: hours, requestedHours: hours, date: date, week: C.weekOf(date), photoIds: ids.length ? ids : null,
        vouchedBy: vouch, description: $('sv-notes').value.trim(), name: me.name || '', countsAsEvent: false,
        status: 'pending', submittedAt: firebase.database.ServerValue.TIMESTAMP
      });
    }).then(function () {
      setStatus('Submitted. The Community Service Chair will review it.', 'success');
      ['sv-event', 'sv-hours', 'sv-vouch', 'sv-notes'].forEach(function (id) { $(id).value = ''; });
      photoPicker.clear();
      return reload();
    }).catch(function (err) { setStatus(err.message || 'Could not submit. Try again.', 'error'); })
      .then(function () { btn.disabled = false; });
  }

  function init() {
    PortalAuth.requireAuth({ page: 'log-service' }).then(function (profile) {
      if (!profile) return;
      me = profile; PortalAuth.initNav(profile);
      return PortalOps.loadSettings();
    }).then(function (s) {
      if (!s) return;
      term = PortalOps.currentTerm();
      $('sv-date').value = C.ymd(new Date());
      $('sv-date').max = C.ymd(new Date());
      photoPicker = PortalPhotos.picker($('sv-photos'), $('sv-preview'), { max: 3, onError: function (m) { setStatus(m, 'error'); } });
      $('btn-send').addEventListener('click', send);
      PortalOps.loadDirectory().then(function (dir) {
        $('sv-people').innerHTML = Object.keys(dir).filter(function (u) { return dir[u].status !== 'pnm'; }).map(function (u) { return '<option value="' + esc(dir[u].name) + '">'; }).join('');
      }).catch(function () {});
      return reload().then(function () { $('page-status').classList.add('hidden'); $('page-body').classList.remove('hidden'); });
    }).catch(function (err) { $('page-status').textContent = (err && err.message) || 'Could not load.'; });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(typeof window !== 'undefined' ? window : this);
