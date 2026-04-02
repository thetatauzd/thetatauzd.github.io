/**
 * Portal Authentication – Google Sign-In, role check, persistent session.
 * Depends: firebase-config.js, Firebase Auth compat loaded in page.
 */
(function(global) {
  'use strict';

  const auth = typeof firebase !== 'undefined' ? firebase.auth() : null;
  const db = typeof firebase !== 'undefined' ? firebase.database() : null;

  if (!auth) {
    console.warn('Portal auth: Firebase Auth not loaded.');
    return;
  }

  /** @type {{ uid: string, email: string, name: string, role: string } | null } */
  let currentUserProfile = null;

  /**
   * Get current Firebase user. Persistence is set to LOCAL so brothers stay logged in.
   */
  function getAuth() {
    return auth;
  }

  /**
   * Ensure persistence is LOCAL (survives browser close).
   */
  function setPersistence() {
    if (auth && firebase.auth.Auth.Persistence) {
      auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(function(err) {
        console.warn('setPersistence failed', err);
      });
    }
  }

  /**
   * Fetch user profile from Realtime Database. Returns { name, rollNumber, role } or null.
   */
  function getUserProfile(uid) {
    return new Promise(function(resolve) {
      if (!db || !uid) {
        resolve(null);
        return;
      }
      db.ref('users/' + uid).once('value')
        .then(function(snap) {
          const val = snap.val();
          resolve(val ? { name: val.name, rollNumber: val.rollNumber || '', role: val.role || 'pending', email: val.email } : null);
        })
        .catch(function() { resolve(null); });
    });
  }

  /**
   * Get current user's profile (cached for this page load). Fetches from DB if not yet loaded.
   */
  function getCurrentUserProfile() {
    return new Promise(function(resolve) {
      const user = auth.currentUser;
      if (!user) {
        currentUserProfile = null;
        resolve(null);
        return;
      }
      // Always fetch fresh from DB so role changes (e.g., pending -> brother/admin) take effect immediately.
      getUserProfile(user.uid).then(function(profile) {
        if (profile) {
          currentUserProfile = { uid: user.uid, email: user.email, name: profile.name, role: profile.role };
        } else {
          currentUserProfile = { uid: user.uid, email: user.email, name: user.displayName || '', role: 'pending' };
        }
        resolve(currentUserProfile);
      });
    });
  }

  /**
   * Redirect based on role: pending -> pending.html, admin -> admin.html, regent/standards -> can go to regent/standards, brother -> portal index.
   */
  function redirectByRole(role, opts) {
    opts = opts || {};
    const allowQuery = opts.allowQuery || false;
    const page = opts.page || '';
    if (role === 'pending') {
      if (page !== 'pending' && page !== 'login') {
        window.location.href = 'pending';
      }
      return;
    }
    // For non-pending roles, we only redirect explicitly on pages that require
    // a role (admin/regent/standards) via requireAdmin/requireRegent/requireStandards.
    // Admins are allowed to view portal home and other views without being forced
    // back to the admin panel here.
  }

  /**
   * Require auth and non-pending. Resolve with profile or redirect to login/pending.
   */
  function requireAuth(opts) {
    opts = opts || {};
    installBfcacheGuard();
    var authTimeout = setTimeout(function() { revealPage(); }, 8000);
    return new Promise(function(resolve, reject) {
      const unsub = auth.onAuthStateChanged(function(user) {
        unsub();
        clearTimeout(authTimeout);
        if (!user) {
          if (opts.redirect !== false) {
            window.location.href = 'login?redirect=' + encodeURIComponent(window.location.pathname + window.location.search);
          } else {
            resolve(null);
          }
          return;
        }
        setPersistence();
        getCurrentUserProfile().then(function(profile) {
          if (!profile) {
            if (opts.redirect !== false) window.location.href = 'login';
            resolve(null);
            return;
          }
          const page = opts.page || '';
          redirectByRole(profile.role, {
            page: page,
            allowQuery: true,
            forcePortalHome: opts.forcePortalHome === true
          });
          resolve(profile);
        });
      });
    });
  }

  /**
   * Require admin role. Redirect to portal home if not admin.
   */
  function requireAdmin() {
    return requireAuth({ page: 'admin' }).then(function(profile) {
      if (profile && profile.role !== 'admin') {
        window.location.href = '/portal';
        return null;
      }
      return profile;
    });
  }

  function requireRegent() {
    return requireAuth({ page: 'regent' }).then(function(profile) {
      if (profile && profile.role !== 'admin') {
        window.location.href = '/portal';
        return null;
      }
      return profile;
    });
  }

  function requireStandards() {
    return requireAuth({ page: 'standards' }).then(function(profile) {
      if (profile && profile.role !== 'admin') {
        window.location.href = '/portal';
        return null;
      }
      return profile;
    });
  }

  function requireRushChair() {
    return requireAuth({ page: 'timer' }).then(function(profile) {
      if (profile && profile.role !== 'rush_chair' && profile.role !== 'admin') {
        window.location.href = '/portal';
        return null;
      }
      return profile;
    });
  }

  /**
   * Sign in with Google. Returns promise.
   */
  function signInWithGoogle() {
    setPersistence();
    const provider = new firebase.auth.GoogleAuthProvider();
    return auth.signInWithPopup(provider);
  }

  /**
   * Sign out.
   */
  function signOut() {
    return auth.signOut().then(function() {
      currentUserProfile = null;
    });
  }

  /**
   * Register new brother (create/update user record with role pending). Call after Google sign-in.
   */
  function registerBrother(uid, email, name, rollNumber) {
    if (!db) return Promise.reject(new Error('Database not loaded'));
    const ref = db.ref('users/' + uid);
    return ref.once('value').then(function(snap) {
      if (snap.exists() && snap.val().role !== 'pending') {
        return Promise.resolve(); // already approved
      }
      return ref.set({
        email: email || '',
        name: name || '',
        rollNumber: rollNumber || '',
        role: 'pending',
        createdAt: new Date().toISOString()
      });
    });
  }

  /**
   * Remove the auth wall and show page content. Called automatically by initNav;
   * pages that skip initNav (e.g. pending.html) should call this explicitly.
   */
  function revealPage() {
    document.body.classList.remove('auth-pending');
    var sp = document.getElementById('auth-spinner');
    if (sp) sp.remove();
  }

  /**
   * Re-lock the page behind the auth wall (used by bfcache guard).
   */
  function lockPage() {
    document.body.classList.add('auth-pending');
    if (!document.getElementById('auth-spinner')) {
      var sp = document.createElement('div');
      sp.className = 'auth-spinner';
      sp.id = 'auth-spinner';
      sp.innerHTML = '<div class="sp"></div>';
      document.body.insertBefore(sp, document.body.firstChild);
    }
  }

  var bfcacheGuardInstalled = false;

  /**
   * Guard against the browser back-button restoring a cached authenticated page.
   * On bfcache restore, re-lock the page and verify the user is still signed in.
   */
  function installBfcacheGuard() {
    if (bfcacheGuardInstalled) return;
    bfcacheGuardInstalled = true;
    window.addEventListener('pageshow', function(e) {
      if (!e.persisted) return;
      lockPage();
      var unsub = auth.onAuthStateChanged(function(user) {
        unsub();
        if (user) {
          revealPage();
        } else {
          window.location.replace('login');
        }
      });
    });
  }

  /**
   * Initialize the standard portal nav dropdown: role-based link visibility,
   * dropdown toggle, and sign-out. Call after auth resolves with a profile.
   */
  function initNav(profile) {
    revealPage();
    if (!profile) return;
    var role = profile.role || '';

    var nameEl = document.getElementById('user-name');
    if (nameEl) nameEl.textContent = profile.name || profile.email || 'Brother';

    if (role === 'admin') {
      var r = document.getElementById('link-regent');
      if (r) r.classList.remove('hidden');
      var s = document.getElementById('link-standards');
      if (s) s.classList.remove('hidden');
      var a = document.getElementById('link-admin');
      if (a) a.classList.remove('hidden');
      var h = document.getElementById('link-history');
      if (h) h.classList.remove('hidden');
    }
    if (role === 'rush_chair' || role === 'admin') {
      var t = document.getElementById('link-timer');
      if (t) t.classList.remove('hidden');
    }

    var ddToggle = document.getElementById('dd-toggle');
    var ddNav = document.getElementById('nav-dropdown');
    if (ddToggle && ddNav) {
      ddToggle.addEventListener('click', function() { ddNav.classList.toggle('open'); });
      document.addEventListener('click', function(e) {
        if (!ddNav.contains(e.target)) ddNav.classList.remove('open');
      });
    }

    var signoutBtn = document.getElementById('btn-signout');
    if (signoutBtn) {
      signoutBtn.addEventListener('click', function() {
        signOut().then(function() { window.location.href = 'login'; });
      });
    }
  }

  global.PortalAuth = {
    getAuth: getAuth,
    setPersistence: setPersistence,
    getUserProfile: getUserProfile,
    getCurrentUserProfile: getCurrentUserProfile,
    redirectByRole: redirectByRole,
    requireAuth: requireAuth,
    requireAdmin: requireAdmin,
    requireRegent: requireRegent,
    requireStandards: requireStandards,
    requireRushChair: requireRushChair,
    signInWithGoogle: signInWithGoogle,
    signOut: signOut,
    registerBrother: registerBrother,
    initNav: initNav,
    revealPage: revealPage
  };
})(typeof window !== 'undefined' ? window : this);
