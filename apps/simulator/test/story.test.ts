import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, it } from "node:test";
import { fileURLToPath } from "node:url";
import { OfflineAgent, parseIntro, SAMPLE_NOTES_PATH } from "../src/agent-offline.ts";
import { Session, type SimEvent } from "../src/session.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const port = 19787 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
let proc: ChildProcess;

before(async () => {
  proc = spawn(process.execPath, ["--import", "tsx", path.join(here, "../../../packages/mcp-server/src/index.ts")], {
    env: { ...process.env, MCP_PORT: String(port), BUDDY_DATA_DIR: mkdtempSync(path.join(tmpdir(), "sb-sim-")), BUDDY_LLM: "offline" },
    stdio: "ignore",
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("MCP server did not start");
});
after(() => proc.kill());

it("understands spoken introductions at any level", () => {
  assert.deepEqual(parseIntro("Hi, I'm Priya. I'm in 10th grade and I love cricket and cooking. My biology test is in 5 days."), {
    name: "Priya",
    level: "Grade 10",
    interests: ["cricket", "cooking"],
    exam_title: "Biology test",
    exam_subject: "biology",
    exam_in_days: 5,
  });
  assert.equal(parseIntro("my name is Rahul and I'm in second year engineering")?.level, "second year engineering");
  assert.equal(parseIntro("I'm Anya, I'm 7 and I love unicorns")?.age, 7);
});

it("runs the study story by voice: onboarding, notes, explanation, quiz, memory the next day, teach-back, bedtime story", async () => {
  const session = await Session.create(new OfflineAgent(), `${base}/mcp`);
  const events: SimEvent[] = [];
  session.subscribe((e) => events.push(e));
  const lastSpeech = () => ([...events].reverse().find((e) => e.type === "speech") as { text: string } | undefined)?.text ?? "";
  const lastCard = () => ([...events].reverse().find((e) => e.type === "card") as any)?.result.structuredContent;
  const say = async (text: string) => {
    await session.turn(text, "voice");
    return lastSpeech();
  };

  assert.equal(session.mcp.protocolVersion, "2025-11-25");
  assert.match(await say("Alexa, help me study"), /What's your name/);
  assert.match(await say("Hi, I'm Priya. I'm in 10th grade and I love cricket and cooking. My biology test is in 5 days."), /Nice to meet you, Priya/);
  assert.ok(events.some((e) => e.type === "learner" && e.name === "Priya"));

  await session.shareNotes("Cell division notes", readFileSync(SAMPLE_NOTES_PATH, "utf8"));
  assert.match(lastSpeech(), /6 topics on cell division/);

  assert.match(await say("explain meiosis"), /charity match|cricket/i);
  assert.match(await say("explain it differently"), /./);
  assert.equal(lastCard().kind, "explanation");

  assert.match(await say("quiz me"), /5 questions.*First one/);
  assert.match(await say("prophase"), /not quite|close, but no/i);
  await say("S phase");
  assert.match(await say("hint"), /hint/i);
  await say("stop");
  assert.equal(lastCard().kind, "quiz_summary");

  await fetch(`${base}/admin/advance`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ days: 1 }) });
  assert.match(await say("good morning"), /Last time you mixed up interphase with prophase/);

  assert.match(await say("let me teach meiosis back to you"), /I'm listening/);
  assert.match(await say("Meiosis makes gametes. It has two divisions and makes four haploid cells, and crossing over shuffles DNA."), /./);
  assert.equal(lastCard().phase, "result");

  assert.match(await say("I get nervous in timed tests"), /keep that in mind/);
  assert.match(await say("what do you know about me"), /nervous in timed tests/);
  assert.match(await say("what's my study plan"), /Out of 6 topics/);
  assert.match(await say("help me focus for 25 minutes"), /Focus mode on for 25 minutes/);

  assert.match(await say("Tell Leo a bedtime story about why stealing is wrong. He's 6 and loves dinosaurs."), /triceratops/);
  assert.equal(lastCard().child.band, "early");

  const kinds = new Set(events.filter((e) => e.type === "card").map((e) => (e as any).result.structuredContent.kind));
  for (const k of ["welcome", "profile", "deck", "explanation", "quiz_question", "quiz_summary", "today", "teach_back", "study_plan", "focus", "story"]) assert.ok(kinds.has(k), `rendered a ${k} card`);
  assert.ok(!events.some((e) => e.type === "error"));
  await session.close();
});
