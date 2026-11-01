/**
 * Theta Tau national chapter awards won by Zeta Delta, newest first.
 * Source: Theta Tau CMT chapter awards history. Add a line when the chapter
 * wins something; the home page renders this list.
 */
(function (global) {
  'use strict';

  var AWARDS = [
    { year: '2026', award: 'Outstanding DEI Program' },
    { year: '2026', award: 'Outstanding Philanthropy Event' },
    { year: '2025', award: 'Outstanding DEI Program' },
    { year: '2025', award: 'Outstanding Professional Development Program' },
    { year: '2025', award: 'Outstanding Philanthropy Program' },
    { year: '2025', award: 'Outstanding Chapter Officer (Rachel Wayne)' },
    { year: '2024', award: 'Outstanding Video' },
    { year: '2023', award: '700 Club (biennium points)' },
    { year: '2022', award: 'Outstanding Philanthropy Event' },
    { year: '2014-16', award: 'Schrader Award' }
  ];

  function escapeHtml(str) {
    var d = document.createElement('div');
    d.textContent = str == null ? '' : String(str);
    return d.innerHTML;
  }

  /** Group by year, keeping the order above. */
  function render() {
    var el = document.getElementById('awards-list');
    if (!el) return;
    var groups = [];
    for (var i = 0; i < AWARDS.length; i++) {
      var a = AWARDS[i];
      var g = groups.length && groups[groups.length - 1].year === a.year ? groups[groups.length - 1] : null;
      if (!g) { g = { year: a.year, awards: [] }; groups.push(g); }
      g.awards.push(a.award);
    }
    el.innerHTML = groups.map(function (g) {
      return '<div class="award-row">' +
        '<div class="award-year">' + escapeHtml(g.year) + '</div>' +
        '<ul class="award-names">' + g.awards.map(function (n) { return '<li>' + escapeHtml(n) + '</li>'; }).join('') + '</ul>' +
        '</div>';
    }).join('');
  }

  global.CHAPTER_AWARDS = AWARDS;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render);
  else render();
})(window);
