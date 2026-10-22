# Vidya

**A personal study mentor on Alexa+ that remembers how you learn.** Tell it who you are, from a 7-year-old to a second-year engineering student, and it teaches at your level, using examples from your world. Share your notes, and it explains them through what you love ("meiosis is like picking two new cricket teams for a charity match"). It quizzes you out loud and remembers exactly what you got wrong. The next day it says, *"Last time you mixed up interphase with prophase, so let's start there."* Family mode turns a value a parent wants to teach into a bedtime story.

Built for the **Alexa+ track** of *Build, Ship, Shape: Amazon Developer Hackathon 2026*. *Vidya* is a working name; it's set in one place (`BUDDY_BRAND`).

| | |
|---|---|
| **MCP server** | Self-hosted, MCP spec **2025-11-25** over **Streamable HTTP**: 35 tools with structured output, an **MCP Apps** card UI, **sampling** (generation on the client's model), **elicitation** (setup form, confirmations, secure sign-in pages), **resource subscriptions** (live games across homes), resources and prompts. Ready to host on AWS ([guide](docs/DEPLOY_AWS.md)) |
| **Agent Skills** | [`study-mentor`](skills/study-mentor/SKILL.md) and [`bedtime-storyteller`](skills/bedtime-storyteller/SKILL.md), in the open Agent Skills format and loaded at runtime |
| **Alexa+ simulator** | A smart-display web app that is a real MCP client, with voice in and out, notes sharing (PDF, text, Markdown), MCP Apps rendering, and a live JSON-RPC traffic panel |
| **Brain** | **Amazon Nova** (Nova 2 Lite by default) on **Amazon Bedrock** through the Converse API, so any Bedrock model works by changing `BUDDY_MODEL`. Voice by **Amazon Polly**. Claude via the Anthropic API is an alternative, and an offline mode with prepared content needs no key. |

---

## Why

Students don't lack information. They lack a patient mentor who knows them. The research is clear: self-testing (*retrieval practice*) and *spaced repetition* beat rereading. They're hard to do alone, though, and the phone that holds your flashcards also holds the reels. A voice mentor in the room changes that:

- **Personal at every level.** Vocabulary, depth, examples and session length all come from the learner's class or age. Nothing is hard-coded per user.
- **Memory that matters.** It remembers interests, which explanation styles clicked, specific mistakes, exam dates and the review schedule, across sessions.
- **Active, not passive.** Spoken quizzes graded by meaning, flashcards, and **teach-back**, where you explain the concept and it checks your explanation against your own notes.
- **Less screen time.** Phone-down focus sessions end with a quick quiz.
- **Study Together.** A quiz battle with siblings in the same room, or with a friend in another home through a spoken invite code ("join game Tiger 4 2"). Every player gets questions at their own level.
- **Accessible.** Voice-first learning helps students with dyslexia or low vision. The cards use Atkinson Hyperlegible, a typeface designed for low-vision readers.
- **Family mode.** "Tell Leo a story about why stealing is wrong, he loves dinosaurs" becomes a gentle story with a question to ask afterwards.

## Built for kids: parents in control, safety goes to a human

An AI shouldn't be a child's secret-keeper, or the one they lean on when something is seriously wrong. Vidya is designed around that.

| Age | What parents can see | Serious concerns |
|---|---|---|
| **Under 13** | **Everything:** every conversation, what the child shared, and progress (designed with COPPA principles in mind: parents of under-13s can review their child's data) | Alert to the parent immediately |
| **13 to 17** | Progress plus a **summary** of topics and mood by default; the parent can switch to **full history** with one setting | **Always** sent to the parent, whatever the setting |
| **18+** | Private | Encouraged to reach out to someone they trust, with crisis lines when needed |

- **No secrets.** Children are told plainly what their parent can see ("Your mom can see what we talk about, so she can help too"). It never says "this stays between us". If a parent changes the setting, the child is told next time.
- **Safety always reaches a person.** Self-harm, abuse, being asked to keep secrets, a stranger or someone online, running away, bullying and deep sadness are all detected:
  - by a deterministic check on the server, so it works with no AI connected
  - by the AI, through `flag_concern`
  - on every turn the device logs (`record_turn`)

  The child gets a warm, honest reply ("it's not your fault; I'm letting your mom know"). Young children are pointed to a grown-up nearby; older ones also get 988 (call or text). The parent gets an alert, and the concern sits **at the top** of their view, most serious first, with the child's own words.
- **Checked before acting.** A worrying "quiz answer" is never graded. The server checks the child's words before any tool acts on them.
- **Parents stay in control.** They can see a child's history, switch between full and summary, add notes, or delete the history at any time.
- **Home and school, connected (read-only).** Connect Google Classroom through a secure page (URL elicitation; a parent connects under 13). Teachers' tests show up in the study plan, teacher notes become personalized study sets, and "what homework do I have?" just works. It never submits or edits anything, and disconnecting deletes the synced data.
- **Online games are invite-only.** Study Together across homes uses a short code, with no lobby of strangers. Other homes only see first names, scores and right or wrong, never what anyone said. Under 13, a parent switches it on first ("allow online games for Leo"). Each player's own home records the game, so parents see it in the history.
- **Parent-led onboarding.** A parent can set up their child, so the child is never interrogated. The first time the child talks, they're greeted with what the parent shared and asked something fun ("What's your favourite dinosaur?") to start a real relationship.

### What the judges asked for, and where it lives

| "Creative" signal from the rules | In Vidya |
|---|---|
| Keeps context across sessions | Learner memory, misconceptions, exam-aware spaced review ([`mentor.ts`](packages/mcp-server/src/domain/mentor.ts), [`srs.ts`](packages/mcp-server/src/domain/srs.ts)) |
| Agentic workflow across services | Notes become a study set, then explanations, quizzes and grading, then the mastery map and an exam plan, then the next day's review |
| Media (cards, carousels) and MCP Apps | One `ui://study-buddy/card.html` view (`text/html;profile=mcp-app`). Cards include index-card flashcards with flip, multiple-choice answer tiles, a mastery map, the exam countdown, a teach-back checklist, a self-running focus timer, and a storybook. |
| Agent Skills | Two skills: teaching playbook and tone, plus guardrails for academic honesty, wellbeing and child safety |
| Responsible AI for families | Age-based parent visibility, no secrets, safety concerns always routed to a parent ([`safety.ts`](packages/mcp-server/src/domain/safety.ts)) |
| Deep MCP use | **Sampling** lets the server generate on the client's own model, with no server key. **Elicitation** handles onboarding forms and delete confirmations. Plus resource templates, prompts, tool annotations and icons. |

---

## Quick start

Requires Node 20+.

```bash
npm install
npm run dev          # MCP server on :8787 and simulator on :5173
open http://localhost:5173
```

That runs in **offline mode**, with prepared content for the bundled biology notes ([`content/cell-division.md`](packages/mcp-server/content/cell-division.md)) and heuristic grading. To use a real model, which handles any notes and any topic, grades by meaning, and writes original stories:

```bash
npm run dev                                                  # with AWS credentials: Amazon Nova on Bedrock (default)
BUDDY_GEN_MODEL=us.amazon.nova-pro-v1:0 npm run dev          # optional: a larger model for study sets and grading
BUDDY_TTS=polly npm run dev                                  # + natural device voice (Amazon Polly)
ANTHROPIC_API_KEY=sk-ant-... npm run dev                     # no AWS? Claude via the Anthropic API instead
GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... npm run dev    # real Google Classroom sync (otherwise a sample class)
```

With a model configured, the simulator also answers the server's **MCP sampling** requests, so the server itself needs no key.

### Try this story

1. "Help me study."
2. "Hi, I'm Priya. I'm in 10th grade and I love cricket and cooking. My biology test is in 5 days."
3. Tap **Use the sample biology notes**, or **Share notes** to pick a PDF or text file of your own.
4. "Explain meiosis." Then "Explain it differently."
5. "Quiz me." Answer one wrong on purpose, then "hint", then "stop".
6. **Skip ahead a day**, then "Good morning." It remembers the mistake.
7. "Let me teach meiosis back to you", then explain it in your own words.
8. "What's my study plan?", "Help me focus for 25 minutes", "What do you know about me?"
9. **Study Together across homes:** open a second tab at `http://localhost:5173/?home=rao`. Each `home` is a separate household. There, say "I'm Asha, Leo's mom. He's 6 and loves dinosaurs", then "Allow online games for Leo", then "Hi, I'm Leo". In Priya's tab, say "Let's play an online quiz battle with my friend". In Leo's tab, say "join game" plus the code on Priya's screen. Then, in Priya's tab, say "start the game". Each device announces whose turn it is.
10. "Tell Leo a bedtime story about why stealing is wrong. He's 6 and loves dinosaurs."

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

# A hosted server (docs/DEPLOY_AWS.md)
claude mcp add --transport http study-buddy https://mcp.<your-domain>/mcp --header "Authorization: Bearer <token>"
```

## Architecture

```
┌──────────────────────────── apps/simulator (Alexa+ experience) ────────────────────────────┐
│  Browser: smart display · Web Speech in/out · notes sharing · MCP Apps host bridge · trace  │
│  Node:  Session ─ VoiceAgent ─┬─ BedrockAgent  (Amazon Nova, Converse API; skills as system)│
│                               ├─ ClaudeAgent   (alternative: Anthropic API)                │
│                               │      also answers MCP sampling for the server               │
│                               └─ OfflineAgent  (scripted router, no key)                    │
│         McpConnection: MCP client · Streamable HTTP · elicitation + sampling handlers       │
└─────────────────────────────────────────┬──────────────────────────────────────────────────┘
                                          │  MCP 2025-11-25 · Streamable HTTP · sessions
┌─────────────────────────────────────────▼──────────── packages/mcp-server ─────────────────┐
│  35 tools (structuredContent + level-aware "speech") · MCP Apps card · resources · prompts  │
│  Homes: one memory per household · GameHub: invite-code games, live via resource updates   │
│  Mentor: profiles & memory · levels → voice guide · decks · quizzes · teach-back · plans    │
│  Generation: sampling → server's own model (Nova on Bedrock) → offline (prepared content)   │
│  Memory engine: exam-aware spaced repetition · misconceptions · styles that worked          │
│  Store: durable household memory (.data/, one folder per home)                              │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

Key files:

- [`server.ts`](packages/mcp-server/src/server.ts): the MCP surface
- [`mentor.ts`](packages/mcp-server/src/domain/mentor.ts): learning logic
- [`games.ts`](packages/mcp-server/src/domain/games.ts) and [`homes.ts`](packages/mcp-server/src/homes.ts): Study Together across homes
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

There are 42 tests:

- **Level mapping:** kindergarten through university and adult learners.
- **The memory loop:** a mistake today comes back first tomorrow, and getting it right resolves it.
- **Style learning:** it notices which explanation style worked.
- **Memory and privacy:** remember, forget, and delete-everything with confirmation.
- **Parent mode:** parent-led setup, then the child is greeted and asked a fun question.
- **Age-based visibility:** full under 13; summary for teens, switchable to full, with the teen told.
- **Child safety:** worrying words get a caring reply instead of grading, go to the parent, and show first, most serious first. Figures of speech ("I killed that quiz") aren't flagged, and adults aren't reported.
- **Moods:** tired means a shorter session.
- **School sync:** connect, tests become exams, notes become study sets, homework, under-13 parent rule, disconnect deletes data.
- **Study Together:** level-matched questions per player, streak scoring, guests aren't saved.
- **Study Together across homes:** spoken invite codes, parent permission under 13, turn order, live updates through resource subscriptions, other homes never see a player's words, each home logs its own result. Plus two simulated devices playing over real HTTP.
- **Teach-back** grading.
- **MCP sampling:** deck, explanation and grading, all generated on the client's model.
- **Elicitation:** onboarding through the setup form.
- **Bedtime stories.**
- **MCP Apps** metadata, resources and prompts.
- **Exam-aware scheduling.**
- **A real Streamable HTTP handshake**, asserting protocol `2025-11-25`.
- **A full spoken end-to-end story** through the simulator.
- **Amazon Nova on Bedrock:** the Converse tool loop, sampling, guardrail refusals and recovery from failed turns, against a fake Bedrock client (no AWS calls in tests).
- **Safety that doesn't depend on the model:** a worried child is protected even when the assistant never said who's talking, an age that doesn't fit the class is ignored, and no parent alert is claimed when none is linked.

## Notes

- Learner data stays in a JSON file per household. "Forget that" and "delete everything" are built in.
- Hosting: one small Lightsail or EC2 server with Docker and automatic HTTPS. See [docs/DEPLOY_AWS.md](docs/DEPLOY_AWS.md).
- The real Alexa+ developer tooling is preview-only for select partners. This repo follows the hackathon's sanctioned path: a self-hosted MCP server plus Agent Skills, demonstrated through a simulated Alexa+ experience that is a real MCP client.
- `/admin/*` endpoints only drive the demo clock. Disable them with `BUDDY_ADMIN=off`.
- The sample notes are original. People named in the demo are fictional.

## License

[MIT](LICENSE)
