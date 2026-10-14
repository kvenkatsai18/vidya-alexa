import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CreateMessageRequestSchema,
  ElicitationCompleteNotificationSchema,
  ElicitRequestSchema,
  type CallToolResult,
  type CreateMessageRequest,
  type CreateMessageResult,
  type ElicitRequest,
  type ElicitResult,
  type Implementation,
  type JSONRPCMessage,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

export const MCP_APP_MIME = "text/html;profile=mcp-app";

export interface TraceFrame {
  dir: "out" | "in";
  at: number;
  message: JSONRPCMessage;
}

/** Wraps the real Streamable HTTP transport so every JSON-RPC frame can be shown in the developer panel. */
class TracingTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: Transport["onmessage"];

  constructor(
    private inner: StreamableHTTPClientTransport,
    private onTrace: (f: TraceFrame) => void,
  ) {
    inner.onmessage = (message: JSONRPCMessage, extra?: Parameters<NonNullable<Transport["onmessage"]>>[1]) => {
      this.onTrace({ dir: "in", at: Date.now(), message });
      this.onmessage?.(message, extra);
    };
    inner.onclose = () => this.onclose?.();
    inner.onerror = (e) => this.onerror?.(e);
  }

  start() {
    return this.inner.start();
  }
  send(message: JSONRPCMessage, options?: TransportSendOptions) {
    this.onTrace({ dir: "out", at: Date.now(), message });
    return this.inner.send(message, options);
  }
  close() {
    return this.inner.close();
  }
  get sessionId() {
    return this.inner.sessionId;
  }
  setProtocolVersion(version: string) {
    this.inner.setProtocolVersion(version);
  }
  get protocolVersion() {
    return this.inner.protocolVersion;
  }
  terminate() {
    return this.inner.terminateSession();
  }
}

export interface McpConnectionOptions {
  onTrace: (f: TraceFrame) => void;
  onElicit: (params: ElicitRequest["params"]) => Promise<ElicitResult>;
  /** When set, the client advertises the sampling capability and answers sampling/createMessage. */
  onSample?: (params: CreateMessageRequest["params"]) => Promise<CreateMessageResult>;
  /** URL-mode elicitation finished out of band (e.g. the parent finished recording their voice). */
  onElicitComplete?: (elicitationId: string) => void;
}

/** The simulator's MCP client: initialize -> tools/list -> tools/call over Streamable HTTP. */
export class McpConnection {
  tools: Tool[] = [];
  private uiByTool = new Map<string, string>();
  private htmlCache = new Map<string, string>();

  private constructor(
    readonly url: string,
    readonly client: Client,
    private transport: TracingTransport,
  ) {}

  static async connect(url: string, opts: McpConnectionOptions): Promise<McpConnection> {
    const inner = new StreamableHTTPClientTransport(new URL(url));
    const transport = new TracingTransport(inner, opts.onTrace);
    const client = new Client(
      { name: "alexa-plus-simulator", title: "Alexa+ experience simulator", version: "0.2.0" },
      {
        capabilities: {
          elicitation: { form: {}, url: {} },
          ...(opts.onSample ? { sampling: {} } : {}),
          // MCP Apps: tell servers we can render text/html;profile=mcp-app views.
          extensions: { "io.modelcontextprotocol/ui": { mimeTypes: [MCP_APP_MIME] } },
        } as Record<string, unknown>,
      },
    );
    client.setRequestHandler(ElicitRequestSchema, (req) => opts.onElicit(req.params));
    if (opts.onSample) client.setRequestHandler(CreateMessageRequestSchema, (req) => opts.onSample!(req.params));
    client.setNotificationHandler(ElicitationCompleteNotificationSchema, (n) => opts.onElicitComplete?.(n.params.elicitationId));
    await client.connect(transport);
    const conn = new McpConnection(url, client, transport);
    await conn.refreshTools();
    return conn;
  }

  async refreshTools() {
    const { tools } = await this.client.listTools();
    this.tools = tools;
    this.uiByTool.clear();
    for (const t of tools) {
      const meta = (t._meta ?? {}) as Record<string, any>;
      const uri = meta.ui?.resourceUri ?? meta["ui/resourceUri"];
      if (typeof uri === "string") this.uiByTool.set(t.name, uri);
    }
  }

  get serverInfo(): Implementation | undefined {
    return this.client.getServerVersion();
  }
  get instructions(): string | undefined {
    return this.client.getInstructions();
  }
  get sessionId() {
    return this.transport.sessionId;
  }
  get protocolVersion() {
    return this.transport.protocolVersion;
  }

  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    // Long timeout: a purchase confirmation (elicitation) can keep a tools/call open while the user decides.
    return this.client.callTool({ name, arguments: args }, undefined, { timeout: 5 * 60_000 }) as Promise<CallToolResult>;
  }

  async uiFor(toolName: string): Promise<{ uri: string; html: string } | null> {
    const uri = this.uiByTool.get(toolName);
    if (!uri) return null;
    let html = this.htmlCache.get(uri);
    if (!html) {
      const res = await this.client.readResource({ uri });
      const c = res.contents.find((x) => x.mimeType === MCP_APP_MIME) ?? res.contents[0];
      if (!c || !("text" in c)) return null;
      html = c.text;
      this.htmlCache.set(uri, html);
    }
    return { uri, html };
  }

  async close() {
    // DELETE /mcp ends the server-side session cleanly.
    await this.transport.terminate().catch(() => {});
    await this.client.close();
  }
}
