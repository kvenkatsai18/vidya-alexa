import type { CallToolResult, CreateMessageRequest, CreateMessageResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpConnection } from "./mcp-client.ts";

export interface AgentContext {
  mcp: McpConnection;
  /** Calls an MCP tool and shows its card on the device. */
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
}

export interface VoiceAgent {
  readonly label: string;
  /** Handle one user utterance; returns what the device should say. */
  turn(ctx: AgentContext, text: string): Promise<string>;
  reset(): void;
  /** Context the agent should know before the next turn (e.g. "the learner just shared notes"). */
  note?(text: string): void;
  /** If present, the client answers MCP sampling requests (sampling/createMessage) with this model. */
  sample?(params: CreateMessageRequest["params"]): Promise<CreateMessageResult>;
}

export function structured(r: CallToolResult): Record<string, any> {
  if (r.structuredContent) return r.structuredContent as Record<string, any>;
  const text = r.content?.find((c) => c.type === "text") as { text: string } | undefined;
  try {
    return JSON.parse(text?.text ?? "{}");
  } catch {
    return { kind: "text", speech: text?.text ?? "" };
  }
}
