import { CELL_DIVISION_DECK, type ConceptSeed } from "../../content/cell-division.deck.ts";
import { GUIDES, voiceGuideText } from "./levels.ts";
import { parseJson, type Llm } from "./llm.ts";
import type { Concept, ExplainStyle, Learner, Question } from "./types.ts";

/**
 * Every generator has two paths: an LLM path (personalized, works on any material) and an
 * offline path (prepared content + heuristics) so the experience still runs without a model.
 */

export class NeedsLlmError extends Error {}

const MAX_MATERIAL_CHARS = 60_000;

const BASE_SYSTEM = `You are the content engine behind Study Buddy, a voice-first study mentor on Alexa+.
Everything you write may be spoken aloud by text-to-speech: no markdown, no emoji, no bullet characters inside spoken text, short clear sentences.
Be accurate. Never invent facts that contradict the learner's material. Reply with a single JSON object only.`;

function learnerContext(l: Learner, extras: string[] = []): string {
  return voiceGuideText(l.name, l.band, l.interests, extras);
}

function log(err: unknown, what: string) {
  console.error(`[study-buddy] ${what} failed, using offline fallback: ${(err as Error).message}`);
}

// ------------------------------------------------------------------ decks

export interface DeckDraft {
  title: string;
  subject: string;
  concepts: ConceptSeed[];
  truncated: boolean;
  source: "llm" | "prepared" | "heuristic";
}

const DECK_SCHEMA = `{"title": string, "subject": string, "concepts": [{"title": string, "summary": string (1-2 sentences), "keyPoints": string[] (3-5), "confusableWith": string[] (terms students mix this up with, may be empty), "flashcards": [{"front": string, "back": string}] (2), "questions": [{"type": "mcq", "prompt": string, "options": string[4], "answer": string (exactly one of options), "explanation": string}, {"type": "short", "prompt": string, "answer": string, "explanation": string}, {"type": "truefalse", "prompt": string (starts with "True or false:"), "answer": "True" | "False", "explanation": string}]}]}`;

function validDeck(d: any): d is { title: string; subject: string; concepts: ConceptSeed[] } {
  return d && typeof d.title === "string" && Array.isArray(d.concepts) && d.concepts.length > 0 &&
    d.concepts.every((c: any) => c.title && c.summary && Array.isArray(c.keyPoints) && Array.isArray(c.questions));
}

export async function deckFromMaterial(llm: Llm | null, learner: Learner, title: string, text: string): Promise<DeckDraft> {
  if (CELL_DIVISION_DECK.match.test(`${title}\n${text.slice(0, 400)}`) && text.length < 12_000 && /PMAT|crossing over/i.test(text)) {
    // The bundled demo notes: use the prepared deck (instant, works offline).
    return { title: CELL_DIVISION_DECK.title, subject: CELL_DIVISION_DECK.subject, concepts: CELL_DIVISION_DECK.concepts, truncated: false, source: "prepared" };
  }
  const truncated = text.length > MAX_MATERIAL_CHARS;
  const body = truncated ? text.slice(0, MAX_MATERIAL_CHARS) : text;
  if (llm) {
    try {
      const out = parseJson<any>(
        await llm.complete({
          purpose: "Turn uploaded notes into a study deck",
          system: BASE_SYSTEM,
          maxTokens: 8000,
          prompt: `Turn these study notes into a study deck for this learner. ${learnerContext(learner)}
Pitch every question at their level (${GUIDES[learner.band].questionStyle}). Use 4 to 8 concepts, in the order they appear in the notes. Ground everything in the notes.
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
    }
  }
  return { ...heuristicDeck(title, body), truncated, source: "heuristic" };
}

export async function deckFromTopic(llm: Llm | null, learner: Learner, topic: string, maxConcepts = 4): Promise<DeckDraft> {
  if (CELL_DIVISION_DECK.match.test(topic)) {
    return { title: CELL_DIVISION_DECK.title, subject: CELL_DIVISION_DECK.subject, concepts: CELL_DIVISION_DECK.concepts, truncated: false, source: "prepared" };
  }
  if (!llm) throw new NeedsLlmError(`I need my AI connection to teach a brand-new topic like ${topic}. You can share your notes, or try the sample biology notes.`);
  const out = parseJson<any>(
    await llm.complete({
      purpose: `Build a study deck on ${topic}`,
      system: BASE_SYSTEM,
      maxTokens: 6000,
      prompt: `Build a short study deck that teaches "${topic}" to this learner. ${learnerContext(learner)}
Use 1 to ${maxConcepts} concepts that build on each other. Pitch it at their level (${GUIDES[learner.band].questionStyle}).
Return JSON with this shape: ${DECK_SCHEMA}`,
    }),
  );
  if (!validDeck(out)) throw new Error("deck JSON had the wrong shape");
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

/** Offline: one concept per heading (or per paragraph), cloze-style cards from its sentences. */
function heuristicDeck(title: string, text: string): Omit<DeckDraft, "truncated" | "source"> {
  const sections: Array<{ title: string; body: string }> = [];
  const parts = text.split(/\n(?=#{1,3}\s)/);
  for (const p of parts) {
    const m = p.match(/^#{1,3}\s+(.+)\n([\s\S]*)$/);
    if (m && m[2].trim().length > 40) sections.push({ title: m[1].trim(), body: m[2].trim() });
  }
  if (!sections.length) {
    text
      .split(/\n\s*\n/)
      .map((b) => b.trim())
      .filter((b) => b.length > 80)
      .slice(0, 8)
      .forEach((b, i) => sections.push({ title: firstWords(b, 5) || `Part ${i + 1}`, body: b }));
  }
  const concepts: ConceptSeed[] = sections.slice(0, 8).map((s) => {
    const sentences = s.body.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/).filter((x) => x.length > 20);
    const summary = sentences.slice(0, 2).join(" ");
    return {
      title: s.title.replace(/^[\d.]+\s*/, ""),
      summary,
      keyPoints: sentences.slice(0, 5),
      confusableWith: [],
      flashcards: [{ front: `What should you remember about ${s.title.toLowerCase()}?`, back: summary }],
      questions: [
        { type: "short", prompt: `In your own words, what is ${s.title.toLowerCase()}?`, answer: summary, explanation: summary },
        ...(sentences[1] ? [{ type: "truefalse" as const, prompt: `True or false: ${lcFirst(sentences[1])}`, answer: "True", explanation: sentences[1] }] : []),
      ],
    };
  });
  return { title: title || concepts[0]?.title || "My notes", subject: "General", concepts };
}

// ------------------------------------------------------------------ explanations

export interface Explanation {
  explanation: string;
  analogy?: string;
  checkQuestion: string;
  source: "llm" | "prepared";
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
): Promise<Explanation> {
  if (llm) {
    try {
      const words = { early: 50, primary: 70, middle: 90, high: 110, college: 140, adult: 110 }[learner.band];
      const out = parseJson<any>(
        await llm.complete({
          purpose: `Explain ${concept.title}`,
          system: BASE_SYSTEM,
          maxTokens: 1200,
          prompt: `Explain this concept to the learner. ${learnerContext(learner, learner.stylesThatWorked.length ? [`Styles that worked before: ${learner.stylesThatWorked.join(", ")}.`] : [])}
Style: ${STYLE_HINT[style]}
${misconceptions.length ? `They previously got this wrong: ${misconceptions.join("; ")}. Gently clear that up.` : ""}
Concept: ${concept.title}
Summary: ${concept.summary}
Key points: ${concept.keyPoints.join(" | ")}
Return JSON: {"explanation": string (spoken, about ${words} words), "analogy": string (one sentence naming the analogy used, or ""), "checkQuestion": string (one quick question to check understanding)}`,
        }),
      );
      if (out?.explanation) return { explanation: String(out.explanation), analogy: out.analogy || undefined, checkQuestion: String(out.checkQuestion || concept.flashcards[0]?.front || ""), source: "llm" };
    } catch (e) {
      log(e, "explanation");
    }
  }
  const key = interestKey(learner, concept.analogies);
  const analogy = concept.analogies?.[key] ?? concept.analogies?.default;
  let explanation: string;
  if (style === "step_by_step" || !analogy) explanation = `${concept.summary} The key points: ${concept.keyPoints.slice(0, 4).map(lcFirst).join("; ")}.`;
  else if (style === "simpler") explanation = `Here's the simple version. ${concept.summary}`;
  else explanation = analogy;
  if (misconceptions.length && concept.confusableWith.length) {
    explanation += ` And remember, last time ${misconceptions[0].charAt(0).toLowerCase()}${misconceptions[0].slice(1)}, so watch out for that.`;
  }
  return { explanation, analogy: analogy && style !== "step_by_step" ? `${key === "default" ? "Everyday" : capitalize(key)} analogy` : undefined, checkQuestion: concept.flashcards[0]?.front ?? `Can you tell me what ${concept.title.toLowerCase()} is?`, source: "prepared" };
}

export function interestKey(learner: Learner, analogies?: Record<string, string>): string {
  if (!analogies) return "default";
  const keys = Object.keys(analogies);
  for (const i of learner.interests) {
    const hit = keys.find((k) => k !== "default" && (i.toLowerCase().includes(k) || k.includes(i.toLowerCase())));
    if (hit) return hit;
  }
  const synonyms: Record<string, string[]> = {
    cricket: ["ipl", "bat", "bowling"],
    football: ["soccer", "fifa", "messi"],
    cooking: ["baking", "food", "chef", "kitchen", "recipes"],
    gaming: ["games", "video games", "minecraft", "fortnite", "roblox", "esports"],
    music: ["singing", "guitar", "piano", "k-pop", "kpop", "songs", "band", "dance"],
  };
  for (const i of learner.interests.map((x) => x.toLowerCase())) {
    for (const [k, words] of Object.entries(synonyms)) if (keys.includes(k) && words.some((w) => i.includes(w))) return k;
  }
  return "default";
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
      return ok
        ? { score: 1, verdict: "correct", feedback: q.explanation }
        : { score: 0, verdict: "incorrect", feedback: `It's ${q.answer}. ${q.explanation}`, misconception: `Mixed up ${q.answer.toLowerCase()} with ${q.options[pick].toLowerCase()}` };
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
          maxTokens: 600,
          prompt: `Grade the learner's spoken answer by meaning, not wording. ${learnerContext(learner)}
Question: ${q.prompt}
Model answer: ${q.answer}
Key points of the concept: ${concept.keyPoints.join(" | ")}
Learner said: "${a}"
Return JSON: {"score": number 0-1, "verdict": "correct" | "partial" | "incorrect", "feedback": string (spoken, 1-2 sentences, kind and specific, at their level), "misconception": string or "" (a short note of the specific misunderstanding, if any, e.g. "Mixed up mitosis and meiosis")}`,
        }),
      );
      if (typeof out?.score === "number") {
        return { score: Math.max(0, Math.min(1, out.score)), verdict: out.verdict ?? verdictFor(out.score), feedback: String(out.feedback ?? q.explanation), misconception: out.misconception || undefined };
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
  // Longest option text that appears in the answer wins ("metaphase" vs "phase").
  let best: number | undefined;
  let bestLen = 0;
  options.forEach((o, i) => {
    const t = o.toLowerCase().replace(/[^\w\s]/g, " ").trim();
    if (t && a.includes(t) && t.length > bestLen) {
      best = i;
      bestLen = t.length;
    }
  });
  return best;
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
  if (llm) {
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
  }
  return templateStory(child, lesson);
}

const WORLDS: Array<{ match: RegExp; hero: string; place: string; friend: string; treasure: string }> = [
  { match: /dino/i, hero: "a little triceratops named Tiko", place: "Fern Valley, where the volcano only ever puffed sleepy clouds", friend: "Rosa the stegosaurus", treasure: "a shiny, star-shaped pebble" },
  { match: /space|rocket|planet|star/i, hero: "a tiny astronaut named Nova", place: "a cosy moon base on the edge of the Milky Way", friend: "Bleep the robot", treasure: "a glowing moon rock" },
  { match: /car|truck|train/i, hero: "a little red train named Ruby", place: "the busy town of Whistle Hill", friend: "Max the tow truck", treasure: "a gleaming golden bell" },
  { match: /unicorn|horse|pony|magic/i, hero: "a small unicorn named Luna", place: "the Meadow of a Thousand Flowers", friend: "Pip the pony", treasure: "a ribbon that shimmered like a rainbow" },
  { match: /cat|dog|puppy|kitten|animal/i, hero: "a curious puppy named Biscuit", place: "a sunny little town by the sea", friend: "Mittens the cat", treasure: "a bright blue ball that squeaked" },
  { match: /football|soccer|cricket|sport/i, hero: "a young bear named Bo who loved to play ball", place: "the Green Hollow playing field", friend: "Ellie the elephant", treasure: "a brand-new, perfectly round ball" },
];

function templateStory(child: Learner, lesson: string): StoryDraft {
  const w = WORLDS.find((x) => child.interests.some((i) => x.match.test(i))) ?? { hero: "a little fox named Fennel", place: "a quiet wood where the trees hummed lullabies", friend: "Owlbert the owl", treasure: "a beautiful red feather" };
  const heroName = w.hero.split(" named ")[1]?.split(" ")[0] ?? "the little fox";
  const friendName = w.friend.split(" ")[0];
  const l = lesson.toLowerCase();
  let middle: string[];
  let question: string;
  if (/steal|taking|take things|theft|rob/.test(l)) {
    middle = [
      `One afternoon, ${heroName} spotted ${w.treasure} sitting all alone. It belonged to ${w.friend}. "Nobody is looking," whispered a little voice inside. "You could just take it." So ${heroName} picked it up and hurried home.`,
      `But that evening, ${heroName}'s tummy felt twisty and heavy. Through the window, ${friendName} was searching everywhere, looking sad. ${heroName} looked at the treasure. It didn't feel shiny anymore. It felt like a secret that was too big to carry.`,
      `So ${heroName} took a deep breath, walked over, and held it out. "I took this. I'm sorry." ${friendName} was quiet for a moment, and then smiled. "Thank you for bringing it back. That was brave." The twisty feeling melted away like snow in the sun.`,
    ];
    question = `Why do you think ${heroName}'s tummy felt twisty, and how did it feel after giving the treasure back?`;
  } else if (/shar/.test(l)) {
    middle = [
      `One day, ${heroName} found ${w.treasure}, the best thing in the whole of ${w.place.split(",")[0]}. "It's all mine," ${heroName} said, holding it tight.`,
      `${w.friend} came by and asked, "Can I see it too?" ${heroName} hid it away. But playing alone wasn't much fun, and soon ${heroName} felt lonely.`,
      `So ${heroName} came back and said, "Let's take turns." They laughed and played until the sky turned pink. Sharing, ${heroName} discovered, made the fun twice as big.`,
    ];
    question = `What happened to the fun when ${heroName} decided to share?`;
  } else if (/brave|scared|fear|afraid|courage/.test(l)) {
    middle = [
      `${heroName} was afraid of the dark path that led home. "What if something is out there?" ${heroName} worried.`,
      `${w.friend} said, "Being brave doesn't mean you're not scared. It means you take one small step anyway." So ${heroName} took one small step, then another.`,
      `The path wasn't so scary after all. There were fireflies lighting the way like tiny lanterns. ${heroName} smiled. One small step at a time, anything is possible.`,
    ];
    question = `What small brave step could you take tomorrow?`;
  } else {
    middle = [
      `One day, ${heroName} had a choice to make. The easy way would have been quicker, but ${heroName} remembered something important: ${lesson.replace(/\.$/, "")}.`,
      `It wasn't easy. ${heroName} felt unsure for a while. But ${w.friend} was watching, and when ${heroName} did the right thing, ${friendName}'s face lit up.`,
      `"I'm proud of you," said ${friendName}. And ${heroName} felt proud too, warm all the way down to the tips of the toes.`,
    ];
    question = `What did ${heroName} learn today?`;
  }
  return {
    title: `${heroName} and the ${/steal|taking|rob/.test(l) ? "Borrowed Treasure" : /shar/.test(l) ? "Best Thing to Share" : /brave|scared|fear|afraid/.test(l) ? "Dark Path Home" : "Right Choice"}`,
    pages: [
      `Once upon a time, in ${w.place}, there lived ${w.hero}. ${heroName}'s best friend was ${w.friend}.`,
      ...middle,
      `That night, ${heroName} curled up, snug and warm, and drifted off to sleep. Goodnight, ${heroName}. And goodnight, ${child.name}.`,
    ],
    question,
  };
}

// ------------------------------------------------------------------ small helpers

function lcFirst(s: string) {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}
function capitalize(s: string) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
function firstWords(s: string, n: number) {
  return s.split(/\s+/).slice(0, n).join(" ").replace(/[,.;:]$/, "");
}
