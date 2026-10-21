import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Mentor } from "../src/domain/mentor.ts";
import { Store } from "../src/domain/store.ts";
import { createStudyBuddyServer } from "../src/server.ts";
import { useOfflineEngine } from "../src/domain/generate.ts";
import { offlineEngine } from "./fixtures/offline-engine.ts";

// Tests use scripted stand-ins for the model; the product generates everything live.
useOfflineEngine(offlineEngine);

type R = Record<string, any>;
const here = path.dirname(fileURLToPath(import.meta.url));
const NOTES = readFileSync(path.join(here, "../content/cell-division.md"), "utf8");

it("Study Together: turns, level-matched questions, scoring with streaks, guests leave no trace", async () => {
  const store = new Store({ dir: null });
  const server = createStudyBuddyServer(new Mentor(store), { llm: null });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: R = {}): Promise<R> => (await client.callTool({ name, arguments: args })).structuredContent as R;

  await call("parent_setup", { parent_name: "Asha", relation: "Mom", child: "Leo", age: 6, interests: ["dinosaurs"] });
  await call("set_up_learner", { name: "Priya", level: "Grade 10" });
  await call("add_material", { title: "Cell division", text: NOTES });

  let q = await call("start_group_quiz", { players: ["Leo", "Sam"], turns_each: 2 });
  assert.equal(q.kind, "group_question");
  assert.deepEqual(q.players.map((p: R) => p.name), ["Priya", "Leo", "Sam"], "the current learner joins automatically");
  assert.equal(q.players.find((p: R) => p.name === "Sam").guest, true);
  assert.match(q.speech, /playing as a guest/);
  assert.equal(q.currentPlayer, "Priya");
  assert.equal(q.question.type, "short", "a 10th grader gets an explain-in-your-own-words question");

  const answerFor = (qq: R) => {
    if (qq.question.type === "truefalse") return /resting|no way|two identical|46 chromosomes into 23|breaks down during telophase/.test(qq.question.prompt) ? "false" : "true";
    return "I'm not sure";
  };
  q = await call("group_answer", { answer: "I'm not sure" }); // Priya
  assert.equal(q.currentPlayer, "Leo");
  assert.equal(q.question.type, "truefalse", "a 6-year-old gets true/false");
  q = await call("group_answer", { answer: answerFor(q) }); // Leo
  assert.equal(q.feedback.player, "Leo");
  assert.equal(q.currentPlayer, "Sam");
  q = await call("group_action", { action: "skip" }); // Sam
  q = await call("group_answer", { answer: "I'm not sure" }); // Priya
  q = await call("group_answer", { answer: answerFor(q) }); // Leo
  q = await call("group_answer", { answer: "dunno" }); // Sam, last turn
  assert.equal(q.kind, "group_summary");
  const leo = q.players.find((p: R) => p.name === "Leo");
  assert.ok(leo.winner, "Leo wins");
  assert.equal(leo.score, 5, "2 + 2 + streak bonus");
  assert.match(q.speech, /Leo wins with 5 points/);

  const s = store.get();
  assert.ok(!s.learners.some((l) => l.name === "Sam"), "guests aren't saved");
  const leoId = s.learners.find((l) => l.name === "Leo")!.id;
  assert.ok(s.mastery.some((m) => m.learnerId === leoId), "Leo's own review schedule updated from the game");
});
