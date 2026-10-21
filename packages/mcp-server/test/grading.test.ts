import assert from "node:assert/strict";
import { it } from "node:test";
import { grade } from "../src/domain/generate.ts";
import type { Llm } from "../src/domain/llm.ts";
import type { Concept, Learner, Question } from "../src/domain/types.ts";

const learner = { id: "l", name: "Venkat", role: "student", level: "2nd year engineering", band: "college", subjects: [], interests: [], stylesThatWorked: [], memories: [], exams: [], streak: { current: 0, best: 0 }, minutesStudied: 0, createdAt: "" } as Learner;
const concept = { id: "c", deckId: "d", title: "Meiosis", summary: "Makes four unique haploid cells.", keyPoints: ["Two divisions", "Four haploid cells"], confusableWith: ["mitosis"], flashcards: [], questions: [] } as unknown as Concept;
const q: Question = { id: "q", type: "mcq", prompt: "Which division makes gametes?", options: ["Mitosis", "Meiosis", "Binary fission", "Budding"], answer: "Meiosis", explanation: "Meiosis makes gametes." };

it("grades a clear multiple-choice pick exactly, without the model", async () => {
  assert.equal((await grade(null, learner, concept, q, "B")).verdict, "correct");
  assert.equal((await grade(null, learner, concept, q, "it's meiosis")).verdict, "correct");
  const wrong = await grade(null, learner, concept, q, "mitosis");
  assert.equal(wrong.verdict, "incorrect");
  assert.match(wrong.misconception!, /Mixed up meiosis with mitosis/);
});

it("lets the model judge an answer that names more than one option", async () => {
  const asked: string[] = [];
  const llm: Llm = { name: "m", complete: async (req) => { asked.push(req.prompt); return JSON.stringify({ score: 0, verdict: "incorrect", feedback: "Meiosis makes four different cells, not two identical ones.", misconception: "Confused meiosis with mitosis" }); } };
  const g = await grade(llm, learner, concept, q, "I think meiosis makes two identical cells, same as mitosis");
  assert.equal(g.verdict, "incorrect", "it was graded correct before the fix");
  assert.equal(asked.length, 1);
  assert.equal(g.misconception, "Confused meiosis with mitosis");
});

it("never marks an answer with a wrong claim as correct, and grades at temperature 0", async () => {
  let temp: number | undefined;
  const lenient: Llm = { name: "m", complete: async (req) => { temp = req.temperature; return JSON.stringify({ errors: ["meiosis makes two identical cells"], score: 0.9, verdict: "correct", feedback: "Exactly.", misconception: "" }); } };
  const open: Question = { id: "q2", type: "short", prompt: "What does meiosis produce?", answer: "Four genetically different haploid cells", explanation: "" };
  const g = await grade(lenient, learner, concept, open, "two identical cells, same as mitosis");
  assert.equal(temp, 0);
  assert.equal(g.verdict, "partial");
  assert.ok(g.score <= 0.5);
  assert.match(g.misconception!, /^Thought meiosis makes two identical cells/);
});

it("phrases a number mix-up so it makes sense the next day", async () => {
  const count: Question = { id: "q3", type: "mcq", prompt: "How many cells does meiosis make?", options: ["Two", "Four", "Eight", "One"], answer: "Four", explanation: "Four haploid cells." };
  const g = await grade(null, learner, concept, count, "two");
  assert.equal(g.misconception, "Said two instead of four in meiosis");
  assert.match(g.feedback, /^It's four\./);
});
