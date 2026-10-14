import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { NeedsLlmError } from "./domain/generate.ts";
import { directLlmFromEnv, SamplingLlm, type Llm } from "./domain/llm.ts";
import { BRAND, BuddyError, Mentor, type Result } from "./domain/mentor.ts";
import { VoiceNotConfiguredError, VoiceStudio } from "./domain/voice.ts";

/** Pending voice enrollments -> callback that tells the client (notifications/elicitation/complete) it's done. */
export const enrollmentNotifiers = new Map<string, () => Promise<void>>();

const here = path.dirname(fileURLToPath(import.meta.url));

export const SERVER_VERSION = "0.2.0";
export const CARD_URI = "ui://study-buddy/card.html";
/** MCP Apps (SEP-1865) resource MIME type. */
export const MCP_APP_MIME = "text/html;profile=mcp-app";

const ICON_SVG =
  "data:image/svg+xml;base64," +
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#1e2531"/><rect x="14" y="18" width="36" height="26" rx="3" fill="#f6f1e4"/><path d="M20 26h24M20 32h24M20 38h16" stroke="#9cb8db" stroke-width="2"/><path d="M14 46l12-6 12 6" fill="none" stroke="#f7e35a" stroke-width="4" stroke-linecap="round"/></svg>`,
  ).toString("base64");

const INSTRUCTIONS = `${BRAND} is a personal study mentor. It remembers each learner (class/age, interests, what explanations worked, mistakes, exam dates, review schedule) across sessions and adapts how it teaches.
Start with get_today. If there's no learner yet, onboard with set_up_learner (name, class or year, age if young, interests, upcoming exam).
Typical flow: add_material (uploaded notes) or add_topic -> explain_concept -> start_quiz -> answer_question (repeat) -> get_study_plan. Use teach_back to have the learner explain a concept in their own words. Use remember when the learner shares something about themselves.
Family mode: tell_story writes an age-appropriate bedtime story that teaches a lesson a parent asks for.
Every result has a voice-ready "speech" field pitched at the learner's level, and get_today/get_profile return a "voiceGuide" describing how to talk to them. Say the speech (lightly adapted) rather than reading raw data.`;

const ResultShape = z.object({ kind: z.string(), speech: z.string() }).passthrough();

// The card loads its typefaces from Google Fonts; hosts that enforce MCP Apps CSP need these domains.
const CARD_UI_META = {
  prefersBorder: false,
  csp: { resourceDomains: ["https://fonts.googleapis.com", "https://fonts.gstatic.com"] },
};
const uiMeta = { ui: { resourceUri: CARD_URI }, "ui/resourceUri": CARD_URI };

function ok(r: Result): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r };
}

function fail(e: unknown): CallToolResult {
  const known = e instanceof BuddyError || e instanceof NeedsLlmError || e instanceof VoiceNotConfiguredError;
  const message = known ? (e as Error).message : `Something went wrong on my side: ${(e as Error).message}`;
  if (!known) console.error(e);
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ kind: "error", speech: message }) }],
    structuredContent: { kind: "error", speech: message },
  };
}

let cardHtml: string | undefined;
export function loadCardHtml(): string {
  if (!cardHtml || process.env.NODE_ENV !== "production") cardHtml = readFileSync(path.join(here, "ui/card.html"), "utf8");
  return cardHtml;
}

const direct = directLlmFromEnv();

/** One McpServer per MCP session; all sessions share the same household memory. */
export function createStudyBuddyServer(mentor: Mentor, opts: { llm?: Llm | null; studio?: VoiceStudio; publicUrl?: string } = {}): McpServer {
  const studio = opts.studio ?? new VoiceStudio(mentor);
  const publicUrl = (opts.publicUrl ?? process.env.BUDDY_PUBLIC_URL ?? `http://localhost:${process.env.MCP_PORT ?? 8787}`).replace(/\/$/, "");
  const server = new McpServer(
    { name: "study-buddy", title: BRAND, version: SERVER_VERSION, icons: [{ src: ICON_SVG, mimeType: "image/svg+xml", sizes: ["any"] }] },
    { instructions: INSTRUCTIONS, capabilities: { logging: {} } },
  );

  /** Generation prefers the client's own model via MCP sampling, then the server's own model, then offline content. */
  const llmFor = (extra: any): Llm | null => {
    if (opts.llm !== undefined) return opts.llm;
    if (server.server.getClientCapabilities()?.sampling) return new SamplingLlm(server.server, extra?.requestId);
    return direct;
  };
  const canElicit = () => !!server.server.getClientCapabilities()?.elicitation;

  const tool = <A,>(
    name: string,
    config: { title: string; description: string; inputSchema: Record<string, z.ZodTypeAny>; readOnly?: boolean; destructive?: boolean; ui?: boolean },
    fn: (args: A, extra: any) => Promise<Result> | Result,
  ) => {
    server.registerTool(
      name,
      {
        title: config.title,
        description: config.description,
        inputSchema: config.inputSchema,
        outputSchema: ResultShape,
        annotations: { readOnlyHint: !!config.readOnly, destructiveHint: !!config.destructive, openWorldHint: false },
        ...(config.ui !== false ? { _meta: uiMeta } : {}),
      },
      (async (args: A, extra: any): Promise<CallToolResult> => {
        try {
          return ok(await fn(args, extra));
        } catch (e) {
          return fail(e);
        }
      }) as any,
    );
  };

  // ------------------------------------------------------------------ learners & memory

  tool(
    "get_today",
    {
      title: "Today",
      description:
        "Start here. Who's studying, a personal greeting, streak, exam countdown, what's due for spaced review, the weak spot from last time, and what to do next. Includes a voiceGuide describing how to talk to this learner. If nobody is set up yet, returns a welcome that invites onboarding.",
      inputSchema: {},
      readOnly: true,
    },
    () => mentor.todayBrief(),
  );

  tool(
    "set_up_learner",
    {
      title: "Set up a learner",
      description:
        "Create or update a learner profile: name, class/grade/year (any level, from kindergarten to university or adult), age, subjects, interests, and an upcoming exam. Personalization (vocabulary, depth, examples, session length) is derived from this. Call it as soon as the learner tells you who they are. Set use_form=true to show an on-screen setup form instead (when the client supports elicitation).",
      inputSchema: {
        name: z.string().optional(),
        level: z.string().optional().describe("As they said it: 'Grade 10', 'class 6', '2nd year engineering', 'adult learner'"),
        age: z.number().int().min(3).max(99).optional(),
        subjects: z.array(z.string()).optional(),
        interests: z.array(z.string()).optional().describe("Hobbies and things they love, used for examples: 'cricket', 'cooking', 'Minecraft'"),
        exam_title: z.string().optional().describe("e.g. 'Biology unit test'"),
        exam_subject: z.string().optional(),
        exam_date: z.string().optional().describe("yyyy-mm-dd"),
        exam_in_days: z.number().int().min(0).max(365).optional(),
        use_form: z.boolean().optional(),
      },
    },
    async (a: any) => {
      let input = a;
      if ((a.use_form || !a.name) && canElicit()) {
        const res = await server.server.elicitInput(
          {
            mode: "form",
            message: `Let's set you up so ${BRAND} can teach you your way.`,
            requestedSchema: {
              type: "object",
              properties: {
                name: { type: "string", title: "Your name" },
                level: { type: "string", title: "Class or year", description: "For example: Grade 7, Class 10, 1st year college" },
                age: { type: "integer", title: "Age", minimum: 3, maximum: 99 },
                interests: { type: "string", title: "Things you love", description: "Comma separated: cricket, cooking, Minecraft" },
                exam_title: { type: "string", title: "Next exam (optional)", description: "For example: Biology unit test" },
                exam_date: { type: "string", title: "Exam date (optional)", format: "date" },
              },
              required: ["name"],
            },
          },
          { timeout: 5 * 60_000 },
        );
        if (res.action !== "accept" || !res.content?.name) throw new BuddyError("No problem. Whenever you're ready, just tell me your name and your class.");
        const c = res.content as Record<string, any>;
        input = { ...a, ...c, interests: typeof c.interests === "string" ? c.interests.split(/,|\band\b/).map((x: string) => x.trim()).filter(Boolean) : a.interests };
      }
      if (!input.name) throw new BuddyError("What's your name? And which class or year are you in?");
      return mentor.setUpLearner({
        name: input.name,
        level: input.level,
        age: input.age === undefined || input.age === "" ? undefined : Number(input.age),
        subjects: input.subjects,
        interests: input.interests,
        exam: input.exam_title ? { title: input.exam_title, subject: input.exam_subject, date: input.exam_date || undefined, inDays: input.exam_in_days } : undefined,
      });
    },
  );

  tool(
    "switch_learner",
    { title: "Switch learner", description: "Switch to another learner in the household (siblings share one device). Use when someone says 'it's Leo now' or 'this is Priya'.", inputSchema: { name: z.string() } },
    (a: { name: string }) => mentor.switchLearner(a.name),
  );

  tool(
    "remember",
    {
      title: "Remember",
      description:
        "Save something the learner tells you about themselves so future sessions adapt: preferences ('I learn better with diagrams'), struggles ('I panic in timed tests'), goals, or personal details ('I'm captain of the cricket team').",
      inputSchema: { fact: z.string(), kind: z.enum(["preference", "struggle", "strength", "personal", "goal"]).optional() },
      ui: false,
    },
    (a: { fact: string; kind?: any }) => mentor.remember(a.fact, a.kind),
  );

  tool(
    "get_profile",
    { title: "What I know about you", description: "Everything remembered about the active learner (told and observed), their exams and stats. Use for 'what do you know about me?'.", inputSchema: {}, readOnly: true },
    () => mentor.profile(),
  );

  tool(
    "forget",
    {
      title: "Forget",
      description:
        "Delete a memory (by memory_id or matching text), or with everything=true delete the learner's whole profile and progress. Deleting everything asks the user to confirm.",
      inputSchema: { memory_id: z.string().optional(), text: z.string().optional(), everything: z.boolean().optional() },
      destructive: true,
      ui: false,
    },
    async (a: { memory_id?: string; text?: string; everything?: boolean }) => {
      if (a.everything && canElicit()) {
        const res = await server.server.elicitInput(
          {
            mode: "form",
            message: "Delete this learner's whole profile, notes and progress? This can't be undone.",
            requestedSchema: { type: "object", properties: { confirm: { type: "boolean", title: "Delete everything", default: false } }, required: ["confirm"] },
          },
          { timeout: 5 * 60_000 },
        );
        if (res.action !== "accept" || res.content?.confirm !== true) return { kind: "cancelled", title: "Kept everything", speech: "Okay, I kept everything." };
      }
      return mentor.forget({ memoryId: a.memory_id, text: a.text, everything: a.everything });
    },
  );

  // ------------------------------------------------------------------ material

  tool(
    "add_material",
    {
      title: "Study my notes",
      description:
        "Turn the learner's own material (uploaded notes, a textbook chapter, a PDF's text, a teacher's handout) into a personalized study set: concepts, flashcards and questions at their level. Linked to an upcoming exam in the same subject.",
      inputSchema: { title: z.string(), text: z.string().describe("The full text of the material") },
    },
    (a: { title: string; text: string }, extra) => mentor.addMaterial(llmFor(extra), a.title, a.text),
  );

  tool(
    "add_topic",
    {
      title: "Learn a topic",
      description: "Build a study set for a topic the learner names, without notes (e.g. 'photosynthesis', 'Newton's laws', 'the French Revolution').",
      inputSchema: { topic: z.string() },
    },
    (a: { topic: string }, extra) => mentor.addTopic(llmFor(extra), a.topic),
  );

  tool(
    "explain_concept",
    {
      title: "Explain",
      description:
        "Explain a concept the way this learner learns best: at their level, with analogies from their interests, and clearing up any mistake they made before. style: analogy, example, step_by_step, simpler ('I still don't get it'), story, deeper. If the concept isn't in their notes, it's explained anyway (curiosity mode).",
      inputSchema: { concept: z.string().optional(), style: z.enum(["analogy", "example", "step_by_step", "simpler", "story", "deeper"]).optional() },
    },
    (a: { concept?: string; style?: any }, extra) => mentor.explainConcept(llmFor(extra), a),
  );

  // ------------------------------------------------------------------ practice

  tool(
    "start_quiz",
    {
      title: "Quiz me",
      description:
        "Start a spoken quiz or flashcard round. Picks what this learner needs most: last time's mistakes first, then topics due for spaced review, then new ones. Length is matched to their level.",
      inputSchema: { topic: z.string().optional(), mode: z.enum(["quiz", "flashcards"]).optional(), count: z.number().int().min(1).max(10).optional() },
    },
    (a: { topic?: string; mode?: any; count?: number }) => mentor.startQuiz(a),
  );

  tool(
    "answer_question",
    {
      title: "Answer",
      description:
        "Submit the learner's spoken answer to the current quiz question or flashcard, in their own words. It's graded by meaning, mistakes are remembered, the review schedule updates, and the next question comes back in the same result.",
      inputSchema: { answer: z.string() },
    },
    (a: { answer: string }, extra) => mentor.answer(llmFor(extra), a.answer),
  );

  tool(
    "quiz_action",
    { title: "Quiz controls", description: "During a quiz: hint, skip, repeat, flip (show a flashcard's answer), or end.", inputSchema: { action: z.enum(["hint", "skip", "repeat", "flip", "end"]) } },
    (a: { action: any }) => mentor.quizAction(a.action),
  );

  tool(
    "teach_back",
    {
      title: "Teach it back",
      description:
        "Feynman-style check: action=start asks the learner to explain a concept in their own words; action=submit with their explanation compares it to the key points and shows what they covered and missed.",
      inputSchema: { action: z.enum(["start", "submit"]), concept: z.string().optional(), explanation: z.string().optional() },
    },
    (a: { action: "start" | "submit"; concept?: string; explanation?: string }, extra) => {
      if (a.action === "start") return mentor.startTeachBack(a.concept);
      if (!a.explanation) throw new BuddyError("Go ahead and explain it in your own words. I'm listening.");
      return mentor.submitTeachBack(llmFor(extra), a.explanation);
    },
  );

  tool(
    "get_study_plan",
    {
      title: "Study plan",
      description: "Exam countdown with a mastery map (solid, getting there, shaky, not started) and a day-by-day plan that saves the last day for mixed review.",
      inputSchema: { exam: z.string().optional() },
      readOnly: true,
    },
    (a: { exam?: string }) => mentor.studyPlan(a.exam),
  );

  tool(
    "summarize",
    { title: "One-page summary", description: "A last-minute revision summary of a study set or topic at the learner's level, with a memory trick.", inputSchema: { topic: z.string().optional() }, readOnly: true },
    (a: { topic?: string }, extra) => mentor.summary(llmFor(extra), a.topic),
  );

  tool(
    "focus_session",
    {
      title: "Focus session",
      description: "Phone-down focus timer. action=start (minutes, topic) begins it; action=end when time's up, which logs the minutes and streak and offers a quick quiz.",
      inputSchema: { action: z.enum(["start", "end"]), minutes: z.number().int().min(5).max(60).optional(), topic: z.string().optional() },
    },
    (a: { action: "start" | "end"; minutes?: number; topic?: string }) => mentor.focus(a),
  );

  // ------------------------------------------------------------------ family mode

  tool(
    "tell_story",
    {
      title: "Bedtime story",
      description:
        "Family mode: write a gentle bedtime story for a child that teaches a lesson the parent asks for ('stealing is wrong', 'it's okay to be scared', 'share with your sister'), built around what the child loves. Remembers the child's age and interests for next time.",
      inputSchema: {
        child: z.string().describe("Child's name"),
        lesson: z.string().describe("The value or lesson, in the parent's words"),
        age: z.number().int().min(2).max(12).optional(),
        interests: z.array(z.string()).optional(),
        minutes: z.number().int().min(2).max(8).optional(),
        voice: z.string().optional().describe("Read it in a parent's story voice, only when asked: 'Mom', 'Dad', 'Grandma' or the parent's name"),
      },
    },
    async (a: { child: string; lesson: string; age?: number; interests?: string[]; minutes?: number; voice?: string }, extra) => {
      const wantsVoice = a.voice !== undefined;
      const v = wantsVoice ? studio.find(a.voice || undefined) : undefined;
      const usable = v && v.status === "active";
      const r = await mentor.tellStory(llmFor(extra), { ...a, voiceId: usable ? v!.id : undefined });
      if (usable) {
        // The device plays the parent-voice recording; the assistant only says a short, honest intro.
        return {
          ...r,
          voiceLabel: studio.label(v!),
          audioUrl: `${publicUrl}/voice/audio/story/${r.storyId}`,
          speech: `Here's a story for ${(r.child as any).name}, read in ${v!.relation}'s voice.`,
        };
      }
      if (wantsVoice) {
        const why = v ? `${v.relation}'s voice is paused` : `there's no story voice${a.voice ? ` for ${a.voice}` : ""} yet`;
        return { ...r, speech: `Just so you know, ${why}, so I'll read it myself. ${r.speech}` };
      }
      return r;
    },
  );

  // ------------------------------------------------------------------ parent story voices (consent-first, stories & messages only)

  const canElicitUrl = () => !!(server.server.getClientCapabilities()?.elicitation as any)?.url;

  tool(
    "create_parent_voice",
    {
      title: "Create a parent's story voice",
      description:
        "Let a parent record their own voice so bedtime stories, and goodnight messages they write, can be read in it. Opens a secure recording page (URL elicitation) where the parent reads a consent sentence and a short passage. Only the parent themselves can do this. The voice can never be used for free conversation.",
      inputSchema: {
        parent_name: z.string().describe("The parent's own name"),
        relation: z.string().optional().describe("How the kids call them: Mom, Dad, Grandma..."),
        children: z.array(z.string()).optional().describe("Children this voice reads to"),
      },
    },
    async (a: { parent_name: string; relation?: string; children?: string[] }) => {
      const e = studio.startEnrollment({ parentName: a.parent_name, relation: a.relation, children: a.children });
      const url = `${publicUrl}/voice/enroll?token=${e.token}`;
      const base = {
        kind: "voice_enroll",
        title: `${e.relation}'s story voice`,
        relation: e.relation,
        parentName: e.parentName,
        url,
        live: studio.provider.live,
        steps: ["Read the consent sentence out loud", "Read a short passage for about 30 to 60 seconds", "Create the voice"],
      };
      if (canElicitUrl()) {
        const elicitationId = e.token.slice(0, 16);
        const res = await server.server.elicitInput(
          { mode: "url", elicitationId, url, message: `${e.parentName}, record your story voice on this secure page. You'll read a consent sentence and a short passage.` },
          { timeout: 5 * 60_000 },
        );
        if (res.action !== "accept") return { kind: "cancelled", title: "No voice created", speech: "No problem. You can set up your story voice any time." };
        enrollmentNotifiers.set(e.token, server.server.createElicitationCompletionNotifier(elicitationId));
        return { ...base, status: "recording", speech: `Great. Read the sentence and the short passage on the page, then tap create. I'll let you know when your voice is ready.` };
      }
      return { ...base, status: "link", speech: `Open the recording page on the screen and read the sentence and short passage. It takes about a minute.` };
    },
  );

  tool(
    "parent_voice",
    {
      title: "Manage story voices",
      description: "List the family's parent story voices, or pause, resume or delete one (deleting removes it from the voice provider too, and asks for confirmation).",
      inputSchema: { action: z.enum(["list", "pause", "resume", "delete"]), voice: z.string().optional().describe("Parent name or relation") },
      destructive: true,
    },
    async (a: { action: "list" | "pause" | "resume" | "delete"; voice?: string }) => {
      if (a.action === "list") return studio.list();
      if (a.action === "pause" || a.action === "resume") return studio.setStatus(a.voice, a.action === "pause" ? "paused" : "active");
      if (canElicit()) {
        const v = studio.find(a.voice);
        const res = await server.server.elicitInput(
          { mode: "form", message: `Delete ${v ? `${v.relation}'s` : "this"} story voice? Stories and messages in that voice will be removed.`, requestedSchema: { type: "object", properties: { confirm: { type: "boolean", title: "Delete the voice", default: false } }, required: ["confirm"] } },
          { timeout: 5 * 60_000 },
        );
        if (res.action !== "accept" || res.content?.confirm !== true) return { kind: "cancelled", title: "Kept the voice", speech: "Okay, I kept it." };
      }
      return studio.remove(a.voice);
    },
  );

  tool(
    "voice_message",
    {
      title: "Goodnight messages",
      description:
        "action=leave: a parent writes a short goodnight message for a child; it's stored exactly as written (never rewrite it) and later played in that parent's story voice. action=play: play a child's new messages.",
      inputSchema: {
        action: z.enum(["leave", "play"]),
        to: z.string().describe("Child's name"),
        from: z.string().optional().describe("Which parent voice reads it (Mom, Dad, name)"),
        text: z.string().optional().describe("For leave: the parent's exact words"),
      },
    },
    (a: { action: "leave" | "play"; to: string; from?: string; text?: string }) => {
      if (a.action === "leave") return studio.leaveMessage({ from: a.from, to: a.to, text: a.text ?? "" });
      return studio.playMessages(a.to, publicUrl);
    },
  );

  // ------------------------------------------------------------------ resources & prompts

  server.registerResource(
    "card",
    CARD_URI,
    { title: `${BRAND} card`, description: "MCP App view that renders every result as a smart-display card.", mimeType: MCP_APP_MIME, _meta: { ui: CARD_UI_META } },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: MCP_APP_MIME, text: loadCardHtml(), _meta: { ui: CARD_UI_META } }] }),
  );

  server.registerResource(
    "deck",
    new ResourceTemplate("study-buddy://decks/{deckId}", {
      list: async () => ({
        resources: mentor.store.get().decks.map((d) => ({ uri: `study-buddy://decks/${d.id}`, name: `${d.title} (${d.subject})`, mimeType: "text/markdown" })),
      }),
    }),
    { title: "Study set", description: "A learner's study set: concepts, key points, flashcards and questions.", mimeType: "text/markdown" },
    async (uri, { deckId }) => {
      const s = mentor.store.get();
      const d = s.decks.find((x) => x.id === deckId);
      if (!d) throw new Error(`Unknown deck ${deckId}`);
      const md = [
        `# ${d.title} (${d.subject})`,
        ...s.concepts
          .filter((c) => c.deckId === d.id)
          .flatMap((c) => [`## ${c.title}`, c.summary, ...c.keyPoints.map((k) => `- ${k}`), "", ...c.flashcards.map((f) => `**Q:** ${f.front}  \n**A:** ${f.back}`), ""]),
      ].join("\n");
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: md }] };
    },
  );

  server.registerPrompt(
    "study-session",
    { title: "Study session", description: "Start a personalized study session on a topic.", argsSchema: { topic: z.string() } },
    ({ topic }) => ({ messages: [{ role: "user", content: { type: "text", text: `Help me study ${topic}. Explain it my way, then quiz me.` } }] }),
  );

  server.registerPrompt(
    "bedtime-story",
    { title: "Bedtime story", description: "A bedtime story that teaches a lesson.", argsSchema: { child: z.string(), lesson: z.string() } },
    ({ child, lesson }) => ({ messages: [{ role: "user", content: { type: "text", text: `Tell ${child} a bedtime story about this: ${lesson}` } }] }),
  );

  return server;
}
