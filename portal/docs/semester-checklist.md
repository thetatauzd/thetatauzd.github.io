# Semester checklist

File locations (old tracker sheets, Budget, form responses, Apps Script projects): exec Drive →
"Portal handoff: file locations". Ask the Technology Chair for access.

## Fall 2026: the Tracker sheet is the record
Until the switch below, officers work on the Tracker sheet and brothers use the Google Forms. The Chapter Ops pages
are a read-only preview of a copy of the sheet. So this semester:
- The steps below that use the officer pages (Semester Setup, charging dues, the Marshal's class, Chapter Settings)
  wait until the switch. User Management works as usual.
- An admin presses **Refresh from sheet** whenever the preview should catch up (Admin menu, or the button in the
  yellow note on any preview page). It also runs on its own when an admin opens a preview page and the copy is more
  than a day old. Refreshing is always safe and can be repeated: each refresh replaces the whole copy for the term,
  and the sheet itself never changes.
- Before the first refresh, Gateway.gs must be redeployed as a new version (`portal/apps-script/README.md`).

## Start of semester (Technology Chair + Standards Chair, the week before the first chapter)
1. **User Management**: approve pending sign-ups. Set every returning member's status (Active / Co-op / Abroad /
   Inactive / Alumni). Graduated last term → Alumni. Co-op or abroad and back → Active.
2. **User Management**: positions for the new exec board and chairs. Remove positions from people who left them.
3. **Semester Setup → 1** (signed in as the Standards Chair or an admin): new term code (F27 / S27), label, dates,
   dues due date → **Preview**.
   CHECK: the preview lists last term's real service shortfalls, normally a handful of brothers, not everyone.
   Then **Start the semester**. There is no undo, so check the preview carefully.
4. **Semester Setup → 2**: weekly chapters (first and last date, day, time, skipped weeks) → **Add these to the list
   below** → fix titles and types (voting chapters!) → add rush events, initiation, philanthropy, committee meetings →
   **Create these events**.
5. **Treasurer**: confirm dues were charged, or charge them when the national invoice arrives.
6. **Marshal**: create the pledge class after bid day.
7. **Semester Setup → 3** (admin): download the zip of the closed semester's photos to the chapter Drive, then
   **Clear photos**.
8. **Chapter Settings**: change numbers only if the bylaws changed. Write the bylaw section in the note.

## End of semester
1. Standards: no pending excuses. Service Chair: no pending entries.
2. Standards Board → **Download term backup (JSON)** → save to the chapter Drive folder "Portal backups/<term>".
3. Treasurer → **Export to Excel** → same folder.

## Officer change (elections)
- User Management → edit positions on the old and the new holder. Permissions update the next time each person loads
  a page.
- If the chapter changed what a position may do (Chapter Settings → Positions), press **Refresh everyone's
  permissions** on User Management afterwards. Until then their stored permissions are the old ones.
- After initiation: the Marshal or any exec officer adds the new class to the Family Tree (menu → Family Tree →
  open each big → + Add a little). Export a picture for the chapter Instagram and download a backup file.
- Each new officer reads their section of `portal/docs/officer-guide.md` (Chapter Ops menu → Officer guide).
- Officers this semester (sheet mode): a new position shows the Chapter Ops preview pages it may read. Their work
  stays on the Tracker sheet until the switch.

## Switching the record to the site (planned for Spring 2027)
Do this once, between semesters, signed in as an admin. There is a way back (switch to the Tracker sheet again), but
the next refresh then replaces whatever officers typed on the site.
1. Pick a date and tell every officer to stop editing the Tracker sheet from then on.
2. **Refresh from sheet**: press **Check without saving**, then **Refresh from sheet**. Fix every unmatched name with
   the picker and refresh again until the totals match the sheet's dashboard (or every difference is explained).
3. **Chapter Settings → Source of truth → Switch to This site…**. Read the confirm box, then type `SITE`. Every
   officer page unlocks, the yellow notes go away, and nothing is copied from the sheet after this.
4. **Semester Setup → 1**: start the new term. Closing Fall 2026 uses the sheet's own numbers (for example 8 service
   hours), so its roll-over matches the sheet. Then follow "Start of semester" above.
5. Close the Google Forms for excuses and service hours (Forms → Responses → not accepting), so nobody sends one to
   the old place. The menu and the home tiles already point to the site's own forms.
6. The brothers' **Theta Tau Tracker** still reads the sheet until a developer points it at the site's tracker
   (`tracker-preview`). Plan that code change for the same week.
7. Archive the Tracker sheet (view only) and download the Standards Board term backup to the chapter Drive.

## Admin succession (do this BEFORE the Technology Chair graduates)
1. The incoming Technology Chair signs in to the portal once (creates their account) and is approved.
2. Firebase console → Realtime Database → Data → `users` → their uid → `role` → `"admin"`. Keep exactly TWO admins:
   the Technology Chair and the Standards Chair. Admin can read every excuse reason and photo. Never make the Regent,
   the Treasurer or a friend admin "just in case".
3. Firebase console → Project settings → Users and permissions: add the incoming Technology Chair and the Standards
   Chair as Owner, and remove Owners who left. An Owner can read the whole database in the console, so the same
   two-person limit applies. When the Standards Chair changes, swap the admin role and the Owner seat the same week.
4. GitHub → thetatauzd organisation → People: make them Owners. Domain registrar for thetatauzd.org: add them and
   check the renewal date.
5. Google Drive: transfer ownership of the old Tracker archive, the Budget sheet, the Forms and the Apps Script
   projects (Gateway, RosterGateway) to a chapter-owned account. Apps Script web apps run as their owner and stop if
   that account is deleted.
6. The NEW admin (not the outgoing one) sets the outgoing admin's status to Alumni and removes the Technology Chair
   position on User Management. Then in the console, `users` → outgoing uid: set `role` to `"brother"` and delete
   `perms/admin` (the site keeps admin sticky on purpose). Check: the outgoing account opening `/portal/admin` is sent
   to the portal home.
