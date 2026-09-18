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
meta/schemaVersion   2
```
Statuses (`settings/statuses`): `pending, active, coop, inactive, pnm, alumnus, graduated`. Each has `countsAsActive` (quorum, waiting-on lists, "active brothers"), `chargedDues`, `votes`. Only `active` votes.

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
events/{term}/{eventId}                 { title, date, type, recorded, recordedAt, notes, ...audit }
attendance/{term}/{eventId}/{uid}       { present, markedBy, markedAt }        -- officers read
myAttendance/{term}/{uid}/{eventId}     same record, mirrored                   -- the brother reads their own
excuses/{term}/{uid}/{id}               { eventId, category, reason, hasDoctorNote, submittedAt, lateSubmission,
                                          status: pending|approved|denied, reviewedBy, reviewedAt, reviewNote }
adjustments/{term}/{uid}/{id}           { points, reason, enteredBy, date, ...audit }   -- negative = credit
rollover/{term}/{uid}                   { points, from, note, ...audit }
standing/{term}/{uid}                   { override: good|warning|bad|null, reason, setBy, setAt }
```
`PortalOps.saveAttendance(term, eventId, marks, profile)` writes both attendance shapes and flips `recorded`. A missing mark on a recorded event counts as absent.

**Computed by `OpsCore.computeDemerits(uid, facts, settings)`:**
- per event type: `max(0, unexcused − freePerTerm) × type.unexcused + excused × type.excused` (an approved excuse for that event makes the absence excused; excused chapter absences do not use up the free ones)
- payment demerits: unpaid charges past due + grace with `demeritsIfLate`, unless on a plan
- `total = rollover + attendance + payment + adjustments − extraServiceHours × extraHourErases`
- standing: `bad` at `badStandingThreshold`, `warning` at `warningThreshold`, override wins; buy-out from the ladder
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
serviceEvents/{term}/{id}       { name, date, hoursDefault, countsForPledges, ...audit }
service/{term}/{uid}/{id}       { hours, eventName, eventId, date, week, photoUrl, vouchedBy, description,
                                  status: pending|approved|denied, submittedAt, reviewedBy, reviewedAt, reviewNote }
```
Brothers and PNMs may create and edit their own entries only while `pending`. `OpsCore.serviceSummary` gives approved/pending hours, distinct events, shortfall and the extra hours that erase demerits.

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
| directory, events, serviceEvents, settings, terms | every non-pending member | attendance/settings/service/finance holders as noted |
| attendance | attendance, standards, settings holders | attendance, standards |
| myAttendance, excuses, adjustments, rollover, standing, ledger, service | officers per domain; **self reads own subtree** | officers; self may create pending excuses/service entries |
| ledger entries | | never overwritten (`!data.exists()`), must carry createdBy = auth.uid |
| pledge nodes | pledges, standards, settings holders; self reads own pledge | pledges |
| votes / hasVoted / progress | | only `status === 'active'` (or legacy records without a status) |

## Gateway and import

`portal/apps-script/Gateway.gs` `exportAll` (admin only) returns every tab of the tracker sheet. `portal/import.html` previews the export, matches rows to portal accounts by roll number then by name, and writes: Roster → users status/sortOrder + roster nodes; Config → settings (only when empty); Event_Info → events; Attendance → attendance + myAttendance; Payments_Fines → ledger; Standards_Adjustments → adjustments; Rollover → rollover; Service_Log → service; Excuses → excuses. Logged in `imports/` and `changeLog/`.

## Term rollover (Settings page)

1. Close the current term (`terms/{id}/status = closed`).
2. Create the next term, set `settings/currentTerm`.
3. Write `rollover/{next}/{uid} = serviceShortfallNext` for everyone with a shortfall (from `OpsCore.computeDemerits`).
4. Charge dues (`dues_{next}`) to every status with `chargedDues`.
Each step is idempotent by key.
