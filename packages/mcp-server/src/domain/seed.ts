import type { State } from "./types.ts";

export function createSeedState(_now: Date): State {
  return {
    version: 2,
    clockOffsetMs: 0,
    household: { id: "home", name: "Home", timeZone: process.env.BUDDY_TZ ?? "America/Chicago" },
    activeLearnerId: undefined,
    learners: [],
    materials: [],
    decks: [],
    concepts: [],
    mastery: [],
    quizzes: [],
    teachBacks: [],
    stories: [],
    focus: [],
    seq: 100,
  };
}
