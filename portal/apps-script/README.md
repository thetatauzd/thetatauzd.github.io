# Apps Script gateways

There are **three**, each bound to a different spreadsheet and each with its own
deployment and `/exec` URL:

| File | Lives in | Serves |
|---|---|---|
| [`Gateway.gs`](Gateway.gs) | **F26 Theta Tau Tracker** | A brother's own demerits and payments (`me`), and the admin-only full export behind **Refresh from sheet** (`exportAll`) |
| [`RosterGateway.gs`](RosterGateway.gs) | **Brother list** (the chapter roll) | Roll number ↔ name, for sign-up autofill |
| [`NewsletterGateway.gs`](NewsletterGateway.gs) | **Newsletter Subscribers** (owned by thetatauusc@gmail.com) | The newsletter email list: public `subscribe` and `unsubscribe`, and the admin-only `notify` and `status` behind **Email subscribers** |

They verify callers differently, and the reason matters:

- The **Tracker** gateway reads the caller's own record from the Realtime
  Database, so the database rules do the verifying. That requires the caller to
  already have a portal account.
- The **Roster** gateway can't do that — someone signing up has no portal account
  yet, which is the entire point of it. So it verifies the Firebase token
  directly with Google instead. A valid Google sign-in is required; a portal
  account is not.

The roster gateway never returns Phone or Email, and has no "list everyone"
action — every call is one exact match, so it can't be used to pull the roll down
in bulk.

The **Newsletter** gateway's `subscribe` is open to anyone (it can only add an
address), and `unsubscribe` needs the secret token from that person's email. Its
`notify` and `status` check admins the same way as the Tracker gateway. See
[Newsletter sign-up gateway](#newsletter-sign-up-gateway) below.

---

# Theta Tau Tracker gateway — setup

The portal shows each brother their own demerits and payment balance. The data
lives in the **F26 Theta Tau Tracker** Google Sheet; this Apps Script is what lets
the portal read one brother's row without making the sheet public.

## Why not just publish the sheet

A published sheet is readable by **anyone with the link, with no login**. That is
fine for a newsletter and not fine for balances and demerits. This gateway keeps
the sheet private and makes the portal the only way in.

## How a brother is identified

Roll number is the key, and a brother cannot ask for someone else's:

1. The portal sends the brother's Firebase ID token.
2. The gateway uses **that token** to read `users/{uid}` from the Realtime
   Database. Your existing rule only allows a user to read their own record, so
   the database refuses anything else — no service-account key needed.
3. The roll number on that record is trusted, and everything else is looked up
   from it.

## ⚠️ Before you touch the Apps Script project

The Tracker's existing `Code.gs` is the **template builder** that originally created
these tabs. Two things follow from that:

**1. Do not paste the gateway over `Code.gs`.** Add it as a *separate* file
instead — the two share no function or variable names (verified), so they sit
side by side happily. Overwriting `Code.gs` would destroy the builder.

**2. The "Build / Rebuild Template" menu item is dangerous now.** It calls
`resetWorkbook_`, which **deletes every sheet in the workbook** and recreates
blank ones. One stray click from an exec member wipes the chapter's payment
records, demerits and roster.

It is also now out of sync with your live sheet, so re-running it would *undo*
work you've already done:

| Live workbook | What the builder would recreate |
|---|---|
| `Roster` has **Roll Number** | Rebuilt as `Committee(s)` — roll numbers gone |
| Tab named `DemeritDashboard` | Renamed back to `Dashboard` |
| Dashboard has a **Rollover Demerits** column | Dropped |
| `S26 Rollover Demerits` tab | Deleted |

Worth deleting that menu item, or renaming the function so it can't be run by
accident. The gateway reads the sheet and never writes to it, so it can't cause
this — but the builder still can.

## Deploy

1. Open the Tracker spreadsheet → **Extensions → Apps Script**.
2. Click **+ → Script**, name the file `Gateway`, and paste in
   [`Gateway.gs`](Gateway.gs) from this folder. Leave `Code.gs` alone.
3. **Deploy → New deployment → Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**

   "Anyone" is required for the browser to reach it. The token check above is what
   protects the data, not this setting.
4. Authorize when prompted (it needs to read the sheet and call out to Firebase).
5. Copy the `/exec` URL.
6. Paste it into `portal/js/tracker.js` as `GATEWAY_URL`, then commit and push.

After **any** edit to `Gateway.gs`, redeploy it as a new version of the same
deployment (see [Redeploy](#redeploy) below), or the old version keeps serving.

## Sheet expectations

Read from the tabs you already have:

| Tab | Used for |
|---|---|
| `Roster` | Name ↔ Roll Number. This is the bridge between the portal and the sheet. |
| `Payments_Fines` | Balance due, amount paid, and the line-item history. |
| `DemeritDashboard` | Demerit totals per brother. |
| `Standards_Adjustments` | The individual entries behind the standards number. |
| `Service_Hours` | Service hours (the live sheet has it). |
| `Demerit_Rules` | Rates, thresholds and the service requirement. Only `exportAll` reads it. |
| `Event_Info`, `Attendance`, `Excuses` | Events and attendance. Only `exportAll` reads them. |

Header rows are found by looking for `Brother Name`, so the title rows above
`DemeritDashboard`'s header are fine. Blank spacer rows are skipped, and roll
numbers stored as `396.0` are normalised to `396`.

## Making roll number the real key

Every tab currently keys on `Brother Name`, which breaks the moment a name is
typed two ways. The gateway already prefers a **`Roll Number`** column when a tab
has one and only falls back to name matching when it doesn't — so you can migrate
one tab at a time with nothing breaking in between.

Recommended: add a `Roll Number` column to `Payments_Fines` and
`Standards_Adjustments`, filled by formula so nobody has to type it:

```
=IFERROR(VLOOKUP($A2, Roster!$A:$B, 2, FALSE), "")
```

Exec keeps picking names from the dropdown; the roll number fills itself in.

## Service hours tab

The live sheet has a `Service_Hours` tab with these columns (My Tracker hides the
service section on a workbook without it):

| Brother Name | Roll Number | Event | Date | Hours | Confirmed |
|---|---|---|---|---|---|

For My Tracker (`me`), `Confirmed` counts as yes for `Y`, `Yes`, `TRUE`,
`Confirmed`, or `Approved`. The sheet's own DemeritDashboard and the Refresh from
sheet copy count only a ticked box (`TRUE`), so tick the box rather than typing.
Only confirmed rows are added to the total; everything else shows as Pending.

## Refresh from sheet (`exportAll`, version 2)

While the sheet is the record, officers preview the new Chapter Ops pages from a
copy of it. An admin makes the copy on **Admin → Refresh from sheet**
(`portal/import.html`), and it also runs on its own when an admin opens a preview
page and the copy is more than a day old. Brothers are not affected: My Tracker
keeps reading the sheet through `me`.

`exportAll` is admin only (the same database check as `me`, then `role === 'admin'`).
It returns `{ ok, version: 2, exportedAt, tabs }`, one entry per tab:
`{ tab, found, headers, rows }`, dates as `yyyy-MM-dd` in the spreadsheet's time zone.

| Export key | Tab read (first that exists) |
|---|---|
| `Roster` | `Roster` |
| `Demerit_Rules` | `Demerit_Rules`, else `Config` |
| `Event_Info` | `Event_Info` |
| `Attendance` | `Attendance` |
| `Payments_Fines` | `Payments_Fines` |
| `Standards_Adjustments` | `Standards_Adjustments` |
| `Service_Hours` | `Service_Hours`, else `Service_Log` |
| `Excuses` | `Excuses` |
| `DemeritDashboard` | `DemeritDashboard`, else `Dashboard` (the sheet's own totals, used to check the copy) |
| `Rollover` | any tab with "rollover" in its name (`S26 Rollover Demerits`) |

Version 1 (before November 2026) asked for `Config` and `Service_Log`, which the
live sheet does not have, so both came back empty, and it did not send
`DemeritDashboard`. The portal refuses a version 1 export and says the gateway
needs redeploying, so nothing is copied until the new version is live.

## Redeploy

Do this after every change to `Gateway.gs`. The `/exec` URL must stay the same,
because `portal/js/tracker.js` and `portal/js/sheet-sync.js` both call it.

1. Open the **F26 Theta Tau Tracker** → **Extensions → Apps Script**.
2. Open the `Gateway` file (not `Code.gs`), select everything, and paste in the new
   [`Gateway.gs`](Gateway.gs). Press **Save** (the disk icon).
3. **Deploy → Manage deployments**. Pick the existing **Web app** deployment and
   press the pencil (**Edit**).
4. Under **Version**, choose **New version**. Leave *Execute as: Me* and
   *Who has access: Anyone* as they are. Press **Deploy**.
5. If Google asks to authorize again, allow it (it reads the sheet and calls Firebase).
6. Check: open the `/exec` URL with `?action=ping` on the end. It must list the tabs
   and say `"version":2`. The Refresh from sheet page also shows "Gateway: Up to date".

Do **not** press **Deploy → New deployment**: that creates a second, different
`/exec` URL that the portal does not use, and the old version keeps serving.

## Checking it works

Visit the `/exec` URL with `?action=ping` on the end. You should get the list of
tab names back, and `"version":2` once the current `Gateway.gs` is deployed. If you get an error page instead, the deployment's access is
probably not set to **Anyone**.

---

# Chapter roll gateway — setup

Bound to the **brother list** spreadsheet, not the Tracker. This is a brand-new
Apps Script project, so there is nothing to preserve — paste it straight into
`Code.gs`.

1. Open the **brother list** spreadsheet → **Extensions → Apps Script**.
2. Paste in [`RosterGateway.gs`](RosterGateway.gs).
3. **Deploy → New deployment → Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
4. Authorize when prompted.
5. Copy the `/exec` URL — it goes into the sign-up page as `ROSTER_GATEWAY_URL`.

## Expected columns

Row 1 of the first tab, matched by name:

| Roll Number | Name |
|---|---|

Everything else on that sheet (`PC`, `Major`, `Graduation`, `Executive Roles`,
`Phone`, `Email`) is ignored and never loaded into memory. If the roll ever moves
to a different tab, set `ROLL_SHEET_NAME` at the top of the script.

Roll numbers are normalised, so `396`, `"396"` and `396.0` all match, and
non-numeric entries like `1XX` are handled as-is.

## What it returns

One exact match at a time, either direction:

- Given a roll number → that brother's name
- Given a name → that brother's roll number

If two brothers share a name it reports `ambiguous` rather than guessing, so
nobody ends up with the wrong roll number stamped on their portal account.

## Checking it works

Add `?action=ping` to the `/exec` URL. You should get back the row count of the
roll — no names, no contact details. `ping` is the only action that does not
require a sign-in token, and it deliberately returns nothing but a number.

---

# Newsletter sign-up gateway

A third gateway, separate from the two above. It has its own Google Sheet and its
own Apps Script project. The file is [`NewsletterGateway.gs`](NewsletterGateway.gs).

It runs two buttons:

- **Subscribe** on the public Newsletters page (`newsletter.html`). A visitor types
  their email and it goes into the Sheet.
- **Email subscribers** on the portal's Newsletters admin page. After an admin posts
  an issue, they press it. Everyone on the list gets one email with the link.

Every email has an unsubscribe link. It opens the Newsletters page, which asks the
person to press **Unsubscribe**. Nothing happens on page load, because mail
filters (USC's Microsoft 365 among them) open links in emails to scan them.
Nobody gets an email when they sign up. That way nobody can use the form to make
the chapter email a stranger.

## Who owns it

The chapter Gmail, **thetatauusc@gmail.com**, owns the Sheet and the script. Apps
Script sends mail as the account that owns it. The USC mailbox
(sotheta@mailbox.sc.edu) is Microsoft 365, so Apps Script cannot send from it.
Emails go out as "Theta Tau Zeta Delta". Replies go to sotheta@mailbox.sc.edu.

No email address goes into Firebase or this repository. The Sheet is the list.

## Setup (once)

Do all of this signed in as thetatauusc@gmail.com. If your browser is signed in to
other Google accounts too, use a private window, so nothing is made under the
wrong account.

1. Go to sheets.google.com and make a blank spreadsheet. Name it
   **Newsletter Subscribers**.
2. **Extensions → Apps Script**. Name the project "Newsletter gateway".
3. Select everything in `Code.gs` and paste in
   [`NewsletterGateway.gs`](NewsletterGateway.gs). Press **Save**. This project is
   new, so there is nothing to keep. Never paste this file into the Tracker's
   project: both define `doGet` and `doPost`.
4. Pick **setup** in the function menu at the top and press **Run**. Google asks for
   permission. Allow it. The script needs to edit this one spreadsheet, send email
   as you, and connect to Firebase to check admins. If Google says the app is not
   verified, press **Advanced**, then **Go to Newsletter gateway**. That is normal
   for a script you made yourself.
   The log should say `Ready. Tabs: Subscribers and Sends. Emails left today: 100.`
   (the number can differ). You can delete the empty `Sheet1` tab.
5. Optional: run **sendTestEmail**. It sends one sample to thetatauusc@gmail.com so
   you can see how it looks. Its unsubscribe link is a sample and says it is not
   valid.
6. **Deploy → New deployment**. Press the gear and pick **Web app**.
   - Execute as: **Me**
   - Who has access: **Anyone**

   Press **Deploy**. "Anyone" is needed so the public page can reach it. The admin
   check inside the script is what protects sending, not this setting.
7. Copy the **Web app URL**. It ends in `/exec`.
8. Open that URL with `?action=ping` on the end. You should see
   `{"ok":true,"version":2}`. If you get a Google sign-in page or an error, the
   access is probably not set to **Anyone**.
9. Paste the URL into `js/newsletter-config.js` as `NEWSLETTER_GATEWAY_URL`. Bump
   the `?v=` wherever that file is loaded (`newsletter.html` and
   `portal/newsletters-admin.html`). Commit and push. Until then, the public page
   says "Email sotheta@mailbox.sc.edu to get on the list" and the portal button
   says the script is not deployed yet.

## Redeploy after a change

Deploy → Manage deployments → pencil (**Edit**) → Version: **New version** →
**Deploy**. That keeps the `/exec` URL. Do not press New deployment again: it makes
a new URL the site does not know, and the old version keeps serving. Then check
`?action=ping` again.

The ping shows the version (`NEWSLETTER_GATEWAY_VERSION` at the top of the script, now `{"ok":true,"version":2}`), so if it shows an older number, the live copy is not the one in this repository yet. Raise that number with every change.

Before pasting a changed file, run `node scripts/newsletter-tests.js`. Every line
must say OK.

## What the Sheet holds

The script makes both tabs the first time it runs. Row 1 is the header. You can
move columns or add your own. The script finds columns by their header.

**Subscribers** has one row per email:

| Column | What it is |
|---|---|
| `email` | Lowercased and trimmed |
| `name` | Optional, from the form. Never used in an email, since anyone can type any name |
| `status` | `active` or `unsubscribed`. Blank counts as active. Anything else (for example `removed` or `paused`) gets no email, and the sign-up form cannot change it back |
| `subscribedAt` | When they signed up, or signed up again |
| `unsubscribedAt` | When they unsubscribed. Blank while active. On a `removed` or `paused` row, when they used the unsubscribe link (the link does not change that status) |
| `token` | The secret in their unsubscribe link. Do not edit or share it |
| `source` | Where they signed up (`newsletter-page`) |

**Sends** has one row per email sent: `newsletterId` (the issue's id under
`newsletters/` in Firebase), `email` and `sentAt`. This is how the script knows who
already has an issue. Leave these rows alone. If the rows for an issue are deleted
and someone presses Email subscribers on it again, everyone gets it again.

## Sending an issue

1. Post the issue on the Newsletters admin page as usual.
2. Press **Email subscribers** on that issue.
3. The script emails each active subscriber who does not have that issue yet. Each
   person gets their own email, so nobody sees the list.
4. If it says some are still to go, press it again. Wait for the next day only if it
   says Gmail's daily limit is used up. It picks up where it stopped. Nobody gets the
   same issue twice.
5. If it says Gmail turned down some addresses, find those rows: sign in as
   thetatauusc@gmail.com, open the script (Extensions → Apps Script from the Sheet),
   then **Executions** on the left. The latest `doPost` run's log names each refused
   row by number. Fix a typo in the `email` cell, or set the row's `status` to
   `removed` if the address is junk. If it says Gmail is not taking emails right now,
   the rows are fine: try again later.

The link in the email must start with `https://` and go to drive.google.com or
thetatauzd.org.

## Quota

- A free Gmail account can email about **100 people a day** from Apps Script. The
  count refreshes once a day, not always at midnight. The script asks Gmail how
  many are left and never sends more.
- `sendTestEmail` uses the same quota. Mail you send by hand in Gmail does not.
- One press sends at most 150 and stops after 4.5 minutes, because Apps Script stops
  any run at 6 minutes.
- So 300 subscribers means an issue takes 3 days. If the list grows well past that,
  the options are a Google Workspace account (about 1,500 a day) or a mailing
  service.
- Sign-ups are capped at 10 a minute, 30 an hour and 75 a day (UTC) for the whole
  list. That keeps a bot from adding more rows in a day than Gmail can email. If
  real sign-ups hit the cap (say, right after a post asking alumni to sign up),
  raise `SIGNUPS_PER_MINUTE`, `SIGNUPS_PER_HOUR` and `SIGNUPS_PER_DAY` at the top of
  the script and redeploy. The daily count lives in Script Properties
  (`nl:rate:day`), because the cache forgets after 6 hours.

## Adding people by hand

To add people who already get the newsletter another way, paste their addresses
into the `email` column of **Subscribers**, one per row, under the last row. Leave
the other columns blank. A blank status counts as active, and the script gives each
row an unsubscribe token before the next send. Only add people who asked for the
newsletter or expect it.

## Take someone off, export, clean up

- **Take someone off**: set their `status` to `unsubscribed`. They can sign up
  again on the page. To keep an address off for good (a bot, a bounce, someone who
  asked), set `status` to `removed`: the form then answers "That address can't be
  added from this page" and changes nothing. The unsubscribe link does not change
  a `removed` or `paused` status either; it only fills in `unsubscribedAt`. So
  before you set such a row back to `active`, look at `unsubscribedAt`: a date
  there means the person asked to leave. If they want to be forgotten
  entirely, delete their row (and their rows in Sends).
- **Export**: on the Subscribers tab, File → Download → Comma-separated values
  (.csv). Or filter `status` to `active` and copy the `email` column. Keep the copy
  private and delete it when you are done.
- **Clean up**: rows with a bad address never get mail. Delete junk rows (a bot that
  got through) or set them to `removed` before you press Email subscribers. The
  portal's confirm box says how many people signed up since the last email; a
  number far above normal means bots. If one address has two rows and either one
  says `unsubscribed`, that person gets nothing.

## Privacy

- The Sheet holds personal email addresses. Keep it private. Share it with as few
  people as possible, and never as "Anyone with the link".
- Never commit the Sheet, an export of it, or any address from it to this
  repository. The repository is public.
- The public page can only add an address, or unsubscribe one with its token. It
  cannot read the list. The admin actions return counts, never addresses.
- The script can open only this one spreadsheet (`@OnlyCurrentDoc` at the top).

## Actions

Every call is a POST with a JSON body sent as `text/plain` (no CORS preflight). GET
answers only `?action=ping`. Replies are `{ "ok": true, ... }` or
`{ "ok": false, "code": ..., "error": ... }`.

| Action | Who | Sends | Gets back |
|---|---|---|---|
| `ping` | anyone | nothing | `version: 2` |
| `subscribe` | anyone | `email`, `name` (optional), `website` (honeypot, must be empty), `source` | `status`: `subscribed`, `already`, `resubscribed` or `held` (an admin set another status; nothing written). Errors: `invalid-email`, `rate-limited`, `bot` |
| `unsubscribe` | anyone with the link | `token` | `status`: `unsubscribed` or `already`. Only active rows become `unsubscribed`; a `removed` or `paused` row keeps its status and gets `unsubscribedAt`, and with no active row the answer is `already`. Error: `unknown-token` |
| `notify` | admins | `idToken`, `newsletterId`, `title`, `url` | `sent`, `total`, `alreadySent`, `remaining`, `quotaLeft`, `done`, `failed`, `badAddresses` |
| `status` | admins | `idToken` | `active`, `unsubscribed`, `newSinceLastSend`, `quotaLeft`, `issues: { <newsletterId>: { sent, total } }` |

A filled honeypot gets `subscribed` and nothing is written. Any action can also
return `bad-request`, `busy` or `server-error`. The admin actions can also return
`not-signed-in`, `not-admin` and (notify) `bad-url`.

For notify: `total` is everyone active now. `alreadySent` is how many of them had
the issue before this press. `sent` is this press. `remaining` is still to go.
`done` is true when everyone active has it. `failed` counts addresses Gmail refused
this press. They stay in `remaining` and are tried again next press, and they do
not count against the press's limit, so a bad address cannot use up a press.
`badAddresses` is how many of those refusals named the address (a bad row). The
others are Gmail refusing every email (a restricted account, a Gmail outage): after
5 of those in a row with nothing sent between them (`MAX_REFUSALS_IN_A_ROW`), the
press stops. Bad rows never stop a press, however many there are in a row. For
status, `unsubscribed` counts everyone who gets no email, and `newSinceLastSend`
counts active subscribers who signed up after the last press that sent something
read the list. That time is the Script Property `nl:lastPlanAt`, saved by notify,
so people who signed up while a press was sending count as new. Without it (before
the first send under version 2), it counts from the newest row in Sends, and
before any send it counts everyone with a sign-up date.

Admins are checked the same way as the Tracker gateway: the script reads
`users/{uid}.json?auth=<idToken>` from the Realtime Database, and `role` must be
`admin`.

## Limits worth knowing

- There is no confirmation email. Anyone can type anyone's address, including an
  address that unsubscribed. That person gets nothing until the next issue, and
  every issue has the unsubscribe link. The honeypot and the caps keep most bots
  out. Look over new rows before you press Email subscribers.
- Names never start with `=`, `+`, `-` or `@` (the script drops those), so a CSV
  export opened in Excel cannot run a formula someone typed into the form.
- The answer `already` tells a visitor that an address is on the list.
- The first emails may land in spam. Ask readers to add thetatauusc@gmail.com to
  their contacts.
- Apps Script cannot add the `List-Unsubscribe` header, so Gmail's own unsubscribe
  button will not show. The link at the bottom of each email is the way out.
