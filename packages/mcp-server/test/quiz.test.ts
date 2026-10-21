import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Llm } from "../src/domain/llm.ts";
import { Mentor } from "../src/domain/mentor.ts";
import { Store } from "../src/domain/store.ts";
import { createStudyBuddyServer } from "../src/server.ts";
import { CELL_DIVISION_DECK } from "./fixtures/cell-division.deck.ts";

type R = Record<string, any>;
const here = path.dirname(fileURLToPath(import.meta.url));
const NOTES = readFileSync(path.join(here, "../content/cell-division.md"), "utf8");

function model() {
  let n = 0;
  const asked: string[] = [];
  const llm: Llm = {
    name: "m",
    async complete(req) {
      asked.push(req.purpose);
      if (/study deck/.test(req.purpose)) return JSON.stringify({ title: "Cell division", subject: "Biology", concepts: CELL_DIVISION_DECK.concepts.slice(0, 2) });
      if (/Write new questions/.test(req.purpose)) {
        n++;
        return JSON.stringify({ questions: [1, 2, 3].map((i) => ({ type: "short", prompt: `Fresh question ${n}.${i}: why does this matter?`, answer: "Because it does", explanation: "" })) });
      }
      if (/Grade/.test(req.purpose)) return JSON.stringify({ errors: [], score: 1, verdict: "correct", feedback: "Yes.", misconception: "" });
      return "{}";
    },
  };
  return { llm, asked };
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

const prompts = (store: Store) => {
  const s = store.get();
  const q = s.quizzes.at(-1)!;
  return q.queue.map((x) => s.concepts.find((c) => c.id === x.conceptId)!.questions.find((y) => y.id === x.questionId)!.prompt);
};

it("a second quiz doesn't repeat the first one", async () => {
  const m = model();
  const { call, store } = await connect(m.llm);
  await call("set_up_learner", { name: "Priya", level: "Grade 10" });
  await call("add_material", { title: "Cell division", text: NOTES });
  await call("start_quiz", { count: 3 });
  const first = prompts(store);
  await call("quiz_action", { action: "end" });
  await call("start_quiz", { count: 3 });
  const second = prompts(store);
  assert.equal(second.filter((p) => first.includes(p)).length, 0, `repeated: ${second.filter((p) => first.includes(p))}`);
});

it("\"new questions\" writes fresh ones, and runs out never: used-up topics get new questions", async () => {
  const m = model();
  const { call, store } = await connect(m.llm);
  await call("set_up_learner", { name: "Priya", level: "Grade 10" });
  await call("add_material", { title: "Cell division", text: NOTES });
  await call("start_quiz", { count: 2, fresh: true });
  assert.ok(m.asked.some((p) => /Write new questions/.test(p)));
  assert.ok(prompts(store).every((p) => /^Fresh question/.test(p)), `asked: ${prompts(store)}`);

  // Keep quizzing: when every question of a topic was asked recently, new ones are written.
  for (let i = 0; i < 4; i++) {
    await call("quiz_action", { action: "end" });
    await call("start_quiz", { count: 2 });
  }
  const all = store.get().quizzes.flatMap((q) => q.queue.map((x) => x.questionId));
  const lastTwo = store.get().quizzes.slice(-2).flatMap((q) => q.queue.map((x) => x.questionId));
  assert.equal(new Set(lastTwo).size, lastTwo.length);
  assert.ok(store.get().concepts.every((c) => c.questions.length > 3), "pools grew with fresh questions");
  assert.ok(all.length >= 10);
});
