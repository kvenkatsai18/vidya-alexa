import type { LevelBand } from "./types.ts";

/**
 * Personalization starts here: the same concept is taught very differently to a 6-year-old,
 * a 10th grader and a second-year engineering student. The band is derived from what the
 * learner tells us (age and/or class), so every level is supported without special cases.
 */
export function bandFor(level: string | undefined, age: number | undefined): LevelBand {
  const l = (level ?? "").toLowerCase();
  if (/\b(phd|doctoral|master'?s|mba|postgrad|working|professional|adult|parent|self[- ]?learner|career)\b/.test(l)) return "adult";
  if (/\b(college|university|undergrad|bachelor|b\.?\s?(tech|sc|a|com|e)|engineering|medical school|freshman|sophomore|junior year|senior year|(1st|2nd|3rd|4th|first|second|third|fourth|final) year)\b/.test(l)) return "college";
  const grade = gradeNumber(l);
  if (grade !== undefined) {
    if (grade <= 2) return "early";
    if (grade <= 5) return "primary";
    if (grade <= 8) return "middle";
    return "high";
  }
  if (/\b(kindergarten|kg|preschool|nursery)\b/.test(l)) return "early";
  if (/\b(high school|secondary|gcse|a[- ]levels?|sat|board exams?)\b/.test(l)) return "high";
  if (/\b(middle school)\b/.test(l)) return "middle";
  if (/\b(primary|elementary)\b/.test(l)) return "primary";
  if (age !== undefined) {
    if (age <= 7) return "early";
    if (age <= 10) return "primary";
    if (age <= 13) return "middle";
    if (age <= 18) return "high";
    if (age <= 23) return "college";
    return "adult";
  }
  return "high";
}

/**
 * An age that clearly doesn't fit the stated class is most likely a guess (an assistant filling in a
 * field the person never mentioned), so it's ignored and the class decides. Age matters: under-13 rules
 * (parent visibility, online games) depend on it.
 */
export function plausibleAge(level: string | undefined, age: number): number | undefined {
  const l = (level ?? "").toLowerCase();
  const grade = gradeNumber(l);
  if (grade !== undefined && (age < grade + 3 || age > grade + 9)) return undefined;
  const band = bandFor(level, undefined);
  if (level && band === "college" && age < 15) return undefined;
  return age;
}

export function gradeNumber(level: string): number | undefined {
  const l = level.toLowerCase();
  const m =
    l.match(/\b(?:grade|class|standard|std|year)\s*(\d{1,2})\b/) ??
    l.match(/\b(\d{1,2})(?:st|nd|rd|th)\s*(?:grade|class|standard|std)?\b/) ??
    l.match(/^\s*(\d{1,2})\s*$/);
  if (!m) return undefined;
  const n = Number(m[1]);
  return n >= 1 && n <= 12 ? n : undefined;
}

export interface VoiceGuide {
  band: LevelBand;
  label: string;
  tone: string;
  vocabulary: string;
  sessionMinutes: number;
  questionStyle: string;
}

export const GUIDES: Record<LevelBand, VoiceGuide> = {
  early: {
    band: "early",
    label: "young child (about 5 to 7)",
    tone: "Warm, playful and patient. Celebrate effort. Use characters, sounds and tiny stories.",
    vocabulary: "Very short sentences, everyday words only. Explain any new word with something they can see or touch.",
    sessionMinutes: 5,
    questionStyle: "Yes/no or pick-one questions, one idea at a time.",
  },
  primary: {
    band: "primary",
    label: "primary school (about 8 to 10)",
    tone: "Encouraging and fun, like a favourite teacher. Turn practice into a game.",
    vocabulary: "Simple words and concrete examples from home, school, sports and cartoons.",
    sessionMinutes: 10,
    questionStyle: "Short questions with clear right answers; offer hints freely.",
  },
  middle: {
    band: "middle",
    label: "middle school (about 11 to 13)",
    tone: "Friendly and upbeat, like a cool older cousin. Relatable, never babyish.",
    vocabulary: "Introduce proper terms but define them right away with a relatable example.",
    sessionMinutes: 15,
    questionStyle: "Mix of multiple choice and 'explain in your own words'.",
  },
  high: {
    band: "high",
    label: "high school (about 14 to 18)",
    tone: "Focused and motivating, exam-aware, a little witty. Treat them as capable.",
    vocabulary: "Correct subject terminology and exam phrasing; connect ideas to their interests.",
    sessionMinutes: 20,
    questionStyle: "Exam-style questions, including 'why' and 'compare' questions.",
  },
  college: {
    band: "college",
    label: "college / university",
    tone: "Peer-level and rigorous. Get to the point; reward deep understanding.",
    vocabulary: "Precise technical language, mechanisms and edge cases; real-world applications.",
    sessionMinutes: 30,
    questionStyle: "Conceptual and application questions; ask them to justify answers.",
  },
  adult: {
    band: "adult",
    label: "adult learner",
    tone: "Respectful and efficient, practical. Never patronizing.",
    vocabulary: "Plain professional language; tie concepts to work and daily life.",
    sessionMinutes: 20,
    questionStyle: "Practical scenario questions.",
  },
};

/** One-paragraph instruction any LLM (or MCP client) can follow to talk to this learner. */
export function voiceGuideText(name: string, band: LevelBand, interests: string[], extras: string[] = []): string {
  const g = GUIDES[band];
  return [
    `You're talking with ${name}, a ${g.label} learner.`,
    `Tone: ${g.tone}`,
    `Language: ${g.vocabulary}`,
    interests.length ? `When an example helps, take it from what ${name} loves: ${interests.join(", ")}. Don't force it into everything.` : "",
    ...extras,
  ]
    .filter(Boolean)
    .join(" ");
}
