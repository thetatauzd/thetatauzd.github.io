/**
 * PortalLinks — the link tiles on the portal home page, editable by admins at
 * portal-links (no code change needed to add, rename, reorder or hide a link).
 *
 *   portalLinks/sections/{id} = { title, order, links: { {id}: { label, url, icon, order, audience, hidden } } }
 *   portalLinks/calendarUrl   = Google Calendar embed URL (optional)
 *
 * audience: all | active (everyone but PNMs) | pnm | officers (holds any capability) | admin
 * url: https://… or a portal page such as "tracker". Anything else is refused,
 * so a pasted javascript: link can never run.
 * DEFAULT is what shows until an admin saves the first change.
 */
(function (global) {
  'use strict';

  var ICONS = {
    "vote": "<polyline points=\"9 11 12 14 22 4\"/><path d=\"M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11\"/>",
    "timer": "<circle cx=\"12\" cy=\"13\" r=\"8\"/><path d=\"M12 9v4l2.5 2\"/><path d=\"M9 2h6\"/>",
    "grid": "<rect x=\"3\" y=\"3\" width=\"18\" height=\"18\" rx=\"2\"/><path d=\"M3 9h18M9 21V9\"/>",
    "bulb": "<path d=\"M9 18h6\"/><path d=\"M10 22h4\"/><path d=\"M15.1 14c.2-1 .6-1.7 1.4-2.5A4.6 4.6 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.8.8 1.2 1.5 1.4 2.5\"/>",
    "calendar-x": "<rect x=\"3\" y=\"4\" width=\"18\" height=\"18\" rx=\"2\"/><path d=\"M16 2v4M8 2v4M3 10h18\"/><path d=\"m10 14 4 4M14 14l-4 4\"/>",
    "heart": "<path d=\"M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1L12 21l7.7-7.6 1.1-1a5.5 5.5 0 0 0 0-7.8z\"/>",
    "clipboard": "<path d=\"M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2\"/><rect x=\"8\" y=\"2\" width=\"8\" height=\"4\" rx=\"1\"/><path d=\"M9 12h6M9 16h4\"/>",
    "alert": "<path d=\"M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z\"/><path d=\"M12 9v4M12 17h.01\"/>",
    "book": "<path d=\"M4 19.5A2.5 2.5 0 0 1 6.5 17H20\"/><path d=\"M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z\"/>",
    "gavel": "<path d=\"m14.5 12.5-8 8a2.12 2.12 0 1 1-3-3l8-8\"/><path d=\"m16 16 6-6\"/><path d=\"m8 8 6-6\"/><path d=\"m9 7 8 8\"/><path d=\"m21 11-8-8\"/><path d=\"M3 22h10\"/>",
    "link": "<path d=\"M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7\"/><path d=\"M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7\"/>",
    "chart": "<path d=\"M3 3v18h18\"/><path d=\"M7 15l4-4 3 3 5-6\"/>",
    "folder": "<path d=\"M3 7a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z\"/>",
    "doc": "<path d=\"M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z\"/><path d=\"M14 2v6h6M8 13h8M8 17h5\"/>",
    "dollar": "<path d=\"M12 2v20\"/><path d=\"M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6\"/>",
    "people": "<path d=\"M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2\"/><circle cx=\"9\" cy=\"7\" r=\"4\"/><path d=\"M23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8\"/>",
    "calendar": "<rect x=\"3\" y=\"4\" width=\"18\" height=\"18\" rx=\"2\"/><path d=\"M16 2v4M8 2v4M3 10h18\"/>",
    "camera": "<path d=\"M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z\"/><circle cx=\"12\" cy=\"13\" r=\"4\"/>",
    "mail": "<rect x=\"2\" y=\"4\" width=\"20\" height=\"16\" rx=\"2\"/><path d=\"m22 6-10 7L2 6\"/>",
    "star": "<path d=\"m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z\"/>",
    "shirt": "<path d=\"M20.4 7.5 16 4a4 4 0 0 1-8 0L3.6 7.5a1 1 0 0 0-.3 1.2l1.5 3a1 1 0 0 0 1.2.5L8 11.5V20a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-8.5l2 .7a1 1 0 0 0 1.2-.5l1.5-3a1 1 0 0 0-.3-1.2z\"/>",
    "home": "<path d=\"M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z\"/>"
};

  var DEFAULT = {
    "tools": {
        "title": "Chapter Tools",
        "order": 1,
        "links": {
            "tracker": {
                "label": "My Tracker",
                "url": "tracker",
                "icon": "chart",
                "order": 1,
                "audience": "all"
            },
            "voting": {
                "label": "Voting",
                "url": "voting",
                "icon": "vote",
                "order": 2,
                "audience": "all"
            },
            "timer": {
                "label": "Event Timer",
                "url": "timer",
                "icon": "timer",
                "order": 3,
                "audience": "all"
            },
            "cmt": {
                "label": "CMT (Chapter Management Tool)",
                "url": "https://cmt.thetatau.org/",
                "icon": "grid",
                "order": 4,
                "audience": "all"
            }
        }
    },
    "forms": {
        "title": "Forms",
        "order": 2,
        "links": {
            "excuse": {
                "label": "Excused Absence Request",
                "url": "excuse",
                "icon": "calendar-x",
                "order": 1,
                "audience": "all"
            },
            "service": {
                "label": "Log Service Hours",
                "url": "log-service",
                "icon": "heart",
                "order": 2,
                "audience": "all"
            },
            "suggest": {
                "label": "Suggestion Box",
                "url": "https://forms.gle/J6VS1uHyRY5dmMLz8",
                "icon": "bulb",
                "order": 3,
                "audience": "all"
            },
            "report": {
                "label": "Standards Report Form",
                "url": "https://docs.google.com/forms/d/e/1FAIpQLSexPJKwoFsV5_OhqBOkf9dtI722QIqPeqpZT8AumJ8HnXwSFw/viewform",
                "icon": "clipboard",
                "order": 4,
                "audience": "all"
            },
            "concern": {
                "label": "Standards Concerns Form",
                "url": "https://docs.google.com/forms/d/e/1FAIpQLSfiuC-GMeZIhcl6zoJcFIua_-vIkgigcsp6clA2oo2znpkWLQ/viewform",
                "icon": "alert",
                "order": 5,
                "audience": "all"
            }
        }
    },
    "resources": {
        "title": "Resources",
        "order": 3,
        "links": {
            "textbooks": {
                "label": "Textbook Bank",
                "url": "https://drive.google.com/drive/folders/1PBIxFjb9p-EDtErJXusBblbV75rcgqRO?usp=sharing",
                "icon": "book",
                "order": 1,
                "audience": "all"
            },
            "bylaws": {
                "label": "Chapter Bylaws",
                "url": "https://drive.google.com/drive/folders/1fj4oobTumOEYza9B6S82-hEgVXkeb-q7?usp=sharing",
                "icon": "gavel",
                "order": 2,
                "audience": "all"
            }
        }
    }
};

  var AUDIENCES = { all: 'Everyone', active: 'Brothers (not PNMs)', pnm: 'PNMs only', officers: 'Officers and chairs with a tool', admin: 'Admins only' };

  function safeUrl(url) {
    var u = String(url == null ? '' : url).trim();
    if (/^https:\/\/[^\s]+$/i.test(u)) return u;
    if (/^[a-z0-9][a-z0-9\-\/]*$/i.test(u)) return u;          // a portal page, e.g. "tracker"
    return '';
  }
  function isExternal(url) { return /^https:/i.test(url); }

  function canSee(link, profile) {
    var a = link.audience || 'all', p = profile || {};
    if (p.role === 'admin') return true;
    if (a === 'all') return true;
    if (a === 'active') return p.status !== 'pnm' && p.role !== 'pnm';
    if (a === 'pnm') return p.status === 'pnm' || p.role === 'pnm';
    if (a === 'officers') return Object.keys(p.perms || {}).some(function (k) { return p.perms[k]; });
    return false;
  }

  function sorted(obj) {
    return Object.keys(obj || {}).map(function (k) { var v = Object.assign({}, obj[k]); v.key = k; return v; })
      .sort(function (a, b) { return (a.order || 0) - (b.order || 0) || String(a.label || a.title || '').localeCompare(String(b.label || b.title || '')); });
  }

  function load() {
    return firebase.database().ref('portalLinks').once('value').then(function (s) {
      var v = s.val() || {};
      return { sections: v.sections || DEFAULT, calendarUrl: v.calendarUrl || '', isDefault: !v.sections };
    }).catch(function () { return { sections: DEFAULT, calendarUrl: '', isDefault: true }; });
  }

  function iconSvg(name) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[name] || ICONS.link) + '</svg>';
  }

  /** Build the home page cards. Text goes in with textContent; only built-in icons use innerHTML. */
  function render(container, sections, profile) {
    container.innerHTML = '';
    sorted(sections).forEach(function (sec) {
      var links = sorted(sec.links).filter(function (l) { return !l.hidden && safeUrl(l.url) && canSee(l, profile); });
      if (!links.length) return;
      var card = document.createElement('div'); card.className = 'portal-card';
      var h = document.createElement('h2'); h.textContent = sec.title || ''; card.appendChild(h);
      var grid = document.createElement('div'); grid.className = 'portal-nav-grid';
      links.forEach(function (l) {
        var a = document.createElement('a');
        a.href = safeUrl(l.url);
        if (isExternal(a.getAttribute('href'))) { a.target = '_blank'; a.rel = 'noopener'; }
        a.innerHTML = iconSvg(l.icon);
        var span = document.createElement('span'); span.textContent = l.label || ''; a.appendChild(span);
        grid.appendChild(a);
      });
      card.appendChild(grid); container.appendChild(card);
    });
  }

  global.PortalLinks = { ICONS: ICONS, DEFAULT: DEFAULT, AUDIENCES: AUDIENCES, safeUrl: safeUrl, isExternal: isExternal, canSee: canSee, sorted: sorted, load: load, render: render, iconSvg: iconSvg };
})(typeof window !== 'undefined' ? window : this);
