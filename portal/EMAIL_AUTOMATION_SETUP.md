# Email Automation Setup

The admin tool lives at `/portal/email-automation.html`.

It supports:

- starter templates
- custom `.txt` template uploads
- CSV and Excel recipient uploads
- placeholder-to-column mapping
- preview from the first valid row
- test send
- bulk send
- skipped-row summaries

## Gateway URL

Actual sending is disabled until `EMAIL_GATEWAY_URL` is set in
`portal/js/email-automation.js`.

The browser never stores sender passwords, SMTP secrets, or API keys. It only
builds the payload and calls the configured backend gateway.

## Included Apps Script Gateway

`portal/apps-script/EmailGateway.gs` is a deployable Google Apps Script gateway.
It verifies the Firebase ID token, requires the caller to be a portal `admin`,
renders each email on the backend, sends valid rows, and reports skipped rows.

Apps Script cannot connect to arbitrary SMTP servers. This implementation sends
through the Google account that owns the script by using `MailApp`. The portal
uses a generic gateway contract (`listProfiles`, `sendTest`, `sendBatch`), so a
future Node/Nodemailer, SendGrid, Mailgun, Resend, or Microsoft Graph backend can
replace it without redesigning the page.

## Deploy Apps Script

1. Create a new Apps Script project.
2. Paste in `portal/apps-script/EmailGateway.gs`.
3. Run `configureEmailProfiles` once if you want the default profile metadata in
   Script Properties.
4. Deploy -> New deployment -> Web app.
5. Set `Execute as` to `Me`.
6. Set `Who has access` to `Anyone`.
7. Authorize the requested scopes.
8. Copy the `/exec` URL into `EMAIL_GATEWAY_URL` in
   `portal/js/email-automation.js`.

Sender profile metadata is stored in Script Properties under
`EMAIL_SENDER_PROFILES`. Do not put SMTP passwords or API keys there for this
Apps Script gateway. Use a real server-side SMTP/API backend for provider
secrets.

## Basic Tests

Run these after setup, in this order.

### 1. Static Syntax Checks

From the repo root:

```powershell
node --check portal/js/email-automation.js
node --check portal/js/auth.js
Get-Content -Raw -LiteralPath "portal/apps-script/EmailGateway.gs" | node --check --input-type=commonjs
```

These checks catch JavaScript syntax errors before opening the portal. The
`.gs` file is Apps Script JavaScript, so it is checked through stdin instead of
directly by extension.

### 2. Local Visual Smoke Test

Start a local static server:

```powershell
npx http-server -p 8080
```

Open `http://localhost:8080/portal/email-automation.html`.

Check:

- unauthenticated users are redirected to login
- non-admin users cannot access the page
- admins can open the page from the Admin dropdown
- the layout fits at desktop width
- the layout fits at mobile width around 390px wide
- text does not overlap in the sender bar, mapping panel, preview panel, or
  summary panel
- upload controls, buttons, and dropdowns are readable and clickable

The page may show `Gateway not configured` until `EMAIL_GATEWAY_URL` is set.
That is expected; preview and validation can still be tested.

### 3. Recipient Import and Validation Test

Create a small CSV locally:

```csv
first_name,last_name,email,chapter,event_name,date,deadline
Alex,Smith,alex@example.com,Zeta Delta,Recruitment Night,Sep 10,Sep 12
Bad,Email,not-an-email,Zeta Delta,Recruitment Night,Sep 10,Sep 12
Missing,Date,missing-date@example.com,Zeta Delta,Recruitment Night,,Sep 12
```

Upload it in the recipient panel.

Check:

- headers appear in the mapping dropdowns
- `{{first_name}}`, `{{chapter}}`, `{{event_name}}`, and similar placeholders
  auto-map when matching columns exist
- the valid count includes only complete rows with a valid email address
- invalid rows appear in the skipped-row list
- the preview renders using the first valid row
- changing a mapping immediately updates the preview and validation counts

### 4. Gateway Integration Test

After deploying `EmailGateway.gs` and setting `EMAIL_GATEWAY_URL`, reload the
portal page as an admin.

Check:

- the sender selector loads at least one active sender profile
- the status changes from `Gateway not configured` to `Gateway connected`
- browser DevTools Network shows the `listProfiles` request returning `ok: true`
- using a non-admin account returns an admin-access error from the gateway

You can also visit the deployed `/exec` URL with `?action=ping`. It should
return:

```json
{"ok":true}
```

### 5. Email Functionality Test

Use only your own address or a small internal test alias.

1. Upload the sample CSV above.
2. Map all required placeholders.
3. Put your own address in `Test recipient`.
4. Click `Send Test`.
5. Confirm one email arrives and the subject/body match the preview.

Then test skip behavior:

1. Keep the same sample CSV.
2. Click `Send All`.
3. Confirm only the valid row sends.
4. Confirm the summary reports sent and skipped counts.

Do not test bulk sending with a real recruitment or chapter list until the test
recipient flow, skipped-row behavior, and sender identity have all been checked.

### 6. Integration Regression Test

After adding the email gateway URL, quickly check these existing portal paths:

- `/portal`
- `/portal/admin`
- `/portal/newsletters-admin`
- `/portal/voting`
- `/portal/tracker`

Check:

- the Admin dropdown still opens
- `Email Automation` appears for admins
- sign-out still works
- existing admin pages still pass their role checks
- Firebase-authenticated pages still remove the loading wall after auth resolves
