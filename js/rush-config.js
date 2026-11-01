/**
 * Rush page config — the single place to open/close rush and set semester text.
 *
 * HOW TO UPDATE:
 * - When rush CLOSES: set isOpen to false. Set CURRENT_RUSH to the next semester (e.g. "Fall 2027").
 *   The schedule graphics and the GroupMe section hide themselves.
 * - When rush OPENS (start of semester, usually within the first month of classes):
 *   set isOpen to true, check CURRENT_RUSH, set ctaLine, and
 *   rushLinkUrl to the NEW GroupMe invite (leave "" to hide the join button).
 *   Then swap the poster and event cards in rush.html (Images/rush/f26/ → the new folder).
 * - interestFormUrl: a Google Form (name, email, major, year) shown in the closed
 *   banner all year so people can sign up before rush starts. Leave "" to hide it.
 */
/** The one value to change each semester: the semester rush belongs to. */
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
  interestFormUrl: ""
};
