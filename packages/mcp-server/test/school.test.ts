import assert from "node:assert/strict";
import { it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitationCompleteNotificationSchema, ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Mentor } from "../src/domain/mentor.ts";
import { gradeFromCourses, judgeAge, type AgeSignals } from "../src/domain/age.ts";
import { SchoolSync } from "../src/domain/school.ts";
import { MockClassroomProvider } from "./fixtures/mock-school.ts";
import { Store } from "../src/domain/store.ts";
import { createStudyBuddyServer, schoolNotifiers } from "../src/server.ts";
import { useOfflineEngine } from "../src/domain/generate.ts";
import { offlineEngine } from "./fixtures/offline-engine.ts";

// Tests use scripted stand-ins for the model; the product generates everything live.
useOfflineEngine(offlineEngine);

type R = Record<string, any>;

async function connect(age?: AgeSignals) {
  delete process.env.GOOGLE_CLIENT_ID;
  const store = new Store({ dir: null });
  const mentor = new Mentor(store);
  const provider = new MockClassroomProvider(age);
  const school = new SchoolSync(mentor, provider);
  const server = createStudyBuddyServer(mentor, { llm: null, school, publicUrl: "http://localhost:8787" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" }, { capabilities: { elicitation: { form: {}, url: {} } } });
  const urls: string[] = [];
  const completed: string[] = [];
  client.setRequestHandler(ElicitRequestSchema, async (req) => {
    if (req.params.mode === "url") urls.push(req.params.url);
    return { action: "accept" } as any;
  });
  client.setNotificationHandler(ElicitationCompleteNotificationSchema, (n) => {
    completed.push(n.params.elicitationId);
  });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: R = {}): Promise<R> => (await client.callTool({ name, arguments: args })).structuredContent as R;
  return { call, school, store, urls, completed, provider, mentor };
}

it("school sync (test mode): connect by URL elicitation, tests become exams, teacher notes become a study set", async () => {
  const { call, school, store, urls, completed } = await connect();
  await call("set_up_learner", { name: "Priya", level: "Grade 10", age: 15 });

  const before = await call("school_homework", {});
  assert.match(before.speech, /isn't connected/);

  const start = await call("connect_school", {});
  assert.equal(start.kind, "school_connect");
  const token = new URL(urls[0]).searchParams.get("token")!;
  const synced = (await school.completeConnect(token, undefined, "http://localhost:8787/school/oauth/callback", null)) as R;
  await schoolNotifiers.get(token)?.();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(completed.length, 1, "device is told the connection finished");

  assert.equal(synced.kind, "school_synced");
  assert.equal(synced.courses.length, 3);
  assert.ok(synced.newExams.some((e: string) => /Biology 10B/.test(e)), "the posted test became an exam");
  assert.equal(synced.studySets.length, 1, "teacher notes became a study set");
  const priya = store.get().learners.find((l) => l.name === "Priya")!;
  const bio = priya.exams.find((e) => /Biology/.test(e.title))!;
  assert.ok(bio.deckIds.length >= 1, "the study set is linked to the test");

  const hw = await call("school_homework", {});
  assert.ok(hw.items.some((i: R) => i.state === "missing"), "past-due work is surfaced");
  assert.match(hw.speech, /past due/);
  assert.match(hw.speech, /coming up/);

  const plan = await call("get_study_plan", { exam: "Biology" });
  assert.match(plan.title, /Biology 10B/);
  assert.equal(plan.mastery.length, 6);

  const today = await call("get_today");
  assert.match(today.speech, /From school/);

  const off = await call("disconnect_school", {});
  assert.equal(off.kind, "school_disconnected");
  assert.equal((store.get().schoolWork ?? []).length, 0, "synced data is deleted on disconnect");
});

it("under 13, only a parent can connect school", async () => {
  const { call } = await connect();
  await call("parent_setup", { parent_name: "Asha", relation: "Mom", child: "Leo", age: 9 });
  await call("switch_learner", { name: "Leo" });
  const blocked = await call("connect_school", {});
  assert.equal(blocked.kind, "error");
  assert.match(blocked.speech, /a parent connects school/);
  const ok = await call("connect_school", { learner: "Leo", parent_name: "Asha" });
  assert.equal(ok.kind, "school_connect");
  assert.equal(ok.by.role, "parent");
});

it("without Google keys there's no fake school: connecting says what's missing", async () => {
  const { schoolProviderFromEnv, NOT_SET_UP } = await import("../src/domain/school.ts");
  delete process.env.GOOGLE_CLIENT_ID;
  const store = new Store({ dir: null });
  const mentor = new Mentor(store);
  const school = new SchoolSync(mentor, schoolProviderFromEnv());
  mentor.school = school;
  const server = createStudyBuddyServer(mentor, { llm: null, school, publicUrl: "http://localhost:8787" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" }, { capabilities: { elicitation: { url: {} } } });
  await Promise.all([server.connect(a), client.connect(b)]);
  await client.callTool({ name: "set_up_learner", arguments: { name: "Priya", level: "Grade 10" } });
  const r = (await client.callTool({ name: "connect_school", arguments: {} })).structuredContent as Record<string, any>;
  assert.equal(r.kind, "error");
  assert.equal(r.speech, NOT_SET_UP);
});

it("asks Google only for read-only Classroom access and the age check; Drive is opt-in", async () => {
  const { googleScopes } = await import("../src/domain/school.ts");
  const scopes = googleScopes();
  assert.ok(scopes.every((s) => /classroom\.[a-z.]+readonly$|profile\.agerange\.read$|user\.birthday\.read$/.test(s)), "read-only: Classroom, age range, birthday");
  assert.ok(scopes.some((s) => s.endsWith("profile.agerange.read")), "the age check needs Google's age range");
  assert.ok(scopes.some((s) => s.endsWith("classroom.rosters.readonly")), "teacher names need rosters");
  assert.ok(!scopes.some((s) => s.includes("drive")));
  process.env.BUDDY_GOOGLE_DRIVE = "on";
  assert.ok(googleScopes().some((s) => s.endsWith("drive.readonly")));
  delete process.env.BUDDY_GOOGLE_DRIVE;
});

// A 13-year-old (or a 10-year-old) says "I'm 18". The age that counts is the one Google reports at sign-in.

const REDIRECT = "http://localhost:8787/school/oauth/callback";
const tokenOf = (url: string) => new URL(url).searchParams.get("token")!;

it("reads the grade from class names and weighs Google's age signals over what was said", () => {
  assert.equal(gradeFromCourses([{ name: "Grade 7 Science" }, { name: "Math", section: "8th grade" }]), 7);
  assert.equal(gradeFromCourses([{ name: "Class 6 English" }]), 6);
  assert.equal(gradeFromCourses([{ name: "Year 8 History" }]), 7, "UK Year 8 is US grade 7");
  assert.equal(gradeFromCourses([{ name: "Biology 10B", section: "Period 3" }]), undefined, "'10B' isn't a grade");
  const today = "2026-10-21";
  assert.deepEqual(judgeAge({ birthday: "2014-03-02" }, { age: 18, band: "college" }, today), { minor: true, under13: true, age: 12, basis: "the birthday on the Google account" });
  assert.equal(judgeAge({ range: "under18", grade: 9 }, { age: 18, band: "college" }, today).under13, false);
  assert.equal(judgeAge({ range: "under18" }, { age: 18, band: "college" }, today).under13, null, "said 18, Google says under 18: can't trust the claim");
  assert.equal(judgeAge({ range: "under18" }, { age: 15, band: "high" }, today).under13, false, "a teen claim that fits Google stands");
  assert.equal(judgeAge({ range: "21plus" }, { age: 18, band: "college" }, today).minor, false);
});

it("'I'm 18' but Google says under 18 and the classes are grade 7: a parent has to connect, nothing is kept", async () => {
  const { call, school, store, urls, provider, mentor } = await connect({ range: "under18", grade: 7 });
  await call("set_up_learner", { name: "Riya", level: "First year college", age: 18 });
  assert.equal(store.get().learners[0].age, 18);
  const start = await call("connect_school", {});
  assert.equal(start.kind, "school_connect", "the claim lets them start");
  const r = (await school.completeConnect(tokenOf(urls[0]), undefined, REDIRECT, null)) as R;
  assert.equal(r.kind, "school_needs_parent");
  assert.match(r.speech, /^I checked with Google\. .*under 13.*a parent needs to connect school, and I didn't keep anything\./);
  assert.equal((store.get().schoolConnections ?? []).length, 0, "not connected");
  assert.equal((store.get().schoolWork ?? []).length, 0, "nothing synced");
  assert.equal(provider.revoked, 1, "Google access handed back");
  const l = store.get().learners[0];
  assert.equal(l.age, undefined, "the 'I'm 18' claim is dropped");
  assert.equal(mentor.visibilityFor(l), "full", "a parent can see everything, as for any under-13");
  assert.equal(mentor.onlineGamesAllowed(l), false);
  assert.equal((await call("school_status")).kind, "school_needs_parent", "the device can say why");
  await call("set_up_learner", { name: "Riya", age: 19 });
  assert.equal(store.get().learners[0].age, undefined, "saying 19 now doesn't change it");
  const again = await call("connect_school", {});
  assert.match(again.speech, /a parent connects school/, "next time it asks for a parent straight away");
  const parent = await call("connect_school", { learner: "Riya", parent_name: "Meera" });
  assert.equal(parent.kind, "school_connect", "a parent can connect");
  const ok = (await school.completeConnect(tokenOf(urls.at(-1)!), undefined, REDIRECT, null)) as R;
  assert.equal(ok.kind, "school_synced");
});

it("a teen whose Google account agrees, or an adult account, connects as usual", async () => {
  const teen = await connect({ range: "under18", grade: 10 });
  await teen.call("set_up_learner", { name: "Sam", level: "Grade 10" });
  await teen.call("connect_school", {});
  const r = (await teen.school.completeConnect(tokenOf(teen.urls[0]), undefined, REDIRECT, null)) as R;
  assert.equal(r.kind, "school_synced");
  assert.equal(teen.mentor.visibilityFor(teen.store.get().learners[0]), "summary");

  const adult = await connect({ range: "21plus" });
  await adult.call("set_up_learner", { name: "Venkat", level: "Second year engineering" });
  await adult.call("connect_school", {});
  assert.equal(((await adult.school.completeConnect(tokenOf(adult.urls[0]), undefined, REDIRECT, null)) as R).kind, "school_synced");
  assert.equal(adult.mentor.visibilityFor(adult.store.get().learners[0]), "private");
});
