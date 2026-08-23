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

## Deploy

1. Open the Tracker spreadsheet → **Extensions → Apps Script**.
2. Replace `Code.gs` with [`Code.gs`](Code.gs) from this folder.
3. **Deploy → New deployment → Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**

   "Anyone" is required for the browser to reach it. The token check above is what
   protects the data, not this setting.
4. Authorize when prompted (it needs to read the sheet and call out to Firebase).
5. Copy the `/exec` URL.
6. Paste it into `portal/js/tracker.js` as `GATEWAY_URL`, then commit and push.

After **any** edit to `Code.gs`, re-deploy with
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
