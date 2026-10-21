import type { LevelBand } from "./types.ts";

/**
 * Age checks that don't rely on what a child says. When a learner signs in to Google to connect
 * school, Google tells us the account's age range (under 18 / 18-20 / 21+) and, if set, a birthday;
 * their Classroom course names often say the grade ("Grade 7 Science"). A spoken "I'm 18" can't
 * outrank those.
 */

export interface AgeSignals {
  /** Google People API ageRanges. */
  range?: "under18" | "18to20" | "21plus";
  /** Google People API birthday (yyyy-mm-dd), when the account has one with a year. */
  birthday?: string;
  /** Lowest school grade found in their class names (US grade numbering). */
  grade?: number;
}

export interface AgeVerdict {
  /** Under 18 by Google or school grade; null = unknown. */
  minor: boolean | null;
  /** Under 13; null = can't tell (treated as "needs a parent" when they're a minor). */
  under13: boolean | null;
  /** Exact age, from a birthday. */
  age?: number;
  /** What it was based on, said plainly. */
  basis: string;
}

/** "Grade 7 Science", "7th grade", "Class 6", "Std 8", "Year 8" (UK, one ahead of US grades). */
export function gradeFromCourses(courses: Array<{ name: string; section?: string }>): number | undefined {
  const grades: number[] = [];
  for (const c of courses) {
    const t = `${c.name} ${c.section ?? ""}`;
    for (const m of t.matchAll(/\b(?:grade|class|std\.?|standard)\s*(\d{1,2})\b/gi)) grades.push(Number(m[1]));
    for (const m of t.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)\s*(?:grade|std|standard)\b/gi)) grades.push(Number(m[1]));
    for (const m of t.matchAll(/\byear\s*(\d{1,2})\b/gi)) grades.push(Number(m[1]) - 1);
  }
  const ok = grades.filter((g) => g >= 0 && g <= 12);
  return ok.length ? Math.min(...ok) : undefined;
}

export function ageOn(birthday: string, today: string): number {
  const [by, bm, bd] = birthday.split("-").map(Number);
  const [ty, tm, td] = today.split("-").map(Number);
  return ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0);
}

/**
 * Weigh Google's signals against what the learner claimed. Exact birthday wins; then Google's age
 * range; then the grade in their classes. A claim only counts when it agrees with Google.
 */
export function judgeAge(signals: AgeSignals, claimed: { age?: number; band: LevelBand }, today: string): AgeVerdict {
  if (signals.birthday && /^\d{4}-\d{2}-\d{2}$/.test(signals.birthday)) {
    const age = ageOn(signals.birthday, today);
    return { minor: age < 18, under13: age < 13, age, basis: "the birthday on the Google account" };
  }
  // Grade 7 and below is mostly 12 and under: on the safe side.
  const gradeUnder13 = signals.grade === undefined ? null : signals.grade <= 7;
  if (signals.range === "18to20" || signals.range === "21plus") return { minor: false, under13: false, basis: "Google says this is an adult account" };
  if (signals.range === "under18") {
    if (gradeUnder13 !== null) return { minor: true, under13: gradeUnder13, basis: `Google says under 18, and the classes are grade ${signals.grade}` };
    // Under 18, but under 13? Only their own claim is left, and it counts only if it fits "under 18".
    const claimedTeen = claimed.age !== undefined ? claimed.age >= 13 && claimed.age < 18 : claimed.band === "high";
    const claimedChild = claimed.age !== undefined ? claimed.age < 13 : claimed.band === "early" || claimed.band === "primary";
    return { minor: true, under13: claimedChild ? true : claimedTeen ? false : null, basis: "Google says this account is under 18" };
  }
  if (gradeUnder13 !== null) return { minor: signals.grade! <= 12, under13: gradeUnder13, basis: `the classes are grade ${signals.grade}` };
  return { minor: null, under13: null, basis: "no age information from Google" };
}

/** A parent has to connect: under 13, or a minor we can't confirm is 13 or older. */
export function needsParent(v: AgeVerdict): boolean {
  return v.under13 === true || (v.minor === true && v.under13 === null);
}
