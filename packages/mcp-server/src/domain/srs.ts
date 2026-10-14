import type { Mastery } from "./types.ts";
import { addDays, daysBetween, isoDate } from "./time.ts";

/**
 * Spaced repetition (SM-2 family) with two additions that matter for students:
 *  1. Exam-aware: a concept is never scheduled past the day before its exam.
 *  2. Strength: an estimate of "would they get this right right now?" that decays over time,
 *     used for the mastery map and to pick what to review.
 */

export type Grade = "again" | "hard" | "good" | "easy";

export function gradeFor(score: number): Grade {
  if (score < 0.4) return "again";
  if (score < 0.7) return "hard";
  if (score < 0.9) return "good";
  return "easy";
}

export function newMastery(learnerId: string, conceptId: string, today: string): Mastery {
  return { learnerId, conceptId, reps: 0, lapses: 0, ease: 2.5, intervalDays: 0, due: today, misconceptions: [], history: [] };
}

export function review(m: Mastery, score: number, today: string, examDate?: string): Mastery {
  const g = gradeFor(score);
  const q = { again: 1, hard: 3, good: 4, easy: 5 }[g];
  m.ease = Math.max(1.3, m.ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
  if (g === "again") {
    m.lapses += 1;
    m.reps = 0;
    m.intervalDays = 0; // see it again today/tomorrow
  } else {
    m.reps += 1;
    if (m.reps === 1) m.intervalDays = g === "easy" ? 3 : 1;
    else if (m.reps === 2) m.intervalDays = g === "hard" ? 2 : 4;
    else m.intervalDays = Math.round(m.intervalDays * (g === "hard" ? 1.2 : m.ease) * (g === "easy" ? 1.3 : 1));
  }
  let due = isoDate(addDays(new Date(`${today}T12:00:00Z`), Math.max(g === "again" ? 0 : 1, m.intervalDays)), "UTC");
  if (examDate && examDate > today) {
    const dayBefore = isoDate(addDays(new Date(`${examDate}T12:00:00Z`), -1), "UTC");
    if (due > dayBefore) due = dayBefore < today ? today : dayBefore;
  }
  m.due = due;
  m.lastReviewed = today;
  return m;
}

/** 0..1 estimate of recall right now. */
export function strength(m: Mastery | undefined, today: string): number {
  if (!m || m.history.length === 0) return 0;
  const recent = m.history.slice(-3);
  const avg = recent.reduce((s, h) => s + h.score, 0) / recent.length;
  const since = m.lastReviewed ? Math.max(0, daysBetween(m.lastReviewed, today)) : 0;
  const stability = Math.max(1, m.intervalDays * 1.6 + m.reps);
  const retention = Math.exp(-since / stability);
  return Math.round(avg * (0.55 + 0.45 * retention) * 100) / 100;
}

export type MasteryStatus = "new" | "shaky" | "learning" | "solid";

export function statusFor(m: Mastery | undefined, today: string): MasteryStatus {
  if (!m || m.history.length === 0) return "new";
  const s = strength(m, today);
  if (s < 0.5) return "shaky";
  if (s < 0.8) return "learning";
  return "solid";
}

export function isDue(m: Mastery | undefined, today: string): boolean {
  return !m || m.due <= today;
}
