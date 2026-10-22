import path from "node:path";
import { GameHub } from "./domain/games.ts";
import { Mentor } from "./domain/mentor.ts";
import { SchoolSync, schoolProviderFromEnv } from "./domain/school.ts";
import { dataRoot, Store } from "./domain/store.ts";
import { VoiceStudio, voiceProviderFromEnv } from "./domain/voice.ts";

export interface Home {
  id: string;
  store: Store;
  mentor: Mentor;
  studio: VoiceStudio;
  school: SchoolSync;
}

export const DEFAULT_HOME = "home";

/** Normalize a home id from a header ("Rao Family" -> "rao-family"). */
export function homeIdFrom(raw: string | undefined | null): string {
  const id = String(raw ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return id || DEFAULT_HOME;
}

/**
 * One server, many homes. Each household's memory lives in its own folder, so families never see each
 * other's data. In production the home comes from the signed-in account (MCP authorization / Alexa account
 * linking); the simulator sends it in the `x-study-buddy-home` header.
 */
export class HomeRegistry {
  private homes = new Map<string, Home>();
  readonly games = new GameHub();

  constructor(private opts: { inMemory?: boolean } = {}) {
    // Online games update each player's own home (minutes, streak, activity log).
    this.games.onResult = (homeId, learnerId, summary) => this.get(homeId).mentor.recordOnlineGame(learnerId, summary);
  }

  get(rawId?: string | null): Home {
    const id = homeIdFrom(rawId);
    let h = this.homes.get(id);
    if (!h) {
      const dir = this.opts.inMemory ? null : id === DEFAULT_HOME ? dataRoot() : path.join(dataRoot(), "homes", id);
      const store = new Store({ dir });
      const mentor = new Mentor(store);
      const studio = new VoiceStudio(mentor, voiceProviderFromEnv(), dir ? path.join(dir, "audio") : null);
      const school = new SchoolSync(mentor, schoolProviderFromEnv());
      mentor.school = school;
      h = { id, store, mentor, studio, school };
      this.homes.set(id, h);
    }
    return h;
  }

  all(): Home[] {
    return [...this.homes.values()];
  }

  /** A home that's already open, without creating one. */
  find(rawId?: string | null): Home | undefined {
    return this.homes.get(homeIdFrom(rawId));
  }

  /** Which home started a voice / school connect flow with this token. */
  findByToken(token: string): Home | undefined {
    return this.all().find((h) => {
      const s = h.store.get();
      return (s.voiceEnrollments ?? []).some((e) => e.token === token) || (s.schoolEnrollments ?? []).some((e) => e.token === token);
    });
  }
}
