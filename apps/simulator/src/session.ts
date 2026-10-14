import { randomUUID } from "node:crypto";
import type { CallToolResult, ElicitRequest, ElicitResult } from "@modelcontextprotocol/sdk/types.js";
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
  | { type: "sampling"; purpose: string; ms: number }
  | { type: "elicit_done"; id: string; action: string }
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

export class Session {
  readonly id = randomUUID();
  mcp!: McpConnection;
  private listeners = new Set<(e: SimEvent) => void>();
  private backlog: SimEvent[] = [];
  private pending?: PendingElicit;
  private busy = false;
  lastActive = Date.now();

  private constructor(
    readonly agent: VoiceAgent,
    private mcpUrl: string,
  ) {}

  static async create(agent: VoiceAgent, mcpUrl: string): Promise<Session> {
    const s = new Session(agent, mcpUrl);
    s.mcp = await McpConnection.connect(mcpUrl, {
      onTrace: (frame) => s.emit({ type: "trace", frame }),
      onElicit: (params) => s.elicit(params),
      onElicitComplete: () => {
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
        if (sc?.learner?.name && sc.learner.role !== "child") this.emit({ type: "learner", name: sc.learner.name, level: sc.learner.level });
        if (!result.isError) {
          const ui = await this.mcp.uiFor(name).catch(() => null);
          if (ui) this.emit({ type: "card", toolName: name, uri: ui.uri, html: ui.html, input: args, result });
        }
        return result;
      },
    };
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

  async turn(text: string, source: "voice" | "tap" | "text") {
    this.lastActive = Date.now();
    const utterance = text.trim();
    if (!utterance) return;
    this.emit({ type: "user", text: utterance, source });

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
      const speech = await this.agent.turn(this.ctx(), utterance);
      this.emit({ type: "speech", text: speech });
    } catch (e) {
      console.error(e);
      const msg = (e as Error).message ?? String(e);
      this.emit({ type: "error", message: msg });
      this.emit({ type: "speech", text: "Sorry, something went wrong on my end. Please try that again." });
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
