import {
  bedtimeStory,
  deckFromMaterial,
  deckFromTopic,
  evaluateTeachBack,
  explain,
  grade,
  freshQuestions,
  keywords,
  regrade,
  researchTopic,
  summarize,
  type DeckDraft,
} from "./generate.ts";
import { needsParent as needsParentByAge } from "./age.ts";
import { bandFor, GUIDES, plausibleAge, voiceGuideText } from "./levels.ts";
import { detectConcern, safetyReply, type DetectedConcern } from "./safety.ts";
import type { Llm } from "./llm.ts";
import { isDue, newMastery, review, statusFor, strength } from "./srs.ts";
import type { Store } from "./store.ts";
import { addDays, daysBetween, hourIn, isoDate, relativeDay, spokenDate } from "./time.ts";
import type {
  Concept,
  Deck,
  Exam,
  ExplainStyle,
  GroupPlayer,
  GroupQuiz,
  Learner,
  Lesson,
  Mastery,
  MemoryKind,
  MemorySource,
  Question,
  QuizItem,
  QuizSession,
  State,
} from "./types.ts";

/** "Biology exam" -> "Biology"; "Unit 4 test: Cell division" -> "Cell division". */
function examTopic(e: Exam): string {
  const t = e.title.replace(/^.*?:\s*/, (m) => (/test|quiz|exam/i.test(m) ? "" : m)).replace(/\b(unit \d+|final|midterm|mid-term)\b/gi, "").replace(/\b(test|exam|quiz|assessment)s?\b/gi, "").replace(/\s+/g, " ").trim();
  return t || e.subject || e.title;
}

/** Does this study set belong to this exam? Same subject, or the exam's title names the set's subject or topic. */
function examMatchesDeck(e: Exam, d: Deck): boolean {
  const subject = (d.subject || "").toLowerCase();
  const title = e.title.toLowerCase();
  if (e.subject && subject && e.subject.toLowerCase() === subject) return true;
  if (subject && subject !== "general" && new RegExp(`\\b${subject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(title)) return true;
  const topic = examTopic(e).toLowerCase();
  return topic.length > 3 && (d.title.toLowerCase().includes(topic) || topic.includes(d.title.toLowerCase()));
}

/** Words that ask the assistant to do something differently ("too long", "don't use…", "that's wrong"). */
export function asksForChange(said: string): boolean {
  return /\b(too (long|short|fast|slow|hard|easy|much|little|childish|babyish|simple|complicated|wordy|boring)|shorter|longer|simpler|slower|faster|harder|easier|(don'?t|do not|never|stop) (use|using|say|saying|call|calling|give|giving|ask|asking|explain|explaining|talk|talking|read|reading|do|doing)|instead|rather|i prefer|i'?d prefer|i like it when|i learn better|please (be|keep|make|use|talk|speak|explain|go)|can you (be|keep|make|talk|speak|explain it|go|use)|you (got|marked|graded) (that|it|my answer)|that'?s (wrong|not right|incorrect)|wrong|less|more (examples|detail|details|fun)|next time|from now on|remember to|like an adult|like a kid|grown[- ]up)\b/i.test(said);
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "Friday", "next Monday", "tomorrow", "in 5 days", "Oct 30", "30th October" -> yyyy-mm-dd (in the home's time zone). */
export function whenToDate(words: string, now: Date, tz: string): string | undefined {
  const t = words.toLowerCase().trim();
  const today = isoDate(now, tz);
  const base = new Date(`${today}T12:00:00Z`);
  const plus = (n: number) => isoDate(addDays(base, n), "UTC");
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  if (/\btoday\b/.test(t)) return plus(0);
  if (/\b(day after tomorrow)\b/.test(t)) return plus(2);
  if (/\btomorrow\b/.test(t)) return plus(1);
  const inN = t.match(/\bin (\d{1,3}) days?\b/);
  if (inN) return plus(Number(inN[1]));
  if (/\b(in a week|next week)\b/.test(t)) return plus(7);
  const wd = WEEKDAYS.findIndex((d) => new RegExp(`\\b${d.slice(0, 3)}(${d.slice(3)})?\\b`).test(t));
  if (wd >= 0) {
    const cur = base.getUTCDay();
    let diff = (wd - cur + 7) % 7 || 7;
    if (/\bnext\b/.test(t) && diff < 7 && !/\bthis\b/.test(t) && diff <= 2) diff += 7; // "next Monday" said on a Saturday
    return plus(diff);
  }
  const md = t.match(/\b([a-z]{3})[a-z]*\.? (\d{1,2})(st|nd|rd|th)?\b/) ?? t.match(/\b(\d{1,2})(st|nd|rd|th)? (?:of )?([a-z]{3})[a-z]*\b/);
  if (md) {
    const [mon, day] = /^\d/.test(md[1]) ? [md[3], Number(md[1])] : [md[1], Number(md[2])];
    const m = MONTHS.indexOf(mon);
    if (m >= 0 && day >= 1 && day <= 31) {
      let y = base.getUTCFullYear();
      const pad = (n: number) => String(n).padStart(2, "0");
      let d = `${y}-${pad(m + 1)}-${pad(day)}`;
      if (d < today) d = `${++y}-${pad(m + 1)}-${pad(day)}`;
      return d;
    }
  }
  return undefined;
}

const NUMBER_WORDS: Record<number, string> = { 2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight", 9: "nine", 10: "ten" };

/** Every tool result carries `kind` (which card to render) and `speech` (what the assistant should say). */
export interface Result {
  kind: string;
  speech: string;
  [key: string]: unknown;
}

export class BuddyError extends Error {}

export const BRAND = process.env.BUDDY_BRAND ?? "Vidya";

const PRAISE: Record<Learner["band"], string[]> = {
  early: ["Yay, you got it!", "Wow, super job!", "Yes! High five!"],
  primary: ["Awesome, that's right!", "You got it!", "Brilliant!"],
  middle: ["Nice, that's right!", "Nailed it.", "Yep, exactly."],
  high: ["Nailed it.", "Spot on.", "Exactly right."],
  college: ["Correct.", "Exactly.", "Right, well reasoned."],
  adult: ["That's right.", "Correct.", "Exactly."],
};

function pick<T>(arr: T[], seed: number): T {
  return arr[Math.abs(seed) % arr.length];
}
function lcFirst(s: string) {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}
/** Lowercase for mid-sentence use, keeping acronyms ("DNA") and "I" intact. */
function low(s: string) {
  return s.split(/(\s+)/).map((w) => (/^[A-Z]{2,}/.test(w) || /^I$/.test(w) ? w : w.toLowerCase())).join("");
}
function plural(n: number, w: string) {
  return `${n} ${w}${n === 1 ? "" : "s"}`;
}
function listJoin(items: string[]) {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}
function titleCase(s: string) {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

export interface SetUpInput {
  name: string;
  age?: number;
  level?: string;
  subjects?: string[];
  interests?: string[];
  role?: "student" | "child";
  exam?: { title: string; subject?: string; date?: string; inDays?: number; when?: string };
}

export class Mentor {
  /** Set by the server when school sync is available (keeps this module free of a circular import). */
  school?: {
    summaryFor(l: Learner): { dueSoon: number; missing: number; next?: string } | null;
    connection(l: Learner): unknown;
    sync(learnerName: string | undefined, llm: Llm | null): Promise<Result>;
  };

  constructor(readonly store: Store) {}

  // ------------------------------------------------------------------ basics

  private get s(): State {
    return this.store.get();
  }
  private get tz() {
    return this.s.household.timeZone;
  }
  now() {
    return this.store.now();
  }
  today() {
    return isoDate(this.now(), this.tz);
  }
  private id(prefix: string) {
    return `${prefix}-${++this.s.seq}`;
  }

  findLearner(name?: string): Learner | undefined {
    if (!name) return this.s.learners.find((l) => l.id === this.s.activeLearnerId);
    const n = name.trim().toLowerCase();
    return (
      this.s.learners.find((l) => l.id === n || l.name.toLowerCase() === n || (l.aliases ?? []).some((a) => a.toLowerCase() === n)) ??
      this.s.learners.find((l) => l.name.toLowerCase().startsWith(n))
    );
  }

  learner(): Learner {
    const l = this.findLearner();
    if (!l) {
      throw new BuddyError(
        this.s.learners.length
          ? `Who's studying today? I know ${listJoin(this.s.learners.filter((x) => x.role === "student").map((x) => x.name))}.`
          : `Hi! I'm ${BRAND}. Before we start, tell me a little about you: your name, your class or year, and what you're into.`,
      );
    }
    return l;
  }

  private voiceGuide(l: Learner) {
    const worked = l.stylesThatWorked.length ? [`Explanations that worked before: ${l.stylesThatWorked.slice(0, 3).join(", ")}.`] : [];
    const struggles = l.memories.filter((m) => m.kind === "struggle").slice(-2).map((m) => m.text);
    const lessons = (l.lessons ?? []).map((x) => x.text);
    return voiceGuideText(l.name, l.band, l.interests, [
      ...worked,
      ...(struggles.length ? [`Keep in mind: ${struggles.join("; ")}.`] : []),
      ...(lessons.length ? [`${l.name} corrected you before. Always follow these: ${lessons.join("; ")}.`] : []),
    ]);
  }

  // ------------------------------------------------------------------ learning from corrections

  /**
   * The learner corrected us ("call me Priya A", "that's too long", "stop using cricket examples").
   * Save it as a lesson that every future session and every generated explanation follows.
   */
  learnFromFeedback(input: { lesson: string; kind?: Lesson["kind"]; preferredName?: string; learnerSaid?: string }, source: Lesson["source"] = "told"): Result {
    const l = this.learner();
    // Only learn what the learner actually asked for. The assistant may not invent a correction
    // ("stop" is not "keep it shorter"); when we know their words, the lesson must be grounded in them.
    if (input.learnerSaid !== undefined) {
      const said = input.learnerSaid.trim();
      const askedName = !!input.preferredName && /\b(call me|my name is|i'?m called|name'?s|pronounced?)\b/i.test(said);
      const askedChange = asksForChange(said);
      if (!askedName) input = { ...input, preferredName: undefined };
      if (!askedName && !askedChange) {
        return { kind: "lesson_skipped", title: "", saved: false, reason: "The learner didn't ask for a change, so nothing was saved.", speech: "" };
      }
      if (!askedChange) input = { ...input, lesson: "" };
    }
    const name = input.preferredName?.trim().replace(/[.!?]+$/, "");
    const other = input.lesson.trim().replace(/\s+/g, " ").replace(/[.!]+$/, "");
    if (name && name.toLowerCase() !== l.name.toLowerCase()) {
      const old = l.name;
      this.store.update(() => {
        l.aliases = [...new Set([...(l.aliases ?? []), old])];
        l.name = name;
        this.addLesson(l, `Call them ${name}, not ${old}`, "name", source);
        // "That's too long, and call me Priya A": keep both lessons.
        if (other && !/^call (me|them)\b/i.test(other)) this.addLesson(l, other.charAt(0).toUpperCase() + other.slice(1), input.kind && input.kind !== "name" ? input.kind : "other", source);
      });
      return { kind: "lesson_learned", title: "Got it", lesson: `Call them ${name}`, lessons: this.lessonsOf(l), learner: this.learnerCard(l), speech: `Got it, ${name}. That's what I'll call you from now on.${other && !/^call (me|them)\b/i.test(other) ? " And I'll keep that in mind too." : ""}` };
    }
    // Already switched (the server caught "call me Pri" as they said it): just confirm it.
    if (name && name.toLowerCase() === l.name.toLowerCase() && (!other || /^call (me|them)\b/i.test(other)))
      return { kind: "lesson_learned", title: "Got it", lesson: `Call them ${l.name}`, lessons: this.lessonsOf(l), learner: this.learnerCard(l), speech: `Got it, ${l.name}. That's what I'll call you from now on.` };
    const text = input.lesson.trim().replace(/\s+/g, " ").replace(/[.!]+$/, "");
    if (!text) throw new BuddyError("What should I do differently?");
    let added = false;
    this.store.update(() => {
      added = this.addLesson(l, text.charAt(0).toUpperCase() + text.slice(1), input.kind ?? "other", source);
    });
    const speech = !added ? `I've already got that one, and I'll keep doing it.` : input.kind === "grading" ? `Thanks. I'll grade that more fairly from now on.` : `Thanks for telling me. I'll do it that way from now on.`;
    return { kind: "lesson_learned", title: "Got it", lesson: text, lessons: this.lessonsOf(l), learner: this.learnerCard(l), speech };
  }

  private addLesson(l: Learner, text: string, kind: Lesson["kind"], source: Lesson["source"]): boolean {
    l.lessons ??= [];
    const key = text.toLowerCase();
    if (l.lessons.some((x) => x.text.toLowerCase() === key)) return false;
    // A newer name or style lesson replaces an older one of the same kind and topic.
    if (kind === "name") l.lessons = l.lessons.filter((x) => x.kind !== "name");
    l.lessons.push({ id: this.id("lesson"), text, kind, source, at: this.now().toISOString() });
    if (l.lessons.length > 40) l.lessons.splice(0, l.lessons.length - 40);
    return true;
  }

  private lessonsOf(l: Learner) {
    return (l.lessons ?? []).map((x) => ({ text: x.text, kind: x.kind, source: x.source, when: relativeDay(x.at, this.now(), this.tz) }));
  }

  /** Catch common corrections in what the learner said, even if the assistant didn't save them. */
  /** "I have a thermodynamics exam next Tuesday": saved from their words, whatever the model does with them. */
  private detectExam(l: Learner, heard: string): Exam | undefined {
    if (/\b(quiz me|was|were|had|failed|took|did|passed|sat|went)\b/i.test(heard)) return undefined;
    const m = heard.match(/\b((?:[A-Za-z][\w'-]*\s+){0,3}?)(exam|test|midterm|final|finals)\b/i);
    if (!m) return undefined;
    const date = whenToDate(heard, this.now(), this.tz);
    if (!date || date < this.today()) return undefined;
    const lead = m[1].trim().split(/\s+/).filter((w) => w && !/^(a|an|my|the|our|have|has|got|i|i've|ive|i'm|im|is|big|next|this|upcoming|another|for|of|and|so|um|uh)$/i.test(w));
    const title = `${lead.length ? `${titleCase(lead.join(" "))} ` : ""}${m[2].toLowerCase()}`.replace(/^./, (c) => c.toUpperCase());
    if (l.exams.some((x) => x.date === date && (low(x.title) === low(title) || keywords(x.title).some((k) => keywords(title).includes(k))))) return undefined;
    return this.store.update(() => this.addExamTo(l, { title, subject: lead.length ? titleCase(lead.join(" ")) : undefined, date }));
  }

  private detectLesson(l: Learner, heard: string): Result | undefined {
    const t = heard.replace(/^\s*(hey |ok |okay )?alexa[,!.]?\s*/i, "").trim();
    const nameMatch = t.match(/\b(?:please |just )?call me ([A-Za-z][\w'-]*(?: [A-Z][\w.'-]*)?)/i);
    if (nameMatch && !/^(back|later|when|if|tomorrow|now|again)$/i.test(nameMatch[1])) {
      // "call me Pri from now on": the name is "Pri", not "Pri From".
      const words = nameMatch[1].split(" ");
      if (words.length > 1 && /^(from|now|on|please|instead|ok|okay|then|again|too|and|so|thanks|for|by|when|if|today|anymore)$/i.test(words[1])) words.length = 1;
      const name = words.join(" ").replace(/\b\w/g, (c) => c.toUpperCase());
      if (name.toLowerCase() !== l.name.toLowerCase()) return this.learnFromFeedback({ lesson: "", preferredName: name }, "detected");
      return undefined;
    }
    const style: Array<[RegExp, string, Lesson["kind"]]> = [
      [/\b(too long|too wordy|way too much|shorter please|keep it short(er)?)\b/i, "Keep explanations short", "style"],
      [/\b(too fast|slow down|slower please)\b/i, "Go slower, one idea at a time", "style"],
      [/\b(too hard|too difficult)\b/i, "Make questions a little easier", "teaching"],
      [/\b(too easy|too simple|more challenging|harder questions)\b/i, "Make questions more challenging", "teaching"],
      [/\b(too childish|babyish|like a (little )?kid|like i'?m five)\b/i, "Talk in a more grown-up way", "style"],
    ];
    for (const [re, lesson, kind] of style) if (re.test(t)) return this.learnFromFeedback({ lesson, kind }, "detected");
    const dont = t.match(/\b(?:please )?(?:don'?t|do not|stop|never) (call(?:ing)? me|us(?:e|ing)|say(?:ing)?|giv(?:e|ing)|ask(?:ing)?|read(?:ing)?) ([^.!?]{3,60})/i);
    if (dont) {
      const verb = dont[1].toLowerCase().replace(/ing\b/, "").replace(/^us$/, "use").replace(/^giv$/, "give").replace(/^ask$/, "ask").replace(/^say$/, "say").replace(/^read$/, "read").replace(/^call me$/, "call me").replace(/^calling me$/, "call me");
      return this.learnFromFeedback({ lesson: `Don't ${verb} ${dont[2].trim()}`, kind: "style" }, "detected");
    }
    return undefined;
  }

  /**
   * "That was right!": re-check the last graded answer. If we were wrong, fix the score, drop the
   * mistake we recorded, and keep a grading lesson so it doesn't happen again.
   */
  async recheck(llm: Llm | null, reason = ""): Promise<Result> {
    const l = this.learner();
    const session = this.s.quizzes.filter((q) => q.learnerId === l.id && q.results.length).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    const last = session?.results[session.results.length - 1];
    if (!session || !last?.answer) throw new BuddyError("I don't have a recent answer to check. Let's do a quick quiz first.");
    if (last.verdict === "correct") return { kind: "recheck", title: "Already right", overturned: false, speech: `I marked that one right already, so you're all good.` };
    const concept = this.s.concepts.find((c) => c.id === last.conceptId)!;
    const q = concept.questions.find((x) => x.id === last.questionId) ?? { id: "fc", type: "short" as const, prompt: concept.flashcards[0]?.front ?? concept.title, answer: concept.summary, explanation: concept.summary };
    const r = await regrade(llm, l, concept, q, last.answer, reason);
    if (!r.overturned) return { kind: "recheck", title: "Checked again", overturned: false, concept: concept.title, speech: r.feedback || `I checked again, and I still think it's ${q.answer}.` };
    const today = this.today();
    this.store.update(() => {
      last.score = Math.max(last.score, r.score);
      last.verdict = r.score >= 0.8 ? "correct" : "partial";
      last.corrected = true;
      const m = this.mastery(l, concept.id);
      if (m) {
        const mis = last.misconception ? m.misconceptions.find((x) => x.text === last.misconception && !x.resolved) : undefined;
        if (mis) m.misconceptions.splice(m.misconceptions.indexOf(mis), 1);
        m.history.push({ at: this.now().toISOString(), score: last.score, mode: "quiz" });
        review(m, last.score, today, this.examFor(l, concept.id)?.date);
      }
      if (r.lesson) this.addLesson(l, r.lesson, "grading", "told");
    });
    return {
      kind: "recheck",
      title: "You were right",
      overturned: true,
      concept: concept.title,
      lesson: r.lesson ?? null,
      lessons: this.lessonsOf(l),
      speech: `${r.feedback || "You're right, and I got that wrong."} I've fixed your score${r.lesson ? ", and I'll grade that kind of answer fairly from now on" : ""}.`,
    };
  }

  private learnerCard(l: Learner) {
    return {
      id: l.id,
      name: l.name,
      role: l.role,
      age: l.age ?? null,
      level: l.level,
      band: l.band,
      bandLabel: GUIDES[l.band].label,
      interests: l.interests,
      subjects: l.subjects,
      streak: l.streak,
      addedBy: l.addedBy ?? null,
    };
  }

  private mastery(l: Learner, conceptId: string): Mastery | undefined {
    return this.s.mastery.find((m) => m.learnerId === l.id && m.conceptId === conceptId);
  }

  private decksOf(l: Learner): Deck[] {
    return this.s.decks.filter((d) => d.learnerId === l.id);
  }

  private conceptsOf(l: Learner, deckIds?: string[]): Concept[] {
    const ids = new Set((deckIds?.length ? deckIds : this.decksOf(l).map((d) => d.id)));
    return this.s.concepts.filter((c) => ids.has(c.deckId));
  }

  private examFor(l: Learner, conceptId?: string): Exam | undefined {
    const today = this.today();
    const upcoming = l.exams.filter((e) => e.date >= today).sort((a, b) => a.date.localeCompare(b.date));
    if (!conceptId) return upcoming[0];
    const c = this.s.concepts.find((x) => x.id === conceptId);
    return upcoming.find((e) => !e.deckIds.length || (c && e.deckIds.includes(c.deckId))) ?? upcoming[0];
  }

  private touchStreak(l: Learner) {
    const today = this.today();
    if (l.streak.lastDay === today) return;
    const yesterday = isoDate(addDays(new Date(`${today}T12:00:00Z`), -1), "UTC");
    l.streak.current = l.streak.lastDay === yesterday ? l.streak.current + 1 : 1;
    l.streak.best = Math.max(l.streak.best, l.streak.current);
    l.streak.lastDay = today;
  }

  private addMemory(l: Learner, text: string, kind: MemoryKind, source: MemorySource, by?: string) {
    const norm = text.trim().replace(/\.$/, "");
    if (l.memories.some((m) => m.text.toLowerCase() === norm.toLowerCase())) return;
    l.memories.push({ id: this.id("mem"), text: norm, kind, source, ...(by ? { by } : {}), at: this.now().toISOString() });
  }

  private moodToday(l: Learner): string | undefined {
    return l.mood && l.mood.day === this.today() ? l.mood.state : undefined;
  }

  /**
   * strict: the learner named a topic ("explain enthalpy"), so it must be in a concept's title, not just
   * mentioned in its summary (an entropy card that mentions enthalpy isn't enthalpy).
   */
  resolveConcept(l: Learner, query?: string, strict = false): Concept | undefined {
    const pool = this.conceptsOf(l);
    if (!pool.length) return undefined;
    if (!query) return this.weakest(l, pool) ?? pool[0];
    const q = query.toLowerCase();
    const exact = pool.find((c) => c.id === query || low(c.title) === q);
    if (exact) return exact;
    const qk = new Set(keywords(q));
    if (strict) {
      const deckTitle = (c: Concept) => this.s.decks.find((d) => d.id === c.deckId)?.title ?? "";
      return pool
        .map((c) => ({ c, hits: keywords(`${c.title} ${deckTitle(c)}`).filter((k, i, a) => qk.has(k) && a.indexOf(k) === i).length, inTitle: low(c.title).includes(q) || q.includes(low(c.title)) }))
        .filter((x) => x.inTitle || x.hits * 2 > qk.size)
        .sort((a, b) => Number(b.inTitle) - Number(a.inTitle) || b.hits - a.hits)[0]?.c;
    }
    const scored = pool
      .map((c) => ({ c, score: keywords(`${c.title} ${c.title} ${c.summary}`).filter((k) => qk.has(k)).length + (low(c.title).includes(q) || q.includes(low(c.title)) ? 3 : 0) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    return scored[0]?.c;
  }

  private weakest(l: Learner, pool: Concept[]): Concept | undefined {
    const today = this.today();
    return pool
      .filter((c) => this.mastery(l, c.id)?.history.length)
      .sort((a, b) => strength(this.mastery(l, a.id), today) - strength(this.mastery(l, b.id), today))[0];
  }

  // ------------------------------------------------------------------ profiles & memory

  setUpLearner(input: SetUpInput): Result {
    const pre = this.findLearner(input.name);
    if (pre?.addedBy && !pre.metAt && input.role !== "child") {
      // The child is introducing themselves; a parent already told us about them.
      this.store.update(() => {
        for (const x of input.interests ?? []) if (!pre.interests.includes(x.toLowerCase())) pre.interests.push(x.toLowerCase());
      });
      return this.meet(pre);
    }
    return this.store.update((s) => {
      let l = this.findLearner(input.name);
      const isNew = !l;
      if (!l) {
        l = {
          id: input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || this.id("learner"),
          name: titleCase(input.name.trim()),
          role: input.role ?? (input.age !== undefined && input.age <= 8 ? "child" : "student"),
          level: "",
          band: "high",
          subjects: [],
          interests: [],
          stylesThatWorked: [],
          memories: [],
          exams: [],
          streak: { current: 0, best: 0 },
          minutesStudied: 0,
          createdAt: this.now().toISOString(),
        };
        if (s.learners.some((x) => x.id === l!.id)) l.id = this.id(l.id);
        s.learners.push(l);
      }
      // Google said they're under 18: a spoken "I'm 18" doesn't change that.
      if (input.age !== undefined && !(l.ageCheck?.minor && input.age >= 18)) {
        const age = plausibleAge(input.level ?? l.level, input.age);
        if (age !== undefined) l.age = age;
      }
      if (input.level) l.level = input.level;
      if (input.role) l.role = input.role;
      l.band = bandFor(l.level, l.age);
      if (!l.level) l.level = l.age !== undefined ? `Age ${l.age}` : "Not set";
      for (const x of input.subjects ?? []) if (!l.subjects.some((y) => y.toLowerCase() === x.toLowerCase())) l.subjects.push(titleCase(x));
      for (const x of input.interests ?? []) if (!l.interests.some((y) => y.toLowerCase() === x.toLowerCase())) l.interests.push(x.toLowerCase());
      let exam: Exam | undefined;
      if (input.exam) exam = this.addExamTo(l, input.exam);
      if (l.role === "student") s.activeLearnerId = l.id;

      const g = GUIDES[l.band];
      const bits: string[] = [];
      if (isNew) bits.push(l.role === "child" ? `Hi ${l.name}! It's so nice to meet you.` : `Nice to meet you, ${l.name}!`);
      else bits.push(`Got it, I've updated your profile, ${l.name}.`);
      if (l.role === "student") {
        const about: string[] = [];
        if (l.level && l.level !== "Not set") about.push(l.level.charAt(0).toUpperCase() + l.level.slice(1));
        if (l.interests.length) about.push(`into ${listJoin(l.interests.slice(0, 3))}`);
        if (about.length && isNew) bits.push(`${about.join(", ")}. I'll keep my explanations at your level and use examples you'll actually like.`);
        if (exam) bits.push(`Your ${exam.title} is ${relativeDay(exam.date, this.now(), this.tz)}, ${plural(daysBetween(this.today(), exam.date), "day")} away. I'll plan our sessions around it.`);
        if (isNew) bits.push(this.decksOf(l).length ? "Want to pick up where we left off?" : "Want to share your notes, or tell me a topic to start with?");
      }
      return {
        kind: "profile",
        title: isNew ? `Welcome, ${l.name}` : `${l.name}'s profile`,
        isNew,
        learner: this.learnerCard(l),
        memories: l.memories,
        exams: l.exams,
        voiceGuide: this.voiceGuide(l),
        sessionMinutes: g.sessionMinutes,
        speech: bits.join(" "),
      };
    });
  }

  addExamTo(l: Learner, e: NonNullable<SetUpInput["exam"]>): Exam {
    const fromWords = e.when ? whenToDate(e.when, this.now(), this.tz) : undefined;
    const date = fromWords ?? (e.date && /^\d{4}-\d{2}-\d{2}$/.test(e.date) ? e.date : e.date ? whenToDate(e.date, this.now(), this.tz) : undefined) ?? isoDate(addDays(this.now(), Math.max(0, e.inDays ?? 7)), this.tz);
    const subject = e.subject ? titleCase(e.subject) : undefined;
    const existing = l.exams.find((x) => low(x.title) === low(e.title)) ?? l.exams.find((x) => x.date === date && keywords(x.title).some((k) => keywords(e.title).includes(k)));
    const deckIds = this.decksOf(l)
      .filter((d) => subject && d.subject.toLowerCase() === subject.toLowerCase())
      .map((d) => d.id);
    if (existing) {
      existing.date = date;
      existing.subject = subject ?? existing.subject;
      return existing;
    }
    const exam: Exam = { id: this.id("exam"), title: e.title.replace(/^./, (c) => c.toUpperCase()), subject, date, deckIds };
    l.exams.push(exam);
    if (subject && !l.subjects.includes(subject)) l.subjects.push(subject);
    return exam;
  }

  switchLearner(name: string): Result {
    const l = this.findLearner(name);
    if (!l) throw new BuddyError(`I haven't met ${name} yet. Want to set up a profile? Just tell me their name, class and what they like.`);
    this.store.update((s) => {
      s.activeLearnerId = l.id;
    });
    if (l.addedBy && !l.metAt) return this.meet(l);
    return this.todayBrief(`Hey ${l.name}!`);
  }

  // ------------------------------------------------------------------ meeting a child a parent set up

  /**
   * The first time a parent-added learner talks to us: greet them with what we already know, and ask
   * something fun about it. Not to collect data (we have it), but to start a real relationship.
   */
  private meet(l: Learner): Result {
    const today = this.today();
    this.store.update((s) => {
      l.metAt = this.now().toISOString();
      s.activeLearnerId = l.id;
    });
    const by = l.addedBy!;
    const young = l.band === "early" || l.band === "primary";
    const facts: string[] = [];
    if (l.level && l.level !== "Not set" && !/^age /i.test(l.level)) facts.push(`you're in ${l.level.replace(/^grade/i, "grade").replace(/^class/i, "class")}`);
    else if (l.age) facts.push(`you're ${l.age}`);
    if (l.interests.length) facts.push(`you love ${listJoin(l.interests.slice(0, 2))}`);
    const ask = icebreaker(l.interests[0]);
    const exam = this.examFor(l);
    const speech = [
      young ? `Hi ${l.name}! I'm ${BRAND}.` : `Hey ${l.name}, nice to finally meet you. I'm ${BRAND}.`,
      facts.length ? `Your ${by.relation.toLowerCase()} told me ${listJoin(facts)}.${young ? " That's so cool!" : ""}` : `Your ${by.relation.toLowerCase()} set me up so we can learn together.`,
      exam && !young ? `And I hear ${exam.title} is ${relativeDay(exam.date, this.now(), this.tz)}, so we'll get you ready.` : "",
      this.transparencyLine(l),
      ask.question,
    ]
      .filter(Boolean)
      .join(" ");
    return {
      kind: "meet",
      title: `Hi, ${l.name}!`,
      learner: this.learnerCard(l),
      addedBy: by,
      known: facts,
      askedAbout: ask.topic,
      question: ask.question,
      transparency: this.transparencyLine(l),
      today,
      speech,
    };
  }

  // ------------------------------------------------------------------ transparency & safety

  /** Who a parent can see, by default: under 13 everything, teens a summary, adults nothing. */
  visibilityFor(l: Learner): "full" | "summary" | "private" {
    if (l.visibility) return l.visibility;
    // What Google said about their age outranks what they said.
    if (l.ageCheck?.under13) return "full";
    const age = l.age;
    if (age !== undefined) {
      const v = age < 13 ? "full" : age < 18 ? "summary" : "private";
      return l.ageCheck?.minor && v === "private" ? "summary" : v;
    }
    if (l.ageCheck?.minor) return "summary";
    return l.band === "college" || l.band === "adult" ? "private" : l.band === "high" ? "summary" : "full";
  }

  guardianOf(l: Learner): { name: string; relation: string } | undefined {
    if (l.addedBy) return l.addedBy;
    const p = (this.s.parents ?? []).find((x) => x.childIds.includes(l.id));
    return p ? { name: p.name, relation: p.relation } : undefined;
  }

  /** Children are always told, plainly, what their parent can see. No secrets. */
  private transparencyLine(l: Learner): string {
    const g = this.guardianOf(l);
    const v = this.visibilityFor(l);
    if (!g || v === "private") return "";
    const rel = g.relation.toLowerCase();
    const pron = /mom|mum|mother|grandma|aunt/.test(rel) ? "she" : /dad|father|grandpa|uncle/.test(rel) ? "he" : "they";
    if (v === "full") return l.band === "early" || l.band === "primary" ? `Your ${rel} can see what we talk about, so ${pron} can help too.` : `Just so you know, your ${rel} can see our chats, so ${pron} can help too.`;
    return `Just so you know, your ${rel} can see how your studying is going, and if anything serious comes up, I'll let ${pron === "they" ? "them" : pron === "she" ? "her" : "him"} know.`;
  }

  /** The device logs each exchange so parents can review it; any serious concern is flagged right away. */
  recordTurn(heard: string, said: string, phase?: "heard" | "said"): Result {
    const l = this.speaker(heard);
    if (phase === "heard") {
      // Before the reply: take a correction on board now, so this very reply follows it.
      const learned = l && this.findLearner() && !detectConcern(heard) ? this.detectLesson(l, heard) : undefined;
      const exam = l && l.role === "student" ? this.detectExam(l, heard) : undefined;
      return { kind: "turn_recorded", title: "Heard", concern: null, learned: learned ? { lesson: learned.lesson, speech: learned.speech } : null, exam: exam ? { title: exam.title, date: exam.date, when: relativeDay(exam.date, this.now(), this.tz), daysAway: daysBetween(this.today(), exam.date) } : null, speech: "" };
    }
    const at = this.now().toISOString();
    let concern: Result | undefined;
    this.store.update((s) => {
      s.turns ??= [];
      s.turns.push({ id: this.id("turn"), learnerId: l?.id, heard: heard.slice(0, 1000), said: said.slice(0, 2000), at });
      if (s.turns.length > 3000) s.turns.splice(0, s.turns.length - 3000);
    });
    const d = detectConcern(heard);
    if (l && d) concern = this.raiseConcern(l, d, heard);
    // Learn from corrections even if the assistant didn't save them itself.
    const learned = phase === undefined && l && !d && this.findLearner() ? this.detectLesson(l, heard) : undefined;
    return { kind: "turn_recorded", title: "Logged", concern: concern ?? null, learned: learned ? { lesson: learned.lesson, speech: learned.speech } : null, speech: "" };
  }

  /** Checks a learner's own words before a tool acts on them. Returns a caring reply if something is wrong. */
  safetyCheck(text: string | undefined): Result | undefined {
    if (!text) return undefined;
    const l = this.speaker(text);
    const d = detectConcern(text);
    if (!l || !d) return undefined;
    return this.raiseConcern(l, d, text);
  }

  flagConcern(input: { category: DetectedConcern["category"]; severity?: DetectedConcern["severity"]; summary: string; excerpt?: string }): Result {
    const l = this.speaker(input.excerpt ?? "");
    if (!l) {
      // Nobody is set up on this device: still answer kindly and honestly; there's no parent to tell.
      return { kind: "concern_flagged", title: "You're not alone", category: input.category, severity: input.severity ?? "high", alerted: false, guardian: null, learner: null, speech: safetyReply(input.category, "", undefined, false) };
    }
    return this.raiseConcern(l, { category: input.category, severity: input.severity ?? "high", summary: input.summary }, input.excerpt ?? input.summary);
  }

  /**
   * Who is talking. Usually the current learner; if the assistant never said, work it out so a safety
   * concern is never dropped: a known name in their words ("I'm Leo"), or the only child at home.
   */
  private speaker(words: string): Learner | undefined {
    const current = this.findLearner();
    if (current) return current;
    const named = words.match(/\b(?:i'?m|i am|this is|it'?s|my name is)\s+([a-z]+)/i)?.[1];
    const byName = named ? this.findLearner(named) : undefined;
    if (byName) return byName;
    return this.s.learners.length === 1 ? this.s.learners[0] : undefined;
  }

  private raiseConcern(l: Learner, d: DetectedConcern, excerpt: string): Result {
    const minor = this.visibilityFor(l) !== "private";
    const guardian = this.guardianOf(l);
    const recent = (this.s.concerns ?? []).find((c) => c.learnerId === l.id && c.category === d.category && Date.parse(this.now().toISOString()) - Date.parse(c.at) < 10 * 60_000);
    let alerted = false;
    if (minor && !recent) {
      this.store.update((s) => {
        s.concerns ??= [];
        s.concerns.push({ id: this.id("concern"), learnerId: l.id, category: d.category, severity: d.severity, excerpt: excerpt.slice(0, 400), summary: d.summary, at: this.now().toISOString(), status: "new" });
      });
      alerted = true;
    }
    const young = l.band === "early" || l.band === "primary";
    const speech = minor
      ? safetyReply(d.category, l.name, guardian?.relation, young)
      : `${l.name}, I'm really glad you told me, and I'm sorry you're going through this. Please reach out to someone you trust today.${d.category === "self_harm" ? " If you might hurt yourself, call or text 988 right now to talk to someone." : d.category === "abuse" || d.category === "danger" ? " If you're in danger, call 911." : ""} You don't have to handle this alone.`;
    return {
      kind: "concern_flagged",
      title: "You're not alone",
      category: d.category,
      severity: d.severity,
      // Saved either way (a parent who links later sees it), but only a linked parent is actually alerted.
      alerted: !!guardian && minor && (alerted || !!recent),
      guardian: minor ? guardian?.relation ?? null : null,
      learner: this.learnerCard(l),
      speech,
    };
  }

  private concernsFor(l: Learner) {
    // Most serious first (urgent, then high, then watch), newest first within each.
    const rank = { urgent: 0, high: 1, watch: 2 } as const;
    return (this.s.concerns ?? []).filter((c) => c.learnerId === l.id).sort((a, b) => (a.status === "new" ? 0 : 1) - (b.status === "new" ? 0 : 1) || rank[a.severity] - rank[b.severity] || b.at.localeCompare(a.at));
  }

  onlineGamesAllowed(l: Learner): boolean {
    if (l.onlineGames) return l.onlineGames === "allowed";
    if (l.ageCheck?.minor !== undefined && l.ageCheck.minor !== null) return !needsParentByAge(l.ageCheck);
    return !((l.age !== undefined && l.age < 13) || (l.age === undefined && ["early", "primary", "middle"].includes(l.band)));
  }

  /** An online game finished: count it in this home (minutes, streak) and log it so parents can see it. */
  recordOnlineGame(learnerId: string, g: { code: string; title: string; score: number; correct: number; answered: number; others: string[]; won: boolean }) {
    const l = this.s.learners.find((x) => x.id === learnerId);
    if (!l) return;
    this.store.update((s) => {
      l.minutesStudied += Math.max(1, Math.round(g.answered * 0.7));
      this.touchStreak(l);
      s.turns ??= [];
      s.turns.push({
        id: this.id("turn"),
        learnerId: l.id,
        heard: `(Online Study Together with ${listJoin(g.others)})`,
        said: `Answered ${g.correct} of ${g.answered} right, ${g.score} points${g.won ? ", and won" : ""}.`,
        at: this.now().toISOString(),
      });
    });
  }

  parentSettings(input: { child: string; visibility?: "full" | "summary"; clearHistory?: boolean; onlineGames?: "allowed" | "off" }): Result {
    const child = this.findLearner(input.child);
    if (!child) throw new BuddyError(`I don't know ${input.child} yet.`);
    if (this.visibilityFor(child) === "private" && !child.visibility) throw new BuddyError(`${child.name} is an adult learner, so their conversations stay private.`);
    const bits: string[] = [];
    this.store.update((s) => {
      if (input.visibility) {
        child.visibility = input.visibility;
        const g = this.guardianOf(child);
        child.notice = `Quick heads-up: your ${g?.relation.toLowerCase() ?? "parent"} can now see ${input.visibility === "full" ? "our full chats" : "a summary of our chats"}.`;
        bits.push(input.visibility === "full" ? `You can now see all of ${child.name}'s conversations. I'll let ${child.name} know too, so there are no secrets.` : `You'll now see a summary of ${child.name}'s conversations instead of every word. Safety concerns will always come to you.`);
      }
      if (input.onlineGames) {
        child.onlineGames = input.onlineGames;
        bits.push(input.onlineGames === "allowed" ? `${child.name} can now play Study Together with friends from other homes, using invite codes only. They'll only ever see first names and scores.` : `Online games are off for ${child.name}. Study Together at home still works.`);
      }
            if (input.clearHistory) {
        s.turns = (s.turns ?? []).filter((t) => t.learnerId !== child.id);
        bits.push(`I've deleted ${child.name}'s conversation history.`);
      }
    });
    return {
      kind: "parent_settings",
      title: `${child.name}'s privacy settings`,
      child: this.learnerCard(child),
      visibility: this.visibilityFor(child),
      onlineGames: this.onlineGamesAllowed(child) ? "allowed" : "off",
      speech: bits.join(" ") || `${child.name}'s history is set to ${this.visibilityFor(child)}.`,
    };
  }

  parentHistory(childName: string, days = 7): Result {
    const child = this.findLearner(childName);
    if (!child) throw new BuddyError(`I don't know ${childName} yet.`);
    const v = this.visibilityFor(child);
    if (v === "private") throw new BuddyError(`${child.name} is an adult learner, so their conversations stay private.`);
    if (v === "summary") throw new BuddyError(`${child.name}'s history is set to summary, which is the default for teens. Ask me to switch ${child.name} to full history if you'd like to see every conversation.`);
    const since = new Date(this.now().getTime() - days * 86_400_000).toISOString();
    const turns = (this.s.turns ?? []).filter((t) => t.learnerId === child.id && t.at >= since);
    return {
      kind: "parent_history",
      title: `${child.name}'s conversations`,
      child: this.learnerCard(child),
      days,
      turns: turns.slice(-60).map((t) => ({ heard: t.heard, said: t.said, at: t.at, when: relativeDay(t.at, this.now(), this.tz), flagged: !!detectConcern(t.heard) })),
      total: turns.length,
      speech: turns.length ? `Here are ${child.name}'s last ${plural(Math.min(turns.length, 60), "conversation")} from the past ${days} days. They're on the screen.` : `${child.name} hasn't talked with me in the past ${days} days.`,
    };
  }

  // ------------------------------------------------------------------ parent mode

  private parentRecord(name: string, relation: string, childId?: string) {
    const s = this.s;
    s.parents ??= [];
    let p = s.parents.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!p) {
      p = { id: this.id("parent"), name: titleCase(name), relation, childIds: [], createdAt: this.now().toISOString() };
      s.parents.push(p);
    }
    p.relation = relation || p.relation;
    if (childId && !p.childIds.includes(childId)) p.childIds.push(childId);
    return p;
  }

  /** A parent sets up (or updates) their child. The child is greeted warmly the first time they talk. */
  parentSetup(input: SetUpInput & { parentName: string; relation: string; notes?: string[] }): Result {
    const prevActive = this.s.activeLearnerId;
    const existing = this.findLearner(input.name);
    this.setUpLearner({ ...input, role: input.role ?? (input.age !== undefined && input.age <= 8 ? "child" : existing?.role ?? "student") });
    const child = this.findLearner(input.name)!;
    const relation = titleCase(input.relation || "Parent");
    const parent = this.store.update((s) => {
      s.activeLearnerId = prevActive; // the parent is talking; don't switch the device to the child yet
      child.addedBy ??= { name: titleCase(input.parentName), relation };
      for (const n of input.notes ?? []) this.addMemory(child, n, kindFor(n), "parent", titleCase(input.parentName));
      return this.parentRecord(input.parentName, relation, child.id);
    });
    const bits = [`Thanks, ${parent.name}. I've set up ${child.name}${child.level && child.level !== "Not set" ? `, ${child.level}` : ""}${child.interests.length ? `, who loves ${listJoin(child.interests.slice(0, 2))}` : ""}.`];
    if (input.notes?.length) bits.push(`I'll keep in mind that ${lcFirst(input.notes[0].replace(/\.$/, ""))}.`);
    const exam = this.examFor(child);
    if (exam) bits.push(`${child.name}'s ${exam.title} is ${relativeDay(exam.date, this.now(), this.tz)}, so I'll plan around it.`);
    bits.push(child.metAt ? `I'll use this next time we study.` : `When ${child.name} talks to me, I'll say hi and get to know ${child.name} myself.`);
    return {
      kind: "parent_saved",
      title: `${child.name}'s profile`,
      parent: { name: parent.name, relation: parent.relation },
      child: this.learnerCard(child),
      notes: child.memories.filter((m) => m.source === "parent").map((m) => m.text),
      speaker: `${parent.name} (${parent.relation})`,
      speech: bits.join(" "),
    };
  }

  parentNote(input: { child: string; note: string; parentName?: string }): Result {
    const child = this.findLearner(input.child);
    if (!child) throw new BuddyError(`I don't know ${input.child} yet. Tell me a little about them first: their age or class, and what they love.`);
    const by = input.parentName ? titleCase(input.parentName) : child.addedBy?.name;
    this.store.update(() => this.addMemory(child, input.note, kindFor(input.note), "parent", by));
    const k = kindFor(input.note);
    return {
      kind: "parent_saved",
      title: `Noted for ${child.name}`,
      child: this.learnerCard(child),
      notes: child.memories.filter((m) => m.source === "parent").map((m) => m.text),
      speech: k === "struggle" ? `Thanks for telling me. I'll go gently with ${child.name} on that.` : `Got it, I'll remember that about ${child.name}.`,
    };
  }

  /**
   * What a parent sees, by the child's visibility: safety concerns always come first; then progress;
   * then either the full conversation history (under 13 by default) or a summary (teens by default).
   */
  parentOverview(childName: string): Result {
    const child = this.findLearner(childName);
    if (!child) throw new BuddyError(`I don't know ${childName} yet.`);
    const today = this.today();
    const map = this.masteryMap(child);
    const weekAgo = isoDate(addDays(new Date(`${today}T12:00:00Z`), -7), "UTC");
    const quizzes = this.s.quizzes.filter((q) => q.learnerId === child.id && q.results.length && isoDate(new Date(q.startedAt), this.tz) >= weekAgo);
    const answered = quizzes.flatMap((q) => q.results);
    const accuracy = answered.length ? Math.round((answered.filter((r) => r.verdict === "correct").length / answered.length) * 100) : null;
    const tricky = map.filter((m) => m.misconception || m.status === "shaky").slice(0, 3);
    const exam = this.examFor(child);
    const stories = this.s.stories.filter((x) => x.childId === child.id).length;
    const counts = { solid: map.filter((m) => m.status === "solid").length, total: map.length };
    const bits: string[] = [];
    if (!map.length && !child.minutesStudied) bits.push(`${child.name} hasn't started studying with me yet.`);
    else {
      bits.push(`${child.name} has studied about ${plural(child.minutesStudied, "minute")} with me${child.streak.current >= 2 ? `, and is on a ${child.streak.current}-day streak` : ""}.`);
      if (counts.total) bits.push(`${counts.solid} of ${plural(counts.total, "topic")} are solid${accuracy !== null ? `, with ${accuracy} percent of answers right this week` : ""}.`);
      if (tricky[0]) bits.push(`The tricky one right now is ${low(tricky[0].title)}${tricky[0].misconception ? `: ${lcFirst(tricky[0].misconception)}` : ""}.`);
    }
    if (exam) bits.push(`${exam.title} is ${relativeDay(exam.date, this.now(), this.tz)}.`);
    if (stories) bits.push(`We've also shared ${stories === 1 ? "one bedtime story" : `${stories} bedtime stories`}.`);
    const school = this.school?.summaryFor(child) ?? null;
    if (school && (school.dueSoon || school.missing)) bits.push(`From school: ${school.dueSoon} due in the next few days${school.missing ? `, and ${school.missing === 1 ? "one assignment is" : `${school.missing} assignments are`} past due` : ""}.`);
    const visibility = this.visibilityFor(child);
    const concerns = visibility === "private" ? [] : this.concernsFor(child);
    const fresh = concerns.filter((c) => c.status === "new");
    if (fresh.length) {
      bits.unshift(`Before anything else, something you should know: ${relativeDay(fresh[0].at, this.now(), this.tz)}, ${child.name} ${lcFirst(fresh[0].summary)}. It's at the top of the screen. It might be a good moment to check in with ${child.name}.`);
    }
    const turns = visibility === "private" ? [] : (this.s.turns ?? []).filter((t) => t.learnerId === child.id && t.at >= `${weekAgo}T00:00:00`);
    const moods = turns.map((t) => t.heard).filter((h) => /\b(tired|stressed|sad|happy|excited|bored|nervous)\b/i.test(h)).slice(-5);
    const topicsTalked = [...new Set([...map.filter((m) => m.status !== "new").map((m) => m.title), ...this.s.stories.filter((x) => x.childId === child.id).map((x) => `Story: ${x.lesson}`)])].slice(0, 8);
    const concernCards = concerns.slice(0, 5).map((c) => ({ category: c.category, severity: c.severity, summary: c.summary, excerpt: visibility === "full" || c.severity === "urgent" ? c.excerpt : null, when: relativeDay(c.at, this.now(), this.tz), isNew: c.status === "new" }));
    if (fresh.length) this.store.update(() => fresh.forEach((c) => (c.status = "seen")));
    return {
      kind: "parent_overview",
      title: `How ${child.name} is doing`,
      child: this.learnerCard(child),
      minutes: child.minutesStudied,
      streak: child.streak,
      accuracy,
      counts,
      mastery: map.slice(0, 8),
      tricky: tricky.map((t) => ({ title: t.title, note: t.misconception })),
      exam: exam ? { ...exam, daysLeft: daysBetween(today, exam.date) } : null,
      stories,
      parentNotes: child.memories.filter((m) => m.source === "parent").map((m) => m.text),
      learningStyle: child.memories.filter((m) => m.source === "observed").map((m) => m.text).slice(-3),
      visibility,
      school,
      concerns: concernCards,
      conversations: turns.length,
      summary: visibility === "summary" ? { topics: topicsTalked, moods } : null,
      recent: visibility === "full" ? turns.slice(-6).map((t) => ({ heard: t.heard, said: t.said, when: relativeDay(t.at, this.now(), this.tz) })) : [],
      sharedWithMe: visibility === "full" ? child.memories.filter((m) => m.source === "learner").map((m) => m.text) : [],
      transparencyNote:
        visibility === "private"
          ? `${child.name} is an adult learner, so conversations stay private.`
          : visibility === "full"
            ? `You can see everything ${child.name} says to me, and ${child.name} knows that. Safety concerns are flagged right away.`
            : `You see a summary, the default for teens, and ${child.name} knows that. Safety concerns always come to you. You can switch to full history any time.`,
      speech: bits.join(" "),
    };
  }

  remember(text: string, kind: MemoryKind | "mood" = "personal"): Result {
    const l = this.learner();
    if (kind === "mood") return this.setMood(l, text);
    this.store.update(() => this.addMemory(l, text, kind, "learner"));
    const speech =
      kind === "struggle"
        ? `Thanks for telling me. I'll keep that in mind and go at your pace.`
        : kind === "preference"
          ? `Got it. I'll teach it that way from now on.`
          : `Got it, I'll remember that.`;
    return { kind: "memory_saved", title: "Remembered", memory: l.memories[l.memories.length - 1], learner: this.learnerCard(l), speech };
  }

  /** Moods adapt today's sessions (shorter when tired or stressed) without becoming a permanent memory. */
  private setMood(l: Learner, text: string): Result {
    const t = text.toLowerCase();
    const state = /tired|sleepy|exhausted|drained/.test(t) ? "tired" : /stress|anxious|nervous|worried|panic|scared|overwhelm/.test(t) ? "stressed" : /bored|meh/.test(t) ? "bored" : /happy|excited|great|good|pumped|ready/.test(t) ? "great" : "okay";
    this.store.update(() => {
      l.mood = { state, day: this.today() };
    });
    const young = l.band === "early" || l.band === "primary";
    const speech = {
      tired: young ? `Aw, okay. Let's just do a tiny bit today. Three quick ones, then rest.` : `Thanks for telling me. We'll keep it short today, just three quick questions, and call it a win.`,
      stressed: (() => {
        // Ground the worry in the real date: "next Tuesday, 8 days away" is less scary than "soon".
        const next = l.exams.filter((e) => e.date >= this.today()).sort((a, b) => a.date.localeCompare(b.date))[0];
        const days = next ? daysBetween(this.today(), next.date) : 0;
        const when = next ? ` Your ${next.title} is ${relativeDay(next.date, this.now(), this.tz)}, ${plural(days, "day")} away.${days >= 3 ? " That's enough time if we take it step by step." : " We'll focus on what matters most."}` : "";
        return `That's okay, ${l.name}. Exams can feel like a lot.${when} Let's do one small thing at a time, and I'm right here.`;
      })(),
      bored: `Got it, let's make it more fun. Want to teach it back to me, or race through some flashcards?`,
      great: `Love that energy! Let's make the most of it.`,
      okay: `Thanks for telling me. Let's go at your pace.`,
    }[state]!;
    return { kind: "memory_saved", title: "Got it", mood: state, learner: this.learnerCard(l), speech };
  }

  profile(): Result {
    const l = this.learner();
    const told = l.memories.filter((m) => m.source === "learner");
    const observed = l.memories.filter((m) => m.source === "observed");
    const bits = [
      `Here's what I know about you, ${l.name}. You're ${l.level !== "Not set" ? l.level : GUIDES[l.band].label}${l.interests.length ? ` and you're into ${listJoin(l.interests.slice(0, 3))}` : ""}.`,
    ];
    if (told.length) bits.push(`You told me ${lcFirst(told[told.length - 1].text.replace(/^I\b/, "you").replace(/\bmy\b/g, "your"))}.`);
    if (observed.length) bits.push(`I've also noticed: ${lcFirst(observed[observed.length - 1].text)}.`);
    const lessons = (l.lessons ?? []).filter((x) => x.kind !== "name");
    if (lessons.length) bits.push(`And you've taught me ${lessons.length === 1 ? "one thing" : `${lessons.length} things`} about helping you, like: ${lcFirst(lessons[lessons.length - 1].text)}.`);
    bits.push(`You can ask me to forget anything.`);
    return {
      kind: "profile",
      title: `What I know about ${l.name}`,
      isNew: false,
      learner: this.learnerCard(l),
      memories: [...told, ...observed],
      lessons: this.lessonsOf(l),
      exams: l.exams,
      stats: { minutesStudied: l.minutesStudied, decks: this.decksOf(l).length, concepts: this.conceptsOf(l).length },
      voiceGuide: this.voiceGuide(l),
      speech: bits.join(" "),
    };
  }

  /** Study sets a delete request means: one topic ("delete the startups one"), or all of them ("delete my study plan"). */
  studySetsFor(input: { topic?: string; all?: boolean }): Deck[] {
    const l = this.learner();
    const decks = this.decksOf(l);
    if (input.all || !input.topic) return decks;
    const q = low(input.topic);
    const qk = keywords(q);
    return decks.filter((d) => low(d.title).includes(q) || q.includes(low(d.title)) || (qk.length > 0 && keywords(d.title).filter((k) => qk.includes(k)).length * 2 >= Math.max(1, keywords(d.title).length)));
  }

  /** What deleting these sets would remove, said plainly for the confirmation. */
  describeStudySets(decks: Deck[]): string {
    const topics = decks.reduce((n, d) => n + d.conceptIds.length, 0);
    return `${decks.length === 1 ? `your ${decks[0].title} study set` : `your ${decks.length} study sets (${listJoin(decks.map((d) => d.title))})`}, ${plural(topics, "topic")} and their quiz progress`;
  }

  /** Delete study sets (and the plan built from them). The profile, memories and lessons stay. */
  deleteStudySets(input: { topic?: string; all?: boolean }): Result {
    const l = this.learner();
    const decks = this.studySetsFor(input);
    if (!decks.length) {
      const have = this.decksOf(l);
      throw new BuddyError(have.length ? `I couldn't find a study set called ${input.topic}. You have ${listJoin(have.map((d) => d.title))}.` : "You don't have any study sets right now.");
    }
    const what = this.describeStudySets(decks);
    this.store.update((s) => {
      const deckIds = new Set(decks.map((d) => d.id));
      const conceptIds = new Set(s.concepts.filter((c) => deckIds.has(c.deckId)).map((c) => c.id));
      const materialIds = new Set(decks.map((d) => d.materialId).filter(Boolean) as string[]);
      s.decks = s.decks.filter((d) => !deckIds.has(d.id));
      s.concepts = s.concepts.filter((c) => !conceptIds.has(c.id));
      s.materials = s.materials.filter((m) => !materialIds.has(m.id) || s.decks.some((d) => d.materialId === m.id));
      s.mastery = s.mastery.filter((m) => !conceptIds.has(m.conceptId));
      s.quizzes = s.quizzes.filter((q) => !q.queue.some((x) => conceptIds.has(x.conceptId)));
      s.teachBacks = s.teachBacks.filter((t) => !conceptIds.has(t.conceptId));
      for (const e of l.exams) e.deckIds = e.deckIds.filter((id) => !deckIds.has(id));
      if (l.lastExplained && conceptIds.has(l.lastExplained.conceptId)) l.lastExplained = undefined;
    });
    const left = this.decksOf(l);
    return {
      kind: "study_sets_deleted",
      title: "Deleted",
      deleted: decks.map((d) => d.title),
      remaining: left.map((d) => ({ id: d.id, title: d.title, topics: d.conceptIds.length })),
      learner: this.learnerCard(l),
      speech: `Done. I deleted ${what}.${left.length ? ` You still have ${listJoin(left.map((d) => d.title))}.` : " Your profile and what I've learned about you are still here. Share new notes whenever you're ready."}`,
    };
  }

  forget(input: { memoryId?: string; text?: string; everything?: boolean }): Result {
    const l = this.learner();
    if (input.everything) {
      const name = l.name;
      this.store.update((s) => {
        s.learners = s.learners.filter((x) => x.id !== l.id);
        const deckIds = new Set(s.decks.filter((d) => d.learnerId === l.id).map((d) => d.id));
        s.decks = s.decks.filter((d) => d.learnerId !== l.id);
        s.concepts = s.concepts.filter((c) => !deckIds.has(c.deckId));
        s.materials = s.materials.filter((m) => m.learnerId !== l.id);
        s.mastery = s.mastery.filter((m) => m.learnerId !== l.id);
        s.quizzes = s.quizzes.filter((q) => q.learnerId !== l.id);
        s.teachBacks = s.teachBacks.filter((q) => q.learnerId !== l.id);
        s.focus = s.focus.filter((q) => q.learnerId !== l.id);
        if (s.activeLearnerId === l.id) s.activeLearnerId = undefined;
      });
      return { kind: "forgotten", title: "Profile deleted", speech: `Done. I've deleted everything I knew about ${name}, including notes and progress.` };
    }
    // Memories and lessons ("forget the podcast thing"): the closest match, not any shared word.
    const FILLER = /^(thing|things|stuff|one|part|bit|note|about|that|lesson|memory|remember)$/;
    const stems = (t: string) => keywords(t).filter((k) => !FILLER.test(k)).map((k) => k.slice(0, 6));
    const closeness = (text: string) => {
      if (!input.text) return 0;
      const q = low(input.text);
      if (low(text).includes(q)) return 99;
      const qk = [...new Set(stems(q))];
      const tk = new Set(stems(text));
      return qk.length ? qk.filter((k) => tk.has(k)).length / qk.length : 0;
    };
    const items = [...l.memories.map((m) => ({ id: m.id, text: m.text, lesson: false })), ...(l.lessons ?? []).map((x) => ({ id: x.id, text: x.text, lesson: true }))];
    const target = items.find((m) => m.id === input.memoryId) ?? items.map((m) => ({ m, c: closeness(m.text) })).filter((x) => x.c > 0.5).sort((a, b) => b.c - a.c)[0]?.m;
    if (!target) throw new BuddyError("I couldn't find that in what I remember. Ask me what I know about you to see everything.");
    this.store.update(() => {
      l.memories = l.memories.filter((m) => m.id !== target.id);
      l.lessons = (l.lessons ?? []).filter((m) => m.id !== target.id);
    });
    return target.lesson
      ? { kind: "forgotten", title: "Forgotten", forgotten: target.text, lessons: this.lessonsOf(l), speech: `Okay, I've dropped that one: ${lcFirst(target.text)}.` }
      : { kind: "forgotten", title: "Forgotten", forgotten: target.text, speech: `Okay, I've forgotten that ${lcFirst(target.text)}.` };
  }

  // ------------------------------------------------------------------ today

  todayBrief(prefix?: string): Result {
    const l = this.findLearner();
    if (l?.addedBy && !l.metAt) return this.meet(l);
    if (!l) {
      return {
        kind: "welcome",
        title: `Hi, I'm ${BRAND}`,
        learners: this.s.learners.map((x) => this.learnerCard(x)),
        speech: this.s.learners.length
          ? `Hi! Who's studying today? I know ${listJoin(this.s.learners.map((x) => x.name))}.`
          : `Hi! I'm ${BRAND}, your study mentor. I'll learn how you like to learn and help you get ready for your exams. What's your name, and what class or year are you in?`,
      };
    }
    const today = this.today();
    const hour = hourIn(this.now(), this.tz);
    const greet = prefix ?? `${hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening"}, ${l.name}!`;
    const concepts = this.conceptsOf(l);
    const due = concepts.filter((c) => this.mastery(l, c.id)?.history.length && isDue(this.mastery(l, c.id), today));
    const fresh = concepts.filter((c) => !this.mastery(l, c.id)?.history.length);
    const exam = this.examFor(l);
    const lastQuiz = this.s.quizzes.filter((q) => q.learnerId === l.id && q.results.length).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    const openMisconceptions = this.s.mastery
      .filter((m) => m.learnerId === l.id)
      .flatMap((m) => m.misconceptions.filter((x) => !x.resolved).map((x) => ({ ...x, conceptId: m.conceptId })))
      .sort((a, b) => b.at.localeCompare(a.at));
    const weak = openMisconceptions[0] ? this.s.concepts.find((c) => c.id === openMisconceptions[0].conceptId) : this.weakest(l, concepts);

    // What the daily routine did on its own since they last talked: say it first, once.
    const briefing = l.briefing && l.briefing.day === today && !l.briefing.seen ? l.briefing : undefined;
    if (briefing) {
      this.store.update(() => {
        l.briefing!.seen = true;
      });
    }
    const bits = [greet];
    const did = briefing?.did.map((x) => x.spoken).filter(Boolean) ?? [];
    if (did.length) bits.push(`While you were away, I ${listJoin(did)}.`);
    if (l.notice) {
      bits.push(l.notice);
      this.store.update(() => {
        l.notice = undefined;
      });
    }
    if (l.streak.current >= 2 && l.streak.lastDay && daysBetween(l.streak.lastDay, today) <= 1) bits.push(`You're on a ${l.streak.current}-day streak.`);
    if (exam) {
      const left = daysBetween(today, exam.date);
      const what = `Your ${exam.title.replace(/^(\w)/, (c) => (/^[A-Z][a-z]+ (test|exam|quiz|final|midterm)\b/.test(exam.title) ? c.toLowerCase() : c))}`;
      const when = relativeDay(exam.date, this.now(), this.tz);
      bits.push(
        left === 0
          ? `${what} is today. You've got this.`
          : left === 1
            ? `${what} is tomorrow.`
            : `${what} is ${/^(mon|tues|wednes|thurs|fri|satur|sun)day$/i.test(when) ? `on ${when}` : when}, ${NUMBER_WORDS[left] ?? left} days away.`,
      );
    }
    const school = this.school?.summaryFor(l);
    if (school?.dueSoon) bits.push(`From school: ${school.dueSoon === 1 ? "one thing is" : `${school.dueSoon} things are`} due in the next few days${school.next ? `, starting with ${lcFirst(school.next)}` : ""}.`);
    if (lastQuiz && daysBetween(isoDate(new Date(lastQuiz.startedAt), this.tz), today) >= 1 && openMisconceptions[0]) {
      // Say a short, specific mix-up as it is; a longer note stays on the card.
      const note = openMisconceptions[0].text.trim().replace(/\.$/, "");
      const short = note.split(/\s+/).length <= 10 && /^(mixed up|confused|thought|forgot|said|mistook)\b/i.test(note);
      bits.push(short ? `Last time you ${lcFirst(note)}, so let's start there.` : `${weak ? weak.title : "One topic"} tripped you up a little last time, so let's start there.`);
    } else if (due.length) bits.push(`You have ${plural(due.length, "topic")} ready for review${weak ? `, starting with ${low(weak.title)}` : ""}.`);
    else if (weak && this.mastery(l, weak.id)?.history.length) bits.push(`Let's start with ${low(weak.title)}.`);
    else if (fresh.length) bits.push(`Next up: ${low(fresh[0].title)}.`);
    else if (!concepts.length) bits.push("Share your notes or name a topic, and I'll build your study set.");
    const suggestion = !concepts.length
      ? "add_material"
      : openMisconceptions[0] || due.length
        ? "review"
        : fresh.length
          ? "learn"
          : "teach_back";
    if (concepts.length) bits.push(suggestion === "review" ? `Ready for a quick ${GUIDES[l.band].sessionMinutes > 10 ? "ten" : "five"}-minute review?` : suggestion === "learn" ? "Want me to explain it?" : "Want to try teaching one back to me?");

    return {
      kind: "today",
      title: `${l.name}'s day`,
      learner: this.learnerCard(l),
      date: spokenDate(this.now(), this.tz),
      exam: exam ? { ...exam, daysLeft: daysBetween(today, exam.date) } : null,
      dueCount: due.length,
      newCount: fresh.length,
      weakSpot: weak ? { conceptId: weak.id, title: weak.title, note: openMisconceptions[0]?.text ?? null } : null,
      lastSession: lastQuiz ? { score: lastQuiz.results.filter((r) => r.verdict === "correct").length, total: lastQuiz.results.length, when: relativeDay(lastQuiz.startedAt, this.now(), this.tz) } : null,
      suggestion,
      briefing: briefing ? { did: briefing.did.map((x) => ({ kind: x.kind, text: x.text })), today: briefing.today } : null,
      lessons: this.lessonsOf(l),
      voiceGuide: this.voiceGuide(l),
      speech: bits.join(" "),
    };
  }

  // ------------------------------------------------------------------ materials

  async addMaterial(llm: Llm | null, title: string, text: string): Promise<Result> {
    const l = this.learner();
    if (text.trim().length < 80) throw new BuddyError("That's a bit short to study from. Share a page or two of notes, or just tell me the topic.");
    const draft = await deckFromMaterial(llm, l, title, text);
    return this.saveDeck(l, draft, { title, text, kind: "upload" });
  }

  /** Study material for a specific learner (used by school sync, which may run for a learner who isn't active). */
  async addMaterialFor(llm: Llm | null, l: Learner, title: string, text: string): Promise<Result> {
    const draft = await deckFromMaterial(llm, l, title, text);
    return this.saveDeck(l, draft, { title, text, kind: "upload" });
  }

  /**
   * Go beyond the notes: research the topic on the web (with sources) and explain what we found
   * at the learner's level. Saved with the study set so it's there next time.
   */
  async research(writer: Llm | null, researcher: Llm | null, topic?: string): Promise<Result> {
    return this.researchFor(this.learner(), writer, researcher, topic);
  }

  private async researchFor(l: Learner, writer: Llm | null, researcher: Llm | null, topic?: string): Promise<Result> {
    const decks = this.decksOf(l).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const t = topic?.replace(/\b(beyond|outside) (my|the) notes\b/i, "").trim();
    const deck = t ? decks.find((d) => d.title.toLowerCase().includes(t.toLowerCase()) || t.toLowerCase().includes(d.title.toLowerCase())) ?? decks[0] : decks[0];
    const subject = t || deck?.title;
    if (!subject) throw new BuddyError("What should I look into? Name a topic, or share your notes first.");
    const fromNotes = deck ? this.conceptsOf(l, [deck.id]).map((c) => c.title) : [];
    const r = await researchTopic(researcher, writer, l, subject, fromNotes);
    const saved = { id: this.id("research"), topic: subject, title: r.title, overview: r.overview, cards: r.cards, sources: r.sources, at: this.now().toISOString() };
    if (deck) {
      this.store.update(() => {
        deck.research ??= [];
        deck.research.push(saved);
        if (deck.research.length > 10) deck.research.shift();
      });
    }
    const n = r.cards.length;
    return {
      kind: "research",
      ...saved,
      deckId: deck?.id ?? null,
      speech: `${r.overview} I found ${n} ${n === 1 ? "thing" : "things"} beyond your notes${r.sources.length ? `, from ${r.sources.length} ${r.sources.length === 1 ? "source" : "sources"}` : ""}. They're on the screen; swipe through them.`.replace(/\s+/g, " ").trim(),
    };
  }

  // ------------------------------------------------------------------ the daily routine (proactive)

  /**
   * Once a day, without being asked, for every learner: sync school, build a study set for any test
   * coming up that doesn't have one, research the nearest test's topic beyond the notes, and plan the
   * day. The next time they talk, they hear what was done ("Since yesterday").
   */
  async dailyRoutine(writer: Llm | null, researcher: Llm | null, opts: { learnerId?: string; force?: boolean } = {}): Promise<Result[]> {
    const today = this.today();
    const out: Result[] = [];
    for (const l of this.s.learners.filter((x) => !opts.learnerId || x.id === opts.learnerId)) {
      if (!opts.force && l.briefing?.day === today) continue;
      // They only just set up (they're probably still here): don't build things behind their back.
      if (!opts.force && this.now().getTime() - Date.parse(l.createdAt) < 60 * 60_000) continue;
      const did: NonNullable<Learner["briefing"]>["did"] = [];
      const step = async (what: string, fn: () => Promise<void>) => {
        try {
          await fn();
        } catch (e) {
          console.error(`[study-buddy] daily routine: ${what} for ${l.name} skipped: ${(e as Error).message}`);
        }
      };
      // 1. School: sync, and notice new tests and assignments.
      if (this.school?.connection(l)) {
        await step("school sync", async () => {
          const r = await this.school!.sync(l.name, writer);
          const exams = (r.newExams as string[]) ?? [];
          const sets = (r.studySets as string[]) ?? [];
          did.push({
            kind: "school",
            text: `Synced school${exams.length ? `: ${plural(exams.length, "new test")} (${exams.join(", ")})` : ", nothing new"}${sets.length ? `, and turned teacher notes into ${plural(sets.length, "study set")}` : ""}`,
            spoken: exams.length ? `synced your school and found ${plural(exams.length, "new test")}` : "synced your school",
          });
        });
      }
      // 2. Upcoming tests without a study set: link one they already have, or build one.
      for (const exam of l.exams.filter((e) => daysBetween(today, e.date) >= 0 && daysBetween(today, e.date) <= 10 && !e.deckIds.length)) {
        const have = this.decksOf(l).filter((d) => examMatchesDeck(exam, d));
        if (have.length) {
          this.store.update(() => {
            exam.deckIds.push(...have.map((d) => d.id));
          });
          continue;
        }
        await step(`study set for ${exam.title}`, async () => {
          const topic = examTopic(exam);
          const draft = await deckFromTopic(writer, l, topic, 5);
          const r = this.saveDeck(l, draft, { title: exam.title, text: exam.title, kind: "topic" });
          const deckId = (r.deck as { id: string }).id;
          this.store.update(() => {
            if (!exam.deckIds.includes(deckId)) exam.deckIds.push(deckId);
          });
          did.push({ kind: "study_set", text: `Made a study set for your ${exam.title} (${plural((r.concepts as unknown[]).length, "topic")})`, spoken: `made a study set for your ${exam.title}` });
        });
      }
      // 3. Research the nearest test's topic (or the latest study set) beyond the notes, every few days.
      const exam = this.examFor(l);
      const decks = this.decksOf(l).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const focus = (exam && decks.find((d) => exam.deckIds.includes(d.id))) ?? decks[0];
      const lastResearch = focus?.research?.at(-1);
      if (focus && researcher?.research && (!lastResearch || daysBetween(isoDate(new Date(lastResearch.at), this.tz), today) >= 3)) {
        await step(`research on ${focus.title}`, async () => {
          const r = await this.researchFor(l, writer, researcher, focus.title);
          did.push({ kind: "research", text: `Researched ${focus.title} beyond the notes: ${plural((r.cards as unknown[]).length, "new thing")}, with sources`, spoken: `found ${plural((r.cards as unknown[]).length, "new thing")} about ${low(focus.title)}` });
        });
      }
      // 4. Plan the day.
      const concepts = this.conceptsOf(l);
      const due = concepts.filter((c) => this.mastery(l, c.id)?.history.length && isDue(this.mastery(l, c.id), today));
      const weak = this.weakest(l, concepts);
      const todayText = due.length ? `${plural(due.length, "topic")} to review${weak ? `, starting with ${low(weak.title)}` : ""}` : weak ? `Start with ${low(weak.title)}` : concepts.length ? "A quick quiz to keep things fresh" : "Share notes or name a topic to get started";
      did.push({ kind: "plan", text: `Planned today: ${todayText}`, spoken: "" });
      const briefing = { day: today, at: this.now().toISOString(), did, today: todayText };
      this.store.update(() => {
        l.briefing = briefing;
      });
      out.push(this.briefingResult(l));
    }
    return out;
  }

  private briefingResult(l: Learner): Result {
    const b = l.briefing!;
    const spoken = b.did.map((x) => x.spoken).filter(Boolean);
    return {
      kind: "briefing",
      title: "Since yesterday",
      learner: this.learnerCard(l),
      did: b.did.map((x) => ({ kind: x.kind, text: x.text })),
      today: b.today,
      speech: `${spoken.length ? `While you were away, I ${listJoin(spoken)}. ` : ""}Today: ${lcFirst(b.today)}.`,
    };
  }

  /** "Prepare my day": run the routine now for the current learner. */
  async prepareMyDay(writer: Llm | null, researcher: Llm | null): Promise<Result> {
    const l = this.learner();
    const [r] = await this.dailyRoutine(writer, researcher, { learnerId: l.id, force: true });
    this.store.update(() => {
      if (l.briefing) l.briefing.seen = true;
    });
    return r;
  }

  async addTopic(llm: Llm | null, topic: string): Promise<Result> {
    const l = this.learner();
    const draft = await deckFromTopic(llm, l, topic);
    return this.saveDeck(l, draft, { title: topic, text: topic, kind: "topic" });
  }

  private saveDeck(l: Learner, draft: DeckDraft, m: { title: string; text: string; kind: "upload" | "topic" }): Result {
    const existing = this.decksOf(l).find((d) => low(d.title) === low(draft.title));
    if (existing) {
      const concepts = this.s.concepts.filter((c) => c.deckId === existing.id);
      return this.deckResult(l, existing, concepts, `You already have ${low(existing.title)} in your study set: ${plural(concepts.length, "topic")}.`, false);
    }
    const { deck, concepts } = this.store.update((s) => {
      const material = { id: this.id("mat"), learnerId: l.id, title: m.title, kind: m.kind, text: m.text, addedAt: this.now().toISOString() };
      s.materials.push(material);
      const deck: Deck = { id: this.id("deck"), learnerId: l.id, title: draft.title, subject: titleCase(draft.subject || "General"), materialId: material.id, conceptIds: [], createdAt: this.now().toISOString() };
      const concepts: Concept[] = draft.concepts.map((c) => {
        const id = this.id("c");
        return {
          ...c,
          id,
          deckId: deck.id,
          flashcards: c.flashcards.map((f, i) => ({ ...f, id: `${id}-f${i}` })),
          questions: c.questions.map((q, i) => ({ ...q, id: `${id}-q${i}` })),
        };
      });
      deck.conceptIds = concepts.map((c) => c.id);
      s.decks.push(deck);
      s.concepts.push(...concepts);
      // Link to an upcoming exam in the same subject ("Biology exam" <-> a Biology study set).
      for (const e of l.exams) if (examMatchesDeck(e, deck) && !e.deckIds.includes(deck.id)) e.deckIds.push(deck.id);
      if (!l.subjects.includes(deck.subject) && deck.subject !== "General") l.subjects.push(deck.subject);
      return { deck, concepts };
    });
    const exam = l.exams.find((e) => e.deckIds.includes(deck.id) && e.date >= this.today());
    const speech = `${m.kind === "upload" ? "Got your notes! " : ""}I've turned ${m.kind === "upload" ? "them" : "that"} into ${plural(concepts.length, "topic")} on ${low(deck.title)}: ${listJoin(concepts.slice(0, 3).map((c) => low(c.title)))}${concepts.length > 3 ? ", and more" : ""}.${draft.truncated ? " It was a long document, so I used the first part. Share the rest separately if you need it." : ""}${exam ? ` I've linked it to your ${exam.title}.` : ""} Want me to explain the first one, or jump straight into a quiz?`;
    return this.deckResult(l, deck, concepts, speech, true, draft.source);
  }

  private deckResult(l: Learner, deck: Deck, concepts: Concept[], speech: string, isNew: boolean, source?: string): Result {
    const today = this.today();
    return {
      kind: "deck",
      title: deck.title,
      isNew,
      source: source ?? null,
      deck: { id: deck.id, title: deck.title, subject: deck.subject },
      concepts: concepts.map((c) => ({ id: c.id, title: c.title, summary: c.summary, status: statusFor(this.mastery(l, c.id), today) })),
      speech,
    };
  }

  // ------------------------------------------------------------------ explain

  /** Spoken lead-in, so an explanation sounds like a person starting to talk rather than a card being read. */
  private explainOpener(l: Learner, style: ExplainStyle, asked: boolean, source: string): string {
    if (source === "llm") return ""; // the model already writes conversationally
    const young = l.band === "early" || l.band === "primary";
    if (asked && style === "simpler") return young ? "Okay, let's make it super simple." : "No worries, let's make it simpler.";
    if (asked) return pick(["Sure, let's try it another way.", "Okay, different angle.", "Alright, let me put it another way."], l.name.length);
    if (style === "analogy") return young ? `Ooh, I love this one, ${l.name}. Imagine this.` : pick([`Okay ${l.name}, picture this.`, `Alright, here's how I'd think about it.`, `So, imagine this.`], l.name.length + l.interests.length);
    return pick([`Okay, so here's the idea.`, `Alright ${l.name}, here's the gist.`], l.name.length);
  }

  /** Study sets for new topics that are still being written in the background (see explainConcept). */
  private building = new Set<Promise<void>>();
  private async settled() {
    if (this.building.size) await Promise.allSettled([...this.building]);
  }

  async explainConcept(llm: Llm | null, input: { concept?: string; style?: ExplainStyle; request?: string }): Promise<Result> {
    // Only wait for a topic still being written if they mean the one we were just talking about.
    if (!input.concept || this.learner().lastExplained?.conceptId.startsWith("pending:")) {
      const pending = this.learner().lastExplained?.conceptId.slice(8) ?? "";
      if (!input.concept || low(input.concept) === low(pending)) await this.settled();
    }
    const l = this.learner();
    const recent = l.lastExplained?.at && this.now().getTime() - Date.parse(l.lastExplained.at) < 30 * 60_000 ? this.s.concepts.find((c) => c.id === l.lastExplained!.conceptId) : undefined;
    // "Another example?" with no topic named: the thing we were just talking about.
    let concept = input.concept ? this.resolveConcept(l, input.concept, true) : (recent ?? this.resolveConcept(l));
    const style: ExplainStyle = input.style ?? (l.stylesThatWorked[0] ?? (l.interests.length ? "analogy" : "example"));
    if (!concept && input.concept && llm) {
      // Curiosity mode: learning anything, not just exam material. Answer now; the topic's study set
      // (for quizzing later) is written in the background.
      const topic = input.concept;
      const job = deckFromTopic(llm, l, topic, 2)
        .then((draft) => {
          this.saveDeck(l, draft, { title: topic, text: topic, kind: "topic" });
          const c = this.resolveConcept(l, topic) ?? this.conceptsOf(l).slice(-1)[0];
          this.store.update(() => {
            if (l.lastExplained?.conceptId === `pending:${topic}`) l.lastExplained.conceptId = c.id;
          });
        })
        .catch((e) => console.error(`[study-buddy] couldn't build a study set for "${topic}":`, (e as Error).message))
        .finally(() => this.building.delete(job));
      this.building.add(job);
      const stub = { id: "", deckId: "", title: titleCase(topic), summary: topic, keyPoints: [], flashcards: [], questions: [] } as unknown as Concept;
      const ex = await explain(llm, l, stub, style, [], undefined, input.request);
      this.store.update(() => {
        l.lastExplained = { conceptId: `pending:${topic}`, style, text: ex.explanation.slice(0, 800), at: this.now().toISOString() };
      });
      return this.explanationResult(l, stub, style, ex, [], input.style !== undefined);
    }
    if (!concept && input.concept) {
      const draft = await deckFromTopic(llm, l, input.concept, 1);
      this.saveDeck(l, draft, { title: input.concept, text: input.concept, kind: "topic" });
      concept = this.resolveConcept(l, input.concept) ?? this.conceptsOf(l).slice(-1)[0];
    }
    if (!concept) throw new BuddyError("Tell me what you'd like explained, or share your notes first.");
    const m = this.mastery(l, concept.id);
    const misconceptions = (m?.misconceptions ?? []).filter((x) => !x.resolved).map((x) => x.text);
    // Explaining the same thing again ("huh?", "simpler please"): tell the model what didn't land.
    const prev = l.lastExplained?.conceptId === concept.id && l.lastExplained.at && this.now().getTime() - Date.parse(l.lastExplained.at) < 30 * 60_000 ? l.lastExplained.text : undefined;
    const ex = await explain(llm, l, concept, style, misconceptions, prev, input.request);
    this.store.update(() => {
      l.lastExplained = { conceptId: concept!.id, style, text: ex.explanation.slice(0, 800), at: this.now().toISOString() };
    });
    return this.explanationResult(l, concept, style, ex, misconceptions, input.style !== undefined);
  }

  private explanationResult(l: Learner, concept: Concept, style: ExplainStyle, ex: Awaited<ReturnType<typeof explain>>, misconceptions: string[], asked: boolean): Result {
    return {
      kind: "explanation",
      title: concept.title,
      conceptId: concept.id || null,
      style,
      analogy: ex.analogy ?? null,
      explanation: ex.explanation,
      keyPoints: concept.keyPoints,
      checkQuestion: ex.checkQuestion,
      misconception: misconceptions[0] ?? null,
      learner: this.learnerCard(l),
      speech: `${this.explainOpener(l, style, asked, ex.source)} ${ex.explanation} ${ex.checkQuestion ? `${pick(["", "So,", "Quick one:", "Let me check:"], l.name.length + concept.title.length + (l.stylesThatWorked.length + 1) * this.s.seq)} ${ex.checkQuestion}` : ""}`.replace(/\s+/g, " ").trim(),
    };
  }

  // ------------------------------------------------------------------ quiz & flashcards

  async startQuiz(input: { topic?: string; mode?: "quiz" | "flashcards"; count?: number; fresh?: boolean }, llm: Llm | null = null): Promise<Result> {
    await this.settled();
    const l = this.learner();
    const mode = input.mode ?? "quiz";
    const today = this.today();
    let pool = this.conceptsOf(l);
    if (!pool.length) throw new BuddyError("We need something to study first. Share your notes or tell me a topic.");
    let title = "Review";
    if (input.topic) {
      const deck = this.decksOf(l).find((d) => low(d.title).includes(input.topic!.toLowerCase()) || input.topic!.toLowerCase().includes(low(d.title)));
      if (deck) {
        pool = pool.filter((c) => c.deckId === deck.id);
        title = deck.title;
      } else {
        const c = this.resolveConcept(l, input.topic, true);
        if (c) {
          pool = [c];
          title = c.title;
        } else if (llm) {
          // Something they haven't studied with me yet: write a short set on it first.
          const made = this.saveDeck(l, await deckFromTopic(llm, l, input.topic, 3), { title: input.topic, text: input.topic, kind: "topic" });
          const deckId = (made.deck as { id: string }).id;
          pool = this.s.concepts.filter((x) => x.deckId === deckId);
          title = this.s.decks.find((d) => d.id === deckId)?.title ?? input.topic;
        }
      }
    }
    const mood = this.moodToday(l);
    const gentle = mood === "tired" || mood === "stressed";
    const count = Math.max(1, Math.min(10, input.count ?? (gentle ? 3 : Math.min(6, Math.max(3, Math.round(GUIDES[l.band].sessionMinutes / 4))))));
    // Priority: open misconceptions, due & weak, then new, then the rest.
    const score = (c: Concept) => {
      const m = this.mastery(l, c.id);
      if (m?.misconceptions.some((x) => !x.resolved)) return 0;
      if (m?.history.length && isDue(m, today)) return 1 + strength(m, today);
      if (!m?.history.length) return 3;
      return 4 + strength(m, today);
    };
    const ordered = [...pool].sort((a, b) => score(a) - score(b));
    // Don't repeat yesterday's quiz: skip questions from their recent quizzes, and when a topic has
    // run out (or they ask for new ones), have the model write fresh questions for it.
    const recent = new Set(
      this.s.quizzes
        .filter((q) => q.learnerId === l.id)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, 4)
        .flatMap((q) => q.queue.map((x) => x.questionId).filter(Boolean) as string[]),
    );
    if (mode === "quiz") {
      const targets = ordered.slice(0, Math.min(count, ordered.length));
      // How many questions each topic has to supply for this quiz; top up any that would run short.
      const perTopic = Math.ceil(count / Math.max(1, targets.length));
      const unaskedIn = (c: Concept) => c.questions.filter((q) => !recent.has(q.id)).length;
      const needFresh = targets.filter((c) => input.fresh || unaskedIn(c) < perTopic);
      // Written in parallel, so "new questions" doesn't keep them waiting.
      const made = await Promise.all(needFresh.slice(0, 4).map((c) => freshQuestions(llm, l, c, input.fresh ? Math.max(3, perTopic) : Math.max(2, perTopic - unaskedIn(c) + 1))));
      needFresh.slice(0, 4).forEach((c, k) => {
        if (!made[k].length) return;
        this.store.update(() => {
          const start = c.questions.length;
          c.questions.push(...made[k].map((q, i) => ({ ...q, id: `${c.id}-q${start + i}-${this.s.seq + 1}` })));
          this.s.seq += 1;
        });
      });
    }
    const queue: QuizItem[] = [];
    let round = 0;
    while (queue.length < count && round < 4) {
      for (const c of ordered) {
        if (queue.length >= count) break;
        if (mode === "flashcards") {
          const f = c.flashcards[round % Math.max(1, c.flashcards.length)];
          if (f && !queue.some((q) => q.flashcardId === f.id)) queue.push({ conceptId: c.id, flashcardId: f.id });
        } else {
          // Newest unasked first, then unasked, then (only if nothing else) the least recent.
          const unasked = c.questions.filter((q) => !recent.has(q.id) && !queue.some((x) => x.questionId === q.id));
          const pick = input.fresh ? unasked[unasked.length - 1] : unasked[0];
          const prior = this.mastery(l, c.id)?.history.length ?? 0;
          const q = pick ?? c.questions[(prior + round) % Math.max(1, c.questions.length)];
          if (q && !queue.some((x) => x.questionId === q.id)) queue.push({ conceptId: c.id, questionId: q.id });
        }
      }
      round++;
    }
    const session: QuizSession = {
      id: this.id("quiz"),
      learnerId: l.id,
      mode,
      title,
      queue,
      index: 0,
      hintsUsed: 0,
      revealed: false,
      results: [],
      startedAt: this.now().toISOString(),
    };
    this.store.update((s) => {
      for (const q of s.quizzes) if (q.learnerId === l.id && !q.endedAt) q.endedAt = this.now().toISOString();
      s.quizzes.push(session);
    });
    const intro =
      mode === "flashcards"
        ? `Flashcards${title === "Review" ? "" : ` on ${low(title)}`}. Say the answer, or say "flip" to see it.`
        : gentle
          ? `Just ${plural(queue.length, "easy question")}, nice and relaxed. Answer however you like.`
          : `Let's do ${plural(queue.length, "question")}${title === "Review" ? ", starting with what you need most" : ` on ${low(title)}`}. Answer in your own words. You can say "hint" or "skip".`;
    return this.questionResult(l, session, intro);
  }

  private activeQuiz(l: Learner): QuizSession {
    const q = this.s.quizzes.filter((x) => x.learnerId === l.id && !x.endedAt).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    if (!q) throw new BuddyError("We're not in a quiz right now. Say 'quiz me' to start one.");
    return q;
  }

  private current(session: QuizSession) {
    const item = session.queue[session.index];
    const concept = this.s.concepts.find((c) => c.id === item.conceptId)!;
    const question = item.questionId ? concept.questions.find((q) => q.id === item.questionId) : undefined;
    const card = item.flashcardId ? concept.flashcards.find((f) => f.id === item.flashcardId) : undefined;
    return { item, concept, question, card };
  }

  private spokenQuestion(q: Question): string {
    if (q.type === "mcq" && q.options) {
      // Long options read better lettered: "A, the reaction is endothermic. B, ..."
      if (q.options.some((o) => o.split(/\s+/).length > 3)) return `${q.prompt} ${q.options.map((o, i) => `${i === q.options!.length - 1 ? "Or " : ""}${"ABCD"[i]}, ${o.replace(/[.?!]+$/, "")}.`).join(" ")}`;
      return `${q.prompt} Is it ${listJoin(q.options).replace(/, and /, ", or ").replace(/ and ([^,]+)$/, " or $1")}?`;
    }
    return q.prompt;
  }

  private questionResult(l: Learner, session: QuizSession, prefix = "", feedback?: Record<string, unknown>): Result {
    const { concept, question, card } = this.current(session);
    const n = session.index + 1;
    const total = session.queue.length;
    const lead = n === 1 ? (total > 1 ? "First one." : "Here's your question.") : n === total ? "Last one." : pick(["Next one.", "Okay, next.", "Here's another."], n);
    const ask = card ? `${n === 1 ? "First card." : n === total ? "Last card." : "Next card."} ${card.front}` : `${lead} ${this.spokenQuestion(question!)}`;
    return {
      kind: "quiz_question",
      title: session.title,
      sessionId: session.id,
      mode: session.mode,
      number: n,
      total,
      concept: { id: concept.id, title: concept.title },
      question: question ? { type: question.type, prompt: question.prompt, options: question.options ?? null } : null,
      flashcard: card ? { front: card.front, back: session.revealed ? card.back : null } : null,
      feedback: feedback ?? null,
      score: { correct: session.results.filter((r) => r.verdict === "correct").length, answered: session.results.length },
      results: session.results.map((r) => r.verdict),
      speech: `${prefix ? `${prefix} ` : ""}${ask}`,
    };
  }

  async answer(llm: Llm | null, answerText: string): Promise<Result> {
    const l = this.learner();
    const session = this.activeQuiz(l);
    const { concept, question, card } = this.current(session);
    let g: { score: number; verdict: "correct" | "partial" | "incorrect"; feedback: string; misconception?: string };
    if (card) {
      if (session.revealed) {
        const knew = /\b(yes|yeah|yep|got it|knew it|i knew|correct|right)\b/i.test(answerText) && !/\b(no|didn'?t|did not|missed)\b/i.test(answerText);
        g = { score: knew ? 0.8 : 0.2, verdict: knew ? "correct" : "incorrect", feedback: knew ? "Great, marking that one as known." : "No worries, I'll bring it back soon." };
      } else {
        g = await grade(llm, l, concept, { id: "fc", type: "short", prompt: card.front, answer: card.back, explanation: card.back }, answerText);
      }
    } else {
      g = await grade(llm, l, concept, question!, answerText);
    }
    if (session.hintsUsed > 0 && g.score > 0.6) g.score = Math.max(0.6, g.score - 0.15 * session.hintsUsed);
    return this.recordAndAdvance(l, session, concept, g, card ? "flashcard" : "quiz", { answer: answerText, questionId: question?.id });
  }

  private recordAndAdvance(
    l: Learner,
    session: QuizSession,
    concept: Concept,
    g: { score: number; verdict: "correct" | "partial" | "incorrect"; feedback: string; misconception?: string },
    mode: "quiz" | "flashcard",
    given?: { answer: string; questionId?: string },
  ): Result {
    const today = this.today();
    let observed: string | undefined;
    let resolvedOld: string | undefined;
    this.store.update((s) => {
      let m = this.mastery(l, concept.id);
      if (!m) {
        m = newMastery(l.id, concept.id, today);
        s.mastery.push(m);
      }
      m.history.push({ at: this.now().toISOString(), score: g.score, mode });
      review(m, g.score, today, this.examFor(l, concept.id)?.date);
      if (g.misconception && g.verdict !== "correct") {
        m.misconceptions.push({ text: g.misconception, at: this.now().toISOString() });
      } else if (g.verdict === "correct") {
        const open = m.misconceptions.find((x) => !x.resolved);
        if (open) {
          open.resolved = true;
          resolvedOld = open.text;
        }
      }
      // Learn which explanation style works: a correct answer right after an explanation.
      const last = l.lastExplained;
      if (last && last.conceptId === concept.id && g.verdict === "correct") {
        if (!l.stylesThatWorked.includes(last.style)) l.stylesThatWorked.unshift(last.style);
        const interest = l.interests[0];
        observed = last.style === "analogy" && interest ? `${titleCase(interest)} analogies help ${l.name} understand` : `${l.name} learns well with ${last.style.replace("_", "-")} explanations`;
        this.addMemory(l, observed, "strength", "observed");
        l.lastExplained = undefined;
      }
      if (g.verdict !== "correct" && m.lapses >= 2) this.addMemory(l, `Finds ${low(concept.title)} tricky`, "struggle", "observed");
      session.results.push({ conceptId: concept.id, score: g.score, verdict: g.verdict, misconception: g.misconception, answer: given?.answer.slice(0, 500), questionId: given?.questionId });
      session.index += 1;
      session.hintsUsed = 0;
      session.revealed = false;
      this.touchStreak(l);
      l.minutesStudied += 1;
    });

    const seed = session.results.length + l.name.length;
    const head =
      g.verdict === "correct"
        ? `${pick(PRAISE[l.band], seed)}${seed % 3 === 0 ? ` Nice, ${l.name}.` : ""}${resolvedOld ? " And you've fixed the mix-up from last time." : ""}`
        : g.verdict === "partial"
          ? pick(["Close!", "Almost!", "So close."], seed)
          : pick(["Not quite.", "Hmm, not quite.", "Ooh, close, but no."], seed);
    const fb = g.verdict === "correct" && resolvedOld ? "" : g.feedback;
    const misNote = g.misconception && g.verdict !== "correct" ? " I'll bring this one back tomorrow." : "";
    const feedback = { verdict: g.verdict, text: `${head} ${fb}`.trim(), misconception: g.verdict !== "correct" ? g.misconception ?? null : null, concept: concept.title };
    const said = `${head} ${fb}${misNote}`.replace(/\s+/g, " ").trim();

    if (session.index >= session.queue.length) return this.finishQuiz(l, session, said, feedback);
    return this.questionResult(l, session, said, feedback);
  }

  private finishQuiz(l: Learner, session: QuizSession, lead: string, feedback?: Record<string, unknown>): Result {
    const today = this.today();
    this.store.update(() => {
      session.endedAt = this.now().toISOString();
    });
    const correct = session.results.filter((r) => r.verdict === "correct").length;
    const total = session.results.length;
    const weak = [...new Set(session.results.filter((r) => r.verdict !== "correct").map((r) => r.conceptId))].map((id) => this.s.concepts.find((c) => c.id === id)!).filter(Boolean);
    const ratio = total ? correct / total : 0;
    const verdict = !total
      ? "No problem, we can pick it up later."
      : ratio === 1 ? (l.band === "early" || l.band === "primary" ? "A perfect score! You're a superstar." : "A perfect round.") : ratio >= 0.7 ? "Strong round." : ratio >= 0.4 ? "Good effort, and now we know what to work on." : "That was a tough one, and that's exactly why we practice.";
    const next = weak.length ? ` Your focus for next time: ${listJoin(weak.slice(0, 2).map((c) => low(c.title)))}. I'll schedule it before your exam.` : "";
    const streak = l.streak.current >= 2 ? ` That's ${l.streak.current} days in a row.` : "";
    return {
      kind: "quiz_summary",
      title: `${session.title}: ${correct} of ${total}`,
      sessionId: session.id,
      correct,
      total,
      feedback: feedback ?? null,
      weak: weak.map((c) => ({ id: c.id, title: c.title })),
      streak: l.streak,
      mastery: this.masteryMap(l, undefined).slice(0, 8),
      // One or two answers isn't a "round": no score report, just a friendly stop.
      speech: (total < 3 ? `${lead} ${total ? "We'll pick it up next time." : verdict}` : `${lead} That's ${correct} out of ${total}. ${verdict}${next}${streak}`).replace(/\s+/g, " ").trim(),
      today,
    };
  }

  quizAction(action: "hint" | "skip" | "repeat" | "flip" | "end"): Result {
    const l = this.learner();
    const session = this.activeQuiz(l);
    const { concept, question, card } = this.current(session);
    switch (action) {
      case "repeat":
        return this.questionResult(l, session);
      case "hint": {
        session.hintsUsed += 1;
        this.store.update(() => {});
        const answer = card?.back ?? question!.answer;
        const hint =
          session.hintsUsed === 1
            ? `Think about this: ${lcFirst(concept.keyPoints[0] ?? concept.summary)}`
            : question?.type === "mcq"
              ? `It starts with "${answer.slice(0, 3)}".`
              : `The answer has to do with ${listJoin(keywords(answer).slice(0, 2))}.`;
        return { ...this.questionResult(l, session), kind: "quiz_question", hint, speech: `Here's a hint. ${hint}` };
      }
      case "flip": {
        if (!card) return { ...this.questionResult(l, session), speech: `The answer is: ${question!.answer}. Let's move on.` };
        this.store.update(() => {
          session.revealed = true;
        });
        return { ...this.questionResult(l, session), speech: `The answer: ${card.back} Did you know it?` };
      }
      case "skip":
        return this.recordAndAdvance(l, session, concept, { score: 0.2, verdict: "incorrect", feedback: `The answer was: ${card?.back ?? question!.answer}` }, card ? "flashcard" : "quiz");
      case "end":
        return this.finishQuiz(l, session, "Okay, let's stop there.");
    }
  }

  // ------------------------------------------------------------------ study together (group quiz battle)

  startGroupQuiz(input: { players: string[]; topic?: string; turnsEach?: number; includeMe?: boolean }): Result {
    const host = this.findLearner();
    const names = [...new Set(input.players.map((n) => n.trim()).filter(Boolean).map(titleCase))];
    if (host && input.includeMe !== false && !names.some((n) => n.toLowerCase() === host.name.toLowerCase())) names.unshift(host.name);
    if (names.length < 2) throw new BuddyError("Study Together needs at least two players. Who's playing?");
    if (names.length > 6) throw new BuddyError("Let's keep it to six players or fewer.");
    const players: GroupPlayer[] = names.map((n) => {
      const l = this.findLearner(n);
      return { name: l?.name ?? n, learnerId: l?.id, band: l?.band ?? host?.band ?? "high", score: 0, streak: 0, bestStreak: 0, answered: 0, correct: 0 };
    });
    // Questions come from the host's study sets (or any player's), optionally narrowed to a topic.
    const owners = [host, ...players.map((p) => (p.learnerId ? this.s.learners.find((l) => l.id === p.learnerId) : undefined))].filter((x): x is Learner => !!x);
    let decks = owners.flatMap((o) => this.decksOf(o));
    let title = "Study Together";
    if (input.topic) {
      const hit = decks.filter((d) => d.title.toLowerCase().includes(input.topic!.toLowerCase()) || input.topic!.toLowerCase().includes(d.title.toLowerCase()));
      if (hit.length) {
        decks = hit;
        title = `${hit[0].title} battle`;
      }
    }
    decks = decks.filter((d, i) => decks.findIndex((x) => x.id === d.id) === i);
    if (!decks.length) throw new BuddyError("We need something to quiz on first. Share some notes or pick a topic, then we can play.");
    const game: GroupQuiz = {
      id: this.id("group"),
      title,
      deckIds: decks.map((d) => d.id),
      players,
      turnsEach: Math.max(1, Math.min(5, input.turnsEach ?? 3)),
      turn: 0,
      asked: [],
      hintsUsed: 0,
      startedAt: this.now().toISOString(),
    };
    this.pickGroupQuestion(game);
    this.store.update((s) => {
      s.groupQuizzes ??= [];
      for (const g of s.groupQuizzes) if (!g.endedAt) g.endedAt = this.now().toISOString();
      s.groupQuizzes.push(game);
    });
    const guests = players.filter((p) => !p.learnerId).map((p) => p.name);
    const intro = `Study Together! ${listJoin(players.map((p) => p.name))}, ${game.turnsEach} ${game.turnsEach === 1 ? "question" : "questions"} each. Two points for a right answer, one for close, and a bonus for streaks.${guests.length ? ` Welcome, ${listJoin(guests)}! You're playing as ${guests.length === 1 ? "a guest" : "guests"}, so I won't save anything about you.` : ""}`;
    return this.groupQuestionResult(game, intro);
  }

  /** Concepts for an online game: this learner's study sets, optionally narrowed to a topic. */
  conceptsForGame(l: Learner, topic?: string): { concepts: Concept[]; title: string } {
    let decks = this.decksOf(l);
    let title = "Study Together online";
    if (topic) {
      const hit = decks.filter((d) => d.title.toLowerCase().includes(topic.toLowerCase()) || topic.toLowerCase().includes(d.title.toLowerCase()));
      if (hit.length) {
        decks = hit;
        title = `${hit[0].title} battle`;
      }
    }
    return { concepts: this.conceptsOf(l, decks.map((d) => d.id)), title };
  }

  private groupPool(game: GroupQuiz): Concept[] {
    const ids = new Set(game.deckIds);
    return this.s.concepts.filter((c) => ids.has(c.deckId));
  }

  /** Each player gets a question pitched at them: younger players get true/false and multiple choice. */
  private pickGroupQuestion(game: GroupQuiz) {
    const player = game.players[game.turn % game.players.length];
    const prefer: Question["type"][] =
      player.band === "early" || player.band === "primary" ? ["truefalse", "mcq"] : player.band === "middle" ? ["mcq", "truefalse", "short"] : ["short", "mcq", "truefalse"];
    const pool = this.groupPool(game);
    const usage = (c: Concept) => game.asked.filter((q) => c.questions.some((x) => x.id === q)).length;
    const concepts = [...pool].sort((a, b) => usage(a) - usage(b));
    for (const type of prefer) {
      for (const c of concepts) {
        const q = c.questions.find((x) => x.type === type && !game.asked.includes(x.id));
        if (q) {
          game.current = { conceptId: c.id, questionId: q.id };
          game.asked.push(q.id);
          return;
        }
      }
    }
    // Everything has been asked: start reusing.
    const c = concepts[0];
    const q = c.questions.find((x) => prefer.includes(x.type)) ?? c.questions[0];
    game.current = { conceptId: c.id, questionId: q.id };
  }

  private activeGroup(): GroupQuiz {
    const g = (this.s.groupQuizzes ?? []).filter((x) => !x.endedAt).slice(-1)[0];
    if (!g) throw new BuddyError("There's no game going right now. Say 'let's play a quiz with' and the names.");
    return g;
  }

  private groupQuestionResult(game: GroupQuiz, prefix = "", feedback?: Record<string, unknown>): Result {
    const player = game.players[game.turn % game.players.length];
    const concept = this.s.concepts.find((c) => c.id === game.current!.conceptId)!;
    const q = concept.questions.find((x) => x.id === game.current!.questionId)!;
    const total = game.players.length * game.turnsEach;
    const young = player.band === "early" || player.band === "primary";
    const call = game.turn === total - 1 ? `Final question! ${player.name}, it's all yours.` : pick([`${player.name}, your turn!`, `Over to you, ${player.name}.`, `${player.name}, you're up!`], game.turn);
    return {
      kind: "group_question",
      title: game.title,
      gameId: game.id,
      turn: game.turn + 1,
      totalTurns: total,
      currentPlayer: player.name,
      players: this.scoreboard(game),
      concept: { id: concept.id, title: concept.title },
      question: { type: q.type, prompt: q.prompt, options: q.options ?? null },
      feedback: feedback ?? null,
      speech: `${prefix ? `${prefix} ` : ""}${call} ${young && q.type === "truefalse" ? q.prompt : this.spokenQuestion(q)}`.replace(/\s+/g, " ").trim(),
    };
  }

  private scoreboard(game: GroupQuiz) {
    const current = game.players[game.turn % game.players.length]?.name;
    return game.players.map((p) => ({ name: p.name, score: p.score, streak: p.streak, guest: !p.learnerId, current: p.name === current && !game.endedAt }));
  }

  async groupAnswer(llm: Llm | null, answerText: string): Promise<Result> {
    const game = this.activeGroup();
    const player = game.players[game.turn % game.players.length];
    const concept = this.s.concepts.find((c) => c.id === game.current!.conceptId)!;
    const q = concept.questions.find((x) => x.id === game.current!.questionId)!;
    const learner = player.learnerId ? this.s.learners.find((l) => l.id === player.learnerId) : undefined;
    const graderView: Learner = learner ?? { id: "guest", name: player.name, role: "student", level: "", band: player.band, subjects: [], interests: [], stylesThatWorked: [], memories: [], exams: [], streak: { current: 0, best: 0 }, minutesStudied: 0, createdAt: "" };
    const g = await grade(llm, graderView, concept, q, answerText);
    let points = g.verdict === "correct" ? 2 : g.verdict === "partial" ? 1 : 0;
    if (game.hintsUsed && points === 2) points = 1;
    this.store.update((s) => {
      player.answered += 1;
      if (g.verdict === "correct") {
        player.correct += 1;
        player.streak += 1;
        if (player.streak >= 2) points += 1; // streak bonus
        player.bestStreak = Math.max(player.bestStreak, player.streak);
      } else player.streak = 0;
      player.score += points;
      // Registered players learn from the game too: their own review schedule and mistakes update.
      if (learner) {
        let m = this.mastery(learner, concept.id);
        if (!m) {
          m = newMastery(learner.id, concept.id, this.today());
          s.mastery.push(m);
        }
        m.history.push({ at: this.now().toISOString(), score: g.score, mode: "quiz" });
        review(m, g.score, this.today(), this.examFor(learner, concept.id)?.date);
        if (g.misconception && g.verdict !== "correct") m.misconceptions.push({ text: g.misconception, at: this.now().toISOString() });
        this.touchStreak(learner);
        learner.minutesStudied += 1;
      }
      game.turn += 1;
      game.hintsUsed = 0;
      if (game.turn < game.players.length * game.turnsEach) this.pickGroupQuestion(game);
    });
    const young = player.band === "early" || player.band === "primary";
    const head =
      g.verdict === "correct"
        ? `${pick(PRAISE[player.band], game.turn)}${player.streak >= 2 ? ` That's ${player.streak} in a row, bonus point!` : ""}`
        : g.verdict === "partial"
          ? `Close, ${player.name}! One point.`
          : young
            ? `Good try, ${player.name}!`
            : `Not quite, ${player.name}.`;
    const fb = g.verdict === "correct" ? "" : ` ${g.feedback}`;
    const feedback = { player: player.name, verdict: g.verdict, points, text: `${head}${fb}`.trim() };
    if (game.turn >= game.players.length * game.turnsEach) return this.finishGroup(game, `${head}${fb}`);
    return this.groupQuestionResult(game, `${head}${fb}`, feedback);
  }

  groupAction(action: "hint" | "skip" | "repeat" | "scores" | "end"): Result {
    const game = this.activeGroup();
    const player = game.players[game.turn % game.players.length];
    if (action === "end") return this.finishGroup(game, "Okay, final whistle!");
    if (action === "repeat") return this.groupQuestionResult(game);
    if (action === "scores") {
      const board = [...game.players].sort((a, b) => b.score - a.score);
      return { ...this.groupQuestionResult(game), speech: `Scores: ${board.map((p) => `${p.name} ${p.score}`).join(", ")}. ${player.name}, it's still your turn.` };
    }
    const concept = this.s.concepts.find((c) => c.id === game.current!.conceptId)!;
    const q = concept.questions.find((x) => x.id === game.current!.questionId)!;
    if (action === "hint") {
      this.store.update(() => {
        game.hintsUsed += 1;
      });
      const hint = q.type === "mcq" ? `It starts with "${q.answer.slice(0, 3)}".` : `Think about this: ${lcFirst(concept.keyPoints[0] ?? concept.summary)}`;
      return { ...this.groupQuestionResult(game), hint, speech: `Hint for ${player.name}: ${hint} A right answer still gets a point.` };
    }
    // skip
    this.store.update(() => {
      player.answered += 1;
      player.streak = 0;
      game.turn += 1;
      if (game.turn < game.players.length * game.turnsEach) this.pickGroupQuestion(game);
    });
    const said = `No worries. The answer was ${q.answer}.`;
    if (game.turn >= game.players.length * game.turnsEach) return this.finishGroup(game, said);
    return this.groupQuestionResult(game, said);
  }

  private finishGroup(game: GroupQuiz, lead: string): Result {
    this.store.update(() => {
      game.endedAt = this.now().toISOString();
    });
    const board = [...game.players].sort((a, b) => b.score - a.score || b.correct - a.correct);
    const top = board[0].score;
    const winners = board.filter((p) => p.score === top);
    const allYoung = game.players.every((p) => p.band === "early" || p.band === "primary");
    const result =
      top === 0
        ? "Tough round for everyone. That's how we find what to practice!"
        : winners.length > 1
          ? `It's a tie between ${listJoin(winners.map((w) => w.name))} with ${top} points!`
          : `${winners[0].name} wins with ${top} points!`;
    const streaker = [...game.players].sort((a, b) => b.bestStreak - a.bestStreak)[0];
    const extra = streaker.bestStreak >= 2 ? ` Best streak: ${streaker.name}, ${streaker.bestStreak} in a row.` : "";
    const cheer = allYoung ? " Everyone did amazing. High fives all round!" : " Great game, everyone. Shake hands, and the questions you missed will show up in your own reviews.";
    return {
      kind: "group_summary",
      title: "Final scores",
      gameId: game.id,
      players: board.map((p) => ({ name: p.name, score: p.score, correct: p.correct, answered: p.answered, bestStreak: p.bestStreak, guest: !p.learnerId, winner: p.score === top && top > 0 })),
      speech: `${lead} ${result}${extra}${cheer}`.replace(/\s+/g, " ").trim(),
    };
  }

  // ------------------------------------------------------------------ teach-back

  startTeachBack(conceptQuery?: string): Result {
    const l = this.learner();
    const concept = this.resolveConcept(l, conceptQuery);
    if (!concept) throw new BuddyError("Pick a topic you've studied and I'll be your student.");
    this.store.update((s) => {
      s.teachBacks.push({ id: this.id("tb"), learnerId: l.id, conceptId: concept.id, startedAt: this.now().toISOString() });
    });
    const audience = l.band === "early" || l.band === "primary" ? "your teddy bear" : l.band === "college" || l.band === "adult" ? "a first-year student" : "your little cousin";
    return {
      kind: "teach_back",
      title: `Teach me: ${concept.title}`,
      phase: "listening",
      conceptId: concept.id,
      checklist: concept.keyPoints.map((k) => ({ point: k, status: "pending" })),
      speech: `Your turn to be the teacher. Explain ${low(concept.title)} to me like I'm ${audience}. Take your time. I'm listening.`,
    };
  }

  async submitTeachBack(llm: Llm | null, explanation: string): Promise<Result> {
    const l = this.learner();
    const tb = this.s.teachBacks.filter((t) => t.learnerId === l.id).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    if (!tb) throw new BuddyError("Pick a topic first and I'll be your student. Say 'let me teach you' and the topic.");
    const concept = this.s.concepts.find((c) => c.id === tb.conceptId)!;
    const r = await evaluateTeachBack(llm, l, concept, explanation);
    this.store.update((s) => {
      let m = this.mastery(l, concept.id);
      if (!m) {
        m = newMastery(l.id, concept.id, this.today());
        s.mastery.push(m);
      }
      m.history.push({ at: this.now().toISOString(), score: r.score, mode: "teach_back" });
      review(m, r.score, this.today(), this.examFor(l, concept.id)?.date);
      this.touchStreak(l);
      l.minutesStudied += 2;
    });
    const covered = new Set(r.covered.map((x) => x.toLowerCase()));
    return {
      kind: "teach_back",
      title: `You taught: ${concept.title}`,
      phase: "result",
      conceptId: concept.id,
      score: r.score,
      checklist: concept.keyPoints.map((k) => ({ point: k, status: covered.has(k.toLowerCase()) ? "covered" : "missing" })),
      incorrect: r.incorrect,
      speech: `${r.feedback}${r.score >= 0.8 ? " If you can teach it, you know it." : " Want to try once more, or should I explain that part?"}`,
    };
  }

  // ------------------------------------------------------------------ plan & progress

  private masteryMap(l: Learner, deckIds?: string[]) {
    const today = this.today();
    return this.conceptsOf(l, deckIds).map((c) => {
      const m = this.mastery(l, c.id);
      return {
        conceptId: c.id,
        title: c.title,
        status: statusFor(m, today),
        strength: strength(m, today),
        due: m?.due ?? today,
        misconception: m?.misconceptions.filter((x) => !x.resolved).slice(-1)[0]?.text ?? null,
      };
    });
  }

  studyPlan(examQuery?: string): Result {
    const l = this.learner();
    const today = this.today();
    const exam = examQuery ? l.exams.find((e) => low(e.title).includes(examQuery.toLowerCase()) || e.subject?.toLowerCase() === examQuery.toLowerCase()) ?? this.examFor(l) : this.examFor(l);
    const map = this.masteryMap(l, exam?.deckIds);
    if (!map.length) throw new BuddyError("Once you share notes or a topic, I'll build your study plan.");
    const daysLeft = exam ? Math.max(0, daysBetween(today, exam.date)) : 7;
    const order = [...map].sort((a, b) => {
      const rank = (x: (typeof map)[number]) => (x.misconception ? 0 : x.status === "shaky" ? 1 : x.status === "new" ? 2 : x.status === "learning" ? 3 : 4);
      return rank(a) - rank(b) || a.strength - b.strength;
    });
    const studyDays = Math.max(1, daysLeft - (daysLeft >= 2 ? 1 : 0)); // keep the last day for mixed review
    const perDay = Math.max(1, Math.ceil(order.filter((x) => x.status !== "solid").length / studyDays));
    const days: Array<{ date: string; label: string; focus: string[]; minutes: number }> = [];
    let cursor = 0;
    const horizon = Math.min(daysLeft || 1, 6);
    for (let d = 0; d < horizon; d++) {
      const date = isoDate(addDays(new Date(`${today}T12:00:00Z`), d), "UTC");
      const isLast = exam && d === daysLeft - 1 && daysLeft >= 2;
      let focus: string[];
      if (isLast) focus = ["Mixed review of everything", "Teach back your weakest topic"];
      else {
        focus = order.slice(cursor, cursor + perDay).filter((x) => x.status !== "solid").map((x) => x.title);
        cursor += perDay;
        if (!focus.length) focus = ["Quick spaced review"];
      }
      days.push({ date, label: d === 0 ? "Today" : relativeDay(date, this.now(), this.tz), focus, minutes: GUIDES[l.band].sessionMinutes });
    }
    const counts = { solid: map.filter((x) => x.status === "solid").length, learning: map.filter((x) => x.status === "learning").length, shaky: map.filter((x) => x.status === "shaky").length, new: map.filter((x) => x.status === "new").length };
    const bits: string[] = [];
    if (exam) bits.push(`${exam.title} is ${relativeDay(exam.date, this.now(), this.tz)}${daysLeft > 1 ? `, ${daysLeft} days away` : ""}.`);
    const parts: string[] = [];
    if (counts.solid) parts.push(`${counts.solid} solid`);
    if (counts.learning) parts.push(`${counts.learning} getting there`);
    if (counts.shaky) parts.push(`${counts.shaky} shaky`);
    if (counts.new) parts.push(`${counts.new} not started`);
    bits.push(`Out of ${plural(map.length, "topic")}, you've got ${listJoin(parts)}.`);
    bits.push(`Today: ${listJoin(days[0].focus.map((f) => f.toLowerCase()))}, about ${days[0].minutes} minutes.`);
    return { kind: "study_plan", title: exam ? `${exam.title} plan` : "Study plan", exam: exam ? { ...exam, daysLeft } : null, counts, mastery: map, days, speech: bits.join(" ") };
  }

  async summary(llm: Llm | null, topic?: string): Promise<Result> {
    const l = this.learner();
    const deck = topic ? this.decksOf(l).find((d) => low(d.title).includes(topic.toLowerCase()) || topic.toLowerCase().includes(low(d.title))) : this.decksOf(l).slice(-1)[0];
    const concepts = deck ? this.s.concepts.filter((c) => c.deckId === deck.id) : topic ? [this.resolveConcept(l, topic)].filter((x): x is Concept => !!x) : [];
    if (!concepts.length) throw new BuddyError("Share your notes or a topic first, and I'll make you a one-page summary.");
    const title = deck?.title ?? concepts[0].title;
    const s = await summarize(llm, l, title, concepts);
    return {
      kind: "summary",
      title: `${title} in one page`,
      headline: s.headline,
      points: s.points,
      memoryTrick: s.memoryTrick ?? null,
      speech: `${s.headline} First, ${lcFirst(s.points[0])}${s.memoryTrick ? ` Memory trick: ${lcFirst(s.memoryTrick).replace(/\.?$/, ".")}` : ""} The other ${plural(Math.max(0, s.points.length - 1), "point")} are on the screen.`,
    };
  }

  // ------------------------------------------------------------------ focus sessions

  focus(input: { action: "start" | "end"; minutes?: number; topic?: string }): Result {
    const l = this.learner();
    if (input.action === "start") {
      const minutes = Math.max(5, Math.min(60, input.minutes ?? (l.band === "early" || l.band === "primary" ? 10 : 25)));
      const start = this.now();
      const session = { id: this.id("focus"), learnerId: l.id, minutes, topic: input.topic, startedAt: start.toISOString(), endsAt: new Date(start.getTime() + minutes * 60_000).toISOString() };
      this.store.update((s) => s.focus.push(session));
      return {
        kind: "focus",
        title: "Focus session",
        phase: "running",
        session,
        serverNow: start.toISOString(),
        speech: `Focus mode on for ${minutes} minutes${input.topic ? ` on ${input.topic}` : ""}. Put your phone face down, out of reach. I'll check in when the time's up with a quick quiz on what you studied.`,
      };
    }
    const open = this.s.focus.filter((f) => f.learnerId === l.id && !f.completed).slice(-1)[0];
    if (!open) throw new BuddyError("There's no focus session running. Want to start one?");
    const minutes = Math.max(1, Math.round((Math.min(this.now().getTime(), Date.parse(open.endsAt)) - Date.parse(open.startedAt)) / 60_000));
    this.store.update(() => {
      open.completed = true;
      l.minutesStudied += minutes;
      this.touchStreak(l);
    });
    return {
      kind: "focus",
      title: "Focus session done",
      phase: "done",
      session: open,
      minutes,
      streak: l.streak,
      speech: `Time's up! That was ${plural(minutes, "minute")} of real focus${l.streak.current >= 2 ? `, and day ${l.streak.current} of your streak` : ""}. Want a quick three-question quiz to lock it in?`,
    };
  }

  // ------------------------------------------------------------------ bedtime stories

  async tellStory(llm: Llm | null, input: { child: string; lesson: string; age?: number; interests?: string[]; minutes?: number; voiceId?: string }): Promise<Result> {
    let child = this.findLearner(input.child);
    if (!child || input.age !== undefined || input.interests?.length) {
      this.setUpLearner({ name: input.child, age: input.age ?? child?.age, role: "child", interests: input.interests, level: child?.level || (input.age !== undefined ? `Age ${input.age}` : "") });
      child = this.findLearner(input.child)!;
    }
    const minutes = Math.max(2, Math.min(8, input.minutes ?? (child.band === "early" ? 3 : 5)));
    const draft = await bedtimeStory(llm, child, input.lesson, minutes);
    const story = { id: this.id("story"), childId: child.id, lesson: input.lesson, title: draft.title, pages: draft.pages, question: draft.question, voiceId: input.voiceId, createdAt: this.now().toISOString() };
    this.store.update((s) => s.stories.push(story));
    return {
      kind: "story",
      title: draft.title,
      storyId: story.id,
      child: this.learnerCard(child),
      lesson: input.lesson,
      pages: draft.pages,
      question: draft.question,
      storyCount: this.s.stories.filter((x) => x.childId === child!.id).length,
      speech: `${draft.title}. ${draft.pages.join(" ")} ${draft.question ? `${draft.question}` : ""}`.trim(),
    };
  }
}

/** A fun, specific question about something the learner loves, to start a real conversation. */
function icebreaker(interest?: string): { topic: string; question: string } {
  const i = (interest ?? "").toLowerCase();
  const table: Array<[RegExp, string, string]> = [
    [/dino/, "favourite dinosaur", "What's your favourite dinosaur?"],
    [/cricket/, "favourite cricketer", "Who's your favourite cricketer?"],
    [/football|soccer/, "favourite football player", "Who's your favourite football player?"],
    [/space|planet|rocket|star/, "dream planet", "If you could visit any planet, which one would it be?"],
    [/unicorn/, "unicorn name", "If you had a unicorn, what would you name it?"],
    [/minecraft/, "Minecraft build", "What are you building in Minecraft these days?"],
    [/gam/, "favourite game", "What game are you playing these days?"],
    [/music|song|sing|k-?pop|guitar|piano/, "favourite song", "What song have you been listening to a lot lately?"],
    [/draw|art|paint/, "favourite thing to draw", "What do you like drawing most?"],
    [/cook|bak|food/, "favourite dish", "What's your favourite thing to cook or eat?"],
    [/read|book/, "favourite book", "What's the best book you've read lately?"],
    [/dog|cat|animal|pet/, "favourite animal", "What's your favourite animal?"],
  ];
  const hit = table.find(([re]) => re.test(i));
  if (hit) return { topic: hit[1], question: hit[2] };
  if (interest) return { topic: `${interest}`, question: `What do you love most about ${interest}?` };
  return { topic: "favourite thing", question: "What's something you really love doing?" };
}

function kindFor(text: string): MemoryKind {
  const t = text.toLowerCase();
  if (/\b(nervous|anxious|panic|struggle|hard|hate|bad at|confus|forget|scared|shy|worr|difficult|weak)/.test(t)) return "struggle";
  if (/\b(prefer|learn(s)? better|likes? it when|rather|works for)/.test(t)) return "preference";
  if (/\b(want(s)? to|goal|aim|dream|hoping)/.test(t)) return "goal";
  if (/\b(good at|best at|great at|strong in|loves? to read)/.test(t)) return "strength";
  return "personal";
}
