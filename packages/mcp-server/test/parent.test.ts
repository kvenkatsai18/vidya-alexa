import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
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

async function connect() {
  const store = new Store({ dir: null });
  const server = createStudyBuddyServer(new Mentor(store), { llm: null });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { store, call: async (name: string, args: R = {}): Promise<R> => (await client.callTool({ name, arguments: args })).structuredContent as R };
}

describe("parent mode", () => {
  it("a worrying message still reaches the parent when the assistant never said who's talking", async () => {
    const { call, store } = await connect();
    await call("parent_setup", { parent_name: "Asha", relation: "Mom", child: "Leo", age: 6, interests: ["dinosaurs"] });
    const r = await call("record_turn", { heard: "nobody at school wants to play with me and I feel sad", said: "..." });
    assert.equal(r.concern.guardian, "Mom");
    assert.equal(r.concern.alerted, true);
    assert.equal(store.get().concerns?.[0].category, "bullying");
    const t = await call("get_today", { name: "Leo" });
    assert.equal(t.kind, "meet", "get_today with the speaker's name switches to them");
  });

  it("ignores an age that doesn't fit the class (an assistant's guess), so under-13 rules aren't triggered by mistake", async () => {
    const { call, store } = await connect();
    await call("set_up_learner", { name: "Priya", level: "10th grade", age: 12 });
    const p = store.get().learners.find((l) => l.name === "Priya")!;
    assert.equal(p.age, undefined);
    assert.equal(p.band, "high");
    await call("set_up_learner", { name: "Mia", level: "Grade 4", age: 9 });
    assert.equal(store.get().learners.find((l) => l.name === "Mia")!.age, 9, "a fitting age is kept");
  });

  it("never claims to alert a parent when none is linked", async () => {
    const { call, store } = await connect();
    await call("set_up_learner", { name: "Priya", level: "Grade 10", age: 15 });
    const r = await call("flag_concern", { category: "bullying", severity: "watch", summary: "Kids at school make fun of her" });
    assert.equal(r.alerted, false);
    assert.equal(r.guardian, null);
    assert.doesNotMatch(r.speech, /letting|I'll let|I'm going to tell/);
    assert.match(r.speech, /Please tell an adult you trust, like a parent, a teacher, or your school counselor/);
    assert.match(r.speech, /talk about it, or take a break/);
    assert.equal(store.get().concerns?.length, 1, "still saved, so a parent who links later can see it");
  });

  it("a parent sets up a child, and the child is greeted with what we know and asked something fun", async () => {
    const { call, store } = await connect();
    const saved = await call("parent_setup", { parent_name: "Asha", relation: "Mom", child: "Leo", age: 6, level: "Class 1", interests: ["dinosaurs"], notes: ["He gets shy with new things"] });
    assert.equal(saved.kind, "parent_saved");
    assert.equal(saved.child.band, "early");
    assert.match(saved.speech, /When Leo talks to me, I'll say hi/);
    assert.equal(store.get().activeLearnerId, undefined, "the parent is talking; the device doesn't switch to the child");

    const meet = await call("switch_learner", { name: "Leo" });
    assert.equal(meet.kind, "meet");
    assert.match(meet.speech, /Your mom told me you're in class 1 and you love dinosaurs/);
    assert.equal(meet.question, "What's your favourite dinosaur?");

    const again = await call("get_today");
    assert.notEqual(again.kind, "meet", "the warm intro happens once");

    const leo = store.get().learners.find((l) => l.name === "Leo")!;
    assert.ok(leo.memories.some((m) => m.source === "parent" && m.kind === "struggle" && /shy/.test(m.text)));
  });

  it("a teen introducing themselves after a parent set them up is met, not re-onboarded", async () => {
    const { call } = await connect();
    await call("parent_setup", { parent_name: "Raj", relation: "Dad", child: "Priya", level: "Grade 10", interests: ["cricket"], exam_title: "Biology test", exam_subject: "Biology", exam_in_days: 5 });
    const meet = await call("set_up_learner", { name: "Priya", level: "Grade 10" });
    assert.equal(meet.kind, "meet");
    assert.match(meet.speech, /Your dad told me/);
    assert.match(meet.question, /cricketer/);
  });

  it("teens default to a summary; a parent can switch to full history, and the teen is told", async () => {
    const { call } = await connect();
    await call("parent_setup", { parent_name: "Raj", relation: "Dad", child: "Priya", level: "Grade 10", interests: ["cricket"] });
    const meet = await call("switch_learner", { name: "Priya" });
    assert.match(meet.speech, /your dad can see how your studying is going, and if anything serious comes up, I'll let him know/);
    await call("remember", { fact: "I have a crush on someone in my class", kind: "personal" });
    await call("add_material", { title: "Cell division", text: NOTES });
    await call("start_quiz", { count: 2 });
    await call("answer_question", { answer: "prophase" });
    await call("answer_question", { answer: "S phase" });

    let view = await call("parent_overview", { child: "Priya" });
    assert.equal(view.visibility, "summary");
    assert.equal(view.accuracy, 50);
    assert.ok(!JSON.stringify(view).includes("crush"), "summary mode shows topics and progress, not every word");
    await assert.rejects(async () => {
      const h = await call("parent_history", { child: "Priya" });
      if (h.kind === "error") throw new Error(h.speech);
    }, /set to summary/);

    const set = await call("parent_settings", { child: "Priya", visibility: "full" });
    assert.match(set.speech, /I'll let Priya know too/);
    view = await call("parent_overview", { child: "Priya" });
    assert.ok(view.sharedWithMe.some((m: string) => /crush/.test(m)), "full mode shows what the child shared");
    const next = await call("get_today");
    assert.match(next.speech, /your dad can now see our full chats/, "the teen is told about the change");
  });

  it("under 13 is fully visible by default, with conversation history", async () => {
    const { call } = await connect();
    await call("parent_setup", { parent_name: "Asha", relation: "Mom", child: "Leo", age: 6, interests: ["dinosaurs"] });
    const meet = await call("switch_learner", { name: "Leo" });
    assert.match(meet.speech, /Your mom can see what we talk about, so she can help too/);
    await call("record_turn", { heard: "T-rex is my favourite", said: "T-rex! Great choice." });
    const h = await call("parent_history", { child: "Leo" });
    assert.equal(h.kind, "parent_history");
    assert.equal(h.turns[0].heard, "T-rex is my favourite");
  });

  it("adapts to mood: tired means a short, gentle session today", async () => {
    const { call } = await connect();
    await call("set_up_learner", { name: "Sam", level: "Grade 9" });
    await call("add_material", { title: "Cell division", text: NOTES });
    const mood = await call("remember", { fact: "I'm so tired today", kind: "mood" });
    assert.equal(mood.mood, "tired");
    const quiz = await call("start_quiz", {});
    assert.equal(quiz.total, 3);
    assert.match(quiz.speech, /nice and relaxed/);
  });

  it("safety: a child's serious words get a caring reply and go straight to the parent, first thing", async () => {
    const { call } = await connect();
    await call("parent_setup", { parent_name: "Asha", relation: "Mom", child: "Leo", age: 9, interests: ["football"] });
    await call("switch_learner", { name: "Leo" });
    await call("add_material", { title: "Cell division", text: NOTES });
    await call("start_quiz", {});
    const reply = await call("answer_question", { answer: "I don't care, the kids at school make fun of me every day" });
    assert.equal(reply.kind, "concern_flagged", "not graded as a quiz answer");
    assert.equal(reply.category, "bullying");
    assert.match(reply.speech, /not okay|not your fault/);
    assert.match(reply.speech, /your mom/);

    const logged = await call("record_turn", { heard: "sometimes I want to die", said: "..." });
    assert.equal(logged.concern.category, "self_harm");
    assert.match(logged.concern.speech, /grown-up/, "young children are pointed to a grown-up nearby (988 is offered to older kids)");

    const view = await call("parent_overview", { child: "Leo" });
    assert.match(view.speech, /^Before anything else/);
    assert.equal(view.concerns.length, 2);
    assert.equal(view.concerns[0].category, "self_harm");
    const seen = await call("parent_overview", { child: "Leo" });
    assert.ok(seen.concerns.every((c: R) => !c.isNew), "marked as seen once the parent has looked");
  });

  it("safety: figures of speech aren't flagged, and adults aren't reported to anyone", async () => {
    const { call } = await connect();
    await call("set_up_learner", { name: "Rahul", level: "2nd year engineering", age: 20 });
    const ok = await call("record_turn", { heard: "I'm dying to know the answer, I killed that quiz", said: "" });
    assert.equal(ok.concern, null);
    const adult = await call("record_turn", { heard: "I feel so hopeless lately", said: "" });
    assert.equal(adult.concern.alerted, false, "an adult's concern isn't sent to a parent");
    assert.match(adult.concern.speech, /someone you trust/);
  });
});
