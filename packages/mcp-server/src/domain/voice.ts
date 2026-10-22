import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BRAND, BuddyError, type Mentor, type Result } from "./mentor.ts";
import type { Learner, ParentVoice, State, VoiceEnrollment, VoiceMessage } from "./types.ts";

/**
 * Parent story voices ("Mom's voice" for bedtime stories).
 *
 * Safety model (deliberately narrow):
 *  - Only a parent can create their own voice, after reading a consent sentence aloud.
 *  - The voice can only read two things: bedtime stories someone in the family asked for, and
 *    goodnight messages the parent wrote, word for word. There is no endpoint that synthesizes
 *    arbitrary text, so the voice can't be made to "say" anything else or hold a conversation.
 *  - Everything in that voice is labelled "<Relation>'s voice (AI)". Parents can pause or delete it.
 *  - The raw recording is sent to the provider to create the voice and never stored here.
 */

export interface VoiceProvider {
  readonly name: "elevenlabs" | "mock";
  readonly live: boolean;
  clone(name: string, wav: Buffer, description: string): Promise<string>;
  synthesize(providerVoiceId: string, text: string): Promise<Buffer>;
  remove(providerVoiceId: string): Promise<void>;
}

export class VoiceNotConfiguredError extends Error {}

class ElevenLabsProvider implements VoiceProvider {
  readonly name = "elevenlabs" as const;
  readonly live = true;
  private base = process.env.ELEVENLABS_BASE_URL ?? "https://api.elevenlabs.io";
  private model = process.env.ELEVENLABS_MODEL ?? "eleven_multilingual_v2";
  constructor(private key: string) {}

  async clone(name: string, wav: Buffer, description: string): Promise<string> {
    const form = new FormData();
    form.append("name", name);
    form.append("description", description);
    form.append("remove_background_noise", "true");
    form.append("files", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "sample.wav");
    const r = await fetch(`${this.base}/v1/voices/add`, { method: "POST", headers: { "xi-api-key": this.key }, body: form });
    if (!r.ok) throw new Error(`Voice provider rejected the sample (${r.status}): ${(await r.text()).slice(0, 300)}`);
    const out = (await r.json()) as { voice_id: string };
    return out.voice_id;
  }

  async synthesize(providerVoiceId: string, text: string): Promise<Buffer> {
    const r = await fetch(`${this.base}/v1/text-to-speech/${encodeURIComponent(providerVoiceId)}?output_format=mp3_44100_128`, {
      method: "POST",
      headers: { "xi-api-key": this.key, "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({ text, model_id: this.model, voice_settings: { stability: 0.55, similarity_boost: 0.8, style: 0.15, use_speaker_boost: true, speed: 0.92 } }),
    });
    if (!r.ok) throw new Error(`Voice provider couldn't speak (${r.status}): ${(await r.text()).slice(0, 300)}`);
    return Buffer.from(await r.arrayBuffer());
  }

  async remove(providerVoiceId: string): Promise<void> {
    const r = await fetch(`${this.base}/v1/voices/${encodeURIComponent(providerVoiceId)}`, { method: "DELETE", headers: { "xi-api-key": this.key } });
    if (!r.ok && r.status !== 404) throw new Error(`Voice provider couldn't delete the voice (${r.status})`);
  }
}

/** Free stand-in so the whole flow can be built and tested without spending credits. */
class MockProvider implements VoiceProvider {
  readonly name = "mock" as const;
  readonly live = false;
  async clone(): Promise<string> {
    return `mock-${randomBytes(4).toString("hex")}`;
  }
  async synthesize(): Promise<Buffer> {
    throw new VoiceNotConfiguredError("Voice cloning isn't configured (set ELEVENLABS_API_KEY). Using the standard voice instead.");
  }
  async remove(): Promise<void> {}
}

export function voiceProviderFromEnv(): VoiceProvider {
  const key = process.env.ELEVENLABS_API_KEY;
  return key ? new ElevenLabsProvider(key) : new MockProvider();
}

// ------------------------------------------------------------------ helpers

const RELATIONS: Array<[RegExp, string]> = [
  [/\b(mom|mum|mommy|mummy|mother|amma|maa|mama)\b/i, "Mom"],
  [/\b(dad|daddy|father|papa|appa|baba)\b/i, "Dad"],
  [/\b(grandma|grandmother|granny|nani|dadi|nana ji|ammamma|paati)\b/i, "Grandma"],
  [/\b(grandpa|grandfather|nana|dada|thatha)\b/i, "Grandpa"],
  [/\b(aunt|auntie|aunty)\b/i, "Auntie"],
  [/\b(uncle)\b/i, "Uncle"],
];

export function normalizeRelation(text?: string): string | undefined {
  if (!text) return undefined;
  return RELATIONS.find(([re]) => re.test(text))?.[1];
}

export function consentPhrase(parentName: string): string {
  return `I'm ${parentName}, and I agree to let ${BRAND} read stories and messages to my family in my voice.`;
}

/** The transcript must contain the parent's name and the agreement, read aloud. */
export function consentMatches(parentName: string, transcript: string): boolean {
  const t = transcript.toLowerCase();
  const first = parentName.trim().split(/\s+/)[0].toLowerCase();
  const name = first.length <= 3 ? t.includes(first) : t.includes(first.slice(0, Math.max(3, first.length - 1)));
  return name && /\b(agree|consent)\b/.test(t) && /\b(voice|stories|story)\b/.test(t);
}

/** Seconds of audio in a PCM WAV buffer (reads the header; doesn't trust the client). */
export function wavSeconds(buf: Buffer): number {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return 0;
  let off = 12;
  let byteRate = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "fmt ") byteRate = buf.readUInt32LE(off + 16);
    if (id === "data") return byteRate ? Math.min(size, buf.length - off - 8) / byteRate : 0;
    off += 8 + size + (size % 2);
  }
  return 0;
}

const READING_PASSAGE = `Once upon a time, on a hill covered in soft green grass, there was a little house with a red door. Every evening, when the sky turned orange and pink, the family inside would gather by the window. They would talk about their day, the funny things and the hard things, and then they would read a story together. Some nights the story was about dragons who were afraid of the dark. Some nights it was about a tiny boat that sailed all the way to the moon. And every night, the very last words were always the same: I love you, sleep tight, and I'll see you in the morning.`;

// ------------------------------------------------------------------ service

export class VoiceStudio {
  constructor(
    private mentor: Mentor,
    readonly provider: VoiceProvider = voiceProviderFromEnv(),
    private audioDir: string | null = null,
  ) {}

  private get s(): State {
    const s = this.mentor.store.get();
    s.parentVoices ??= [];
    s.voiceMessages ??= [];
    s.voiceEnrollments ??= [];
    return s;
  }

  get passage() {
    return READING_PASSAGE;
  }

  label(v: ParentVoice) {
    return `${v.relation}'s voice (AI)`;
  }

  find(query?: string): ParentVoice | undefined {
    const voices = this.s.parentVoices!;
    if (!query) return voices.length === 1 ? voices[0] : undefined;
    const rel = normalizeRelation(query);
    const q = query.toLowerCase();
    return voices.find((v) => v.parentName.toLowerCase() === q || v.parentName.toLowerCase().split(" ")[0] === q.split(" ")[0]) ?? (rel ? voices.find((v) => v.relation === rel) : undefined);
  }

  private child(name: string): Learner {
    let c = this.mentor.findLearner(name);
    if (!c) {
      this.mentor.setUpLearner({ name, role: "child" });
      c = this.mentor.findLearner(name)!;
    }
    return c;
  }

  // ---------------------------------------------------------------- enrollment

  startEnrollment(input: { parentName: string; relation?: string; children?: string[] }): VoiceEnrollment {
    const parentName = input.parentName.trim().replace(/\b\w/g, (c) => c.toUpperCase());
    if (!parentName) throw new BuddyError("Whose voice is this? Tell me your name, and whether you're Mom, Dad, Grandma, or someone else.");
    if (this.s.parentVoices!.length >= 4) throw new BuddyError("This home already has four story voices. Delete one first.");
    const relation = normalizeRelation(input.relation) ?? normalizeRelation(input.parentName) ?? input.relation?.trim() ?? parentName;
    const enrollment: VoiceEnrollment = {
      token: randomBytes(18).toString("base64url"),
      parentName: normalizeRelation(parentName) ? relation : parentName,
      relation,
      childNames: (input.children ?? []).map((c) => c.trim()).filter(Boolean),
      consentPhrase: consentPhrase(normalizeRelation(parentName) ? relation : parentName),
      expiresAt: new Date(this.mentor.now().getTime() + 30 * 60_000).toISOString(),
    };
    this.mentor.store.update(() => {
      const s = this.s;
      s.voiceEnrollments = s.voiceEnrollments!.filter((e) => e.expiresAt > this.mentor.now().toISOString() && !e.completedVoiceId);
      s.voiceEnrollments.push(enrollment);
    });
    return enrollment;
  }

  enrollment(token: string): VoiceEnrollment | undefined {
    const e = this.s.voiceEnrollments!.find((x) => x.token === token);
    if (!e || e.completedVoiceId || e.expiresAt < this.mentor.now().toISOString()) return undefined;
    return e;
  }

  async completeEnrollment(token: string, wav: Buffer, transcript: string, attested: boolean): Promise<ParentVoice> {
    const e = this.enrollment(token);
    if (!e) throw new BuddyError("This recording link has expired. Ask Vidya to set up your voice again.");
    const seconds = wavSeconds(wav);
    if (seconds < 20) throw new BuddyError(`That recording is only ${Math.round(seconds)} seconds. Please record at least 20 seconds, reading the passage.`);
    const spoken = consentMatches(e.parentName, transcript);
    if (!spoken && !attested) throw new BuddyError("I couldn't hear the consent sentence. Please read it aloud at the start of the recording.");
    const providerVoiceId = await this.provider.clone(`${BRAND}: ${e.relation} (${e.parentName})`, wav, `Bedtime story voice for the ${e.parentName} family. Created with spoken consent.`);
    const voice: ParentVoice = {
      id: `voice-${randomBytes(4).toString("hex")}`,
      parentName: e.parentName,
      relation: e.relation,
      childIds: e.childNames.map((n) => this.child(n).id),
      provider: this.provider.name,
      providerVoiceId,
      status: "active",
      consent: { phrase: e.consentPhrase, transcript: transcript.slice(0, 500), method: spoken ? "spoken" : "attested", at: this.mentor.now().toISOString() },
      createdAt: this.mentor.now().toISOString(),
    };
    this.mentor.store.update(() => {
      this.s.parentVoices!.push(voice);
      e.completedVoiceId = voice.id;
    });
    return voice;
  }

  // ---------------------------------------------------------------- manage

  list(): Result {
    const voices = this.s.parentVoices!;
    const people = (ids: string[]) => ids.map((id) => this.mentor.store.get().learners.find((l) => l.id === id)?.name).filter(Boolean) as string[];
    return {
      kind: "parent_voices",
      title: "Story voices",
      provider: this.provider.name,
      live: this.provider.live,
      voices: voices.map((v) => ({ id: v.id, parentName: v.parentName, relation: v.relation, label: this.label(v), status: v.status, children: people(v.childIds), createdAt: v.createdAt, consent: v.consent.method })),
      speech: voices.length
        ? `There ${voices.length === 1 ? "is one story voice" : `are ${voices.length} story voices`}: ${voices.map((v) => `${v.relation}${v.status === "paused" ? ", paused" : ""}`).join(" and ")}. They only read bedtime stories and goodnight messages that you write.`
        : "No story voices yet. A parent can record one, so bedtime stories can be read in their voice.",
    };
  }

  setStatus(query: string | undefined, status: "active" | "paused"): Result {
    const v = this.find(query);
    if (!v) throw new BuddyError("I couldn't find that story voice.");
    this.mentor.store.update(() => {
      v.status = status;
    });
    return { kind: "parent_voices_changed", title: status === "paused" ? "Voice paused" : "Voice back on", speech: status === "paused" ? `Okay, ${v.relation}'s voice is paused. Stories will use my voice until you turn it back on.` : `${v.relation}'s voice is back on for bedtime stories.` };
  }

  async remove(query: string | undefined): Promise<Result> {
    const v = this.find(query);
    if (!v) throw new BuddyError("I couldn't find that story voice.");
    await this.provider.remove(v.providerVoiceId);
    this.mentor.store.update(() => {
      const s = this.s;
      s.parentVoices = s.parentVoices!.filter((x) => x.id !== v.id);
      const msgIds = s.voiceMessages!.filter((m) => m.voiceId === v.id).map((m) => m.id);
      const storyIds = s.stories.filter((st) => st.voiceId === v.id).map((st) => st.id);
      s.voiceMessages = s.voiceMessages!.filter((m) => m.voiceId !== v.id);
      for (const st of s.stories) if (st.voiceId === v.id) st.voiceId = undefined;
      for (const id of [...msgIds, ...storyIds]) this.dropAudio(id);
    });
    return { kind: "parent_voices_changed", title: "Voice deleted", speech: `Done. ${v.relation}'s voice is deleted, from here and from the voice service, along with any saved messages.` };
  }

  // ---------------------------------------------------------------- messages (parent-written, read verbatim)

  leaveMessage(input: { from?: string; to: string; text: string }): Result {
    const v = this.find(input.from);
    if (!v) throw new BuddyError(this.s.parentVoices!.length ? "Whose voice should read it? Say, for example, 'from Mom'." : "There's no story voice yet. A parent needs to record one first.");
    const text = input.text.trim();
    if (text.length < 2) throw new BuddyError("What would you like the message to say?");
    if (text.length > 600) throw new BuddyError("That's a long message. Keep goodnight messages under about a minute.");
    const child = this.child(input.to);
    const msg: VoiceMessage = { id: `msg-${randomBytes(4).toString("hex")}`, voiceId: v.id, toChildId: child.id, text, createdAt: this.mentor.now().toISOString() };
    this.mentor.store.update(() => {
      this.s.voiceMessages!.push(msg);
      if (!v.childIds.includes(child.id)) v.childIds.push(child.id);
    });
    return {
      kind: "voice_message_saved",
      title: `Message for ${child.name}`,
      from: v.relation,
      to: child.name,
      text,
      speech: `Saved. When ${child.name} asks for messages, I'll play it in ${v.relation}'s voice, exactly as you wrote it.`,
    };
  }

  playMessages(childName: string, base: string): Result {
    const child = this.mentor.findLearner(childName);
    const msgs = child ? this.s.voiceMessages!.filter((m) => m.toChildId === child.id && !m.playedAt) : [];
    if (!child || !msgs.length) return { kind: "voice_messages", title: "Messages", messages: [], speech: `No new messages${child ? ` for ${child.name}` : ""} right now.` };
    this.mentor.store.update(() => {
      for (const m of msgs) m.playedAt = this.mentor.now().toISOString();
    });
    const items = msgs.map((m) => {
      const v = this.s.parentVoices!.find((x) => x.id === m.voiceId)!;
      return { id: m.id, from: v.relation, label: this.label(v), text: m.text, audioUrl: v.status === "active" ? `${base}/voice/audio/message/${m.id}` : null, createdAt: m.createdAt };
    });
    return {
      kind: "voice_messages",
      title: `Messages for ${child.name}`,
      child: child.name,
      messages: items,
      speech: `${child.name}, you have ${items.length === 1 ? "a message" : `${items.length} messages`} from ${[...new Set(items.map((i) => i.from))].join(" and ")}.`,
    };
  }

  // ---------------------------------------------------------------- audio (only stories and messages)

  /** The only texts a parent voice will ever speak. */
  private scriptFor(kind: "story" | "message", id: string): { voice: ParentVoice; text: string } {
    const s = this.s;
    if (kind === "story") {
      const st = s.stories.find((x) => x.id === id);
      const voice = st?.voiceId ? s.parentVoices!.find((v) => v.id === st.voiceId) : undefined;
      if (!st || !voice) throw new BuddyError("No story in a parent's voice with that id.");
      const child = s.learners.find((l) => l.id === st.childId);
      return { voice, text: [`${st.title}.`, ...st.pages, st.question ? `${child?.name ?? ""}, ${st.question.charAt(0).toLowerCase()}${st.question.slice(1)}` : ""].join("\n\n") };
    }
    const m = s.voiceMessages!.find((x) => x.id === id);
    const voice = m ? s.parentVoices!.find((v) => v.id === m.voiceId) : undefined;
    if (!m || !voice) throw new BuddyError("No message with that id.");
    return { voice, text: m.text };
  }

  async audio(kind: "story" | "message", id: string): Promise<Buffer> {
    const { voice, text } = this.scriptFor(kind, id);
    if (voice.status !== "active") throw new BuddyError(`${voice.relation}'s voice is paused.`);
    const file = this.audioDir ? path.join(this.audioDir, `${id}.mp3`) : null;
    if (file && existsSync(file)) return readFileSync(file);
    const audio = await this.provider.synthesize(voice.providerVoiceId, text);
    if (file) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, audio);
    }
    return audio;
  }

  private dropAudio(id: string) {
    if (!this.audioDir) return;
    const f = path.join(this.audioDir, `${id}.mp3`);
    if (existsSync(f)) rmSync(f);
  }
}
