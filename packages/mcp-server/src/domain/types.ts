/** How a learner should be spoken to. Derived from age and class/level, never hard-coded per user. */
export type LevelBand = "early" | "primary" | "middle" | "high" | "college" | "adult";

export type MemoryKind = "preference" | "struggle" | "strength" | "personal" | "goal";

export interface Memory {
  id: string;
  text: string;
  kind: MemoryKind;
  /** "learner" = they told us, "observed" = we inferred it from how they studied. */
  source: "learner" | "observed";
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
  /** The last explanation given, so a correct answer right after it teaches us which style works. */
  lastExplained?: { conceptId: string; style: ExplainStyle };
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
  createdAt: string;
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
  results: Array<{ conceptId: string; score: number; verdict: "correct" | "partial" | "incorrect"; misconception?: string }>;
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
  teachBacks: TeachBackSession[];
  stories: Story[];
  focus: FocusSession[];
  parentVoices?: ParentVoice[];
  voiceMessages?: VoiceMessage[];
  voiceEnrollments?: VoiceEnrollment[];
  seq: number;
}
