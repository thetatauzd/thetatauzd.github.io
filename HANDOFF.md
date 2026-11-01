# Handoff, 1 November 2026

Where the website and portal work stands, written for whoever picks this up on a machine that can run the
Firebase CLI. Delete this file once everything below is merged and published.

## Branches on GitHub

| Branch | What is on it | State |
|---|---|---|
| `main` | The live site. Includes the tracker pause (menu link and home tiles removed, tracker page shows a paused notice, assets v=24). | Live |
| `public-site-phase0` | Everything public-site: Phase 0 fixes, copy pass, Website admin page, stats/awards/signature events. Already contains `main`. | Pushed, not merged. Merging it is one fast-forward. |
| `chapter-ops-uce4qa` | Chapter Ops (attendance, standards, treasurer, service, marshal, settings, My Tracker) and the Family Tree. 21 commits ahead of `main`, one behind (the tracker pause). | Pushed, not merged. Needs `main` merged in first (the tracker pause touches the same portal menus). |

## To go live with the public-site work

1. `git checkout main && git merge public-site-phase0 && git push`
2. Publish the database rules (the branch adds a `site` node): `firebase deploy --only database`. Until this is
   done the new Admin → Website page fails to save with "permission denied". Check with
   `firebase database:get "/.settings/rules"`.
3. Load https://www.thetatauzd.org/?cb=1 and /rush?cb=1 and /portal/?cb=1.
4. Sign in as admin, open Admin → Website, press "Start from the Fall 2026 cards", switch rush to closed, Save.

## To go live with Chapter Ops and the Family Tree

1. `git checkout chapter-ops-uce4qa && git merge main` (resolve the portal menu conflicts: keep the Website
   link and drop the tracker link), then merge into `main` and push.
2. Publish the rules again (the branch adds `familyTree` and all the ops nodes).
3. User Management → "Refresh everyone's permissions".
4. Family Tree → "Import the Canva poster" (first open, while empty).
5. Read `portal/docs/semester-checklist.md` and `portal/docs/officer-guide.md` on that branch.

## What was done this session, in order

1. Family Tree in the portal (chapter-ops branch): pure layout core, pannable SVG, photos, editing by exec,
   PNG export, backup/restore, 496 members imported from the Canva poster and reconciled with the Drive
   Brother List and the big/little match sheets, signs of office, black pills for removed brothers.
2. Website game plan: https://claude.ai/artifact/2EeZA6ehbkF1Fqjvn4arfu (private until shared). Review of
   the site, 43 chapter sites catalogued, award criteria, brand and USC rules, recommended sitemap, four
   phases, content-gathering table, drafted award entry.
3. Phase 0 on `public-site-phase0`: rush closed with a state-aware page, Instagram contact in the footer, dark
   text on gold buttons, absolute head tags and a social preview image, robots/sitemap/404, heavy photos
   re-encoded, typos, purpose and tagline, RSO line, portal link de-emphasised, dead files removed.
4. Tracker pause on `main` (live).
5. Copy pass: no em dashes in any visible text, marketing filler rewritten with real facts.
6. Admin → Website page: open or close rush, title, next semester, GroupMe and interest-form links, poster and
   event cards with pictures, saved under `site/rush`; the public rush page reads it and falls back to the files.
7. Stats in `js/site-stats.js` (480+ brothers, 67 active, 900+ hours, 911.5 in Spring 2026, 1,000+ students,
   3.8 GPA, chartered Feb 5, 2011, years computed), awards in `js/awards.js` rendered on the home page,
   signature events on the service page, `CURRENT_RUSH` in `js/rush-config.js`, newsletter page states fixed.

## Still open from the game plan

- Phase 1: rush page substance (eligibility, cost, process, FAQ, a Google Form interest list), About, Brothers
  (exec board), Contact pages, role email aliases. Needs facts from exec: see the content table in the plan.
- Phase 2: one shared template, content in data files, image pipeline, cookieless analytics.
- Phase 3: public read-only family tree, roster, gallery, history, sponsorship, award entry by mid-April 2027.
- Needs from you: a chapter email address, an interest-form URL (paste it on the Website page), a new interns
  graphic (the current one says Summer 2025), and a chapter vote on publishing dues.

## Rules of the road (also in CLAUDE.md on the chapter-ops branch)

Plain ES5, no build step, Spark plan only, the rules file is the only security and must be published,
bump `?v=` on every portal page when portal JS or CSS changes, run `python3 dev-server.py 8080` locally,
test with a non-admin account, plain commit messages with no trailers.
