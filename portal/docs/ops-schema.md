# Chapter Ops — data schema and rules

This is the reference for everything the portal stores about chapter operations. It is written so a person or an AI tool can change a rule safely: **facts are stored, results are computed** by `portal/js/ops-core.js`, and `portal/ops-tests.html` proves the computations against cases shaped like the Fall 2026 tracker sheet (every name in it is invented). Change `ops-core.js`, open the test page, and every line must read OK.

Authorization is entirely `firebase-database.rules.json`, published with `scripts/publish-rules.sh` (see `portal/README.md`). There is no server.

The repository is public and GitHub Pages serves it. Never commit personal data: no real names next to demerits,
standing, money or notes, no phone numbers, private emails or student IDs, and no export of the database or the
sheet. Test fixtures use invented names. `_config.yml` keeps `CLAUDE.md`, `AGENTS.md` and `portal/docs/` off
thetatauzd.org, but they are still public on GitHub.

## Source of truth (Fall 2026: the Tracker sheet)

The owner's decision of 2026-11-02: for Fall 2026 the chapter's Google **Tracker** sheet stays the record. Officers keep
working on the sheet and brothers keep using the Google Forms. The site holds a read-only **copy** of the sheet so
officers can preview the Chapter Ops pages. An admin switches the source to the site at the cut-over (planned for
Spring 2027).

```
settings/mode   { source: 'sheet' | 'site',              -- missing or unreadable = 'sheet'
                  forms: { excuse, service },              -- optional; else OpsMode.FORMS in js/ops-mode.js
                  lastSyncAt, lastSyncBy, lastSyncByName,  -- the last finished Refresh from sheet
                  syncing, syncingAt, syncingBy, syncingByName,   -- the refresh lock (10 minutes; see Refresh
                                                           --   from sheet below)
                  copyIncomplete }                         -- true from a refresh's first write until it finishes
```
- `js/ops-mode.js` (`OpsMode`) reads it: `load`, `isSheet`, `formUrl`, `isStale` (no copy, unfinished, or older
  than a day), `isSyncing` (`syncing` is true and the lock is under 10 minutes old; an older lock is dead), `when`,
  `banner` (it says when the last refresh stopped partway). Every page that shows the copy loads it. `js/auth.js`
  loads it on demand on pages that do not.
- **Sheet mode** (the default):
  - Brothers see the live **Theta Tau Tracker** (`tracker`, `js/tracker.js`, Gateway.gs action `me`), exactly as
    before Chapter Ops. "Request an excuse" and "Log service hours" (menu and home tiles) open the Google Forms.
    The site's `excuse` and `log-service` pages show only a notice and a button to the form. They read and write nothing.
  - Officers get the Chapter Ops pages as a **read-only preview** of the copy. `PortalOps.preview` draws the banner
    ("Preview. Copied from the Tracker sheet … by …"), hides every `[data-write]` part and shows every
    `[data-readonly]` part, for admins too. Semester Setup shows a closed card. Chapter Settings is read-only
    except the admin-only switch. User Management still saves (accounts are not tracker data).
  - Admins get "Refresh from sheet now" in the banner. When an admin opens a preview page and the copy is more than
    a day old or the last refresh stopped partway, `PortalSync.refreshIfStale` makes a new one by itself, and the
    banner shows its steps ("Reading the Tracker sheet…", "Saving …"). When the copy looks fresh the check runs
    quietly (`st.silent`): the button stays "Refresh from sheet now", a press during the check runs as soon as it
    ends, and the banner is drawn again when it ends. Before 2026-11-05 the quiet check set the page's busy flag
    and did not draw the banner, so a live-mode redraw during the check (the real SDK answers the settings/mode
    listener in the same message as the check's read, listener first) drew the button as "Copying from the
    sheet…", disabled, and nothing drew it again when the check ended: the button stayed stuck until the page
    was reloaded. The portal home never does (`page: 'home'` is refused): a quiet refresh cut off by the next tap
    would leave a half-written copy.
  - Totals follow the sheet's own numbers: `PortalOps.termSettings` lays `settings/sheetPolicy` over the site settings
    for the sheet's term.
- **Site mode** (after the switch): no banner, no refresh, the site's forms and officer pages work as written below.
  A switch made while a page is open shows "The source of truth just changed. Reload this page".
- The switch: Chapter Settings → Source of truth → **Switch to This site…** (admin only, typed confirmation `SITE`;
  back again with `SHEET`). It writes `settings/mode/source` and nothing else, and is refused while a refresh runs.
- Page helpers in `js/ops-db.js`: `PortalOps.loadMode` (never fails; a failure means sheet mode), `isReadOnly(mode)`,
  `lockWrites(root)`, `preview({ profile, el, what, onRefresh })` (resolves `{ mode, readOnly }`, never rejects; it
  also watches `settings/mode` live and reloads the page's data after a new copy) and `termSettings(settings, term, opts)`.
  `loadSettings()` also returns `.mode` and `.sheetPolicy`. A new officer page marks its write controls
  `data-write`, its read-only hints `data-readonly`, calls `PortalOps.preview` and guards every write function.
- Load order on a preview page: Firebase app, auth, database, `firebase-config.js`, `auth.js`, `ops-core.js`,
  `ops-db.js`, `ops-mode.js`, `sheet-sync.js` (it loads `sheet-sync-core.js` itself), then the page script.
- The read-only preview is enforced by the pages, not by the rules. Until the rules say otherwise, an officer with a
  capability can still write tracker nodes from the console, and anything written there is replaced at the next refresh.

## Principles

1. **Configuration is data.** Positions, statuses, event types and every policy number live under `settings/` and are edited on the Settings page (with history). Defaults are in `OpsCore.DEFAULTS`; `OpsCore.withDefaults(stored)` fills gaps, so a missing setting is never an error.
2. **Rules know capabilities, not positions.** `users/{uid}/perms` is derived from the person's positions (`OpsCore.permsFor`) every time an admin saves them. Rules check `perms/finance`, `perms/attendance`, `perms/standards`, `perms/service`, `perms/pledges`, `perms/settings`; admin (`role === 'admin'`) passes everything. Adding a position never touches rules.
3. **Terms.** Operational nodes are keyed by term (`F26`, `S27`). `settings/currentTerm` names the live one. Rollover copies only what policy says carries forward (service shortfall demerits).
4. **Append-only money and discipline.** Ledger entries and adjustments are never edited; add a `reversal` or a correcting entry. Every officer write carries `createdBy`, `createdByName`, `createdAt` (`PortalOps.audit`).
5. **Legacy `role` string stays.** Older pages and the voting rules key on `users/{uid}/role`. It is recomputed by `OpsCore.legacyRole` on every save: admin stays admin; standards_chair → `standards`; regent → `regent`; recruitment_chair → `rush_chair`; status pnm → `pnm`; pending → `pending`; else `brother`.

## People

```
users/{uid}          { email, name, rollNumber, createdAt,
                       role, status, inactiveSince, sortOrder, notes,
                       positions: { treasurer: true }, perms: { finance: true, settings: true },
                       updatedBy, updatedAt }
directory/{uid}      { name, rollNumber, status, positions, sortOrder }   -- no emails; every member may read
roster/{roll}        { name }                                             -- sign-up autofill (child reads only)
rosterByName/{key}   { roll, name }                                       -- key = OpsCore.nameKey(name)
statusHistory/{uid}/{id}  { from, to, effective, by, byName, at }                   -- appended by saveUser on every status change
meta/schemaVersion   2
```
Statuses (`settings/statuses`): `pending, active, coop, abroad, inactive, pnm, alumnus, graduated`. Each has `countsAsActive` (on roll call, quorum, "active brothers"), `chargedDues`, `votes`. Every non-pending status can sign in. Only `active` votes. A status change takes effect at the next roll call: attendance only counts events where the person has a mark, and roll call only writes marks for people whose status `countsAsActive` that night.

Write path: `PortalOps.saveUser(uid, patch, profile)` — recomputes perms and role, mirrors `directory/`, `roster/`, `rosterByName/` in one multi-path update. `PortalOps.migrateUsers` upgrades old role-only records (idempotent).

## Settings

```
settings/currentTerm            'F26'
settings/positions/{key}        { label, group: officer|board|chair, order, perms: {...} }
settings/statuses/{key}         { label, order, countsAsActive, chargedDues, votes }
settings/eventTypes/{key}       { label, order, unexcused, excused, freePerTerm, source }
settings/policy                 see OpsCore.DEFAULTS.policy (thresholds, service, buyout, dues, attendance, quorum, pledge, gpa)
settings/history/{push}         { group, before, after, changedBy, changedByName, changedAt, note }   -- write-once
settings/mode                   see "Source of truth" above
settings/sheetPolicy            { term, eventTypes, policy }   -- the sheet's own numbers for its term (Demerit_Rules),
                                                               -- written by Refresh from sheet. Numbers only.
settings/sheetAliases/{nameKey} { name, uid } | { name, ignore: true }   -- sheet spellings matched by hand on the
                                                               -- Refresh from sheet page. Names only, never numbers.
terms/{termId}                  { label, startDate, endDate, duesDueDate, duesChargedAt, status: active|closed, source?: 'sheet', ...audit }
```
`settings/` is readable by every approved member and writable by admins and `perms/settings` holders, so
`sheetPolicy` and `sheetAliases` must never hold anything personal beyond a name.
Defaults come from the Fall 2026 bylaws, the Standards Board procedures and the tracker's Config tab. Notable: chapter meetings cost 2 unexcused with 2 free per term; voting chapters 5; rush events 2; initiation and philanthropy 7 (excused still 2); committee meetings 1. Warning at 7, bad standing at 10. Buy-out $50 at 10 demerits, +$25 per further 5, cap $125. Service: 12 hours / 3 events for brothers (owner's choice; bylaws say 8), 8 / 3 for PNMs; 1 demerit per hour short and 2 per event short, applied next term. Dues $250, late one day after due date, $5 per week for two weeks then $10 per week.

## Attendance, excuses, demerits (per term)

```
events/{term}/{eventId}                 { title, date, time 'HH:MM', type, recorded, recordedAt, notes, ...audit }
                                        -- ONLY events that can give or take demerits. Service events are not kept.
                                        -- every member can read it, so Refresh from sheet never copies Event_Info Notes
attendance/{term}/{eventId}/{uid}       { present, markedBy, markedAt }        -- officers read
myAttendance/{term}/{uid}/{eventId}     same record, mirrored                   -- the brother reads their own
excuses/{term}/{uid}/{id}               { eventId | (eventText + eventDate when not listed), kind: absent|late|leaveEarly, time,
                                          category, reason, photoIds[], submittedAt, lateSubmission, afterEvent,
                                          status: pending|approved|denied, reviewedBy, reviewedByName, reviewedAt, reviewNote }
                                        -- reasons/photos: the brother + Standards only
excuseFlags/{term}/{eventId}/{uid}      'pending' | 'approved' | 'denied' (prefixed late_ / early_ for those kinds)
                                        -- reason-free mirror: Scribe badges, other officers' demerit math
proof/excuse/{term}/{uid}/{photoId}     { data: 'data:image/jpeg;base64,…', w, h, bytes, createdAt }   -- see Photos
adjustments/{term}/{uid}/{id}           { points, reason, enteredBy, date, ...audit }   -- negative = credit
rollover/{term}/{uid}                   { points, from, note, ...audit }
standing/{term}/{uid}                   { override: good|warning|bad|null, reason, setBy, setAt }
```
`PortalOps.saveAttendance(term, eventId, marks, profile)` writes both attendance shapes and flips `recorded`. **No mark on a recorded event means the person was not on roll call (PNM, co-op, abroad, inactive, joined later) and the event is skipped**; an explicit `present: false` is an absence.

Excuse flow: `excuse.html` → `PortalOps.submitExcuses` (one request per ticked event, shared photos) → Standards Board queue → `PortalOps.decideExcuse` (writes the excuse and its flag; decisions can be changed) → when roll is taken an absent + approved `absent`-kind request is charged the type's `excused` rate. `late`/`leaveEarly` requests never excuse an absence; those people are marked present. `OpsCore.excuseTiming` applies the 24-hour rule (`policy.attendance.excuseHoursBefore`, event `time` or `defaultEventTime`).

**Computed by `OpsCore.computeDemerits(uid, facts, settings)`:**
- per event type: `max(0, unexcused − freePerTerm) × type.unexcused + excused × type.excused` (an approved excuse for that event makes the absence excused; excused chapter absences do not use up the free ones)
- payment demerits: unpaid charges past due + grace with `demeritsIfLate`, unless on a plan
- `total = rollover + attendance + payment + adjustments − extraServiceHours × extraHourErases`
- standing: `bad` at `badStandingThreshold`, `warning` at `warningThreshold`, override wins; buy-out from the ladder
- `OpsCore.demeritTimeline` returns the same total as dated lines (roll-over, each absence incl. "free absence 1 of 2", excused-at-cost, adjustments, late fees, extra-service credit) with a running total; `OpsCore.freeAbsences` gives `{ allowed, used, left }`
- `serviceShortfallNext` is shown but not added to the total (policy applies it next term at rollover)

## Finances (per term)

```
ledger/{term}/{uid}/{entryId}   { type: charge|payment|waiver|plan|reversal,
                                  item, amount, dueDate, date, method, accruesLate, demeritsIfLate,
                                  chargeId, planDueDate, reverses, note, ...audit }
```
The dues charge for a term uses the fixed key `dues_{term}` so "Charge dues to all active" is idempotent. Imported charges carry `accruesLate: false`. `OpsCore.ledgerSummary(entries, settings, {asOf})` returns each charge with `paid, waived, remaining, status (paid|waived|plan|late|unpaid), lateFee` and a `balance`. `OpsCore.lateFeeFor` implements the ladder; accrual stops at settlement or waiver and pauses from a plan's date until its `planDueDate`.

## Service (per term)

```
service/{term}/{uid}/{id}       { eventName (typed), hours, requestedHours, date, week (Sunday of that week), photoIds[], vouchedBy,
                                  description, countsAsEvent, status: pending|approved|denied, submittedAt,
                                  reviewedBy, reviewedByName, reviewedAt, reviewNote }
proof/service/{term}/{uid}/{photoId}   same shape as excuse photos
```
There is no list of service events on the site: the event name is typed (`log-service.html`, and the chair's bulk credit). The Service Chair may change the hours when approving and ticks `countsAsEvent` when the entry is one of the required service events; distinct events = approved entries with `countsAsEvent`, de-duplicated by name + date. Brothers and PNMs may create, edit and take back their own entries only while `pending`. `OpsCore.serviceSummary` gives approved/pending hours, distinct events, shortfall and the extra hours that erase demerits.

## Pledges

```
pledgeClasses/{id}                          { label, termId, startDate, targetInitiation, meetings: { m0: { title, date } ... }, ...audit }
pledges/{uid}                               { classId, startDate, nationalExam: { passed, date, enteredBy }, chapterExam, pinnedAt, initiatedAt, depledgedAt, notes, updatedBy, updatedAt }
pledgeAttendance/{classId}/{meetingId}/{uid} { present, markedBy, markedAt }
```
`OpsCore.pledgeReadiness` checks hours, events, weeks and exams against `policy.pledge`.

## Bookkeeping

```
changeLog/{term}/{push}   { type, where, detail, by, byName, at }   -- a refresh logs type 'sheetSync'
imports/sheetSync         the latest Refresh from sheet report: { term, at, by, byName, auto, exportedAt, exportVersion,
                            counts, before, changed, compared, matching, mismatches[], notCompared[], serviceDiffs[],
                            unmatched[], ignored[], rosterDiffs[], warnings[], rolloverTab }   -- rolloverTab: the
                            sheet tab the roll-over came from, '' when none was copied
imports/{push}            { kind: 'sheetSync', term, at, by, byName, status: done|failed|partial, auto, counts,
                            changedNodes, mismatches, unmatched, code, error }   -- one row per refresh
```
`imports/` is admin-only (read and write). The mismatch list and unmatched names live only there.

## Rules summary

| Node | Read | Write |
|---|---|---|
| users | admin, regent, standards, any perm holder; self | self while pending/new; admin (validate: self cannot set positions/perms/status) |
| directory, events, settings, terms, portalLinks | every non-pending member | attendance/settings/service/finance holders as noted. `settings/mode` falls under `settings`: today any `perms/settings` holder could write it, although only admins see the switch |
| attendance | attendance, standards, settings holders | attendance, standards |
| myAttendance, excuses, adjustments, rollover, standing, ledger, service | officers per domain; **self reads own subtree** | officers; self may create pending excuses/service entries |
| excuses | **Standards + admin only**; self reads own | self while pending (active or pnm), Standards |
| excuseFlags | attendance, standards, finance, settings; self | self may set/clear `pending`; Standards sets the ruling |
| proof/excuse, proof/service | Standards / Service+Marshal; self | self creates (≤ 400k chars, JPEG data URL) or deletes own; admin clears a term |
| statusHistory | officers; self | admin, append-only |
| imports | admin only | admin only |
| changeLog | admin and any ops capability (finance, attendance, standards, service, pledges, settings) | the same |
| portalLinks | every member | admin |
| familyTree/members, photos, meta | every approved member | admin or `perms/tree` (exec by default); members may not hold `status` or `note`; name ≤ 80, roll a number, LinkedIn URL only; photo ≤ 90k chars JPEG data URL |
| familyTree/private | the exec board: admin or `perms/tree` (chairs do not have it) | admin or `perms/tree`; `status` resigned or removed, `note` ≤ 1000, nothing else |
| familyTree/history | officers (same as private): before/after copies hold standing | admin or `perms/tree`, append-only |
| site/rush | **anyone, signed in or not** (the public rush page reads `/site/rush.json` over plain HTTPS, about 1 KB) | admin only (Admin → Website, `portal/site-admin.html`). Text only. Validated children: isOpen (required), nextSemester ≤ 60, rushTitle ≤ 80, subtitle/ctaLine ≤ 200, rushLinkUrl/interestFormUrl `https://` ≤ 500, heroAlt ≤ 200, updatedAt, events/0-9 {title (required) ≤ 80, detail ≤ 160, inviteOnly}. Never personal data: no names or emails. |
| site/rushPictures | **anyone, signed in or not** (the rush page fetches `/site/rushPictures.json` only while rush is open) | admin only, written in the same update as site/rush. hero and events/0-9 (same index as site/rush/events), each a full JPEG data URL ≤ 100k chars. Closing rush needs no cleanup: a closed page never downloads them. |
| ledger entries | | never overwritten (`!data.exists()`), must carry createdBy = auth.uid |
| pledge nodes | pledges, standards, settings holders; self reads own pledge | pledges |
| votes / hasVoted / progress | | only `status === 'active'` (or legacy records without a status) |

## Gateway and Refresh from sheet

`portal/apps-script/Gateway.gs` serves two actions from the Tracker sheet (setup and redeploy steps:
`portal/apps-script/README.md`):
- `me`: one brother's own row (demerits, payments, service). The live Theta Tau Tracker (`js/tracker.js`) and the
  portal home tiles use it. Unchanged since before Chapter Ops.
- `exportAll` (version 2, admin only): Roster, Demerit_Rules (else Config), Event_Info, Attendance, Payments_Fines,
  Standards_Adjustments, Service_Hours (else Service_Log), Excuses, DemeritDashboard and the roll-over tab (any tab
  with "rollover" in its name). `?action=ping` returns the version.

Refresh from sheet (`portal/import.html`, admin only, and `PortalSync.refreshIfStale` on preview pages):
1. `js/sheet-sync-core.js` (`SheetSyncCore`, pure, tests in `portal/sync-tests.html` and `node scripts/sync-tests.js`)
   maps the export to the term nodes `events, attendance, myAttendance, excuseFlags, excuses, adjustments, rollover,
   service, ledger`. Keys come from content (event title, item + due date, date + reason), never from row numbers, so
   the same sheet always gives the same copy and a deleted row disappears. It matches each sheet name to an account:
   a saved alias to an account (`settings/sheetAliases`) first, then the roll number, then an 'ignore' alias, the
   exact name, the Roster's spelling and a loose match on first and last name. Pending accounts are never matched.
   A row is never guessed, because a wrong match files one brother's reasons and fines under an account another
   brother can read: it is left out and listed as ambiguous (an admin settles it with an alias) when the roll
   number points at one account and the name at another, when a known roll number (the row's or the Roster's)
   contradicts a Roster or loose match, when two Roster people share the loose name, or when two Roster rows land
   on one account (then neither is copied). Exact-name matches ignore roll numbers. It follows the sheet's own rules
   (the dashboard formulas, checked 2026-11-02) and recomputes every total with OpsCore to compare with
   DemeritDashboard.
2. `js/sheet-sync.js` (`PortalSync`, tests in `node scripts/sync-runner-tests.js`) takes the lock in
   `settings/mode`, replaces each changed node for the term WHOLE (a node with the same facts is left alone; the
   ledger is cleared as a whole term, then written entry by entry, because its rules are append-only), and writes
   `settings/sheetPolicy` (when it changed), `settings/currentTerm` and `terms/{T}` (only when missing),
   `imports/sheetSync`, an `imports/` row and a `changeLog/` entry, then `settings/mode/lastSync*`. Before its first
   write it sets `settings/mode/copyIncomplete` and waits for the server to confirm it; the flag is cleared with
   `lastSync*` only after a complete copy, so a refresh that failed or was cut off shows in the banner and is retried
   at the next admin visit to a preview page.
   The lock (`syncing`, `syncingAt/By/ByName`, taken in a transaction):
   - It is let go only by the run itself (done or failed), by its page on `pagehide`, by the same admin's
     takeover (below), or by age (10 minutes). While a refresh runs the page asks before leaving
     (`beforeunload`); on `pagehide` it lets go of the lock itself (best effort, the same conditional release)
     and logs the run as `left-page`. A page that is killed, or whose connection drops, keeps the lock. The
     server never lets go on its own: a dropped connection can come back while the run is still writing, and a
     second refresh started in the gap would get the first run's later writes (a ledger clear, then entries) on
     top of its finished copy.
   - A live lock older than `PortalSync.TAKEOVER_MS` (2 minutes) held by the same admin, that this page did not
     take, is that admin's own refresh from another page or tab: a button press takes it over (`tookOverLockAt` in
     the `imports/` row). A refresh takes about 10 seconds, so a 2-minute-old lock is almost surely dead. Another
     admin's live lock still gives `locked`, and `refreshIfStale` never takes over.
   - A run confirms the lock is still its own (`syncingAt/By` are its token) before every write of the copy: the
     first in the transaction that sets `copyIncomplete`, then before each node, each ledger chunk, the settings
     and the report. One that was taken over stops (`taken-over`, logged as `partial` or `failed`) and writes
     nothing more, not even `copyIncomplete`: it set the mark before its first write and only a finished copy
     clears it, so the mark is either still set or was cleared by a newer finished copy that must not be
     overwritten. A write already sent when the lock changed hands can still land: at most one per run.
     The same checks stop a run (`site-mode`, nothing more written) when `settings/mode/source` turned to
     `'site'` while it ran. The run's page watches `settings/mode`: once another refresh holds the lock it
     drops its `beforeunload` and `pagehide` handlers, so leaving neither asks nor logs `left-page` for it.
     If the final release does not commit (the lock changed hands after the last check), the run fails with
     `release`: the copy is saved but not recorded as finished, so `copyIncomplete` stays and the next
     refresh redoes it. After its own run ends, a preview page reloads its data if another refresh finished
     meanwhile.
   - The gateway call gives up after `PortalSync.GATEWAY_TIMEOUT_MS` (6.5 minutes; Apps Script stops a run at 6),
     so a request that never answers fails with `gateway-timeout` and the lock is released.
3. Guards (nothing is written): admins only, sheet mode only, one refresh at a time, an export older than version 2,
   a copied tab (Attendance, Payments_Fines, Excuses, Standards_Adjustments, Service_Hours) the gateway could not find
   ("missing-tab": renamed or deleted), and an export whose dates belong to another semester ("wrong-term": with at
   least 3 dated Event_Info rows, else Payments_Fines due dates, more than half outside the term's months, F = Jul to
   Dec, S = Jan to Jun; an admin cannot copy it anyway). A node that would shrink to under half its size (from 20
   records) or to nothing asks first ("shrink"). A roll-over tab named for a term other than the one before is not
   copied (a note says so). "Check without saving" builds the report and writes nothing.

The refresh never changes accounts (`users/`), `standing/`, the pledge nodes, `proof/` photos or any other setting.
Saved name matches (`settings/sheetAliases`) are written only by the picker on the Refresh from sheet page. The old
one-time import is gone: it used row-number keys and could not remove rows.

## Photos (no Firebase Storage)

`js/ops-photos.js` (`PortalPhotos`) shrinks a picture in the browser (longest edge 1600 px, JPEG, ≤ ~210 KB) and stores it as a data URL under `proof/{excuse|service}/{term}/{uid}/{photoId}`. Requests keep only `photoIds`, so lists stay small and a photo downloads only when opened. About 30–40 MB per semester against the free plan's 1 GB; Semester Setup zips and clears closed semesters. Images only (photograph or screenshot a document).

## Portal home links

`portalLinks/sections/{id} = { title, order, links: { id: { label, url, icon, order, audience, hidden } } }`, `portalLinks/calendarUrl`. Edited at `portal-links.html` (admin), rendered by `js/portal-links-core.js`, which also holds the built-in default set and the icon list. `url` must be `https://…` or a portal page name; audience is `all | active | pnm | officers | admin` (`officers` = admin, any position, or any capability, the same rule as `PortalAuth.isOfficer`).

In sheet mode the home page (`portal/index.html`) draws a link to `excuse` or `log-service` as the Google Form
(`OpsMode.formUrl`) under its old name, once. Stored links need no change. Officers also get an "Officer preview" card
with one tile per Chapter Ops page they can open. The home page never refreshes the copy; the preview pages do.

## Family tree

```
familyTree/members/{id}   { name, roll, major, pledgeClass, bigId, big2Id, linkedin, hasPhoto,
                            fullName, nickname, minor, grad, roles,            -- from the Drive "Brother List"
                            offices: { regent: 'past', marshal: 'current' },    -- official signs of office: X! XX! XXX! XXXX!
                            familyName, color }            -- familyName/color only on a family root (no bigId)
                                                           -- never status or note (the rules refuse them here)
familyTree/private/{id}   { status: 'resigned' | 'removed', note }   -- exec board only (admin or perms/tree; chairs excluded)
                                                           -- absent = brother; resigned/removed stay in the tree
familyTree/photos/{id}    { data: 'data:image/jpeg;base64,…', w: 192, h: 192, bytes, createdAt, by }   -- one square thumbnail per member
familyTree/meta           { classes: [ 'Alpha', …, 'Omega Beta', … ], title, importedAt, importedBy, source, updatedAt }
familyTree/history/{push} { action: add|edit|delete|import, memberId, name, before, after, by, byName, at }   -- officers only
```
Facts are only "who is whose big"; `js/family-tree-core.js` (pure, tested in `ops-tests.html`) turns them into families, rows per pledge class and a tidy layout, and refuses loops. `family-tree.html` draws it as pannable SVG (one finger pans, two pinch), exports the same drawing to PNG on a canvas (≤ 15 M pixels on iOS, so a phone exports one family at a time), and lets `tree` holders edit in a side panel / bottom sheet. Co-big (`big2Id`) draws a dashed line. `name` is the everyday name, `fullName` the Brother List's legal name; both are searchable, and every approved member can read both. Office signs follow the national list: Regent X, Vice Regent Y, Scribe V, Treasurer Z, Corresponding Secretary R, Marshal W, Inner Guard T, Outer Guard U; doubled = past, tripled = grand (`FamilyTreeCore.OFFICES`, `signs`, `parseSigns`). Photos: ~116 × 15 KB ≈ 1.7 MB in the database, loaded once after the pills draw. Deleting a member re-attaches their littles to the deleted member's big.

**Standing is for officers only.** Officers (`FamilyTreeCore.isOfficer`, the same rule as the read rule) load `familyTree/private` and see the black pill, the standing chip and the note. Everyone else never asks for it, and resigned or removed brothers are drawn like everyone else. Save and remove write `members/{id}` and `private/{id}` separately. A picture export draws everyone alike unless an officer picks "Black pills (officers only)". A backup file keeps standing in a separate `private` map, and only when an officer whose private copy loaded downloads it.

**First fill.** The tree is filled once by an admin with **Restore from a backup file** while it is empty, using a private copy of the 2026 poster file (the Canva poster reconciled against the Drive Brother List) that is kept in an officers-only Drive folder and NEVER in this repository. `FamilyTreeCore.restorePlan` reads both file shapes (status/note inside each member, or a `private` map), lists anything the rules would refuse before writing, and the page writes members, the whole `private` node, meta and history in one update, then photos in chunks of 40. Until the familyTree rules are published, that update is refused as a whole and nothing is saved.

## Navigation

The three header menus are built by `NAV` in `js/auth.js`. Every page ships empty shells (`#dd-menu`, `#ops-dd-menu`,
`#admin-dd-menu`) and `initNav` fills them. Add a page to the site's menus by adding one line there. Item keys:
- `perm: [...]`: holders of any listed capability (admins always).
- `roles: [...]`: those legacy roles.
- `officer: true`: officers only (`PortalAuth.isOfficer`: admin, `users/{uid}/positions` exists, or any
  `users/{uid}/perms/*` is true). `PortalAuth.requireOfficer({ fallback })` gates a page the same way.
- `form: 'excuse' | 'service'`: in sheet mode the link goes to that Google Form (`OpsMode.formUrl`), in site mode to
  `href`. In sheet mode the Chapter Ops menu also opens with a "Preview from the Tracker sheet" label.

`PortalAuth.visibleNav(group, profile)` gives the entries one person sees (the home page's officer card uses it).
On a page that does not load `js/ops-mode.js` (the voting pages), `PortalAuth.withOpsMode` loads it on demand to set
the two form links. Access to the voting pages is unchanged: Regent View and Standards are admin-only.

## Pages

In sheet mode every officer page below is a read-only preview of the copy (see "Source of truth").

| Page | Who | What |
|---|---|---|
| index (portal home) | everyone | sheet tiles (balance, service, demerits) from Gateway `me`, link tiles, calendar; officers also get the "Officer preview" card |
| tracker | everyone | the live Theta Tau Tracker, read from the sheet through Gateway `me` (`js/tracker.js`), as before Chapter Ops |
| tracker-preview | officers | the site's My Tracker computed from the copy (`js/ops-tracker.js`): standing, demerit history, attendance, dues, service, pledge card. Brothers are sent to `tracker` |
| excuse, log-service | active + PNM | sheet mode: a notice and a button to the Google Form, nothing read or written. Site mode: the site's own forms |
| attendance | attendance, standards | events, roll call with excuse badges (sheet mode: the copied marks as pills) |
| standards-board | standards, settings | dashboard, excuse queue, adjustments, overrides, roll-over |
| treasurer / service / marshal | finance / service, standards / pledges, standards | their domains |
| member?uid= | any officer capability | one person's record, sections limited by rules |
| semester | settings, attendance | new term, bulk event schedule, photo clean-up (closed in sheet mode) |
| settings | settings | every bylaw number, event types, positions, statuses, history, the Source of truth switch (admin) |
| admin, portal-links, import, site-admin | admin | people, home page links, Refresh from sheet, public rush page settings |
| family-tree | every approved member (standing and notes: officers; edit: `tree`, exec by default) | big/little lineage: search, families, person cards, PNG export, editor, restore from a backup file (admin, empty tree) |

## Term rollover (Semester Setup page)

Semester Setup is closed while the Tracker sheet is the record. After the switch:
1. Close the current term (`terms/{id}/status = closed`).
2. Create the next term, set `settings/currentTerm`.
3. Write `rollover/{next}/{uid} = serviceShortfallNext` for everyone with a shortfall (from `OpsCore.computeDemerits`).
   A term the sheet owned (Fall 2026) is closed with the sheet's own numbers (`PortalOps.termSettings` with
   `anyMode`), so its roll-over follows the sheet's rules, for example 8 service hours.
4. Charge dues (`dues_{next}`) to every status with `chargedDues`.
Each step is idempotent by key.

## Decisions (owner, 2026)

Why the module looks the way it does. Change these only on purpose.

- Only events that can give or take demerits are entered on the site (chapters, voting chapters, rush, initiation,
  philanthropy, committee). **Service events are never listed**: brothers type the event name when logging hours, and
  the Service Chair ticks "counts as a service event" when approving.
- Excused absences and service hours are built-in forms with photo upload. Standards Report, Standards Concerns and
  the Suggestion Box stay external Google Forms (links editable by admins on Portal Links).
- Photos are compressed in the browser and stored in the Realtime Database under `proof/` (free plan, no Storage),
  cleared per semester from Semester Setup.
- Excuse reasons and photos are readable only by the brother, the Standards Chair and admins; everyone else uses
  `excuseFlags`. The Regent does not hold the `standards` capability. Exactly two admins: Technology Chair and
  Standards Chair.
- Statuses: active, co-op, abroad, inactive, alumni and PNM all keep portal access; only active brothers are on roll
  call, pay dues and vote (editable in Chapter Settings). No attendance mark on a recorded event = not on roll call.
- A late fee is money owed, not a demerit trigger: once the principal is paid the fee stops growing and is still owed;
  payment demerits follow the principal only.
- "Reset at the start of a semester" = Semester Setup: start a new term code, then bulk-schedule events.
- The budget stays in Google Sheets.
- Fall 2026 (owner, 2026-11-02): the Tracker sheet stays the record and brothers keep the Google Forms and the live
  Theta Tau Tracker. Officers preview the Chapter Ops pages from a copy that admins refresh from the sheet (and that
  refreshes itself when an admin opens a preview page and it is over a day old). No page writes tracker data while
  the sheet owns it. The copy is made again on every refresh, never imported once. At the cut-over an admin refreshes
  one last time, switches the source to the site, and the sheet is archived.
- Family tree standing (resigned or removed) and private notes are for officers only. The poster file with personal
  data stays out of the repository; the tree is filled once from a private copy.
- Service requirement default is 12 hours / 3 events (the Service Chair's target; bylaws say 8, editable).
