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
    env: { ...process.env, MCP_PORT: String(port), BUDDY_DATA_DIR: mkdtempSync(path.join(tmpdir(), "sb-sim-")), BUDDY_LLM: "fixture" },
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

it("parent sets up a child by voice; the child is greeted and gets to know Study Buddy", async () => {
  const session = await Session.create(new OfflineAgent(), `${base}/mcp`);
  const events: SimEvent[] = [];
  session.subscribe((e) => events.push(e));
  const say = async (text: string) => {
    await session.turn(text, "voice");
    return ([...events].reverse().find((e) => e.type === "speech") as { text: string } | undefined)?.text ?? "";
  };
  assert.match(await say("I'm Asha, Leo's mom. He's 6, he's in class 1 and he loves dinosaurs. He gets shy with new things."), /I've set up Leo/);
  assert.match(await say("How is Leo doing?"), /hasn't started studying/);
  assert.match(await say("Hi, I'm Leo"), /Your mom told me .* dinosaurs.*favourite dinosaur/);
  assert.match(await say("T-rex"), /T-rex! Great choice/);
  assert.match(await say("I'm so tired"), /tiny bit today|keep it short/);
  assert.match(await say("the kids at school make fun of me"), /not okay|not your fault/);
  assert.ok(events.some((e) => e.type === "alert" && e.category === "bullying"), "parent alert raised");
  assert.match(await say("I'm Asha, Leo's mom. How is Leo doing?"), /^Before anything else/);
  assert.match(await say("Hi, I'm Leo"), /./);
  await session.shareNotes("Cell division notes", readFileSync(SAMPLE_NOTES_PATH, "utf8"));
  assert.match(await say("let's play a quiz with Mia and Sam"), /Study Together! Leo, Mia, and Sam.*guests.*Leo, (your turn|you're up)|Over to you, Leo/);
  assert.match(await say("true"), /Mia/);
  assert.match(await say("what are the scores"), /Scores:/);
  await session.close();
});


it("Study Together across homes: two devices, an invite code, live turn updates", async () => {
  const device = async (home: string) => {
    const session = await Session.create(new OfflineAgent(), `${base}/mcp`, home);
    const events: SimEvent[] = [];
    session.subscribe((e) => events.push(e));
    const lastSpeech = () => ([...events].reverse().find((e) => e.type === "speech") as { text: string } | undefined)?.text ?? "";
    const lastCard = () => ([...events].reverse().find((e) => e.type === "card") as any)?.result.structuredContent;
    const say = async (text: string) => {
      await session.turn(text, "voice");
      return lastSpeech();
    };
    return { session, events, say, lastSpeech, lastCard };
  };
  const waitFor = async (fn: () => boolean) => {
    for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 30));
    assert.ok(fn(), "update arrived");
  };

  const kapoor = await device("kapoor");
  const rao = await device("rao");
  await kapoor.say("Hi, I'm Priya. I'm in 10th grade and I love cricket.");
  await kapoor.session.shareNotes("Cell division notes", readFileSync(SAMPLE_NOTES_PATH, "utf8"));
  const lobby = await kapoor.say("let's play an online quiz battle with my friend at her home");
  const code = kapoor.lastCard().spokenCode as string;
  assert.match(lobby, new RegExp(`Your game code is ${code}`));

  await rao.say("I'm Asha, Leo's mom. He's 6, he's in class 1 and he loves dinosaurs.");
  await rao.say("Hi, I'm Leo");
  assert.match(await rao.say(`join game ${code.toLowerCase()}`), /Online games are off for Leo/);
  assert.match(await rao.say("I'm Asha. Allow online games for Leo"), /Leo can now play Study Together with friends from other homes/);
  await rao.say("Hi, I'm Leo");
  assert.match(await rao.say(`join game ${code.toLowerCase()}`), /You're in Priya's game/);
  await waitFor(() => kapoor.lastCard()?.players?.length === 2);
  assert.match(kapoor.lastSpeech(), /Leo joined/, "Priya's device announces Leo");

  assert.match(await kapoor.say("start the game"), /Priya, your turn/);
  await waitFor(() => rao.lastCard()?.status === "playing");
  assert.match(rao.lastSpeech(), /Priya's turn at their home/);
  assert.match(await rao.say("true"), /Priya's turn/, "Leo can't answer out of turn");

  await kapoor.say("mitosis makes two identical cells");
  await waitFor(() => rao.lastCard()?.yourTurn === true);
  assert.match(rao.lastSpeech(), /Leo, your turn/);
  assert.equal(rao.events.filter((e) => e.type === "card").at(-1)?.type, "card");
  assert.ok(!rao.events.some((e) => e.type === "speech" && /identical cells/.test(e.text)), "Leo's home never hears Priya's words");

  assert.match(await rao.say("what are the scores"), /Scores: Priya \d+, Leo 0/);
  assert.ok(!kapoor.events.some((e) => e.type === "error") && !rao.events.some((e) => e.type === "error"));
  const mine = await (await fetch(`${base}/admin/state?home=rao`)).json();
  assert.ok(!mine.state.learners.some((l: { name: string }) => l.name === "Priya"), "homes keep separate memory");
  await kapoor.session.close();
  await rao.session.close();
});


it("'delete my study plan' deletes the study sets after a clear confirmation, never the whole profile", async () => {
  // The AI picks the wrong tool, as Nova did live: forget everything=true.
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const careless = {
    label: "careless",
    reset() {},
    async turn(ctx: any, text: string) {
      if (/delete|forget/i.test(text)) {
        const r = await ctx.callTool("forget", { everything: true });
        return r.structuredContent?.speech ?? r.content[0].text;
      }
      return "";
    },
  };
  const session = await Session.create(careless as never, `${base}/mcp`, "delete-test");
  const events: SimEvent[] = [];
  session.subscribe((e) => {
    events.push(e);
    if (e.type === "tool" && e.phase === "call") calls.push({ name: e.name, args: e.args as Record<string, unknown> });
    if (e.type === "elicit") setTimeout(() => session.answerElicit(e.id, "accept", { confirm: true }), 10);
  });
  await session.callToolFromView("set_up_learner", { name: "Venkat", level: "College" });
  await session.shareNotes("Startup notes", readFileSync(SAMPLE_NOTES_PATH, "utf8"));

  await session.turn("can you delete the entire study plan", "voice");
  const ask = events.find((e) => e.type === "elicit") as { message: string } | undefined;
  assert.match(ask!.message, /^Delete your .* study set.*\? Your profile and what I've learned about you stay\.$/);
  assert.deepEqual(calls.at(-1), { name: "delete_study_set", args: { all: true } });
  const card = events.filter((e) => e.type === "card").at(-1) as { result: { structuredContent: { kind: string } } } | undefined;
  assert.equal(card?.result.structuredContent.kind, "study_sets_deleted", "the screen shows the change, not the old plan");
  const profile = (await session.callToolFromView("get_profile", {})).structuredContent as { learner?: { name: string } };
  assert.equal(profile.learner?.name, "Venkat", "the profile is still there");

  await session.turn("forget it", "voice");
  assert.match((events.filter((e) => e.type === "speech").at(-1) as { text: string }).text, /^Not deleted: .*Ask them exactly what to delete/);
  assert.equal(((await session.callToolFromView("get_profile", {})).structuredContent as { learner?: { name: string } }).learner?.name, "Venkat", "a vague 'forget it' deletes nothing");
  await session.close();
});
