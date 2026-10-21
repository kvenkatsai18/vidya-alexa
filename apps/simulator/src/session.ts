import { randomUUID } from "node:crypto";
import type { CallToolResult, ElicitRequest, ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { detectConcern } from "../../../packages/mcp-server/src/domain/safety.ts";
import type { AgentContext, VoiceAgent } from "./agent.ts";
import { McpConnection, type TraceFrame } from "./mcp-client.ts";

export type SimEvent =
  | { type: "trace"; frame: TraceFrame }
  | { type: "status"; state: "thinking" | "idle" }
  | { type: "user"; text: string; source: "voice" | "tap" | "text" }
  | { type: "tool"; phase: "call" | "result"; name: string; args?: unknown; isError?: boolean; ms?: number }
  | { type: "card"; toolName: string; uri: string; html: string; input: unknown; result: CallToolResult }
  | { type: "speech"; text: string }
  | { type: "elicit"; id: string; message: string; schema: unknown; url?: string }
  | { type: "learner"; name: string; level?: string }
  | { type: "audio"; items: Array<{ url: string; label: string; fallbackText: string }> }
  | { type: "voice_ready" }
  | { type: "alert"; guardian: string | null; category: string; learner?: string }
  | { type: "sampling"; purpose: string; ms: number }
  | { type: "elicit_done"; id: string; action: string }
  | { type: "learned"; lesson: string }
  | { type: "error"; message: string };

const YES = /^(yes|yeah|yep|yup|sure|ok(ay)?|confirm|do it|place it|book it|buy it|go ahead|please do|absolutely|definitely)\b/i;
const NO = /^(no|nope|nah|cancel|don'?t|stop|never ?mind|wait|not now)\b/i;

interface PendingElicit {
  id: string;
  message: string;
  /** A single yes/no confirmation (can be answered by voice) vs a form to fill in. */
  isConfirm: boolean;
  resolve: (r: ElicitResult) => void;
}

/** "Thanks, that's enough for today", "ok good night", "bye", "I'm done for now". */
const GOODBYE = /\b(bye|good ?night|that'?s (enough|it|all) for (today|now|tonight)|i'?m done( for (today|now|tonight))?|see you( tomorrow| later)?|gotta go|talk (to you )?later)\b/i;

export class Session {
  readonly id = randomUUID();
  mcp!: McpConnection;
  private listeners = new Set<(e: SimEvent) => void>();
  private backlog: SimEvent[] = [];
  private pending?: PendingElicit;
  private busy = false;
  /** What the learner actually said this turn: lessons are only saved if these words ask for a change. */
  private heardNow = "";
  /** Latest version of each live game this device has shown, so a push doesn't repeat our own result. */
  private gameVersions = new Map<string, number>();
  lastActive = Date.now();

  private constructor(
    readonly agent: VoiceAgent,
    private mcpUrl: string,
    readonly home: string,
    private timeZone?: string,
  ) {}
  /** The day the agent was last told the date (models don't know today's date on their own). */
  private toldDay = "";

  static async create(agent: VoiceAgent, mcpUrl: string, home = "home", timeZone?: string): Promise<Session> {
    const s = new Session(agent, mcpUrl, home, timeZone);
    s.mcp = await McpConnection.connect(mcpUrl, {
      home,
      timeZone,
      accessToken: process.env.BUDDY_ACCESS_TOKEN || undefined,
      onResourceUpdated: (uri) => void s.gameUpdated(uri),
      onTrace: (frame) => s.emit({ type: "trace", frame }),
      onElicit: (params) => s.elicit(params),
      onElicitComplete: (elicitationId) => {
        if (elicitationId.startsWith("school-")) {
          s.emit({ type: "voice_ready" });
          // Connected, or Google said they're under 13 and a parent has to do it: say which.
          void s
            .ctx()
            .callTool("school_status", {})
            .then((r) => {
              const sc = (r.structuredContent ?? {}) as { kind?: string; speech?: string };
              const parent = sc.kind === "school_needs_parent";
              s.agent.note?.(parent ? `Connecting school didn't go through: ${sc.speech}` : "The learner's school is now connected and synced (read-only). They can ask what homework they have.");
              s.emit({ type: "speech", text: parent ? sc.speech! : "Your school is connected! Ask me what homework you have, or what's coming up." });
            })
            .catch(() => s.emit({ type: "speech", text: "Your school is connected! Ask me what homework you have, or what's coming up." }));
          return;
        }
        s.emit({ type: "voice_ready" });
        s.agent.note?.("The parent finished recording; their story voice is now ready to use for bedtime stories.");
        s.emit({ type: "speech", text: "Your story voice is ready! Next time, just ask for a bedtime story in your voice." });
      },
      onSample: agent.sample
        ? async (params) => {
            const started = Date.now();
            const r = await agent.sample!(params);
            s.emit({ type: "sampling", purpose: String((params.metadata as any)?.purpose ?? "generate"), ms: Date.now() - started });
            return r;
          }
        : undefined,
    });
    return s;
  }

  get agentLabel() {
    return this.agent.label;
  }

  subscribe(fn: (e: SimEvent) => void): () => void {
    for (const e of this.backlog) fn(e);
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(e: SimEvent) {
    this.backlog.push(e);
    if (this.backlog.length > 400) this.backlog.splice(0, this.backlog.length - 400);
    for (const fn of this.listeners) fn(e);
  }

  /** Server -> client elicitation: confirmations (answerable by voice) and short forms (shown on screen). */
  private elicit(params: ElicitRequest["params"]): Promise<ElicitResult> {
    const id = randomUUID();
    const message = "message" in params ? params.message : "Please confirm.";
    const schema = ("requestedSchema" in params ? params.requestedSchema : undefined) as { properties?: Record<string, { type?: string }> } | undefined;
    const props = Object.entries(schema?.properties ?? {});
    const url = "url" in params && params.mode === "url" ? params.url : undefined;
    const isConfirm = !!url || (props.length === 1 && props[0][1].type === "boolean");
    return new Promise((resolve) => {
      this.pending = { id, message, isConfirm, resolve };
      this.emit({ type: "elicit", id, message, schema, ...(url ? { url } : {}) } as SimEvent);
      this.emit({ type: "speech", text: isConfirm ? `${message} Should I go ahead?` : `${message} Fill it in on the screen, or just tell me.` });
    });
  }

  answerElicit(id: string, action: "accept" | "decline" | "cancel", content?: Record<string, string | number | boolean | string[]>) {
    if (!this.pending || this.pending.id !== id) return false;
    const p = this.pending;
    this.pending = undefined;
    this.emit({ type: "elicit_done", id, action });
    p.resolve(action === "accept" ? { action, content: content ?? (p.isConfirm ? { confirm: true } : {}) } : { action });
    return true;
  }

  private ctx(): AgentContext {
    return {
      mcp: this.mcp,
      callTool: async (name, args) => {
        // The AI may not invent corrections: the server checks lessons against the learner's real words.
        if (name === "learn_from_feedback") args = { ...args, learner_said: this.heardNow };
        // Grade what the learner actually said, never the model's tidied-up version of it.
        if (name === "answer_question" && this.heardNow) args = { ...args, answer: this.heardNow.replace(/^\s*(hey |ok |okay )?alexa[,!.]?\s*/i, "") };
        // "One more example, with a car engine?" is a new explanation, not web research.
        if (name === "research_topic" && /\b(example|explain|another way|walk me through|show me how)\b/i.test(this.heardNow) && !/\b(research|latest|new|news|recent|look (it |that )?up|search|beyond|real[- ]world|real life|used in)\b/i.test(this.heardNow)) {
          name = "explain_concept";
          args = { style: "example", request: this.heardNow };
        }
        // "Delete my study plan" is not "delete my whole profile": everything=true needs those words.
        if (name === "forget" && args.everything && !/\b(everything|all (about|of) me|(my|the) (whole |entire )?(profile|account)|all my (data|info)|start (over|fresh)|reset)\b/i.test(this.heardNow)) {
          if (/\b(plan|notes?|study sets?|topics?|decks?|material|subjects?)\b/i.test(this.heardNow)) {
            name = "delete_study_set";
            args = { all: true };
          } else {
            return { isError: true, content: [{ type: "text", text: "Not deleted: the learner didn't ask to delete their whole profile. Ask them exactly what to delete (a study set, a memory, or a lesson)." }] };
          }
        }
        // "What?" in a quiz means "say it again", not "give me a hint".
        if (name === "quiz_action" && args.action === "hint" && /^\W*(what|huh|pardon( me)?|sorry|come again|say (that|it) again|repeat( that| it)?|what was (that|the question))\W*$/i.test(this.heardNow.replace(/^\s*(hmm+|um+|uh+|alexa)[,.]?\s*/i, ""))) args = { ...args, action: "repeat" };
        const started = Date.now();
        this.emit({ type: "tool", phase: "call", name, args });
        const result = await this.mcp.callTool(name, args);
        this.emit({ type: "tool", phase: "result", name, isError: result.isError === true, ms: Date.now() - started });
        const sc = result.structuredContent as
          | { learner?: { name: string; level?: string; role?: string }; audioUrl?: string; voiceLabel?: string; title?: string; pages?: string[]; question?: string; messages?: Array<{ audioUrl: string | null; label: string; text: string }> }
          | undefined;
        // Parent-voice audio (stories / goodnight messages) plays on the device after the spoken intro.
        if (sc?.audioUrl) this.emit({ type: "audio", items: [{ url: sc.audioUrl, label: sc.voiceLabel ?? "", fallbackText: [sc.title, ...(sc.pages ?? []), sc.question].filter(Boolean).join(" ") }] });
        const msgs = (sc?.messages ?? []).filter((m) => m.audioUrl);
        if (msgs.length) this.emit({ type: "audio", items: msgs.map((m) => ({ url: m.audioUrl!, label: m.label, fallbackText: m.text })) });
        const flagged = result.structuredContent as { kind?: string; guardian?: string | null; category?: string; learner?: { name: string } } | undefined;
        if (flagged?.kind === "concern_flagged" && flagged.guardian) this.emit({ type: "alert", guardian: flagged.guardian ?? null, category: flagged.category ?? "", learner: flagged.learner?.name });
        const speaker = (result.structuredContent as { speaker?: string } | undefined)?.speaker;
        if (speaker) this.emit({ type: "learner", name: speaker });
        else if (sc?.learner?.name && (sc.learner.role !== "child" || name === "switch_learner" || name === "get_today" || name === "set_up_learner")) this.emit({ type: "learner", name: sc.learner.name, level: sc.learner.level });
        const game = result.structuredContent as { gameUri?: string; version?: number; status?: string } | undefined;
        if (game?.gameUri && !result.isError) {
          this.gameVersions.set(game.gameUri, Math.max(game.version ?? 0, this.gameVersions.get(game.gameUri) ?? 0));
          if (game.status === "done") void this.mcp.unsubscribe(game.gameUri);
          else void this.mcp.subscribe(game.gameUri);
        }
        if (!result.isError && (result.structuredContent as { kind?: string } | undefined)?.kind !== "lesson_skipped") {
          const ui = await this.mcp.uiFor(name).catch(() => null);
          if (ui) this.emit({ type: "card", toolName: name, uri: ui.uri, html: ui.html, input: args, result });
        }
        return result;
      },
    };
  }

  /** Another home did something in our online game: show the new state and say what happened. */
  private async gameUpdated(uri: string) {
    try {
      const view = await this.mcp.readJson(uri);
      if ((view.version ?? 0) <= (this.gameVersions.get(uri) ?? 0)) return;
      this.gameVersions.set(uri, view.version);
      if (view.status === "done") void this.mcp.unsubscribe(uri);
      this.agent.observe?.(view);
      this.agent.note?.(`Online game update (${view.code}): ${view.speech} ${view.yourTurn ? "It's this learner's turn; their next words are their answer (online_game_answer)." : ""}`.trim());
      const ui = await this.mcp.uiFor("online_game_action").catch(() => null);
      if (ui) this.emit({ type: "card", toolName: "online_game_action", uri: ui.uri, html: ui.html, input: {}, result: { content: [{ type: "text", text: JSON.stringify(view) }], structuredContent: view } });
      if (view.speech) this.emit({ type: "speech", text: view.speech });
    } catch {
      // The game ended or expired; nothing to show.
    }
  }

  /**
   * Notes shared from the learner's phone (in Alexa+, documents can be shared to Alexa from the app).
   * The server turns them into a study set; the agent is told so it can carry on naturally.
   */
  async shareNotes(title: string, text: string) {
    if (this.busy) {
      this.emit({ type: "speech", text: "One second, I'm still working on that." });
      return;
    }
    this.lastActive = Date.now();
    this.busy = true;
    this.emit({ type: "user", text: `Shared notes: ${title}`, source: "tap" });
    this.emit({ type: "status", state: "thinking" });
    try {
      const result = await this.ctx().callTool("add_material", { title, text });
      const sc = result.structuredContent as { speech?: string; title?: string } | undefined;
      this.agent.note?.(`The learner just shared notes titled "${title}" from their phone. Study Buddy already added them as the study set "${sc?.title ?? title}" and told them so.`);
      this.emit({ type: "speech", text: sc?.speech ?? "Got your notes." });
    } catch (e) {
      this.emit({ type: "error", message: (e as Error).message });
    } finally {
      this.busy = false;
      this.emit({ type: "status", state: "idle" });
    }
  }

  /** Card-initiated tools/call (MCP Apps views may call server tools through the host). */
  async callToolFromView(name: string, args: Record<string, unknown>) {
    return this.ctx().callTool(name, args);
  }

  async turn(text: string, source: "voice" | "tap" | "text", interrupted?: { said: string; unsaid: string; answering?: boolean }) {
    this.lastActive = Date.now();
    const utterance = text.trim();
    if (!utterance) return;
    this.emit({ type: "user", text: utterance, source });
    this.heardNow = utterance;
    if (interrupted?.answering) {
      this.agent.note?.(`The learner answered before you finished reading the quiz question (you had said: "${interrupted.said || "(nothing yet)"}"). Their words are their answer: grade them with answer_question, unless they clearly asked for something else (hint, skip, repeat, stop).`);
    } else if (interrupted) {
      this.agent.note?.(
        `The learner interrupted you mid-reply. You had already said: "${interrupted.said || "(nothing yet)"}". You had not yet said: "${interrupted.unsaid}". Their next words are their reaction: respond to that in context, carry on from where it makes sense, and don't repeat what you already said.`,
      );
    }

    if (this.pending) {
      const said = utterance.replace(/^\s*alexa[,!.]?\s*/i, "");
      if (this.pending.isConfirm) {
        if (YES.test(said)) return void this.answerElicit(this.pending.id, "accept", { confirm: true });
        if (NO.test(said)) return void this.answerElicit(this.pending.id, "decline");
        this.emit({ type: "speech", text: "Should I go ahead? You can say yes or no." });
        return;
      }
      // A form is open but the learner just talked instead: close the form and let the agent handle it by voice.
      this.answerElicit(this.pending.id, "cancel");
      for (let i = 0; i < 200 && this.busy; i++) await new Promise((r) => setTimeout(r, 50));
    }
    if (this.busy) {
      this.emit({ type: "speech", text: "One second, I'm still working on that." });
      return;
    }

    this.busy = true;
    this.emit({ type: "status", state: "thinking" });
    try {
      if (GOODBYE.test(utterance)) {
        this.agent.note?.("They're wrapping up for now. If a quiz is running, end it (quiz_action end). Then say one or two warm sentences: what they did and what's next. Don't read out a plan, list topics, or ask a question.");
      }
      const now = new Date();
      const day = now.toLocaleDateString("en-US", { timeZone: this.timeZone, weekday: "long", year: "numeric", month: "long", day: "numeric" });
      if (day !== this.toldDay) {
        this.toldDay = day;
        this.agent.note?.(`Today is ${day}.`);
      }
      // A correction ("too easy", "call me Priya A") applies to this very reply, not just the next one.
      const pre = await this.mcp.callTool("record_turn", { heard: utterance, said: "", phase: "heard" }).catch(() => undefined);
      const learnedNow = (pre?.structuredContent as { learned?: { lesson: string } | null } | undefined)?.learned;
      const examNow = (pre?.structuredContent as { exam?: { title: string; when: string; daysAway: number } | null } | undefined)?.exam;
      if (examNow) this.agent.note?.(`Saved from what they just said: their ${examNow.title} is ${examNow.when} (${examNow.daysAway} days away). It's on their plan; mention it briefly, no need to save it again.`);
      if (learnedNow?.lesson) {
        this.emit({ type: "learned", lesson: learnedNow.lesson });
        this.agent.note?.(`The learner just taught you: "${learnedNow.lesson}". Follow it from this reply on.`);
      }
      // Safety first, whatever model is plugged in: worrying words get the caring reply (and a linked
      // parent is alerted) before the model runs, so it never depends on the model choosing to.
      const worry = detectConcern(utterance);
      if (worry) {
        const r = await this.ctx().callTool("flag_concern", { category: worry.category, severity: worry.severity, summary: worry.summary, excerpt: utterance });
        const sc = (r.structuredContent ?? {}) as { speech?: string; guardian?: string | null };
        const speech = sc.speech || "Thank you for telling me. Please talk to an adult you trust about this.";
        this.agent.note?.(`The learner just said: "${utterance}". Study Buddy already answered with a caring safety reply${sc.guardian ? ` and alerted their ${sc.guardian.toLowerCase()}` : ""}. Be gentle, and don't go back to studying unless they ask.`);
        this.emit({ type: "speech", text: speech });
        await this.mcp.callTool("record_turn", { heard: utterance, said: speech, phase: "said" }).catch(() => undefined);
        return;
      }
      const speech = await this.agent.turn(this.ctx(), utterance);
      this.emit({ type: "speech", text: speech });
      // Keep the family's conversation history (parents can review it); this also backstops safety detection.
      const logged = await this.mcp.callTool("record_turn", { heard: utterance, said: speech, phase: "said" }).catch(() => undefined);
      const c = (logged?.structuredContent as { concern?: { guardian?: string | null; category?: string; learner?: { name: string } } | null } | undefined)?.concern;
      if (c?.guardian) this.emit({ type: "alert", guardian: c.guardian ?? null, category: c.category ?? "", learner: c.learner?.name });
    } catch (e) {
      console.error(e);
      const msg = (e as Error).message ?? String(e);
      this.emit({ type: "error", message: msg });
      const busy = /Throttling|Too many requests|ServiceUnavailable/i.test(msg);
      this.emit({ type: "speech", text: busy ? "Sorry, I'm a little swamped right now. Give me a few seconds and say that again?" : "Sorry, something went wrong on my end. Please try that again." });
    } finally {
      this.busy = false;
      this.emit({ type: "status", state: "idle" });
    }
  }

  resetConversation() {
    this.agent.reset();
    if (this.pending) this.answerElicit(this.pending.id, "cancel");
  }

  async close() {
    this.listeners.clear();
    await this.mcp.close().catch(() => {});
  }
}
