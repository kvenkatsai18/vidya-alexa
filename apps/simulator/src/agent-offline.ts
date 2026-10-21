import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectConcern } from "../../../packages/mcp-server/src/domain/safety.ts";
import { structured, type AgentContext, type VoiceAgent } from "./agent.ts";

/**
 * Scripted agent used when no LLM is configured, so the simulator (and the judges) can run the whole
 * experience without an API key. It maps utterances to Study Buddy MCP tool calls with an intent
 * router plus conversational state, and speaks each tool's voice-ready `speech` field.
 */

type R = Record<string, any>;

const here = path.dirname(fileURLToPath(import.meta.url));
export const SAMPLE_NOTES_PATH = path.resolve(here, "../../../packages/mcp-server/content/cell-division.md");

const YES = /^(yes|yeah|yep|yup|sure|ok(ay)?|please|go ahead|do it|let'?s (do it|go)|sounds good|absolutely|definitely)\b/;
const SUBJECTS = ["biology", "chemistry", "physics", "maths", "math", "mathematics", "history", "geography", "english", "science", "economics", "computer science", "hindi", "french", "spanish"];
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const NOT_NAMES = new Set(["in", "a", "an", "the", "studying", "doing", "going", "not", "so", "really", "very", "into", "done", "back", "here", "ready", "stuck", "confused", "sorry", "fine", "good", "nervous", "learning", "trying", "taking", "preparing", "looking"]);

function norm(text: string) {
  return text
    .toLowerCase()
    .replace(/^\s*(hey |ok |okay )?alexa[,!.]?\s*/, "")
    .replace(/[“”"]/g, "")
    .replace(/[.!?]+$/, "")
    .trim();
}

const DIGIT_WORDS: Record<string, string> = { zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9" };

/** "tiger four two" -> "tiger 4 2" (the server normalizes the rest). */
function digitsOf(code: string): string {
  return code.replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine)\b/g, (w) => DIGIT_WORDS[w]);
}

function daysUntil(t: string): number | undefined {
  const inDays = t.match(/\bin (\d{1,2}) days?\b/);
  if (inDays) return Number(inDays[1]);
  if (/\btomorrow\b/.test(t)) return 1;
  if (/\btoday\b/.test(t)) return 0;
  if (/\bnext week\b/.test(t)) return 7;
  if (/\bin a week\b/.test(t)) return 7;
  const day = WEEKDAYS.findIndex((d) => new RegExp(`\\b${d}\\b`).test(t));
  if (day >= 0) {
    const diff = (day - new Date().getDay() + 7) % 7;
    return diff === 0 ? 7 : diff;
  }
  return undefined;
}

/** "I'm Priya, I'm in 10th grade and I love cricket and cooking. My biology exam is on Friday." */
export function parseIntro(raw: string): R | undefined {
  const t = raw.replace(/^\s*(hey |ok |okay )?alexa[,!.]?\s*/i, "");
  const out: R = {};
  const name = t.match(/\b(?:my name is|i'?m|i am|this is|it'?s|call me)\s+([A-Za-z][a-z]+)\b/i);
  if (name && !NOT_NAMES.has(name[1].toLowerCase())) out.name = name[1];
  const lower = t.toLowerCase();
  const grade = lower.match(/\b(\d{1,2})(?:st|nd|rd|th)\s*(grade|class|standard|std)?\b/) ?? lower.match(/\b(grade|class|standard|std|year)\s*(\d{1,2})\b/);
  if (grade) out.level = /^\d/.test(grade[1]) ? `Grade ${grade[1]}` : `${grade[1][0].toUpperCase()}${grade[1].slice(1)} ${grade[2]}`;
  const year = lower.match(/\b((?:1st|2nd|3rd|4th|first|second|third|fourth|final) year(?: of)?(?: [a-z.]+(?: [a-z.]+)?)?)\b/);
  if (!out.level && year) out.level = year[1].replace(/\b(at|in|and)\b.*$/, "").trim();
  if (!out.level && /\b(college|university|undergrad)\b/.test(lower)) out.level = "College";
  if (!out.level && /\b(kindergarten|preschool)\b/.test(lower)) out.level = "Kindergarten";
  if (!out.level && /\b(working|professional|adult)\b/.test(lower)) out.level = "Adult learner";
  const age = lower.match(/\b(\d{1,2})\s*(?:years?\s*old|yo)\b/) ?? lower.match(/\bi'?m (\d{1,2})\b/);
  if (age) out.age = Number(age[1]);
  const likes = lower.match(/\b(?:i (?:really )?(?:love|like|enjoy)|i'?m (?:really )?into|i am into|big fan of)\s+([^.;]+)/);
  if (likes) {
    out.interests = likes[1]
      .split(/,|\band\b|\bor\b/)
      .map((x) => x.replace(/\b(my|the|playing|watching|doing)\b/g, "").replace(/\b(exam|test)\b.*$/, "").trim())
      .filter((x) => x && x.length < 30 && !/\bexam|test|grade|class\b/.test(x));
  }
  const examM = lower.match(/\b(?:my|a|an|the)?\s*([a-z ]{0,30}?)\s*(exam|test|quiz|finals?|midterms?)\b(.*)$/);
  if (examM && /\b(exam|test|finals?|midterms?)\b/.test(lower) && (daysUntil(examM[3] ?? "") !== undefined || daysUntil(lower) !== undefined)) {
    const subject = SUBJECTS.find((s) => lower.includes(s));
    const title = `${subject ? subject[0].toUpperCase() + subject.slice(1) + " " : ""}${examM[2] === "test" ? "test" : "exam"}`;
    out.exam_title = title;
    if (subject) out.exam_subject = subject;
    out.exam_in_days = daysUntil(examM[3] ?? "") ?? daysUntil(lower);
  }
  return Object.keys(out).length ? out : undefined;
}

function styleFrom(t: string): string | undefined {
  if (/\b(simpl|still don'?t|confus|lost|too hard|easier)\b/.test(t)) return "simpler";
  if (/\bstep by step\b|\bsteps\b/.test(t)) return "step_by_step";
  if (/\b(example|real life|real-life|real world)\b/.test(t)) return "example";
  if (/\b(deeper|more detail|in depth|why does)\b/.test(t)) return "deeper";
  if (/\b(story)\b/.test(t)) return "story";
  if (/\b(differently|another way|different way|analogy)\b/.test(t)) return "analogy";
  return undefined;
}

function topicFrom(t: string): string | undefined {
  const m = t.match(/\b(?:explain|teach me(?: about)?|tell me about|what (?:is|are|'s)|what's|how does|how do|why (?:does|do|is)|help me (?:with|understand)|quiz me on|test me on|flashcards (?:on|for)|summar(?:y|ize|ise)(?: of)?|on)\s+(.+)$/);
  if (!m) return undefined;
  const topic = m[1].replace(/\b(again|please|to me|for me|differently|another way|more simply|simply|step by step|in simple words|like i'?m \w+)\b/g, "").replace(/\s+/g, " ").trim();
  return topic && !/^(it|that|this|the next topic|my weak spot|the part i missed)$/.test(topic) ? topic : undefined;
}

export class OfflineAgent implements VoiceAgent {
  readonly label = "Scripted intent router (offline mode, no LLM)";
  private last: R | null = null;
  private lastConcept?: string;
  private learnerName?: string;
  /** Set when a parent is the one talking ("I'm Asha, Leo's mom"). */
  private parent?: { name: string; relation: string; child?: string };
  /** Last Study Together line-up, for "rematch". */
  private lastPlayers?: string[];
  private styleTurn = 0;

  reset() {
    this.last = null;
    this.lastConcept = undefined;
    this.learnerName = undefined;
    this.parent = undefined;
  }

  note() {
    // The router reads state from tool results; nothing to remember here.
  }

  observe(state: R) {
    this.last = state;
  }

  async turn(ctx: AgentContext, raw: string): Promise<string> {
    const t = norm(raw);
    const call = async (name: string, args: R = {}) => {
      const r = structured(await ctx.callTool(name, args));
      if (r.kind !== "error") this.last = r;
      if (r.kind === "explanation") this.lastConcept = r.title;
      if (r.kind === "teach_back") this.lastConcept = String(r.title).replace(/^(Teach me|You taught): /, "");
      if (r.concept?.title) this.lastConcept = r.concept.title;
      if (r.learner?.name && r.learner.role !== "child") this.learnerName = r.learner.name;
      return r;
    };
    const say = (r: R) => String(r.speech ?? "Okay.");
    const last = this.last;

    // --- child safety comes before everything (a parent describing a worry is a parent note instead)
    const worry = detectConcern(raw);
    if (worry && !this.parent) {
      return say(await call("flag_concern", { category: worry.category, severity: worry.severity, summary: worry.summary, excerpt: raw }));
    }

    // --- parent transparency controls
    const histFor = t.match(/\b(?:show me|what has|what did|let me see|read me)\s+([a-z]+)'?s?\s+(?:been (?:talking|saying|chatting)|conversations?|chats?|history)\b/)?.[1] ?? t.match(/\b([a-z]+)'s (conversations?|chats?|chat history|history)\b/)?.[1];
    if (histFor && !/\b(delete|clear|erase)\b/.test(t)) return say(await call("parent_history", { child: histFor[0].toUpperCase() + histFor.slice(1) }));
    const setFor = t.match(/\b(?:full history|summary|summaries)\b.*\bfor ([a-z]+)\b/)?.[1] ?? t.match(/\bswitch ([a-z]+) to (?:full|summary)\b/)?.[1];
    if (setFor) return say(await call("parent_settings", { child: setFor[0].toUpperCase() + setFor.slice(1), visibility: /\bsummar/.test(t) && !/\bfull\b/.test(t) ? "summary" : "full" }));
    const clearFor = t.match(/\b(?:delete|clear|erase) ([a-z]+)'s (?:conversation )?(?:history|conversations|chats)\b/)?.[1];
    if (clearFor) return say(await call("parent_settings", { child: clearFor[0].toUpperCase() + clearFor.slice(1), clear_history: true }));

    // --- answering the icebreaker when we first meet a child
    if (last?.kind === "meet" && !/\b(story|quiz|explain|help|notes|parent|join|game|online)\b/.test(t)) {
      const name = last.learner?.name ?? "";
      const answer = raw.replace(/^\s*(alexa[,!.]?\s*)?(um+|uh+|hmm+|well|i think|probably|maybe|it'?s|my favou?rite (one )?is|i like|i love)[,\s]*/gi, "").replace(/[.!?]+$/, "").trim();
      await ctx.callTool("remember", { fact: `${name}'s ${last.askedAbout}: ${answer}`, kind: "personal" });
      this.last = { kind: "met" };
      const young = last.learner?.band === "early" || last.learner?.band === "primary";
      return `${answer.charAt(0).toUpperCase() + answer.slice(1)}! ${young ? "Great choice." : "Good pick."} I'll remember that. ${young ? `Want to hear a story, or play a quick learning game?` : `So, what are you studying right now? You can share your notes, or just name a topic.`}`;
    }

    // --- parent mode: a parent introduces themselves and their child
    const parentIntro = raw.match(/\b(?:i'?m|i am|this is)\s+([A-Za-z]+),?\s+([A-Za-z]+)'s\s+(mom|mum|mother|dad|father|parent|grandma|grandmother|grandpa|grandfather|aunt|auntie|uncle|guardian)\b/i)
      ?? raw.match(/\b(?:i'?m|i am)\s+([A-Za-z]+)'s\s+(mom|mum|mother|dad|father|parent|grandma|grandpa|guardian)\b/i);
    if (parentIntro) {
      const [pname, child, rel] = parentIntro.length === 4 ? [parentIntro[1], parentIntro[2], parentIntro[3]] : [parentIntro[2], parentIntro[1], parentIntro[2]];
      this.parent = { name: pname, relation: rel, child };
    }
    const childRef = this.parent?.child;
    if (this.parent && childRef && !/\b(record|clone|voice|story|message|school|classroom|homework|assignments?|due)\b/.test(t)) {
      const c = childRef[0].toUpperCase() + childRef.slice(1);
      if (/\bhow('?s| is) \w+ doing\b|\bprogress\b|\breport\b|\bhow did (he|she|they)\b/.test(t)) return say(await call("parent_overview", { child: c }));
      const info = parseIntro(raw.replace(/\b(he|she|they)'?s\b/gi, "I'm").replace(/\b(he|she|they) (loves?|likes?|enjoys?)\b/gi, "I love"));
      const notes = (raw.match(/\b(?:he|she|they)\s+(?:gets|is|struggles|finds|can be|has trouble|hates|forgets|panics)[^.!?]*/gi) ?? []).map((n) => n.trim());
      const age = Number(t.match(/\b(?:he'?s|she'?s|they'?re|is|aged?)\s+(\d{1,2})\b/)?.[1] ?? info?.age ?? NaN);
      if (parentIntro || info?.level || info?.interests || Number.isFinite(age)) {
        return say(
          await call("parent_setup", {
            parent_name: this.parent.name === this.parent.relation ? this.parent.relation : this.parent.name,
            relation: this.parent.relation,
            child: c,
            ...(Number.isFinite(age) ? { age } : {}),
            ...(info?.level ? { level: info.level } : {}),
            ...(info?.interests?.length ? { interests: info.interests } : {}),
            ...(notes.length ? { notes } : {}),
            ...(info?.exam_title ? { exam_title: info.exam_title, exam_subject: info.exam_subject, exam_in_days: info.exam_in_days } : {}),
          }),
        );
      }
      if (notes.length) return say(await call("parent_note", { child: c, note: notes[0], parent_name: this.parent.name }));
    }
    const overview = t.match(/\bhow('?s| is) ([a-z]+) doing\b/);
    if (overview) return say(await call("parent_overview", { child: overview[2][0].toUpperCase() + overview[2].slice(1) }));

    // --- moods adapt today's session
    if (/^(i'?m|i am|feeling|i feel)\s+(so |really |super |a bit |kinda |very )?(tired|sleepy|exhausted|stressed|anxious|nervous|worried|bored|overwhelmed|happy|excited|great|pumped)\b/.test(t)) {
      return say(await call("remember", { fact: raw, kind: "mood" }));
    }

    // --- school (read-only)
    if (/\b(connect|link|add|sync up)\b.*\b(school|classroom|classes)\b/.test(t) && !/\bdis(connect)?\b/.test(t)) {
      const forChild = t.match(/\b([a-z]+)'s (school|classroom|classes)\b/)?.[1];
      const learner = forChild && forChild !== "my" ? forChild[0].toUpperCase() + forChild.slice(1) : undefined;
      return say(await call("connect_school", { ...(learner ? { learner } : {}), ...(this.parent ? { parent_name: this.parent.name } : {}) }));
    }
    if (/\b(disconnect|unlink|remove)\b.*\b(school|classroom)\b/.test(t)) return say(await call("disconnect_school", {}));
    if (/\b(sync|refresh|update)\b.*\b(school|classes|classroom|assignments)\b/.test(t)) return say(await call("sync_school", {}));
    if (/\b(homework|assignments?|what'?s due|what is due|due this week|anything due|coursework)\b/.test(t)) {
      const forChild = t.match(/\b(?:does|has) ([a-z]+) (?:have|got)\b/)?.[1] ?? t.match(/\b([a-z]+)'s (homework|assignments)\b/)?.[1];
      return say(await call("school_homework", forChild && forChild !== "my" ? { learner: forChild[0].toUpperCase() + forChild.slice(1) } : {}));
    }

    // --- parent story voices (only when the server has them enabled)
    const voiceTools = ctx.mcp.tools.some((x) => x.name === "create_parent_voice");
    const REL = /\b(mom|mum|mommy|mummy|mother|amma|dad|daddy|father|papa|grandma|granny|nani|dadi|grandpa|nana|dada|auntie|aunt|uncle)\b/;
    const voiceRef = t.match(/\bin (my|[a-z]+)'?s? (?:own )?voice\b/)?.[1];
    if (voiceTools && /\b(story voices?|my voice|(\w+)'?s voice)\b/.test(t) && /\b(delete|remove|forget|erase)\b/.test(t)) {
      return say(await call("parent_voice", { action: "delete", ...(voiceRef || t.match(REL) ? { voice: (t.match(REL)?.[1] ?? voiceRef)! } : {}) }));
    }
    if (voiceTools && /\b(story voices?|my voice|(\w+)'?s voice)\b/.test(t) && /\b(pause|stop using|turn off)\b/.test(t)) {
      return say(await call("parent_voice", { action: "pause", ...(t.match(REL) ? { voice: t.match(REL)![1] } : {}) }));
    }
    if (voiceTools && /\b(story voices?|my voice|(\w+)'?s voice)\b/.test(t) && /\b(resume|turn (it )?back on|unpause|turn on)\b/.test(t)) {
      return say(await call("parent_voice", { action: "resume", ...(t.match(REL) ? { voice: t.match(REL)![1] } : {}) }));
    }
    if (voiceTools && /\bwhat (story )?voices\b|\blist (the )?(story )?voices\b|\bstory voices\b$/.test(t)) return say(await call("parent_voice", { action: "list" }));
    if (voiceTools && /\b(record|clone|create|set up|setup|save|make|add)\b.*\bvoice\b/.test(t) && !/\bstory about\b/.test(t)) {
      const name = raw.match(/\b(?:i'?m|i am|this is|my name is)\s+([A-Z][a-z]+)\b/i)?.[1];
      const relation = t.match(REL)?.[1];
      const children = t.match(/\bfor ([a-z]+(?:(?:,| and) [a-z]+)*)\b/)?.[1]?.split(/,| and /).map((x) => x.trim()).filter((x) => x && !/^(bedtime|stories|story|my|the|kids?|children)$/.test(x));
      if (!name && !relation) return "Sure. Whose voice is it? Tell me your name, and whether the kids call you Mom, Dad, or something else.";
      return say(await call("create_parent_voice", { parent_name: name ?? relation!, ...(relation ? { relation } : {}), ...(children?.length ? { children: children.map((c) => c[0].toUpperCase() + c.slice(1)) } : {}) }));
    }
    if (voiceTools && /\b(leave|send|record|write)\b.*\b(good ?night |goodnight )?message\b/.test(t)) {
      const to = t.match(/\bfor ([a-z]+)\b/)?.[1] ?? t.match(/\bto ([a-z]+)\b/)?.[1];
      const from = t.match(/\bfrom ([a-z]+)\b/)?.[1] ?? t.match(REL)?.[1];
      // The parent's exact words: everything after ":" or "saying" / "that says".
      const text = raw.match(/:\s*(.+)$/)?.[1] ?? raw.match(/\b(?:saying|that says|it says)\s+(.+)$/i)?.[1];
      if (!to) return "Who's the message for?";
      if (!text) return `What would you like it to say? Start with "saying", and I'll keep your exact words.`;
      return say(await call("voice_message", { action: "leave", to: to[0].toUpperCase() + to.slice(1), ...(from ? { from } : {}), text: text.trim().replace(/^["“]|["”]$/g, "") }));
    }
    if (voiceTools && /\b(any|my|new|play|read)\b.*\bmessages?\b/.test(t) && !/\bleave\b/.test(t)) {
      const forName = t.match(/\bfor ([a-z]+)\b/)?.[1];
      const to = (forName && !/^(me|us|myself)$/.test(forName) ? forName : undefined) ?? raw.match(/\b(?:i'?m|it'?s|this is)\s+([A-Z][a-z]+)\b/i)?.[1] ?? last?.child?.name ?? this.learnerName;
      if (!to) return "Whose messages should I play?";
      return say(await call("voice_message", { action: "play", to: to[0].toUpperCase() + to.slice(1) }));
    }

    // --- family mode first: "tell Leo a story about ..."
    if (/\bstor(y|ies)\b/.test(t) && !/\b(as a story|like a story)\b/.test(t)) {
      const child =
        raw.match(/\b(?:[Tt]ell|[Ff]or|[Rr]ead)\s+([A-Z][a-z]+)\b/)?.[1] ??
        t.match(/\b(?:tell|read)\s+([a-z]+)\s+(?:a|another|the)\s+(?:\w+\s+)?story\b/)?.[1] ??
        t.match(/\bstory (?:for|to) ([a-z]+)\b/)?.[1] ??
        last?.child?.name;
      if (!child) return "Who's the story for, and what would you like it to teach?";
      const tl = t.replace(/\s*\bin (my|[a-z]+)'?s? (?:own )?voice\b/, "");
      const lesson =
        tl.match(/\b(?:about|that teaches|teaching|on)\s+(?:why\s+|how\s+|that\s+)?(.+?)(?:[.,;]|$|\b(?:he|she|they)\b|\bhe'?s\b)/)?.[1]?.trim() ??
        (last?.kind === "story" ? last.lesson : "being kind");
      const age = Number(t.match(/\b(?:he'?s|she'?s|they'?re|is|aged?)\s+(\d{1,2})\b/)?.[1] ?? t.match(/\b(\d{1,2})\s*(?:years? old|yo)\b/)?.[1] ?? NaN);
      const interests = t.match(/\b(?:loves?|likes?|is into|into)\s+([^.;]+)/)?.[1]?.split(/,|\band\b/).map((x) => x.trim()).filter(Boolean);
      const voice = voiceRef && voiceRef !== "my" ? voiceRef : voiceRef === "my" ? "my" : undefined;
      return say(await call("tell_story", { child: child[0].toUpperCase() + child.slice(1), lesson, ...(Number.isFinite(age) ? { age } : {}), ...(interests?.length ? { interests } : {}), ...(voice ? { voice: voice === "my" ? "" : voice } : {}) }));
    }

    // --- the daily routine
    if (/\b(prepare my day|plan my day|what did you do (overnight|while i was away)|what('s| is) (my )?plan (for )?today)\b/.test(t)) return say(await call("prepare_my_day"));

    // --- research beyond the notes
    if (/\b(research|beyond (my|the) notes|tell me more about|real[- ]world (uses|examples))\b/.test(t)) {
      const topic = t.match(/\b(?:research|more about)\s+(.+?)(?:\s+beyond (?:my|the) notes)?$/)?.[1];
      return say(await call("research_topic", topic ? { topic } : {}));
    }

    // --- the learner corrects us
    const callMe = raw.match(/\b(?:please |just )?call me ([A-Za-z][\w'-]*(?: [A-Z][\w.'-]*)?)/i);
    if (callMe) return say(await call("learn_from_feedback", { lesson: "", preferred_name: callMe[1] }));
    if (/\b(that was right|i was right|my answer was right|that'?s not wrong|check (it|that|my answer) again|recheck)\b/.test(t)) return say(await call("recheck_answer", { reason: raw }));

    // --- parent: online games on/off for a child
    const og = t.match(/\b(allow|turn on|switch on|enable|turn off|switch off|disable|block|stop)\b.*\bonline (?:games?|study together)\b.*\bfor ([a-z]+)\b/);
    if (og) return say(await call("parent_settings", { child: og[2][0].toUpperCase() + og[2].slice(1), online_games: /^(allow|turn on|switch on|enable)$/.test(og[1]) ? "allowed" : "off" }));

    // --- Study Together across homes (invite code)
    const joinCode = t.match(/\bjoin (?:the |a |my friend'?s |their )?(?:game|battle|quiz)?\s*(?:code )?([a-z]+(?:[ -]?(?:\d|one|two|three|four|five|six|seven|eight|nine|zero)){1,2}|[a-z]+[ -]?\d{2})\b/);
    if (joinCode && !/\b(join (?:me|us|in))\b/.test(t)) return say(await call("join_online_game", { code: digitsOf(joinCode[1]) }));
    if (last?.kind === "online_game" && last.status !== "done") {
      if (last.status === "lobby" && /\b(start|begin|let'?s go|let'?s play|everyone'?s (in|here))\b/.test(t)) return say(await call("online_game_action", { action: "start" }));
      if (/\b(leave|quit|i'?m out)\b/.test(t)) return say(await call("online_game_action", { action: last.isHost ? "end" : "leave" }));
      if (/^(stop|end|game over)\b|\bend the game\b/.test(t)) return say(await call("online_game_action", { action: "end" }));
      if (/\b(scores?|who'?s winning|scoreboard|status|what'?s the code|who'?s (in|here))\b/.test(t)) return say(await call("online_game_action", { action: "status" }));
      if (last.status === "playing" && last.yourTurn) {
        if (/^(hint|give me a hint|a hint|clue)\b|\bhint\b/.test(t)) return say(await call("online_game_action", { action: "hint" }));
        if (/^(skip|pass|i don'?t know|no idea|dunno)\b/.test(t)) return say(await call("online_game_action", { action: "skip" }));
        if (/^(repeat|again|say (that|it) again|what was the question)\b/.test(t)) return say(await call("online_game_action", { action: "status" }).then((r) => ({ ...r, speech: last.speech })));
        return say(await call("online_game_answer", { answer: raw }));
      }
      if (last.status === "playing" && /^(true|false|yes|no|[a-d]\b)/.test(t)) return `Hold on, it's ${last.currentPlayer}'s turn at their home.`;
    }
    if (/\b(online|other homes?|another home|their (own )?homes?|remote(ly)?|over the internet|from (his|her|their) house)\b/.test(t) && /\b(game|quiz|battle|play|study together|compete)\b/.test(t)) {
      const topic = t.match(/\b(?:on|about) ([a-z ]+?)(?: with | online|$)/)?.[1];
      return say(await call("start_online_game", topic ? { topic } : {}));
    }

    // --- Study Together: a game in progress takes every answer
    if (last?.kind === "group_question") {
      if (/^(hint|give me a hint|a hint|clue)\b|\bhint\b/.test(t)) return say(await call("group_action", { action: "hint" }));
      if (/^(skip|pass|i don'?t know|no idea|dunno)\b/.test(t)) return say(await call("group_action", { action: "skip" }));
      if (/\b(scores?|who'?s winning|scoreboard)\b/.test(t)) return say(await call("group_action", { action: "scores" }));
      if (/^(repeat|again|say (that|it) again|what was the question)\b/.test(t)) return say(await call("group_action", { action: "repeat" }));
      if (/^(stop|end|quit|game over|that'?s enough)\b|\bend the game\b/.test(t)) return say(await call("group_action", { action: "end" }));
      return say(await call("group_answer", { answer: raw }));
    }
    const playWith = t.match(/\b(?:play|quiz|compete|battle|study|game)\b.*\bwith ([a-z]+(?:(?:,| and|,? and) [a-z]+)*)/)?.[1];
    if ((playWith && /\b(play|quiz|compete|battle|game|together|race)\b/.test(t)) || /\b(study together|quiz battle)\b/.test(t)) {
      const players = (playWith ?? "")
        .split(/,| and /)
        .map((x) => x.trim())
        .filter((x) => x && !/^(me|my|friends?|family|everyone|us|them)$/.test(x))
        .map((x) => x[0].toUpperCase() + x.slice(1));
      if (!players.length) return "Fun! Who's playing? Tell me everyone's names.";
      this.lastPlayers = players;
      const topic = t.match(/\b(?:on|about) ([a-z ]+?)(?: with |$)/)?.[1];
      return say(await call("start_group_quiz", { players, ...(topic ? { topic } : {}) }));
    }
    if (/^(rematch|again|play again|one more (game|round))\b/.test(t) && last?.kind === "group_summary" && this.lastPlayers) {
      return say(await call("start_group_quiz", { players: this.lastPlayers }));
    }

    // --- an open quiz: almost everything is an answer
    if (last?.kind === "quiz_question") {
      if (/^(hint|give me a hint|a hint|clue)\b|\bhint\b/.test(t)) return say(await call("quiz_action", { action: "hint" }));
      if (/^(skip|pass|next one|i don'?t know|no idea|dunno)\b/.test(t)) return say(await call("quiz_action", { action: "skip" }));
      if (/^(repeat|again|say (that|it) again|what was the question|repeat the question)\b/.test(t)) return say(await call("quiz_action", { action: "repeat" }));
      if (/^(flip|show (me )?the answer|reveal)\b/.test(t)) return say(await call("quiz_action", { action: "flip" }));
      if (/^(stop|end|quit|that'?s enough|i'?m done)\b|\b(end|stop) the quiz\b/.test(t)) return say(await call("quiz_action", { action: "end" }));
      if (!/\b(explain|teach me|what is)\b/.test(t)) return say(await call("answer_question", { answer: raw }));
    }

    // --- teach-back: the next thing they say is their explanation
    if (last?.kind === "teach_back" && last.phase === "listening" && !/^(cancel|stop|never ?mind)\b/.test(t)) {
      return say(await call("teach_back", { action: "submit", explanation: raw }));
    }

    // --- focus session ending (the card says this when the timer runs out)
    if (/\b(focus session is done|end (my )?focus|focus is over|time'?s up)\b/.test(t)) return say(await call("focus_session", { action: "end" }));

    // --- onboarding / introductions
    const intro = parseIntro(raw);
    if (!this.learnerName && !intro?.name && !/\b(set me up|use the form)\b/.test(t)) {
      // Find out who's here before anything else (the server remembers learners across sessions).
      const r = await call("get_today", {});
      if (r.kind === "today") this.learnerName = r.learner?.name;
      if (r.kind === "welcome" || /^(hi|hello|hey|good (morning|afternoon|evening))\b|\b(help me study|let'?s study|study time)\b/.test(t)) return say(r);
    }
    if (/\b(help me study|let'?s study|study time|what should we do)\b/.test(t)) return say(await call("get_today", {}));
    const today = last?.kind === "welcome" || !last ? undefined : last;
    if (/\b(set me up|setup form|use the form|sign me up)\b/.test(t)) return say(await call("set_up_learner", { use_form: true }));
    if (intro?.name && !intro.level && !intro.age && !intro.interests && !parentIntro) {
      const r = structured(await ctx.callTool("switch_learner", { name: intro.name }));
      if (r.kind !== "error") {
        this.last = r;
        if (r.learner?.name) this.learnerName = r.learner.name;
        this.parent = undefined;
        return say(r);
      }
    }
    if (intro?.name && !parentIntro && (intro.level || intro.age || intro.interests || last?.kind === "welcome" || !last)) {
      return say(await call("set_up_learner", intro));
    }
    if (intro?.name && /^((hi|hello|hey)[,!]?\s+)?(it'?s|this is|i'?m)\s+\w+(\s+(now|here))?$/.test(t)) {
      const r = structured(await ctx.callTool("switch_learner", { name: intro.name }));
      if (r.kind !== "error") {
        this.last = r;
        return say(r);
      }
      return say(await call("set_up_learner", intro));
    }
    if (intro?.exam_title && !intro.name) return say(await call("set_up_learner", { name: today?.learner?.name ?? last?.learner?.name ?? "", ...intro }));

    // --- notes
    if (/\b(sample|biology|my) notes\b|\buse (the|my) notes\b|\bstudy my notes\b|\bshare (my )?notes\b/.test(t)) {
      if (/\b(sample|biology|use)\b/.test(t)) {
        return say(await call("add_material", { title: "Cell division notes", text: readFileSync(SAMPLE_NOTES_PATH, "utf8") }));
      }
      return "Share your notes from your phone with the Share notes button, or say: use my biology notes.";
    }

    // --- memory & privacy
    if (/\bwhat do you (know|remember)\b|\bmy profile\b/.test(t)) return say(await call("get_profile", {}));
    if (/\b(forget|delete) (everything|all|my (profile|data))\b/.test(t)) return say(await call("forget", { everything: true }));
    const forget = t.match(/^forget (?:that )?(.+)$/);
    if (forget) return say(await call("forget", { text: forget[1] }));
    const rem = t.match(/^(?:remember (?:that )?)(.+)$/);
    if (rem) return say(await call("remember", { fact: rem[1], kind: kindFor(rem[1]) }));
    if (/^i (get|am|feel|hate|prefer|learn better|struggle|always|usually|find)\b/.test(t) && !/\b(done|finished|ready)\b/.test(t)) {
      return say(await call("remember", { fact: raw.replace(/[.!]$/, ""), kind: kindFor(t) }));
    }

    // --- teach-back
    if (/\b(teach (it|this|that|\w+) back|let me (explain|teach)|i'?ll (explain|teach)|let me try teaching)\b/.test(t)) {
      const concept = t.match(/\bteach (.+?) back\b/)?.[1]?.replace(/^(it|this|that)$/, "") || topicFrom(t) || this.lastConcept;
      return say(await call("teach_back", { action: "start", ...(concept ? { concept } : {}) }));
    }

    // --- questions about themselves come before "what is X" explanations
    if (/\b(plan|how am i doing|progress|what should i (study|do)|mastery|am i ready|ready for)\b/.test(t)) return say(await call("get_study_plan", {}));
    if (/\b(summar|cheat sheet|recap|revision notes|one page)\b/.test(t)) return say(await call("summarize", topicFrom(t) ? { topic: topicFrom(t) } : {}));

    // --- explanations
    const style = styleFrom(t);
    const wantsExplain = /\b(explain|teach me|tell me about|what (is|are)|what's|how does|how do|why (does|do|is)|help me understand|i don'?t (get|understand)|confused|makes no sense)\b/.test(t);
    if (wantsExplain || (style && this.lastConcept && /\b(differently|another way|simpl|example|step by step|deeper)\b/.test(t))) {
      let concept = topicFrom(t);
      if (!concept && /\b(next topic)\b/.test(t)) concept = undefined;
      if (/\b(weak spot|part i missed)\b/.test(t)) concept = last?.weakSpot?.title ?? last?.weak?.[0]?.title ?? this.lastConcept;
      if (!concept && (style || /\b(it|that|this)\b/.test(t))) concept = this.lastConcept;
      const s = style === "analogy" ? ["analogy", "example", "step_by_step"][this.styleTurn++ % 3] : style;
      return say(await call("explain_concept", { ...(concept ? { concept } : {}), ...(s ? { style: s } : {}) }));
    }
    if (YES.test(t) && last?.kind === "deck") return say(await call("explain_concept", { concept: last.concepts?.[0]?.title }));
    if (YES.test(t) && last?.kind === "focus" && last.phase === "done") return say(await call("start_quiz", { count: 3 }));
    if (YES.test(t) && (last?.kind === "explanation" || last?.kind === "today")) return say(await call("start_quiz", {}));

    // --- practice
    if (/\b(quiz|test me|practice|questions|flashcards?|review|revise)\b/.test(t)) {
      const mode = /\bflashcards?\b/.test(t) ? "flashcards" : "quiz";
      const topic = t.match(/\b(?:on|about|for)\s+(.+)$/)?.[1]?.replace(/\b(what i just studied|it|that|this)\b/, "").trim();
      const count = /\b(quick|three|3)\b/.test(t) ? 3 : undefined;
      return say(await call("start_quiz", { mode, ...(topic ? { topic } : {}), ...(count ? { count } : {}) }));
    }
    if (/\b(summar|cheat sheet|recap|revision notes|one page)\b/.test(t)) return say(await call("summarize", topicFrom(t) ? { topic: topicFrom(t) } : {}));
    if (/\b(focus|distract|pomodoro|timer|reels|scrolling|procrastinat|phone)\b/.test(t)) {
      const minutes = Number(t.match(/\b(\d{1,2})\s*(?:min|minutes)\b/)?.[1] ?? NaN);
      return say(await call("focus_session", { action: "start", ...(Number.isFinite(minutes) ? { minutes } : {}), ...(this.lastConcept ? { topic: this.lastConcept } : {}) }));
    }
    if (/\b(learn|study|new topic)\b/.test(t)) {
      const topic = t.match(/\b(?:learn|study)\s+(?:about\s+)?(.+)$/)?.[1];
      if (topic && !/^(today|now|something|a new topic)$/.test(topic)) return say(await call("add_topic", { topic }));
      return "What would you like to learn? Name a topic, or share your notes.";
    }
    if (/\b(done for (today|tonight)|goodnight|good night|bye|see you)\b/.test(t)) {
      return "Great work today. Get some sleep, it's when your brain locks in what you learned. See you tomorrow!";
    }
    if (/^(hi|hello|hey|good (morning|afternoon|evening))\b|\bwhat'?s (up|next|on today)\b/.test(t) || !last) return say(await call("get_today", {}));

    return "I can explain anything, quiz you, make flashcards, plan for your exam, or tell a bedtime story. Try saying: quiz me, or explain meiosis.";
  }
}

function kindFor(text: string): string {
  if (/\b(nervous|anxious|panic|struggle|hard|hate|bad at|confus|forget|scared)\b/.test(text)) return "struggle";
  if (/\b(prefer|learn better|like it when|rather|works for me)\b/.test(text)) return "preference";
  if (/\b(want to|goal|aim|dream|hoping)\b/.test(text)) return "goal";
  if (/\b(good at|best at|great at)\b/.test(text)) return "strength";
  return "personal";
}
