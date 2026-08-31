/**
 * Admin email automation client.
 * The browser never stores provider secrets. It prepares templates, recipient
 * rows, mapping, previews, and calls a backend gateway for actual sending.
 */
(function (global) {
  'use strict';

  var EMAIL_GATEWAY_URL = '';

  var TEMPLATES = [
    {
      name: 'Rush invitation',
      category: 'Recruitment',
      subject: 'Invitation to {{event_name}}',
      body: 'Hi {{first_name}},\n\nTheta Tau Zeta Delta would love to see you at {{event_name}} on {{date}}. Reply with any questions, and we hope to meet you there.\n\nIn H&T,\n{{chapter}}'
    },
    {
      name: 'Recruitment follow-up',
      category: 'Recruitment',
      subject: 'Thanks for coming, {{first_name}}',
      body: 'Hi {{first_name}},\n\nThanks for spending time with Theta Tau at {{event_name}}. Our next deadline is {{deadline}}. Let us know if you have questions.\n\nIn H&T,\n{{chapter}}'
    },
    {
      name: 'Chapter event reminder',
      category: 'Chapter',
      subject: 'Reminder: {{event_name}} on {{date}}',
      body: 'Hi {{first_name}},\n\nThis is a reminder that {{event_name}} is scheduled for {{date}}. Please arrive on time and reach out if something changes.\n\nIn H&T,\n{{chapter}}'
    },
    {
      name: 'Officer announcement',
      category: 'Chapter',
      subject: '{{event_name}} update',
      body: 'Hi {{first_name}},\n\nPlease review this chapter update:\n\n{{message}}\n\nIn H&T,\n{{chapter}}'
    },
    {
      name: 'Thank-you note',
      category: 'Chapter',
      subject: 'Thank you, {{first_name}}',
      body: 'Hi {{first_name}},\n\nThank you for your help with {{event_name}}. We appreciate the time and care you put into supporting the chapter.\n\nIn H&T,\n{{chapter}}'
    },
    {
      name: 'Deadline reminder',
      category: 'Chapter',
      subject: 'Deadline reminder: {{deadline}}',
      body: 'Hi {{first_name}},\n\nThis is a reminder that the deadline for {{event_name}} is {{deadline}}. Please complete it as soon as you can.\n\nIn H&T,\n{{chapter}}'
    }
  ];

  var state = {
    profiles: [],
    headers: [],
    rows: [],
    mappings: {},
    variables: [],
    validation: { valid: [], skipped: [] }
  };

  function $(id) {
    return document.getElementById(id);
  }

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function isEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
  }

  function variablesFrom(text) {
    var out = {};
    String(text || '').replace(/\{\{\s*([a-zA-Z0-9_ .-]+)\s*\}\}/g, function (_, name) {
      out[String(name).trim()] = true;
      return _;
    });
    return Object.keys(out).sort();
  }

  function autoMap(variable) {
    var normalized = variable.toLowerCase().replace(/[^a-z0-9]/g, '');
    for (var i = 0; i < state.headers.length; i++) {
      var h = state.headers[i];
      var hn = h.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (hn === normalized) return h;
    }
    if (normalized === 'email') {
      return state.headers.find(function (h) { return /e-?mail|email address/i.test(h); }) || '';
    }
    return '';
  }

  function renderTemplate(text, row) {
    return String(text || '').replace(/\{\{\s*([a-zA-Z0-9_ .-]+)\s*\}\}/g, function (_, name) {
      var key = state.mappings[String(name).trim()];
      return key ? String(row[key] == null ? '' : row[key]) : '';
    });
  }

  function currentTemplate() {
    return {
      name: $('template-name').value.trim() || 'Custom email',
      subject: $('email-subject').value,
      body: $('email-body').value
    };
  }

  function requiredVariables() {
    var t = currentTemplate();
    var vars = variablesFrom(t.subject + '\n' + t.body);
    if (vars.indexOf('email') === -1) vars.unshift('email');
    return vars;
  }

  function parseCsv(text) {
    var rows = [];
    var row = [];
    var cell = '';
    var quote = false;
    var i;
    for (i = 0; i < text.length; i++) {
      var ch = text[i];
      var next = text[i + 1];
      if (quote && ch === '"' && next === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quote = !quote;
      } else if (!quote && (ch === ',' || ch === '\t')) {
        row.push(cell);
        cell = '';
      } else if (!quote && (ch === '\n' || ch === '\r')) {
        if (ch === '\r' && next === '\n') i++;
        row.push(cell);
        if (row.some(function (v) { return String(v).trim(); })) rows.push(row);
        row = [];
        cell = '';
      } else {
        cell += ch;
      }
    }
    row.push(cell);
    if (row.some(function (v) { return String(v).trim(); })) rows.push(row);
    return tableToObjects(rows);
  }

  function tableToObjects(table) {
    if (!table || !table.length) return { headers: [], rows: [] };
    var headers = table[0].map(function (h) { return String(h || '').trim(); }).filter(Boolean);
    var rows = [];
    for (var r = 1; r < table.length; r++) {
      var obj = {};
      var empty = true;
      for (var c = 0; c < headers.length; c++) {
        var val = table[r][c] == null ? '' : String(table[r][c]).trim();
        obj[headers[c]] = val;
        if (val) empty = false;
      }
      if (!empty) rows.push(obj);
    }
    return { headers: headers, rows: rows };
  }

  function validateRows() {
    var vars = requiredVariables();
    state.variables = vars;
    var valid = [];
    var skipped = [];

    state.rows.forEach(function (row, idx) {
      var emailCol = state.mappings.email || state.mappings.Email || autoMap('email');
      var email = emailCol ? row[emailCol] : '';
      if (!isEmail(email)) {
        skipped.push({ row: idx + 2, reason: 'invalid_email', email: email || '' });
        return;
      }

      for (var i = 0; i < vars.length; i++) {
        var name = vars[i];
        var col = state.mappings[name];
        if (!col) {
          skipped.push({ row: idx + 2, reason: 'missing_mapping', variable: name, email: email });
          return;
        }
        if (!String(row[col] || '').trim()) {
          skipped.push({ row: idx + 2, reason: 'missing_required_value', variable: name, email: email });
          return;
        }
      }
      valid.push({ rowNumber: idx + 2, data: row, email: String(email).trim() });
    });

    state.validation = { valid: valid, skipped: skipped };
    renderStats();
    renderPreview();
    renderSkips(skipped);
  }

  function renderMappings() {
    var box = $('mapping-fields');
    var vars = requiredVariables();
    state.variables = vars;

    vars.forEach(function (v) {
      if (!state.mappings[v]) state.mappings[v] = autoMap(v);
    });

    if (!vars.length) {
      box.innerHTML = '<p class="section-empty">Add placeholders like {{first_name}} to map columns.</p>';
      return;
    }

    box.innerHTML = vars.map(function (v) {
      var options = ['<option value="">Unmapped</option>'].concat(state.headers.map(function (h) {
        return '<option value="' + esc(h) + '"' + (state.mappings[v] === h ? ' selected' : '') + '>' + esc(h) + '</option>';
      }));
      return '<label><span>{{' + esc(v) + '}}</span><select data-variable="' + esc(v) + '">' + options.join('') + '</select></label>';
    }).join('');

    box.querySelectorAll('select').forEach(function (select) {
      select.addEventListener('change', function () {
        state.mappings[this.getAttribute('data-variable')] = this.value;
        validateRows();
      });
    });
  }

  function renderStats() {
    $('recipient-stats').innerHTML =
      '<span>Total: ' + state.rows.length + '</span>' +
      '<span>Valid: ' + state.validation.valid.length + '</span>' +
      '<span>Skipped: ' + state.validation.skipped.length + '</span>';
  }

  function renderPreview() {
    var first = state.validation.valid[0];
    var t = currentTemplate();
    if (!first) {
      $('preview-meta').textContent = state.rows.length ? 'No valid recipient rows.' : 'No valid recipient loaded.';
      $('preview-subject').textContent = '';
      $('preview-body').textContent = '';
      return;
    }
    $('preview-meta').textContent = 'Row ' + first.rowNumber + ' -> ' + first.email;
    $('preview-subject').textContent = renderTemplate(t.subject, first.data);
    $('preview-body').textContent = renderTemplate(t.body, first.data);
  }

  function renderSkips(items) {
    if (!items.length) {
      $('skip-list').innerHTML = '<p class="section-empty">No skipped rows.</p>';
      return;
    }
    $('skip-list').innerHTML = items.slice(0, 30).map(function (item) {
      var detail = item.variable ? ' (' + item.variable + ')' : '';
      return '<div><strong>Row ' + item.row + '</strong> ' + esc(item.reason + detail) + '</div>';
    }).join('') + (items.length > 30 ? '<div>And ' + (items.length - 30) + ' more...</div>' : '');
  }

  function setTemplate(t) {
    $('template-name').value = t.name || '';
    $('email-subject').value = t.subject || '';
    $('email-body').value = t.body || '';
    renderMappings();
    validateRows();
  }

  function callGateway(payload) {
    if (!EMAIL_GATEWAY_URL) return Promise.reject(new Error('Email gateway URL is not configured.'));
    return firebase.auth().currentUser.getIdToken().then(function (idToken) {
      return fetch(EMAIL_GATEWAY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ idToken: idToken }, payload || {}))
      });
    }).then(function (res) {
      return res.json();
    }).then(function (data) {
      if (!data || data.ok === false) throw new Error((data && data.error) || 'Email gateway error.');
      return data;
    });
  }

  function loadProfiles() {
    if (!EMAIL_GATEWAY_URL) {
      $('gateway-status').textContent = 'Gateway not configured. Previews work, but sending is disabled.';
      $('sender-profile').innerHTML = '<option value="">No gateway configured</option>';
      return Promise.resolve();
    }
    return callGateway({ action: 'listProfiles' }).then(function (data) {
      state.profiles = data.profiles || [];
      $('sender-profile').innerHTML = state.profiles.length
        ? state.profiles.map(function (p) {
            return '<option value="' + esc(p.profileId) + '">' + esc(p.displayName + ' <' + p.fromAddress + '>') + '</option>';
          }).join('')
        : '<option value="">No active sender profiles</option>';
      $('gateway-status').textContent = state.profiles.length
        ? 'Gateway connected.'
        : 'Gateway connected, but no active sender profiles are configured.';
    }).catch(function (err) {
      $('gateway-status').textContent = err.message || 'Could not reach sender gateway.';
    });
  }

  function send(mode) {
    validateRows();
    var profileId = $('sender-profile').value;
    var template = currentTemplate();
    var testRecipient = $('test-recipient').value.trim();

    if (!profileId) return alert('Choose a sender profile first.');
    if (mode === 'test' && !isEmail(testRecipient)) return alert('Enter a valid test recipient.');
    if (mode === 'bulk' && !state.validation.valid.length) return alert('No valid rows to send.');
    if (mode === 'bulk' && !confirm('Send ' + state.validation.valid.length + ' email(s)? Skipped rows will not be sent.')) return;

    var btn = mode === 'test' ? $('btn-test-send') : $('btn-send-all');
    btn.disabled = true;
    btn.textContent = mode === 'test' ? 'Sending...' : 'Sending batch...';

    callGateway({
      action: mode === 'test' ? 'sendTest' : 'sendBatch',
      profileId: profileId,
      testRecipient: testRecipient,
      template: template,
      mappings: state.mappings,
      skippedRows: state.validation.skipped,
      rows: state.validation.valid.map(function (r) { return { rowNumber: r.rowNumber, data: r.data }; })
    }).then(function (data) {
      var summary = data.summary || {};
      var skippedCount = typeof summary.skipped === 'number' ? summary.skipped : state.validation.skipped.length;
      $('send-summary').innerHTML =
        '<span>Sent: ' + (summary.sent || 0) + '</span>' +
        '<span>Skipped: ' + skippedCount + '</span>' +
        '<span>Errors: ' + ((summary.errors && summary.errors.length) || 0) + '</span>';
      renderSkips((summary.skippedRows || state.validation.skipped).concat(summary.errors || []));
    }).catch(function (err) {
      alert(err.message || 'Send failed.');
    }).finally(function () {
      btn.disabled = false;
      btn.textContent = mode === 'test' ? 'Send Test' : 'Send All';
    });
  }

  function wire() {
    var select = $('template-select');
    select.innerHTML = TEMPLATES.map(function (t, i) {
      return '<option value="' + i + '">' + esc(t.name) + '</option>';
    }).join('');
    select.addEventListener('change', function () {
      setTemplate(TEMPLATES[Number(this.value)] || TEMPLATES[0]);
    });

    ['email-subject', 'email-body'].forEach(function (id) {
      $(id).addEventListener('input', function () {
        renderMappings();
        validateRows();
      });
    });

    $('template-file').addEventListener('change', function () {
      var file = this.files && this.files[0];
      if (!file) return;
      file.text().then(function (text) {
        $('template-name').value = file.name.replace(/\.[^.]+$/, '');
        $('email-body').value = text;
        renderMappings();
        validateRows();
      });
    });

    $('recipient-file').addEventListener('change', function () {
      var file = this.files && this.files[0];
      if (!file) return;
      $('recipient-file-name').textContent = file.name;
      var ext = file.name.toLowerCase().split('.').pop();
      if ((ext === 'xlsx' || ext === 'xls') && global.XLSX) {
        file.arrayBuffer().then(function (buf) {
          var wb = global.XLSX.read(buf, { type: 'array' });
          var ws = wb.Sheets[wb.SheetNames[0]];
          var table = global.XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
          var parsed = tableToObjects(table);
          state.headers = parsed.headers;
          state.rows = parsed.rows;
          state.mappings = {};
          renderMappings();
          validateRows();
        });
      } else {
        file.text().then(function (text) {
          var parsed = parseCsv(text);
          state.headers = parsed.headers;
          state.rows = parsed.rows;
          state.mappings = {};
          renderMappings();
          validateRows();
        });
      }
    });

    $('btn-revalidate').addEventListener('click', validateRows);
    $('btn-test-send').addEventListener('click', function () { send('test'); });
    $('btn-send-all').addEventListener('click', function () { send('bulk'); });
  }

  function init() {
    PortalAuth.requireAdmin().then(function (profile) {
      if (!profile) return;
      PortalAuth.initNav(profile);
      $('test-recipient').value = profile.email || '';
      wire();
      setTemplate(TEMPLATES[0]);
      loadProfiles();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(typeof window !== 'undefined' ? window : this);
