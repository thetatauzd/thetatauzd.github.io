# Theta Tau Zeta Delta at the University of South Carolina

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
├── newsletter.html          # Newsletter archive (read from Firebase)
├── 404.html                 # Not-found page
│
├── css/
│   ├── design.css           # The design system: tokens, components, legibility rules (loaded last)
│   ├── site.css             # Legacy layout base (Squarespace export)
│   └── static.css           # Legacy shared styles
│
├── js/
│   ├── nav.js               # Header state and the mobile menu (modal dialog)
│   ├── rush-config.js       # Rush open/closed fallback, GroupMe and interest-form links
│   ├── site-stats.js        # Chapter numbers shown on the home and service pages
│   └── awards.js            # National awards list on the home page
│
├── Images/
│   ├── photos/              # Responsive photo sets made by scripts/make-images.sh (<slug>-<width>.webp/.jpg)
│   ├── brand/               # Palmetto logo, Coat of Arms, app icons
│   ├── logos/               # Company logos for the rush logo strip
│   ├── video/               # Short silent highlight reels and their posters
│   └── rush/                # Rush poster and event cards (fallback for the Website page)
│
├── scripts/
│   ├── make-images.sh       # Photo -> responsive WebP/JPEG sets (macOS: sips + cwebp; run in a normal Terminal)
│   ├── brand-tool.swift     # Lifts/trims logos for Images/brand
│   └── publish-rules.sh     # Safe Firebase rules publish
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
| **Rush open/closed, title, GroupMe link, interest form, poster and event cards** | Portal → Admin → **Website** (no code). Saved under `site/rush` in Firebase and read by `rush.html`. If nothing has been saved there, the page falls back to `js/rush-config.js` and the pictures in `Images/rush/`. |
| **Photos anywhere on the site** | Put the original in a folder, run `sh scripts/make-images.sh <folder>` and paste the printed `<picture>` markup. Never reuse a published filename: give a new photo a new name. |
| **Rush schedule graphics (fallback only)** | `rush.html`: the `FALL 2026 RUSH GRAPHICS` block, used only when nothing is saved on the Website page. |
| **Leadership contacts** (Regent, VR, Rush Chairs, etc.) | Footer on every page: `index.html`, `brotherhood.html`, `profession.html`, `rush.html`, `service.html`, `newsletter.html` |
| **Company logos** | `Images/logos/` (the rush logo strip); the profession page uses the collage in `Images/photos/companies-collage-*` |
| **Brotherhood / service / profession photos** | `Images/photos/`, made with `scripts/make-images.sh` (see "Photos anywhere on the site") |

### Rush Page Status (`js/rush-config.js`)

This file is the fallback only: whatever an admin saves on Portal → Admin → **Website** wins over it.

```js
var CURRENT_RUSH = "Spring 2027";
window.RUSH_CONFIG = {
  isOpen: false,                 // true shows the schedule, signup and GroupMe; false shows the "Rush has closed" banner
  nextSemester: CURRENT_RUSH,    // closed banner: "Next rush: ..."
  rushTitle: CURRENT_RUSH + " Rush",
  ctaLine: "Join the Rush GroupMe to keep up with every event.",
  rushLinkUrl: "",               // the current GroupMe invite; "" hides the button
  interestFormUrl: "",           // interest-list Google Form, shown all year; "" hides it
  staticCardsSemester: "Fall 2026"  // semester of the poster and cards in Images/rush/f26/
};
```

The comments at the top of `js/rush-config.js` say what to change when rush opens or closes.

---

## Brand Colors

| Color | Hex | Usage |
|---|---|---|
| Dark Red | `#8B0000` | Primary headings, buttons |
| Gold | `#FFCC33` | Accents, active states, highlights |
| Off-White | `#EDEAB5` | Background tones |

From the 2018 Theta Tau style guide. Dark red and gold are the `--maroon` and `--gold` tokens at the top of `css/design.css`, the shared design system every public page loads last.

---

## Deployment

Hosted on **GitHub Pages**: every push to `main` deploys automatically. The `CNAME` file sets the custom domain `thetatauzd.org`.

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
