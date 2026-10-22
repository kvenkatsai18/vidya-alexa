import assert from "node:assert/strict";
import { it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Llm, LlmRequest } from "../src/domain/llm.ts";
import { Mentor, whenToDate } from "../src/domain/mentor.ts";
import { Store } from "../src/domain/store.ts";
import { createStudyBuddyServer } from "../src/server.ts";
import { CELL_DIVISION_DECK } from "./fixtures/cell-division.deck.ts";

type R = Record<string, any>;

// Found by talking to it like a person: "huh?" got the same explanation again, "Friday" became Thursday,
// "too easy" only counted from the next turn, and "new questions" took 14 seconds.

function model() {
  const asked: LlmRequest[] = [];
  let live = 0;
  let peak = 0;
  let explained = 0;
  const llm: Llm = {
    name: "m",
    async complete(req) {
      asked.push(req);
      if (/study deck/.test(req.purpose)) return JSON.stringify({ title: "Cell division", subject: "Biology", concepts: CELL_DIVISION_DECK.concepts.slice(0, 3) });
      if (/^Explain /.test(req.purpose)) return JSON.stringify({ explanation: `Explanation number ${++explained}: think of a photocopier.`, analogy: "photocopier", checkQuestion: "What gets copied?" });
      if (/Write new questions/.test(req.purpose)) {
        live++;
        peak = Math.max(peak, live);
        await new Promise((r) => setTimeout(r, 30));
        live--;
        return JSON.stringify({ questions: [1, 2, 3].map((i) => ({ type: "short", prompt: `${req.purpose} ${i}: why?`, answer: "Because", explanation: "" })) });
      }
      return "{}";
    },
  };
  return { llm, asked, peak: () => peak };
}

async function connect(llm: Llm) {
  const store = new Store({ dir: null });
  const server = createStudyBuddyServer(new Mentor(store), { llm });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: R = {}): Promise<R> => (await client.callTool({ name, arguments: args })).structuredContent as R;
  return { call, store };
}

it("works out exam dates from the learner's own words", () => {
  const monday = new Date("2026-10-19T15:00:00Z");
  const tz = "America/Los_Angeles";
  assert.equal(whenToDate("Friday", monday, tz), "2026-10-23");
  assert.equal(whenToDate("this friday", monday, tz), "2026-10-23");
  assert.equal(whenToDate("on Monday", monday, tz), "2026-10-26", "a week away, not today");
  assert.equal(whenToDate("tomorrow", monday, tz), "2026-10-20");
  assert.equal(whenToDate("in 5 days", monday, tz), "2026-10-24");
  assert.equal(whenToDate("next week", monday, tz), "2026-10-26");
  assert.equal(whenToDate("Oct 30", monday, tz), "2026-10-30");
  assert.equal(whenToDate("30th October", monday, tz), "2026-10-30");
  assert.equal(whenToDate("January 5", monday, tz), "2027-01-05", "a date that's passed means next year");
  assert.equal(whenToDate("sometime soon", monday, tz), undefined);
  // Late on Monday evening in California it's already Tuesday in UTC: still Monday for them.
  assert.equal(whenToDate("tomorrow", new Date("2026-10-20T05:30:00Z"), tz), "2026-10-20");
});

it("'my test is on Friday' is saved for Friday, even if the model's day count is off", async () => {
  const { call, store } = await connect(model().llm);
  await call("set_up_learner", { name: "Priya", level: "Grade 10", exam_title: "Biology test", exam_when: "Friday", exam_in_days: 3 });
  const exam = store.get().learners[0].exams[0];
  const day = new Date(`${exam.date}T12:00:00Z`).getUTCDay();
  assert.equal(day, 5, `saved as ${exam.date}`);
});

it("'huh?' gets a fresh angle, not the same explanation again, and 'simpler' is shorter", async () => {
  const m = model();
  const { call } = await connect(m.llm);
  await call("set_up_learner", { name: "Priya", level: "Grade 10", interests: ["cricket"] });
  await call("add_material", { title: "Cell division", text: "Mitosis makes two identical cells. ".repeat(10) });
  const concept = CELL_DIVISION_DECK.concepts[0].title;
  const first = await call("explain_concept", { concept });
  assert.match(first.speech, /Explanation number 1/);
  assert.doesNotMatch(first.speech, /Quick check:/, "no quiz-show phrasing every time");
  await call("explain_concept", { concept, style: "simpler" });
  const prompts = m.asked.filter((r) => /^Explain /.test(r.purpose)).map((r) => r.prompt);
  assert.doesNotMatch(prompts[0], /You just explained it/);
  assert.match(prompts[1], /You just explained it like this[^]*Explanation number 1: think of a photocopier[^]*completely different angle/);
  const limit = (p: string) => Number(p.match(/at most (\d+) words/)![1]);
  assert.ok(limit(prompts[1]) < limit(prompts[0]), "simpler means shorter");
  assert.ok(limit(prompts[0]) <= 70, "a spoken answer, not an essay");
});

it("a correction counts in the same turn: detected before the reply, logged once after", async () => {
  const { call, store } = await connect(model().llm);
  await call("set_up_learner", { name: "Priya", level: "Grade 10" });
  const pre = await call("record_turn", { heard: "These are too easy, give me harder questions", said: "", phase: "heard" });
  assert.match(pre.learned.lesson, /more challenging/);
  assert.equal(store.get().learners[0].lessons!.length, 1);
  assert.equal(store.get().turns?.length ?? 0, 0, "nothing logged before the reply");
  const post = await call("record_turn", { heard: "These are too easy, give me harder questions", said: "Okay, harder ones.", phase: "said" });
  assert.equal(post.learned, null, "not learned twice");
  assert.equal(store.get().learners[0].lessons!.length, 1);
  assert.equal(store.get().turns?.length, 1);
});

it("new questions for several topics are written at the same time, without forcing interests in", async () => {
  const m = model();
  const { call } = await connect(m.llm);
  await call("set_up_learner", { name: "Priya", level: "Grade 10", interests: ["cricket"] });
  await call("add_material", { title: "Cell division", text: "Mitosis makes two identical cells. ".repeat(10) });
  await call("start_quiz", { count: 6, fresh: true });
  assert.ok(m.peak() >= 2, "in parallel");
  const fresh = m.asked.filter((r) => /Write new questions/.test(r.purpose));
  assert.match(fresh[0].prompt, /don't force them into every question/);
  const deck = m.asked.find((r) => /study deck/.test(r.purpose))!;
  assert.match(deck.prompt, /never words like "mastery"/);
});

it("'call me Pri from now on' means Pri, and ending a quiz before answering isn't called a tough round", async () => {
  const { call, store } = await connect(model().llm);
  await call("set_up_learner", { name: "Priya", level: "Grade 10" });
  await call("record_turn", { heard: "oh and just call me Pri from now on", said: "", phase: "heard" });
  assert.equal(store.get().learners[0].name, "Pri");
  await call("record_turn", { heard: "call me Priya A", said: "", phase: "heard" });
  assert.equal(store.get().learners[0].name, "Priya A", "a real second name still counts");
  await call("add_material", { title: "Cell division", text: "Mitosis makes two identical cells. ".repeat(10) });
  await call("start_quiz", { count: 3 });
  const end = await call("quiz_action", { action: "end" });
  assert.doesNotMatch(end.speech, /tough one/);
});

it("'explain enthalpy' is about enthalpy, even when the entropy set mentions it; a quiz on a new topic is written for it", async () => {
  const asked: LlmRequest[] = [];
  const llm: Llm = {
    name: "m",
    async complete(req) {
      asked.push(req);
      const topic = req.prompt.match(/teaches "([^"]+)"/)?.[1];
      if (topic) {
        await new Promise((r) => setTimeout(r, 40));
        const t = topic.charAt(0).toUpperCase() + topic.slice(1);
        return JSON.stringify({ title: t, subject: "Physics", concepts: [{ title: `${t} basics`, summary: /entropy/i.test(t) ? "Disorder. Gibbs free energy links it with enthalpy: dG = dH - TdS." : `What ${t} is.`, keyPoints: ["k"], flashcards: [{ front: "f", back: "b" }], questions: [{ type: "short", prompt: `What is ${t}?`, answer: "a", explanation: "" }] }] });
      }
      if (/^Explain /.test(req.purpose)) return JSON.stringify({ explanation: `About ${req.purpose.slice(8)}.`, analogy: "", checkQuestion: "" });
      return "{}";
    },
  };
  const { call, store } = await connect(llm);
  await call("set_up_learner", { name: "Arjun", level: "2nd year engineering" });
  await call("explain_concept", { concept: "entropy" });
  const r = await call("explain_concept", { concept: "enthalpy" });
  assert.match(r.speech, /About Enthalpy/i, r.speech);
  const q = await call("start_quiz", { topic: "enthalpy" });
  assert.match(q.question.prompt, /What is Enthalpy/i, "quizzed on enthalpy, not entropy");
  assert.deepEqual(store.get().decks.map((d) => d.title).sort(), ["Enthalpy", "Entropy"]);
  await call("quiz_action", { action: "end" });
  const q2 = await call("start_quiz", { topic: "the French Revolution" });
  assert.match(q2.question.prompt, /French Revolution/, "a topic they haven't studied yet gets its own questions");
});

it("an exam mentioned in passing is saved from their words", async () => {
  const { call, store } = await connect(model().llm);
  await call("set_up_learner", { name: "Arjun", level: "2nd year engineering" });
  const r = await call("record_turn", { heard: "I have a thermodynamics exam next Tuesday and honestly I'm kinda panicking", said: "", phase: "heard" });
  assert.equal(r.exam.title, "Thermodynamics exam");
  const exam = store.get().learners[0].exams[0];
  assert.equal(new Date(`${exam.date}T12:00:00Z`).getUTCDay(), 2);
  await call("set_up_learner", { name: "Arjun", exam_title: "Thermodynamics", exam_when: "next Tuesday" });
  assert.equal(store.get().learners[0].exams.length, 1, "the model saving it too doesn't make a second one");
  const past = await call("record_turn", { heard: "I failed my chemistry test on Monday", said: "", phase: "heard" });
  assert.equal(past.exam, null);
});

it("forgets a lesson by what it was about, and only a close match", async () => {
  const { call, store } = await connect(model().llm);
  await call("set_up_learner", { name: "Venkat", level: "College" });
  await call("record_turn", { heard: "that's too long, keep it short", said: "", phase: "heard" });
  await call("remember", { kind: "goal", fact: "Is building a startup about podcasts" });
  await assert.rejects(call("forget", { text: "what is a startup tricky" }).then((r) => { if (!r || r.kind !== "forgotten") throw new Error("not forgotten"); }), "loose word overlap doesn't delete a memory");
  const r = await call("forget", { text: "the short explanations thing" });
  assert.equal(r.kind, "forgotten");
  assert.equal(store.get().learners[0].lessons!.length, 0, "lessons can be forgotten too");
  assert.equal(store.get().learners[0].memories.length, 1);
});

it("a correction caught as they said it isn't answered with 'I've already got that one'", async () => {
  const { call } = await connect(model().llm);
  await call("set_up_learner", { name: "Priya", level: "Grade 10" });
  await call("record_turn", { heard: "These are too easy, give me harder new questions", said: "", phase: "heard" });
  const r = await call("learn_from_feedback", { lesson: "Make questions more challenging", kind: "teaching", learner_said: "These are too easy, give me harder new questions" });
  assert.doesNotMatch(r.speech, /already got that one/);
  assert.match(r.speech, /from now on/);
});
