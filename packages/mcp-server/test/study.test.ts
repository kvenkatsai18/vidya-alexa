import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CreateMessageRequestSchema, ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { bandFor } from "../src/domain/levels.ts";
import { Mentor } from "../src/domain/mentor.ts";
import { newMastery, review } from "../src/domain/srs.ts";
import { Store } from "../src/domain/store.ts";
import { CARD_URI, createStudyBuddyServer, MCP_APP_MIME } from "../src/server.ts";
import { useOfflineEngine } from "../src/domain/generate.ts";
import { offlineEngine } from "./fixtures/offline-engine.ts";

// Tests use scripted stand-ins for the model; the product generates everything live.
useOfflineEngine(offlineEngine);

type R = Record<string, any>;
const here = path.dirname(fileURLToPath(import.meta.url));
const NOTES = readFileSync(path.join(here, "../content/cell-division.md"), "utf8");

interface ConnectOpts {
  elicit?: (params: R) => R;
  sample?: (params: R) => string;
}

async function connect(opts: ConnectOpts = {}) {
  const store = new Store({ dir: null });
  const mentor = new Mentor(store);
  // Offline unless the test client offers sampling.
  const server = createStudyBuddyServer(mentor, opts.sample ? {} : { llm: null });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const caps: R = {};
  if (opts.elicit) caps.elicitation = { form: {} };
  if (opts.sample) caps.sampling = {};
  const client = new Client({ name: "test", version: "1" }, { capabilities: caps });
  const sampled: R[] = [];
  if (opts.elicit) client.setRequestHandler(ElicitRequestSchema, async (req) => opts.elicit!(req.params) as any);
  if (opts.sample) {
    client.setRequestHandler(CreateMessageRequestSchema, async (req) => {
      sampled.push(req.params);
      return { role: "assistant", model: "test-model", content: { type: "text", text: opts.sample!(req.params) } };
    });
  }
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: R = {}): Promise<R> => {
    const res = await client.callTool({ name, arguments: args });
    assert.ok(res.structuredContent, `${name} returned structuredContent`);
    return res.structuredContent as R;
  };
  return { client, call, store, mentor, sampled };
}

describe("personalization by level", () => {
  it("maps any class, year or age to a teaching band", () => {
    assert.equal(bandFor("kindergarten", undefined), "early");
    assert.equal(bandFor("Class 3", undefined), "primary");
    assert.equal(bandFor("grade 7", undefined), "middle");
    assert.equal(bandFor("10th", undefined), "high");
    assert.equal(bandFor("Class 12 board exams", undefined), "high");
    assert.equal(bandFor("2nd year engineering", undefined), "college");
    assert.equal(bandFor("B.Tech", undefined), "college");
    assert.equal(bandFor("working professional", undefined), "adult");
    assert.equal(bandFor("", 6), "early");
    assert.equal(bandFor("", 16), "high");
  });

  it("speaks differently to a 7-year-old and a college student", async () => {
    const { call } = await connect();
    const kid = await call("set_up_learner", { name: "Anya", level: "Class 2", age: 7, interests: ["unicorns"] });
    const uni = await call("set_up_learner", { name: "Rahul", level: "2nd year engineering", interests: ["gaming"] });
    assert.equal(kid.learner.band, "early");
    assert.equal(uni.learner.band, "college");
    assert.match(kid.voiceGuide, /short sentences/i);
    assert.match(uni.voiceGuide, /technical/i);
    assert.notEqual(kid.voiceGuide, uni.voiceGuide);
  });
});

describe("the memory loop", () => {
  it("onboards, studies notes, remembers a mistake and brings it back the next day", async () => {
    const { call, store } = await connect();

    const hello = await call("get_today");
    assert.equal(hello.kind, "welcome");

    const me = await call("set_up_learner", { name: "Priya", level: "Grade 10", age: 15, interests: ["cricket", "cooking"], exam_title: "Biology unit test", exam_subject: "Biology", exam_in_days: 5 });
    assert.equal(me.kind, "profile");
    assert.match(me.speech, /5 days away/);

    const deck = await call("add_material", { title: "Cell division notes", text: NOTES });
    assert.equal(deck.kind, "deck");
    assert.equal(deck.concepts.length, 6);
    assert.match(deck.speech, /linked it to your Biology unit test/);

    const ex = await call("explain_concept", { concept: "meiosis" });
    assert.equal(ex.kind, "explanation");
    assert.match(ex.explanation, /cricket|charity match/i, "uses Priya's interest");

    let q = await call("start_quiz", {});
    assert.equal(q.kind, "quiz_question");
    assert.equal(q.question.prompt, "Where does a typical cell spend most of its life?");
    q = await call("answer_question", { answer: "prophase" });
    assert.equal(q.feedback.verdict, "incorrect");
    assert.match(q.feedback.misconception, /mixed up interphase with prophase/i);
    q = await call("answer_question", { answer: "the S phase" });
    assert.equal(q.feedback.verdict, "correct");
    const hint = await call("quiz_action", { action: "hint" });
    assert.ok(hint.hint);
    await call("quiz_action", { action: "end" });

    store.advanceClock(1);
    const tomorrow = await call("get_today");
    assert.equal(tomorrow.kind, "today");
    assert.match(tomorrow.speech, /Last time you mixed up interphase with prophase/);
    assert.equal(tomorrow.exam.daysLeft, 4);

    // The weak spot comes first in the next quiz, and getting it right resolves it.
    q = await call("start_quiz", {});
    assert.equal(q.concept.title, "The cell cycle");
    q = await call("answer_question", { answer: q.question.type === "truefalse" ? "false" : q.question.type === "mcq" ? "interphase" : "Checkpoints stop damaged cells dividing, which prevents cancer" });
    assert.notEqual(q.feedback.verdict, "incorrect");

    const plan = await call("get_study_plan");
    assert.equal(plan.kind, "study_plan");
    assert.equal(plan.mastery.length, 6);
    assert.ok(plan.days.length >= 3);
    assert.match(plan.days.at(-1).focus.join(" "), /Mixed review/);
  });

  it("learns which explanation style works for the learner", async () => {
    const { call } = await connect();
    await call("set_up_learner", { name: "Sam", level: "Grade 9", interests: ["football"] });
    await call("add_material", { title: "Cell division", text: NOTES });
    await call("explain_concept", { concept: "phases of mitosis", style: "analogy" });
    await call("start_quiz", { topic: "phases of mitosis" });
    await call("answer_question", { answer: "metaphase" });
    const profile = await call("get_profile");
    assert.ok(profile.memories.some((m: R) => m.source === "observed" && /football analogies/i.test(m.text)));
  });

  it("remembers and forgets on request", async () => {
    const { call } = await connect({ elicit: () => ({ action: "decline" }) });
    await call("set_up_learner", { name: "Priya", level: "Grade 10" });
    await call("remember", { fact: "I get nervous in timed tests", kind: "struggle" });
    let p = await call("get_profile");
    assert.match(p.speech, /you get nervous in timed tests/);
    const f = await call("forget", { text: "timed tests" });
    assert.equal(f.kind, "forgotten");
    p = await call("get_profile");
    assert.equal(p.memories.length, 0);
    const kept = await call("forget", { everything: true });
    assert.equal(kept.kind, "cancelled", "declined confirmation keeps the profile");
  });

  it("teach-back checks the learner's own explanation against the key points", async () => {
    const { call } = await connect();
    await call("set_up_learner", { name: "Priya", level: "Grade 10" });
    await call("add_material", { title: "Cell division", text: NOTES });
    const start = await call("teach_back", { action: "start", concept: "meiosis" });
    assert.equal(start.phase, "listening");
    const res = await call("teach_back", { action: "submit", explanation: "Meiosis makes gametes like sperm and egg cells. It has two divisions and makes four haploid cells with half the chromosomes, and crossing over swaps DNA." });
    assert.equal(res.phase, "result");
    assert.ok(res.score >= 0.6);
    assert.ok(res.checklist.some((c: R) => c.status === "covered"));
  });
});

describe("MCP features", () => {
  it("uses MCP sampling for new topics, explanations and grading when the client offers it", async () => {
    const { call, sampled } = await connect({
      sample: (p) => {
        const prompt = p.messages[0].content.text as string;
        if (/Build a short study deck/.test(prompt)) {
          return JSON.stringify({
            title: "Photosynthesis",
            subject: "Biology",
            concepts: [
              {
                title: "Photosynthesis",
                summary: "Plants turn light, water and carbon dioxide into glucose and oxygen.",
                keyPoints: ["Happens in chloroplasts", "Needs light", "Makes glucose and oxygen"],
                confusableWith: ["respiration"],
                flashcards: [{ front: "Where does photosynthesis happen?", back: "In the chloroplasts." }],
                questions: [{ type: "short", prompt: "What does photosynthesis make?", answer: "Glucose and oxygen", explanation: "Those are the products." }],
              },
            ],
          });
        }
        if (/Explain this concept/.test(prompt)) return JSON.stringify({ explanation: "Think of a leaf as a solar-powered kitchen.", analogy: "Cooking analogy", checkQuestion: "What goes into the kitchen?" });
        if (/Grade the learner/.test(prompt)) return JSON.stringify({ score: 0.9, verdict: "correct", feedback: "Yes, sugar and oxygen.", misconception: "" });
        return "{}";
      },
    });
    await call("set_up_learner", { name: "Maya", level: "Grade 6", interests: ["cooking"] });
    const deck = await call("add_topic", { topic: "photosynthesis" });
    assert.equal(deck.concepts[0].title, "Photosynthesis");
    const ex = await call("explain_concept", { concept: "photosynthesis" });
    assert.match(ex.explanation, /solar-powered kitchen/);
    await call("start_quiz", {});
    const graded = await call("answer_question", { answer: "sugar and oxygen" });
    assert.equal(graded.kind, "quiz_summary");
    assert.equal(graded.correct, 1);
    // deck, explanation, fresh questions (the set had only one question), grading
    assert.equal(sampled.length, 4);
    assert.match(sampled[2].messages[0].content.text, /Write \d NEW quiz questions about "Photosynthesis"/);
    assert.match(sampled[0].systemPrompt, /Vidya/);
    assert.match(sampled[1].messages[0].content.text, /Maya/, "the learner context travels with the request");
  });

  it("can onboard through an elicitation form", async () => {
    const { call } = await connect({ elicit: () => ({ action: "accept", content: { name: "Leo", level: "Class 1", age: 6, interests: "dinosaurs, space" } }) });
    const res = await call("set_up_learner", { use_form: true });
    assert.equal(res.learner.name, "Leo");
    assert.equal(res.learner.band, "early");
    assert.deepEqual(res.learner.interests, ["dinosaurs", "space"]);
  });

  it("writes bedtime stories around the child's interests and the parent's lesson", async () => {
    const { call } = await connect();
    const story = await call("tell_story", { child: "Leo", lesson: "Stealing is wrong", age: 6, interests: ["dinosaurs"] });
    assert.equal(story.kind, "story");
    assert.ok(story.pages.length >= 4);
    assert.match(story.pages.join(" "), /triceratops/);
    assert.match(story.pages.at(-1), /goodnight, Leo/i);
    assert.equal(story.child.band, "early");
  });

  it("exposes MCP Apps metadata, resources and prompts", async () => {
    const { client, call } = await connect();
    const { tools } = await client.listTools();
    assert.ok(tools.length >= 17);
    assert.equal((tools.find((t) => t.name === "start_quiz")!._meta as R).ui.resourceUri, CARD_URI);
    const card = await client.readResource({ uri: CARD_URI });
    assert.equal(card.contents[0].mimeType, MCP_APP_MIME);
    await call("set_up_learner", { name: "Priya", level: "Grade 10" });
    const deck = await call("add_material", { title: "Cell division", text: NOTES });
    const res = await client.readResource({ uri: `study-buddy://decks/${deck.deck.id}` });
    assert.match(String((res.contents[0] as R).text), /## Meiosis/);
    const { prompts } = await client.listPrompts();
    assert.deepEqual(prompts.map((p) => p.name).sort(), ["bedtime-story", "study-session"]);
  });
});

describe("spaced repetition", () => {
  it("never schedules a review after the exam", () => {
    const m = newMastery("p", "c", "2026-10-13");
    for (let i = 0; i < 4; i++) review(m, 1, "2026-10-13", "2026-10-16");
    assert.ok(m.due <= "2026-10-15", `due ${m.due} should be on or before the day before the exam`);
  });
  it("brings a missed concept back right away", () => {
    const m = newMastery("p", "c", "2026-10-13");
    review(m, 0, "2026-10-13");
    assert.equal(m.due, "2026-10-13");
    assert.equal(m.lapses, 1);
  });
});

describe("Streamable HTTP transport", () => {
  let proc: ChildProcess;
  const port = 18787 + Math.floor(Math.random() * 1000);

  before(async () => {
    proc = spawn(process.execPath, ["--import", "tsx", path.join(here, "../src/index.ts")], {
      env: { ...process.env, MCP_PORT: String(port), BUDDY_DATA_DIR: mkdtempSync(path.join(tmpdir(), "sb-")), BUDDY_LLM: "fixture" },
      stdio: "pipe",
    });
    for (let i = 0; i < 50; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return;
      } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("server did not start");
  });
  after(() => proc.kill());

  it("negotiates protocol 2025-11-25 and serves tools over HTTP", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
    const client = new Client({ name: "http-test", version: "1" });
    await client.connect(transport);
    assert.equal(transport.protocolVersion, "2025-11-25");
    assert.ok(transport.sessionId);
    const res = await client.callTool({ name: "get_today", arguments: {} });
    assert.equal((res.structuredContent as R).kind, "welcome");
    await client.close();
  });
});

it("with no AI connected, nothing is faked: generation asks for the AI connection", async () => {
  useOfflineEngine(null);
  try {
    const store = new Store({ dir: null });
    const server = createStudyBuddyServer(new Mentor(store), { llm: null });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const call = async (name: string, args: R = {}): Promise<R> => (await client.callTool({ name, arguments: args })).structuredContent as R;
    await call("set_up_learner", { name: "Priya", level: "Grade 10" });
    const deck = await call("add_material", { title: "Cell division", text: NOTES });
    assert.equal(deck.kind, "error");
    assert.match(deck.speech, /need my AI connection/);
    const topic = await call("add_topic", { topic: "photosynthesis" });
    assert.match(topic.speech, /need my AI connection/);
    assert.equal(store.get().decks.length, 0, "no pre-made study set was created");
  } finally {
    useOfflineEngine(offlineEngine);
  }
});
