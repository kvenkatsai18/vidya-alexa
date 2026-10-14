import Anthropic from "@anthropic-ai/sdk";
import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";
import type { CallToolResult, CreateMessageRequest, CreateMessageResult } from "@modelcontextprotocol/sdk/types.js";
import type { AgentContext, VoiceAgent } from "./agent.ts";
import type { LoadedSkill } from "./skill.ts";

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type ToolParam = Anthropic.Beta.Messages.BetaTool;
type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ClaudeAgentOptions {
  provider: "anthropic" | "bedrock";
  model: string;
  effort: Effort;
  skills: LoadedSkill[];
}

const MAX_TOOL_ROUNDS = 8;

const DEVICE_CONTEXT = `## This device
You are running as an Alexa+ add-on on a smart display in the learner's room (simulated in a web page).
- Your final reply is spoken aloud by text-to-speech and shown as a caption. Talk like a person in a live conversation: react to what they said, use contractions and short sentences, and end by handing the turn back. Plain sentences only: no markdown, bullet points, emoji, or IDs. Never read card text verbatim.
- Study Buddy tool results render as cards on the screen automatically. Don't describe the card.
- Taps on card buttons arrive as ordinary user messages.
- Notes the learner shares from their phone are added for you and announced as context.
- When a tool asks the user to confirm something or fill in a form, the device shows it. You'll get the outcome back as the tool result.
Latency-sensitive; begin your visible answer immediately.`;

/** Claude as the Alexa+ "brain": the Messages API with the Study Buddy MCP tools, on the Anthropic API or Amazon Bedrock. */
export class ClaudeAgent implements VoiceAgent {
  readonly label: string;
  private client: Anthropic | AnthropicBedrockMantle;
  private history: MessageParam[] = [];
  private notes: string[] = [];

  constructor(private opts: ClaudeAgentOptions) {
    if (opts.provider === "bedrock") {
      this.client = new AnthropicBedrockMantle({ awsRegion: process.env.AWS_REGION ?? "us-east-1" });
      this.label = `Claude (${opts.model}) on Amazon Bedrock`;
    } else {
      this.client = new Anthropic();
      this.label = `Claude (${opts.model}) via Anthropic API`;
    }
  }

  reset() {
    this.history = [];
    this.notes = [];
  }

  note(text: string) {
    this.notes.push(text);
  }

  /**
   * Answers the server's MCP sampling requests (sampling/createMessage) with the same model, so the
   * Study Buddy server can generate decks, explanations and grades without an API key of its own.
   */
  async sample(params: CreateMessageRequest["params"]): Promise<CreateMessageResult> {
    const messages = params.messages.map((m) => ({
      role: m.role,
      content: (Array.isArray(m.content) ? m.content : [m.content])
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => ({ type: "text" as const, text: c.text })),
    }));
    const response = await this.create({
      model: this.modelId(),
      max_tokens: Math.max(1024, params.maxTokens),
      ...(params.systemPrompt ? { system: params.systemPrompt } : {}),
      messages,
      output_config: { effort: "low" },
    });
    return {
      role: "assistant",
      model: response.model,
      stopReason: response.stop_reason === "max_tokens" ? "maxTokens" : "endTurn",
      content: { type: "text", text: spokenText(response.content, false) },
    };
  }

  private modelId() {
    return this.opts.provider === "bedrock" && !this.opts.model.startsWith("anthropic.") ? `anthropic.${this.opts.model}` : this.opts.model;
  }

  private system(ctx: AgentContext): string {
    return [...this.opts.skills.map((sk) => sk.instructions), DEVICE_CONTEXT, ctx.mcp.instructions ? `## Study Buddy server instructions\n${ctx.mcp.instructions}` : ""]
      .filter(Boolean)
      .join("\n\n");
  }

  private tools(ctx: AgentContext): ToolParam[] {
    return ctx.mcp.tools.map((t) => ({
      name: t.name,
      description: t.description ?? t.title ?? t.name,
      input_schema: t.inputSchema as ToolParam["input_schema"],
    }));
  }

  private create(params: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming) {
    if (this.opts.provider === "anthropic") {
      // Server-side refusal fallback (Claude API only): a declined request is re-run on Anthropic's recommended model.
      return (this.client as Anthropic).beta.messages.create({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" });
    }
    return (this.client as AnthropicBedrockMantle).beta.messages.create(params);
  }

  async turn(ctx: AgentContext, text: string): Promise<string> {
    // Append-only history: assistant content (including thinking blocks) is echoed back unchanged.
    const context = this.notes.splice(0).map((n) => `(${n})`).join("\n");
    this.history.push({ role: "user", content: context ? `${context}\n\n${text}` : text });
    const system = this.system(ctx);
    const tools = this.tools(ctx);

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await this.create({
        model: this.modelId(),
        max_tokens: 16000,
        system,
        tools,
        messages: this.history,
        output_config: { effort: this.opts.effort },
        // The skill + tool definitions are identical every turn: cache the prefix to cut latency and cost.
        cache_control: { type: "ephemeral" },
      });
      this.history.push({ role: "assistant", content: response.content as MessageParam["content"] });

      if (response.stop_reason === "refusal") {
        return "Sorry, I can't help with that one. I can help with repairs, parts, and home maintenance.";
      }
      if (response.stop_reason === "pause_turn") continue;

      const toolUses = response.content.filter((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === "tool_use");
      if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
        return spokenText(response.content) || "Okay.";
      }

      // Run tool calls in parallel and return every result in a single user message.
      const results = await Promise.all(
        toolUses.map(async (tu) => {
          let result: CallToolResult;
          try {
            result = await ctx.callTool(tu.name, (tu.input ?? {}) as Record<string, unknown>);
          } catch (e) {
            result = { isError: true, content: [{ type: "text", text: `Tool failed: ${(e as Error).message}` }] };
          }
          return {
            type: "tool_result" as const,
            tool_use_id: tu.id,
            is_error: result.isError === true,
            content: result.content
              .filter((c) => c.type === "text")
              .map((c) => ({ type: "text" as const, text: (c as { text: string }).text })),
          };
        }),
      );
      this.history.push({ role: "user", content: results });
    }
    return "Sorry, that took longer than I expected. Could you say that again?";
  }
}

function spokenText(content: Anthropic.Beta.Messages.BetaContentBlock[], forSpeech = true): string {
  const text = content
    .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join(forSpeech ? " " : "\n");
  return forSpeech ? text.replace(/[*_#`]/g, "").replace(/\s+/g, " ").trim() : text;
}
