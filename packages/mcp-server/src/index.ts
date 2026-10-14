import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import type { Request, Response } from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest, LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { BuddyError, Mentor } from "./domain/mentor.ts";
import { VoiceNotConfiguredError, VoiceStudio, voiceProviderFromEnv } from "./domain/voice.ts";
import { Store } from "./domain/store.ts";
import { createStudyBuddyServer, enrollmentNotifiers, SERVER_VERSION } from "./server.ts";

const PORT = Number(process.env.MCP_PORT ?? 8787);
const HOST = process.env.MCP_HOST ?? "127.0.0.1";
const ADMIN = process.env.BUDDY_ADMIN !== "off";

const store = new Store();
const mentor = new Mentor(store);
const studio = new VoiceStudio(mentor, voiceProviderFromEnv(), store.file ? path.join(path.dirname(store.file), "audio") : null);
const here = path.dirname(fileURLToPath(import.meta.url));

// createMcpExpressApp adds JSON parsing and, for localhost binds, Host-header (DNS rebinding) protection.
const app = createMcpExpressApp({ host: HOST });

// CORS so browser-based clients (MCP Inspector, web simulators) can connect directly.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin ?? "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, Mcp-Protocol-Version");
  if (req.method === "OPTIONS") return void res.sendStatus(204);
  next();
});

// ---------------------------------------------------------------- Streamable HTTP (stateful sessions)

const sessions = new Map<string, StreamableHTTPServerTransport>();

app.post("/mcp", async (req: Request, res: Response) => {
  const sid = req.header("mcp-session-id");
  let transport = sid ? sessions.get(sid) : undefined;

  if (!transport) {
    if (sid || !isInitializeRequest(req.body)) {
      res.status(sid ? 404 : 400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: sid ? "Session not found. Re-initialize." : "Bad Request: send an initialize request first." },
        id: null,
      });
      return;
    }
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, transport!);
        log(`session ${id.slice(0, 8)} opened (${sessions.size} active)`);
      },
    });
    transport.onclose = () => {
      if (transport!.sessionId) sessions.delete(transport!.sessionId);
    };
    await createStudyBuddyServer(mentor, { studio }).connect(transport);
  }
  await transport.handleRequest(req, res, req.body);
});

// GET opens the server->client SSE stream; DELETE ends the session.
const bySession = async (req: Request, res: Response) => {
  const sid = req.header("mcp-session-id");
  const transport = sid ? sessions.get(sid) : undefined;
  if (!transport) return void res.status(sid ? 404 : 400).send("Unknown or missing Mcp-Session-Id");
  await transport.handleRequest(req, res);
};
app.get("/mcp", bySession);
app.delete("/mcp", bySession);

// ---------------------------------------------------------------- health + demo admin

// ---------------------------------------------------------------- parent story voices

// Secure recording page opened through URL elicitation (the parent's phone in real life).
app.get("/voice/enroll", (req, res) => {
  const e = studio.enrollment(String(req.query.token ?? ""));
  if (!e) return void res.status(410).type("html").send("<!doctype html><meta charset=utf-8><body style='font-family:system-ui;background:#12163a;color:#f4ecdd;padding:40px'><h1>This link has expired</h1><p>Ask Study Buddy to set up your story voice again.</p></body>");
  const cfg = { token: e.token, parentName: e.parentName, relation: e.relation, consentPhrase: e.consentPhrase, passage: studio.passage, live: studio.provider.live };
  const html = readFileSync(path.join(here, "ui/voice-enroll.html"), "utf8").replace("__CONFIG__", () => JSON.stringify(cfg).replace(/</g, "\\u003c"));
  res.setHeader("Cache-Control", "no-store");
  res.type("html").send(html);
});

app.post("/voice/enroll", express.raw({ type: ["audio/wav", "audio/x-wav", "application/octet-stream"], limit: "20mb" }), async (req, res) => {
  const token = String(req.query.token ?? "");
  try {
    const transcript = decodeURIComponent(String(req.header("x-transcript") ?? ""));
    const voice = await studio.completeEnrollment(token, req.body as Buffer, transcript, req.header("x-attested") === "1");
    log(`story voice created for ${voice.relation} (${voice.provider}, consent ${voice.consent.method})`);
    const notify = enrollmentNotifiers.get(token);
    enrollmentNotifiers.delete(token);
    await notify?.().catch(() => {});
    res.json({ ok: true, relation: voice.relation, live: studio.provider.live });
  } catch (e) {
    res.status(e instanceof BuddyError ? 400 : 502).json({ error: (e as Error).message });
  }
});

// Audio only exists for a story or a parent-written message. There is deliberately no "speak this text" endpoint.
app.get("/voice/audio/:kind/:id", async (req, res) => {
  const kind = req.params.kind;
  if (kind !== "story" && kind !== "message") return void res.status(404).end();
  try {
    const audio = await studio.audio(kind, req.params.id);
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.end(audio);
  } catch (e) {
    if (e instanceof VoiceNotConfiguredError) return void res.status(501).json({ error: e.message });
    res.status(e instanceof BuddyError ? 404 : 502).json({ error: (e as Error).message });
  }
});

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, name: "study-buddy", version: SERVER_VERSION, protocol: LATEST_PROTOCOL_VERSION, sessions: sessions.size, now: store.now().toISOString() });
});

if (ADMIN) {
  // Demo-only controls used by the simulator's developer panel. Disable with BUDDY_ADMIN=off.
  app.get("/admin/state", (_req, res) => res.json({ now: store.now().toISOString(), state: store.get() }));
  app.post("/admin/advance", (req, res) => {
    const days = Number(req.body?.days ?? 1);
    if (!Number.isFinite(days) || Math.abs(days) > 60) return void res.status(400).json({ error: "days must be between -60 and 60" });
    store.advanceClock(days);
    log(`clock advanced ${days}d -> ${store.now().toISOString()}`);
    res.json({ now: store.now().toISOString() });
  });
  app.post("/admin/reset", (_req, res) => {
    store.reset();
    log("state reset to seed");
    res.json({ ok: true, now: store.now().toISOString() });
  });
}

function log(msg: string) {
  console.log(`[study-buddy-mcp] ${msg}`);
}

app.listen(PORT, HOST, () => {
  log(`Streamable HTTP MCP server on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}/mcp (protocol ${LATEST_PROTOCOL_VERSION})`);
  log(`state file: ${store.file ?? "(in-memory)"}`);
  log(`story voices: ${studio.provider.live ? "ElevenLabs voice cloning" : "test mode (set ELEVENLABS_API_KEY to create real voices)"}`);
});
