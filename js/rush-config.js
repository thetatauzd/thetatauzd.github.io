/**
 * Rush page fallback config. Admins normally run the rush page from the portal:
 * Admin → Website saves to the database, and whatever is saved there wins over this file.
 * This file is used only when nothing is saved there yet, or the database cannot be reached.
 *
 * Keep it roughly current anyway:
 * - When rush CLOSES: set isOpen to false and CURRENT_RUSH to the next semester (e.g. "Fall 2027").
 * - When rush OPENS: set isOpen to true, check CURRENT_RUSH and ctaLine, and set rushLinkUrl to the
 *   NEW GroupMe invite ("" hides the join button).
 * - staticCardsSemester: the semester of the poster and cards checked into rush.html
 *   (Images/rush/f26/). They show only while the open title names this semester, so last
 *   semester's dates never appear under a new title. Change it when you swap those files.
 * - interestFormUrl: a Google Form (name, email, major, year) shown in the closed banner all
 *   year so people can sign up before rush starts. "" hides it.
 */
/** The semester rush belongs to. */
var CURRENT_RUSH = "Spring 2027";

window.RUSH_CONFIG = {
  /** true = show the schedule, signup and GroupMe; false = "Rush has closed" banner */
  isOpen: false,

  /** Shown when closed: "Next rush: " + this */
  nextSemester: CURRENT_RUSH,

  /** When open: main rush heading */
  rushTitle: CURRENT_RUSH + " Rush",

  /** When open: line under the title */
  ctaLine: "Join the Rush GroupMe to keep up with every event.",

  /** When open: the current GroupMe invite. "" hides the button. Replace every semester. */
  rushLinkUrl: "",

  /** All year: interest-list Google Form. "" hides the button. */
  interestFormUrl: "",

  /** The semester of the poster and cards checked into rush.html. */
  staticCardsSemester: "Fall 2026"
};
