import assert from "node:assert/strict";
import { it } from "node:test";
import type { ConverseCommand, ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import { modelLabel, speakable } from "../../../packages/mcp-server/src/domain/bedrock.ts";
import { DirectLlm, parseJson } from "../../../packages/mcp-server/src/domain/llm.ts";
import { BedrockAgent } from "../src/agent-bedrock.ts";

type R = Record<string, any>;

/** A fake Bedrock that replays scripted Converse responses and records every request. */
function fakeBedrock(replies: (ConverseCommandOutput | Error)[]) {
  const sent: R[] = [];
  return {
    sent,
    async send(cmd: ConverseCommand) {
      sent.push(structuredClone(cmd.input) as R);
      const r = replies.shift();
      if (!r) throw new Error("no scripted reply");
      if (r instanceof Error) throw r;
      return r;
    },
  };
}
const reply = (content: R[], stopReason: string) => ({ output: { message: { role: "assistant", content } }, stopReason, $metadata: {} }) as unknown as ConverseCommandOutput;

const ctx = (calls: R[]) => ({
  mcp: {
    instructions: "Server instructions here.",
    tools: [{ name: "start_quiz", description: "Start a spoken quiz.", inputSchema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: { topic: { type: "string" } } } }],
  },
  callTool: async (name: string, args: R) => {
    calls.push({ name, args });
    return { content: [{ type: "text", text: JSON.stringify({ kind: "quiz_question", speech: "Question one." }) }] };
  },
}) as never;

it("reads slightly broken JSON from smaller models", () => {
  // An invalid \' escape, a raw line break inside a string, and a trailing comma, wrapped in a code fence.
  const broken = "```json\n" + String.raw`{"title": "Bo\'s brave night", "pages": ["Line one` + "\n" + String.raw`line two", "It\'s okay",], "question": "Why?"}` + "\n```";
  assert.deepEqual(parseJson(broken), { title: "Bo's brave night", pages: ["Line one\nline two", "It's okay"], question: "Why?" });
});

it("cleans replies for the ear", () => {
  assert.equal(speakable("Great choice! 🦖💥 Here's what helps:\n- Talk to a teacher\n- Join a game\n1. **Breathe**"), "Great choice! Here's what helps. Talk to a teacher. Join a game. Breathe.");
});

it("drops markdown dividers from spoken replies", () => {
  assert.equal(speakable("Got it! Mitosis instead.\n---\nMitosis as a backup plan."), "Got it! Mitosis instead. Mitosis as a backup plan.");
  assert.equal(speakable("Got it! ---. Next part."), "Got it! Next part.");
});

it("names Bedrock models for people", () => {
  assert.equal(modelLabel("us.amazon.nova-2-lite-v1:0"), "Amazon Nova 2 Lite");
  assert.equal(modelLabel("us.amazon.nova-pro-v1:0"), "Amazon Nova Pro");
  assert.equal(modelLabel("anthropic.claude-x"), "anthropic.claude-x");
});

it("Nova on Bedrock: calls MCP tools through Converse, returns results, speaks without its thinking notes", async () => {
  const bedrock = fakeBedrock([
    reply([{ text: "<thinking>The learner wants a quiz.</thinking>" }, { toolUse: { toolUseId: "t1", name: "start_quiz", input: { topic: "cells" } } }], "tool_use"),
    reply([{ text: "<thinking>Ask it.</thinking> Okay Priya, question one!" }], "end_turn"),
  ]);
  const agent = new BedrockAgent({ model: "us.amazon.nova-2-lite-v1:0", genModel: "us.amazon.nova-2-lite-v1:0", skills: [{ name: "s", description: "", instructions: "Skill text." }] as never, client: bedrock });
  assert.equal(agent.label, "Amazon Nova 2 Lite on Amazon Bedrock");
  agent.note("The learner shared notes.");
  const calls: R[] = [];
  const said = await agent.turn(ctx(calls), "Quiz me on cells");

  assert.equal(said, "Okay Priya, question one!");
  assert.deepEqual(calls, [{ name: "start_quiz", args: { topic: "cells" } }]);
  const first = bedrock.sent[0];
  assert.equal(first.modelId, "us.amazon.nova-2-lite-v1:0");
  assert.match(first.system[0].text, /Skill text\.[\s\S]*This device[\s\S]*Server instructions here/);
  assert.match(first.messages[0].content[0].text, /^\(The learner shared notes\.\)\n\nQuiz me on cells\n\n\[Voice device: /);
  assert.equal(first.toolConfig.tools[0].toolSpec.name, "start_quiz");
  assert.equal(first.toolConfig.tools[0].toolSpec.inputSchema.json.$schema, undefined, "JSON Schema dialect stripped");
  assert.equal(first.inferenceConfig.temperature, 0);
  const second = bedrock.sent[1];
  assert.deepEqual(second.messages.map((m: R) => m.role), ["user", "assistant", "user"]);
  const result = second.messages[2].content[0].toolResult;
  assert.equal(result.toolUseId, "t1");
  assert.equal(result.status, "success");
  assert.match(result.content[0].text, /quiz_question/);
});

it("keeps the conversation valid after a failed turn, and answers sampling with the generation model", async () => {
  const bedrock = fakeBedrock([new Error("ThrottlingException"), reply([{ text: "Hi again!" }], "end_turn"), reply([{ text: "Generated deck" }], "end_turn")]);
  const agent = new BedrockAgent({ model: "us.amazon.nova-2-lite-v1:0", genModel: "us.amazon.nova-pro-v1:0", skills: [], client: bedrock });
  await assert.rejects(agent.turn(ctx([]), "hello"), /Throttling/);
  assert.equal(await agent.turn(ctx([]), "hello?"), "Hi again!");
  assert.deepEqual(bedrock.sent[1].messages.map((m: R) => m.role), ["user"], "the failed turn was rolled back");

  const sampled = await agent.sample({ messages: [{ role: "user", content: { type: "text", text: "Make a deck" } }], systemPrompt: "You write decks.", maxTokens: 3000 });
  assert.equal((sampled.content as R).text, "Generated deck");
  assert.equal(bedrock.sent[2].modelId, "us.amazon.nova-pro-v1:0");
  assert.equal(bedrock.sent[2].system[0].text, "You write decks.");
});

it("the server's own model also runs on Bedrock and refuses cleanly when a guardrail blocks", async () => {
  const bedrock = fakeBedrock([reply([{ text: "{\"ok\":true}" }], "end_turn"), reply([{ text: "" }], "guardrail_intervened")]);
  const llm = new DirectLlm("bedrock", "us.amazon.nova-2-lite-v1:0", bedrock);
  assert.equal(llm.name, "Amazon Nova 2 Lite on Amazon Bedrock");
  assert.equal(await llm.complete({ purpose: "test", system: "sys", prompt: "go" }), "{\"ok\":true}");
  await assert.rejects(llm.complete({ purpose: "test", system: "sys", prompt: "go" }), /declined/);
});

it("collects cited sources from a web-grounded Nova reply", async () => {
  const { converseResearch } = await import("../../../packages/mcp-server/src/domain/bedrock.ts");
  const bedrock = fakeBedrock([
    reply([
      { text: "CRISPR treats sickle cell disease." },
      { citationsContent: { citations: [{ location: { web: { url: "https://www.nih.gov/crispr", domain: "www.nih.gov" } } }] } },
      { text: "It was approved in 2023." },
      { citationsContent: { citations: [{ location: { web: { url: "https://www.fda.gov/x", domain: "www.fda.gov" } } }, { location: { web: { url: "https://www.nih.gov/crispr", domain: "www.nih.gov" } } }] } },
    ] as R[], "end_turn"),
  ]);
  const r = await converseResearch(bedrock, { modelId: "us.amazon.nova-2-lite-v1:0", prompt: "CRISPR" });
  assert.equal(r.text, "CRISPR treats sickle cell disease.\nIt was approved in 2023.");
  assert.deepEqual(r.sources.map((s) => s.domain), ["www.nih.gov", "www.fda.gov"], "deduplicated, in order");
  assert.equal(bedrock.sent[0].toolConfig.tools[0].systemTool.name, "nova_grounding");
});
