# Brother Portal: Technical Documentation

The Brother Portal is a Firebase-backed private member portal for active brothers of Theta Tau Zeta Delta. It lives in the `/portal/` directory and is hosted on GitHub Pages alongside the main site, no server required.

---

## Table of Contents

1. [Firebase Setup](#firebase-setup)
2. [First Admin User](#first-admin-user)
3. [Security Rules](#security-rules)
4. [File Structure](#file-structure)
5. [Authentication & Roles](#authentication--roles)
6. [Chapter Ops](#chapter-ops)
7. [Voting System](#voting-system)
8. [Session Flow](#session-flow)
9. [Database Schema](#database-schema)
10. [Session History & Export](#session-history--export)
11. [Event Timer](#event-timer)
12. [Newsletters](#newsletters)
13. [What to Update](#what-to-update)

---

## Firebase Setup

1. **Create a Firebase project** at [console.firebase.google.com](https://console.firebase.google.com).

2. **Enable Google Sign-In**
   - Authentication → Sign-in method → Google → Enable. Set a support email.

3. **Enable Realtime Database**
   - Build → Realtime Database → Create Database. Choose a region. Start in **locked mode**.

4. **Apply security rules**
   - Brand-new database: `firebase use <your-project-id>`, then `firebase deploy --only database` (there is nothing live
     to lose yet). Every later change: `scripts/publish-rules.sh`, see [Security Rules](#security-rules).

   Note: newsletters intentionally do **not** use Firebase Storage, Cloud Storage for Firebase now requires the paid Blaze plan even within the free-tier quota, and this project stays on the free Spark plan. Newsletter PDFs live in Google Drive; only a share link is stored in the database. See [Newsletters](#newsletters).

5. **Get your web config**
   - Project Settings (gear icon) → Your apps → Add app → Web. Register the app, then copy the `firebaseConfig` object.

6. **Add config to the portal**
   - Open `portal/js/firebase-config.js` and replace the placeholder values with your Firebase project's config.
   - The `apiKey` in Firebase is safe to include in a public repo as long as you restrict it by domain, see step 8.

7. **Authorize your domain**
   - Authentication → Settings → Authorized domains. Add your GitHub Pages domain (e.g. `thetatauzd.github.io`) and any custom domain (e.g. `thetatauzd.org`).

8. **Restrict the API key** *(recommended)*
   - [Google Cloud Console](https://console.cloud.google.com) → APIs & Services → Credentials → your API key → Restrict to HTTP referrers (your domain).

---

## First Admin User

Firebase has no built-in admin bootstrap. Set up the first admin manually:

1. Open the portal and sign in with Google. Submit the registration form with your name and roll number, this creates your user record in the database with `role: "pending"`.
2. In the Firebase console, go to **Realtime Database → users → {your-uid}**.
3. Change `role` from `"pending"` to `"admin"`.
4. Refresh the portal, you will be redirected to the portal home with full admin access.

From there you can approve other brothers and assign roles from the **Admin** panel.

---

## Security Rules

Rules are in `firebase-database.rules.json` at the repo root. Key principles:

- Only authenticated users (`auth != null`) can read session data.
- Brothers can only write their own vote (`auth.uid === $uid`).
- Only `admin` and `standards` roles can create/close polls.
- Only `admin` and `rush_chair` roles can control the event timer.
- `sessionHistory` is readable and writable only by `admin`.
- Connected brothers presence node (`connectedBrothers/$uid`) is writable only by that UID, readable only by that UID, used for kick detection.
- `newsletters` is publicly readable (powers the public `/newsletter` page) but writable only by `admin`.

**Publish the rules only with `scripts/publish-rules.sh`.** The live rules must never lose a node: an older copy of
this file (for example from before Chapter Ops) silently removes rules and can let any Google account make itself admin.
From the repo root, on a branch that has `firebase.json`:

```
scripts/publish-rules.sh                    # nothing at the top level may change
scripts/publish-rules.sh "site,familyTree"  # name every top-level node you meant to add or change
```

It stops without publishing if the file would remove a live node, touch a node you did not name, or drop the
`users/$uid` guard that keeps new sign-ups from making themselves admin. It prints every changed rule, asks before
publishing, and checks afterwards that the live rules equal the file. Never paste the file into the console instead.

---

## File Structure

```
portal/
├── index.html            # Portal home (brother view)
├── login.html            # Google Sign-In + self-registration
├── pending.html          # "Waiting for approval" screen (auto-redirects on approval)
├── voting.html           # Brother voting page (enter code → vote)
├── standards.html        # Standards session control panel
├── regent.html           # Regent display board (projector view)
├── admin.html            # User management (admin only)
├── history.html          # Session history & export (admin only)
├── chapter-results.html  # Chapter-friendly results view (pass/fail, no percentages)
├── timer.html            # Synchronized event timer
├── newsletters-admin.html # Upload & manage chapter newsletters (admin only)
├── tracker.html          # Theta Tau Tracker: a brother's own row, read live from the Tracker sheet (js/tracker.js)
├── tracker-preview.html  # Officers: the site's My Tracker computed from the sheet copy (js/ops-tracker.js)
├── excuse.html, log-service.html   # Site forms (sheet mode: a notice and a button to the Google Form)
├── attendance, standards-board, treasurer, service, marshal, member, semester, settings .html
│                         # Chapter Ops officer pages (read-only previews while the sheet is the record)
├── import.html           # Admin: Refresh from sheet
├── family-tree.html      # Big/little family tree
├── portal-links.html, site-admin.html   # Admin: home page links, public rush page
├── ops-tests.html, sync-tests.html      # Test pages (pure code, invented names)
├── docs/                 # ops-schema.md, officer-guide.md, semester-checklist.md (not served on the site)
├── apps-script/          # Gateway.gs (Tracker sheet), RosterGateway.gs (sign-up autofill), setup README
│
├── css/
│   └── portal.css        # All portal styles (colors, layout, components)
│
└── js/
    ├── firebase-config.js  # Firebase project config, EDIT THIS with your keys
    ├── auth.js             # Auth state, role checks, nav init, sign-in/out
    ├── db.js               # Realtime Database helpers (refs, vote submission, aggregation)
    ├── voting.js           # Brother voting page logic
    ├── standards.js        # Standards session and poll control logic
    ├── regent.js           # Regent display board logic
    ├── admin.js            # Admin user management logic
    ├── newsletters.js      # Newsletter upload/list/delete logic
    ├── timer.js            # Synchronized timer logic
    ├── ops-core.js         # Chapter Ops math (pure): demerits, dues, late fees, service, pledges
    ├── ops-db.js           # Chapter Ops Firebase glue (PortalOps), including the preview helpers
    ├── ops-mode.js         # OpsMode: who owns the tracker data (settings/mode), the Google Form links
    ├── sheet-sync-core.js  # Pure mapper from the Tracker sheet export to the site's copy
    ├── sheet-sync.js       # PortalSync: Refresh from sheet (admins)
    └── family-tree-core.js, family-tree.js, portal-links-core.js, ops-photos.js, …
```

---

## Authentication & Roles

Sign-in is **Google only**. After signing in for the first time, brothers complete a self-registration form (name and roll number). Their account is set to `pending` until an admin approves it.

| Role | Access |
|---|---|
| `pending` | Waiting screen only. Auto-redirects to portal home the instant an admin approves. |
| `brother` (and `pnm`, `standards`, `regent`) | Portal home, voting, results, Theta Tau Tracker, family tree. |
| `rush_chair` | All above + Event Timer controls. |
| `admin` | Full access: all pages, Standards and Regent View, session history, user management, timer controls. |

Role is stored in `users/{uid}/role` in the Realtime Database. It is recomputed from status and positions when an
admin saves someone on User Management (`OpsCore.legacyRole`). The Standards and Regent View pages are admin-only, as
they were before Chapter Ops, whatever the role says.

Chapter Ops pages are opened by capabilities (`users/{uid}/perms`, derived from positions) instead of roles. An
**officer** is an admin, anyone with a position, or anyone with a capability set to true (`PortalAuth.isOfficer`).
Officers see the Chapter Ops menu, the "Officer preview" card on the home page and `tracker-preview`. Menus are built
from `NAV` in `js/auth.js`.

---

## Chapter Ops

Attendance, excuses, demerits, dues, service hours and pledges. The full reference is
[`docs/ops-schema.md`](docs/ops-schema.md); the how-to for each officer is [`docs/officer-guide.md`](docs/officer-guide.md);
the start, end and cut-over steps are in [`docs/semester-checklist.md`](docs/semester-checklist.md).

**Fall 2026: the Tracker sheet is the record.** `settings/mode/source` is `'sheet'` (or missing):
- Brothers keep today's live Theta Tau Tracker (`tracker`, Gateway.gs action `me`) and the Google Forms.
- Officers see the Chapter Ops pages as a read-only preview of a copy of the sheet. No page writes tracker data.
- Admins refresh the copy on **Admin → Refresh from sheet** (`import.html`, `js/sheet-sync.js`). It also refreshes
  itself when an admin opens a preview page and the copy is more than a day old.
- At the cut-over (planned for Spring 2027) an admin refreshes one last time and switches the source on Chapter
  Settings. From then on the site is the record.

**Tests** (none of them touch Firebase):
```
node scripts/sync-tests.js          # the sheet mapper (also portal/sync-tests.html in a browser)
node scripts/sync-runner-tests.js   # Refresh from sheet against an in-memory database
# in a browser, with python3 dev-server.py 8080 running:
#   http://localhost:8080/portal/ops-tests.html   OpsCore and FamilyTreeCore; every line must say OK
```

**This repository is public**, and GitHub Pages serves every file on `main` except what `_config.yml` excludes
(`CLAUDE.md`, `AGENTS.md`, `portal/docs/`). Never commit personal data: no brothers' names next to demerits,
standing, money or notes, no phone numbers, private emails or student IDs, no export of the database, the Tracker
sheet or the family tree poster file. Test fixtures use invented names.

---

## Voting System

### Poll Types

| Type | Ballot | Notes |
|---|---|---|
| **Rush Prelim** (`rush_prelim`) | +2 / +1 / 0 / -1 / -2 per candidate | Scorecard over ~200 candidates. Leaderboard sorted by total score. What-if min score in history. |
| **Rush Bid** (`rush_bid`) | Yes / No / Abstain | 75% threshold (yes / (yes+no)). Abstains excluded. |
| **Motion** (`motion`) | Yes / No / Abstain | Same math as Rush Bid. Threshold set at poll creation. |
| **PNM Vote** (`pnm_vote`) | Yes / No / Abstain | 75% threshold. Standards sees a flag for anyone 2 standard deviations below the mean. |
| **PNM De-pledge** (`pnm_depledge`) | Yes / No | >50% to de-pledge. No abstain. Triggered automatically when Standards confirms a flagged PNM. |
| **Regular Vote** (`regular`) | Custom options | Options defined at session creation (Yes/No, Yes/No/IDK, or custom text list). |
| **Ranked Scorecard** (`ranked`) | +2 / +1 / 0 / -1 / -2 per candidate | Older session type, same mechanics as Rush Prelim. |

### Thresholds

Thresholds are **not adjustable during an active vote**. They are fixed at poll creation. In **Session History**, a what-if threshold slider lets you retroactively recalculate pass/fail for any session.

---

## Session Flow

### Standards (session creator)

1. Go to **Standards** and choose a session type:
   - **Ranked Scorecard**, for Rush Prelim (add candidate list).
   - **Regular Vote**, choose Yes/No, Yes/No/IDK, or custom options.
2. Enter an access code (e.g. `CHAPTER26`) and click **Create session**.
3. Add polls to the queue (name + type). Hit **Enter** or the Add button.
4. Click **Open poll** to start voting. Brothers see the poll live.
5. Click **Close poll**, votes are locked, aggregation is saved, next poll auto-advances.
6. Click **End session**, all brothers are disconnected, session data is saved to history.

If the page is accidentally refreshed, the session auto-reconnects using the same code.

### Brothers (voters)

1. Go to **Voting** and enter the session code.
2. Wait for a poll to open, the waiting screen shows "Up next" and a poll counter.
3. Vote. Confirmation shown immediately. Individual votes are anonymous to other brothers.
4. If kicked by Standards, a kicked screen appears and they are removed from the session.
5. When Standards ends the session, an "ended" screen appears.

### Regent

1. Go to **Regent** and enter the session code.
2. Real-time display of who has **not** voted (names disappear as they vote).
3. Vote count and progress bar update live.
4. When all votes are in, a "Poll Complete" banner appears.

---

## Database Schema

```
users/
  {uid}/
    email, name, rollNumber, role, createdAt

sessionByCode/
  {CODE} = sessionId          # Lookup table: code → session ID. Removed when session ends.

sessions/
  {sessionId}/
    meta/
      accessCode, createdBy, createdAt, status ('active' | 'ended'), sessionType
    currentPollIndex            # Index into pollOrder array
    pollOrder                   # Array of poll IDs in queue order
    polls/
      {pollId}/
        name, type, status ('upcoming' | 'open' | 'closed')
        threshold               # For yes/no types
        minimumScore            # For ranked/prelim types
        candidates              # Array of names (ranked/prelim only)
        votes/
          {uid}/ vote, votedAt
        hasVoted/
          {uid} = true          # Lightweight node for Regent display
        aggregation/
          # yes/no types: { yes, no, abstain }
          # ranked types: { candidateScores: { name: { total, count } }, totalVoters }
    connectedBrothers/
      {uid} = timestamp         # Presence. Removed on disconnect/kick.

sessionHistory/
  {sessionId}/                  # Full snapshot saved when Standards ends session
    accessCode, endedAt, createdAt, createdBy
    polls/
      {pollId}/ name, type, threshold, minimumScore, candidates, aggregation, result
        voters/ {uid}/ name, vote

timers/
  active/
    status ('idle' | 'running' | 'paused' | 'stopped')
    startedAt, duration, pausedAt, elapsed
```

Chapter Ops, the family tree, the portal home links and the rush page settings have their own nodes. They are listed
with their rules in [`docs/ops-schema.md`](docs/ops-schema.md).

---

## Session History & Export

Session history is saved automatically when Standards clicks **End session**. It is accessible from the dropdown menu (admin only).

**History page features:**
- Click any session card to expand it.
- **Yes/No Vote Summary** card at the top: all yes/no polls in one table, sorted by yes%.
- Individual poll cards show vote counts and yes percentage (no pass/fail judgment, just the numbers).
- **What-if min score**: for ranked/prelim polls, adjust the cutoff score and recalculate the leaderboard live.
- **What-if threshold**: in the summary card, change the threshold for all yes/no polls at once.
- **Show Chapter**: opens `chapter-results.html`, alphabetical pass/fail list without percentages, suitable for chapter display.
- **Export Excel**: downloads `.xlsx` with an **Overview** tab first (poll name, yes, no, abstain, yes%), then one tab per poll with individual votes.
- **Delete**: permanently removes the session from history.

---

## Event Timer

The synchronized event timer at `/portal/timer.html` is controlled by admins and rush chairs. All connected devices see the same countdown in real time.

- **Start / Pause / Resume / Stop**, admin/rush_chair only.
- Supports decimal minutes (e.g. `2.5` = 2 minutes 30 seconds).
- Uses Firebase server time offset to stay synchronized across devices.
- Audio beeps on phase transitions.

Timer state is stored in `timers/active` in the Realtime Database.

---

## Website settings (rush page)

Admins open **Admin → Website** (`portal/site-admin.html`, `portal/js/site-admin.js`) to run the public rush page
without touching code: open or close rush, set the title, the next semester, the GroupMe invite and an interest-form
link, upload the poster and one picture per event card, and reorder or remove cards.

- Text is saved under `site/rush` (state, titles, links, card titles and details: about 1 KB). Pictures are saved
  separately under `site/rushPictures` (poster and one per card), shrunk in the browser to JPEG data URLs of at most
  100,000 characters each, so the project stays on the Spark plan. Both are world-readable and admin-written only;
  nothing personal (no names, no emails) is ever saved there.
- `rush.html` decides open or closed from `js/rush-config.js` in the page head, requests `site/rush` right away
  (holding both states hidden for at most 1.5 s), and then applies whatever `site/rush` says. It downloads
  `site/rushPictures` only while rush is open, so a closed rush page costs visitors about 1 KB of the free plan's
  10 GB/month download allowance. The page reads the database with plain HTTPS requests, not the Firebase SDK.
- New semester: press "Start from the Fall 2026 cards" once if the list is empty, swap the pictures, fix the dates,
  switch rush to open, save.
- When rush closes: switch to closed, set the next semester and save. Visitors download no pictures while rush is
  closed, so the pictures can stay for next semester. Do not use "Clear everything saved here" for this: it also wipes
  the interest-form link and the next semester, and the page falls back to `js/rush-config.js`.
- The poster and cards checked into `rush.html` belong to `staticCardsSemester` in `js/rush-config.js` (Fall 2026).
  They show only while the open title names that semester, so an old schedule never appears under a new title.
- The first publish of these rules adds `site` (and `familyTree` from Chapter Ops):
  `scripts/publish-rules.sh "site,familyTree"`. Until then saving fails with "permission denied" and the public page
  uses the files.

## Newsletters

Chapter newsletters are published by admins from `/portal/newsletters-admin.html` and shown publicly (no login required) at `/newsletter`, the main site's newsletter archive.

**Deliberately does not use Firebase Storage.** As of late 2024, Cloud Storage for Firebase requires the paid Blaze plan even to stay within the free-tier quota. To keep this project on the free Spark plan (no billing, no card on file), newsletter PDFs live in **Google Drive** instead, only a share link is stored in Firebase.

**Admin publish flow** (`portal/newsletters-admin.html` + `portal/js/newsletters.js`):
1. Admin uploads the PDF to Drive and sets sharing to "Anyone with the link" (Viewer).
2. Admin pastes the Drive link into the form, along with a title, issue date, and optional description.
3. A metadata record is written to Realtime Database under `newsletters/{pushId}`: `title`, `date`, `description`, `fileURL` (the Drive link), `uploadedBy`, `uploadedAt`.
4. **Delete** removes the database record (the file itself stays in Drive, delete it there separately if you want it fully gone).

**Public page** (`/newsletter.html`, repo root): reads the `newsletters` node directly (public read, no auth) and lists newsletters newest-first with a link to each PDF.

**Email list** (`js/newsletter-signup.js`, `js/newsletter-config.js`, `portal/apps-script/NewsletterGateway.gs`): the public page has a "Get the next issue by email" sign-up box. Addresses go to a private "Newsletter Subscribers" Google Sheet owned by thetatauusc@gmail.com, through its own Apps Script web app; no address is stored in Firebase or this repo. After publishing, an admin presses **Email subscribers** on the issue (in the table, or under the publish form); the script emails each active subscriber once, up to Gmail's ~100 a day, and the next press carries on. Every email links to `/newsletter?unsubscribe=<token>`, where the person presses Unsubscribe. Until `NEWSLETTER_GATEWAY_URL` is set, the page shows "Email sotheta@mailbox.sc.edu to get on the list" instead of the form. Setup, limits and Sheet upkeep: [apps-script/README.md, "Newsletter sign-up gateway"](apps-script/README.md#newsletter-sign-up-gateway).

**Security model:** the Realtime Database `newsletters` node is publicly readable but only `admin`-writable (see [Security Rules](#security-rules)). Since there's no file upload, there's no separate Storage rules concern, the RTDB rule alone gates who can publish.

If you'd rather have one-click file uploads instead of a Drive-link paste step, that's possible by switching back to Firebase Storage, it just requires upgrading the Firebase project to the Blaze plan (billing stays $0/month at this scale, but a card must be on file).

---

## What to Update

| Task | Where |
|---|---|
| Firebase API keys | `portal/js/firebase-config.js` |
| Security rules | `firebase-database.rules.json` → `scripts/publish-rules.sh` (see Security Rules) |
| Embedded Google Calendar | **Admin → Portal Links** (calendar link); the fallback is the `<iframe>` in `portal/index.html` |
| Portal home links (bylaws, forms, resources) | **Admin → Portal Links**; the built-in set is in `portal/js/portal-links-core.js` |
| Google Forms for excuses and service hours (sheet mode) | `OpsMode.FORMS` in `portal/js/ops-mode.js`, or `settings/mode/forms` |
| Header menus | `NAV` in `portal/js/auth.js` |
| Chapter numbers (demerits, dues, service) | **Chapter Settings** (after the switch to the site); defaults in `OpsCore.DEFAULTS` |
| Authorized sign-in domains | Firebase console → Authentication → Authorized domains |
