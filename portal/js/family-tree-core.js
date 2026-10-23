/**
 * FamilyTreeCore — pure helpers for the big/little family tree (no DOM, no
 * Firebase). The page stores facts (who is whose big) and this file turns them
 * into a drawing: families, rows per pledge class, a tidy layout, search and
 * the checks that keep the tree a tree. Tested in portal/ops-tests.html.
 *
 *   member = { id, name, roll, major, pledgeClass, bigId, big2Id, familyName,
 *              color, mark, linkedin, note, hasPhoto }
 */
(function (global) {
  'use strict';

  var GREEK = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta', 'Iota', 'Kappa', 'Lambda', 'Mu',
    'Nu', 'Xi', 'Omicron', 'Pi', 'Rho', 'Sigma', 'Tau', 'Upsilon', 'Phi', 'Chi', 'Psi', 'Omega'];

  /** Pledge classes in order: Alpha … Omega, then Beta Gamma … Beta Omega (the Brother List's names), then Gamma Gamma … */
  function classList(count) {
    var out = [], series = 0;
    while (out.length < count) {
      for (var i = 0; i < GREEK.length && out.length < count; i++) {
        if (series > 0 && i < 2) continue;              // the second series starts at Beta Gamma
        out.push(series === 0 ? GREEK[i] : GREEK[series] + ' ' + GREEK[i]);
      }
      series++;
    }
    return out;
  }
  var DEFAULT_CLASSES = classList(46);                  // Alpha … Beta Omega

  /**
   * Theta Tau's official signs of office (the letters after roll numbers in the
   * Brother List): a current holder signs X!, a past holder XX!, national (grand)
   * officers XXX! / XXXX!. member.offices = { regent: 'past', marshal: 'current' }.
   */
  var OFFICE_LEVELS = { current: [1, ''], past: [2, 'Past '], grand: [3, 'Grand '], pastGrand: [4, 'Past Grand '] };
  var OFFICES = [
    { key: 'regent', label: 'Regent', sign: 'X' },
    { key: 'vice_regent', label: 'Vice Regent', sign: 'Y' },
    { key: 'scribe', label: 'Scribe', sign: 'V' },
    { key: 'treasurer', label: 'Treasurer', sign: 'Z' },
    { key: 'corresponding_secretary', label: 'Corresponding Secretary', sign: 'R' },
    { key: 'marshal', label: 'Marshal', sign: 'W' },
    { key: 'inner_guard', label: 'Inner Guard', sign: 'T' },
    { key: 'outer_guard', label: 'Outer Guard', sign: 'U' }
  ];
  /** [{ sign: 'XX!', label: 'Past Regent' }, …] in official order. */
  function signs(offices) {
    var out = [];
    OFFICES.forEach(function (o) {
      var v = (offices || {})[o.key]; if (v === true) v = 'past';
      var lv = OFFICE_LEVELS[v]; if (!lv) return;
      var s = ''; for (var i = 0; i < lv[0]; i++) s += o.sign;
      out.push({ key: o.key, sign: s + '!', label: lv[1] + o.label });
    });
    return out;
  }
  /** 'UUXX' (as typed after a roll number) → { outer_guard: 'past', regent: 'past' }. */
  function parseSigns(text) {
    var out = {}, runs = String(text || '').toUpperCase().replace(/[^A-Z]/g, '').match(/(.)\1*/g) || [];
    runs.forEach(function (run) {
      var o = OFFICES.filter(function (x) { return x.sign === run.charAt(0); })[0];
      if (!o) return;
      var level = Object.keys(OFFICE_LEVELS).filter(function (k) { return OFFICE_LEVELS[k][0] === Math.min(run.length, 4); })[0];
      out[o.key] = level;
    });
    return out;
  }
  function signText(offices) { return signs(offices).map(function (s) { return s.sign; }).join(' '); }

  /** Standing in the chapter. Anyone not a brother any more stays in the tree (their littles keep their big) but is drawn in black. */
  var STATUSES = { '': 'Brother', resigned: 'Resigned', removed: 'Removed by Nationals' };

  /** The class after the last one in `classes` (so a new class is one tap). */
  function nextClass(classes) {
    var list = classes || DEFAULT_CLASSES;
    var all = classList(list.length + 24);
    var last = list[list.length - 1];
    var i = all.indexOf(last);
    return i === -1 ? all[list.length] : all[i + 1];
  }

  function classIndex(name, classes) {
    var i = (classes || DEFAULT_CLASSES).indexOf(name || '');
    return i === -1 ? (classes || DEFAULT_CLASSES).length : i;   // unknown classes sort last
  }

  // ── Structure ──

  /** Index members: byId, children per big, roots (no big, or big missing). */
  function index(members, classes) {
    var byId = {}, children = {}, list = [];
    Object.keys(members || {}).forEach(function (id) {
      var m = members[id]; if (!m) return;
      var c = Object.assign({ id: id }, m);
      byId[id] = c; list.push(c);
    });
    list.forEach(function (m) {
      var big = m.bigId && byId[m.bigId] ? m.bigId : '';
      m.bigId = big;
      if (m.big2Id && !byId[m.big2Id]) m.big2Id = '';
      if (big) (children[big] = children[big] || []).push(m.id);
    });
    var cmp = memberSorter(byId, classes);
    Object.keys(children).forEach(function (k) { children[k].sort(cmp); });
    var roots = list.filter(function (m) { return !m.bigId; }).map(function (m) { return m.id; }).sort(cmp);
    return { byId: byId, children: children, roots: roots, list: list };
  }

  function memberSorter(byId, classes) {
    return function (a, b) {
      var A = byId[a], B = byId[b];
      var d = classIndex(A.pledgeClass, classes) - classIndex(B.pledgeClass, classes);
      if (d) return d;
      d = (num(A.roll) || 1e9) - (num(B.roll) || 1e9);
      if (d) return d;
      return (A.name || '').localeCompare(B.name || '');
    };
  }
  function num(v) { var n = parseInt(v, 10); return isNaN(n) ? 0 : n; }

  /** Every member below `id` (littles, grand-littles …), not including id. */
  function descendants(idx, id) {
    var out = [], stack = (idx.children[id] || []).slice();
    while (stack.length) {
      var cur = stack.pop(); out.push(cur);
      stack = stack.concat(idx.children[cur] || []);
    }
    return out;
  }

  /** The root of the family `id` belongs to. */
  function rootOf(idx, id) {
    var cur = id, guard = 0;
    while (idx.byId[cur] && idx.byId[cur].bigId && guard++ < 1000) cur = idx.byId[cur].bigId;
    return cur;
  }

  /** True if making `bigId` the big of `id` would create a loop (someone their own ancestor). */
  function wouldCycle(idx, id, bigId) {
    if (!bigId || bigId === id) return bigId === id;
    var cur = bigId, guard = 0;
    while (cur && guard++ < 1000) {
      if (cur === id) return true;
      cur = idx.byId[cur] ? idx.byId[cur].bigId : '';
    }
    return false;
  }

  /** Families: one per root, with a name (the root's familyName or "<root> family") and a colour. */
  function families(idx) {
    return idx.roots.map(function (rid) {
      var r = idx.byId[rid];
      var ids = [rid].concat(descendants(idx, rid));
      return { rootId: rid, name: r.familyName || ((r.name || 'Unnamed') + ' family'), color: r.color || 'gold', ids: ids, size: ids.length };
    });
  }

  /** What a person's card shows: big, co-big, grand-big, littles, grand-littles, family. */
  function relations(idx, id) {
    var m = idx.byId[id]; if (!m) return null;
    var big = m.bigId ? idx.byId[m.bigId] : null;
    var littles = (idx.children[id] || []).map(function (k) { return idx.byId[k]; });
    var grand = [];
    littles.forEach(function (l) { (idx.children[l.id] || []).forEach(function (g) { grand.push(idx.byId[g]); }); });
    return {
      big: big, big2: m.big2Id ? idx.byId[m.big2Id] : null, grandBig: big && big.bigId ? idx.byId[big.bigId] : null,
      littles: littles, grandLittles: grand, rootId: rootOf(idx, id),
      twins: big ? (idx.children[big.id] || []).filter(function (k) { return k !== id; }).map(function (k) { return idx.byId[k]; }) : []
    };
  }

  // ── Layout ──
  // Rows are pledge classes (fixed y). Each family is a tidy tree packed left to
  // right with a per-row contour, so a big in Alpha whose little joined in Omega
  // stays in one column and nothing overlaps. Units: 1 = one node width.

  function layout(idx, classes, opts) {
    opts = opts || {};
    var gap = opts.gap || 0.25, familyGap = opts.familyGap || 0.9;
    var pos = {}, fams = families(idx), bounds = [];
    var cursor = 0, totalCont = {};
    fams.forEach(function (f) {
      var r = place(f.rootId);
      var shift = cursor;
      Object.keys(r.cont).forEach(function (row) {
        if (totalCont[row]) shift = Math.max(shift, totalCont[row][1] + familyGap - r.cont[row][0]);
      });
      var minX = Infinity, maxX = -Infinity;
      Object.keys(r.pos).forEach(function (id) {
        pos[id] = { x: r.pos[id] + shift, row: rowOf(id) };
        minX = Math.min(minX, pos[id].x); maxX = Math.max(maxX, pos[id].x);
      });
      Object.keys(r.cont).forEach(function (row) {
        var a = r.cont[row][0] + shift, b = r.cont[row][1] + shift;
        totalCont[row] = totalCont[row] ? [Math.min(totalCont[row][0], a), Math.max(totalCont[row][1], b)] : [a, b];
      });
      bounds.push({ rootId: f.rootId, name: f.name, color: f.color, minX: minX, maxX: maxX, size: f.size });
      cursor = maxX + 1;
    });
    var width = 0, maxRow = 0;
    Object.keys(pos).forEach(function (id) { width = Math.max(width, pos[id].x + 0.5); maxRow = Math.max(maxRow, pos[id].row); });
    return { pos: pos, families: bounds, width: width, rows: maxRow + 1 };

    function rowOf(id) { return classIndex(idx.byId[id].pledgeClass, classes); }

    function place(id) {
      var kids = idx.children[id] || [];
      var row = rowOf(id);
      if (!kids.length) {
        var c = {}; c[row] = [-0.5, 0.5];
        var p = {}; p[id] = 0;
        return { pos: p, cont: c };
      }
      var merged = {}, P = {}, first = null, last = null;
      kids.forEach(function (k) {
        var sub = place(k);
        var shift = 0;
        Object.keys(sub.cont).forEach(function (r2) {
          if (merged[r2]) shift = Math.max(shift, merged[r2][1] + gap - sub.cont[r2][0]);
        });
        Object.keys(sub.pos).forEach(function (sid) { P[sid] = sub.pos[sid] + shift; });
        Object.keys(sub.cont).forEach(function (r2) {
          var a = sub.cont[r2][0] + shift, b = sub.cont[r2][1] + shift;
          merged[r2] = merged[r2] ? [Math.min(merged[r2][0], a), Math.max(merged[r2][1], b)] : [a, b];
        });
        if (first === null) first = P[k];
        last = P[k];
      });
      var x = (first + last) / 2;
      // A little in the same class as their big sits beside, not under, them.
      if (merged[row]) x = Math.max(x, merged[row][1] + gap + 0.5);
      P[id] = x;
      merged[row] = merged[row] ? [Math.min(merged[row][0], x - 0.5), Math.max(merged[row][1], x + 0.5)] : [x - 0.5, x + 0.5];
      return { pos: P, cont: merged };
    }
  }

  // ── Search & validation ──

  function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

  /** Members matching a query by name, roll number, major or class (best first). */
  function search(idx, q, limit) {
    var n = norm(q); if (!n) return [];
    var hits = idx.list.map(function (m) {
      var name = norm(m.name), full = norm((m.fullName || '') + ' ' + (m.nickname || '')), score = 0;
      if (name === n) score = 100;
      else if (name.indexOf(n) === 0) score = 80;
      else if (name.indexOf(n) !== -1) score = 60;
      else if (String(m.roll || '') === n) score = 90;
      else if (full.indexOf(n) !== -1) score = 55;
      else if (norm(m.major).indexOf(n) === 0) score = 30;
      else if (norm(m.pledgeClass) === n) score = 20;
      else if (n.split(' ').every(function (w) { return name.indexOf(w) !== -1 || full.indexOf(w) !== -1; })) score = 50;
      return { m: m, score: score };
    }).filter(function (h) { return h.score > 0; });
    hits.sort(function (a, b) { return b.score - a.score || (a.m.name || '').localeCompare(b.m.name || ''); });
    return hits.slice(0, limit || 12).map(function (h) { return h.m; });
  }

  /** Problems with a member record before it is saved. Returns [] when fine. */
  function validate(idx, id, m) {
    var errs = [];
    if (!m.name || !String(m.name).trim()) errs.push('A name is needed.');
    if (String(m.name || '').length > 80) errs.push('That name is too long.');
    if (m.roll !== '' && m.roll != null && (!/^\d{1,5}$/.test(String(m.roll)))) errs.push('Roll number must be a whole number.');
    if (m.bigId && !idx.byId[m.bigId]) errs.push('That big is not in the tree.');
    if (m.bigId && wouldCycle(idx, id, m.bigId)) errs.push('That would make someone their own big (a loop).');
    if (m.big2Id && m.big2Id === m.bigId) errs.push('Big and co-big are the same person.');
    if (m.big2Id && m.big2Id === id) errs.push('Someone cannot be their own co-big.');
    if (m.linkedin && !/^https:\/\/(www\.)?linkedin\.com\//.test(m.linkedin)) errs.push('LinkedIn link must start with https://www.linkedin.com/.');
    return errs;
  }

  /** Database keys and photo size limits, shared with the rules file. */
  var LIMITS = { nameChars: 80, photoChars: 90000, photoSide: 192 };

  /** Cleaned record to store: trims strings, numbers roll, drops empty fields. */
  function cleanRecord(m) {
    var out = {
      name: String(m.name || '').trim(), pledgeClass: String(m.pledgeClass || '').trim(),
      major: String(m.major || '').trim(), bigId: m.bigId || '', big2Id: m.big2Id || '',
      linkedin: String(m.linkedin || '').trim(), note: String(m.note || '').trim(),
      familyName: String(m.familyName || '').trim(), color: m.color || ''
    };
    var r = parseInt(m.roll, 10); if (!isNaN(r)) out.roll = r;
    if (m.hasPhoto) out.hasPhoto = true;
    ['fullName', 'nickname', 'grad', 'minor', 'roles'].forEach(function (k) { out[k] = String(m[k] || '').trim(); });
    if (STATUSES[m.status] && m.status) out.status = m.status;
    var offices = {};
    OFFICES.forEach(function (o) { var v = (m.offices || {})[o.key]; if (OFFICE_LEVELS[v]) offices[o.key] = v; });
    if (Object.keys(offices).length) out.offices = offices;
    Object.keys(out).forEach(function (k) { if (out[k] === '' || out[k] === false) delete out[k]; });
    return out;
  }

  /** Counts for the summary line: members, families, classes, photos. */
  function stats(idx, classes) {
    var fams = families(idx), photos = 0, cls = {};
    idx.list.forEach(function (m) { if (m.hasPhoto) photos++; if (m.pledgeClass) cls[m.pledgeClass] = true; });
    return { members: idx.list.length, families: fams.length, classes: Object.keys(cls).length, photos: photos,
      largest: fams.reduce(function (a, f) { return !a || f.size > a.size ? f : a; }, null) };
  }

  global.FamilyTreeCore = {
    GREEK: GREEK, DEFAULT_CLASSES: DEFAULT_CLASSES, LIMITS: LIMITS, OFFICES: OFFICES, OFFICE_LEVELS: OFFICE_LEVELS, STATUSES: STATUSES,
    classList: classList, nextClass: nextClass, classIndex: classIndex, signs: signs, signText: signText, parseSigns: parseSigns,
    index: index, descendants: descendants, rootOf: rootOf, wouldCycle: wouldCycle, families: families, relations: relations,
    layout: layout, search: search, validate: validate, cleanRecord: cleanRecord, stats: stats
  };
})(typeof window !== 'undefined' ? window : this);
