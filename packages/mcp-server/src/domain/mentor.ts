import {
  bedtimeStory,
  deckFromMaterial,
  deckFromTopic,
  evaluateTeachBack,
  explain,
  grade,
  keywords,
  summarize,
  type DeckDraft,
} from "./generate.ts";
import { bandFor, GUIDES, voiceGuideText } from "./levels.ts";
import type { Llm } from "./llm.ts";
import { isDue, newMastery, review, statusFor, strength } from "./srs.ts";
import type { Store } from "./store.ts";
import { addDays, daysBetween, hourIn, isoDate, relativeDay, spokenDate } from "./time.ts";
import type {
  Concept,
  Deck,
  Exam,
  ExplainStyle,
  Learner,
  Mastery,
  MemoryKind,
  Question,
  QuizItem,
  QuizSession,
  State,
} from "./types.ts";

/** Every tool result carries `kind` (which card to render) and `speech` (what the assistant should say). */
export interface Result {
  kind: string;
  speech: string;
  [key: string]: unknown;
}

export class BuddyError extends Error {}

export const BRAND = process.env.BUDDY_BRAND ?? "Study Buddy";

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
  exam?: { title: string; subject?: string; date?: string; inDays?: number };
}

export class Mentor {
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
    return this.s.learners.find((l) => l.id === n || l.name.toLowerCase() === n) ?? this.s.learners.find((l) => l.name.toLowerCase().startsWith(n));
  }

  private learner(): Learner {
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
    return voiceGuideText(l.name, l.band, l.interests, [...worked, ...(struggles.length ? [`Keep in mind: ${struggles.join("; ")}.`] : [])]);
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

  private addMemory(l: Learner, text: string, kind: MemoryKind, source: "learner" | "observed") {
    const norm = text.trim().replace(/\.$/, "");
    if (l.memories.some((m) => m.text.toLowerCase() === norm.toLowerCase())) return;
    l.memories.push({ id: this.id("mem"), text: norm, kind, source, at: this.now().toISOString() });
  }

  resolveConcept(l: Learner, query?: string): Concept | undefined {
    const pool = this.conceptsOf(l);
    if (!pool.length) return undefined;
    if (!query) return this.weakest(l, pool) ?? pool[0];
    const q = query.toLowerCase();
    const exact = pool.find((c) => c.id === query || low(c.title) === q);
    if (exact) return exact;
    const qk = new Set(keywords(q));
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
      if (input.age !== undefined) l.age = input.age;
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

  private addExamTo(l: Learner, e: NonNullable<SetUpInput["exam"]>): Exam {
    const date = e.date ?? isoDate(addDays(this.now(), Math.max(0, e.inDays ?? 7)), this.tz);
    const subject = e.subject ? titleCase(e.subject) : undefined;
    const existing = l.exams.find((x) => low(x.title) === low(e.title));
    const deckIds = this.decksOf(l)
      .filter((d) => subject && d.subject.toLowerCase() === subject.toLowerCase())
      .map((d) => d.id);
    if (existing) {
      existing.date = date;
      existing.subject = subject ?? existing.subject;
      return existing;
    }
    const exam: Exam = { id: this.id("exam"), title: e.title, subject, date, deckIds };
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
    return this.todayBrief(`Hey ${l.name}!`);
  }

  remember(text: string, kind: MemoryKind = "personal"): Result {
    const l = this.learner();
    this.store.update(() => this.addMemory(l, text, kind, "learner"));
    const speech =
      kind === "struggle"
        ? `Thanks for telling me. I'll keep that in mind and go at your pace.`
        : kind === "preference"
          ? `Got it. I'll teach it that way from now on.`
          : `Got it, I'll remember that.`;
    return { kind: "memory_saved", title: "Remembered", memory: l.memories[l.memories.length - 1], learner: this.learnerCard(l), speech };
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
    bits.push(`You can ask me to forget anything.`);
    return {
      kind: "profile",
      title: `What I know about ${l.name}`,
      isNew: false,
      learner: this.learnerCard(l),
      memories: [...told, ...observed],
      exams: l.exams,
      stats: { minutesStudied: l.minutesStudied, decks: this.decksOf(l).length, concepts: this.conceptsOf(l).length },
      voiceGuide: this.voiceGuide(l),
      speech: bits.join(" "),
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
    const target =
      l.memories.find((m) => m.id === input.memoryId) ??
      (input.text ? l.memories.find((m) => m.text.toLowerCase().includes(input.text!.toLowerCase()) || keywords(input.text!).some((k) => keywords(m.text).includes(k))) : undefined);
    if (!target) throw new BuddyError("I couldn't find that in what I remember. Ask me what I know about you to see everything.");
    this.store.update(() => {
      l.memories = l.memories.filter((m) => m.id !== target.id);
    });
    return { kind: "forgotten", title: "Forgotten", forgotten: target.text, speech: `Okay, I've forgotten that ${lcFirst(target.text)}.` };
  }

  // ------------------------------------------------------------------ today

  todayBrief(prefix?: string): Result {
    const l = this.findLearner();
    if (!l) {
      return {
        kind: "welcome",
        title: `Hi, I'm ${BRAND}`,
        learners: this.s.learners.map((x) => this.learnerCard(x)),
        speech: this.s.learners.length
          ? `Hi! Who's studying today? I know ${listJoin(this.s.learners.filter((x) => x.role === "student").map((x) => x.name))}.`
          : `Hi! I'm ${BRAND}, your study mentor. I'll learn how you like to learn and help you get ready for your exams. What's your name, and what class or year are you in?`,
      };
    }
    const today = this.today();
    const hour = hourIn(this.now(), this.tz);
    const greet = prefix ?? `${hour < 12 ? "Good morning" : hour < 17 ? "Hey" : "Good evening"}, ${l.name}!`;
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

    const bits = [greet];
    if (l.streak.current >= 2 && l.streak.lastDay && daysBetween(l.streak.lastDay, today) <= 1) bits.push(`You're on a ${l.streak.current}-day streak.`);
    if (exam) bits.push(`${exam.title} is ${relativeDay(exam.date, this.now(), this.tz)}${daysBetween(today, exam.date) > 1 ? `, ${plural(daysBetween(today, exam.date), "day")} to go` : ""}.`);
    if (lastQuiz && daysBetween(isoDate(new Date(lastQuiz.startedAt), this.tz), today) >= 1 && openMisconceptions[0]) {
      bits.push(`Last time you ${lcFirst(openMisconceptions[0].text)}, so let's start there.`);
    } else if (due.length) bits.push(`You have ${plural(due.length, "topic")} ready for review.`);
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
      // Link to an upcoming exam in the same subject.
      for (const e of l.exams) {
        if (!e.deckIds.length && e.subject && e.subject.toLowerCase() === deck.subject.toLowerCase()) e.deckIds.push(deck.id);
        else if (e.subject && e.subject.toLowerCase() === deck.subject.toLowerCase() && !e.deckIds.includes(deck.id)) e.deckIds.push(deck.id);
      }
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

  async explainConcept(llm: Llm | null, input: { concept?: string; style?: ExplainStyle }): Promise<Result> {
    const l = this.learner();
    let concept = this.resolveConcept(l, input.concept);
    if (!concept && input.concept) {
      // Curiosity mode: learning anything, not just exam material.
      const draft = await deckFromTopic(llm, l, input.concept, 1);
      this.saveDeck(l, draft, { title: input.concept, text: input.concept, kind: "topic" });
      concept = this.resolveConcept(l, input.concept) ?? this.conceptsOf(l).slice(-1)[0];
    }
    if (!concept) throw new BuddyError("Tell me what you'd like explained, or share your notes first.");
    const style: ExplainStyle = input.style ?? (l.stylesThatWorked[0] ?? (l.interests.length ? "analogy" : "example"));
    const m = this.mastery(l, concept.id);
    const misconceptions = (m?.misconceptions ?? []).filter((x) => !x.resolved).map((x) => x.text);
    const ex = await explain(llm, l, concept, style, misconceptions);
    this.store.update(() => {
      l.lastExplained = { conceptId: concept!.id, style };
    });
    return {
      kind: "explanation",
      title: concept.title,
      conceptId: concept.id,
      style,
      analogy: ex.analogy ?? null,
      explanation: ex.explanation,
      keyPoints: concept.keyPoints,
      checkQuestion: ex.checkQuestion,
      misconception: misconceptions[0] ?? null,
      learner: this.learnerCard(l),
      speech: `${this.explainOpener(l, style, input.style !== undefined, ex.source)} ${ex.explanation} ${ex.checkQuestion ? `${pick(["Does that click?", "Make sense?", "With me so far?"], l.name.length + concept.title.length)} Quick check: ${ex.checkQuestion}` : ""}`.replace(/\s+/g, " ").trim(),
    };
  }

  // ------------------------------------------------------------------ quiz & flashcards

  startQuiz(input: { topic?: string; mode?: "quiz" | "flashcards"; count?: number }): Result {
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
        const c = this.resolveConcept(l, input.topic);
        if (c) {
          pool = [c];
          title = c.title;
        }
      }
    }
    const count = Math.max(1, Math.min(10, input.count ?? Math.min(6, Math.max(3, Math.round(GUIDES[l.band].sessionMinutes / 4)))));
    // Priority: open misconceptions, due & weak, then new, then the rest.
    const score = (c: Concept) => {
      const m = this.mastery(l, c.id);
      if (m?.misconceptions.some((x) => !x.resolved)) return 0;
      if (m?.history.length && isDue(m, today)) return 1 + strength(m, today);
      if (!m?.history.length) return 3;
      return 4 + strength(m, today);
    };
    const ordered = [...pool].sort((a, b) => score(a) - score(b));
    const queue: QuizItem[] = [];
    let round = 0;
    while (queue.length < count && round < 4) {
      for (const c of ordered) {
        if (queue.length >= count) break;
        if (mode === "flashcards") {
          const f = c.flashcards[round % Math.max(1, c.flashcards.length)];
          if (f && !queue.some((q) => q.flashcardId === f.id)) queue.push({ conceptId: c.id, flashcardId: f.id });
        } else {
          const prior = this.mastery(l, c.id)?.history.length ?? 0;
          const q = c.questions[(prior + round) % Math.max(1, c.questions.length)];
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
    if (q.type === "mcq" && q.options) return `${q.prompt} Is it ${listJoin(q.options).replace(/, and /, ", or ").replace(/ and ([^,]+)$/, " or $1")}?`;
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
    return this.recordAndAdvance(l, session, concept, g, card ? "flashcard" : "quiz");
  }

  private recordAndAdvance(
    l: Learner,
    session: QuizSession,
    concept: Concept,
    g: { score: number; verdict: "correct" | "partial" | "incorrect"; feedback: string; misconception?: string },
    mode: "quiz" | "flashcard",
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
      session.results.push({ conceptId: concept.id, score: g.score, verdict: g.verdict, misconception: g.misconception });
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
    const verdict =
      ratio === 1 ? (l.band === "early" || l.band === "primary" ? "A perfect score! You're a superstar." : "A perfect round.") : ratio >= 0.7 ? "Strong round." : ratio >= 0.4 ? "Good effort, and now we know what to work on." : "That was a tough one, and that's exactly why we practice.";
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
      speech: `${lead} ${total ? `That's ${correct} out of ${total}.` : ""} ${verdict}${next}${streak}`.replace(/\s+/g, " ").trim(),
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
