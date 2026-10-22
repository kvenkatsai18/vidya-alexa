import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import type { Request, Response } from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest, LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { BuddyError } from "./domain/mentor.ts";
import { VoiceNotConfiguredError } from "./domain/voice.ts";
import { HomeRegistry } from "./homes.ts";
import { createStudyBuddyServer, enrollmentNotifiers, schoolNotifiers, SERVER_VERSION } from "./server.ts";
import { directLlmFromEnv } from "./domain/llm.ts";

const PORT = Number(process.env.MCP_PORT ?? 8787);
const HOST = process.env.MCP_HOST ?? "127.0.0.1";
const ADMIN = process.env.BUDDY_ADMIN !== "off";
// Hosted deployments: require "Authorization: Bearer <token>" on /mcp and /admin. Per-family sign-in
// (MCP authorization / Alexa account linking) replaces this in production.
const ACCESS_TOKEN = process.env.BUDDY_ACCESS_TOKEN ?? "";

// Automated tests only: scripted stand-ins for the model (never used by the product).
if (process.env.BUDDY_LLM === "fixture") {
  const { useOfflineEngine } = await import("./domain/generate.ts");
  const { offlineEngine } = await import("../test/fixtures/offline-engine.ts");
  useOfflineEngine(offlineEngine);
  const { useTestSchoolProvider } = await import("./domain/school.ts");
  const { MockClassroomProvider } = await import("../test/fixtures/mock-school.ts");
  useTestSchoolProvider(new MockClassroomProvider());
}

// Each household gets its own memory; online Study Together games are shared across homes.
const homes = new HomeRegistry();
const main = homes.get();
const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_URL = (process.env.BUDDY_PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/$/, "");

// createMcpExpressApp adds JSON parsing and, for localhost binds, Host-header (DNS rebinding) protection.
const app = createMcpExpressApp({ host: HOST });

// CORS so browser-based clients (MCP Inspector, web simulators) can connect directly.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin ?? "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID, X-Study-Buddy-Home, X-Study-Buddy-Tz");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, Mcp-Protocol-Version");
  if (req.method === "OPTIONS") return void res.sendStatus(204);
  next();
});

const requireToken = (req: Request, res: Response, next: () => void) => {
  if (!ACCESS_TOKEN || req.header("authorization") === `Bearer ${ACCESS_TOKEN}`) return next();
  res.status(401).setHeader("WWW-Authenticate", "Bearer").json({ error: "Missing or wrong access token." });
};
app.use("/mcp", requireToken);
app.use("/admin", requireToken);

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
    // Production: the home comes from the signed-in account. The simulator names it in a header.
    const home = homes.get(req.header("x-study-buddy-home"));
    // The device's time zone (unless BUDDY_TZ pins one), so greetings and "today" match the device's clock.
    const tz = req.header("x-study-buddy-tz");
    if (tz && !process.env.BUDDY_TZ && tz !== home.store.get().household.timeZone) {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
        home.store.update((s) => {
          s.household.timeZone = tz;
        });
      } catch {}
    }
    await createStudyBuddyServer(home.mentor, { studio: home.studio, school: home.school, publicUrl: PUBLIC_URL, games: homes.games, homeId: home.id }).connect(transport);
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
const VOICE_CLONING = process.env.BUDDY_VOICE_CLONING === "on";
app.use("/voice", (_req, res, next) => (VOICE_CLONING ? next() : void res.status(404).end()));

app.get("/voice/enroll", (req, res) => {
  const token = String(req.query.token ?? "");
  const studio = homes.findByToken(token)?.studio;
  const e = studio?.enrollment(token);
  if (!studio || !e) return void res.status(410).type("html").send("<!doctype html><meta charset=utf-8><body style='font-family:system-ui;background:#12163a;color:#f4ecdd;padding:40px'><h1>This link has expired</h1><p>Ask Vidya to set up your story voice again.</p></body>");
  const cfg = { token: e.token, parentName: e.parentName, relation: e.relation, consentPhrase: e.consentPhrase, passage: studio.passage, live: studio.provider.live };
  const html = readFileSync(path.join(here, "ui/voice-enroll.html"), "utf8").replace("__CONFIG__", () => JSON.stringify(cfg).replace(/</g, "\\u003c"));
  res.setHeader("Cache-Control", "no-store");
  res.type("html").send(html);
});

app.post("/voice/enroll", express.raw({ type: ["audio/wav", "audio/x-wav", "application/octet-stream"], limit: "20mb" }), async (req, res) => {
  const token = String(req.query.token ?? "");
  const studio = homes.findByToken(token)?.studio ?? main.studio;
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
    // Ids are random, so look across homes.
    const audio = await firstOk(homes.all().map((h) => () => h.studio.audio(kind, req.params.id)));
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.end(audio);
  } catch (e) {
    if (e instanceof VoiceNotConfiguredError) return void res.status(501).json({ error: e.message });
    res.status(e instanceof BuddyError ? 404 : 502).json({ error: (e as Error).message });
  }
});

// ---------------------------------------------------------------- school connect (opened through URL elicitation)

const SCHOOL_REDIRECT = `${PUBLIC_URL}/school/oauth/callback`;

function page(title: string, body: string) {
  return `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${title}</title><body style="font-family:system-ui;background:#151a23;color:#eef1f5;padding:40px;max-width:620px;margin:auto;line-height:1.5"><h1>${title}</h1>${body}</body>`;
}

async function firstOk<T>(tries: (() => Promise<T>)[]): Promise<T> {
  let err: unknown = new BuddyError("Not found");
  for (const t of tries) {
    try {
      return await t();
    } catch (e) {
      if (e instanceof VoiceNotConfiguredError) throw e;
      err = e;
    }
  }
  throw err;
}

async function finishSchool(token: string, code?: string) {
  const school = (homes.findByToken(token) ?? main).school;
  const result = await school.completeConnect(token, code, SCHOOL_REDIRECT, directLlmFromEnv());
  const notify = schoolNotifiers.get(token);
  schoolNotifiers.delete(token);
  await notify?.().catch(() => {});
  log(`school connected (${school.provider.name})`);
  return result;
}

app.get("/school/connect", (req, res) => {
  const token = String(req.query.token ?? "");
  const home = homes.findByToken(token);
  const school = home?.school;
  const e = school?.enrollment(token);
  if (!home || !school || !e) return void res.status(410).type("html").send(page("This link has expired", "<p>Ask Vidya to connect school again.</p>"));
  const learner = home.store.get().learners.find((l) => l.id === e.learnerId);
  const cfg = { token: e.token, learner: learner?.name ?? "", by: e.connectedBy, live: school.provider.live, authUrl: school.provider.authUrl(e.token, SCHOOL_REDIRECT) };
  const html = readFileSync(path.join(here, "ui/school-connect.html"), "utf8").replace("__CONFIG__", () => JSON.stringify(cfg).replace(/</g, "\\u003c"));
  res.setHeader("Cache-Control", "no-store");
  res.type("html").send(html);
});

// Live: Google redirects back here with an authorization code.
app.get("/school/oauth/callback", async (req, res) => {
  const token = String(req.query.state ?? "");
  if (req.query.error) return void res.status(400).type("html").send(page("Not connected", `<p>Sign-in was cancelled (${String(req.query.error)}). You can close this page.</p>`));
  try {
    const r = await finishSchool(token, String(req.query.code ?? ""));
    res.type("html").send(page(r.kind === "school_needs_parent" ? "A parent needs to connect school" : "School connected", `<p>${(r.speech as string).replace(/[<>&]/g, "")}</p><p>You can close this page.</p>`));
  } catch (e) {
    res.status(400).type("html").send(page("Couldn't connect", `<p>${(e as Error).message.replace(/[<>&]/g, "")}</p>`));
  }
});

// Test mode: connect the sample class.
app.post("/school/connect/mock", async (req, res) => {
  try {
    if (main.school.provider.name !== "fixture") return void res.status(400).json({ error: "Use Google sign-in." });
    const r = await finishSchool(String(req.query.token ?? ""));
    res.json({ ok: true, speech: r.speech });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, name: "study-buddy", version: SERVER_VERSION, protocol: LATEST_PROTOCOL_VERSION, sessions: sessions.size, homes: homes.all().length, games: homes.games.count(), now: main.store.now().toISOString() });
});

if (ADMIN) {
  // Demo-only controls used by the simulator's developer panel. Disable with BUDDY_ADMIN=off.
  app.get("/admin/state", (req, res) => {
    const h = homes.get(String(req.query.home ?? ""));
    res.json({ home: h.id, now: h.store.now().toISOString(), state: h.store.get() });
  });
  app.post("/admin/advance", async (req, res) => {
    const days = Number(req.body?.days ?? 1);
    if (!Number.isFinite(days) || Math.abs(days) > 60) return void res.status(400).json({ error: "days must be between -60 and 60" });
    for (const h of homes.all()) h.store.advanceClock(days);
    log(`clock advanced ${days}d -> ${main.store.now().toISOString()}`);
    // A new day on the demo clock: the overnight routine runs now, like it would at 5am.
    const ran = days > 0 ? await runDailyRoutines() : 0;
    res.json({ now: main.store.now().toISOString(), routines: ran });
  });
  app.post("/admin/reset", (_req, res) => {
    for (const h of homes.all()) h.store.reset();
    homes.games.clear();
    log("state reset to seed");
    res.json({ ok: true, now: main.store.now().toISOString() });
  });
}

// ---------------------------------------------------------------- the daily routine (proactive, no one has to ask)

const routineModel = directLlmFromEnv();
let routineRun: Promise<number> = Promise.resolve(0);

/**
 * For every home: once a day per learner, from 5am home time. Returns how many briefings were prepared.
 * Runs one at a time; a request while one is running waits for it, then runs (for a new day, say).
 */
function runDailyRoutines(): Promise<number> {
  routineRun = routineRun.then(runDailyRoutinesNow, runDailyRoutinesNow);
  return routineRun;
}

async function runDailyRoutinesNow(): Promise<number> {
  if (!routineModel) return 0;
  let n = 0;
  try {
    for (const h of homes.all()) {
      const hour = Number(h.store.now().toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: h.store.get().household.timeZone }));
      if (hour < 5 && hour !== 0) continue;
      const done = await h.mentor.dailyRoutine(routineModel, routineModel);
      n += done.length;
      if (done.length) log(`daily routine (${h.id}): ${done.map((r) => `${(r.learner as { name: string }).name}: ${r.speech}`).join(" | ")}`);
    }
  } catch (e) {
    log(`daily routine failed: ${(e as Error).message}`);
  }
  return n;
}
setInterval(() => void runDailyRoutines(), 30 * 60_000).unref();
setTimeout(() => void runDailyRoutines(), 20_000).unref();

function log(msg: string) {
  console.log(`[study-buddy-mcp] ${msg}`);
}

app.listen(PORT, HOST, () => {
  log(`Streamable HTTP MCP server on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}/mcp (protocol ${LATEST_PROTOCOL_VERSION})`);
  if (ACCESS_TOKEN) log("access token required on /mcp and /admin");
  else if (HOST !== "127.0.0.1" && HOST !== "localhost") log("WARNING: listening publicly without BUDDY_ACCESS_TOKEN");
  log(`state file: ${main.store.file ?? "(in-memory)"} (other homes under homes/)`);
  if (VOICE_CLONING) log(`story voices: ${main.studio.provider.live ? "ElevenLabs voice cloning" : "test mode"}`);
  log(`school sync: ${main.school.provider.live ? `Google Classroom (read-only${process.env.BUDDY_GOOGLE_DRIVE === "on" ? ", with Drive docs" : ""}), redirect ${SCHOOL_REDIRECT}` : main.school.provider.name === "fixture" ? "test classroom (automated tests)" : "not set up (add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env)"}`);
});
