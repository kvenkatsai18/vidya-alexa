import { BedrockRuntimeClient, ConverseCommand, type ContentBlock, type ConverseCommandOutput, type Tool } from "@aws-sdk/client-bedrock-runtime";

/**
 * Amazon Bedrock through the Converse API: one request shape for every Bedrock model, so the project
 * defaults to Amazon Nova and can switch models with BUDDY_MODEL alone.
 */

/** Amazon Nova 2 Lite through the US cross-region inference profile: fast enough for voice, and good with tools. */
export const DEFAULT_BEDROCK_MODEL = "us.amazon.nova-2-lite-v1:0";

/** The one method we use, so tests can pass a fake. */
export interface ConverseClient {
  send(command: ConverseCommand): Promise<ConverseCommandOutput>;
}

export function bedrockClient(): ConverseClient {
  // New accounts have low request quotas: back off and retry instead of failing the learner's turn.
  return new BedrockRuntimeClient({ region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1", maxAttempts: 6, retryMode: "adaptive" });
}

/** "us.amazon.nova-2-lite-v1:0" -> "Amazon Nova 2 Lite". */
export function modelLabel(modelId: string): string {
  const nova = modelId.match(/amazon\.nova-(?:(\d+(?:\.\d+)?)-)?(lite|pro|micro|premier|sonic)/);
  if (nova) return `Amazon Nova ${nova[1] ? `${nova[1]} ` : ""}${nova[2][0].toUpperCase()}${nova[2].slice(1)}`;
  return modelId;
}

/** MCP tool definitions -> Converse tool specs. */
export function converseTools(tools: { name: string; title?: string; description?: string; inputSchema: Record<string, unknown> }[]): Tool[] {
  return tools.map((t) => {
    const { $schema: _drop, ...schema } = t.inputSchema;
    return { toolSpec: { name: t.name, description: t.description ?? t.title ?? t.name, inputSchema: { json: schema as never } } };
  });
}

/** Text of a reply, without the <thinking> notes some models write before calling tools. */
export function replyText(content: ContentBlock[] | undefined, forSpeech = true): string {
  const text = (content ?? [])
    .map((b) => ("text" in b && typeof b.text === "string" ? b.text : ""))
    .filter(Boolean)
    .join("\n")
    .replace(/<thinking>[\s\S]*?(<\/thinking>|$)/g, "")
    .trim();
  return forSpeech ? speakable(text) : text;
}

/** Text meant for the ear: no emoji, markdown, or list markers. */
export function speakable(text: string): string {
  return text
    .replace(/\p{Extended_Pictographic}|\uFE0F|\u200D/gu, "")
    .replace(/^\s*([-=_*]\s*){3,}$/gm, "") // markdown dividers
    .replace(/\s+[-=]{3,}\.?(\s+|$)/g, " ")
    .replace(/[*_#`]/g, "")
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-•]|\d+[.)])\s+/, "").trim())
    .filter(Boolean)
    // Each line (a list item, a heading) becomes its own spoken sentence.
    .map((line) => line.replace(/:$/, ".").replace(/([^.!?,;])$/, "$1."))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Web research with Amazon Nova Web Grounding (a Bedrock system tool): the model searches the web
 * itself and returns text plus citations. Needs bedrock:InvokeTool on system-tool/amazon.nova_grounding.
 */
export async function converseResearch(
  client: ConverseClient,
  req: { modelId: string; system?: string; prompt: string; maxTokens?: number },
): Promise<{ text: string; sources: Array<{ url: string; domain: string; title?: string }> }> {
  const out = await client.send(
    new ConverseCommand({
      modelId: req.modelId,
      ...(req.system ? { system: [{ text: req.system }] } : {}),
      messages: [{ role: "user", content: [{ text: req.prompt }] }],
      toolConfig: { tools: [{ systemTool: { name: "nova_grounding" } } as never] },
      inferenceConfig: { maxTokens: req.maxTokens ?? 2500, temperature: 0.3 },
    }),
  );
  const content = out.output?.message?.content ?? [];
  const sources = new Map<string, { url: string; domain: string; title?: string }>();
  // Citations arrive as their own content blocks; collect every web location wherever it appears.
  const walk = (v: unknown) => {
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, any>;
    const web = o.location?.web ?? o.web;
    if (web?.url && !sources.has(web.url)) sources.set(web.url, { url: String(web.url), domain: String(web.domain ?? new URL(web.url).hostname), title: o.title ?? web.title });
    for (const x of Object.values(o)) walk(x);
  };
  walk(content);
  return { text: replyText(content, false), sources: [...sources.values()].slice(0, 8) };
}

/** A single prompt -> text completion (study sets, grading, stories). */
export async function converseText(
  client: ConverseClient,
  req: { modelId: string; system?: string; prompt: string; maxTokens?: number; temperature?: number },
): Promise<string> {
  const out = await client.send(
    new ConverseCommand({
      modelId: req.modelId,
      ...(req.system ? { system: [{ text: req.system }] } : {}),
      messages: [{ role: "user", content: [{ text: req.prompt }] }],
      inferenceConfig: { maxTokens: Math.min(10_000, Math.max(1000, req.maxTokens ?? 2000)), temperature: req.temperature ?? 0.7 },
    }),
  );
  if (out.stopReason === "guardrail_intervened" || out.stopReason === "content_filtered") throw new Error("The model declined this request.");
  return replyText(out.output?.message?.content, false);
}
