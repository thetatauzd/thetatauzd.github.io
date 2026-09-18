/**
 * Treasurer — charge dues and fees, record payments, waivers, plans and
 * buy-outs, see every balance with computed late fees, export to Excel.
 * The ledger is append-only; mistakes are fixed with reversals.
 */
(function (global) {
  'use strict';

  var C = global.OpsCore;
  var esc = C.esc, money = C.money, fmtDate = C.fmtDate;
  var me = null, S = null, term = null, all = null, termRec = null;
  var feeSel = {};

  function $(id) { return document.getElementById(id); }
  function setStatus(id, msg, kind) { var el = $(id); el.textContent = msg || ''; el.className = 'status-line' + (kind ? ' ' + kind : ''); }
  function name(uid) { var d = all.directory[uid]; return d ? d.name : uid; }
  function pill(t, cls) { return '<span class="count-pill ' + (cls || '') + '">' + esc(t) + '</span>'; }
  function today() { return C.ymd(new Date()); }

  function reload() {
    return Promise.all([PortalOps.loadTermFacts(term, ['ledger', 'adjustments', 'standing', 'events', 'attendance', 'rollover', 'service']), PortalOps.db.ref('terms/' + term).once('value')])
      .then(function (r) { all = r[0]; S = all.settings; termRec = r[1].val() || {}; renderAll(); });
  }

  function people(filterFn) {
    return Object.keys(all.directory).filter(function (uid) { return all.directory[uid].status !== 'pending' && (!filterFn || filterFn(all.directory[uid])); })
      .sort(function (a, b) { return name(a).localeCompare(name(b)); });
  }

  // ── Dues ──

  function renderDues() {
    var d = S.policy.dues;
    $('tr-term').textContent = term;
    $('tr-dues-amount').textContent = money(d.amount) + (termRec.duesChargedAt ? ' · charged ' + fmtDate(termRec.duesChargedAt) : ' · not charged yet');
    $('tr-pnm-amount').textContent = money(d.pnmAmount);
    $('tr-late-rule').textContent = 'Late ' + d.graceDays + ' day' + (d.graceDays === 1 ? '' : 's') + ' after due; $' + (d.lateLadder || []).join(', then $') + ' per week, then $' + d.lateAfterLadder + '/week';
    if (!$('tr-due').value) $('tr-due').value = termRec.duesDueDate || '';
  }

  function chargeDues(kind) {
    var d = S.policy.dues;
    var due = $('tr-due').value;
    if (!due) return setStatus('tr-status', 'Set the due date first.', 'error');
    var isPnm = kind === 'pnm';
    var targets = people(function (p) { return isPnm ? p.status === 'pnm' : C.isChargedStatus(p.status, S); });
    var key = (isPnm ? 'pnmdues_' : 'dues_') + term;
    var updates = {}, n = 0;
    targets.forEach(function (uid) {
      if ((all.ledger[uid] || {})[key]) return;
      updates['ledger/' + term + '/' + uid + '/' + key] = Object.assign({ type: 'charge', item: isPnm ? 'PNM dues' : 'Dues', amount: isPnm ? d.pnmAmount : d.amount, dueDate: due, date: today(), accruesLate: true, demeritsIfLate: d.demeritsIfLate || 0 }, PortalOps.audit(me));
      n++;
    });
    if (!n) return setStatus('tr-status', 'Everyone eligible is already charged.', 'success');
    if (!confirm('Charge ' + money(isPnm ? d.pnmAmount : d.amount) + ' to ' + n + ' ' + (isPnm ? 'PNM' : 'active brother') + (n === 1 ? '' : 's') + ', due ' + fmtDate(due) + '?')) return;
    updates['terms/' + term + '/duesDueDate'] = due;
    if (!isPnm) updates['terms/' + term + '/duesChargedAt'] = new Date().toISOString();
    PortalOps.db.ref().update(updates).then(function () {
      setStatus('tr-status', 'Charged ' + n + '.', 'success');
      PortalOps.logChange(term, 'charge', key, 'Charged ' + (isPnm ? 'PNM ' : '') + 'dues to ' + n + ' people, due ' + due, me);
      return reload();
    }).catch(function (err) { setStatus('tr-status', err.message || 'Failed.', 'error'); });
  }

  // ── Fees ──

  function renderFeeList() {
    var q = ($('fee-search').value || '').trim().toLowerCase();
    var uids = people();
    $('fee-list').innerHTML = uids.map(function (uid) {
      var d = all.directory[uid];
      var hide = q && name(uid).toLowerCase().indexOf(q) === -1;
      return '<li' + (hide ? ' class="hidden"' : '') + '><label style="display:flex; gap:0.5rem; align-items:center; width:100%; cursor:pointer;"><input type="checkbox" class="fee-cb" data-uid="' + esc(uid) + '"' + (feeSel[uid] ? ' checked' : '') + '><span class="bro-name">' + esc(name(uid)) + '</span>' + (C.isActiveStatus(d.status, S) ? '' : pill(d.status)) + '</label></li>';
    }).join('');
    $('fee-list').querySelectorAll('.fee-cb').forEach(function (cb) { cb.addEventListener('change', function () { feeSel[this.getAttribute('data-uid')] = this.checked; updateFeeCount(); }); });
    updateFeeCount();
  }
  function updateFeeCount() { $('fee-count').textContent = Object.keys(feeSel).filter(function (u) { return feeSel[u]; }).length + ' selected'; }

  function chargeFee() {
    var item = $('fee-item').value.trim(), amount = parseFloat($('fee-amount').value), due = $('fee-due').value;
    var uids = Object.keys(feeSel).filter(function (u) { return feeSel[u]; });
    if (!item) return setStatus('fee-status', 'Name the item.', 'error');
    if (!(amount > 0)) return setStatus('fee-status', 'Enter the amount.', 'error');
    if (!uids.length) return setStatus('fee-status', 'Pick who to charge.', 'error');
    if (!confirm('Charge ' + money(amount) + ' for "' + item + '" to ' + uids.length + ' people?')) return;
    var key = 'fee_' + C.nameKey(item) + '_' + Date.now().toString(36);
    var updates = {};
    uids.forEach(function (uid) {
      updates['ledger/' + term + '/' + uid + '/' + key] = Object.assign({ type: 'charge', item: item, amount: amount, dueDate: due || null, date: today(), accruesLate: $('fee-late').checked && !!due, demeritsIfLate: parseInt($('fee-demerits').value, 10) || 0 }, PortalOps.audit(me));
    });
    PortalOps.db.ref().update(updates).then(function () {
      setStatus('fee-status', 'Charged ' + uids.length + '.', 'success'); feeSel = {}; $('fee-item').value = ''; $('fee-amount').value = '';
      PortalOps.logChange(term, 'charge', key, 'Charged "' + item + '" ' + money(amount) + ' to ' + uids.length + ' people', me);
      return reload();
    }).catch(function (err) { setStatus('fee-status', err.message || 'Failed.', 'error'); });
  }

  // ── Balances ──

  function summaries() {
    var out = [];
    people().forEach(function (uid) {
      var led = C.ledgerSummary(all.ledger[uid], S);
      if (!led.charges.length) return;
      var dem = C.computeDemerits(uid, PortalOps.factsFor(term, uid, all), S);
      out.push({ uid: uid, name: name(uid), roll: C.rollKey(all.directory[uid].rollNumber), status: all.directory[uid].status, led: led, dem: dem });
    });
    return out;
  }

  function renderBalances() {
    var q = ($('bal-search').value || '').trim().toLowerCase(), f = $('bal-filter').value;
    var rows = summaries();
    var collected = 0, outstanding = 0, duesPaid = 0, duesTotal = 0, lateCount = 0;
    rows.forEach(function (r) {
      collected += r.led.totalPaid; outstanding += r.led.balance;
      var dues = r.led.charges.find(function (c) { return c.key === 'dues_' + term; });
      if (dues) { duesTotal++; if (dues.settled) duesPaid++; }
      if (r.led.charges.some(function (c) { return c.status === 'late'; })) lateCount++;
    });
    $('bal-collected').textContent = money(collected);
    $('bal-outstanding').textContent = money(outstanding);
    $('bal-dues-paid').textContent = duesPaid + ' / ' + duesTotal;
    $('bal-late-count').textContent = lateCount;
    var shown = rows.filter(function (r) {
      if (q && (r.name + ' ' + r.roll).toLowerCase().indexOf(q) === -1) return false;
      var anyLate = r.led.charges.some(function (c) { return c.status === 'late'; }), anyPlan = r.led.charges.some(function (c) { return c.status === 'plan'; });
      if (f === 'owing') return r.led.balance > 0;
      if (f === 'late') return anyLate;
      if (f === 'plan') return anyPlan;
      if (f === 'clear') return r.led.balance <= 0;
      return true;
    }).sort(function (a, b) { return b.led.balance - a.led.balance || a.name.localeCompare(b.name); });
    $('bal-list').innerHTML = shown.length ? shown.map(renderPerson).join('') : '<p class="section-empty">Nobody matches.</p>';
    wireBalances();
  }

  function renderPerson(r) {
    var chips = r.led.charges.map(function (c) {
      var cls = c.status === 'paid' || c.status === 'waived' ? 'good' : (c.status === 'late' ? 'bad' : (c.status === 'plan' ? 'warn' : ''));
      return '<span class="rchip ' + cls + '">' + esc(c.item) + ' ' + (c.settled ? '✓' : money(c.remaining + c.lateFee)) + '</span>';
    }).join('');
    var body = r.led.charges.map(function (c) {
      var hist = c.history.map(function (h) { return '<div class="step-hint" style="margin:0;">' + esc(fmtDate(h.date)) + ' — ' + esc(h.type) + ' ' + (h.amount ? money(h.amount) : '') + (h.method ? ' (' + esc(h.method) + ')' : '') + (h.note ? ' · ' + esc(h.note) : '') + ' <button type="button" class="btn-text rev-btn" data-uid="' + esc(r.uid) + '" data-key="' + esc(h.key) + '">reverse</button></div>'; }).join('');
      var acts = c.settled ? '' :
        '<div class="add-row" style="align-items:center; margin-top:0.35rem;">' +
        '<input class="field pay-amt" data-key="' + esc(c.key) + '" type="number" step="0.01" placeholder="' + (c.remaining + c.lateFee) + '" style="max-width:110px;">' +
        '<select class="field pay-method" data-key="' + esc(c.key) + '" style="max-width:120px;"><option>venmo</option><option>cash</option><option>check</option><option>zelle</option><option>other</option></select>' +
        '<button type="button" class="btn btn-primary btn-small act" data-a="payment" data-uid="' + esc(r.uid) + '" data-key="' + esc(c.key) + '" style="margin:0;">Record payment</button>' +
        '<button type="button" class="btn ghost btn-small act" data-a="plan" data-uid="' + esc(r.uid) + '" data-key="' + esc(c.key) + '" style="margin:0;">Payment plan</button>' +
        '<button type="button" class="btn ghost btn-small act" data-a="waiver" data-uid="' + esc(r.uid) + '" data-key="' + esc(c.key) + '" style="margin:0;">Waive</button></div>';
      return '<div class="rd"><div class="rd-line">' + esc(c.item) + ' · ' + money(c.amount) + (c.dueDate ? ' · due ' + esc(fmtDate(c.dueDate)) : '') + ' · ' + pill(c.status, c.status === 'paid' || c.status === 'waived' ? 'good' : (c.status === 'late' ? 'bad' : 'warn')) +
        (c.lateFee ? ' <span style="color:#c62828; font-size:0.85rem;">+' + money(c.lateFee) + ' late fee</span>' : '') + (c.onPlan && c.planDueDate ? ' <span class="step-hint" style="display:inline;">plan due ' + esc(fmtDate(c.planDueDate)) + '</span>' : '') + '</div>' + hist + acts + '</div>';
    }).join('');
    var buyout = r.dem.standing === 'bad' && r.dem.buyout ? '<div class="rd"><div class="rd-line">Bad standing · buy-out ' + money(r.dem.buyout) + ' resets ' + r.dem.total + ' demerits to 0</div><button type="button" class="btn ghost btn-small act" data-a="buyout" data-uid="' + esc(r.uid) + '" data-amount="' + r.dem.buyout + '" data-total="' + r.dem.total + '" style="margin:0;">Record buy-out paid</button></div>' : '';
    return '<details class="cand"><summary><span class="cand-name">' + esc(r.name) + (r.roll ? ' <span style="color:#999; font-weight:400;">#' + esc(r.roll) + '</span>' : '') + (C.isActiveStatus(r.status, S) ? '' : ' ' + pill(r.status)) + '</span><span class="cand-chips">' + chips + '<span class="rchip ' + (r.led.balance > 0 ? 'bad' : 'good') + '">' + money(r.led.balance) + '</span></span></summary>' + body + buyout + '</details>';
  }

  function wireBalances() {
    $('bal-list').querySelectorAll('.act').forEach(function (b) {
      b.addEventListener('click', function () {
        var a = this.getAttribute('data-a'), uid = this.getAttribute('data-uid'), key = this.getAttribute('data-key');
        if (a === 'payment') {
          var amtEl = document.querySelector('.pay-amt[data-key="' + key + '"]'), method = document.querySelector('.pay-method[data-key="' + key + '"]').value;
          var amt = parseFloat(amtEl.value) || parseFloat(amtEl.placeholder);
          if (!(amt > 0)) return alert('Enter the amount.');
          return write(uid, { type: 'payment', chargeId: key, amount: amt, date: today(), method: method }, 'Payment ' + money(amt) + ' from ' + name(uid));
        }
        if (a === 'waiver') {
          var note = prompt('Waive the rest of this charge for ' + name(uid) + '? Reason:'); if (note === null) return;
          return write(uid, { type: 'waiver', chargeId: key, amount: 0, date: today(), note: note }, 'Waived ' + key + ' for ' + name(uid) + ': ' + note);
        }
        if (a === 'plan') {
          var due = prompt('Payment plan for ' + name(uid) + ' — final due date (YYYY-MM-DD):', ''); if (due === null) return;
          if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) return alert('Use YYYY-MM-DD.');
          return write(uid, { type: 'plan', chargeId: key, date: today(), planDueDate: due, note: 'Payment plan' }, 'Payment plan for ' + name(uid) + ' due ' + due);
        }
        if (a === 'buyout') {
          var amount = parseFloat(this.getAttribute('data-amount')), total = parseInt(this.getAttribute('data-total'), 10);
          if (!confirm('Record a ' + money(amount) + ' buy-out from ' + name(uid) + '? This charges and pays the fine and resets their ' + total + ' demerits to 0.')) return;
          var k = 'buyout_' + Date.now().toString(36);
          var updates = {};
          updates['ledger/' + term + '/' + uid + '/' + k] = Object.assign({ type: 'charge', item: 'Buy-out', amount: amount, dueDate: today(), date: today(), accruesLate: false, demeritsIfLate: 0 }, PortalOps.audit(me));
          updates['ledger/' + term + '/' + uid + '/' + k + '_pay'] = Object.assign({ type: 'payment', chargeId: k, amount: amount, date: today(), method: 'buyout' }, PortalOps.audit(me));
          updates['adjustments/' + term + '/' + uid + '/' + k] = Object.assign({ points: -total, reason: 'Buy-out paid (' + money(amount) + ') — demerits reset', date: today(), enteredBy: me.name || '' }, PortalOps.audit(me));
          return PortalOps.db.ref().update(updates).then(function () { PortalOps.logChange(term, 'buyout', uid, name(uid) + ' paid buy-out ' + money(amount) + ', ' + total + ' demerits reset', me); return reload(); }).catch(function (err) { alert(err.message || 'Failed.'); });
        }
      });
    });
    $('bal-list').querySelectorAll('.rev-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        var uid = this.getAttribute('data-uid'), key = this.getAttribute('data-key');
        var why = prompt('Reverse this entry for ' + name(uid) + '? Reason:'); if (why === null) return;
        write(uid, { type: 'reversal', reverses: key, date: today(), note: why }, 'Reversed ' + key + ' for ' + name(uid) + ': ' + why);
      });
    });
  }

  function write(uid, entry, logText) {
    return PortalOps.addLedgerEntry(term, uid, entry, me).then(function () { PortalOps.logChange(term, 'ledger', uid, logText, me); return reload(); })
      .catch(function (err) { alert(err.message || 'Failed.'); });
  }

  // ── Export ──

  function exportXlsx() {
    if (typeof XLSX === 'undefined') return alert('Excel library not loaded.');
    var rows = summaries();
    var wb = XLSX.utils.book_new();
    var overview = [['Brother', 'Roll', 'Status', 'Charged', 'Paid', 'Waived', 'Late fees', 'Balance', 'Standing']];
    rows.forEach(function (r) { overview.push([r.name, r.roll, r.status, r.led.totalCharged, r.led.totalPaid, r.led.totalWaived, r.led.lateFees, r.led.balance, r.dem.standing]); });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(overview), 'Balances');
    var detail = [['Brother', 'Item', 'Amount', 'Due', 'Status', 'Paid', 'Waived', 'Late fee', 'Remaining']];
    rows.forEach(function (r) { r.led.charges.forEach(function (c) { detail.push([r.name, c.item, c.amount, c.dueDate || '', c.status, c.paid, c.waived, c.lateFee, c.remaining]); }); });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(detail), 'Charges');
    XLSX.writeFile(wb, 'treasurer_' + term + '.xlsx');
  }

  function renderAll() { renderDues(); renderFeeList(); renderBalances(); }

  function init() {
    PortalAuth.requirePerm('finance').then(function (profile) {
      if (!profile) return;
      me = profile; PortalAuth.initNav(profile);
      return PortalOps.loadSettings();
    }).then(function (s) {
      if (!s) return;
      term = PortalOps.currentTerm();
      $('fee-due').value = today();
      $('btn-charge-dues').addEventListener('click', function () { chargeDues('brother'); });
      $('btn-charge-pnm').addEventListener('click', function () { chargeDues('pnm'); });
      $('btn-charge-fee').addEventListener('click', chargeFee);
      $('fee-search').addEventListener('input', renderFeeList);
      $('fee-all').addEventListener('click', function () { people(function (p) { return C.isActiveStatus(p.status, S); }).forEach(function (u) { feeSel[u] = true; }); renderFeeList(); });
      $('fee-none').addEventListener('click', function () { feeSel = {}; renderFeeList(); });
      $('bal-search').addEventListener('input', renderBalances);
      $('bal-filter').addEventListener('change', renderBalances);
      $('btn-export-xlsx').addEventListener('click', exportXlsx);
      return reload();
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(typeof window !== 'undefined' ? window : this);
