/**
 * Chapter numbers used on the public pages. Edit the values here and every
 * page updates. Sources: Theta Tau CMT census, the chapter service log and
 * the STEM Extravaganza count. Update once a semester.
 *
 * Any element with data-stat="key" gets the value as its text. The numbers
 * are also typed into the HTML as a fallback; this file wins.
 */
(function (global) {
  'use strict';

  var CHARTERED = '2011-02-05';

  var STATS = {
    charteredText: 'February 5, 2011',
    brothersAllTime: '480+',          // CMT living census: 487
    activeMembers: '67',
    serviceHoursPerSemester: '900+',  // Spring 2026: 911.5, Spring 2025: 969.5
    serviceHoursLatest: '911.5',
    serviceHoursLatestTerm: 'Spring 2026',
    studentsReached: '1,000+',        // K-12 students at STEM Extravaganza 2026
    studentsReachedEvent: 'STEM Extravaganza 2026',
    averageGpa: '3.8'
  };

  /** Whole years since the charter date (15 on Feb 5, 2026 and after, until Feb 5, 2027). */
  function yearsAtUSC(today) {
    var now = today || new Date();
    var parts = CHARTERED.split('-');
    var charter = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    var years = now.getFullYear() - charter.getFullYear();
    var beforeAnniversary = now.getMonth() < charter.getMonth() ||
      (now.getMonth() === charter.getMonth() && now.getDate() < charter.getDate());
    if (beforeAnniversary) years -= 1;
    return years;
  }

  STATS.yearsAtUSC = String(yearsAtUSC());
  STATS.chartered = CHARTERED;

  function fill() {
    var els = document.querySelectorAll('[data-stat]');
    for (var i = 0; i < els.length; i++) {
      var key = els[i].getAttribute('data-stat');
      if (STATS[key] != null) els[i].textContent = STATS[key];
    }
  }

  global.SITE_STATS = STATS;
  global.SITE_STATS.yearsSince = yearsAtUSC;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fill);
  else fill();
})(window);
