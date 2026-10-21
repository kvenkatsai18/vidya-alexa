/** How a learner should be spoken to. Derived from age and class/level, never hard-coded per user. */
export type LevelBand = "early" | "primary" | "middle" | "high" | "college" | "adult";

export type MemoryKind = "preference" | "struggle" | "strength" | "personal" | "goal";

export type MemorySource = "learner" | "observed" | "parent";

export interface Memory {
  id: string;
  text: string;
  kind: MemoryKind;
  /** "learner" = they told us, "observed" = inferred from how they studied, "parent" = a parent told us. */
  source: MemorySource;
  /** For parent notes: who said it. */
  by?: string;
  at: string;
}

export interface Exam {
  id: string;
  title: string;
  subject?: string;
  /** yyyy-mm-dd */
  date: string;
  deckIds: string[];
}

export type ExplainStyle = "analogy" | "example" | "step_by_step" | "simpler" | "story" | "deeper";

export interface Learner {
  id: string;
  name: string;
  role: "student" | "child";
  age?: number;
  /** As the learner said it: "Grade 10", "2nd year engineering", "adult learner". */
  level: string;
  band: LevelBand;
  subjects: string[];
  interests: string[];
  /** Explanation styles that worked for this learner, most recent first. */
  stylesThatWorked: ExplainStyle[];
  memories: Memory[];
  exams: Exam[];
  streak: { current: number; best: number; lastDay?: string };
  minutesStudied: number;
  /** Set when a parent created this profile; the child is greeted warmly the first time they talk. */
  addedBy?: { name: string; relation: string };
  /** When the learner first talked to Study Buddy themselves. */
  metAt?: string;
  /**
   * What a parent can see. Defaults by age: under 13 "full", 13-17 "summary", adults "private".
   * Safety concerns are always shared with a parent for minors, whatever this is set to.
   */
  visibility?: "full" | "summary" | "private";
  /** What Google said about their age when they connected school (see age.ts); outranks what they say. */
  ageCheck?: { minor: boolean | null; under13: boolean | null; basis: string; at: string };
  /** Online Study Together with other homes. Defaults: under 13 "off" (a parent switches it on), otherwise "allowed". */
  onlineGames?: "allowed" | "off";
    /** Something to tell the learner next time they talk (e.g. "your dad can now see our full chats"). */
  notice?: string;
  /** How they said they feel today ("tired", "stressed"...). Adapts session length and tone; expires daily. */
  mood?: { state: string; day: string };
  /**
   * Lessons the learner taught Study Buddy by correcting it ("call me Priya A", "too long", "you
   * graded that wrong"). Applied to every future session and every generated explanation.
   */
  lessons?: Lesson[];
  /** What the daily routine did on its own, shown the next time they talk ("Since yesterday"). */
  briefing?: Briefing;
  /** Earlier names, so "Hi, I'm Priya" still finds "Priya A". */
  aliases?: string[];
  /** The last explanation given, so a correct answer right after it teaches us which style works. */
  lastExplained?: { conceptId: string; style: ExplainStyle; text?: string; at?: string };
  createdAt: string;
}

export interface Flashcard {
  id: string;
  front: string;
  back: string;
}

export interface Question {
  id: string;
  type: "mcq" | "short" | "truefalse";
  prompt: string;
  options?: string[];
  answer: string;
  explanation: string;
}

export interface Concept {
  id: string;
  deckId: string;
  title: string;
  summary: string;
  keyPoints: string[];
  /** Terms learners commonly confuse this concept with. */
  confusableWith: string[];
  flashcards: Flashcard[];
  questions: Question[];
  /** Pre-written explanations keyed by interest ("cricket", "cooking", "default"). Optional, used offline. */
  analogies?: Record<string, string>;
}

export interface Deck {
  id: string;
  learnerId: string;
  title: string;
  subject: string;
  materialId?: string;
  conceptIds: string[];
  /** Research beyond the notes (web search with sources), newest last. */
  research?: Research[];
  createdAt: string;
}

export interface Source {
  url: string;
  domain: string;
  title?: string;
}

export interface Research {
  id: string;
  topic: string;
  title: string;
  overview: string;
  cards: Array<{ heading: string; body: string; example?: string }>;
  sources: Source[];
  at: string;
}

export interface Material {
  id: string;
  learnerId: string;
  title: string;
  kind: "upload" | "topic";
  text: string;
  addedAt: string;
}

export interface MasteryEvent {
  at: string;
  score: number;
  mode: "quiz" | "flashcard" | "teach_back";
}

export interface Mastery {
  learnerId: string;
  conceptId: string;
  reps: number;
  lapses: number;
  ease: number;
  intervalDays: number;
  /** yyyy-mm-dd the concept is next due for review. */
  due: string;
  lastReviewed?: string;
  misconceptions: Array<{ text: string; at: string; resolved?: boolean }>;
  history: MasteryEvent[];
}

export interface Briefing {
  /** yyyy-mm-dd in the home's time zone */
  day: string;
  at: string;
  /** Things done without being asked ("Made a study set for your Biology test"). */
  did: Array<{ kind: "school" | "study_set" | "research" | "plan"; text: string; spoken: string }>;
  /** What to do today. */
  today: string;
  seen?: boolean;
}

export interface Lesson {
  id: string;
  /** Written as an instruction to follow: "Call her Priya A", "Keep explanations short". */
  text: string;
  kind: "name" | "style" | "teaching" | "grading" | "other";
  /** "told" = saved by the assistant when corrected; "detected" = the server caught the correction itself. */
  source: "told" | "detected";
  at: string;
}

export interface QuizItem {
  conceptId: string;
  questionId?: string;
  flashcardId?: string;
}

export interface QuizSession {
  id: string;
  learnerId: string;
  mode: "quiz" | "flashcards";
  title: string;
  queue: QuizItem[];
  index: number;
  hintsUsed: number;
  revealed: boolean;
  results: Array<{ conceptId: string; score: number; verdict: "correct" | "partial" | "incorrect"; misconception?: string; answer?: string; questionId?: string; corrected?: boolean }>;
  startedAt: string;
  endedAt?: string;
}

/** Study Together: players take turns at one device. Registered players' own memory updates; guests leave no trace. */
export interface GroupPlayer {
  name: string;
  learnerId?: string;
  band: LevelBand;
  score: number;
  streak: number;
  bestStreak: number;
  answered: number;
  correct: number;
}

export interface GroupQuiz {
  id: string;
  title: string;
  deckIds: string[];
  players: GroupPlayer[];
  turnsEach: number;
  turn: number;
  current?: { conceptId: string; questionId: string };
  asked: string[];
  hintsUsed: number;
  startedAt: string;
  endedAt?: string;
}

export interface TeachBackSession {
  id: string;
  learnerId: string;
  conceptId: string;
  startedAt: string;
}

export interface Story {
  id: string;
  childId: string;
  lesson: string;
  title: string;
  pages: string[];
  question: string;
  /** Parent voice used to read it (only when explicitly asked for). */
  voiceId?: string;
  createdAt: string;
}

/**
 * A parent's cloned story voice. Safety model: it can only ever read (a) bedtime stories someone in
 * the family asks for and (b) goodnight messages the parent wrote word for word. Never free conversation.
 */
export interface ParentVoice {
  id: string;
  parentName: string;
  /** How the children know them: "Mom", "Dad", "Grandma"... */
  relation: string;
  childIds: string[];
  provider: "elevenlabs" | "mock";
  providerVoiceId: string;
  status: "active" | "paused";
  consent: { phrase: string; transcript: string; method: "spoken" | "attested"; at: string };
  createdAt: string;
}

export interface VoiceMessage {
  id: string;
  voiceId: string;
  toChildId: string;
  /** Exactly what the parent wrote. Never rewritten by AI. */
  text: string;
  createdAt: string;
  playedAt?: string;
}

export interface VoiceEnrollment {
  token: string;
  parentName: string;
  relation: string;
  childNames: string[];
  consentPhrase: string;
  expiresAt: string;
  elicitationId?: string;
  completedVoiceId?: string;
}

export interface FocusSession {
  id: string;
  learnerId: string;
  minutes: number;
  topic?: string;
  startedAt: string;
  endsAt: string;
  completed?: boolean;
}

export interface Parent {
  id: string;
  name: string;
  relation: string;
  childIds: string[];
  createdAt: string;
}

/** One exchange on the device, kept so parents can review their child's conversations. */
export interface Turn {
  id: string;
  learnerId?: string;
  heard: string;
  said: string;
  at: string;
}

export type ConcernCategory = "self_harm" | "abuse" | "bullying" | "danger" | "distress";

/** Something serious a child said. Always surfaced to a parent (for minors): AI isn't the right helper for this. */
export interface Concern {
  id: string;
  learnerId: string;
  category: ConcernCategory;
  severity: "urgent" | "high" | "watch";
  /** The child's own words. */
  excerpt: string;
  summary: string;
  at: string;
  status: "new" | "seen";
}

/** A read-only link to a learner's school (Google Classroom). Never submits or edits anything. */
export interface SchoolConnection {
  id: string;
  learnerId: string;
  provider: "google" | "none" | "fixture";
  connectedBy: { role: "learner" | "parent"; name: string };
  accountLabel: string;
  tokens?: { refresh?: string; access?: string; expiresAt?: string };
  connectedAt: string;
  lastSync?: string;
}

export interface SchoolCourse {
  id: string;
  learnerId: string;
  externalId: string;
  name: string;
  section?: string;
  teacher?: string;
}

export interface SchoolMaterial {
  title: string;
  url?: string;
  kind: "doc" | "pdf" | "link" | "video" | "form" | "file";
  /** Text, when it could be read (Google Docs export, or sample notes in test mode). */
  text?: string;
}

export interface SchoolWork {
  id: string;
  learnerId: string;
  courseId: string;
  externalId: string;
  title: string;
  description?: string;
  kind: "assignment" | "test" | "material";
  /** yyyy-mm-dd */
  due?: string;
  state: "todo" | "done" | "missing";
  materials: SchoolMaterial[];
  url?: string;
  deckId?: string;
  examId?: string;
}

export interface SchoolEnrollment {
  token: string;
  learnerId: string;
  connectedBy: { role: "learner" | "parent"; name: string };
  expiresAt: string;
  elicitationId?: string;
  done?: boolean;
}

export interface Household {
  id: string;
  name: string;
  timeZone: string;
}

export interface State {
  version: 2;
  clockOffsetMs: number;
  household: Household;
  activeLearnerId?: string;
  learners: Learner[];
  materials: Material[];
  decks: Deck[];
  concepts: Concept[];
  mastery: Mastery[];
  quizzes: QuizSession[];
  groupQuizzes?: GroupQuiz[];
  teachBacks: TeachBackSession[];
  stories: Story[];
  focus: FocusSession[];
  parents?: Parent[];
  turns?: Turn[];
  schoolConnections?: SchoolConnection[];
  schoolCourses?: SchoolCourse[];
  schoolWork?: SchoolWork[];
  schoolEnrollments?: SchoolEnrollment[];
  concerns?: Concern[];
  parentVoices?: ParentVoice[];
  voiceMessages?: VoiceMessage[];
  voiceEnrollments?: VoiceEnrollment[];
  seq: number;
}

/** A concept as a model (or a test fixture) writes it, before ids are assigned. */
export type ConceptSeed = Omit<Concept, "id" | "deckId" | "flashcards" | "questions"> & {
  flashcards: Array<{ front: string; back: string }>;
  questions: Array<Omit<Concept["questions"][number], "id">>;
};
