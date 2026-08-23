# Apps Script gateways

There are **two**, each bound to a different spreadsheet and each with its own
deployment and `/exec` URL:

| File | Lives in | Serves |
|---|---|---|
| [`Gateway.gs`](Gateway.gs) | **F26 Theta Tau Tracker** | A brother's own demerits and payments |
| [`RosterGateway.gs`](RosterGateway.gs) | **Brother list** (the chapter roll) | Roll number ↔ name, for sign-up autofill |

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

After **any** edit to `Gateway.gs`, re-deploy with
**Deploy → Manage deployments → ✏️ → Deploy**, or the old version keeps serving.

## Sheet expectations

Read from the tabs you already have:

| Tab | Used for |
|---|---|
| `Roster` | Name ↔ Roll Number. This is the bridge between the portal and the sheet. |
| `Payments_Fines` | Balance due, amount paid, and the line-item history. |
| `DemeritDashboard` | Demerit totals per brother. |
| `Standards_Adjustments` | The individual entries behind the standards number. |
| `Service_Hours` | **Optional and not created yet** — see below. |

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

## Adding service hours later

The portal hides the service-hours section until the tab exists. Create a tab
named `Service_Hours` with these columns and it appears on its own:

| Brother Name | Roll Number | Event | Date | Hours | Confirmed |
|---|---|---|---|---|---|

`Confirmed` counts as yes for `Y`, `Yes`, `TRUE`, `Confirmed`, or `Approved`.
Only confirmed rows are added to the total; everything else shows as Pending.

## Checking it works

Visit the `/exec` URL with `?action=ping` on the end. You should get the list of
tab names back. If you get an error page instead, the deployment's access is
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
