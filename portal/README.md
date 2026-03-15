# Brother Portal – Setup Guide

## Firebase Setup

1. **Create a Firebase project** at [Firebase Console](https://console.firebase.google.com/).

2. **Enable Google Sign-In**
   - Authentication → Sign-in method → Google → Enable. Set support email.

3. **Create Realtime Database**
   - Build → Realtime Database → Create Database. Pick a region. Start in **locked mode**.

4. **Deploy security rules**
   - In Realtime Database → Rules, paste the contents of `../firebase-database.rules.json` (from repo root), then Publish.

5. **Get Web config**
   - Project Settings (gear) → Your apps → Add app → Web. Register app, copy `firebaseConfig`.

6. **Configure the portal**
   - Edit `portal/js/firebase-config.js` and replace the placeholder `firebaseConfig` with your values.  
   - **Do not commit real API keys** to a public repo. Restrict API key in Google Cloud Console (APIs & Services → Credentials) to your domain and Firebase.

7. **Authorized domains**
   - Authentication → Settings → Authorized domains. Add your GitHub Pages domain (e.g. `username.github.io`) and any custom domain.

## First Admin User

Firebase does not have a “first user” bootstrap. Create the first admin manually:

1. Open your app and sign in with Google once (you will hit the “register” flow; submit with any name/roll so a record is created, or skip and add manually).
2. In **Realtime Database**, go to the `users` node.
3. Find your user by UID (from Authentication → Users, copy the User UID of your Google account) or create a new key with that UID.
4. Set the record to:
   ```json
   {
     "email": "your-google@gmail.com",
     "name": "Your Name",
     "rollNumber": "ADMIN",
     "role": "admin",
     "createdAt": "2025-01-01T00:00:00.000Z"
   }
   ```
5. Sign out and sign in again. You should be redirected to the portal home and can open the Admin panel to approve others and set roles.

## File Structure

- `index.html` – Portal home (brother view) after login.
- `login.html` – Login / self-registration.
- `pending.html` – “Waiting for approval” for pending users.
- `admin.html` – Approve/deny users and manage roles (admin only).
- `voting.html` – Brother voting (access code → vote).
- `regent.html` – Regent display board (`/portal/regent.html`).
- `standards.html` – Standards session and poll control.
- `js/firebase-config.js` – Your Firebase config (edit with your keys).
- `js/auth.js` – Auth state and role-based redirect.
- `js/db.js` – Realtime Database helpers.
- `js/voting.js`, `js/regent.js`, `js/standards.js`, `js/admin.js` – View logic.
- `css/portal.css` – Portal styles.

## Hosting (GitHub Pages)

The portal is static. Build the site as usual; ensure `portal/` is included. Main site links to `portal/index.html` or `/portal/` for the Brother Portal.
