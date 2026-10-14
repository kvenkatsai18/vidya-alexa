# Study Buddy tool guide

Every tool returns `structuredContent` with a `kind` (the card it renders) and a voice-ready `speech` string. Tools marked 🖼 render the MCP App card `ui://study-buddy/card.html`.

| Tool | Args | Result `kind` |
|---|---|---|
| 🖼 `get_today` | none | `welcome` (no learner yet) or `today` (streak, exam countdown, due count, weak spot, `suggestion`, `voiceGuide`) |
| 🖼 `set_up_learner` | `name`, `level`, `age`, `subjects`, `interests`, `exam_title`, `exam_subject`, `exam_date` or `exam_in_days`, `use_form` | `profile` |
| 🖼 `switch_learner` | `name` | `today` |
| `remember` | `fact`, `kind` (preference, struggle, strength, personal, goal) | `memory_saved` |
| 🖼 `get_profile` | none | `profile` (memories told and observed) |
| `forget` | `memory_id`, `text`, or `everything` | `forgotten` or `cancelled` |
| 🖼 `add_material` | `title`, `text` | `deck` |
| 🖼 `add_topic` | `topic` | `deck` |
| 🖼 `explain_concept` | `concept`, `style` | `explanation` |
| 🖼 `start_quiz` | `topic`, `mode` (quiz or flashcards), `count` | `quiz_question` |
| 🖼 `answer_question` | `answer` | `quiz_question` (with `feedback`) or `quiz_summary` |
| 🖼 `quiz_action` | `action` (hint, skip, repeat, flip, end) | `quiz_question` or `quiz_summary` |
| 🖼 `teach_back` | `action` (start or submit), `concept`, `explanation` | `teach_back` (`phase`: listening or result) |
| 🖼 `get_study_plan` | `exam` | `study_plan` (mastery map and day-by-day plan) |
| 🖼 `summarize` | `topic` | `summary` |
| 🖼 `focus_session` | `action` (start or end), `minutes`, `topic` | `focus` |
| 🖼 `tell_story` | `child`, `lesson`, `age`, `interests`, `minutes` | `story` |

How content gets generated: the server uses **MCP sampling** (the client's own model) when the client supports it, then the server's own model if one is configured, and otherwise prepared content and heuristics.

Resources: `study-buddy://decks/{deckId}` returns a study set as Markdown. Prompts: `study-session(topic)` and `bedtime-story(child, lesson)`.
