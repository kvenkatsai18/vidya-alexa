import Anthropic from "@anthropic-ai/sdk";
import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { RequestId } from "@modelcontextprotocol/sdk/types.js";

export interface LlmRequest {
  /** Short label shown to the client when it approves a sampling request. */
  purpose: string;
  system: string;
  prompt: string;
  maxTokens?: number;
}

export interface Llm {
  readonly name: string;
  complete(req: LlmRequest): Promise<string>;
}

/**
 * MCP sampling: the server asks the *client's* model to generate (sampling/createMessage).
 * The server needs no API key of its own, and the user's assistant stays in control of which
 * model runs and whether the request is allowed.
 */
export class SamplingLlm implements Llm {
  readonly name = "MCP sampling (client's model)";
  constructor(
    private server: Server,
    private relatedRequestId?: RequestId,
  ) {}

  async complete(req: LlmRequest): Promise<string> {
    const res = await this.server.createMessage(
      {
        messages: [{ role: "user", content: { type: "text", text: req.prompt } }],
        systemPrompt: req.system,
        maxTokens: req.maxTokens ?? 2000,
        includeContext: "none",
        modelPreferences: { hints: [{ name: "claude" }], speedPriority: 0.7, intelligencePriority: 0.6, costPriority: 0.3 },
        metadata: { purpose: req.purpose },
      },
      { relatedRequestId: this.relatedRequestId, timeout: 120_000 },
    );
    const content = Array.isArray(res.content) ? res.content : [res.content];
    return content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
  }
}

/** The server's own model, used when the client can't sample (configure ANTHROPIC_API_KEY or BUDDY_LLM=bedrock). */
export class DirectLlm implements Llm {
  readonly name: string;
  private client: Anthropic | AnthropicBedrockMantle;

  constructor(
    private provider: "anthropic" | "bedrock",
    private model: string,
  ) {
    if (provider === "bedrock") {
      this.client = new AnthropicBedrockMantle({ awsRegion: process.env.AWS_REGION ?? "us-east-1" });
      this.name = `${model} on Amazon Bedrock`;
    } else {
      this.client = new Anthropic();
      this.name = `${model} via Anthropic API`;
    }
  }

  async complete(req: LlmRequest): Promise<string> {
    const params = {
      model: this.provider === "bedrock" && !this.model.startsWith("anthropic.") ? `anthropic.${this.model}` : this.model,
      max_tokens: Math.max(4000, req.maxTokens ?? 2000),
      system: req.system,
      messages: [{ role: "user" as const, content: req.prompt }],
      output_config: { effort: "low" as const },
    };
    const res =
      this.provider === "anthropic"
        ? await (this.client as Anthropic).beta.messages.create({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" })
        : await (this.client as AnthropicBedrockMantle).beta.messages.create(params);
    if (res.stop_reason === "refusal") throw new Error("The model declined this request.");
    return res.content
      .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  }
}

export function directLlmFromEnv(): Llm | null {
  const mode = process.env.BUDDY_LLM;
  const model = process.env.BUDDY_MODEL ?? "claude-opus-5-5";
  if (mode === "offline") return null;
  if (mode === "bedrock") return new DirectLlm("bedrock", model);
  if (mode === "anthropic" || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return new DirectLlm("anthropic", model);
  return null;
}

/** Pull the first JSON object out of a model reply (tolerates code fences and stray prose). */
export function parseJson<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("No JSON object in model reply");
  return JSON.parse(body.slice(start, end + 1)) as T;
}
