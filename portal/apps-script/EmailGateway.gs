/**
 * Email automation gateway
 * ========================
 * Deploy as an Apps Script web app when the chapter wants the portal email
 * automation UI to send through the Google account that owns this script.
 *
 * Apps Script cannot connect to arbitrary SMTP servers. The browser-side portal
 * still uses a provider-agnostic gateway contract, so a future Node/Nodemailer,
 * SendGrid, Resend, or Mailgun backend can implement these same actions:
 * listProfiles, sendTest, and sendBatch.
 */

var FIREBASE_DB = 'https://thetatauzd-2ab25-default-rtdb.firebaseio.com';
var PROFILE_PROPERTY = 'EMAIL_SENDER_PROFILES';
var MAX_BATCH_SIZE = 200;

function doPost(e) {
  return handleEmailGateway(e);
}

function doGet(e) {
  return handleEmailGateway(e);
}

function handleEmailGateway(e) {
  try {
    var req = parseEmailRequest(e);
    var action = req.action || 'listProfiles';

    if (action === 'ping') return emailJson({ ok: true });
    if (action === 'listProfiles') return emailJson({ ok: true, profiles: publicProfiles(resolveAdmin(req.idToken)) });
    if (action === 'sendTest') return emailJson(sendTestEmail(req));
    if (action === 'sendBatch') return emailJson(sendBatchEmails(req));

    return emailJson({ ok: false, error: 'Unknown action: ' + action });
  } catch (err) {
    return emailJson({ ok: false, error: String(err && err.message || err) });
  }
}

function parseEmailRequest(e) {
  if (e && e.postData && e.postData.contents) {
    try { return JSON.parse(e.postData.contents); } catch (ignored) {}
  }
  return (e && e.parameter) || {};
}

function emailJson(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function resolveAdmin(idToken) {
  if (!idToken) throw new Error('Not signed in.');
  var uid = uidFromEmailToken(idToken);
  if (!uid) throw new Error('Could not read that sign-in token.');

  var url = FIREBASE_DB + '/users/' + encodeURIComponent(uid) + '.json?auth=' +
    encodeURIComponent(idToken);
  var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  var code = res.getResponseCode();
  if (code === 401 || code === 403) throw new Error('Your session expired. Sign in again.');
  if (code !== 200) throw new Error('Could not verify your account (' + code + ').');

  var rec = JSON.parse(res.getContentText() || 'null');
  if (!rec || rec.role !== 'admin') throw new Error('Admin access required.');

  return {
    uid: uid,
    email: rec.email || '',
    name: rec.name || '',
    role: rec.role || ''
  };
}

function uidFromEmailToken(idToken) {
  var parts = String(idToken).split('.');
  if (parts.length < 2) return null;
  try {
    var payload = Utilities.newBlob(
      Utilities.base64DecodeWebSafe(parts[1])
    ).getDataAsString();
    var obj = JSON.parse(payload);
    return obj.user_id || obj.sub || null;
  } catch (err) {
    return null;
  }
}

function getProfiles() {
  var raw = PropertiesService.getScriptProperties().getProperty(PROFILE_PROPERTY);
  if (!raw) {
    return [{
      profileId: 'chapter-default',
      displayName: 'Chapter default',
      providerType: 'apps_script_mail',
      fromAddress: Session.getEffectiveUser().getEmail(),
      replyTo: '',
      active: true
    }];
  }
  var parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

function publicProfiles(admin) {
  return getProfiles().filter(function (p) {
    return p && p.active !== false;
  }).map(function (p) {
    return {
      profileId: String(p.profileId || ''),
      displayName: String(p.displayName || p.profileId || 'Sender'),
      providerType: String(p.providerType || 'apps_script_mail'),
      fromAddress: String(p.fromAddress || admin.email || ''),
      replyTo: String(p.replyTo || ''),
      active: p.active !== false
    };
  });
}

function findProfile(profileId) {
  var profiles = getProfiles();
  for (var i = 0; i < profiles.length; i++) {
    if (String(profiles[i].profileId) === String(profileId) && profiles[i].active !== false) {
      return profiles[i];
    }
  }
  throw new Error('Sender profile not found or inactive.');
}

function sendTestEmail(req) {
  var admin = resolveAdmin(req.idToken);
  var profile = findProfile(req.profileId);
  var testRecipient = String(req.testRecipient || '').trim();
  if (!isValidEmailAddress(testRecipient)) throw new Error('Valid test recipient required.');

  var sample = firstRow(req.rows);
  var rendered = renderEmail(req.template || {}, req.mappings || {}, sample.data || {});
  sendOne(profile, testRecipient, rendered.subject, rendered.body);

  return {
    ok: true,
    summary: {
      totalRows: 1,
      sent: 1,
      skipped: 0,
      skippedRows: [],
      errors: [],
      requestedBy: admin.email
    }
  };
}

function sendBatchEmails(req) {
  var admin = resolveAdmin(req.idToken);
  var profile = findProfile(req.profileId);
  var rows = Array.isArray(req.rows) ? req.rows.slice(0, MAX_BATCH_SIZE) : [];
  var summary = {
    totalRows: rows.length,
    sent: 0,
    skipped: 0,
    invalidEmail: 0,
    skippedRows: Array.isArray(req.skippedRows) ? req.skippedRows : [],
    errors: [],
    requestedBy: admin.email
  };

  rows.forEach(function (item) {
    try {
      var row = item.data || {};
      var rendered = renderEmail(req.template || {}, req.mappings || {}, row);
      var email = recipientEmail(req.mappings || {}, row);

      if (!isValidEmailAddress(email)) {
        summary.invalidEmail++;
        summary.skippedRows.push({ row: item.rowNumber || '', reason: 'invalid_email', email: email || '' });
        return;
      }
      if (rendered.missing.length) {
        summary.skippedRows.push({ row: item.rowNumber || '', reason: 'missing_required_value', variable: rendered.missing[0], email: email });
        return;
      }

      sendOne(profile, email, rendered.subject, rendered.body);
      summary.sent++;
    } catch (err) {
      summary.skipped++;
      summary.errors.push({ row: item.rowNumber || '', reason: 'provider_error', error: String(err && err.message || err) });
    }
  });

  summary.skipped = summary.skippedRows.length + summary.errors.length;
  return { ok: true, summary: summary };
}

function firstRow(rows) {
  if (Array.isArray(rows) && rows.length) return rows[0];
  return { rowNumber: 0, data: {} };
}

function recipientEmail(mappings, row) {
  var key = mappings.email || mappings.Email || 'email';
  return String(row[key] || '').trim();
}

function renderEmail(template, mappings, row) {
  var missing = [];
  function render(text) {
    return String(text || '').replace(/\{\{\s*([a-zA-Z0-9_ .-]+)\s*\}\}/g, function (_, name) {
      var variable = String(name).trim();
      var key = mappings[variable];
      var value = key ? row[key] : '';
      if (!String(value || '').trim()) missing.push(variable);
      return String(value || '');
    });
  }

  var subject = render(template.subject || '');
  var body = render(template.body || '');
  if (!subject.trim()) throw new Error('Subject is required.');
  if (!body.trim()) throw new Error('Body is required.');

  return { subject: subject, body: body, missing: unique(missing) };
}

function sendOne(profile, to, subject, body) {
  var provider = String(profile.providerType || 'apps_script_mail');
  if (provider !== 'apps_script_mail') {
    throw new Error('Provider "' + provider + '" is not supported by this Apps Script gateway.');
  }

  var options = {
    name: profile.displayName || undefined,
    replyTo: profile.replyTo || undefined
  };
  MailApp.sendEmail(to, subject, body, options);
}

function isValidEmailAddress(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function unique(items) {
  var seen = {};
  var out = [];
  items.forEach(function (item) {
    if (!seen[item]) {
      seen[item] = true;
      out.push(item);
    }
  });
  return out;
}

/**
 * Optional helper to create or replace profile metadata from the Apps Script
 * editor. Do not put passwords here. For this Apps Script gateway, messages are
 * sent by the script owner's Google account.
 */
function configureEmailProfiles() {
  var profiles = [{
    profileId: 'chapter-default',
    displayName: 'Theta Tau Zeta Delta',
    providerType: 'apps_script_mail',
    fromAddress: Session.getEffectiveUser().getEmail(),
    replyTo: '',
    active: true
  }];
  PropertiesService.getScriptProperties().setProperty(PROFILE_PROPERTY, JSON.stringify(profiles));
}
