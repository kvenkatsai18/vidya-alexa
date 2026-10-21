import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Request, type Response } from "express";
import { modelLabel } from "../../../packages/mcp-server/src/domain/bedrock.ts";
import { llmModeFromEnv, modelsFromEnv } from "../../../packages/mcp-server/src/domain/llm.ts";
import { BedrockAgent } from "./agent-bedrock.ts";
import { ClaudeAgent } from "./agent-claude.ts";
import { OfflineAgent, SAMPLE_NOTES_PATH } from "./agent-offline.ts";
import type { VoiceAgent } from "./agent.ts";
import { Session } from "./session.ts";
import { loadSkills } from "./skill.ts";
import { POLLY_VOICES, synthesize, TTS_ENABLED } from "./tts.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.SIM_PORT ?? 5173);
const HOST = process.env.SIM_HOST ?? "127.0.0.1";
const AUTH: Record<string, string> = process.env.BUDDY_ACCESS_TOKEN ? { authorization: `Bearer ${process.env.BUDDY_ACCESS_TOKEN}` } : {};
const MCP_URL = process.env.MCP_URL ?? "http://127.0.0.1:8787/mcp";
const MCP_ORIGIN = new URL(MCP_URL).origin;
const EFFORT = (process.env.BUDDY_EFFORT ?? "low") as "low" | "medium" | "high";

const skills = loadSkills();

// Amazon Nova on Amazon Bedrock whenever AWS credentials exist; Claude via the Anthropic API as the alternative.
const MODE = llmModeFromEnv();
const { model: MODEL, genModel: GEN_MODEL } = modelsFromEnv(MODE);

function makeAgent(): VoiceAgent {
  if (MODE === "offline") return new OfflineAgent();
  if (MODE === "bedrock") return new BedrockAgent({ model: MODEL, genModel: GEN_MODEL, skills });
  return new ClaudeAgent({ model: MODEL, effort: EFFORT, skills });
}

const sessions = new Map<string, Session>();
setInterval(() => {
  // Drop sessions idle for over an hour.
  for (const [id, s] of sessions) {
    if (Date.now() - s.lastActive > 3_600_000) {
      sessions.delete(id);
      void s.close();
    }
  }
}, 60_000).unref();

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(express.static(path.join(here, "../public"), { etag: false, maxAge: 0 }));

const getSession = (req: Request, res: Response): Session | undefined => {
  const s = sessions.get(String(req.params.id));
  if (!s) res.status(404).json({ error: "Session expired. Reload the page." });
  return s;
};

app.get("/api/config", (_req, res) => {
  res.json({
    mode: MODE,
    model: MODE === "offline" ? null : MODEL,
    effort: MODE === "anthropic" ? EFFORT : null,
    mcpUrl: MCP_URL,
    skills: skills.map((s) => ({ name: s.name, description: s.description })),
    tts: TTS_ENABLED ? { engine: "polly", voices: POLLY_VOICES, default: process.env.BUDDY_VOICE ?? "Joanna" } : { engine: "browser" },
  });
});

app.post("/api/sessions", async (req, res) => {
  if (MODE === "offline") {
    // No pre-made demo: Study Buddy only runs with a real model.
    return void res.status(503).json({
      needsAi: true,
      error: "Study Buddy needs an AI connection. Add AWS credentials with Amazon Bedrock access (aws configure, region us-east-1), then restart with npm run dev.",
    });
  }
  try {
    // ?home=rao in the device URL makes this a different household (to try Study Together across homes).
    const home = String(req.body?.home ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 40) || "home";
    // The device's own time zone, so "Good morning" matches the clock on the wall.
    const tz = /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(String(req.body?.tz ?? "")) ? String(req.body.tz) : undefined;
    const s = await Session.create(makeAgent(), MCP_URL, home, tz);
    sessions.set(s.id, s);
    res.json({
      id: s.id,
      home: s.home,
      agent: s.agentLabel,
      server: s.mcp.serverInfo,
      protocolVersion: s.mcp.protocolVersion,
      mcpSessionId: s.mcp.sessionId,
      tools: s.mcp.tools.map((t) => ({ name: t.name, title: t.title, hasUi: !!(t._meta as any)?.ui?.resourceUri })),
    });
  } catch (e) {
    res.status(502).json({ error: `Couldn't reach the Study Buddy MCP server at ${MCP_URL}. Is it running? (${(e as Error).message})` });
  }
});

app.get("/api/sessions/:id/events", (req, res) => {
  const s = getSession(req, res);
  if (!s) return;
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.write(": connected\n\n");
  const off = s.subscribe((e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
  const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
  req.on("close", () => {
    clearInterval(ping);
    off();
  });
});

app.post("/api/sessions/:id/turn", (req, res) => {
  const s = getSession(req, res);
  if (!s) return;
  const text = String(req.body?.text ?? "").slice(0, 500);
  const source = ["voice", "tap", "text"].includes(req.body?.source) ? req.body.source : "text";
  // They cut the device off mid-reply: what it had said, and what it hadn't yet.
  const i = req.body?.interrupted;
  const interrupted = i && typeof i.said === "string" ? { said: String(i.said).slice(0, 1500), unsaid: String(i.unsaid ?? "").slice(0, 1500), answering: i.answering === true } : undefined;
  void s.turn(text, source, interrupted);
  res.status(202).json({ ok: true });
});

app.post("/api/sessions/:id/elicit", (req, res) => {
  const s = getSession(req, res);
  if (!s) return;
  const ok = s.answerElicit(String(req.body?.id), req.body?.action, req.body?.content);
  res.status(ok ? 200 : 409).json({ ok });
});

// Natural speech (Amazon Polly) for the device's voice.
app.post("/api/tts", async (req, res) => {
  if (!TTS_ENABLED) return void res.status(404).json({ error: "Server voice is off. Set BUDDY_TTS=polly with AWS credentials." });
  const text = String(req.body?.text ?? "").trim();
  if (!text) return void res.status(400).end();
  try {
    const audio = await synthesize(text, String(req.body?.voice ?? ""), req.body?.style === "story" ? "story" : "talk");
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    res.end(audio);
  } catch (e) {
    console.error("[tts]", (e as Error).message);
    res.status(502).json({ error: (e as Error).message });
  }
});

// Notes shared "from the phone": plain text, Markdown, or PDF (text extracted here), or the bundled sample notes.
app.post("/api/sessions/:id/notes", async (req, res) => {
  const s = getSession(req, res);
  if (!s) return;
  try {
    let title = String(req.body?.title ?? "My notes").replace(/\.(pdf|md|txt)$/i, "").slice(0, 120);
    let text: string;
    if (req.body?.sample) {
      title = "Cell division notes";
      text = readFileSync(SAMPLE_NOTES_PATH, "utf8");
    } else if (req.body?.pdfBase64) {
      const { extractText, getDocumentProxy } = await import("unpdf");
      const pdf = await getDocumentProxy(new Uint8Array(Buffer.from(String(req.body.pdfBase64), "base64")));
      text = (await extractText(pdf, { mergePages: true })).text;
    } else {
      text = String(req.body?.text ?? "");
    }
    if (text.trim().length < 80) return void res.status(400).json({ error: "That file doesn't have enough text to study from." });
    void s.shareNotes(title, text);
    res.status(202).json({ ok: true, chars: text.length });
  } catch (e) {
    res.status(400).json({ error: `Couldn't read that file: ${(e as Error).message}` });
  }
});

app.post("/api/sessions/:id/tool", async (req, res) => {
  const s = getSession(req, res);
  if (!s) return;
  try {
    res.json(await s.callToolFromView(String(req.body?.name), req.body?.arguments ?? {}));
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

app.post("/api/sessions/:id/reset", (req, res) => {
  const s = getSession(req, res);
  if (!s) return;
  s.resetConversation();
  res.json({ ok: true });
});

// Demo controls proxied to the MCP server's admin endpoints.
app.post("/api/admin/:action", async (req, res) => {
  const action = req.params.action;
  if (action !== "advance" && action !== "reset") return void res.status(404).end();
  try {
    const r = await fetch(`${MCP_ORIGIN}/admin/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH },
      body: JSON.stringify(req.body ?? {}),
    });
    if (action === "reset") for (const s of sessions.values()) s.resetConversation();
    res.status(r.status).json(await r.json());
  } catch (e) {
    res.status(502).json({ error: (e as Error).message });
  }
});

app.get("/api/admin/now", async (_req, res) => {
  try {
    res.json(await (await fetch(`${MCP_ORIGIN}/healthz`)).json());
  } catch (e) {
    res.status(502).json({ error: (e as Error).message });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`[simulator] http://localhost:${PORT}`);
  console.log(`[simulator] agent: ${MODE === "offline" ? "NO AI CONNECTED: the device will ask for one (add AWS credentials for Amazon Nova on Bedrock, or ANTHROPIC_API_KEY)" : MODE === "bedrock" ? `${modelLabel(MODEL)} on Amazon Bedrock (${MODEL}); sampling on ${GEN_MODEL}` : `Claude ${MODEL} via Anthropic API, effort ${EFFORT}`}`);
  console.log(`[simulator] skills: ${skills.map((s) => s.name).join(", ")}`);
  console.log(`[simulator] voice: ${TTS_ENABLED ? "Amazon Polly (generative)" : "browser speech synthesis (set BUDDY_TTS=polly for a natural voice)"}`);
  console.log(`[simulator] MCP server: ${MCP_URL}`);
});
