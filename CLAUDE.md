# thetatauzd.org — read this before changing anything

Website of Theta Tau, Zeta Delta chapter (University of South Carolina). Static site on GitHub Pages: only the `main`
branch deploys, the domain is in `CNAME`. The private **Brother Portal** lives in `portal/` and uses Firebase
(Google sign-in + Realtime Database) on the **free Spark plan**. Project id `thetatauzd-2ab25`.

## Hard rules
- No build step, no npm in the browser, no frameworks. Plain ES5 JavaScript in IIFEs like the existing files
  (`var`, `function`, no arrow functions, no modules). Third-party code only from a CDN `<script>` tag.
- Spark plan only: no Cloud Storage, no Cloud Functions, no servers. Photos are compressed JPEG data URLs stored in
  the database (`portal/js/ops-photos.js`).
- `firebase-database.rules.json` is the ONLY security. Every new database node needs a rule. Editing the file changes
  nothing until it is published: `firebase deploy --only database` (Firebase CLI, logged in as a project Owner) or
  paste it into Firebase console → Realtime Database → Rules → Publish. Commit and publish together, then check the
  live rules match: `firebase database:get "/.settings/rules"`.
- Do not change the voting system (`voting.*`, `standards.*`, `regent.*`, `history.*`, `chapter-results.*`,
  `js/slides.js`, `js/db.js`, the `sessions*` rules) or anything outside `portal/` unless the task says so.
- Only events that can give or take demerits go in `events/`. Service events are typed in by the brother, never listed.
- The chapter budget stays in Google Sheets.
- Commits: plain messages. No Co-Authored-By or other trailers.

## How Chapter Ops works
- Facts are stored, results are computed. ALL demerit, dues, late-fee, service and pledge math is in
  `portal/js/ops-core.js` (pure: no DOM, no Firebase). Pages never do math themselves. After changing `ops-core.js`,
  open `portal/ops-tests.html`: every line must say OK. Add a test for every new rule.
- Numbers (thresholds, fees, event types, positions, statuses) live in `settings/` and are edited on the Chapter
  Settings page; the defaults are `OpsCore.DEFAULTS`.
- Rules check capabilities (`users/{uid}/perms`: finance, attendance, standards, service, pledges, settings), never
  position names. Positions map to capabilities in Chapter Settings.
- INVARIANT: every capability whose pages compute a demerit total (standards, finance, settings) can read all of
  `PortalOps.DEMERIT_NODES`. A page that WRITES a computed total (rollover, buy-out) calls
  `PortalOps.requireReadable(all)` first.
- The ledger and adjustments are append-only. Fix mistakes with a reversal or a correcting entry, never by editing.
- Database keys must not contain `. # $ [ ] /`: use `OpsCore.nameKey` (ops) or `PortalDb.ballotKey` (voting).
- Excuse reasons and photos are readable only by the brother, the Standards Chair and admins. Other officers use the
  reason-free `excuseFlags` mirror. Keep it that way.
- Schema and rules summary: `portal/docs/ops-schema.md`. Update it in the same commit as any schema or rule change.
- Menus: `NAV` in `portal/js/auth.js`. Home-page links: the Portal Links page (admin); defaults in
  `portal/js/portal-links-core.js`.

## Every change
1. Work on a branch. GitHub Pages deploys `main` only.
2. If any portal JS or CSS changed, bump the cache number on every page. Check the current one with
   `grep -o '?v=[0-9]*' portal/index.html | head -1`, then e.g. `sed -i '' 's/?v=27/?v=28/g' portal/*.html`.
   Without this, phones keep the old files and the fix looks broken.
3. Run locally: `python3 dev-server.py 8080` → http://localhost:8080/portal/ and
   http://localhost:8080/portal/ops-tests.html. Local pages use the live database.
4. Test with a NON-admin account as well as an admin one.
5. After merging, load the live page with `?cb=<anything>` to skip the CDN cache.

## Docs
- `portal/docs/ops-schema.md`: data, rules, design decisions.
- `portal/docs/officer-guide.md`: how each officer uses their page.
- `portal/docs/semester-checklist.md`: start and end of semester, elections, re-import, admin succession.
