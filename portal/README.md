# Brother Portal — Technical Documentation

The Brother Portal is a Firebase-backed private member portal for active brothers of Theta Tau Zeta Delta. It lives in the `/portal/` directory and is hosted on GitHub Pages alongside the main site — no server required.

---

## Table of Contents

1. [Firebase Setup](#firebase-setup)
2. [First Admin User](#first-admin-user)
3. [Security Rules](#security-rules)
4. [File Structure](#file-structure)
5. [Authentication & Roles](#authentication--roles)
6. [Voting System](#voting-system)
7. [Session Flow](#session-flow)
8. [Database Schema](#database-schema)
9. [Session History & Export](#session-history--export)
10. [Event Timer](#event-timer)
11. [What to Update](#what-to-update)

---

## Firebase Setup

1. **Create a Firebase project** at [console.firebase.google.com](https://console.firebase.google.com).

2. **Enable Google Sign-In**
   - Authentication → Sign-in method → Google → Enable. Set a support email.

3. **Enable Realtime Database**
   - Build → Realtime Database → Create Database. Choose a region. Start in **locked mode**.

4. **Apply security rules**
   - Realtime Database → Rules tab. Paste the full contents of `firebase-database.rules.json` (repo root) and click **Publish**.

5. **Get your web config**
   - Project Settings (gear icon) → Your apps → Add app → Web. Register the app, then copy the `firebaseConfig` object.

6. **Add config to the portal**
   - Open `portal/js/firebase-config.js` and replace the placeholder values with your Firebase project's config.
   - The `apiKey` in Firebase is safe to include in a public repo as long as you restrict it by domain — see step 8.

7. **Authorize your domain**
   - Authentication → Settings → Authorized domains. Add your GitHub Pages domain (e.g. `thetatauzd.github.io`) and any custom domain (e.g. `thetatauzd.org`).

8. **Restrict the API key** *(recommended)*
   - [Google Cloud Console](https://console.cloud.google.com) → APIs & Services → Credentials → your API key → Restrict to HTTP referrers (your domain).

---

## First Admin User

Firebase has no built-in admin bootstrap. Set up the first admin manually:

1. Open the portal and sign in with Google. Submit the registration form with your name and roll number — this creates your user record in the database with `role: "pending"`.
2. In the Firebase console, go to **Realtime Database → users → {your-uid}**.
3. Change `role` from `"pending"` to `"admin"`.
4. Refresh the portal — you will be redirected to the portal home with full admin access.

From there you can approve other brothers and assign roles from the **Admin** panel.

---

## Security Rules

Rules are in `firebase-database.rules.json` at the repo root. Key principles:

- Only authenticated users (`auth != null`) can read session data.
- Brothers can only write their own vote (`auth.uid === $uid`).
- Only `admin` and `standards` roles can create/close polls.
- Only `admin` and `rush_chair` roles can control the event timer.
- `sessionHistory` is readable and writable only by `admin`.
- Connected brothers presence node (`connectedBrothers/$uid`) is writable only by that UID, readable only by that UID — used for kick detection.

**Every time you modify the rules file, re-publish them in the Firebase console.**

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
│
├── css/
│   └── portal.css        # All portal styles (colors, layout, components)
│
└── js/
    ├── firebase-config.js  # Firebase project config — EDIT THIS with your keys
    ├── auth.js             # Auth state, role checks, nav init, sign-in/out
    ├── db.js               # Realtime Database helpers (refs, vote submission, aggregation)
    ├── voting.js           # Brother voting page logic
    ├── standards.js        # Standards session and poll control logic
    ├── regent.js           # Regent display board logic
    ├── admin.js            # Admin user management logic
    └── timer.js            # Synchronized timer logic
```

---

## Authentication & Roles

Sign-in is **Google only**. After signing in for the first time, brothers complete a self-registration form (name and roll number). Their account is set to `pending` until an admin approves it.

| Role | Access |
|---|---|
| `pending` | Waiting screen only. Auto-redirects to portal home the instant an admin approves. |
| `brother` | Portal home, voting page. |
| `standards` | All above + Standards session control. |
| `regent` | All above + Regent display board. |
| `rush_chair` | All above + Event Timer controls. |
| `admin` | Full access: all pages, session history, user management, timer controls. |

Role is stored in `users/{uid}/role` in the Realtime Database. Admins set roles from the Admin panel.

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
   - **Ranked Scorecard** — for Rush Prelim (add candidate list).
   - **Regular Vote** — choose Yes/No, Yes/No/IDK, or custom options.
2. Enter an access code (e.g. `CHAPTER26`) and click **Create session**.
3. Add polls to the queue (name + type). Hit **Enter** or the Add button.
4. Click **Open poll** to start voting. Brothers see the poll live.
5. Click **Close poll** — votes are locked, aggregation is saved, next poll auto-advances.
6. Click **End session** — all brothers are disconnected, session data is saved to history.

If the page is accidentally refreshed, the session auto-reconnects using the same code.

### Brothers (voters)

1. Go to **Voting** and enter the session code.
2. Wait for a poll to open — the waiting screen shows "Up next" and a poll counter.
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

---

## Session History & Export

Session history is saved automatically when Standards clicks **End session**. It is accessible from the dropdown menu (admin only).

**History page features:**
- Click any session card to expand it.
- **Yes/No Vote Summary** card at the top: all yes/no polls in one table, sorted by yes%.
- Individual poll cards show vote counts and yes percentage (no pass/fail judgment — just the numbers).
- **What-if min score**: for ranked/prelim polls, adjust the cutoff score and recalculate the leaderboard live.
- **What-if threshold**: in the summary card, change the threshold for all yes/no polls at once.
- **Show Chapter**: opens `chapter-results.html` — alphabetical pass/fail list without percentages, suitable for chapter display.
- **Export Excel**: downloads `.xlsx` with an **Overview** tab first (poll name, yes, no, abstain, yes%), then one tab per poll with individual votes.
- **Delete**: permanently removes the session from history.

---

## Event Timer

The synchronized event timer at `/portal/timer.html` is controlled by admins and rush chairs. All connected devices see the same countdown in real time.

- **Start / Pause / Resume / Stop** — admin/rush_chair only.
- Supports decimal minutes (e.g. `2.5` = 2 minutes 30 seconds).
- Uses Firebase server time offset to stay synchronized across devices.
- Audio beeps on phase transitions.

Timer state is stored in `timers/active` in the Realtime Database.

---

## What to Update

| Task | Where |
|---|---|
| Firebase API keys | `portal/js/firebase-config.js` |
| Security rules | `firebase-database.rules.json` → republish in Firebase console |
| Embedded Google Calendar | `portal/index.html` — replace the `<iframe>` src |
| Portal resource links (bylaws, absence form, etc.) | `portal/index.html` — the resource cards section |
| Standards report form URL | `portal/index.html` — Standards Report Form link |
| Authorized sign-in domains | Firebase console → Authentication → Authorized domains |
