import { existsSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { bedrockClient, converseResearch, converseText, DEFAULT_BEDROCK_MODEL, modelLabel, type ConverseClient } from "./bedrock.ts";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { RequestId } from "@modelcontextprotocol/sdk/types.js";

export interface LlmRequest {
  /** Short label shown to the client when it approves a sampling request. */
  purpose: string;
  system: string;
  prompt: string;
  maxTokens?: number;
  /** 0 for judging (grading), higher for writing (stories, explanations). */
  temperature?: number;
}

export interface Llm {
  readonly name: string;
  complete(req: LlmRequest): Promise<string>;
  /** Present when this model can search the web (Amazon Nova Web Grounding on Bedrock). */
  research?(req: LlmRequest): Promise<{ text: string; sources: Array<{ url: string; domain: string; title?: string }> }>;
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
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        includeContext: "none",
        modelPreferences: { speedPriority: 0.7, intelligencePriority: 0.6, costPriority: 0.3 },
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

/**
 * The server's own model, used when the client can't sample. Default: Amazon Nova on Amazon Bedrock
 * (Converse API, any Bedrock model via BUDDY_MODEL). Alternative: Claude via the Anthropic API.
 */
export class DirectLlm implements Llm {
  readonly name: string;
  private bedrock?: ConverseClient;
  private anthropic?: Anthropic;

  constructor(
    private provider: "anthropic" | "bedrock",
    private model: string,
    client?: ConverseClient,
  ) {
    if (provider === "bedrock") {
      this.bedrock = client ?? bedrockClient();
      this.name = `${modelLabel(model)} on Amazon Bedrock`;
    } else {
      this.anthropic = new Anthropic();
      this.name = `${model} via Anthropic API`;
    }
  }

  /** Web research: Nova Web Grounding works with Nova 2 models, so research uses BUDDY_RESEARCH_MODEL (Nova 2 Lite by default). */
  async research(req: LlmRequest) {
    if (!this.bedrock) throw new Error("Web research needs Amazon Nova on Bedrock.");
    return converseResearch(this.bedrock, { modelId: process.env.BUDDY_RESEARCH_MODEL ?? DEFAULT_BEDROCK_MODEL, system: req.system, prompt: req.prompt, maxTokens: req.maxTokens });
  }

  async complete(req: LlmRequest): Promise<string> {
    if (this.bedrock) return converseText(this.bedrock, { modelId: this.model, system: req.system, prompt: req.prompt, maxTokens: Math.max(4000, req.maxTokens ?? 2000), temperature: req.temperature });
    const res = await this.anthropic!.beta.messages.create({
      model: this.model,
      max_tokens: Math.max(4000, req.maxTokens ?? 2000),
      system: req.system,
      messages: [{ role: "user" as const, content: req.prompt }],
      output_config: { effort: "low" as const },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    if (res.stop_reason === "refusal") throw new Error("The model declined this request.");
    return res.content
      .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  }
}

export type LlmMode = "bedrock" | "anthropic" | "offline";

/** Default order: Amazon Bedrock (AWS credentials), then the Anthropic API, then offline. BUDDY_LLM forces one. */
export function llmModeFromEnv(): LlmMode {
  const forced = process.env.BUDDY_LLM;
  if (forced === "bedrock" || forced === "anthropic" || forced === "offline") return forced;
  if (forced === "fixture") return "offline"; // automated tests: scripted stand-ins, never a real model
  if (hasAwsCredentials()) return "bedrock";
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return "anthropic";
  return "offline";
}

/** The conversation model (BUDDY_MODEL) and the content-generation model (BUDDY_GEN_MODEL, defaults to the same). */
export function modelsFromEnv(mode: LlmMode): { model: string; genModel: string } {
  const model = process.env.BUDDY_MODEL ?? (mode === "anthropic" ? "claude-opus-5-5" : DEFAULT_BEDROCK_MODEL);
  return { model, genModel: process.env.BUDDY_GEN_MODEL ?? model };
}

export function directLlmFromEnv(): Llm | null {
  const mode = llmModeFromEnv();
  if (mode === "offline") return null;
  return new DirectLlm(mode, modelsFromEnv(mode).genModel);
}

/** AWS credentials available (env vars, a named profile, or ~/.aws files)? Then Amazon Nova on Bedrock is the default. */
export function hasAwsCredentials(): boolean {
  if (process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE || process.env.AWS_SESSION_TOKEN || process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI || process.env.AWS_WEB_IDENTITY_TOKEN_FILE) return true;
  const home = process.env.HOME ?? "";
  return !!home && (existsSync(`${home}/.aws/credentials`) || existsSync(`${home}/.aws/config`));
}


/** Pull the first JSON object out of a model reply (tolerates code fences and stray prose). */
export function parseJson<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("No JSON object in model reply");
  const raw = body.slice(start, end + 1);
  try {
    return JSON.parse(raw) as T;
  } catch {
    // Smaller models often write \' or raw line breaks inside strings, or a trailing comma. Repair and retry.
    return JSON.parse(repairJson(raw)) as T;
  }
}

/** Fix the usual model JSON slips: invalid escapes, raw control characters in strings, trailing commas. */
export function repairJson(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (!inString) {
      if (c === '"') inString = true;
      out += c;
      continue;
    }
    if (c === "\\") {
      const next = text[i + 1] ?? "";
      if ('"\\/bfnrt'.includes(next)) out += c + next;
      else if (next === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) out += c + next;
      else out += next; // \' -> '   \x -> x
      i++;
      continue;
    }
    if (c === '"') inString = false;
    if (c === "\n") out += "\\n";
    else if (c === "\r") out += "";
    else if (c === "\t") out += "\\t";
    else out += c;
  }
  return out.replace(/,\s*([}\]])/g, "$1");
}
