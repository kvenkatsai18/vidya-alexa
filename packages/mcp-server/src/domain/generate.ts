import { GUIDES, voiceGuideText } from "./levels.ts";
import { parseJson, type Llm } from "./llm.ts";
import type { Concept, ConceptSeed, ExplainStyle, Learner, Question, Source } from "./types.ts";

/**
 * Everything a learner sees is generated live by the model (MCP sampling or the server's own
 * Amazon Nova on Bedrock). There is no pre-made content: with no model connected, generation
 * says so plainly. Grading multiple choice and true/false is exact, so it never needs a model.
 */

export class NeedsLlmError extends Error {}

const NO_AI = "I need my AI connection for that, and it isn't set up yet. Connect Amazon Bedrock (AWS credentials) and try again.";
const AI_DOWN = "I couldn't reach my AI just now. Please try that again in a moment.";

/** Scripted stand-ins for the model, used only by the automated tests (test/fixtures/offline-engine.ts). */
export interface OfflineEngine {
  deckFromMaterial(learner: Learner, title: string, text: string): DeckDraft;
  deckFromTopic(learner: Learner, topic: string): DeckDraft | null;
  explain(learner: Learner, concept: Concept, style: ExplainStyle, misconceptions: string[]): Explanation;
  story(child: Learner, lesson: string, minutes: number): StoryDraft;
}
let testEngine: OfflineEngine | null = null;
export function useOfflineEngine(engine: OfflineEngine | null) {
  testEngine = engine;
}

const MAX_MATERIAL_CHARS = 60_000;

const BASE_SYSTEM = `You are the content engine behind Study Buddy, a voice-first study mentor on Alexa+.
Everything you write may be spoken aloud by text-to-speech: no markdown, no emoji, no bullet characters inside spoken text, short clear sentences.
Be accurate. Never invent facts that contradict the learner's material. Reply with a single JSON object only.`;

function learnerContext(l: Learner, extras: string[] = []): string {
  const lessons = (l.lessons ?? []).map((x) => x.text);
  return voiceGuideText(l.name, l.band, l.interests, [...extras, ...(lessons.length ? [`${l.name} corrected you before; always follow these: ${lessons.join("; ")}.`] : [])]);
}

/** The learner says a grade was unfair: check again, honestly, and say what to learn from it. */
export async function regrade(llm: Llm | null, learner: Learner, concept: Concept, q: Question, answer: string, reason: string): Promise<{ overturned: boolean; score: number; feedback: string; lesson?: string }> {
  if (!llm) throw new NeedsLlmError(NO_AI);
  try {
    const out = parseJson<any>(
      await llm.complete({
        purpose: "Re-check a grade the learner disputes",
        system: BASE_SYSTEM,
        maxTokens: 600,
        temperature: 0,
        prompt: `You graded this answer as wrong or partly wrong, and the learner says that was a mistake. Re-check it honestly and carefully, by meaning, with the full concept in mind. Admit it if you were wrong; don't give in if you weren't. ${learnerContext(learner)}
Concept: ${concept.title}. ${concept.summary} Key points: ${concept.keyPoints.join(" | ")}
Question: ${q.prompt}
Model answer: ${q.answer}
Learner's answer: "${answer}"
${reason ? `Learner's reason: "${reason}"` : ""}
Return JSON: {"overturned": boolean (true if their answer deserves credit), "score": number 0-1 (the fair score), "feedback": string (spoken, 1-2 sentences: if overturned, own the mistake simply; if not, explain kindly why), "lesson": string (if overturned: one instruction for grading this learner fairly next time, e.g. "Accept S phase as where DNA is copied"; else "")}`,
      }),
    );
    if (typeof out?.overturned !== "boolean") throw new Error("bad shape");
    return { overturned: out.overturned, score: Math.max(0, Math.min(1, Number(out.score) || 0)), feedback: String(out.feedback ?? ""), lesson: out.lesson || undefined };
  } catch (e) {
    log(e, "re-grade");
    throw new NeedsLlmError(AI_DOWN);
  }
}

function log(err: unknown, what: string) {
  console.error(`[study-buddy] ${what} failed: ${(err as Error).message}`);
}

// ------------------------------------------------------------------ decks

export interface DeckDraft {
  title: string;
  subject: string;
  concepts: ConceptSeed[];
  truncated: boolean;
  source: "llm" | "fixture";
}

const DECK_SCHEMA = `{"title": string, "subject": string, "concepts": [{"title": string, "summary": string (1-2 sentences), "keyPoints": string[] (3-5), "confusableWith": string[] (terms students mix this up with, may be empty), "flashcards": [{"front": string, "back": string}] (2), "questions": [{"type": "mcq", "prompt": string, "options": string[4], "answer": string (exactly one of options), "explanation": string}, {"type": "short", "prompt": string, "answer": string, "explanation": string}, {"type": "truefalse", "prompt": string (starts with "True or false:"), "answer": "True" | "False", "explanation": string}]}]}`;

function validDeck(d: any): d is { title: string; subject: string; concepts: ConceptSeed[] } {
  return d && typeof d.title === "string" && Array.isArray(d.concepts) && d.concepts.length > 0 &&
    d.concepts.every((c: any) => c.title && c.summary && Array.isArray(c.keyPoints) && Array.isArray(c.questions));
}

export async function deckFromMaterial(llm: Llm | null, learner: Learner, title: string, text: string): Promise<DeckDraft> {
  if (!llm) {
    if (testEngine) return testEngine.deckFromMaterial(learner, title, text);
    throw new NeedsLlmError(NO_AI);
  }
  const truncated = text.length > MAX_MATERIAL_CHARS;
  const body = truncated ? text.slice(0, MAX_MATERIAL_CHARS) : text;
  {
    try {
      const out = parseJson<any>(
        await llm.complete({
          purpose: "Turn uploaded notes into a study deck",
          system: BASE_SYSTEM,
          maxTokens: 8000,
          prompt: `Turn these study notes into a study deck for this learner. ${learnerContext(learner)}
Pitch every question at their level (${GUIDES[learner.band].questionStyle}). Use 4 to 8 concepts, in the order they appear in the notes. Ground everything in the notes.
The deck "title" is the topic's own name (for example "Cell division"), never words like "mastery", "study deck", "notes" or "unit".
Notes title: ${title}
<notes>
${body}
</notes>
Return JSON with this shape: ${DECK_SCHEMA}`,
        }),
      );
      if (validDeck(out)) return { ...out, concepts: out.concepts.map(normalizeSeed), truncated, source: "llm" };
      throw new Error("deck JSON had the wrong shape");
    } catch (e) {
      log(e, "deck generation");
      throw new NeedsLlmError(AI_DOWN);
    }
  }
}

export async function deckFromTopic(llm: Llm | null, learner: Learner, topic: string, maxConcepts = 4): Promise<DeckDraft> {
  if (!llm) {
    const d = testEngine?.deckFromTopic(learner, topic);
    if (d) return d;
    throw new NeedsLlmError(NO_AI);
  }
  let out: any;
  try {
    out = parseJson<any>(
    await llm.complete({
      purpose: `Build a study deck on ${topic}`,
      system: BASE_SYSTEM,
      maxTokens: 6000,
      prompt: `Build a short study deck that teaches "${topic}" to this learner. ${learnerContext(learner)}
Use 1 to ${maxConcepts} concepts that build on each other. Pitch it at their level (${GUIDES[learner.band].questionStyle}).
The deck "title" is the topic's own name (for example "The French Revolution" or "Cell division"), never words like "study deck", "exam" or "test".
Each concept title names the idea itself (for example "Entropy as disorder"), never generic words like "Definition", "Introduction" or "Fundamental concept".
Return JSON with this shape: ${DECK_SCHEMA}`,
    }),
  );
  } catch (e) {
    log(e, "topic deck");
    throw new NeedsLlmError(AI_DOWN);
  }
  if (!validDeck(out)) throw new NeedsLlmError(AI_DOWN);
  return { ...out, concepts: out.concepts.map(normalizeSeed), truncated: false, source: "llm" };
}

function normalizeSeed(c: any): ConceptSeed {
  return {
    title: String(c.title),
    summary: String(c.summary),
    keyPoints: (c.keyPoints ?? []).map(String).slice(0, 6),
    confusableWith: (c.confusableWith ?? []).map(String),
    flashcards: (c.flashcards ?? []).filter((f: any) => f?.front && f?.back).slice(0, 4),
    questions: (c.questions ?? [])
      .filter((q: any) => q?.prompt && q?.answer)
      .map((q: any) => ({
        type: q.type === "mcq" || q.type === "truefalse" ? q.type : "short",
        prompt: String(q.prompt),
        options: Array.isArray(q.options) ? q.options.map(String) : undefined,
        answer: String(q.answer),
        explanation: String(q.explanation ?? ""),
      })),
  };
}

// ------------------------------------------------------------------ research beyond the notes

export interface ResearchDraft {
  title: string;
  overview: string;
  cards: Array<{ heading: string; body: string; example?: string }>;
  sources: Source[];
}

const NO_WEB = "Research needs Amazon Nova's web search, and it isn't switched on for this account yet. I can still explain anything from your notes.";

/**
 * Two steps: Nova searches the web for what the notes don't cover (with sources), then the
 * findings are rewritten as short cards at the learner's level, with examples from their interests.
 */
export async function researchTopic(researcher: Llm | null, writer: Llm | null, learner: Learner, topic: string, fromNotes: string[]): Promise<ResearchDraft> {
  if (!researcher?.research) throw new NeedsLlmError(NO_WEB);
  let found: { text: string; sources: Source[] };
  try {
    found = await researcher.research({
      purpose: `Research ${topic}`,
      system: "You are a careful research assistant for a student. Use web search. Prefer reliable educational, scientific and news sources. Be accurate and cite sources.",
      maxTokens: 2500,
      prompt: `Research "${topic}" for a ${learner.level} student (${GUIDES[learner.band].label} level).
${fromNotes.length ? `Their notes already cover: ${fromNotes.join("; ")}. Focus on what the notes don't cover.` : ""}
Find: 1) how it works one level deeper, 2) real-world uses and why it matters today, 3) a recent development or discovery, 4) the most common misconception and the truth, 5) one surprising fact. Plain text, short paragraphs.`,
    });
  } catch (e) {
    log(e, "web research");
    const denied = /AccessDenied|not authorized|InvokeTool/i.test((e as Error).message);
    throw new NeedsLlmError(denied ? NO_WEB : AI_DOWN);
  }
  if (!found.text.trim()) throw new NeedsLlmError(AI_DOWN);
  const w = writer ?? researcher;
  try {
    const out = parseJson<any>(
      await w.complete({
        purpose: `Explain research on ${topic}`,
        system: BASE_SYSTEM,
        maxTokens: 2500,
        prompt: `Turn this web research into 4 to 6 short cards for the learner. ${learnerContext(learner)}
Each card: a heading, a body (at most 55 words, at their level), and one example from their own interests or everyday life. Only use facts from the research.
Topic: ${topic}
<research>
${found.text.slice(0, 12_000)}
</research>
Return JSON: {"title": string, "overview": string (spoken, 1-2 sentences: what you found beyond their notes), "cards": [{"heading": string, "body": string, "example": string}]}`,
      }),
    );
    if (!out?.title || !Array.isArray(out.cards) || !out.cards.length) throw new Error("research JSON had the wrong shape");
    return {
      title: String(out.title),
      overview: String(out.overview ?? ""),
      cards: out.cards.slice(0, 6).map((c: any) => ({ heading: String(c.heading ?? ""), body: String(c.body ?? ""), example: c.example ? String(c.example) : undefined })),
      sources: found.sources,
    };
  } catch (e) {
    log(e, "research cards");
    throw new NeedsLlmError(AI_DOWN);
  }
}

// ------------------------------------------------------------------ fresh questions

/**
 * New questions for a concept the learner has already been quizzed on, so a second quiz isn't the
 * same quiz. Different angles: applying the idea, "why", comparing, a real-world case.
 */
export async function freshQuestions(llm: Llm | null, learner: Learner, concept: Concept, count = 3): Promise<Omit<Question, "id">[]> {
  if (!llm) return [];
  try {
    const out = parseJson<any>(
      await llm.complete({
        purpose: `Write new questions on ${concept.title}`,
        system: BASE_SYSTEM,
        maxTokens: 1800,
        temperature: 0.8,
        prompt: `Write ${count} NEW quiz questions about "${concept.title}" for this learner. ${learnerContext(learner)}
Pitch them at their level (${GUIDES[learner.band].questionStyle}).
They have already been asked these, so do not repeat or rephrase them:
${concept.questions.map((q) => `- ${q.prompt}`).join("\n")}
Use their interests only where it truly helps; don't force them into every question.
Use different angles: applying the idea to a new situation, explaining why, comparing it with something it's often confused with (${concept.confusableWith.join(", ") || "related ideas"}), or a real-world example. Mix types. Ground every answer in these key points: ${concept.keyPoints.join(" | ")}
Return JSON: {"questions": [{"type": "mcq", "prompt": string, "options": string[4], "answer": string (exactly one of options), "explanation": string} | {"type": "short", "prompt": string, "answer": string, "explanation": string} | {"type": "truefalse", "prompt": string (starts with "True or false:"), "answer": "True" | "False", "explanation": string}]}`,
      }),
    );
    const seen = new Set(concept.questions.map((q) => q.prompt.toLowerCase().replace(/\W+/g, " ").trim()));
    return (out?.questions ?? [])
      .filter((q: any) => q?.prompt && q?.answer && !seen.has(String(q.prompt).toLowerCase().replace(/\W+/g, " ").trim()))
      .filter((q: any) => q.type !== "mcq" || (Array.isArray(q.options) && q.options.length >= 2 && q.options.map(String).includes(String(q.answer))))
      .slice(0, count)
      .map((q: any) => ({
        type: q.type === "mcq" || q.type === "truefalse" ? q.type : "short",
        prompt: String(q.prompt),
        options: Array.isArray(q.options) ? q.options.map(String) : undefined,
        answer: String(q.answer),
        explanation: String(q.explanation ?? ""),
      }));
  } catch (e) {
    log(e, "fresh questions");
    return [];
  }
}

// ------------------------------------------------------------------ explanations

export interface Explanation {
  explanation: string;
  analogy?: string;
  checkQuestion: string;
  source: "llm" | "fixture";
}

const STYLE_HINT: Record<ExplainStyle, string> = {
  analogy: "Lead with one vivid analogy from their interests, then map each part of the analogy back to the real concept.",
  example: "Use a concrete real-world example they would actually encounter.",
  step_by_step: "Walk through it in clear numbered-in-speech steps (first, then, finally).",
  simpler: "Explain it much more simply than before: shorter sentences, fewer terms.",
  story: "Tell it as a tiny story with a character.",
  deeper: "Go one level deeper: the mechanism and why it matters.",
};

export async function explain(
  llm: Llm | null,
  learner: Learner,
  concept: Concept,
  style: ExplainStyle,
  misconceptions: string[],
  previous?: string,
  request?: string,
): Promise<Explanation> {
  if (!llm) {
    if (testEngine) return testEngine.explain(learner, concept, style, misconceptions);
    throw new NeedsLlmError(NO_AI);
  }
  {
    try {
      // Spoken answers: short, like a person talking. "Simpler" is much shorter; "deeper" a bit longer.
      const base = { early: 40, primary: 50, middle: 60, high: 70, college: 85, adult: 70 }[learner.band];
      const words = style === "simpler" ? Math.round(base * 0.6) : style === "deeper" ? base + 40 : base;
      const out = parseJson<any>(
        await llm.complete({
          purpose: `Explain ${concept.title}`,
          system: BASE_SYSTEM,
          maxTokens: 1200,
          prompt: `Explain this concept to the learner. ${learnerContext(learner, learner.stylesThatWorked.length ? [`Styles that worked before: ${learner.stylesThatWorked.join(", ")}.`] : [])}
Style: ${STYLE_HINT[style]}
${misconceptions.length ? `They previously got this wrong: ${misconceptions.join("; ")}. Gently clear that up.` : ""}
${previous ? `You just explained it like this and they didn't get it, or asked for another way: "${previous.slice(0, 600)}". Use a completely different angle and a different example; don't reuse that analogy or wording.` : ""}
${request ? `They asked for: "${request.slice(0, 200)}". Do exactly that.` : ""}
Concept: ${concept.title}
Summary: ${concept.summary}
Key points: ${concept.keyPoints.join(" | ")}
Return JSON: {"explanation": string (spoken, at most ${words} words, plain sentences), "analogy": string (a 2-4 word name for the analogy used, or ""), "checkQuestion": string (one short, natural question to check understanding, or "" if it would feel forced)}`,
        }),
      );
      if (out?.explanation) return { explanation: String(out.explanation), analogy: out.analogy || undefined, checkQuestion: String(out.checkQuestion || concept.flashcards[0]?.front || ""), source: "llm" };
    } catch (e) {
      log(e, "explanation");
    }
    throw new NeedsLlmError(AI_DOWN);
  }
}

// ------------------------------------------------------------------ grading

export interface Grade {
  score: number;
  verdict: "correct" | "partial" | "incorrect";
  feedback: string;
  misconception?: string;
}

export async function grade(llm: Llm | null, learner: Learner, concept: Concept, q: Question, answer: string): Promise<Grade> {
  const a = answer.trim();
  if (q.type === "mcq" && q.options) {
    const pick = matchOption(a, q.options);
    if (pick !== undefined) {
      const ok = q.options[pick].toLowerCase() === q.answer.toLowerCase();
      if (ok) return { score: 1, verdict: "correct", feedback: q.explanation };
      // Numbers and very short options make no sense as "mixed up four with two" out of context.
      const isNumber = (x: string) => /^(\d+([.,]\d+)?%?|zero|one|two|three|four|five|six|seven|eight|nine|ten|twelve|twenty|hundred)$/i.test(x.trim());
      const right = isNumber(q.answer) ? q.answer.toLowerCase() : q.answer;
      const misconception =
        isNumber(q.answer) || isNumber(q.options[pick]) || q.answer.length <= 3
          ? `Said ${q.options[pick].toLowerCase()} instead of ${q.answer.toLowerCase()} in ${concept.title.toLowerCase()}`
          : `Mixed up ${q.answer.toLowerCase()} with ${q.options[pick].toLowerCase()}`;
      return { score: 0, verdict: "incorrect", feedback: `It's ${right}. ${q.explanation}`, misconception };
    }
  }
  if (q.type === "mcq" && q.options && !llm) {
    return { score: 0, verdict: "incorrect", feedback: `The answer is ${q.answer}. ${q.explanation}` };
  }
  if (q.type === "truefalse") {
    const said = /\b(true|yes|correct|right)\b/i.test(a) && !/\b(false|no|not)\b/i.test(a) ? "True" : /\b(false|no|wrong|not true)\b/i.test(a) ? "False" : undefined;
    if (said) {
      const ok = said === q.answer;
      return ok
        ? { score: 1, verdict: "correct", feedback: q.explanation }
        : { score: 0, verdict: "incorrect", feedback: `It's actually ${q.answer.toLowerCase()}. ${q.explanation}`, misconception: `Thought it was ${said.toLowerCase()} that ${lcFirst(q.prompt.replace(/^True or false:\s*/i, "").replace(/\.$/, ""))}` };
    }
  }
  if (llm) {
    try {
      const out = parseJson<any>(
        await llm.complete({
          purpose: "Grade a spoken answer",
          system: BASE_SYSTEM,
          maxTokens: 700,
          temperature: 0,
          prompt: `Grade the learner's spoken answer by meaning, not wording. Be fair but strict: kind in tone, honest in the score. ${learnerContext(learner)}
Question: ${q.prompt}
Model answer: ${q.answer}
Key points of the concept: ${concept.keyPoints.join(" | ")}
Learner said: "${a}"
First list every factually wrong claim in what they said (compare against the model answer and key points). Any wrong claim about the concept means the answer is not "correct": "partial" at most if the rest is right, otherwise "incorrect". Missing the main idea is "incorrect".
Return JSON: {"errors": string[] (wrong claims, short; [] if none), "score": number 0-1, "verdict": "correct" | "partial" | "incorrect", "feedback": string (spoken, 1-2 sentences, kind and specific, at their level; if wrong, say what's right), "misconception": string or "" (the specific mix-up in under 10 words, starting with "Mixed up", "Confused", "Thought" or "Forgot", e.g. "Mixed up mitosis and meiosis")}`,
        }),
      );
      if (typeof out?.score === "number") {
        const errors = Array.isArray(out.errors) ? out.errors.filter(Boolean) : [];
        let score = Math.max(0, Math.min(1, out.score));
        let verdict: Grade["verdict"] = out.verdict === "correct" || out.verdict === "partial" || out.verdict === "incorrect" ? out.verdict : verdictFor(score);
        // A wrong claim can't be "correct", whatever the score says.
        if (errors.length && verdict === "correct") {
          verdict = "partial";
          score = Math.min(score, 0.5);
        }
        return { score, verdict, feedback: String(out.feedback ?? q.explanation), misconception: verdict !== "correct" ? out.misconception || (errors[0] ? `Thought ${String(errors[0]).replace(/^that\s+/i, "")}`.slice(0, 80) : undefined) : undefined };
      }
    } catch (e) {
      log(e, "grading");
    }
  }
  return heuristicGrade(concept, q, a);
}

function matchOption(answer: string, options: string[]): number | undefined {
  const a = answer.toLowerCase().replace(/[^\w\s]/g, " ");
  const letter = a.match(/^\s*(?:option\s*)?([a-d])\b/);
  if (letter) return "abcd".indexOf(letter[1]);
  const ordinal = ["first", "second", "third", "fourth"].findIndex((w) => new RegExp(`\\b${w}\\b`).test(a));
  if (ordinal >= 0) return ordinal;
  // Which options does the answer name? Ignore options that are just part of a longer named one
  // ("phase" inside "metaphase"). If it names more than one ("meiosis is like mitosis"), it's not a
  // clear pick: let the model grade it by meaning.
  const named = options
    .map((o, i) => ({ i, t: o.toLowerCase().replace(/[^\w\s]/g, " ").trim() }))
    .filter((x) => x.t && new RegExp(`\\b${x.t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(a));
  const distinct = named.filter((x) => !named.some((y) => y !== x && y.t.length > x.t.length && y.t.includes(x.t)));
  return distinct.length === 1 ? distinct[0].i : undefined;
}

function verdictFor(score: number): Grade["verdict"] {
  return score >= 0.8 ? "correct" : score >= 0.4 ? "partial" : "incorrect";
}

const STOP = new Set("the a an and or of to in on at is are was were be been it its this that these those for with as by from into each so then than which what when where who why how they their there them do does did not no yes can will would should could about also just very more most some any all our your my".split(" "));

export function keywords(text: string): string[] {
  return [...new Set(text.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter((w) => w.length > 3 && !STOP.has(w)).map(stem))];
}

function stem(w: string) {
  return w.replace(/(ing|ed|es|s)$/, "");
}

function heuristicGrade(concept: Concept, q: Question, answer: string): Grade {
  const expected = keywords(`${q.answer}`);
  const said = new Set(keywords(answer));
  const hits = expected.filter((k) => said.has(k)).length;
  const score = expected.length ? Math.min(1, hits / Math.min(4, expected.length)) : 0;
  const wrongTerm = concept.confusableWith.find((t) => said.has(stem(t.toLowerCase())) && !keywords(q.answer).includes(stem(t.toLowerCase())));
  const misconception = wrongTerm ? `Mixed up ${concept.title.toLowerCase()} with ${wrongTerm}` : undefined;
  const verdict = misconception && score < 0.8 ? "incorrect" : verdictFor(score);
  const feedback =
    verdict === "correct"
      ? q.explanation || "That's it."
      : verdict === "partial"
        ? `You're on the right track. The full answer: ${q.answer}`
        : `The answer is ${q.answer}. ${q.type === "short" ? "" : q.explanation}`.trim();
  return { score: verdict === "incorrect" ? Math.min(score, 0.3) : score, verdict, feedback, misconception };
}

// ------------------------------------------------------------------ teach-back

export interface TeachBackResult {
  score: number;
  covered: string[];
  missing: string[];
  incorrect: string[];
  feedback: string;
}

export async function evaluateTeachBack(llm: Llm | null, learner: Learner, concept: Concept, explanation: string): Promise<TeachBackResult> {
  if (llm) {
    try {
      const out = parseJson<any>(
        await llm.complete({
          purpose: "Check a teach-back explanation",
          system: BASE_SYSTEM,
          maxTokens: 900,
          temperature: 0,
          prompt: `The learner just explained a concept back to you in their own words (Feynman technique). Compare it to the key points. ${learnerContext(learner)}
Concept: ${concept.title}
Key points: ${concept.keyPoints.map((k, i) => `${i + 1}. ${k}`).join(" ")}
Learner's explanation: "${explanation}"
Return JSON: {"score": number 0-1, "covered": string[] (key points they got, copied from the list), "missing": string[] (key points they skipped, copied from the list), "incorrect": string[] (anything they said that's wrong, short), "feedback": string (spoken, 2-3 sentences: praise what they nailed, then the single most important gap)}`,
        }),
      );
      if (typeof out?.score === "number") {
        return { score: out.score, covered: out.covered ?? [], missing: out.missing ?? [], incorrect: out.incorrect ?? [], feedback: String(out.feedback ?? "") };
      }
    } catch (e) {
      log(e, "teach-back evaluation");
    }
  }
  const said = new Set(keywords(explanation));
  const covered: string[] = [];
  const missing: string[] = [];
  for (const kp of concept.keyPoints) {
    const k = keywords(kp);
    const hit = k.filter((w) => said.has(w)).length;
    (k.length && hit / k.length >= 0.34 ? covered : missing).push(kp);
  }
  const score = concept.keyPoints.length ? covered.length / concept.keyPoints.length : 0;
  const feedback =
    score >= 0.8
      ? `That was a great explanation. You hit nearly every key point.`
      : covered.length
        ? `Nice, you covered ${covered.length} of the ${concept.keyPoints.length} key ideas. The big one you missed: ${lcFirst(missing[0]).replace(/\.$/, "")}.`
        : `Good try. Let's build it up together. Start with this: ${lcFirst(concept.keyPoints[0]).replace(/\.$/, "")}.`;
  return { score, covered, missing, incorrect: [], feedback };
}

// ------------------------------------------------------------------ summaries

export interface Summary {
  headline: string;
  points: string[];
  memoryTrick?: string;
}

export async function summarize(llm: Llm | null, learner: Learner, title: string, concepts: Concept[]): Promise<Summary> {
  if (llm) {
    try {
      const out = parseJson<any>(
        await llm.complete({
          purpose: `Summarize ${title}`,
          system: BASE_SYSTEM,
          maxTokens: 1200,
          prompt: `Write a last-minute revision summary of these concepts for the learner. ${learnerContext(learner)}
${concepts.map((c) => `${c.title}: ${c.summary} (${c.keyPoints.join("; ")})`).join("\n")}
Return JSON: {"headline": string (one spoken sentence), "points": string[] (at most 7, each one short sentence), "memoryTrick": string (one mnemonic or "")}`,
        }),
      );
      if (out?.headline && Array.isArray(out.points)) return { headline: out.headline, points: out.points.slice(0, 7), memoryTrick: out.memoryTrick || undefined };
    } catch (e) {
      log(e, "summary");
    }
  }
  const trick = concepts.flatMap((c) => c.keyPoints).find((k) => /memory trick|remember the order|PMAT/i.test(k));
  return {
    headline: `Here's ${title.toLowerCase()} on one page.`,
    points: concepts.slice(0, 7).map((c) => `${c.title}: ${c.summary}`),
    memoryTrick: trick,
  };
}

// ------------------------------------------------------------------ bedtime stories

export interface StoryDraft {
  title: string;
  pages: string[];
  question: string;
}

export async function bedtimeStory(llm: Llm | null, child: Learner, lesson: string, minutes: number): Promise<StoryDraft> {
  if (!llm) {
    if (testEngine) return testEngine.story(child, lesson, minutes);
    throw new NeedsLlmError(NO_AI);
  }
  {
    try {
      const words = Math.min(600, Math.max(180, minutes * 120));
      const out = parseJson<any>(
        await llm.complete({
          purpose: "Write a bedtime story",
          system: `${BASE_SYSTEM}
You write gentle, age-appropriate bedtime stories. Nothing scary, violent or shaming. The lesson is shown through what the characters do, not lectured. End calm and sleepy.`,
          maxTokens: 2500,
          prompt: `Write a bedtime story for ${child.name}${child.age ? `, age ${child.age}` : ""}. ${GUIDES[child.band].vocabulary}
${child.interests.length ? `${child.name} loves: ${child.interests.join(", ")}. Build the world around that.` : ""}
The lesson a parent wants to teach: "${lesson}".
About ${words} words, split into 4 to 6 short pages.
Return JSON: {"title": string, "pages": string[], "question": string (one gentle question to ask ${child.name} about the story's lesson)}`,
        }),
      );
      if (out?.title && Array.isArray(out.pages) && out.pages.length) return { title: out.title, pages: out.pages.map(String), question: String(out.question ?? "") };
    } catch (e) {
      log(e, "story");
    }
    throw new NeedsLlmError(AI_DOWN);
  }
}

// ------------------------------------------------------------------ small helpers

function lcFirst(s: string) {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}
