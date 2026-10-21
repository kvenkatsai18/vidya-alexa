import assert from "node:assert/strict";
import { it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Llm } from "../src/domain/llm.ts";
import { Mentor } from "../src/domain/mentor.ts";
import { Store } from "../src/domain/store.ts";
import { createStudyBuddyServer } from "../src/server.ts";
import { CELL_DIVISION_DECK } from "./fixtures/cell-division.deck.ts";

type R = Record<string, any>;

function models() {
  const asked: string[] = [];
  const writer: Llm = {
    name: "writer",
    async complete(req) {
      asked.push(req.purpose);
      if (/study deck/.test(req.purpose)) return JSON.stringify({ title: "Cell division", subject: "Biology", concepts: CELL_DIVISION_DECK.concepts.slice(0, 4) });
      if (/Explain research/.test(req.purpose)) return JSON.stringify({ title: "Cell division today", overview: "Beyond your notes.", cards: [{ heading: "CRISPR", body: "Gene editing.", example: "x" }, { heading: "Cancer", body: "Checkpoints.", example: "y" }, { heading: "Myth", body: "Interphase isn't rest.", example: "z" }] });
      return "{}";
    },
  };
  const researcher: Llm = { name: "web", complete: async () => "{}", research: async () => ({ text: "Findings about cell division.", sources: [{ url: "https://www.nih.gov/x", domain: "www.nih.gov" }] }) };
  return { writer, researcher, asked };
}

async function connect(m: ReturnType<typeof models>) {
  const store = new Store({ dir: null });
  const mentor = new Mentor(store);
  const server = createStudyBuddyServer(mentor, { llm: m.writer, researcher: m.researcher });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: R = {}): Promise<R> => (await client.callTool({ name, arguments: args })).structuredContent as R;
  return { call, store, mentor };
}

/** The overnight routine leaves someone who only just set up alone; these learners joined yesterday. */
const joinedYesterday = (store: Store) => store.update((s) => s.learners.forEach((l) => (l.createdAt = new Date(Date.now() - 26 * 3600_000).toISOString())));

it("works ahead on its own: builds a study set for an upcoming test, researches it, and plans the day", async () => {
  const m = models();
  const { call, store, mentor } = await connect(m);
  await call("set_up_learner", { name: "Priya", level: "Grade 10", exam_title: "Biology test", exam_subject: "Biology", exam_in_days: 5 });
  assert.equal(store.get().decks.length, 0);
  assert.equal((await mentor.dailyRoutine(m.writer, m.researcher)).length, 0, "not while they're still setting up");
  joinedYesterday(store);

  const [b] = await mentor.dailyRoutine(m.writer, m.researcher);
  assert.equal(b.kind, "briefing");
  assert.deepEqual((b.did as R[]).map((x) => x.kind), ["study_set", "research", "plan"]);
  const s = store.get();
  assert.equal(s.decks.length, 1, "a study set was built without anyone asking");
  assert.deepEqual(s.learners[0].exams[0].deckIds, [s.decks[0].id], "linked to the test");
  assert.equal(s.decks[0].research!.length, 1, "and researched beyond the notes");

  const again = await mentor.dailyRoutine(m.writer, m.researcher);
  assert.equal(again.length, 0, "once a day");

  const t = await call("get_today");
  assert.match(t.speech, /While you were away, I made a study set for your Biology test and found 3 new things about cell division\./);
  assert.ok(t.briefing.did.length >= 2);
  const t2 = await call("get_today");
  assert.doesNotMatch(t2.speech, /While you were away/, "said once");
});

it("'prepare my day' runs it on request and keeps going if one step fails", async () => {
  const m = models();
  m.researcher.research = async () => { throw new Error("AccessDeniedException"); };
  const { call } = await connect(m);
  await call("set_up_learner", { name: "Sam", level: "Grade 9", exam_title: "History test", exam_in_days: 3 });
  const r = await call("prepare_my_day");
  assert.equal(r.kind, "briefing");
  assert.deepEqual(r.did.map((x: R) => x.kind), ["study_set", "plan"], "research was skipped, the rest still ran");
  assert.match(r.speech, /While you were away, I made a study set for your History test\. Today: /);
});

it("links your own notes to an upcoming exam instead of building a duplicate overnight", async () => {
  const m = models();
  const { call, store, mentor } = await connect(m);
  // As Nova sent it in live testing: an exam with a title but no subject.
  await call("set_up_learner", { name: "Venkat", level: "2nd year engineering", exam_title: "Biology exam", exam_in_days: 4 });
  await call("add_material", { title: "Cell division notes", text: "x ".repeat(100) });
  const s = store.get();
  assert.equal(s.decks.length, 1);
  assert.deepEqual(s.learners[0].exams[0].deckIds, [s.decks[0].id], "Biology notes are linked to the Biology exam");
  m.asked.length = 0;
  joinedYesterday(store);
  const [b] = await mentor.dailyRoutine(m.writer, m.researcher);
  assert.equal(store.get().decks.length, 1, "no duplicate study set");
  assert.ok(!m.asked.some((p) => /Build a study deck/.test(p)));
  assert.ok((b.did as R[]).some((x) => x.kind === "research" && /Cell division/.test(x.text)), "research is about your real notes");
});
