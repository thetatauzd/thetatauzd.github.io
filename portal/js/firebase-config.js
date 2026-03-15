/**
 * Firebase Configuration for Brother Portal
 *
 * SETUP INSTRUCTIONS:
 * 1. Go to https://console.firebase.google.com/
 * 2. Create a new project (or use existing)
 * 3. Enable Authentication > Sign-in method > Google
 * 4. Create a Realtime Database (not Firestore). Choose a region.
 * 5. In Project Settings (gear) > Your apps > Add app > Web. Copy the config object.
 * 6. Replace the placeholder values below with your firebaseConfig.
 * 7. Do NOT commit real API keys to public repos. For GitHub Pages, use environment
 *    variables at build time or restrict Firebase Auth domain and API key in Google Cloud Console.
 *
 * FIRST ADMIN USER:
 * After deploying, create the first user in Firebase Console:
 * - Authentication: Add a user (or use Google Sign-In once and note the UID).
 * - Realtime Database: Manually add under "users" node:
 *   users/<UID> : { "email": "admin@example.com", "name": "Admin Name", "rollNumber": "", "role": "admin", "createdAt": "<timestamp>" }
 * Then that Google account can sign in and access the Admin panel to approve others.
 */
(function(global) {
  'use strict';

  // Theta Tau Zeta Delta – Brother Portal (project: thetatauzd-2ab25)
  // Restrict API key to your domain in Google Cloud Console > APIs & Services > Credentials.
  const firebaseConfig = {
    apiKey: 'AIzaSyB7hAKBXbY79fd4UDDpV6cWLk_xvflCq8E',
    authDomain: 'thetatauzd-2ab25.firebaseapp.com',
    databaseURL: 'https://thetatauzd-2ab25-default-rtdb.firebaseio.com',
    projectId: 'thetatauzd-2ab25',
    storageBucket: 'thetatauzd-2ab25.firebasestorage.app',
    messagingSenderId: '64856224835',
    appId: '1:64856224835:web:56e533dd81bd3111d450f6'
  };

  // Initialize Firebase (compat SDK loaded via script tags in each page)
  if (typeof firebase !== 'undefined' && firebase.apps && firebase.apps.length === 0) {
    firebase.initializeApp(firebaseConfig);
  }

  global.PORTAL_FIREBASE_CONFIG = firebaseConfig;
})(typeof window !== 'undefined' ? window : this);
