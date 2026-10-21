import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgeSignals } from "../../src/domain/age.ts";
import type { FetchedCourse, FetchedWork, SchoolProvider } from "../../src/domain/school.ts";
import { addDays, isoDate } from "../../src/domain/time.ts";
import type { SchoolConnection } from "../../src/domain/types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

/** TEST FIXTURE ONLY: a fixed classroom so school sync can be tested without Google. */
export class MockClassroomProvider implements SchoolProvider {
  readonly name = "fixture" as const;
  readonly live = false;
  revoked = 0;
  /** What "Google" says about the account's age at sign-in (none by default). */
  constructor(public age?: AgeSignals) {}
  authUrl() {
    return null;
  }
  async exchange() {
    return { tokens: {}, accountLabel: "Test classroom", age: this.age };
  }
  async fetch(_conn: SchoolConnection, now: Date, tz: string) {
    const d = (n: number) => isoDate(addDays(now, n), tz);
    const notes = readFileSync(path.resolve(here, "../../content/cell-division.md"), "utf8");
    const courses: FetchedCourse[] = [
      { externalId: "bio-10b", name: "Biology 10B", section: "Period 3", teacher: "Ms. Rao" },
      { externalId: "alg-1", name: "Algebra I", section: "Period 1", teacher: "Mr. Okafor" },
      { externalId: "eng-10", name: "English 10", section: "Period 5", teacher: "Mrs. Lin" },
    ];
    const work: FetchedWork[] = [
      { externalId: "bio-test-4", courseExternalId: "bio-10b", title: "Unit 4 test: Cell division", description: "Covers the cell cycle, mitosis, cytokinesis and meiosis.", kind: "test", due: d(5), state: "todo", materials: [] },
      { externalId: "bio-ws-4", courseExternalId: "bio-10b", title: "Cell division worksheet", description: "Label the phases of mitosis and answer questions 1-8.", kind: "assignment", due: d(2), state: "todo", materials: [{ title: "Worksheet", kind: "pdf" }] },
      { externalId: "bio-notes-4", courseExternalId: "bio-10b", title: "Unit 4 notes", description: "Notes from class.", kind: "material", state: "todo", materials: [{ title: "Unit 4 notes: Cell division", kind: "doc", text: notes }] },
      { externalId: "alg-quad", courseExternalId: "alg-1", title: "Quadratics practice set", description: "Problems 1-20 on factoring.", kind: "assignment", due: d(1), state: "done", materials: [] },
      { externalId: "alg-quiz", courseExternalId: "alg-1", title: "Factoring quiz", kind: "test", due: d(8), state: "todo", materials: [] },
      { externalId: "eng-ch5", courseExternalId: "eng-10", title: "Read chapter 5 and write a short reflection", kind: "assignment", due: d(-1), state: "missing", materials: [] },
    ];
    return { courses, work };
  }
  async revoke() {
    this.revoked++;
  }
}
