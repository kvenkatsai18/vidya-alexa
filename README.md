# Study Buddy

**A personal study mentor on Alexa+ that remembers how you learn.** Tell it who you are, from a 7-year-old to a second-year engineering student, and it teaches at your level, using examples from your world. Share your notes, and it explains them through what you love ("meiosis is like picking two new cricket teams for a charity match"). It quizzes you out loud and remembers exactly what you got wrong. The next day it says, *"Last time you mixed up interphase with prophase, so let's start there."* Family mode turns a value a parent wants to teach into a bedtime story.

Built for the **Alexa+ track** of *Build, Ship, Shape: Amazon Developer Hackathon 2026*. *Study Buddy* is a working name; it's set in one place (`BUDDY_BRAND`).

| | |
|---|---|
| **MCP server** | Self-hosted, MCP spec **2025-11-25** over **Streamable HTTP**: 17 tools with structured output, an **MCP Apps** card UI, **sampling** (generation on the client's model), **elicitation** (setup form, confirmations), resources and prompts |
| **Agent Skills** | [`study-mentor`](skills/study-mentor/SKILL.md) and [`bedtime-storyteller`](skills/bedtime-storyteller/SKILL.md), in the open Agent Skills format and loaded at runtime |
| **Alexa+ simulator** | A smart-display web app that is a real MCP client, with voice in and out, notes sharing (PDF, text, Markdown), MCP Apps rendering, and a live JSON-RPC traffic panel |
| **Brain** | Claude (`claude-opus-5-5`) via the Anthropic API **or Amazon Bedrock**, plus an offline mode with prepared content that needs no key |

---

## Why

Students don't lack information. They lack a patient mentor who knows them. The research is clear: self-testing (*retrieval practice*) and *spaced repetition* beat rereading. They're hard to do alone, though, and the phone that holds your flashcards also holds the reels. A voice mentor in the room changes that:

- **Personal at every level.** Vocabulary, depth, examples and session length all come from the learner's class or age. Nothing is hard-coded per user.
- **Memory that matters.** It remembers interests, which explanation styles clicked, specific mistakes, exam dates and the review schedule, across sessions.
- **Active, not passive.** Spoken quizzes graded by meaning, flashcards, and **teach-back**, where you explain the concept and it checks your explanation against your own notes.
- **Less screen time.** Phone-down focus sessions end with a quick quiz.
- **Accessible.** Voice-first learning helps students with dyslexia or low vision. The cards use Atkinson Hyperlegible, a typeface designed for low-vision readers.
- **Family mode.** "Tell Leo a story about why stealing is wrong, he loves dinosaurs" becomes a gentle story with a question to ask afterwards.
- **Parent story voices.** A parent who works nights or travels can record their voice once, so bedtime stories, and goodnight notes they write, play in "Mom's voice". It's consent-first: the parent reads a consent sentence aloud on a secure page opened through MCP URL elicitation. It's also narrow: the voice can only read stories and the parent's exact words, never chat as the parent. Everything is labelled as AI, and it can be paused or deleted any time.

### What the judges asked for, and where it lives

| "Creative" signal from the rules | In Study Buddy |
|---|---|
| Keeps context across sessions | Learner memory, misconceptions, exam-aware spaced review ([`mentor.ts`](packages/mcp-server/src/domain/mentor.ts), [`srs.ts`](packages/mcp-server/src/domain/srs.ts)) |
| Agentic workflow across services | Notes become a study set, then explanations, quizzes and grading, then the mastery map and an exam plan, then the next day's review |
| Media (cards, carousels) and MCP Apps | One `ui://study-buddy/card.html` view (`text/html;profile=mcp-app`). Cards include index-card flashcards with flip, multiple-choice answer tiles, a mastery map, the exam countdown, a teach-back checklist, a self-running focus timer, and a storybook. |
| Agent Skills | Two skills: teaching playbook and tone, plus guardrails for academic honesty, wellbeing and child safety |
| Deep MCP use | **Sampling** lets the server generate on the client's own model, with no server key. **Elicitation** handles onboarding forms and delete confirmations. Plus resource templates, prompts, tool annotations and icons. |

---

## Quick start

Requires Node 20+.

```bash
npm install
npm run dev          # MCP server on :8787 and simulator on :5173
open http://localhost:5173
```

That runs in **offline mode**, with prepared content for the bundled biology notes ([`content/cell-division.md`](packages/mcp-server/content/cell-division.md)) and heuristic grading. To use Claude, which handles any notes and any topic, grades by meaning, and writes original stories:

```bash
ANTHROPIC_API_KEY=sk-ant-... npm run dev                     # Anthropic API
BUDDY_TTS=polly npm run dev                                  # natural device voice (Amazon Polly, AWS creds)
ELEVENLABS_API_KEY=... npm run dev                           # real parent story voices (otherwise free test mode)
BUDDY_LLM=bedrock AWS_REGION=us-east-1 npm run dev           # Amazon Bedrock
```

With Claude configured, the simulator also answers the server's **MCP sampling** requests, so the server itself needs no key.

### Try this story

1. "Help me study."
2. "Hi, I'm Priya. I'm in 10th grade and I love cricket and cooking. My biology test is in 5 days."
3. Tap **Use the sample biology notes**, or **Share notes** to pick a PDF or text file of your own.
4. "Explain meiosis." Then "Explain it differently."
5. "Quiz me." Answer one wrong on purpose, then "hint", then "stop".
6. **Skip ahead a day**, then "Good morning." It remembers the mistake.
7. "Let me teach meiosis back to you", then explain it in your own words.
8. "What's my study plan?", "Help me focus for 25 minutes", "What do you know about me?"
9. "Tell Leo a bedtime story about why stealing is wrong. He's 6 and loves dinosaurs."

**Controls:**
- Hold the mic button or the **space bar** to talk (Chrome or Edge).
- Card buttons reply on your behalf.
- Press **D** to hide the developer panel.
- **Reset everything** clears all memory.

---

## Use it from other MCP clients

```bash
npm run start:mcp
npx @modelcontextprotocol/inspector     # Streamable HTTP, URL: http://localhost:8787/mcp

# Claude Code, plus the skills
claude mcp add --transport http study-buddy http://localhost:8787/mcp
cp -r skills/study-mentor skills/bedtime-storyteller ~/.claude/skills/
```

## Architecture

```
┌──────────────────────────── apps/simulator (Alexa+ experience) ────────────────────────────┐
│  Browser: smart display · Web Speech in/out · notes sharing · MCP Apps host bridge · trace  │
│  Node:  Session ─ VoiceAgent ─┬─ ClaudeAgent   (Anthropic API / Bedrock; skills as system)  │
│                               │      also answers MCP sampling for the server               │
│                               └─ OfflineAgent  (scripted router, no key)                    │
│         McpConnection: MCP client · Streamable HTTP · elicitation + sampling handlers       │
└─────────────────────────────────────────┬──────────────────────────────────────────────────┘
                                          │  MCP 2025-11-25 · Streamable HTTP · sessions
┌─────────────────────────────────────────▼──────────── packages/mcp-server ─────────────────┐
│  17 tools (structuredContent + level-aware "speech") · MCP Apps card · resources · prompts  │
│  Mentor: profiles & memory · levels → voice guide · decks · quizzes · teach-back · plans    │
│  Generation: sampling → server's own Claude → offline (prepared deck + heuristics)          │
│  Memory engine: exam-aware spaced repetition · misconceptions · styles that worked          │
│  Store: durable household memory (.data/study-buddy-state.json)                             │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

Key files:

- [`server.ts`](packages/mcp-server/src/server.ts): the MCP surface
- [`mentor.ts`](packages/mcp-server/src/domain/mentor.ts): learning logic
- [`levels.ts`](packages/mcp-server/src/domain/levels.ts): personalization by level
- [`generate.ts`](packages/mcp-server/src/domain/generate.ts): prompts and offline fallbacks
- [`llm.ts`](packages/mcp-server/src/domain/llm.ts): sampling and direct model access
- [`card.html`](packages/mcp-server/src/ui/card.html): the MCP App view
- [`mcp-client.ts`](apps/simulator/src/mcp-client.ts): the simulator's MCP client
- [`app.js`](apps/simulator/public/app.js): the device UI and host bridge

## Tests

```bash
npm test
```

There are 15 tests:

- **Level mapping:** kindergarten through university and adult learners.
- **The memory loop:** a mistake today comes back first tomorrow, and getting it right resolves it.
- **Style learning:** it notices which explanation style worked.
- **Memory and privacy:** remember, forget, and delete-everything with confirmation.
- **Teach-back** grading.
- **MCP sampling:** deck, explanation and grading, all generated on the client's model.
- **Elicitation:** onboarding through the setup form.
- **Bedtime stories.**
- **MCP Apps** metadata, resources and prompts.
- **Exam-aware scheduling.**
- **A real Streamable HTTP handshake**, asserting protocol `2025-11-25`.
- **A full spoken end-to-end story** through the simulator.

## Notes

- Learner data stays in a local JSON file. "Forget that" and "delete everything" are built in.
- The real Alexa+ developer tooling is preview-only for select partners. This repo follows the hackathon's sanctioned path: a self-hosted MCP server plus Agent Skills, demonstrated through a simulated Alexa+ experience that is a real MCP client.
- `/admin/*` endpoints only drive the demo clock. Disable them with `BUDDY_ADMIN=off`.
- The sample notes are original. People named in the demo are fictional.

## License

[MIT](LICENSE)
