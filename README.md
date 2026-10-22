# Vidya

**The study mentor on Alexa that remembers you.** Tell Vidya who you are, from a 7-year-old to a second-year engineering student, and it teaches at your level with examples from your world. Share your notes and it explains them through what you love ("meiosis is like picking two new cricket teams"). It quizzes you out loud, grades what you actually said, and remembers exactly what you got wrong. Overnight it works ahead on its own, and in the morning it says, *"While you were away, I made a study set for your biology test. Last time you mixed up interphase with prophase, so let's start there."*

*Vidya* is Sanskrit for "knowledge". Built for the **Alexa+ track** of *Build, Ship, Shape: Amazon Developer Hackathon 2026*.

| | |
|---|---|
| **MCP server** | Self-hosted, MCP spec **2025-11-25** over **Streamable HTTP**: 41 tools with structured output and level-aware speech, an **MCP Apps** card UI (39 tools render cards), **sampling**, **elicitation** (forms, confirmations, secure sign-in pages), **resource subscriptions** (live games across homes), resource templates and prompts. Hosted on AWS ([guide](docs/DEPLOY_AWS.md)). |
| **Agent Skills** | [`study-mentor`](skills/study-mentor/SKILL.md) and [`bedtime-storyteller`](skills/bedtime-storyteller/SKILL.md), in the open Agent Skills format and loaded at runtime |
| **Alexa+ simulator** | An Echo Show-style web app that is a real MCP client: wake word, barge-in, follow-up listening, notes sharing (PDF, text, Markdown), MCP Apps rendering, and a live JSON-RPC traffic panel |
| **AI on AWS** | **Amazon Nova 2 Lite** on **Amazon Bedrock** (Converse API, so any Bedrock model works by changing `BUDDY_MODEL`), **Nova Web Grounding** for research with sources, and **Amazon Polly** generative voices. Claude via the Anthropic API is an optional alternative. |

---

## Why

Students don't lack information. They lack a patient mentor who knows them. Self-testing (*retrieval practice*) and *spaced repetition* beat rereading, but they're hard to do alone, and the phone that holds your flashcards also holds the reels. A voice mentor in the room changes that:

- **Personal at every level.** Vocabulary, depth, examples and session length come from the learner's class or age.
- **Memory that matters.** Interests, explanation styles that clicked, specific mistakes, exam dates and the review schedule, across sessions.
- **It learns from you.** "Call me Pri", "that's too long", "these are too easy": Vidya saves the lesson from the learner's own words and follows it in the same reply. It never invents a correction nobody asked for.
- **Agentic, not just reactive.** A daily routine syncs school, builds study sets for upcoming tests, researches topics beyond the notes, and plans the day, then briefs the learner in the morning.
- **Beyond the notes.** "Tell me more" searches the web (Nova Web Grounding) and explains what it found at the learner's level, with sources.
- **Active, not passive.** Spoken quizzes graded strictly on what was said, fresh questions on request, flashcards, and **teach-back**.
- **Talks like a person.** Answer a quiz question before it finishes reading the options. Interrupt ("wait, not entropy, I meant enthalpy") and it carries on in context. "What?" repeats the question.
- **Study Together.** A quiz battle with siblings, or with a friend in another home through a spoken invite code.
- **Family mode.** "Tell Leo a story about why stealing is wrong, he loves dinosaurs" becomes a gentle story with a question to ask afterwards.

## Built for kids: parents in control, safety goes to a human

An AI shouldn't be a child's secret-keeper. Vidya is designed around that.

| Age | What parents can see | Serious concerns |
|---|---|---|
| **Under 13** | **Everything:** conversations, what the child shared, progress (designed with COPPA principles in mind) | Alert to the parent immediately |
| **13 to 17** | Progress plus a **summary** of topics and mood; the parent can switch to full history | **Always** sent to the parent |
| **18+** | Private | Encouraged to reach out to someone they trust, with crisis lines when needed |

- **No secrets.** Children are told plainly what their parent can see. It never says "this stays between us".
- **Safety always reaches a person.** Self-harm, abuse, secrets, strangers, running away, bullying and deep sadness are caught by a deterministic check on every turn *before* the AI runs, so safety never depends on the model. The child gets a warm, honest reply; a linked parent gets an alert at the top of their view.
- **Age isn't taken on trust.** When a learner connects Google Classroom, Vidya checks the age Google reports (age range, birthday, and the grade in their class names). A 13-year-old who says "I'm 18" can't connect school alone: a parent has to, and nothing is kept.
- **Home and school, read-only.** Google Classroom sync: tests become exams in the plan, teacher notes become study sets, "what homework do I have?" just works. It never submits or edits anything, and disconnecting deletes the synced data.
- **Safe deletes.** "Delete my study plan" removes study sets only, after a clear confirmation. Deleting a whole profile needs those exact words.
- **Online games are invite-only.** Short codes, no lobby of strangers, first names and scores only. Under 13, a parent switches it on first.

### What the judges asked for, and where it lives

| "Creative" signal from the rules | In Vidya |
|---|---|
| Context across sessions | Learner memory, lessons learned, misconceptions, exam-aware spaced review ([`mentor.ts`](packages/mcp-server/src/domain/mentor.ts), [`srs.ts`](packages/mcp-server/src/domain/srs.ts)) |
| Agentic workflow across services | The daily routine: Google Classroom sync → study sets for upcoming tests → web research (Nova Web Grounding) → a plan for the day → a morning briefing |
| Media (cards, carousels) and MCP Apps | One `ui://study-buddy/card.html` view (`text/html;profile=mcp-app`): swipeable topic, research and briefing carousels, flip flashcards, answer tiles, a mastery map, an exam countdown, a focus timer, a storybook |
| Agent Skills | Two skills: the teaching playbook and tone, plus guardrails for academic honesty, wellbeing and child safety |
| Deep MCP use | **Sampling** (generation on the client's model), **elicitation** (forms, confirmations, URL sign-in pages for Google Classroom), **resource subscriptions** (live cross-home games), resource templates, prompts, tool annotations, icons |

---

## Try it

**Hosted (no setup):** a live instance runs on Amazon Lightsail. The link and login are in the Devpost testing instructions.

**Locally** (Node 20+). Vidya uses live AI only, with no pre-made content, so it needs AWS credentials with access to Amazon Nova on Bedrock (region `us-east-1`) and Amazon Polly:

```bash
npm install
aws configure                 # or AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
BUDDY_TTS=polly npm run dev   # MCP server on :8787, device on :5173
open http://localhost:5173    # Chrome or Edge, allow the microphone
```

Settings can also live in a `.env` file (see [`.env.example`](.env.example)). Optional:

```bash
GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=...   # live Google Classroom sync (read-only)
BUDDY_GEN_MODEL=us.amazon.nova-pro-v1:0         # a larger model for study sets and grading
ANTHROPIC_API_KEY=...                           # Claude via the Anthropic API instead of Bedrock
```

Without any AI credentials the device says that an AI connection is required. Nothing is faked.

### Things to say

1. "Alexa, I'm Priya, 10th grade, I love cricket. I have a bio test on Friday."
2. **Share notes** (a PDF or text file), then "What's the first thing I should know?" Then "huh?" and "simpler please".
3. "Quiz me." Answer one wrong, and try answering before it finishes reading the options. Then "these are too easy".
4. "Call me Pri from now on."
5. **Pretend it's tomorrow** (side panel), then "Good morning". It tells you what it did overnight and starts with yesterday's mistake.
6. "Tell me more about this", for research beyond your notes, with sources.
7. "Connect my school", then "What homework do I have?"
8. **Another home:** open a second tab at `http://localhost:5173/?home=rao`. There, "I'm Asha, Leo's mom. He's 6 and loves dinosaurs", "Allow online games for Leo", "Hi, I'm Leo". In Priya's tab, "Let's play an online quiz battle with my friend"; in Leo's, "join game" plus the code.
9. As Leo, "Nobody at school wants to play with me". Then, "I'm Asha, Leo's mom. How is Leo doing?"

**Controls:** say "Alexa" (wake word), or hold the mic button or **space bar**. "Stop" or "wait" interrupts. Card buttons reply for you. **D** hides the developer panel. **Reset everything** clears all memory.

---

## Use it from other MCP clients

```bash
npm run start:mcp
npx @modelcontextprotocol/inspector     # Streamable HTTP, URL: http://localhost:8787/mcp

# Claude Code, plus the skills
claude mcp add --transport http vidya http://localhost:8787/mcp
cp -r skills/study-mentor skills/bedtime-storyteller ~/.claude/skills/

# A hosted server
claude mcp add --transport http vidya https://mcp.<your-host>/mcp --header "Authorization: Bearer <token>"
```

## Architecture

```
┌──────────────────────────── apps/simulator (Alexa+ experience) ────────────────────────────┐
│  Browser: Echo Show-style display · wake word, barge-in, echo guard · MCP Apps host · trace │
│  Node:  Session ─ safety check ─ VoiceAgent ─┬─ BedrockAgent (Amazon Nova, Converse API)   │
│                                              └─ ClaudeAgent  (alternative: Anthropic API)  │
│         Both answer the server's MCP sampling requests. Amazon Polly for speech.           │
│         McpConnection: MCP client · Streamable HTTP · elicitation + sampling handlers       │
└─────────────────────────────────────────┬──────────────────────────────────────────────────┘
                                          │  MCP 2025-11-25 · Streamable HTTP · sessions
┌─────────────────────────────────────────▼──────────── packages/mcp-server ─────────────────┐
│  41 tools (structuredContent + level-aware "speech") · MCP Apps card · resources · prompts  │
│  Mentor: profiles, memory, lessons · decks · quizzes · grading · teach-back · plans         │
│  Daily routine: school sync → study sets → research → plan → morning briefing               │
│  Research: Nova Web Grounding with citations · School: Google Classroom + age check         │
│  Homes: one memory per household · GameHub: invite-code games, live via resource updates   │
│  Store: durable household memory (one JSON file per home)                                   │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

Key files:

- [`server.ts`](packages/mcp-server/src/server.ts): the MCP surface
- [`mentor.ts`](packages/mcp-server/src/domain/mentor.ts): learning logic, memory, lessons, the daily routine
- [`generate.ts`](packages/mcp-server/src/domain/generate.ts) and [`bedrock.ts`](packages/mcp-server/src/domain/bedrock.ts): prompts, Nova, web grounding
- [`school.ts`](packages/mcp-server/src/domain/school.ts) and [`age.ts`](packages/mcp-server/src/domain/age.ts): Google Classroom and the age check
- [`safety.ts`](packages/mcp-server/src/domain/safety.ts): child safety
- [`card.html`](packages/mcp-server/src/ui/card.html): the MCP App view
- [`session.ts`](apps/simulator/src/session.ts) and [`agent-bedrock.ts`](apps/simulator/src/agent-bedrock.ts): the device's brain
- [`app.js`](apps/simulator/public/app.js): the device UI, the ear (wake word, barge-in, echo guard) and the host bridge

## Tests

```bash
npm test
```

77 tests (64 server, 13 simulator), with scripted stand-ins for the model so no AWS calls are made. Highlights:

- **The memory loop:** a mistake today comes back first tomorrow; getting it right resolves it.
- **Learning from corrections:** saved only from the learner's own words, applied in the same reply, never invented from "stop".
- **Conversation:** "huh?" gets a new angle; "what?" repeats the question; answers are graded on the learner's words; exam dates from "Friday" or "next Tuesday"; topics matched by title, not by a passing mention.
- **The daily routine:** study sets for upcoming tests, research beyond the notes, a plan, a briefing said once.
- **Quizzes:** no repeats across quizzes, fresh questions written in parallel, strict grading.
- **Safety and parents:** caring replies instead of grading, alerts to a linked parent, age-based visibility, safe deletes.
- **School sync and the age check:** "I'm 18" with a grade-7 account needs a parent; teens and adults connect as usual.
- **Study Together across homes:** invite codes, turn order, live updates through resource subscriptions, two simulated devices over real HTTP.
- **MCP:** sampling, elicitation, MCP Apps metadata, resources, prompts, and a real Streamable HTTP handshake on `2025-11-25`.
- **Amazon Nova on Bedrock:** the Converse tool loop, web-grounding citations, guardrail refusals and recovery from failed turns, against a fake Bedrock client.

## Notes

- Learner data stays in one JSON file per household. "Forget that", "delete my study set" and "delete everything" (with confirmation) are built in.
- Hosting: one Lightsail server with Docker and automatic HTTPS ([docs/DEPLOY_AWS.md](docs/DEPLOY_AWS.md)). `deploy/update.sh` ships a new version; `deploy/set-login.sh` changes the device login.
- The real Alexa+ developer tooling is preview-only for select partners. This repo follows the hackathon's sanctioned path: a self-hosted MCP server plus Agent Skills, shown through a simulated Alexa+ device that is a real MCP client.
- `/admin/*` endpoints only drive the demo clock and need the access token. Disable them with `BUDDY_ADMIN=off`.
- Test notes are original. People named in examples are fictional.

## License

[MIT](LICENSE)
