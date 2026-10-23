# Theta Tau Zeta Delta — University of South Carolina

Official website for the Zeta Delta chapter of Theta Tau Professional Engineering Fraternity at USC. Hosted on GitHub Pages at [www.thetatauzd.org](https://www.thetatauzd.org).

---

## Running Locally

No build tools needed. `dev-server.py` serves the repo root the way GitHub Pages does (extensionless
paths such as `/rush` work):

```bash
python3 dev-server.py 8080
# then open http://localhost:8080
```

---

## Project Structure

```
/
├── index.html               # Homepage
├── brotherhood.html         # Brotherhood page
├── profession.html          # Professional development
├── service.html             # Community service
├── rush.html                # Rush information (dynamic open/closed)
│
├── css/
│   ├── site.css             # Main site styles + color variables
│   ├── static.css           # Shared static styles
│   ├── brotherhood_cards.css
│   └── navigation-animations.css
│
├── js/
│   ├── nav.js               # Mobile menu
│   └── rush-config.js       # Rush open/closed status, GroupMe and interest-form links (edit each semester)
│
├── Images/
│   ├── rush/                # All rush-specific images (event photos, backgrounds)
│   ├── Companies/           # Company logos (profession page)
│   └── optimized/           # WebP-optimized versions of photos
│
├── portal/                  # Brother Portal (Firebase-backed)
│   └── (see portal/README.md)
│
├── firebase-database.rules.json   # Firebase Realtime Database security rules
└── package.json
```

---

## What to Update Each Semester

| What | Where |
|---|---|
| **Rush open/closed & next semester** | `js/rush-config.js` — set `isOpen`, `nextSemester`, `rushTitle`, `rushLinkUrl` (new GroupMe) and `interestFormUrl` (Google Form shown while closed) |
| **Rush event photos** | `Images/rush/` — drop in new photos, update paths in `rush.html` |
| **Rush schedule graphics** | `rush.html` — the `FALL 2026 RUSH GRAPHICS` block: swap `Images/rush/f26/` for the new folder and edit the captions. It only shows while `isOpen` is true. |
| **Leadership contacts** (Regent, VR, Rush Chairs, etc.) | Footer on every page: `index.html`, `brotherhood.html`, `profession.html`, `rush.html`, `service.html` |
| **Company logos** | `Images/Companies/` |
| **Brotherhood / service / profession photos** | `Images/` and `Images/optimized/` |

### Rush Page Status (`js/rush-config.js`)

```js
// Set isOpen: true when rush is active, false when it is closed
const rushConfig = {
  isOpen: false,
  nextSemester: 'Fall 2026',
  rushTitle: 'Spring 2026 Rush',
  ctaLine: 'Applications are open — join us!',
  rushLinkUrl: 'https://...'
};
```

When `isOpen` is `false`, the page shows a "Rush is currently closed" banner. When `true`, the rush info section and CTA are shown. The rush event section (specific dates, timeline, comic graphics) is stored in a comment block inside `rush.html` and can be uncommented when needed.

---

## Brand Colors

| Color | Hex | Usage |
|---|---|---|
| Dark Red | `#8B0000` | Primary headings, buttons |
| Gold | `#FFCC33` | Accents, active states, highlights |
| Off-White | `#EDEAB5` | Background tones |

Defined as CSS variables in `css/site.css`.

---

## Deployment

Hosted on **GitHub Pages** — every push to `main` deploys automatically. The `CNAME` file sets the custom domain `thetatauzd.org`.

No build step required. All files are static HTML/CSS/JS.

---

## Brother Portal

A private, Firebase-backed member portal lives at `/portal/`. It requires a USC Google or personal Gmail account and admin approval to access. Full setup and technical documentation in **`portal/README.md`**.

Features: Google Sign-In, role-based access, live voting system (rush bids, motions, PNM votes), session history, Excel export, synchronized event timer, embedded chapter calendar, and more.

---

## Contact

- **Regent**: Jack Schmitt
- **Vice Regent**: Nicole Hoeker
- **Rush Chairs**: Bradley Alford, Kaylee Molitor
- **Alumni Correspondent**: Carlos Arenas
