import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Llm, LlmRequest } from "../src/domain/llm.ts";
import { Mentor } from "../src/domain/mentor.ts";
import { Store } from "../src/domain/store.ts";
import { createStudyBuddyServer } from "../src/server.ts";
import { CELL_DIVISION_DECK } from "./fixtures/cell-division.deck.ts";

type R = Record<string, any>;
const here = path.dirname(fileURLToPath(import.meta.url));
const NOTES = readFileSync(path.join(here, "../content/cell-division.md"), "utf8");

/** A scripted model that records every prompt it gets. */
function scriptedModel() {
  const prompts: LlmRequest[] = [];
  let regrade = { overturned: true, score: 1, feedback: "You're right, S phase is where DNA is copied.", lesson: "Accept S phase as the stage where DNA is copied" };
  const llm: Llm = {
    name: "scripted",
    async complete(req) {
      prompts.push(req);
      if (/study deck/.test(req.purpose)) return JSON.stringify({ title: CELL_DIVISION_DECK.title, subject: CELL_DIVISION_DECK.subject, concepts: CELL_DIVISION_DECK.concepts });
      if (/Grade a spoken answer/.test(req.purpose)) return JSON.stringify({ score: 0, verdict: "incorrect", feedback: "Not quite.", misconception: "Mixed up S phase with G2" });
      if (/Re-check/.test(req.purpose)) return JSON.stringify(regrade);
      return "{}";
    },
  };
  return { llm, prompts, setRegrade: (r: typeof regrade) => (regrade = r) };
}

async function connect(llm: Llm | null) {
  const store = new Store({ dir: null });
  const server = createStudyBuddyServer(new Mentor(store), { llm });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: R = {}): Promise<R> => (await client.callTool({ name, arguments: args })).structuredContent as R;
  return { call, store };
}

it("learns what to call you, and still recognizes you by your old name", async () => {
  const { call, store } = await connect(null);
  await call("set_up_learner", { name: "Priya", level: "Grade 10" });
  const r = await call("learn_from_feedback", { lesson: "", preferred_name: "Priya A" });
  assert.equal(r.kind, "lesson_learned");
  assert.match(r.speech, /Got it, Priya A/);
  assert.equal(store.get().learners[0].name, "Priya A");
  const t = await call("get_today");
  assert.match(t.speech, /Priya A/);
  assert.ok(t.lessons.some((x: R) => /Call them Priya A/.test(x.text)));
  assert.match(t.voiceGuide, /corrected you before/);
  const again = await call("switch_learner", { name: "Priya" });
  assert.equal(again.learner.name, "Priya A", "the old name still finds her");
});

it("keeps both lessons when one sentence has two corrections", async () => {
  const { call, store } = await connect(null);
  await call("set_up_learner", { name: "Priya", level: "Grade 10" });
  const r = await call("learn_from_feedback", { lesson: "Keep explanations under 3 sentences", kind: "style", preferred_name: "Priya A" });
  assert.match(r.speech, /Got it, Priya A.*keep that in mind too/);
  assert.deepEqual(store.get().learners[0].lessons!.map((x) => x.text), ["Call them Priya A, not Priya", "Keep explanations under 3 sentences"]);
  const p = await call("get_profile");
  assert.match(p.speech, /you've taught me one thing about helping you, like: keep explanations under 3 sentences/);
});

it("catches corrections in what you say, even if the assistant didn't save them", async () => {
  const { call, store } = await connect(null);
  await call("set_up_learner", { name: "Sam", level: "Grade 9" });
  const a = await call("record_turn", { heard: "that's way too long", said: "..." });
  assert.equal(a.learned.lesson, "Keep explanations short");
  await call("record_turn", { heard: "honestly that was too long again", said: "..." });
  const b = await call("record_turn", { heard: "please stop using cricket examples", said: "..." });
  assert.equal(b.learned.lesson, "Don't use cricket examples");
  await call("record_turn", { heard: "just call me Sammy", said: "..." });
  const l = store.get().learners[0];
  assert.equal(l.name, "Sammy");
  assert.deepEqual(l.lessons!.map((x) => x.text), ["Keep explanations short", "Don't use cricket examples", "Call them Sammy, not Sam"], "no duplicates");
  assert.ok(l.lessons!.every((x) => x.source === "detected"));
  const p = await call("get_profile");
  assert.equal(p.lessons.length, 3);
});

it("owns a grading mistake: re-checks, fixes the score and the recorded mistake, and grades fairly next time", async () => {
  const m = scriptedModel();
  const { call, store } = await connect(m.llm);
  await call("set_up_learner", { name: "Priya", level: "Grade 10" });
  await call("add_material", { title: "Cell division", text: NOTES });
  await call("start_quiz", { topic: "interphase" });
  // Worded so it doesn't match a multiple-choice option exactly, so the model grades it (wrongly).
  await call("answer_question", { answer: "the stage where the cell makes a copy of its genetic material" });
  const before = store.get().mastery.flatMap((x) => x.misconceptions);
  assert.ok(before.some((x) => x.text === "Mixed up S phase with G2"), "the wrong grade recorded a mistake");

  const r = await call("recheck_answer", { reason: "S phase is literally when DNA is copied" });
  assert.equal(r.kind, "recheck");
  assert.equal(r.overturned, true);
  assert.match(r.speech, /You're right.*fixed your score.*grade that kind of answer fairly/);
  const after = store.get().mastery.flatMap((x) => x.misconceptions);
  assert.ok(!after.some((x) => x.text === "Mixed up S phase with G2"), "the false mistake is gone, so it won't come back tomorrow");
  const q = store.get().quizzes.at(-1)!;
  assert.equal(q.results.at(-1)!.corrected, true);

  // The lesson reaches the model next time it grades.
  await call("answer_question", { answer: "something else" });
  const lastGrade = m.prompts.filter((p) => /Grade a spoken answer/.test(p.purpose)).at(-1)!;
  assert.match(lastGrade.prompt, /Accept S phase as the stage where DNA is copied/);
});

it("doesn't give in when the answer really was wrong", async () => {
  const m = scriptedModel();
  m.setRegrade({ overturned: false, score: 0, feedback: "I checked again: interphase is when the cell copies its DNA, not prophase.", lesson: "" });
  const { call, store } = await connect(m.llm);
  await call("set_up_learner", { name: "Priya", level: "Grade 10" });
  await call("add_material", { title: "Cell division", text: NOTES });
  await call("start_quiz", { topic: "interphase" });
  await call("answer_question", { answer: "prophase" });
  const r = await call("recheck_answer", {});
  assert.equal(r.overturned, false);
  assert.match(r.speech, /checked again/);
  assert.ok(!(store.get().learners[0].lessons ?? []).some((x) => x.kind === "grading"));
});

it("researches beyond the notes with sources, explained for this learner, and saves it with the study set", async () => {
  const m = scriptedModel();
  const prompts: string[] = [];
  const researcher: Llm = {
    name: "web",
    complete: async () => "{}",
    research: async (req) => {
      prompts.push(req.prompt);
      return { text: "CRISPR-based gene editing is used to treat sickle cell disease (approved 2023). Cells copy DNA in S phase...", sources: [{ url: "https://www.nih.gov/crispr", domain: "www.nih.gov" }, { url: "https://www.nature.com/articles/x", domain: "www.nature.com" }] };
    },
  };
  const writerPrompts: string[] = [];
  const writer: Llm = {
    name: "writer",
    complete: async (req) => {
      if (/Explain research/.test(req.purpose)) {
        writerPrompts.push(req.prompt);
        return JSON.stringify({ title: "Cell division in the real world", overview: "Your notes stop at the phases; here's where it matters today.", cards: [{ heading: "Gene editing", body: "Doctors edit cells to treat sickle cell disease.", example: "Like fixing one wrong player in a cricket line-up." }, { heading: "Cancer", body: "Checkpoints failing lets cells divide nonstop.", example: "Like a bowler who never stops bowling." }] });
      }
      return m.llm.complete(req);
    },
  };
  const store = new Store({ dir: null });
  const server = createStudyBuddyServer(new Mentor(store), { llm: writer, researcher });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: R = {}): Promise<R> => (await client.callTool({ name, arguments: args })).structuredContent as R;
  await call("set_up_learner", { name: "Priya", level: "Grade 10", interests: ["cricket"] });
  await call("add_material", { title: "Cell division", text: NOTES });
  const r = await call("research_topic", {});
  assert.equal(r.kind, "research");
  assert.equal(r.topic, "Cell division");
  assert.equal(r.cards.length, 2);
  assert.deepEqual(r.sources.map((x: R) => x.domain), ["www.nih.gov", "www.nature.com"]);
  assert.match(r.speech, /2 things beyond your notes, from 2 sources/);
  assert.match(prompts[0], /Grade 10/);
  assert.match(prompts[0], /notes already cover: The cell cycle/);
  assert.match(writerPrompts[0], /cricket/, "examples come from the learner's interests");
  assert.equal(store.get().decks[0].research!.length, 1, "saved with the study set");
});

it("says plainly when web research isn't switched on", async () => {
  const m = scriptedModel();
  const denied: Llm = { name: "web", complete: async () => "{}", research: async () => { throw new Error("AccessDeniedException: not authorized to perform: bedrock:InvokeTool"); } };
  const store = new Store({ dir: null });
  const server = createStudyBuddyServer(new Mentor(store), { llm: m.llm, researcher: denied });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: R = {}): Promise<R> => (await client.callTool({ name, arguments: args })).structuredContent as R;
  await call("set_up_learner", { name: "Priya", level: "Grade 10" });
  const r = await call("research_topic", { topic: "black holes" });
  assert.equal(r.kind, "error");
  assert.match(r.speech, /web search, and it isn't switched on/);
});

it("never saves a lesson the learner didn't ask for (\"stop\" is not \"keep it shorter\")", async () => {
  const { call, store } = await connect(null);
  await call("set_up_learner", { name: "Venkat", level: "Grade 10" });
  // What happened in live testing: they said "stop", and the AI invented a lesson.
  const invented = await call("learn_from_feedback", { lesson: "Don't explain in this style, keep it shorter and more engaging", kind: "style", learner_said: "stop" });
  assert.equal(invented.kind, "lesson_skipped");
  assert.equal(invented.saved, false);
  const noName = await call("learn_from_feedback", { lesson: "", preferred_name: "Venkat K", learner_said: "explain photosynthesis" });
  assert.equal(noName.kind, "lesson_skipped", "no name change unless they asked to be called something");
  assert.equal(store.get().learners[0].name, "Venkat");
  assert.equal((store.get().learners[0].lessons ?? []).length, 0);

  const real = await call("learn_from_feedback", { lesson: "Keep explanations short", kind: "style", learner_said: "that was way too long" });
  assert.equal(real.kind, "lesson_learned");
  const name = await call("learn_from_feedback", { lesson: "", preferred_name: "Venkat K", learner_said: "please call me Venkat K" });
  assert.equal(name.kind, "lesson_learned");
  assert.equal(store.get().learners[0].name, "Venkat K");
});
