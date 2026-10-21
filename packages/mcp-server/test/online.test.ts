import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { normalizeCode, spokenCode } from "../src/domain/games.ts";
import { createStudyBuddyServer } from "../src/server.ts";
import { HomeRegistry } from "../src/homes.ts";
import { useOfflineEngine } from "../src/domain/generate.ts";
import { offlineEngine } from "./fixtures/offline-engine.ts";

// Tests use scripted stand-ins for the model; the product generates everything live.
useOfflineEngine(offlineEngine);

type R = Record<string, any>;
const here = path.dirname(fileURLToPath(import.meta.url));
const NOTES = readFileSync(path.join(here, "../content/cell-division.md"), "utf8");

async function device(homes: HomeRegistry, homeId: string) {
  const home = homes.get(homeId);
  const server = createStudyBuddyServer(home.mentor, { llm: null, games: homes.games, homeId: home.id });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: homeId, version: "1" });
  const updates: string[] = [];
  client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => void updates.push(n.params.uri));
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: R = {}): Promise<R> => (await client.callTool({ name, arguments: args })).structuredContent as R;
  const read = async (uri: string): Promise<R> => JSON.parse(((await client.readResource({ uri })).contents[0] as { text: string }).text);
  return { home, client, call, read, updates };
}

const settle = () => new Promise((r) => setTimeout(r, 10));

it("spoken game codes survive speech recognition", () => {
  assert.equal(normalizeCode("tiger 4 2"), "TIGER-42");
  assert.equal(normalizeCode("Tiger forty-two 42"), "TIGER-42");
  assert.equal(normalizeCode("TIGER-42"), "TIGER-42");
  assert.equal(spokenCode("TIGER-42"), "Tiger 4 2");
});

it("Study Together across homes: invite code, parent permission under 13, turns, live updates, private answers, results logged at home", async () => {
  const homes = new HomeRegistry({ inMemory: true });
  const priya = await device(homes, "kapoor");
  const leo = await device(homes, "rao");

  await priya.call("set_up_learner", { name: "Priya", level: "Grade 10" });
  await priya.call("add_material", { title: "Cell division", text: NOTES });
  const lobby = await priya.call("start_online_game", { turns_each: 1 });
  assert.equal(lobby.kind, "online_game");
  assert.equal(lobby.status, "lobby");
  assert.ok(lobby.isHost);
  assert.match(lobby.speech, new RegExp(`Your game code is ${lobby.spokenCode}`));
  await priya.client.subscribeResource({ uri: lobby.gameUri });

  // Leo is 6: online games are off until a parent switches them on.
  await leo.call("parent_setup", { parent_name: "Asha", relation: "Mom", child: "Leo", age: 6, interests: ["dinosaurs"] });
  await leo.call("switch_learner", { name: "Leo" });
  const blocked = await leo.call("join_online_game", { code: lobby.spokenCode.toLowerCase() });
  assert.equal(blocked.kind, "error");
  assert.match(blocked.speech, /Online games are off for Leo/);
  const allowed = await leo.call("parent_settings", { child: "Leo", online_games: "allowed" });
  assert.equal(allowed.onlineGames, "allowed");

  const joined = await leo.call("join_online_game", { code: lobby.spokenCode.toLowerCase() });
  assert.equal(joined.status, "lobby");
  assert.ok(!joined.isHost);
  await settle();
  assert.ok(priya.updates.includes(lobby.gameUri), "the host's device hears that Leo joined");
  const seen = await priya.read(lobby.gameUri);
  assert.deepEqual(seen.players.map((p: R) => [p.name, p.home]), [["Priya", "here"], ["Leo", "another home"]]);

  const notHost = await leo.call("online_game_action", { action: "start" });
  assert.match(notHost.speech, /Only Priya can start/);
  const started = await priya.call("online_game_action", { action: "start" });
  assert.equal(started.status, "playing");
  assert.ok(started.yourTurn);
  assert.equal(started.question.type, "short", "a 10th grader gets an explain question");

  const early = await leo.call("online_game_answer", { answer: "true" });
  assert.match(early.speech, /it's Priya's turn/);

  const secret = "mitosis makes two identical cells my secret words";
  await priya.call("online_game_answer", { answer: secret });
  await settle();
  const leoView = await leo.read(lobby.gameUri);
  assert.ok(leoView.yourTurn, "Leo's device now says it's his turn");
  assert.equal(leoView.question.type === "truefalse" || leoView.question.type === "mcq", true, "a 6-year-old gets true/false or multiple choice");
  assert.ok(!JSON.stringify(leoView).includes("secret words"), "other homes never see what a player said");

  const tf = leoView.question.type === "truefalse" ? (/resting|no way|two identical|46 chromosomes into 23|breaks down during telophase/.test(leoView.question.prompt) ? "false" : "true") : leoView.question.options[0];
  const done = await leo.call("online_game_answer", { answer: tf });
  assert.equal(done.status, "done");
  assert.match(done.speech, /Great game, everyone/);
  assert.equal(done.players.length, 2);

  // Each home records the game for its own learner; Leo's mom sees it in his history.
  const history = await leo.call("parent_history", { child: "Leo" });
  assert.ok(history.turns.some((t: R) => /Online Study Together with Priya/.test(t.heard)));
  assert.ok(!leo.home.store.get().learners.some((l) => l.name === "Priya"), "homes never share learner records");
  assert.ok(!priya.home.store.get().learners.some((l) => l.name === "Leo"));
});

it("a game needs at least two players and an unknown code is a friendly error", async () => {
  const homes = new HomeRegistry({ inMemory: true });
  const a = await device(homes, "a");
  await a.call("set_up_learner", { name: "Sam", level: "Grade 8", age: 14 });
  await a.call("add_material", { title: "Cell division", text: NOTES });
  await a.call("start_online_game", {});
  const alone = await a.call("online_game_action", { action: "start" });
  assert.match(alone.speech, /Nobody has joined yet/);
  const b = await device(homes, "b");
  await b.call("set_up_learner", { name: "Ana", level: "Grade 9", age: 15 });
  const nope = await b.call("join_online_game", { code: "panda 1 1" });
  assert.match(nope.speech, /couldn't find a game/);
});
