import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitationCompleteNotificationSchema, ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Mentor } from "../src/domain/mentor.ts";
import { Store } from "../src/domain/store.ts";
import { consentMatches, consentPhrase, VoiceNotConfiguredError, VoiceStudio, voiceProviderFromEnv, wavSeconds } from "../src/domain/voice.ts";
import { createStudyBuddyServer, enrollmentNotifiers } from "../src/server.ts";
import { useOfflineEngine } from "../src/domain/generate.ts";
import { offlineEngine } from "./fixtures/offline-engine.ts";

// Tests use scripted stand-ins for the model; the product generates everything live.
useOfflineEngine(offlineEngine);

type R = Record<string, any>;

function wav(seconds: number, rate = 22050): Buffer {
  const n = Math.round(seconds * rate);
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write("WAVE", 8);
  b.write("fmt ", 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(n * 2, 40);
  return b;
}

async function connect() {
  delete process.env.ELEVENLABS_API_KEY;
  const store = new Store({ dir: null });
  const mentor = new Mentor(store);
  const studio = new VoiceStudio(mentor, voiceProviderFromEnv());
  const server = createStudyBuddyServer(mentor, { llm: null, studio, publicUrl: "http://localhost:8787", voiceCloning: true });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" }, { capabilities: { elicitation: { form: {}, url: {} } } });
  const elicited: R[] = [];
  const completed: string[] = [];
  client.setRequestHandler(ElicitRequestSchema, async (req) => {
    elicited.push(req.params);
    return req.params.mode === "url" ? { action: "accept" } : { action: "accept", content: { confirm: true } };
  });
  client.setNotificationHandler(ElicitationCompleteNotificationSchema, (n) => {
    completed.push(n.params.elicitationId);
  });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: R = {}): Promise<R> => (await client.callTool({ name, arguments: args })).structuredContent as R;
  return { call, studio, store, elicited, completed };
}

describe("parent story voices", () => {
  it("checks consent and recording length from the audio itself", () => {
    const phrase = consentPhrase("Asha");
    assert.match(phrase, /I'm Asha, and I agree/);
    assert.ok(consentMatches("Asha", "i'm asha and i agree to let study buddy read stories and messages to my family in my voice"));
    assert.ok(!consentMatches("Asha", "once upon a time on a hill"));
    assert.ok(!consentMatches("Asha", "I'm Priya and I agree to let you use my voice"), "someone else's name doesn't count");
    assert.equal(Math.round(wavSeconds(wav(25))), 25);
    assert.equal(wavSeconds(Buffer.from("not a wav")), 0);
  });

  it("creates a voice through URL elicitation with spoken consent, then reads a story and a parent-written message", async () => {
    const { call, studio, elicited, completed } = await connect();

    const start = await call("create_parent_voice", { parent_name: "Asha", relation: "mom", children: ["Leo"] });
    assert.equal(start.kind, "voice_enroll");
    assert.equal(start.relation, "Mom");
    assert.equal(elicited[0].mode, "url");
    const token = new URL(elicited[0].url).searchParams.get("token")!;
    assert.ok(studio.enrollment(token));

    await assert.rejects(studio.completeEnrollment(token, wav(8), consentPhrase("Asha"), false), /at least 20 seconds/);
    await assert.rejects(studio.completeEnrollment(token, wav(30), "just reading the story", false), /consent sentence/);

    const voice = await studio.completeEnrollment(token, wav(30), consentPhrase("Asha"), false);
    assert.equal(voice.consent.method, "spoken");
    assert.equal(voice.provider, "mock");
    await enrollmentNotifiers.get(token)?.();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(completed.length, 1, "client is told the voice is ready (notifications/elicitation/complete)");
    assert.equal(studio.enrollment(token), undefined, "links are single use");

    const story = await call("tell_story", { child: "Leo", lesson: "sharing", age: 6, interests: ["dinosaurs"], voice: "Mom" });
    assert.equal(story.voiceLabel, "Mom's voice (AI)");
    assert.match(story.audioUrl, /\/voice\/audio\/story\//);
    assert.match(story.speech, /read in Mom's voice/);
    // Test mode: the mock provider refuses to synthesize, so the device falls back to its own voice.
    await assert.rejects(studio.audio("story", story.storyId), VoiceNotConfiguredError);

    const plain = await call("tell_story", { child: "Leo", lesson: "being brave" });
    assert.equal(plain.audioUrl, undefined, "parent voice is only used when asked for");
    await assert.rejects(studio.audio("story", plain.storyId), /No story in a parent's voice/);

    const exact = "Proud of you today, little dino. See you Saturday!";
    const saved = await call("voice_message", { action: "leave", from: "Mom", to: "Leo", text: exact });
    assert.equal(saved.text, exact, "the parent's words are kept exactly");
    const played = await call("voice_message", { action: "play", to: "Leo" });
    assert.equal(played.messages.length, 1);
    assert.equal(played.messages[0].text, exact);
    assert.match(played.messages[0].audioUrl, /\/voice\/audio\/message\//);
    const again = await call("voice_message", { action: "play", to: "Leo" });
    assert.equal(again.messages.length, 0, "messages play once");
  });

  it("can be paused and deleted, which removes the voice everywhere", async () => {
    const { call, studio, store } = await connect();
    await call("create_parent_voice", { parent_name: "Raj", relation: "dad" });
    const token = store.get().voiceEnrollments!.at(-1)!.token;
    await studio.completeEnrollment(token, wav(25), consentPhrase("Raj"), false);
    const paused = await call("parent_voice", { action: "pause", voice: "Dad" });
    assert.match(paused.speech, /paused/);
    const story = await call("tell_story", { child: "Mia", lesson: "kindness", voice: "Dad" });
    assert.equal(story.audioUrl, undefined);
    assert.match(story.speech, /paused, so I'll read it myself/);
    await call("parent_voice", { action: "resume", voice: "Dad" });
    const deleted = await call("parent_voice", { action: "delete", voice: "Dad" });
    assert.match(deleted.speech, /deleted/);
    const list = await call("parent_voice", { action: "list" });
    assert.equal(list.voices.length, 0);
  });
});
