# Study Buddy tool guide

Every tool returns `structuredContent` with a `kind` (the card it renders) and a voice-ready `speech` string. Tools marked 🖼 render the MCP App card `ui://study-buddy/card.html`.

| Tool | Args | Result `kind` |
|---|---|---|
| 🖼 `get_today` | none | `welcome` (no learner yet), `meet` (a parent-added child talking for the first time; ask its `question`), or `today` (streak, exam countdown, due count, weak spot, `suggestion`, `voiceGuide`) |
| 🖼 `set_up_learner` | `name`, `level`, `age`, `subjects`, `interests`, `exam_title`, `exam_subject`, `exam_date` or `exam_in_days`, `use_form` | `profile` |
| 🖼 `switch_learner` | `name` | `today` |
| 🖼 `learn_from_feedback` | `lesson`, `kind` (name, style, teaching, grading, other), `preferred_name` | `lesson_learned` (applied to every future session and generated explanation) |
| 🖼 `recheck_answer` | `reason` | `recheck` (`overturned`: fixes the score and saves a grading lesson) |
| `remember` | `fact`, `kind` (preference, struggle, strength, personal, goal, mood) | `memory_saved` |
| 🖼 `parent_setup` | `parent_name`, `relation`, `child`, `age`, `level`, `interests`, `subjects`, `notes`, exam fields | `parent_saved` |
| 🖼 `parent_note` | `child`, `note`, `parent_name` | `parent_saved` |
| 🖼 `parent_overview` | `child` | `parent_overview`: safety concerns first, progress, then recent chats (full) or a summary (teens) |
| 🖼 `parent_history` | `child`, `days` | `parent_history` (full visibility only) |
| 🖼 `parent_settings` | `child`, `visibility` (full or summary), `clear_history`, `online_games` (allowed or off) | `parent_settings` |
| 🖼 `flag_concern` | `category` (self_harm, abuse, bullying, danger, distress), `severity`, `summary`, `excerpt` | `concern_flagged` (caring reply; parent alerted) |
| `record_turn` | `heard`, `said` | `turn_recorded` (hosts call this every turn; it also checks for concerns) |
| 🖼 `connect_school` | `learner`, `parent_name` (required under 13) | `school_connect` (URL elicitation to the sign-in page) |
| 🖼 `sync_school` | `learner` | `school_synced` (tests become exams; teacher notes become study sets) |
| 🖼 `school_homework` | `learner`, `days` | `school_homework` (upcoming, past due, turned in) |
| 🖼 `disconnect_school` | `learner` | `school_disconnected` |
| 🖼 `get_profile` | none | `profile` (memories told and observed) |
| `forget` | `memory_id`, `text`, or `everything` | `forgotten` or `cancelled` |
| 🖼 `add_material` | `title`, `text` | `deck` |
| 🖼 `prepare_my_day` | none | `briefing` (`did`: what the routine did on its own; `today`: the plan). It also runs every morning by itself, and `get_today` includes `briefing`. |
| 🖼 `research_topic` | `topic` (defaults to the latest study set) | `research` (swipeable `cards` with personalized examples, `sources` with links; saved with the study set) |
| 🖼 `add_topic` | `topic` | `deck` |
| 🖼 `explain_concept` | `concept`, `style` | `explanation` |
| 🖼 `start_quiz` | `topic`, `mode` (quiz or flashcards), `count` | `quiz_question` |
| 🖼 `answer_question` | `answer` | `quiz_question` (with `feedback`) or `quiz_summary` |
| 🖼 `quiz_action` | `action` (hint, skip, repeat, flip, end) | `quiz_question` or `quiz_summary` |
| 🖼 `teach_back` | `action` (start or submit), `concept`, `explanation` | `teach_back` (`phase`: listening or result) |
| 🖼 `get_study_plan` | `exam` | `study_plan` (mastery map and day-by-day plan) |
| 🖼 `summarize` | `topic` | `summary` |
| 🖼 `focus_session` | `action` (start or end), `minutes`, `topic` | `focus` |
| 🖼 `start_group_quiz` | `players`, `topic`, `turns_each` | `group_question` (same device; guests aren't saved) |
| 🖼 `group_answer` | `answer` | `group_question` (with `feedback`) or `group_summary` |
| 🖼 `group_action` | `action` (hint, skip, scores, repeat, end) | `group_question` or `group_summary` |
| 🖼 `start_online_game` | `topic`, `turns_each` | `online_game` (`status: "lobby"`, a `code` and `spokenCode` to share, a `gameUri` to subscribe to) |
| 🖼 `join_online_game` | `code` ("tiger 4 2" works) | `online_game` |
| 🖼 `online_game_answer` | `answer` (only on this home's turn) | `online_game` (with `feedback`) |
| 🖼 `online_game_action` | `action` (start, status, hint, skip, leave, end) | `online_game` |
| 🖼 `tell_story` | `child`, `lesson`, `age`, `interests`, `minutes` | `story` |

How content gets generated: the server uses **MCP sampling** (the client's own model) when the client supports it, then the server's own model if one is configured, and otherwise prepared content and heuristics.

Resources: `study-buddy://decks/{deckId}` returns a study set as Markdown. `study-buddy://games/{code}` is the live state of an online game from this home's point of view. Subscribe to it (`resources/subscribe`): the server sends `notifications/resources/updated` when another home joins or plays, and the new state's `speech` says what happened and whose turn it is. Prompts: `study-session(topic)` and `bedtime-story(child, lesson)`.
