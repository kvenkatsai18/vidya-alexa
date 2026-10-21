import { randomBytes } from "node:crypto";
import type { Llm } from "./llm.ts";
import { BuddyError, type Mentor, type Result } from "./mentor.ts";
import { judgeAge, needsParent, gradeFromCourses, type AgeSignals } from "./age.ts";
import { addDays, daysBetween, isoDate, relativeDay } from "./time.ts";
import type { Learner, SchoolConnection, SchoolCourse, SchoolEnrollment, SchoolMaterial, SchoolWork, State } from "./types.ts";

/**
 * School sync (Google Classroom), strictly read-only: classes, assignments, due dates, tests and
 * teacher materials flow in; nothing is ever submitted, edited or posted. Tests become exams in the
 * study plan; teacher notes become personalized study sets. Under 13, a parent must connect.
 *
 * Needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (an OAuth "web application" client). There is no
 * sample school in the product: without the keys, connecting says so.
 *
 * Scopes are Classroom-only and read-only ("sensitive", not "restricted"), so any Google account can sign
 * in past Google's unverified-app warning. Reading teacher-attached Google Docs needs Drive, a restricted
 * scope that only works for an app's test users, so it's opt-in: BUDDY_GOOGLE_DRIVE=on.
 */

export function googleScopes(): string[] {
  return [
    "https://www.googleapis.com/auth/classroom.courses.readonly",
    "https://www.googleapis.com/auth/classroom.coursework.me.readonly",
    "https://www.googleapis.com/auth/classroom.courseworkmaterials.readonly",
    // Teacher names (course rosters) and the account's display name.
    "https://www.googleapis.com/auth/classroom.rosters.readonly",
    // Age check: Google's age range (under 18 / 18-20 / 21+) and birthday, so a child can't connect
    // school alone by saying they're older.
    "https://www.googleapis.com/auth/profile.agerange.read",
    "https://www.googleapis.com/auth/user.birthday.read",
    ...(process.env.BUDDY_GOOGLE_DRIVE === "on" ? ["https://www.googleapis.com/auth/drive.readonly"] : []),
  ];
}

export interface FetchedCourse {
  externalId: string;
  name: string;
  section?: string;
  teacher?: string;
}
export interface FetchedWork {
  externalId: string;
  courseExternalId: string;
  title: string;
  description?: string;
  kind: "assignment" | "test" | "material";
  due?: string;
  state: "todo" | "done" | "missing";
  materials: SchoolMaterial[];
  url?: string;
}

export interface SchoolProvider {
  readonly name: "google" | "none" | "fixture";
  readonly live: boolean;
  authUrl(state: string, redirectUri: string): string | null;
  exchange(code: string, redirectUri: string): Promise<{ tokens: NonNullable<SchoolConnection["tokens"]>; accountLabel: string; age?: AgeSignals }>;
  fetch(conn: SchoolConnection, now: Date, tz: string): Promise<{ courses: FetchedCourse[]; work: FetchedWork[]; tokens?: SchoolConnection["tokens"] }>;
  revoke(conn: SchoolConnection): Promise<void>;
}

const TEST_WORDS = /\b(test|quiz|exam|midterm|final|assessment)\b/i;

// ------------------------------------------------------------------ Google Classroom (live)

class GoogleClassroomProvider implements SchoolProvider {
  readonly name = "google" as const;
  readonly live = true;
  constructor(
    private clientId: string,
    private clientSecret: string,
  ) {}

  authUrl(state: string, redirectUri: string) {
    const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    u.searchParams.set("client_id", this.clientId);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", googleScopes().join(" "));
    u.searchParams.set("access_type", "offline");
    u.searchParams.set("prompt", "consent");
    u.searchParams.set("include_granted_scopes", "true");
    u.searchParams.set("state", state);
    return u.toString();
  }

  private async token(body: Record<string, string>) {
    const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
    if (!r.ok) throw new Error(`Google sign-in failed (${r.status}): ${(await r.text()).slice(0, 200)}`);
    return (await r.json()) as { access_token: string; refresh_token?: string; expires_in: number };
  }

  async exchange(code: string, redirectUri: string) {
    const t = await this.token({ code, client_id: this.clientId, client_secret: this.clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" });
    const auth = { headers: { Authorization: `Bearer ${t.access_token}` } };
    const me = await fetch("https://classroom.googleapis.com/v1/userProfiles/me", auth).then((r) => (r.ok ? r.json() : {})) as { name?: { fullName?: string }; emailAddress?: string };
    // Age signals, before anything is kept: Google's age range and birthday, and the grade in class names.
    const person = (await fetch("https://people.googleapis.com/v1/people/me?personFields=ageRanges,birthdays", auth).then((r) => (r.ok ? r.json() : {})).catch(() => ({}))) as {
      ageRanges?: Array<{ ageRange?: string }>;
      birthdays?: Array<{ date?: { year?: number; month?: number; day?: number } }>;
    };
    const range = person.ageRanges?.map((x) => x.ageRange).find((x) => x && x !== "AGE_RANGE_UNSPECIFIED");
    const b = person.birthdays?.map((x) => x.date).find((d) => d?.year && d.month && d.day);
    const { courses = [] } = (await fetch("https://classroom.googleapis.com/v1/courses?studentId=me&courseStates=ACTIVE&pageSize=20", auth).then((r) => (r.ok ? r.json() : {})).catch(() => ({}))) as { courses?: Array<{ name: string; section?: string }> };
    return {
      tokens: { access: t.access_token, refresh: t.refresh_token, expiresAt: new Date(Date.now() + (t.expires_in - 60) * 1000).toISOString() },
      accountLabel: me.name?.fullName ?? "Google Classroom",
      age: {
        range: range === "LESS_THAN_EIGHTEEN" ? "under18" : range === "EIGHTEEN_TO_TWENTY" ? "18to20" : range === "TWENTY_ONE_OR_OLDER" ? "21plus" : undefined,
        birthday: b ? `${b.year}-${String(b.month).padStart(2, "0")}-${String(b.day).padStart(2, "0")}` : undefined,
        grade: gradeFromCourses(courses),
      } satisfies AgeSignals,
    };
  }

  private async access(conn: SchoolConnection) {
    const tk = conn.tokens ?? {};
    if (tk.access && tk.expiresAt && tk.expiresAt > new Date().toISOString()) return { access: tk.access, tokens: undefined };
    if (!tk.refresh) throw new BuddyError("The school connection expired. Please connect again.");
    const t = await this.token({ refresh_token: tk.refresh, client_id: this.clientId, client_secret: this.clientSecret, grant_type: "refresh_token" });
    const tokens = { ...tk, access: t.access_token, expiresAt: new Date(Date.now() + (t.expires_in - 60) * 1000).toISOString() };
    return { access: t.access_token, tokens };
  }

  private async get<T>(access: string, url: string): Promise<T> {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${access}` } });
    if (!r.ok) throw new Error(`Google Classroom request failed (${r.status}) for ${new URL(url).pathname}`);
    return (await r.json()) as T;
  }

  async fetch(conn: SchoolConnection, now: Date, tz: string) {
    const { access, tokens } = await this.access(conn);
    const base = "https://classroom.googleapis.com/v1";
    const { courses = [] } = await this.get<{ courses?: any[] }>(access, `${base}/courses?studentId=me&courseStates=ACTIVE&pageSize=20`);
    const outCourses: FetchedCourse[] = [];
    const outWork: FetchedWork[] = [];
    const horizon = isoDate(addDays(now, -14), tz);
    for (const c of courses.slice(0, 12)) {
      let teacher: string | undefined;
      try {
        const t = await this.get<{ teachers?: any[] }>(access, `${base}/courses/${c.id}/teachers?pageSize=1`);
        teacher = t.teachers?.[0]?.profile?.name?.fullName;
      } catch {}
      outCourses.push({ externalId: c.id, name: c.name, section: c.section, teacher });
      const { courseWork = [] } = await this.get<{ courseWork?: any[] }>(access, `${base}/courses/${c.id}/courseWork?orderBy=dueDate%20desc&pageSize=20`).catch(() => ({ courseWork: [] }));
      for (const w of courseWork) {
        const due = w.dueDate ? `${w.dueDate.year}-${String(w.dueDate.month).padStart(2, "0")}-${String(w.dueDate.day).padStart(2, "0")}` : undefined;
        if (due && due < horizon) continue;
        let state: FetchedWork["state"] = "todo";
        try {
          const sub = await this.get<{ studentSubmissions?: any[] }>(access, `${base}/courses/${c.id}/courseWork/${w.id}/studentSubmissions?userId=me`);
          const st = sub.studentSubmissions?.[0]?.state;
          if (st === "TURNED_IN" || st === "RETURNED") state = "done";
          else if (due && due < isoDate(now, tz)) state = "missing";
        } catch {}
        outWork.push({
          externalId: w.id,
          courseExternalId: c.id,
          title: w.title,
          description: w.description,
          kind: TEST_WORDS.test(`${w.title} ${w.description ?? ""}`) ? "test" : "assignment",
          due,
          state,
          materials: await this.materials(access, w.materials ?? []),
          url: w.alternateLink,
        });
      }
      const { courseWorkMaterial = [] } = await this.get<{ courseWorkMaterial?: any[] }>(access, `${base}/courses/${c.id}/courseWorkMaterials?pageSize=10`).catch(() => ({ courseWorkMaterial: [] }));
      for (const m of courseWorkMaterial.slice(0, 6)) {
        outWork.push({ externalId: m.id, courseExternalId: c.id, title: m.title, description: m.description, kind: "material", state: "todo", materials: await this.materials(access, m.materials ?? []), url: m.alternateLink });
      }
    }
    return { courses: outCourses, work: outWork, tokens };
  }

  /** Attachments; Google Docs are exported as text so teacher notes can become study sets. */
  private async materials(access: string, mats: any[]): Promise<SchoolMaterial[]> {
    const out: SchoolMaterial[] = [];
    for (const m of mats.slice(0, 4)) {
      if (m.driveFile?.driveFile) {
        const f = m.driveFile.driveFile;
        let text: string | undefined;
        if (process.env.BUDDY_GOOGLE_DRIVE === "on") try {
          const r = await fetch(`https://www.googleapis.com/drive/v3/files/${f.id}/export?mimeType=text/plain`, { headers: { Authorization: `Bearer ${access}` } });
          if (r.ok) text = (await r.text()).slice(0, 60_000);
        } catch {}
        out.push({ title: f.title ?? "File", url: f.alternateLink, kind: text ? "doc" : /\.pdf$/i.test(f.title ?? "") ? "pdf" : "file", text });
      } else if (m.link) out.push({ title: m.link.title ?? m.link.url, url: m.link.url, kind: "link" });
      else if (m.youtubeVideo) out.push({ title: m.youtubeVideo.title ?? "Video", url: m.youtubeVideo.alternateLink, kind: "video" });
      else if (m.form) out.push({ title: m.form.title ?? "Form", url: m.form.formUrl, kind: "form" });
    }
    return out;
  }

  async revoke(conn: SchoolConnection) {
    const t = conn.tokens?.refresh ?? conn.tokens?.access;
    if (t) await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(t)}`, { method: "POST" }).catch(() => {});
  }
}

// ------------------------------------------------------------------ not set up

/** No Google keys: connecting says so plainly. */
class NotConfiguredProvider implements SchoolProvider {
  readonly name = "none" as const;
  readonly live = false;
  authUrl() {
    return null;
  }
  async exchange(): Promise<never> {
    throw new BuddyError(NOT_SET_UP);
  }
  async fetch(): Promise<never> {
    throw new BuddyError(NOT_SET_UP);
  }
  async revoke() {}
}

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

export const NOT_SET_UP = "School sync isn't set up on this device yet. It needs Google sign-in keys (GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET).";

/** Tests only: a fixed classroom (test/fixtures/mock-school.ts) instead of Google. */
let testProvider: SchoolProvider | null = null;
export function useTestSchoolProvider(p: SchoolProvider | null) {
  testProvider = p;
}

export function schoolProviderFromEnv(): SchoolProvider {
  const id = process.env.GOOGLE_CLIENT_ID;
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  if (testProvider) return testProvider;
  return id && secret ? new GoogleClassroomProvider(id, secret) : new NotConfiguredProvider();
}

// ------------------------------------------------------------------ service

export class SchoolSync {
  /** How the last connect attempt went, per learner, so the device can say it (connected, or a parent is needed). */
  private lastConnect = new Map<string, Result>();
  constructor(
    private mentor: Mentor,
    readonly provider: SchoolProvider = schoolProviderFromEnv(),
  ) {}

  private get s(): State {
    const s = this.mentor.store.get();
    s.schoolConnections ??= [];
    s.schoolCourses ??= [];
    s.schoolWork ??= [];
    s.schoolEnrollments ??= [];
    return s;
  }

  private learner(name?: string): Learner {
    const l = this.mentor.findLearner(name);
    if (!l) throw new BuddyError(name ? `I don't know ${name} yet. Set them up first.` : "Who's connecting their school? Tell me your name first.");
    return l;
  }

  connection(l: Learner) {
    return this.s.schoolConnections!.find((c) => c.learnerId === l.id);
  }

  /** Under 13, a parent must connect. Returns a single-use link for the secure connect page. */
  startConnect(input: { learner?: string; parentName?: string }): { enrollment: SchoolEnrollment; learner: Learner } {
    if (this.provider.name === "none") throw new BuddyError(NOT_SET_UP);
    const l = this.learner(input.learner);
    // Google's answer from an earlier sign-in outranks what they say now.
    const minorUnder13 = l.ageCheck ? needsParent(l.ageCheck) : (l.age !== undefined && l.age < 13) || (l.age === undefined && ["early", "primary", "middle"].includes(l.band));
    const parent = input.parentName ?? undefined;
    if (minorUnder13 && !parent) {
      const g = this.mentor.guardianOf(l);
      throw new BuddyError(`For kids under 13, a parent connects school. ${g ? `${l.name}'s ${g.relation.toLowerCase()}` : "A parent"} can say: "I'm ${g?.name ?? "the parent"}, connect ${l.name}'s school."`);
    }
    const enrollment: SchoolEnrollment = {
      token: randomBytes(18).toString("base64url"),
      learnerId: l.id,
      connectedBy: parent ? { role: "parent", name: parent } : { role: "learner", name: l.name },
      expiresAt: new Date(this.mentor.now().getTime() + 20 * 60_000).toISOString(),
    };
    this.mentor.store.update(() => {
      const s = this.s;
      s.schoolEnrollments = s.schoolEnrollments!.filter((e) => !e.done && e.expiresAt > this.mentor.now().toISOString());
      s.schoolEnrollments.push(enrollment);
    });
    return { enrollment, learner: l };
  }

  enrollment(token: string) {
    const e = this.s.schoolEnrollments!.find((x) => x.token === token);
    if (!e || e.done || e.expiresAt < this.mentor.now().toISOString()) return undefined;
    return e;
  }

  /** Finish connecting: store the (read-only) access and run a first sync. */
  async completeConnect(token: string, code: string | undefined, redirectUri: string, llm: Llm | null): Promise<Result> {
    const e = this.enrollment(token);
    if (!e) throw new BuddyError("This connect link has expired. Ask Study Buddy to connect school again.");
    const got = this.provider.live ? await this.provider.exchange(code ?? "", redirectUri) : await this.provider.exchange("", redirectUri);
    const l = this.mentor.store.get().learners.find((x) => x.id === e.learnerId)!;
    // Check the age Google reports, not the one they said. A parent connecting is fine at any age.
    if (got.age) {
      const verdict = judgeAge(got.age, { age: l.age, band: l.band }, this.mentor.today());
      const claimedAdult = (l.age !== undefined && l.age >= 18) || l.band === "college" || l.band === "adult";
      this.mentor.store.update(() => {
        l.ageCheck = { ...verdict, at: this.mentor.now().toISOString() };
        if (verdict.age !== undefined) l.age = verdict.age;
        // "I'm 18" from an under-18 account: the claim doesn't stand.
        else if (verdict.minor && l.age !== undefined && l.age >= 18) l.age = undefined;
      });
      if (e.connectedBy.role === "learner" && needsParent(verdict)) {
        await this.provider.revoke({ tokens: got.tokens } as SchoolConnection);
        this.mentor.store.update(() => {
          e.done = true;
        });
        const g = this.mentor.guardianOf(l);
        const why = verdict.under13 ? `${cap(verdict.basis)}, so this looks like an account for someone under 13.` : `${cap(verdict.basis)}${claimedAdult ? ", not 18 or older" : ""}, and I couldn't confirm you're 13 or older.`;
        const result: Result = {
          kind: "school_needs_parent",
          title: "A parent needs to connect school",
          learner: { name: l.name },
          basis: verdict.basis,
          speech: `I checked with Google. ${why} So a parent needs to connect school, and I didn't keep anything. ${g ? `Your ${g.relation.toLowerCase()} can say: "I'm ${g.name}, connect ${l.name}'s school."` : `A parent can say: "I'm your mom" (or dad), "connect ${l.name}'s school."`}`,
        };
        this.lastConnect.set(l.id, result);
        return result;
      }
    }
    this.mentor.store.update(() => {
      const s = this.s;
      s.schoolConnections = s.schoolConnections!.filter((c) => c.learnerId !== l.id);
      s.schoolConnections.push({
        id: `school-${randomBytes(4).toString("hex")}`,
        learnerId: l.id,
        provider: this.provider.name,
        connectedBy: e.connectedBy,
        accountLabel: got.accountLabel,
        tokens: got.tokens,
        connectedAt: this.mentor.now().toISOString(),
      });
      e.done = true;
    });
    const synced = await this.sync(l.name, llm);
    this.lastConnect.set(l.id, synced);
    return synced;
  }

  /** Whether a learner's school is connected, and how the last connect attempt went. */
  status(learnerName: string | undefined): Result {
    const l = this.learner(learnerName);
    const last = this.lastConnect.get(l.id);
    if (last) return last;
    const conn = this.connection(l);
    return conn
      ? { kind: "school_status", title: `${l.name}'s school`, connected: true, speech: `${l.name}'s school is connected (${conn.accountLabel}).` }
      : { kind: "school_status", title: `${l.name}'s school`, connected: false, speech: `${l.name}'s school isn't connected yet.` };
  }

  async sync(learnerName: string | undefined, llm: Llm | null): Promise<Result> {
    const l = this.learner(learnerName);
    const conn = this.connection(l);
    if (!conn) throw new BuddyError(`${l.name}'s school isn't connected yet. Say "connect my school" to link it.`);
    const tz = this.mentor.store.get().household.timeZone;
    const fetched = await this.provider.fetch(conn, this.mentor.now(), tz);
    const createdDecks: string[] = [];
    const newExams: string[] = [];
    this.mentor.store.update(() => {
      const s = this.s;
      if (fetched.tokens) conn.tokens = fetched.tokens;
      conn.lastSync = this.mentor.now().toISOString();
      for (const c of fetched.courses) {
        const existing = s.schoolCourses!.find((x) => x.learnerId === l.id && x.externalId === c.externalId);
        if (existing) Object.assign(existing, c);
        else s.schoolCourses!.push({ id: `course-${randomBytes(3).toString("hex")}`, learnerId: l.id, ...c });
      }
      for (const w of fetched.work) {
        const course = s.schoolCourses!.find((x) => x.learnerId === l.id && x.externalId === w.courseExternalId)!;
        const existing = s.schoolWork!.find((x) => x.learnerId === l.id && x.externalId === w.externalId);
        const { courseExternalId: _c, ...rest } = w;
        if (existing) Object.assign(existing, rest, { courseId: course.id });
        else s.schoolWork!.push({ id: `work-${randomBytes(3).toString("hex")}`, learnerId: l.id, courseId: course.id, ...rest });
      }
      // Tests become exams in the study plan (subject = the class).
      for (const w of s.schoolWork!.filter((x) => x.learnerId === l.id && x.kind === "test" && x.due && !x.examId)) {
        const course = s.schoolCourses!.find((x) => x.id === w.courseId)!;
        const subject = course.name.replace(/\s+\d+\w?$/, "").replace(/\s+(I|II|III)$/, "");
        const exam = this.mentor.addExamTo(l, { title: `${course.name}: ${w.title.replace(/^unit \d+ test:\s*/i, "")} test`.replace(/ test test$/, " test"), subject, date: w.due });
        w.examId = exam.id;
        newExams.push(exam.title);
      }
    });
    // Teacher notes (readable docs) become personalized study sets, once.
    for (const w of this.s.schoolWork!.filter((x) => x.learnerId === l.id && !x.deckId)) {
      const doc = w.materials.find((m) => m.text && m.text.trim().length > 200);
      if (!doc) continue;
      const res = await this.mentor.addMaterialFor(llm, l, doc.title, doc.text!);
      const deckId = (res.deck as { id: string } | undefined)?.id;
      if (!deckId) continue;
      this.mentor.store.update(() => {
        w.deckId = deckId;
        const course = this.s.schoolCourses!.find((x) => x.id === w.courseId)!;
        for (const e of l.exams) if (e.subject && course.name.toLowerCase().startsWith(e.subject.toLowerCase()) && !e.deckIds.includes(deckId)) e.deckIds.push(deckId);
      });
      createdDecks.push(String(res.title ?? doc.title));
    }
    const hw = this.homework(l.name, 7);
    const courses = this.s.schoolCourses!.filter((c) => c.learnerId === l.id);
    const bits = [`I've synced ${courses.length === 1 ? "one class" : `${courses.length} classes`}: ${courses.map((c) => c.name).slice(0, 3).join(", ")}.`];
    if ((hw.items as unknown[]).length) bits.push(String(hw.speech).replace(/^You have/, "You have"));
    if (createdDecks.length) bits.push(`I also turned ${createdDecks.length === 1 ? "your teacher's notes" : "teacher notes"} into a study set, ${createdDecks[0].toLowerCase()}.`);
    return {
      kind: "school_synced",
      title: "School synced",
      learner: { name: l.name },
      provider: this.provider.name,
      live: this.provider.live,
      courses: courses.map((c) => ({ name: c.name, teacher: c.teacher ?? null, section: c.section ?? null })),
      items: hw.items,
      newExams,
      studySets: createdDecks,
      speech: bits.join(" "),
    };
  }

  homework(learnerName: string | undefined, days = 7): Result {
    const l = this.learner(learnerName);
    const today = this.mentor.today();
    const horizon = isoDate(addDays(new Date(`${today}T12:00:00Z`), days), "UTC");
    const courseName = (id: string) => this.s.schoolCourses!.find((c) => c.id === id)?.name ?? "";
    const teacher = (id: string) => this.s.schoolCourses!.find((c) => c.id === id)?.teacher;
    const all = this.s.schoolWork!.filter((w) => w.learnerId === l.id && w.kind !== "material");
    const missing = all.filter((w) => w.state === "missing");
    const upcoming = all.filter((w) => w.state === "todo" && w.due && w.due >= today && w.due <= horizon).sort((a, b) => a.due!.localeCompare(b.due!));
    const done = all.filter((w) => w.state === "done" && w.due && w.due >= isoDate(addDays(new Date(`${today}T12:00:00Z`), -3), "UTC"));
    const now = this.mentor.now();
    const tz = this.mentor.store.get().household.timeZone;
    const describe = (w: SchoolWork) => `${w.kind === "test" ? `the ${courseName(w.courseId)} ${w.title.replace(/^unit \d+ test:\s*/i, "").toLowerCase()} test` : `${w.title.charAt(0).toLowerCase()}${w.title.slice(1)} for ${courseName(w.courseId)}`}, ${relativeDay(w.due!, now, tz)}`;
    const bits: string[] = [];
    if (!this.connection(l)) bits.push(`${l.name}'s school isn't connected yet. Say "connect my school" to link it.`);
    else if (!upcoming.length && !missing.length) bits.push(`Nothing due in the next ${days} days. Nice!`);
    else {
      if (upcoming.length) bits.push(`You have ${upcoming.length === 1 ? "one thing" : `${upcoming.length} things`} coming up: ${upcoming.slice(0, 3).map(describe).join("; ")}.`);
      if (missing.length) bits.push(missing.length === 1 ? `One thing's past due: ${missing[0].title.charAt(0).toLowerCase()}${missing[0].title.slice(1)} for ${courseName(missing[0].courseId)}. It's worth checking in with ${teacher(missing[0].courseId) ?? "your teacher"}.` : `${missing.length} assignments are past due. It's worth checking in with your teachers.`);
      const test = upcoming.find((w) => w.kind === "test" && w.examId);
      if (test) bits.push(`Want to start studying for the ${courseName(test.courseId)} test?`);
    }
    return {
      kind: "school_homework",
      title: `${l.name}'s schoolwork`,
      learner: { name: l.name },
      connected: !!this.connection(l),
      items: [...missing, ...upcoming, ...done].map((w) => ({
        title: w.title,
        course: courseName(w.courseId),
        teacher: teacher(w.courseId) ?? null,
        kind: w.kind,
        due: w.due ?? null,
        when: w.due ? relativeDay(w.due, now, tz) : null,
        daysLeft: w.due ? daysBetween(today, w.due) : null,
        state: w.state,
        hasStudySet: !!w.deckId || !!w.examId,
      })),
      speech: bits.join(" "),
    };
  }

  async disconnect(learnerName: string | undefined): Promise<Result> {
    const l = this.learner(learnerName);
    const conn = this.connection(l);
    if (!conn) throw new BuddyError(`${l.name}'s school isn't connected.`);
    await this.provider.revoke(conn);
    this.mentor.store.update(() => {
      const s = this.s;
      s.schoolConnections = s.schoolConnections!.filter((c) => c.id !== conn.id);
      s.schoolCourses = s.schoolCourses!.filter((c) => c.learnerId !== l.id);
      s.schoolWork = s.schoolWork!.filter((w) => w.learnerId !== l.id);
    });
    return { kind: "school_disconnected", title: "School disconnected", speech: `Done. I've disconnected ${l.name}'s school and deleted the synced classes and assignments. Study sets you already made are still here.` };
  }

  /** One line for the daily briefing and the parent view. */
  summaryFor(l: Learner): { dueSoon: number; missing: number; next?: string } | null {
    if (!this.connection(l)) return null;
    const today = this.mentor.today();
    const soon = isoDate(addDays(new Date(`${today}T12:00:00Z`), 3), "UTC");
    const work = this.s.schoolWork!.filter((w) => w.learnerId === l.id && w.kind !== "material");
    const due = work.filter((w) => w.state === "todo" && w.due && w.due >= today && w.due <= soon).sort((a, b) => a.due!.localeCompare(b.due!));
    return { dueSoon: due.length, missing: work.filter((w) => w.state === "missing").length, next: due[0]?.title };
  }
}
