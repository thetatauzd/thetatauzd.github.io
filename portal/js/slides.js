/**
 * Candidate slide-deck parser (rush slides, PNM check-in slides, anything
 * following the same one-person-per-slide shape).
 *
 * Reads a .pptx exported from Google Slides (File > Download > Microsoft PowerPoint)
 * entirely in the browser and turns each slide into a candidate record:
 *
 *   { number, name, photo, gpa, major, classStanding, heardVia, events[], warnings[] }
 *
 * Photos are downscaled to small JPEG data URLs before they ever reach the database —
 * the source decks are ~1.4MB per photo, which would blow past the free Firebase tier.
 * Email and phone number are deliberately NOT extracted; they aren't needed to vote.
 *
 * Depends on JSZip (loaded via CDN in the page).
 */
(function (global) {
  'use strict';

  var NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

  // Field labels as they appear on the slides. Order matters: used to bound each value.
  var INFO_LABELS = [
    { key: 'gpa', match: /GPA[^:]*:/i },
    { key: 'major', match: /Major\s*:/i },
    { key: 'classStanding', match: /Class Standing[^:]*:/i },
    { key: 'heardVia', match: /How did you hear about Rush\?\s*:/i }
  ];

  // Labels we parse but never store (personal contact info).
  var SKIP_LABELS = [/Email\s*:/i, /Phone Number\s*:/i];

  // Any "Something:" line is treated as a label, so a value that spills onto the
  // next line stops at the next label whatever it happens to be called.
  var LABEL_LINE = /^[^:]{2,60}:/;

  // Attendance markers. Events are read off the slide by name rather than from a
  // fixed list, so renamed or newly added rush events carry through on their own.
  var ATTENDANCE_VALUE = /^(y|yes|n|no|na|n\/a|tbd|✓|✔|✗|x|-|–|—)?$/i;
  var ATTENDED_VALUE = /^(y|yes|✓|✔)/i;

  // Boilerplate that shows up in the info box and should never be read as a value.
  var NOISE = /^\s*\*.*\*\s*$|^\s*BASIC INFORMATION\s*$|^\s*EVENTS ATTENDED\s*$/i;

  function parseXml(text) {
    return new DOMParser().parseFromString(text, 'application/xml');
  }

  /** Text of a shape, one entry per <a:p> paragraph. */
  function paragraphsOf(shapeEl) {
    var out = [];
    var paras = shapeEl.getElementsByTagName('a:p');
    for (var i = 0; i < paras.length; i++) {
      var runs = paras[i].getElementsByTagName('a:t');
      var s = '';
      for (var j = 0; j < runs.length; j++) s += runs[j].textContent;
      s = s.replace(/\s+/g, ' ').trim();
      if (s) out.push(s);
    }
    return out;
  }

  function placeholderType(shapeEl) {
    var ph = shapeEl.getElementsByTagName('p:ph')[0];
    return ph ? (ph.getAttribute('type') || '') : '';
  }

  /**
   * Pull "Label: value" pairs out of a block of paragraphs. A value can spill onto
   * following paragraphs (Google Slides breaks lines mid-value), so each value runs
   * until the next recognised label.
   */
  function extractFields(paragraphs) {
    function startsWithAnyLabel(text) {
      return LABEL_LINE.test(text);
    }

    var result = {};
    var lines = paragraphs.filter(function (p) { return !NOISE.test(p); });

    lines.forEach(function (line, i) {
      INFO_LABELS.forEach(function (label) {
        var m = line.match(label.match);
        if (!m || m.index !== 0) return;
        var value = line.slice(m[0].length).trim();
        // Value continues on following lines until the next label.
        for (var k = i + 1; k < lines.length && !value; k++) {
          if (startsWithAnyLabel(lines[k])) break;
          value = lines[k].trim();
        }
        if (value) result[label.key] = value;
      });
    });

    return result;
  }

  /**
   * Read the "events attended" block by name rather than against a fixed list,
   * so renaming an event or adding a new one on next semester's deck just works.
   *
   * A line counts as an event when it reads "Label: <attendance marker>", where
   * the marker is blank or something like Y/N. That value check is what keeps
   * real fields out — "Major: Computer Science" has too rich a value to qualify,
   * and the known info labels are excluded outright.
   */
  function extractEvents(paragraphs) {
    var events = [];
    var seen = {};

    paragraphs.forEach(function (line) {
      if (NOISE.test(line)) return;

      var m = line.match(/^([^:]{2,60}):\s*(.*)$/);
      if (!m) return;

      var label = m[1].replace(/\s+/g, ' ').trim();
      var value = (m[2] || '').trim();
      if (!label) return;
      if (isReservedLabel(label)) return;
      if (!ATTENDANCE_VALUE.test(value)) return;

      var key = label.toLowerCase();
      if (seen[key]) return;
      seen[key] = true;

      events.push({ label: label, attended: ATTENDED_VALUE.test(value) });
    });

    return events;
  }

  /** Info/contact fields that live in the same text blocks but are not events. */
  function isReservedLabel(label) {
    return INFO_LABELS.concat(SKIP_LABELS.map(function (re) { return { match: re }; }))
      .some(function (l) {
        var m = label.match(l.match);
        return m && m.index === 0;
      });
  }

  /**
   * Downscale an image blob to a small JPEG data URL.
   * maxDim caps the longest edge; quality is JPEG quality 0-1.
   */
  function shrinkImage(blob, maxDim, quality) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () {
        var w = img.naturalWidth, h = img.naturalHeight;
        var scale = Math.min(1, maxDim / Math.max(w, h));
        var cw = Math.max(1, Math.round(w * scale));
        var ch = Math.max(1, Math.round(h * scale));
        var canvas = document.createElement('canvas');
        canvas.width = cw;
        canvas.height = ch;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, cw, ch);
        URL.revokeObjectURL(url);
        try {
          resolve(canvas.toDataURL('image/jpeg', quality));
        } catch (e) {
          reject(e);
        }
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('Could not decode slide image'));
      };
      img.src = url;
    });
  }

  /**
   * Normalize a name off a slide. Chapters often type real names in brackets
   * ("[Douglas Reid]"), so brackets are stripped rather than treated as a
   * placeholder — only the untouched template text is discarded.
   */
  function cleanName(raw) {
    var n = (raw || '').replace(/^\s*\[|\]\s*$/g, '').replace(/\s+/g, ' ').trim();
    if (!n) return '';
    if (/^first\s+last$/i.test(n) || /^name$/i.test(n)) return '';
    return n;
  }

  /**
   * Slides record class standing every which way ("S", "Fr", "Jr.", "freshman",
   * "2"). Normalize to a full word. A bare "S" is read as Sophomore, not Senior —
   * seniors are not eligible to rush, so Senior is only used when spelled out.
   */
  function normalizeClass(raw) {
    var v = (raw || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!v) return '';
    if (v.indexOf('sr') === 0 || v.indexOf('sen') === 0) return 'Senior';
    if (v.indexOf('fr') === 0 || v === 'f' || v === '1' || v.indexOf('firstyear') === 0) return 'Freshman';
    if (v.indexOf('so') === 0 || v === 's' || v === '2') return 'Sophomore';
    if (v.indexOf('j') === 0 || v === '3') return 'Junior';
    return (raw || '').trim();
  }

  /** Heuristic: a loose text box holding just a person's name. */
  function looksLikeName(paras) {
    if (!paras || paras.length !== 1) return false;
    var t = paras[0].replace(/^\s*\[|\]\s*$/g, '').trim();
    if (!t || t.indexOf(':') !== -1) return false;
    if (NOISE.test(t)) return false;
    if (/^\d+$/.test(t)) return false;
    var words = t.split(/\s+/);
    return words.length >= 1 && words.length <= 4 && t.length <= 40;
  }

  function relTargetPath(target) {
    // Targets look like "../media/image15.png" relative to ppt/slides/
    return 'ppt/' + target.replace(/^\.\.\//, '');
  }

  /**
   * Parse a .pptx File/Blob into candidate records.
   *
   * opts.maxDim   longest photo edge in px (default 320)
   * opts.quality  JPEG quality (default 0.72)
   * opts.onProgress(done, total)
   */
  function parseDeck(file, opts) {
    opts = opts || {};
    var maxDim = opts.maxDim || 320;
    var quality = opts.quality || 0.72;
    var onProgress = opts.onProgress || function () {};

    if (typeof JSZip === 'undefined') {
      return Promise.reject(new Error('JSZip failed to load — check your connection and reload.'));
    }

    return JSZip.loadAsync(file).then(function (zip) {
      function readText(path) {
        var f = zip.file(path);
        return f ? f.async('string') : Promise.resolve(null);
      }

      // Slide order comes from presentation.xml -> its rels, not filename order.
      return Promise.all([
        readText('ppt/presentation.xml'),
        readText('ppt/_rels/presentation.xml.rels')
      ]).then(function (res) {
        var presXml = res[0], presRels = res[1];
        if (!presXml || !presRels) {
          throw new Error('That file does not look like a PowerPoint deck.');
        }
        var relMap = {};
        var relDoc = parseXml(presRels);
        var rels = relDoc.getElementsByTagName('Relationship');
        for (var i = 0; i < rels.length; i++) {
          relMap[rels[i].getAttribute('Id')] = rels[i].getAttribute('Target');
        }
        var presDoc = parseXml(presXml);
        var ids = presDoc.getElementsByTagName('p:sldId');
        var slidePaths = [];
        for (var k = 0; k < ids.length; k++) {
          var rid = ids[k].getAttributeNS(NS_R, 'id') || ids[k].getAttribute('r:id');
          var target = relMap[rid];
          if (!target) continue;
          slidePaths.push('ppt/' + target.replace(/^\.\.\//, '').replace(/^\//, ''));
        }
        return slidePaths;
      }).then(function (slidePaths) {
        var total = slidePaths.length;
        var chain = Promise.resolve();
        var candidates = [];

        slidePaths.forEach(function (path, idx) {
          chain = chain.then(function () {
            return parseSlide(zip, path, idx + 1, maxDim, quality).then(function (cand) {
              if (cand) candidates.push(cand);
              onProgress(idx + 1, total);
            });
          });
        });

        return chain.then(function () { return candidates; });
      });
    });
  }

  function parseSlide(zip, path, number, maxDim, quality) {
    var file = zip.file(path);
    if (!file) return Promise.resolve(null);

    return file.async('string').then(function (xml) {
      var doc = parseXml(xml);
      var warnings = [];

      var name = '';
      var infoParagraphs = [];
      var otherParagraphs = [];
      var looseShapes = [];

      var shapes = doc.getElementsByTagName('p:sp');
      for (var i = 0; i < shapes.length; i++) {
        var sp = shapes[i];
        var type = placeholderType(sp);
        var paras = paragraphsOf(sp);
        if (type === 'subTitle') {
          name = paras.join(' ').trim();
        } else if (type === 'sldNum') {
          // slide-number placeholder renders as a field; position is authoritative
          continue;
        } else if (type === 'ctrTitle' || type === 'title') {
          infoParagraphs = infoParagraphs.concat(paras);
        } else {
          otherParagraphs = otherParagraphs.concat(paras);
          looseShapes.push(paras);
        }
      }

      var allParagraphs = infoParagraphs.concat(otherParagraphs);
      var fields = extractFields(allParagraphs);
      var events = extractEvents(allParagraphs);

      name = cleanName(name);

      // Some slides skip the subtitle placeholder and put the name in a plain text box.
      if (!name) {
        for (var s = 0; s < looseShapes.length && !name; s++) {
          name = cleanName(looksLikeName(looseShapes[s]) ? looseShapes[s].join(' ') : '');
        }
      }

      if (!name) warnings.push('No name found on this slide');

      // Find the first embedded picture on the slide.
      var pics = doc.getElementsByTagName('p:pic');
      var embedId = null;
      for (var p = 0; p < pics.length && !embedId; p++) {
        var blips = pics[p].getElementsByTagName('a:blip');
        for (var b = 0; b < blips.length && !embedId; b++) {
          embedId = blips[b].getAttributeNS(NS_R, 'embed') || blips[b].getAttribute('r:embed');
        }
      }

      var relsPath = path.replace(/\/slides\/([^/]+)$/, '/slides/_rels/$1.rels');

      var photoPromise = Promise.resolve('');
      if (embedId) {
        var relsFile = zip.file(relsPath);
        if (relsFile) {
          photoPromise = relsFile.async('string').then(function (relsXml) {
            var relDoc = parseXml(relsXml);
            var rels = relDoc.getElementsByTagName('Relationship');
            var target = null;
            for (var r = 0; r < rels.length; r++) {
              if (rels[r].getAttribute('Id') === embedId) {
                target = rels[r].getAttribute('Target');
                break;
              }
            }
            if (!target) return '';
            var mediaFile = zip.file(relTargetPath(target));
            if (!mediaFile) return '';
            return mediaFile.async('blob').then(function (blob) {
              return shrinkImage(blob, maxDim, quality).catch(function () { return ''; });
            });
          });
        }
      }

      return photoPromise.then(function (photo) {
        if (!photo) warnings.push('No photo found on this slide');

        // A slide with neither a name nor a photo is a divider/section slide, not a person.
        if (!name && !photo) return null;

        return {
          number: number,
          name: name,
          photo: photo,
          gpa: fields.gpa || '',
          major: fields.major || '',
          classStanding: normalizeClass(fields.classStanding),
          heardVia: fields.heardVia || '',
          events: events,
          warnings: warnings
        };
      });
    });
  }

  /** Rough byte size of the roster once serialized, for free-tier budgeting. */
  function estimateSize(candidates) {
    try {
      return new Blob([JSON.stringify(candidates)]).size;
    } catch (e) {
      return JSON.stringify(candidates).length;
    }
  }

  global.PortalSlides = {
    parseDeck: parseDeck,
    estimateSize: estimateSize,
    shrinkImage: shrinkImage
  };
})(typeof window !== 'undefined' ? window : this);
