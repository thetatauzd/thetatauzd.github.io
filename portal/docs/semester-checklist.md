# Semester checklist

File locations (old tracker sheets, Budget, form responses, Apps Script projects): exec Drive →
"Portal handoff: file locations". Ask the Technology Chair for access.

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
- If the chapter changed what a position may do (Chapter Settings → Positions), re-save every holder of that position
  on User Management afterwards. Until then their stored permissions are the old ones.
- Each new officer reads their section of `portal/docs/officer-guide.md` (Chapter Ops menu → Officer guide).

## Re-import from the old Google Sheet (before go-live only, never after)
The import page writes to the live database. A second run does not remove the first run's records, so always wipe
first.
1. Firebase console → Realtime Database → Data: delete `events/<T>`, `attendance/<T>`, `myAttendance/<T>`,
   `excuses/<T>`, `excuseFlags/<T>`, `adjustments/<T>`, `rollover/<T>`, `service/<T>`, `ledger/<T>`, `terms/<T>`.
2. If a name was matched to the wrong account, fix that account's status and roll number on User Management.
3. Import page → all tabs → **Import** → type the term code at the prompt. The log must end with "Done.". Repeat the
   spot checks against the sheet's Dashboard.

After the site is live, fix numbers on the site instead (reversals on Treasurer, correcting adjustments on the
Standards Board, re-taking roll).

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
