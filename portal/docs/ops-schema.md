# Chapter Ops — data schema and rules

This is the reference for everything the portal stores about chapter operations. It is written so a person or an AI tool can change a rule safely: **facts are stored, results are computed** by `portal/js/ops-core.js`, and `portal/ops-tests.html` proves the computations against rows from the Fall 2026 tracker sheet. Change `ops-core.js`, open the test page, and every line must read OK.

Authorization is entirely `firebase-database.rules.json` (paste into the Firebase console to publish). There is no server.

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
terms/{termId}                  { label, startDate, endDate, duesDueDate, duesChargedAt, status: active|closed, ...audit }
```
Defaults come from the Fall 2026 bylaws, the Standards Board procedures and the tracker's Config tab. Notable: chapter meetings cost 2 unexcused with 2 free per term; voting chapters 5; rush events 2; initiation and philanthropy 7 (excused still 2); committee meetings 1. Warning at 7, bad standing at 10. Buy-out $50 at 10 demerits, +$25 per further 5, cap $125. Service: 12 hours / 3 events for brothers (owner's choice; bylaws say 8), 8 / 3 for PNMs; 1 demerit per hour short and 2 per event short, applied next term. Dues $250, late one day after due date, $5 per week for two weeks then $10 per week.

## Attendance, excuses, demerits (per term)

```
events/{term}/{eventId}                 { title, date, time 'HH:MM', type, recorded, recordedAt, notes, ...audit }
                                        -- ONLY events that can give or take demerits. Service events are not kept.
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
changeLog/{term}/{push}   { type, where, detail, by, byName, at }
imports/{id}              { at, by, counts, unmatched }
```

## Rules summary

| Node | Read | Write |
|---|---|---|
| users | admin, regent, standards, any perm holder; self | self while pending/new; admin (validate: self cannot set positions/perms/status) |
| directory, events, settings, terms, portalLinks | every non-pending member | attendance/settings/service/finance holders as noted |
| attendance | attendance, standards, settings holders | attendance, standards |
| myAttendance, excuses, adjustments, rollover, standing, ledger, service | officers per domain; **self reads own subtree** | officers; self may create pending excuses/service entries |
| excuses | **Standards + admin only**; self reads own | self while pending (active or pnm), Standards |
| excuseFlags | attendance, standards, finance, settings; self | self may set/clear `pending`; Standards sets the ruling |
| proof/excuse, proof/service | Standards / Service+Marshal; self | self creates (≤ 400k chars, JPEG data URL) or deletes own; admin clears a term |
| statusHistory | officers; self | admin, append-only |
| portalLinks | every member | admin |
| ledger entries | | never overwritten (`!data.exists()`), must carry createdBy = auth.uid |
| pledge nodes | pledges, standards, settings holders; self reads own pledge | pledges |
| votes / hasVoted / progress | | only `status === 'active'` (or legacy records without a status) |

## Gateway and import

`portal/apps-script/Gateway.gs` `exportAll` (admin only) returns every tab of the tracker sheet. `portal/import.html` previews the export, matches rows to portal accounts by roll number then by name, and writes: Roster → users status/sortOrder + roster nodes; Config → settings (only when empty); Event_Info → events; Attendance → attendance + myAttendance; Payments_Fines → ledger; Standards_Adjustments → adjustments; Rollover → rollover; Service_Log → service; Excuses → excuses. Logged in `imports/` and `changeLog/`.

## Photos (no Firebase Storage)

`js/ops-photos.js` (`PortalPhotos`) shrinks a picture in the browser (longest edge 1600 px, JPEG, ≤ ~210 KB) and stores it as a data URL under `proof/{excuse|service}/{term}/{uid}/{photoId}`. Requests keep only `photoIds`, so lists stay small and a photo downloads only when opened. About 30–40 MB per semester against the free plan's 1 GB; Semester Setup zips and clears closed semesters. Images only (photograph or screenshot a document).

## Portal home links

`portalLinks/sections/{id} = { title, order, links: { id: { label, url, icon, order, audience, hidden } } }`, `portalLinks/calendarUrl`. Edited at `portal-links.html` (admin), rendered by `js/portal-links-core.js`, which also holds the built-in default set and the icon list. `url` must be `https://…` or a portal page name; audience is `all | active | pnm | officers | admin`.

## Navigation

The three header menus are built by `NAV` in `js/auth.js`. Add a page to the site's menus by adding one line there (with `perm` or `roles` to limit who sees it).

## Pages

| Page | Who | What |
|---|---|---|
| tracker | everyone | standing, demerit history, attendance, dues, service, pledge card |
| excuse, log-service | active + PNM | the two forms that replaced Google Forms |
| attendance | attendance, standards | events, roll call with excuse badges |
| standards-board | standards | dashboard, excuse queue, adjustments, overrides, roll-over |
| treasurer / service / marshal | finance / service / pledges | their domains |
| member?uid= | any officer | one person's record, sections limited by rules |
| semester | settings (+ attendance for scheduling) | new term, bulk event schedule, photo clean-up |
| settings | settings | every bylaw number, event types, positions, statuses, history |
| admin, portal-links, import | admin | people, home page links, one-time sheet import |

## Term rollover (Semester Setup page)

1. Close the current term (`terms/{id}/status = closed`).
2. Create the next term, set `settings/currentTerm`.
3. Write `rollover/{next}/{uid} = serviceShortfallNext` for everyone with a shortfall (from `OpsCore.computeDemerits`).
4. Charge dues (`dues_{next}`) to every status with `chargedDues`.
Each step is idempotent by key.
