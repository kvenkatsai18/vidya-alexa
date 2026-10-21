import { randomInt } from "node:crypto";
import { grade } from "./generate.ts";
import type { Llm } from "./llm.ts";
import { BuddyError } from "./mentor.ts";
import type { Concept, Learner, LevelBand, Question } from "./types.ts";

/**
 * Study Together across homes. One shared server runs the game; each home's device sees live updates
 * through an MCP resource subscription (study-buddy://games/{code}).
 *
 * Safety by design:
 *  - Invite-only: a short spoken code ("TIGER 42"); no discovery, no lobby of strangers.
 *  - Under 13 needs a parent to switch online games on; teens are allowed unless a parent turns it off.
 *  - Other homes only ever see first names, scores, and right/close/wrong. Never what a player said.
 *  - Codes expire after 30 minutes if the game doesn't start; at most 6 players.
 */

const WORDS = ["TIGER", "PANDA", "ROCKET", "MANGO", "COMET", "OTTER", "MAPLE", "RIVER", "PIXEL", "LOTUS", "EAGLE", "CORAL", "SOLAR", "ZEBRA", "CEDAR", "NOVA", "KOALA", "LEMON", "ORBIT", "BISON"];

export interface RemotePlayer {
  homeId: string;
  learnerId: string;
  name: string;
  band: LevelBand;
  score: number;
  streak: number;
  bestStreak: number;
  answered: number;
  correct: number;
}

export interface RemoteGame {
  code: string;
  title: string;
  hostHome: string;
  hostName: string;
  status: "lobby" | "playing" | "done";
  players: RemotePlayer[];
  concepts: Concept[];
  turnsEach: number;
  turn: number;
  current?: { conceptId: string; questionId: string };
  asked: string[];
  hintsUsed: number;
  lastEvent: string;
  version: number;
  createdAt: number;
  expiresAt: number;
}

export interface GameSummary {
  code: string;
  title: string;
  score: number;
  correct: number;
  answered: number;
  others: string[];
  won: boolean;
}

type Listener = (code: string) => void;

export function normalizeCode(raw: string): string {
  const t = raw.toUpperCase().replace(/[^A-Z0-9 ]/g, " ");
  const word = WORDS.find((w) => new RegExp(`\\b${w}\\b`).test(t));
  const digits = t.replace(/\bTWENTY\b/g, "2").match(/\d/g)?.join("").slice(0, 2);
  return word && digits && digits.length === 2 ? `${word}-${digits}` : t.replace(/\s+/g, "-").replace(/^-|-$/g, "");
}

export function spokenCode(code: string): string {
  const [w, d] = code.split("-");
  return `${w.charAt(0)}${w.slice(1).toLowerCase()} ${d.split("").join(" ")}`;
}

export class GameHub {
  private games = new Map<string, RemoteGame>();
  private listeners = new Set<Listener>();
  /** Set by the home registry: lets each player's own home record the game. */
  onResult?: (homeId: string, learnerId: string, summary: GameSummary) => void;

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(g: RemoteGame, event: string) {
    g.lastEvent = event;
    g.version += 1;
    for (const fn of this.listeners) fn(g.code);
  }

  private sweep() {
    const now = Date.now();
    for (const [code, g] of this.games) if ((g.status === "lobby" && g.expiresAt < now) || (g.status === "done" && now - g.expiresAt > 3_600_000)) this.games.delete(code);
  }

  get(code: string): RemoteGame | undefined {
    this.sweep();
    return this.games.get(normalizeCode(code));
  }

  count(): number {
    this.sweep();
    return this.games.size;
  }

  clear() {
    this.games.clear();
  }

  activeFor(homeId: string): RemoteGame | undefined {
    this.sweep();
    return [...this.games.values()].filter((g) => g.status !== "done" && g.players.some((p) => p.homeId === homeId)).sort((a, b) => b.createdAt - a.createdAt)[0];
  }

  create(host: { homeId: string; learner: Learner }, concepts: Concept[], opts: { title?: string; turnsEach?: number }): RemoteGame {
    this.sweep();
    if (!concepts.length) throw new BuddyError("We need something to quiz on first. Share some notes or pick a topic, then start the game.");
    let code = "";
    for (let i = 0; i < 50 && (!code || this.games.has(code)); i++) code = `${WORDS[randomInt(WORDS.length)]}-${String(randomInt(10, 100))}`;
    const g: RemoteGame = {
      code,
      title: opts.title ?? "Study Together online",
      hostHome: host.homeId,
      hostName: host.learner.name,
      status: "lobby",
      players: [player(host.homeId, host.learner)],
      // A snapshot of the host's study set, so friends don't need the same notes.
      concepts: structuredClone(concepts),
      turnsEach: Math.max(1, Math.min(5, opts.turnsEach ?? 3)),
      turn: 0,
      asked: [],
      hintsUsed: 0,
      lastEvent: `${host.learner.name} started a game.`,
      version: 1,
      createdAt: Date.now(),
      expiresAt: Date.now() + 30 * 60_000,
    };
    this.games.set(code, g);
    return g;
  }

  join(code: string, who: { homeId: string; learner: Learner }): RemoteGame {
    const g = this.get(code);
    if (!g) throw new BuddyError("I couldn't find a game with that code. Check the code with your friend, or it may have expired.");
    if (g.status !== "lobby") throw new BuddyError("That game has already started. Ask your friend to start a new one.");
    if (g.players.length >= 6) throw new BuddyError("That game is full.");
    if (!g.players.some((p) => p.homeId === who.homeId && p.learnerId === who.learner.id)) g.players.push(player(who.homeId, who.learner));
    this.changed(g, `${who.learner.name} joined.`);
    return g;
  }

  start(code: string, homeId: string): RemoteGame {
    const g = this.mustGet(code);
    if (g.hostHome !== homeId) throw new BuddyError(`Only ${g.hostName} can start this game.`);
    if (g.players.length < 2) throw new BuddyError(`Nobody has joined yet. Ask your friend to say "join game ${spokenCode(g.code)}".`);
    g.status = "playing";
    this.pick(g);
    this.changed(g, "The game has started!");
    return g;
  }

  current(g: RemoteGame) {
    const p = g.players[g.turn % g.players.length];
    const c = g.concepts.find((x) => x.id === g.current!.conceptId)!;
    const q = c.questions.find((x) => x.id === g.current!.questionId)!;
    return { player: p, concept: c, question: q, total: g.players.length * g.turnsEach };
  }

  async answer(code: string, homeId: string, text: string, llm: Llm | null): Promise<{ g: RemoteGame; verdict: string; points: number; feedback: string; player: RemotePlayer }> {
    const g = this.mustGet(code);
    if (g.status !== "playing") throw new BuddyError(g.status === "lobby" ? "The game hasn't started yet." : "That game is over.");
    const { player: p, concept, question } = this.current(g);
    if (p.homeId !== homeId) throw new BuddyError(`Hold on, it's ${p.name}'s turn at their home.`);
    const view: Learner = { id: p.learnerId, name: p.name, role: "student", level: "", band: p.band, subjects: [], interests: [], stylesThatWorked: [], memories: [], exams: [], streak: { current: 0, best: 0 }, minutesStudied: 0, createdAt: "" };
    const res = await grade(llm, view, concept, question, text);
    let points = res.verdict === "correct" ? 2 : res.verdict === "partial" ? 1 : 0;
    if (g.hintsUsed && points === 2) points = 1;
    p.answered += 1;
    if (res.verdict === "correct") {
      p.correct += 1;
      p.streak += 1;
      if (p.streak >= 2) points += 1;
      p.bestStreak = Math.max(p.bestStreak, p.streak);
    } else p.streak = 0;
    p.score += points;
    g.turn += 1;
    g.hintsUsed = 0;
    // Other homes see the result, never the words.
    const said = res.verdict === "correct" ? `${p.name} got it right${p.streak >= 2 ? `, ${p.streak} in a row` : ""}!` : res.verdict === "partial" ? `${p.name} was close.` : `${p.name} didn't get that one.`;
    if (g.turn >= g.players.length * g.turnsEach) this.finish(g, said);
    else {
      this.pick(g);
      this.changed(g, said);
    }
    return { g, verdict: res.verdict, points, feedback: res.feedback, player: p };
  }

  hint(code: string, homeId: string): { g: RemoteGame; hint: string } {
    const g = this.mustGet(code);
    if (g.status !== "playing") throw new BuddyError("The game isn't in progress.");
    const { player: p, concept, question } = this.current(g);
    if (p.homeId !== homeId) throw new BuddyError(`It's ${p.name}'s turn right now.`);
    g.hintsUsed += 1;
    const hint = question.type === "mcq" ? `It starts with "${question.answer.slice(0, 3)}".` : `Think about this: ${concept.keyPoints[0] ?? concept.summary}`;
    return { g, hint };
  }

  skip(code: string, homeId: string): RemoteGame {
    const g = this.mustGet(code);
    if (g.status !== "playing") throw new BuddyError("The game isn't in progress.");
    const { player: p, question } = this.current(g);
    if (p.homeId !== homeId) throw new BuddyError(`It's ${p.name}'s turn right now.`);
    p.answered += 1;
    p.streak = 0;
    g.turn += 1;
    if (g.turn >= g.players.length * g.turnsEach) this.finish(g, `${p.name} skipped. The answer was ${question.answer}.`);
    else {
      this.pick(g);
      this.changed(g, `${p.name} skipped.`);
    }
    return g;
  }

  leave(code: string, homeId: string): RemoteGame {
    const g = this.mustGet(code);
    const leaving = g.players.filter((p) => p.homeId === homeId);
    if (g.hostHome === homeId || g.players.length - leaving.length < 2) {
      this.finish(g, `${leaving[0]?.name ?? "A player"} left, so the game is over.`);
      return g;
    }
    g.players = g.players.filter((p) => p.homeId !== homeId);
    if (g.status === "playing") {
      g.turn = Math.min(g.turn, g.players.length * g.turnsEach - 1);
      this.pick(g);
    }
    this.changed(g, `${leaving.map((p) => p.name).join(" and ")} left the game.`);
    return g;
  }

  end(code: string, homeId: string): RemoteGame {
    const g = this.mustGet(code);
    if (g.hostHome !== homeId) return this.leave(code, homeId);
    this.finish(g, `${g.hostName} ended the game.`);
    return g;
  }

  private finish(g: RemoteGame, lead: string) {
    const started = g.status === "playing";
    g.status = "done";
    g.expiresAt = Date.now();
    const top = Math.max(...g.players.map((p) => p.score));
    const winners = g.players.filter((p) => p.score === top && top > 0);
    const result = !winners.length ? "Nobody scored, so that's what we practice next!" : winners.length > 1 ? `It's a tie between ${winners.map((w) => w.name).join(" and ")}!` : `${winners[0].name} wins with ${top} points!`;
    for (const p of started ? g.players : []) {
      this.onResult?.(p.homeId, p.learnerId, {
        code: g.code,
        title: g.title,
        score: p.score,
        correct: p.correct,
        answered: p.answered,
        others: g.players.filter((x) => x !== p).map((x) => x.name),
        won: winners.includes(p),
      });
    }
    this.changed(g, `${lead} ${result} Great game, everyone.`);
  }

  private mustGet(code: string): RemoteGame {
    const g = this.get(code);
    if (!g) throw new BuddyError("That game isn't running anymore.");
    return g;
  }

  /** Same fairness rule as at home: younger players get true/false and multiple choice. */
  private pick(g: RemoteGame) {
    const p = g.players[g.turn % g.players.length];
    const prefer: Question["type"][] = p.band === "early" || p.band === "primary" ? ["truefalse", "mcq"] : p.band === "middle" ? ["mcq", "truefalse", "short"] : ["short", "mcq", "truefalse"];
    const usage = (c: Concept) => g.asked.filter((q) => c.questions.some((x) => x.id === q)).length;
    const concepts = [...g.concepts].sort((a, b) => usage(a) - usage(b));
    for (const type of prefer) {
      for (const c of concepts) {
        const q = c.questions.find((x) => x.type === type && !g.asked.includes(x.id));
        if (q) {
          g.current = { conceptId: c.id, questionId: q.id };
          g.asked.push(q.id);
          return;
        }
      }
    }
    const c = concepts[0];
    g.current = { conceptId: c.id, questionId: (c.questions.find((x) => prefer.includes(x.type)) ?? c.questions[0]).id };
  }

  /** What a given home sees. Viewer-specific: whose turn it is, and the question only matters for them. */
  view(g: RemoteGame, viewerHome: string) {
    const playing = g.status === "playing";
    const cur = playing ? this.current(g) : undefined;
    const yourTurn = !!cur && cur.player.homeId === viewerHome;
    return {
      kind: "online_game",
      title: g.title,
      code: g.code,
      spokenCode: spokenCode(g.code),
      gameUri: `study-buddy://games/${g.code}`,
      status: g.status,
      isHost: g.hostHome === viewerHome,
      version: g.version,
      lastEvent: g.lastEvent,
      players: g.players.map((p) => ({ name: p.name, home: p.homeId === viewerHome ? "here" : "another home", score: p.score, streak: p.streak, current: !!cur && cur.player === p, winner: g.status === "done" && p.score === Math.max(...g.players.map((x) => x.score)) && p.score > 0 })),
      turn: cur ? g.turn + 1 : null,
      totalTurns: g.players.length * g.turnsEach,
      currentPlayer: cur?.player.name ?? null,
      yourTurn,
      // Only the home whose turn it is gets the question; others just see whose turn it is.
      question: cur && yourTurn ? { type: cur.question.type, prompt: cur.question.prompt, options: cur.question.options ?? null } : null,
      concept: cur && yourTurn ? { title: cur.concept.title } : null,
    };
  }
}

function player(homeId: string, l: Learner): RemotePlayer {
  return { homeId, learnerId: l.id, name: l.name, band: l.band, score: 0, streak: 0, bestStreak: 0, answered: 0, correct: 0 };
}
