/**
 * Rush page config — single place to open/close rush and set semester text.
 *
 * HOW TO UPDATE:
 * - When rush CLOSES: set isOpen to false, set nextSemester (e.g. "Spring 2026").
 * - When rush OPENS (start of semester, usually within first month of classes):
 *   set isOpen to true, set rushTitle (e.g. "Spring 2026 Rush"), set ctaLine and rushLinkUrl if you use them.
 */
window.RUSH_CONFIG = {
  /** true = show full rush + signup; false = show "Rush closed, check back next semester" at top */
  isOpen: false,

  /** Shown when closed: "Check back at the start of next semester" + this (e.g. "Spring 2026") */
  nextSemester: "Fall 2026",

  /** When open: main rush heading (e.g. "Fall 2025 Rush", "Spring 2026 Rush") */
  rushTitle: "Fall 2025 Rush",

  /** When open: line under the title (e.g. "Join The Rush GroupMe! | Schedule a Coffee Chat!") */
  ctaLine: "Join The Rush GroupMe! | Schedule a Coffee Chat!",

  /** When open: optional URL for the LinkTree/signup image (leave "" if image has no link) */
  rushLinkUrl: ""
};
