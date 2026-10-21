import { ConverseCommand, type ContentBlock, type Message } from "@aws-sdk/client-bedrock-runtime";
import type { CallToolResult, CreateMessageRequest, CreateMessageResult } from "@modelcontextprotocol/sdk/types.js";
import { bedrockClient, converseText, converseTools, modelLabel, replyText, type ConverseClient } from "../../../packages/mcp-server/src/domain/bedrock.ts";
import { DEVICE_CONTEXT, DEVICE_RULES, type AgentContext, type VoiceAgent } from "./agent.ts";
import type { LoadedSkill } from "./skill.ts";

export interface BedrockAgentOptions {
  /** Conversation model, e.g. us.amazon.nova-2-lite-v1:0 */
  model: string;
  /** Model that answers the server's sampling requests (study sets, grading, stories). */
  genModel: string;
  skills: LoadedSkill[];
  client?: ConverseClient;
}

const MAX_TOOL_ROUNDS = 8;

/**
 * Smaller models drift into chat-style answers (headings, 140 words) over a long conversation, even with
 * the rules in the system prompt. A one-line reminder on every turn keeps it sounding like a voice.
 */
const VOICE_REMINDER = "[Voice device: call the Study Buddy tools as usual (explaining, quizzing, repeating a question all go through them), then say a few short spoken sentences, no headings or lists. Say a tool's speech as it is, don't expand it.]";

/**
 * Amazon Nova on Amazon Bedrock as the device's "brain": the Converse API with the Study Buddy MCP
 * tools. Any Bedrock model with tool use works through BUDDY_MODEL.
 */
export class BedrockAgent implements VoiceAgent {
  readonly label: string;
  private client: ConverseClient;
  private history: Message[] = [];
  private notes: string[] = [];

  constructor(private opts: BedrockAgentOptions) {
    this.client = opts.client ?? bedrockClient();
    this.label = `${modelLabel(opts.model)} on Amazon Bedrock`;
  }

  reset() {
    this.history = [];
    this.notes = [];
  }

  note(text: string) {
    this.notes.push(text);
  }

  /** Answers the server's MCP sampling requests (sampling/createMessage) on Bedrock. */
  async sample(params: CreateMessageRequest["params"]): Promise<CreateMessageResult> {
    const prompt = params.messages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : [m.content]))
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n\n");
    const text = await converseText(this.client, { modelId: this.opts.genModel, system: params.systemPrompt, prompt, maxTokens: params.maxTokens, temperature: params.temperature });
    return { role: "assistant", model: this.opts.genModel, stopReason: "endTurn", content: { type: "text", text } };
  }

  private system(ctx: AgentContext): string {
    return [...this.opts.skills.map((sk) => sk.instructions), DEVICE_CONTEXT, ctx.mcp.instructions ? `## Study Buddy server instructions\n${ctx.mcp.instructions}` : "", DEVICE_RULES]
      .filter(Boolean)
      .join("\n\n");
  }

  async turn(ctx: AgentContext, text: string): Promise<string> {
    const context = this.notes.splice(0).map((n) => `(${n})`).join("\n");
    // If this turn fails part-way, roll back so the history keeps alternating user/assistant (Converse requires it).
    const mark = this.history.length;
    this.history.push({ role: "user", content: [{ text: `${context ? `${context}\n\n` : ""}${text}\n\n${VOICE_REMINDER}` }] });
    const system = [{ text: this.system(ctx) }];
    const toolConfig = { tools: converseTools(ctx.mcp.tools as never) };

    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const out = await this.client.send(
          new ConverseCommand({
            modelId: this.opts.model,
            system,
            messages: this.history,
            toolConfig,
            // Greedy decoding is the recommended setting for reliable tool calls.
            inferenceConfig: { maxTokens: 2000, temperature: 0 },
          }),
        );
        if (out.stopReason === "guardrail_intervened" || out.stopReason === "content_filtered") {
          this.history.length = mark;
          return "Sorry, I can't help with that one. I can help you study, quiz you, or plan for a test.";
        }
        // Converse rejects blank text blocks when the history is sent back.
        const content = (out.output?.message?.content ?? []).filter((b) => !("text" in b) || (b.text ?? "").trim());
        this.history.push({ role: "assistant", content: content.length ? content : [{ text: "Okay." }] });

        const uses = content.filter((b): b is ContentBlock.ToolUseMember => "toolUse" in b && !!b.toolUse);
        if (out.stopReason !== "tool_use" || uses.length === 0) return replyText(content) || "Okay.";

        // Run tool calls in parallel and return every result in a single user message.
        const results = await Promise.all(
          uses.map(async ({ toolUse }): Promise<ContentBlock> => {
            let result: CallToolResult;
            try {
              result = await ctx.callTool(toolUse.name!, (toolUse.input ?? {}) as Record<string, unknown>);
            } catch (e) {
              result = { isError: true, content: [{ type: "text", text: `Tool failed: ${(e as Error).message}` }] };
            }
            const texts = result.content.filter((c) => c.type === "text").map((c) => ({ text: (c as { text: string }).text || "(empty)" }));
            return { toolResult: { toolUseId: toolUse.toolUseId!, status: result.isError ? "error" : "success", content: texts.length ? texts : [{ text: "(no content)" }] } };
          }),
        );
        this.history.push({ role: "user", content: results });
      }
      return "Sorry, that took longer than I expected. Could you say that again?";
    } catch (e) {
      this.history.length = mark;
      throw e;
    }
  }
}
