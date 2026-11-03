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
          resolve(val ? { name: val.name, rollNumber: val.rollNumber || '', role: val.role || 'pending', email: val.email,
            status: val.status || (val.role === 'pending' ? 'pending' : 'active'),
            positions: val.positions || {}, perms: val.perms || {} } : null);
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
          currentUserProfile = {
            uid: user.uid, email: user.email, name: profile.name,
            rollNumber: profile.rollNumber || '', role: profile.role,
            status: profile.status, positions: profile.positions, perms: profile.perms
          };
        } else {
          currentUserProfile = {
            uid: user.uid, email: user.email, name: user.displayName || '',
            rollNumber: '', role: 'pending', status: 'pending', positions: {}, perms: {}
          };
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

  // The voting pages (Regent View, Standards) stay admin-only, exactly as on the
  // live site before Chapter Ops. Do not widen these without the owner.
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
   * True when the profile may do `perm` (finance, attendance, standards,
   * service, pledges, settings). Admin may do everything.
   */
  function hasPerm(profile, perm) {
    if (!profile) return false;
    if (profile.role === 'admin') return true;
    return !!(profile.perms && profile.perms[perm]);
  }

  /**
   * Require any one of the listed capabilities (or admin). Redirects home otherwise.
   * requirePerm('finance') or requirePerm(['attendance', 'standards']).
   */
  function requirePerm(perms, opts) {
    var list = Array.isArray(perms) ? perms : [perms];
    return requireAuth(Object.assign({ page: list[0] }, opts || {})).then(function(profile) {
      if (!profile) return null;
      var ok = list.some(function(p) { return hasPerm(profile, p); });
      if (!ok) { window.location.href = '/portal'; return null; }
      return profile;
    });
  }

  /**
   * An officer is an admin, anyone holding a position (users/{uid}/positions
   * exists), or anyone with a capability set to true in users/{uid}/perms.
   * Officers see the Chapter Ops preview pages; brothers do not.
   */
  function isOfficer(profile) {
    if (!profile) return false;
    if (profile.role === 'admin') return true;
    var pos = profile.positions || {}, perms = profile.perms || {};
    if (Object.keys(pos).length > 0) return true;
    return Object.keys(perms).some(function(k) { return perms[k] === true; });
  }

  /**
   * Require an officer. Anyone else is sent to opts.fallback (default the
   * portal home), so a brother who opens a preview link lands somewhere useful.
   */
  function requireOfficer(opts) {
    opts = opts || {};
    var fallback = opts.fallback || '/portal';
    return requireAuth(opts).then(function(profile) {
      if (!profile) return null;
      if (!isOfficer(profile)) { window.location.href = fallback; return null; }
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
   * The three header menus, in one place. Every page ships the same empty
   * shells (#dd-menu, #ops-dd-menu, #admin-dd-menu); this fills them, so a new
   * page is added to the site's navigation by adding one line here.
   *   perm: shown to holders of any listed capability (admins always)
   *   roles: shown to those legacy roles
   *   officer: shown to officers only (see isOfficer)
   *   form: 'excuse' | 'service'. While the Tracker sheet is the record
   *         (OpsMode), the link goes to that Google Form instead of href.
   *   siteOnly: hidden while the Tracker sheet is the record (the page writes
   *         tracker data, so it has nothing to do until the switch).
   */
  var NAV = {
    me: [
      { href: '/portal', label: 'Portal home' },
      { href: 'voting', label: 'Voting' },
      { href: 'tracker', label: 'Theta Tau Tracker' },
      { href: 'excuse', label: 'Request an excuse', form: 'excuse' },
      { href: 'log-service', label: 'Log service hours', form: 'service' },
      { href: 'family-tree', label: 'Family Tree' },
      { href: 'timer', label: 'Event Timer', roles: ['rush_chair', 'admin'] },
      { href: '/', label: 'Back to Site' }
    ],
    ops: [
      { href: 'tracker-preview', label: 'My Tracker (preview)', officer: true },
      { href: 'attendance', label: 'Attendance', perm: ['attendance', 'standards'] },
      { href: 'standards-board', label: 'Standards Board', perm: ['standards', 'settings'] },
      { href: 'treasurer', label: 'Treasurer', perm: ['finance'] },
      { href: 'service', label: 'Service Hours', perm: ['service', 'standards'] },
      { href: 'marshal', label: 'Marshal', perm: ['pledges', 'standards'] },
      { href: 'semester', label: 'Semester Setup', perm: ['settings', 'attendance'], siteOnly: true },
      { href: 'settings', label: 'Chapter Settings', perm: ['settings'] },
      { href: 'https://github.com/thetatauzd/thetatauzd.github.io/blob/main/portal/docs/officer-guide.md', label: 'Officer guide', officer: true }
    ],
    admin: [
      { href: 'admin', label: 'User Management' },
      { href: 'portal-links', label: 'Portal Links' },
      { href: 'import', label: 'Refresh from sheet' },
      { href: 'newsletters-admin', label: 'Newsletters' },
      { href: 'site-admin', label: 'Website' },
      { section: 'Voting' },
      { href: 'standards', label: 'Standards' },
      { href: 'regent', label: 'Regent View' },
      { href: 'history', label: 'Session History' }
    ]
  };

  /** The NAV entries of one group this profile may see (sections included). */
  function visibleNav(group, profile) {
    return (NAV[group] || []).filter(function(it) {
      if (it.perm && !it.perm.some(function(p) { return hasPerm(profile, p); })) return false;
      if (it.roles && it.roles.indexOf((profile && profile.role) || '') === -1) return false;
      if (it.officer && !isOfficer(profile)) return false;
      return true;
    });
  }

  /** Where a NAV entry points before the mode is known. Sheet mode is the default. */
  function initialHref(it) {
    if (it.form && global.OpsMode) return global.OpsMode.formUrl(it.form, null);
    return it.href;
  }

  function navItemsHtml(items) {
    return items.map(function(it) {
      if (it.section) return '<div class="dd-section-label">' + it.section + '</div>';
      var href = initialHref(it);
      return '<a href="' + href + '"' + (it.form ? ' data-form="' + it.form + '" data-site-href="' + it.href + '"' : '') +
        (it.siteOnly ? ' class="hidden" data-site-only' : '') +
        (/^https:/.test(href) ? ' target="_blank" rel="noopener"' : '') + '>' + it.label + '</a>';
    }).join('');
  }

  function buildMenus(profile) {
    var meMenu = document.getElementById('dd-menu');
    if (meMenu) meMenu.innerHTML = navItemsHtml(visibleNav('me', profile)) + '<div class="dd-divider"></div><button type="button" class="dd-signout" id="btn-signout">Sign out</button>';
    var opsMenu = document.getElementById('ops-dd-menu');
    if (opsMenu) opsMenu.innerHTML = navItemsHtml(visibleNav('ops', profile));
    var adminMenu = document.getElementById('admin-dd-menu');
    if (adminMenu) adminMenu.innerHTML = navItemsHtml(visibleNav('admin', profile));
  }

  /**
   * OpsMode for pages that did not load js/ops-mode.js themselves (the voting
   * pages, for example). Loaded once, on demand. Resolves null if it fails.
   * Keep the ?v= here equal to the one the pages use for ops-mode.js.
   */
  var opsModeScript = null;
  function withOpsMode() {
    if (global.OpsMode) return Promise.resolve(global.OpsMode);
    if (opsModeScript) return opsModeScript;
    opsModeScript = new Promise(function(resolve) {
      var s = document.createElement('script');
      s.src = 'js/ops-mode.js?v=32';
      s.onload = function() { resolve(global.OpsMode || null); };
      s.onerror = function() { resolve(null); };
      document.head.appendChild(s);
    });
    return opsModeScript;
  }

  /**
   * Point the excuse and service entries at the Google Forms while the Tracker
   * sheet is the record, and at the site's own forms once the site is. In sheet
   * mode the Chapter Ops menu also says its pages are a preview.
   */
  function applyModeToMenus() {
    var links = [].slice.call(document.querySelectorAll('.portal-header a[data-form]'));
    var opsMenu = document.getElementById('ops-dd-menu');
    if (!links.length && !(opsMenu && opsMenu.querySelector('a'))) return;
    withOpsMode().then(function(M) {
      if (!M) return null;
      return M.load().then(function(mode) {
        var sheet = M.isSheet(mode);
        [].forEach.call(document.querySelectorAll('.portal-header a[data-site-only]'), function(a) {
          a.classList.toggle('hidden', sheet);
        });
        links.forEach(function(a) {
          if (sheet) {
            a.href = M.formUrl(a.getAttribute('data-form'), mode);
            a.target = '_blank';
            a.rel = 'noopener';
          } else {
            a.href = a.getAttribute('data-site-href');
            a.removeAttribute('target');
            a.removeAttribute('rel');
          }
        });
        if (sheet && opsMenu && opsMenu.querySelector('a') && !opsMenu.querySelector('.dd-preview-label')) {
          opsMenu.insertAdjacentHTML('afterbegin', '<div class="dd-section-label dd-preview-label">Preview from the Tracker sheet</div>');
        }
      });
    }).catch(function() {});
  }

  /**
   * Initialize the portal nav: role-based visibility, dropdown toggles, sign-out.
   * Admins get a separate "Admin" dropdown holding every admin-only tool; the
   * Chapter Ops dropdown shows when the person can open any page in it.
   * Call after auth resolves with a profile.
   */
  function initNav(profile) {
    revealPage();
    if (!profile) return;
    var role = profile.role || '';

    var nameEl = document.getElementById('user-name');
    if (nameEl) nameEl.textContent = profile.name || profile.email || 'Brother';

    buildMenus(profile);
    applyModeToMenus();

    if (role === 'admin') {
      var adminDd = document.getElementById('admin-dropdown');
      if (adminDd) adminDd.classList.remove('hidden');
    }

    // Chapter Ops menu shows when the person holds any capability it links to.
    var opsDd = document.getElementById('ops-dropdown');
    if (opsDd) opsDd.classList.toggle('hidden', !opsDd.querySelector('a'));

    var dropdowns = [].slice.call(document.querySelectorAll('.nav-dropdown'));
    dropdowns.forEach(function(dd) {
      var toggle = dd.querySelector('.nav-dropdown-toggle');
      if (!toggle) return;
      toggle.addEventListener('click', function(e) {
        e.stopPropagation();
        dropdowns.forEach(function(other) {
          if (other !== dd) other.classList.remove('open');
        });
        dd.classList.toggle('open');
      });
    });
    document.addEventListener('click', function(e) {
      dropdowns.forEach(function(dd) {
        if (!dd.contains(e.target)) dd.classList.remove('open');
      });
    });

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
    requirePerm: requirePerm,
    hasPerm: hasPerm,
    isOfficer: isOfficer,
    requireOfficer: requireOfficer,
    visibleNav: visibleNav,
    withOpsMode: withOpsMode,
    signInWithGoogle: signInWithGoogle,
    signOut: signOut,
    registerBrother: registerBrother,
    initNav: initNav,
    revealPage: revealPage
  };
})(typeof window !== 'undefined' ? window : this);
