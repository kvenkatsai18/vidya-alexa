import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SubscribeRequestSchema, UnsubscribeRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { GameHub, spokenCode } from "./domain/games.ts";
import { z } from "zod";
import { NeedsLlmError } from "./domain/generate.ts";
import { directLlmFromEnv, SamplingLlm, type Llm } from "./domain/llm.ts";
import { BRAND, BuddyError, Mentor, type Result } from "./domain/mentor.ts";
import { SchoolSync } from "./domain/school.ts";
import { VoiceNotConfiguredError, VoiceStudio } from "./domain/voice.ts";

/** Pending voice enrollments -> callback that tells the client (notifications/elicitation/complete) it's done. */
export const enrollmentNotifiers = new Map<string, () => Promise<void>>();
/** Pending school connections -> completion notifier (same mechanism). */
export const schoolNotifiers = new Map<string, () => Promise<void>>();

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

/** Tools whose arguments carry the learner's own words. */
const SAFETY_CHECKED: Record<string, (a: Record<string, any>) => string | undefined> = {
  answer_question: (a) => a.answer,
  group_answer: (a) => a.answer,
  online_game_answer: (a) => a.answer,
  learn_from_feedback: (a) => a.lesson,
  recheck_answer: (a) => a.reason,
  teach_back: (a) => a.explanation,
  remember: (a) => a.fact,
  add_topic: (a) => a.topic,
  research_topic: (a) => a.topic,
  explain_concept: (a) => a.concept,
};

/** One McpServer per MCP session; all sessions share the same household memory. */
export function createStudyBuddyServer(
  mentor: Mentor,
  opts: { llm?: Llm | null; researcher?: Llm | null; studio?: VoiceStudio; school?: SchoolSync; publicUrl?: string; voiceCloning?: boolean; games?: GameHub; homeId?: string } = {},
): McpServer {
  const games = opts.games ?? new GameHub();
  const homeId = opts.homeId ?? "home";
  // Parent story voices exist in the codebase but are off unless explicitly enabled.
  const voiceCloning = opts.voiceCloning ?? process.env.BUDDY_VOICE_CLONING === "on";
  const studio = opts.studio ?? new VoiceStudio(mentor);
  const school = opts.school ?? new SchoolSync(mentor);
  mentor.school ??= school;
  const publicUrl = (opts.publicUrl ?? process.env.BUDDY_PUBLIC_URL ?? `http://localhost:${process.env.MCP_PORT ?? 8787}`).replace(/\/$/, "");
  const server = new McpServer(
    { name: "study-buddy", title: BRAND, version: SERVER_VERSION, icons: [{ src: ICON_SVG, mimeType: "image/svg+xml", sizes: ["any"] }] },
    { instructions: INSTRUCTIONS, capabilities: { logging: {} } },
  );

  // Live game updates: clients subscribe to study-buddy://games/{code} and get notifications/resources/updated.
  server.server.registerCapabilities({ resources: { subscribe: true, listChanged: true } });
  const subscriptions = new Set<string>();
  server.server.setRequestHandler(SubscribeRequestSchema, async (req) => {
    subscriptions.add(req.params.uri);
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, async (req) => {
    subscriptions.delete(req.params.uri);
    return {};
  });
  const offGames = games.subscribe((code) => {
    const uri = `study-buddy://games/${code}`;
    if (subscriptions.has(uri)) void server.server.sendResourceUpdated({ uri }).catch(() => {});
  });
  const prevClose = server.server.onclose;
  server.server.onclose = () => {
    offGames();
    prevClose?.();
  };

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
          // A child's own words are checked before any tool acts on them: something serious gets a caring
          // reply and goes to a parent, instead of being graded or turned into a quiz.
          const words = SAFETY_CHECKED[name]?.(args as any);
          const concern = words ? mentor.safetyCheck(words) : undefined;
          if (concern) return ok(concern);
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
        "Start here. Who's studying, a personal greeting, streak, exam countdown, what's due for spaced review, the weak spot from last time, and what to do next. Includes a voiceGuide describing how to talk to this learner. If nobody is set up yet, returns a welcome that invites onboarding. Pass `name` when the speaker said who they are ('Hi, I'm Leo'): a known learner becomes the current speaker.",
      inputSchema: { name: z.string().optional().describe("The speaker's first name, if they said it") },
    },
    (a: { name?: string }) => (a.name && mentor.findLearner(a.name) ? mentor.switchLearner(a.name) : mentor.todayBrief()),
  );

  tool(
    "set_up_learner",
    {
      title: "Set up a learner",
      description:
        "Create or update a learner profile: name, class/grade/year (any level, from kindergarten to university or adult), age, subjects, interests, and an upcoming exam. Personalization (vocabulary, depth, examples, session length) is derived from this. Call it as soon as the learner tells you who they are, and again whenever they mention a test or exam ('my thermo exam is next Tuesday'): exam_title plus exam_when, in their words. Set use_form=true to show an on-screen setup form instead (when the client supports elicitation).",
      inputSchema: {
        name: z.string().optional(),
        level: z.string().optional().describe("As they said it: 'Grade 10', 'class 6', '2nd year engineering', 'adult learner'"),
        age: z.number().int().min(3).max(99).optional().describe("Only if they said their age. Never guess it from the class."),
        subjects: z.array(z.string()).optional(),
        interests: z.array(z.string()).optional().describe("Hobbies and things they love, used for examples: 'cricket', 'cooking', 'Minecraft'"),
        exam_title: z.string().optional().describe("e.g. 'Biology unit test'"),
        exam_subject: z.string().optional(),
        exam_when: z.string().optional().describe("When the exam is, in the learner's own words: 'Friday', 'tomorrow', 'in 5 days', 'Oct 30'. Prefer this; the server works out the date."),
        exam_date: z.string().optional().describe("yyyy-mm-dd, only if they gave an exact date. Don't work dates out yourself; use exam_when."),
        exam_in_days: z.number().int().min(0).max(365).optional().describe("Only if they said a number of days; otherwise exam_when."),
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
        exam: input.exam_title ? { title: input.exam_title, subject: input.exam_subject, date: input.exam_date || undefined, inDays: input.exam_in_days, when: input.exam_when } : undefined,
      });
    },
  );

  tool(
    "switch_learner",
    { title: "Switch learner", description: "Switch to another learner in the household (siblings share one device). Use when someone says 'it's Leo now' or 'this is Priya'.", inputSchema: { name: z.string() } },
    (a: { name: string }) => mentor.switchLearner(a.name),
  );

  tool(
    "learn_from_feedback",
    {
      title: "Learn from a correction",
      description:
        "Call this only when the learner explicitly asks you to change something, so you never repeat the mistake: what to call them ('call me Priya A' -> preferred_name), how you explain ('that's too long', 'stop using cricket examples', 'talk to me like an adult'), or something you got wrong. Never infer a lesson from 'stop', an interruption, silence, or a short answer, and never put words in their mouth. Pass their exact words in learner_said. Don't use it for facts about them (use remember).",
      inputSchema: {
        lesson: z.string().describe("An instruction to yourself, e.g. 'Keep explanations under 3 sentences'. Empty if only preferred_name."),
        kind: z.enum(["name", "style", "teaching", "grading", "other"]).optional(),
        preferred_name: z.string().optional().describe("Only when they asked to be called something else."),
        learner_said: z.string().optional().describe("The learner's exact words that asked for the change."),
      },
    },
    (a: { lesson: string; kind?: "name" | "style" | "teaching" | "grading" | "other"; preferred_name?: string; learner_said?: string }) =>
      mentor.learnFromFeedback({ lesson: a.lesson, kind: a.kind, preferredName: a.preferred_name, learnerSaid: a.learner_said }),
  );

  tool(
    "recheck_answer",
    {
      title: "Re-check my last answer",
      description:
        "The learner says their last quiz answer was marked wrong unfairly ('that was right!', 'check again'). Re-grades it honestly. If they were right, fixes their score, removes the recorded mistake, and saves a grading lesson so it doesn't happen again.",
      inputSchema: { reason: z.string().optional().describe("Why they think it was right, in their words.") },
    },
    async (a: { reason?: string }, extra) => mentor.recheck(llmFor(extra), a.reason ?? ""),
  );

  tool(
    "remember",
    {
      title: "Remember",
      description:
        "Save something the learner tells you about themselves so future sessions adapt: preferences ('I learn better with diagrams'), struggles ('I panic in timed tests'), goals, personal details ('I'm captain of the cricket team'), or today's mood ('I'm so tired'), which makes today's session shorter and gentler. Call it whenever they reveal something like this, without being asked.",
      inputSchema: { fact: z.string(), kind: z.enum(["preference", "struggle", "strength", "personal", "goal", "mood"]).optional().describe("mood = how they feel today (tired, stressed, excited); adapts today's session") },
      ui: false,
    },
    (a: { fact: string; kind?: any }) => mentor.remember(a.fact, a.kind),
  );

  // ------------------------------------------------------------------ parent mode

  tool(
    "parent_setup",
    {
      title: "Parent: set up my child",
      description:
        "A parent (or carer) tells Study Buddy about their child: name, age, class, interests, subjects, an upcoming exam, and notes ('gets shy with new things', 'struggles with fractions'). The child isn't asked these again; the first time they talk, they're greeted warmly with what the parent shared and asked something fun to start a real conversation.",
      inputSchema: {
        parent_name: z.string(),
        relation: z.string().describe("Mom, Dad, Grandma, guardian..."),
        child: z.string().describe("Child's name"),
        age: z.number().int().min(3).max(25).optional().describe("Only if the parent said it. Never guess it."),
        level: z.string().optional(),
        interests: z.array(z.string()).optional(),
        subjects: z.array(z.string()).optional(),
        notes: z.array(z.string()).optional().describe("Things the parent wants Study Buddy to keep in mind"),
        exam_title: z.string().optional(),
        exam_subject: z.string().optional(),
        exam_when: z.string().optional().describe("In the parent's words: 'Friday', 'in 5 days', 'Oct 30'"),
        exam_date: z.string().optional(),
        exam_in_days: z.number().int().min(0).max(365).optional(),
      },
    },
    (a: any) =>
      mentor.parentSetup({
        parentName: a.parent_name,
        relation: a.relation,
        name: a.child,
        age: a.age,
        level: a.level,
        interests: a.interests,
        subjects: a.subjects,
        notes: a.notes,
        exam: a.exam_title ? { title: a.exam_title, subject: a.exam_subject, date: a.exam_date, inDays: a.exam_in_days, when: a.exam_when } : undefined,
      }),
  );

  tool(
    "parent_note",
    {
      title: "Parent: add a note",
      description: "A parent adds something to remember about their child ('he gets nervous before tests', 'she's been loving space lately').",
      inputSchema: { child: z.string(), note: z.string(), parent_name: z.string().optional() },
    },
    (a: { child: string; note: string; parent_name?: string }) => mentor.parentNote({ child: a.child, note: a.note, parentName: a.parent_name }),
  );

  tool(
    "parent_overview",
    {
      title: "Parent: how is my child doing",
      description:
        "What a parent sees about their child: any safety concerns first, then progress (minutes, streak, topics solid vs tricky, accuracy, exam), then recent conversations (full visibility, default under 13) or a summary of topics and mood (default for teens).",
      inputSchema: { child: z.string() },
      readOnly: true,
    },
    (a: { child: string }) => mentor.parentOverview(a.child),
  );

  // ------------------------------------------------------------------ transparency & child safety

  tool(
    "record_turn",
    {
      title: "Log a conversation turn",
      description:
        "Hosts call this after every exchange (what was heard, what was said) so parents can review their child's conversations. Also checks the child's words for safety concerns and flags them for a parent.",
      inputSchema: {
        heard: z.string(),
        said: z.string(),
        phase: z.enum(["heard", "said"]).optional().describe('"heard": before replying (learn from a correction right away, nothing is logged); "said": after replying (log it). Omit to do both after replying.'),
      },
      ui: false,
    },
    (a: { heard: string; said: string; phase?: "heard" | "said" }) => mentor.recordTurn(a.heard, a.said, a.phase),
  );

  tool(
    "flag_concern",
    {
      title: "Flag a safety concern",
      description:
        "Call this when a child says something that suggests self-harm, abuse, bullying, danger, or deep sadness, even subtly. It records it for the parent (always, for minors) and returns a caring, honest reply that tells the child a grown-up will know. Never promise a child to keep a secret.",
      inputSchema: {
        category: z.enum(["self_harm", "abuse", "bullying", "danger", "distress"]),
        severity: z.enum(["urgent", "high", "watch"]).optional(),
        summary: z.string().describe("One neutral sentence for the parent"),
        excerpt: z.string().optional().describe("The child's words"),
      },
    },
    (a: { category: any; severity?: any; summary: string; excerpt?: string }) => mentor.flagConcern(a),
  );

  tool(
    "parent_history",
    {
      title: "Parent: conversation history",
      description: "A parent reviews their child's conversations with Study Buddy. Available when the child's visibility is full (the default under 13; teens default to summary).",
      inputSchema: { child: z.string(), days: z.number().int().min(1).max(90).optional() },
      readOnly: true,
    },
    (a: { child: string; days?: number }) => mentor.parentHistory(a.child, a.days),
  );

  tool(
    "parent_settings",
    {
      title: "Parent: privacy settings",
      description: "A parent changes settings for a child: visibility full (every conversation) or summary (topics and mood); whether they may play online Study Together with other homes; or deletes the child's conversation history. The child is told about changes.",
      inputSchema: {
        child: z.string(),
        visibility: z.enum(["full", "summary"]).optional(),
        clear_history: z.boolean().optional(),
        online_games: z.enum(["allowed", "off"]).optional().describe("Study Together with friends in other homes (invite codes only). Off by default under 13."),
      },
    },
    (a: { child: string; visibility?: "full" | "summary"; clear_history?: boolean; online_games?: "allowed" | "off" }) =>
      mentor.parentSettings({ child: a.child, visibility: a.visibility, clearHistory: a.clear_history, onlineGames: a.online_games }),
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
        "Delete one memory or one learned lesson (by memory_id or matching text: 'forget the podcast thing'). everything=true deletes the learner's WHOLE profile: only when they clearly ask to delete everything about them or their account. To delete a study plan, notes or study sets, use delete_study_set instead. Deleting everything asks the user to confirm.",
      inputSchema: { memory_id: z.string().optional(), text: z.string().optional(), everything: z.boolean().optional() },
      destructive: true,
    },
    async (a: { memory_id?: string; text?: string; everything?: boolean }) => {
      if (a.everything && canElicit()) {
        const l = mentor.learner();
        const sets = mentor.studySetsFor({ all: true });
        const res = await server.server.elicitInput(
          {
            mode: "form",
            message: `Delete ${l.name}'s whole profile? That's everything: name and level, ${sets.length ? `${mentor.describeStudySets(sets)}, ` : ""}memories and lessons. This can't be undone.`,
            requestedSchema: { type: "object", properties: { confirm: { type: "boolean", title: "Delete everything", default: false } }, required: ["confirm"] },
          },
          { timeout: 5 * 60_000 },
        );
        if (res.action !== "accept" || res.content?.confirm !== true) return { kind: "cancelled", title: "Kept everything", speech: "Okay, I kept everything." };
      }
      return mentor.forget({ memoryId: a.memory_id, text: a.text, everything: a.everything });
    },
  );

  tool(
    "delete_study_set",
    {
      title: "Delete study sets",
      description:
        "Delete study sets made from notes or topics, and the study plan built from them: one by topic ('delete the startups set'), or all=true ('delete my study plan', 'remove all my notes'). The learner's profile, memories and lessons stay. Asks the user to confirm first.",
      inputSchema: { topic: z.string().optional().describe("Which study set, in their words"), all: z.boolean().optional() },
      destructive: true,
    },
    async (a: { topic?: string; all?: boolean }) => {
      const sets = mentor.studySetsFor(a);
      if (sets.length && canElicit()) {
        const res = await server.server.elicitInput(
          {
            mode: "form",
            message: `Delete ${mentor.describeStudySets(sets)}? Your profile and what I've learned about you stay.`,
            requestedSchema: { type: "object", properties: { confirm: { type: "boolean", title: "Delete", default: false } }, required: ["confirm"] },
          },
          { timeout: 5 * 60_000 },
        );
        if (res.action !== "accept" || res.content?.confirm !== true) return { kind: "cancelled", title: "Kept your study sets", speech: "Okay, I kept them." };
      }
      return mentor.deleteStudySets(a);
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
    "prepare_my_day",
    {
      title: "Prepare my day",
      description:
        "Runs the daily routine now for this learner (it also runs on its own every morning): sync school, build study sets for upcoming tests that don't have one, research the nearest test's topic beyond the notes, and plan today. Use for 'prepare my day', 'what's my plan today', 'what did you do overnight?'.",
      inputSchema: {},
    },
    async (_a: Record<string, never>, extra) => mentor.prepareMyDay(llmFor(extra), opts.researcher !== undefined ? opts.researcher : direct),
  );

  tool(
    "research_topic",
    {
      title: "Research beyond the notes",
      description:
        "Go beyond the learner's notes: search the web (Amazon Nova Web Grounding) for how the topic works one level deeper, real-world uses, a recent development, the most common misconception, and a surprising fact, with sources. Explained at their level with examples from their interests, shown as swipeable cards. Use after they share notes, or when they ask 'tell me more', 'what else should I know', 'what's new in this', 'how is this used in the real world'. Not for 'another example' or 'explain it with X': that's explain_concept.",
      inputSchema: { topic: z.string().optional().describe("Defaults to their latest study set.") },
    },
    async (a: { topic?: string }, extra) => mentor.research(llmFor(extra), opts.researcher !== undefined ? opts.researcher : direct, a.topic),
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
      inputSchema: {
        concept: z.string().optional(),
        style: z.enum(["analogy", "example", "step_by_step", "simpler", "story", "deeper"]).optional(),
        request: z.string().optional().describe("What they asked for, in their words, when it's specific: 'another example with a car engine', 'like I'm five'"),
      },
    },
    (a: { concept?: string; style?: any; request?: string }, extra) => mentor.explainConcept(llmFor(extra), a),
  );

  // ------------------------------------------------------------------ practice

  tool(
    "start_quiz",
    {
      title: "Quiz me",
      description:
        "Start a spoken quiz or flashcard round. Picks what this learner needs most: last time's mistakes first, then topics due for spaced review, then new ones. Never repeats their recent quizzes: when a topic's questions are used up, or they ask for new or different questions (fresh: true), new questions are written. Length is matched to their level.",
      inputSchema: {
        topic: z.string().optional(),
        mode: z.enum(["quiz", "flashcards"]).optional(),
        count: z.number().int().min(1).max(10).optional(),
        fresh: z.boolean().optional().describe("true when they ask for new or different questions"),
      },
    },
    async (a: { topic?: string; mode?: any; count?: number; fresh?: boolean }, extra) => mentor.startQuiz(a, llmFor(extra)),
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
    { title: "Quiz controls", description: "During a quiz: repeat (for \"what?\", \"huh?\", \"pardon?\", \"say that again\"), hint (only when they ask for help), skip, flip (show a flashcard's answer), or end.", inputSchema: { action: z.enum(["hint", "skip", "repeat", "flip", "end"]) } },
    (a: { action: any }) => mentor.quizAction(a.action),
  );

  tool(
    "start_group_quiz",
    {
      title: "Study Together",
      description:
        "Start a turn-based quiz battle for several people at one device: siblings, friends, or a parent joining in. Each player gets questions at their own level (younger players get true/false and multiple choice). Scores, streak bonuses, good sportsmanship. Registered players' own memory and reviews update; unknown names play as guests and nothing is saved about them.",
      inputSchema: {
        players: z.array(z.string()).min(1).describe("Player names; the current learner is added automatically"),
        topic: z.string().optional(),
        turns_each: z.number().int().min(1).max(5).optional(),
        include_me: z.boolean().optional().describe("Add the current learner (default true)"),
      },
    },
    (a: { players: string[]; topic?: string; turns_each?: number; include_me?: boolean }) => mentor.startGroupQuiz({ players: a.players, topic: a.topic, turnsEach: a.turns_each, includeMe: a.include_me }),
  );

  tool(
    "group_answer",
    { title: "Study Together: answer", description: "Submit the current player's answer in a Study Together game. Returns the score update and the next player's question (or final scores).", inputSchema: { answer: z.string() } },
    (a: { answer: string }, extra) => mentor.groupAnswer(llmFor(extra), a.answer),
  );

  tool(
    "group_action",
    { title: "Study Together: controls", description: "During a Study Together game: hint, skip, repeat, scores, or end.", inputSchema: { action: z.enum(["hint", "skip", "repeat", "scores", "end"]) } },
    (a: { action: any }) => mentor.groupAction(a.action),
  );

  // ------------------------------------------------------------------ Study Together across homes (invite-only)

  const me = () => {
    const l = mentor.findLearner();
    if (!l) throw new BuddyError("Who's playing? Tell me your name first.");
    return l;
  };
  const gameView = (code: string, extra: Record<string, unknown> = {}): Result => {
    const g = games.get(code);
    if (!g) throw new BuddyError("That game isn't running anymore.");
    const v = games.view(g, homeId);
    const turnLine = v.status !== "playing" ? "" : v.yourTurn ? `${v.currentPlayer}, your turn! ${spokenQ(v.question)}` : `Now it's ${v.currentPlayer}'s turn at their home.`;
    return { ...v, speech: [extra.lead, turnLine].filter(Boolean).join(" ").replace(/([.!?])\.+/g, "$1"), ...extra };
  };
  const spokenQ = (q: { type: string; prompt: string; options: string[] | null } | null) =>
    !q ? "" : q.type === "mcq" && q.options ? `${q.prompt} Is it ${q.options.slice(0, -1).join(", ")}, or ${q.options.at(-1)}?` : q.prompt;

  tool(
    "start_online_game",
    {
      title: "Study Together online",
      description:
        "Start an invite-only Study Together game with friends or family in other homes. Returns a short code ('Tiger 4 2') for friends to join on their own device. Questions come from this learner's study set and adapt to each player's level. Other homes only see first names, scores and right/wrong, never what anyone said. Under 13, a parent must switch online games on first (parent_settings).",
      inputSchema: { topic: z.string().optional(), turns_each: z.number().int().min(1).max(5).optional() },
    },
    (a: { topic?: string; turns_each?: number }) => {
      const l = me();
      if (!mentor.onlineGamesAllowed(l)) throw new BuddyError(`Online games are off for ${l.name}. A parent can switch them on by saying "allow online games for ${l.name}". You can still play Study Together here at home.`);
      const { concepts, title } = mentor.conceptsForGame(l, a.topic);
      const g = games.create({ homeId, learner: l }, concepts, { title, turnsEach: a.turns_each });
      return gameView(g.code, { lead: `Your game code is ${spokenCode(g.code)}. Your friends say "join game ${spokenCode(g.code)}" on their device. Say "start the game" when everyone's in.` });
    },
  );

  tool(
    "join_online_game",
    { title: "Join a Study Together game", description: "Join a friend's online Study Together game using the code they shared.", inputSchema: { code: z.string().describe("e.g. 'TIGER-42' or 'tiger 4 2'") } },
    (a: { code: string }) => {
      const l = me();
      if (!mentor.onlineGamesAllowed(l)) throw new BuddyError(`Online games are off for ${l.name}. Ask a parent to switch them on first.`);
      const g = games.join(a.code, { homeId, learner: l });
      return gameView(g.code, { lead: `You're in ${g.hostName}'s game! Waiting for ${g.hostName} to start.` });
    },
  );

  tool(
    "online_game_answer",
    { title: "Answer (online game)", description: "Submit the answer when it's this home's turn in an online Study Together game.", inputSchema: { answer: z.string() } },
    async (a: { answer: string }, extra) => {
      const g0 = games.activeFor(homeId);
      if (!g0) throw new BuddyError("You're not in an online game right now.");
      const r = await games.answer(g0.code, homeId, a.answer, llmFor(extra));
      const head = r.verdict === "correct" ? `Yes! ${r.points} points.` : r.verdict === "partial" ? `Close! One point.` : `Not quite. ${r.feedback}`;
      return gameView(g0.code, { lead: r.g.status === "done" ? `${head} ${r.g.lastEvent}` : head, feedback: { player: r.player.name, verdict: r.verdict, points: r.points } });
    },
  );

  tool(
    "online_game_action",
    {
      title: "Online game controls",
      description: "Online Study Together controls: start (host only), status (the scores and whose turn it is; anyone can ask at any time), hint and skip (on your turn), leave, end (host).",
      inputSchema: { action: z.enum(["start", "status", "hint", "skip", "leave", "end"]) },
    },
    (a: { action: "start" | "status" | "hint" | "skip" | "leave" | "end" }) => {
      const g0 = games.activeFor(homeId);
      if (!g0) throw new BuddyError("You're not in an online game right now.");
      switch (a.action) {
        case "start":
          games.start(g0.code, homeId);
          return gameView(g0.code, { lead: `Let's go! ${g0.players.map((p) => p.name).join(", ")}.` });
        case "hint": {
          const { hint } = games.hint(g0.code, homeId);
          return { ...gameView(g0.code), hint, speech: `Here's a hint: ${hint}` };
        }
        case "skip":
          games.skip(g0.code, homeId);
          return gameView(g0.code, { lead: "Skipped." });
        case "leave":
          games.leave(g0.code, homeId);
          return gameView(g0.code, { lead: "You've left the game." });
        case "end":
          games.end(g0.code, homeId);
          return gameView(g0.code, { lead: games.get(g0.code)?.lastEvent ?? "Game over." });
        default: {
          const v = games.view(g0, homeId);
          return gameView(g0.code, { lead: v.status === "lobby" ? `Code ${v.spokenCode}. In the game: ${v.players.map((p) => p.name).join(", ")}.` : `Scores: ${v.players.map((p) => `${p.name} ${p.score}`).join(", ")}.` });
        }
      }
    },
  );

  server.registerResource(
    "online-game",
    new ResourceTemplate("study-buddy://games/{code}", { list: undefined }),
    { title: "Online Study Together game", description: "Live state of a Study Together game, from this home's point of view. Subscribe to get updates.", mimeType: "application/json" },
    async (uri, { code }) => {
      const g = games.get(String(code));
      if (!g || !g.players.some((p) => p.homeId === homeId)) throw new Error("Unknown game");
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(gameView(g.code, { lead: g.lastEvent })) }] };
    },
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
        ...(voiceCloning ? { voice: z.string().optional().describe("Read it in a parent's story voice, only when asked: 'Mom', 'Dad', 'Grandma' or the parent's name") } : {}),
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

  // ------------------------------------------------------------------ school (Google Classroom, read-only)

  tool(
    "connect_school",
    {
      title: "Connect school",
      description:
        "Link a learner's school (Google Classroom), read-only: classes, assignments, due dates, tests and teacher materials. Opens a secure sign-in page (URL elicitation). Under 13, a parent must do this (pass parent_name). The age is checked with Google at sign-in, whatever age was said. Nothing is ever submitted or posted.",
      inputSchema: { learner: z.string().optional(), parent_name: z.string().optional().describe("Set when a parent is connecting for their child") },
    },
    async (a: { learner?: string; parent_name?: string }) => {
      const { enrollment, learner } = school.startConnect({ learner: a.learner, parentName: a.parent_name });
      const url = `${publicUrl}/school/connect?token=${enrollment.token}`;
      const base = { kind: "school_connect", title: `Connect ${learner.name}'s school`, learner: { name: learner.name }, url, live: school.provider.live, by: enrollment.connectedBy };
      if (canElicitUrl()) {
        const elicitationId = `school-${enrollment.token.slice(0, 12)}`;
        const res = await server.server.elicitInput(
          { mode: "url", elicitationId, url, message: `Connect ${learner.name}'s school on this secure page. It's read-only: classes, assignments and due dates.` },
          { timeout: 5 * 60_000 },
        );
        if (res.action !== "accept") return { kind: "cancelled", title: "Not connected", speech: "No problem. You can connect school any time." };
        schoolNotifiers.set(enrollment.token, server.server.createElicitationCompletionNotifier(elicitationId));
        return { ...base, status: "connecting", speech: `Sign in on the secure page. I only read classes, assignments and due dates, and I never submit anything.` };
      }
      return { ...base, status: "link", speech: `Open the connect page on the screen to link ${learner.name}'s school. It's read-only.` };
    },
  );

  tool(
    "school_status",
    {
      title: "School status",
      description: "Whether a learner's school is connected, and how the last connect attempt went (for example: Google says the account is under 13, so a parent needs to connect).",
      inputSchema: { learner: z.string().optional() },
      readOnly: true,
    },
    (a: { learner?: string }) => school.status(a.learner),
  );

  tool(
    "sync_school",
    { title: "Sync school", description: "Refresh a connected learner's classes, assignments, tests and teacher materials. Tests become exams in the study plan; teacher notes become study sets.", inputSchema: { learner: z.string().optional() } },
    (a: { learner?: string }, extra) => school.sync(a.learner, llmFor(extra)),
  );

  tool(
    "school_homework",
    { title: "What's due", description: "What's due from school: upcoming assignments and tests, and anything past due. Use for 'what homework do I have?' or a parent asking what their child has due.", inputSchema: { learner: z.string().optional(), days: z.number().int().min(1).max(30).optional() }, readOnly: true },
    (a: { learner?: string; days?: number }) => school.homework(a.learner, a.days),
  );

  tool(
    "disconnect_school",
    { title: "Disconnect school", description: "Remove the school connection (revokes access) and delete synced classes and assignments.", inputSchema: { learner: z.string().optional() }, destructive: true },
    (a: { learner?: string }) => school.disconnect(a.learner),
  );

  // ------------------------------------------------------------------ parent story voices (consent-first, stories & messages only)

  const canElicitUrl = () => !!(server.server.getClientCapabilities()?.elicitation as any)?.url;

  if (voiceCloning) {
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
  }

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
