import assert from "node:assert/strict";
import test from "node:test";
import { autonamePrompt } from "../server/autoname.js";
import { phraseRewritePlan, rewritePlan } from "../server/generation-prompts.js";
import { countO200kPromptTextTokens } from "../server/openai-prompt-tokenizer.js";
import { PromptCacheBreakpointRegistry } from "../server/prompt-cache-breakpoints.js";
import {
  PROMPT_CACHE_POLICY_OFF,
  PromptCacheRuntime,
  type PromptCacheContext,
  promptCacheScope
} from "../server/provider-cache-policy.js";
import {
  buildAnthropicMessagesRequestBody,
  buildOpenAiChatRequestBody
} from "../server/provider-request-body.js";
import { summaryTakePrompt } from "../server/summary-take.js";
import { continuationPlan } from "../shared/continuation-plan.js";
import type { PromptPlan } from "../shared/prompt-plan.js";
import type { GenerationSettings, Story, StoryNode } from "../shared/types.js";
import { platformPerformanceBudget } from "./platform-performance-budget.js";

const PART_COUNT = 256;
const PART_CHARACTERS = 4_096;
const FACT_CHARACTERS = 128 * 1_024;
const ROUNDS = 25;
const CPU_BUDGET_MS = platformPerformanceBudget(8_000);
const REGISTRY_MUTATIONS = 25_000;
const REGISTRY_CAPACITY = 256;
const REQUEST_SETTINGS: GenerationSettings = {
  provider: "openai-compatible",
  baseUrl: "https://provider.example/v1",
  model: "benchmark",
  apiKeyEnv: null,
  temperature: 0.7,
  maxTokens: 2_048,
  systemPrompt: "unused",
  contextWindow: null
};
const OPENAI_EXPLICIT_CONTEXT: PromptCacheContext = {
  source: "settings-v2",
  policy: "auto",
  support: "supported",
  protocol: "openai-chat-completions",
  preset: "openai",
  remoteModelId: "gpt-5.6",
  adapter: "openai-official"
};
const ANTHROPIC_EXPLICIT_CONTEXT: PromptCacheContext = {
  source: "settings-v2",
  policy: "auto",
  support: "supported",
  protocol: "anthropic-messages",
  preset: "anthropic",
  remoteModelId: "claude-opus-4-8",
  adapter: "anthropic-official"
};

test("cold o200k tokenizer initialization remains bounded", { timeout: 30_000 }, (t) => {
  const cpuStart = process.cpuUsage();
  const wallStart = performance.now();
  const tokens = countO200kPromptTextTokens(["hello world"]);
  const cpu = process.cpuUsage(cpuStart);
  const cpuMs = (cpu.user + cpu.system) / 1_000;
  const wallMs = performance.now() - wallStart;

  assert.equal(tokens, 2);
  assert.ok(
    cpuMs < CPU_BUDGET_MS,
    `cold o200k initialization used ${cpuMs.toFixed(1)}ms CPU; budget is ${CPU_BUDGET_MS}ms`
  );
  t.diagnostic(`cold o200k initialization: ${cpuMs.toFixed(1)}ms CPU, ${wallMs.toFixed(1)}ms wall`);
});

test("prompt planning and request lowering stay linear for a 1 MiB transcript", { timeout: 30_000 }, (t) => {
  const story = largeStory();
  const facts = `CANONICAL STORY FACTS\n${"fact-value ".repeat(Math.ceil(FACT_CHARACTERS / 11)).slice(0, FACT_CHARACTERS)}`;
  const targetPart = story.nodes[Math.floor(story.nodes.length / 2)]!;
  const start = 2_000;
  const expected = targetPart.text.slice(start, start + 96);
  const builders: Array<() => PromptPlan> = [
    () => continuationPlan(
      "Keep the prose concrete and observant.",
      facts,
      story.nodes,
      "Follow the sound beyond the gate.",
      false,
      true,
      "ct-benchmark",
      [],
      story.nodes
    ).prompt,
    () => rewritePlan({
      story,
      facts,
      partId: targetPart.id,
      start,
      end: start + expected.length,
      expected,
      instruction: "Make the moment more ominous.",
      lengthTarget: "Length: about sixteen words.",
      authorBrief: "Keep the prose concrete and observant.",
      tag: "rw-benchmark",
      assistantPrefill: false
    }).prompt,
    () => phraseRewritePlan({
      story,
      facts,
      partId: targetPart.id,
      start,
      end: start + expected.length,
      expected,
      instruction: "Make the moment more ominous.",
      lengthTarget: "Length: about sixteen words.",
      authorBrief: "Keep the prose concrete and observant.",
      tag: "rw-benchmark",
      passage: true
    }).prompt,
    () => autonamePrompt(story, "Keep the prose concrete and observant.", 24_000, facts).prompt,
    () => summaryTakePrompt(story.title, story.nodes, 4_096, "benchmark")
  ];

  for (const build of builders) {
    const prompt = build();
    buildOpenAiChatRequestBody(REQUEST_SETTINGS, prompt, PROMPT_CACHE_POLICY_OFF);
    buildAnthropicMessagesRequestBody(REQUEST_SETTINGS, prompt, PROMPT_CACHE_POLICY_OFF);
  }
  let loweredCharacters = 0;
  const cpuStart = process.cpuUsage();
  const wallStart = performance.now();
  for (let round = 0; round < ROUNDS; round += 1) {
    for (const build of builders) {
      const prompt = build();
      loweredCharacters += JSON.stringify(
        buildOpenAiChatRequestBody(REQUEST_SETTINGS, prompt, PROMPT_CACHE_POLICY_OFF)
      ).length;
      loweredCharacters += JSON.stringify(
        buildAnthropicMessagesRequestBody(REQUEST_SETTINGS, prompt, PROMPT_CACHE_POLICY_OFF)
      ).length;
    }
  }
  const cpu = process.cpuUsage(cpuStart);
  const cpuMs = (cpu.user + cpu.system) / 1_000;
  const wallMs = performance.now() - wallStart;

  assert.ok(loweredCharacters > 160_000_000, "benchmark must exercise lowered provider bytes");
  assert.ok(
    cpuMs < CPU_BUDGET_MS,
    `prompt-plan construction used ${cpuMs.toFixed(1)}ms CPU; budget is ${CPU_BUDGET_MS}ms`
  );
  t.diagnostic(
    `${ROUNDS} rounds × ${builders.length} paths: ${cpuMs.toFixed(1)}ms CPU, ${wallMs.toFixed(1)}ms wall`
  );
});

test("cache-scope derivation remains bounded and independent of prompt size", (t) => {
  const cpuStart = process.cpuUsage();
  let characters = 0;
  for (let index = 0; index < 20_000; index += 1) {
    characters += promptCacheScope(`story-${index}`, "continue").length;
  }
  const cpu = process.cpuUsage(cpuStart);
  const cpuMs = (cpu.user + cpu.system) / 1_000;
  assert.equal(characters, 20_000 * 79);
  assert.ok(cpuMs < platformPerformanceBudget(2_000), `20,000 cache scopes used ${cpuMs.toFixed(1)}ms CPU`);
  t.diagnostic(`20,000 cache scopes: ${cpuMs.toFixed(1)}ms CPU`);
});

test(
  "warmed exact GPT-5.6 rolling planning and structured lowering stay bounded at 1 MiB",
  { timeout: 60_000 },
  (t) => {
    const story = largeStory();
    const priorPrompt = continuationBenchmarkPrompt(story.nodes.slice(0, -1));
    const currentPrompt = continuationBenchmarkPrompt(story.nodes);
    const scope = promptCacheScope(story.id, "continue");
    const settings = { ...REQUEST_SETTINGS, model: "gpt-5.6" };

    const warmRuntime = new PromptCacheRuntime({ registryCapacity: 4 });
    warmRuntime.prepare(OPENAI_EXPLICIT_CONTEXT, scope, priorPrompt).commit();

    const planningCpuStart = process.cpuUsage();
    const planningWallStart = performance.now();
    const warmPlan = warmRuntime.prepare(OPENAI_EXPLICIT_CONTEXT, scope, currentPrompt);
    const planningCpu = process.cpuUsage(planningCpuStart);
    const planningCpuMs = (planningCpu.user + planningCpu.system) / 1_000;
    const planningWallMs = performance.now() - planningWallStart;

    assert.equal(warmPlan.wire.kind, "openai-explicit");
    assert.equal(warmPlan.wire.breakpoints.length, 2);
    const warmBody = JSON.stringify(
      buildOpenAiChatRequestBody(settings, currentPrompt, warmPlan.wire)
    );
    assert.equal(occurrences(warmBody, '"prompt_cache_breakpoint"'), 2);
    assert.ok(
      planningCpuMs < CPU_BUDGET_MS,
      `exact rolling cache planning used ${planningCpuMs.toFixed(1)}ms CPU; `
      + `budget is ${CPU_BUDGET_MS}ms`
    );

    let loweredCharacters = 0;
    const cpuStart = process.cpuUsage();
    const wallStart = performance.now();
    for (let round = 0; round < ROUNDS; round += 1) {
      loweredCharacters += JSON.stringify(
        buildOpenAiChatRequestBody(settings, currentPrompt, warmPlan.wire)
      ).length;
    }
    const cpu = process.cpuUsage(cpuStart);
    const cpuMs = (cpu.user + cpu.system) / 1_000;
    const wallMs = performance.now() - wallStart;
    warmPlan.commit();

    assert.ok(loweredCharacters > 25_000_000, "benchmark must lower the full cached prompt");
    assert.ok(
      cpuMs < CPU_BUDGET_MS,
      `structured OpenAI lowering used ${cpuMs.toFixed(1)}ms CPU; budget is ${CPU_BUDGET_MS}ms`
    );
    t.diagnostic(
      `warmed GPT-5.6 rolling plan: ${planningCpuMs.toFixed(1)}ms CPU, `
      + `${planningWallMs.toFixed(1)}ms wall; ${ROUNDS} structured lowerings: `
      + `${cpuMs.toFixed(1)}ms CPU, ${wallMs.toFixed(1)}ms wall`
    );
  }
);

test(
  "unchanged GPT-5.6 stable prefixes reuse token qualification at 1 MiB",
  { timeout: 30_000 },
  (t) => {
    const story = largeStory();
    const prompt = continuationBenchmarkPrompt(story.nodes);
    const scope = promptCacheScope(story.id, "continue");
    let tokenCounts = 0;
    const runtime = new PromptCacheRuntime({
      countOpenAiTokens: (contents) => {
        tokenCounts += 1;
        return countO200kPromptTextTokens(contents);
      }
    });
    runtime.prepare(OPENAI_EXPLICIT_CONTEXT, scope, prompt).commit();
    assert.equal(tokenCounts, 1);
    tokenCounts = 0;

    const cpuStart = process.cpuUsage();
    const wallStart = performance.now();
    for (let round = 0; round < ROUNDS; round += 1) {
      runtime.prepare(OPENAI_EXPLICIT_CONTEXT, scope, prompt).commit();
    }
    const cpu = process.cpuUsage(cpuStart);
    const cpuMs = (cpu.user + cpu.system) / 1_000;
    const wallMs = performance.now() - wallStart;

    assert.equal(tokenCounts, 0, "registry-qualified prefixes must not be retokenized");
    assert.ok(
      cpuMs < platformPerformanceBudget(2_000),
      `unchanged cached-prefix planning used ${cpuMs.toFixed(1)}ms CPU`
    );
    t.diagnostic(
      `${ROUNDS} unchanged 1 MiB plans: ${cpuMs.toFixed(1)}ms CPU, `
      + `${wallMs.toFixed(1)}ms wall, 0 tokenizer calls`
    );
  }
);

test("Anthropic structured cached lowering stays bounded at 1 MiB", { timeout: 30_000 }, (t) => {
  const story = largeStory();
  const prompt = continuationBenchmarkPrompt(story.nodes);
  const scope = promptCacheScope(story.id, "continue");
  const settings = { ...REQUEST_SETTINGS, model: "claude-opus-4-8" };
  const runtime = new PromptCacheRuntime();

  const warmPlan = runtime.prepare(ANTHROPIC_EXPLICIT_CONTEXT, scope, prompt);
  assert.equal(warmPlan.wire.kind, "anthropic-explicit");
  const warmBody = JSON.stringify(
    buildAnthropicMessagesRequestBody(settings, prompt, warmPlan.wire)
  );
  assert.equal(occurrences(warmBody, '"cache_control"'), 1);

  let loweredCharacters = 0;
  const cpuStart = process.cpuUsage();
  const wallStart = performance.now();
  for (let round = 0; round < ROUNDS; round += 1) {
    const plan = runtime.prepare(ANTHROPIC_EXPLICIT_CONTEXT, scope, prompt);
    loweredCharacters += JSON.stringify(
      buildAnthropicMessagesRequestBody(settings, prompt, plan.wire)
    ).length;
  }
  const cpu = process.cpuUsage(cpuStart);
  const cpuMs = (cpu.user + cpu.system) / 1_000;
  const wallMs = performance.now() - wallStart;

  assert.ok(loweredCharacters > 25_000_000, "benchmark must lower the full cached prompt");
  assert.ok(
    cpuMs < CPU_BUDGET_MS,
    `Anthropic cached lowering used ${cpuMs.toFixed(1)}ms CPU; budget is ${CPU_BUDGET_MS}ms`
  );
  t.diagnostic(
    `${ROUNDS} Anthropic cached lowerings: ${cpuMs.toFixed(1)}ms CPU, ${wallMs.toFixed(1)}ms wall`
  );
});

test("prompt-cache registry remains capped through 25,000 mutations and evictions", (t) => {
  const registry = new PromptCacheBreakpointRegistry(REGISTRY_CAPACITY);
  const cpuStart = process.cpuUsage();
  for (let index = 0; index < REGISTRY_MUTATIONS; index += 1) {
    registry.commit(`scope-${index}`, `boundary-${index}`);
  }
  const cpu = process.cpuUsage(cpuStart);
  const cpuMs = (cpu.user + cpu.system) / 1_000;
  const firstRetained = REGISTRY_MUTATIONS - REGISTRY_CAPACITY;

  assert.equal(registry.size, REGISTRY_CAPACITY);
  assert.equal(registry.previous(`scope-${firstRetained - 1}`), null);
  assert.equal(
    registry.previous(`scope-${firstRetained}`),
    `boundary-${firstRetained}`
  );
  assert.equal(
    registry.previous(`scope-${REGISTRY_MUTATIONS - 1}`),
    `boundary-${REGISTRY_MUTATIONS - 1}`
  );
  assert.equal(registry.hashes().length, REGISTRY_CAPACITY);
  assert.ok(cpuMs < platformPerformanceBudget(2_000), `25,000 registry mutations used ${cpuMs.toFixed(1)}ms CPU`);
  t.diagnostic(
    `${REGISTRY_MUTATIONS.toLocaleString()} registry mutations: `
    + `${cpuMs.toFixed(1)}ms CPU, cap ${registry.size}`
  );
});

function continuationBenchmarkPrompt(nodes: readonly StoryNode[]): PromptPlan {
  const facts = `CANONICAL STORY FACTS\n${
    "fact-value ".repeat(Math.ceil(FACT_CHARACTERS / 11)).slice(0, FACT_CHARACTERS)
  }`;
  return continuationPlan(
    "Keep the prose concrete and observant.",
    facts,
    nodes,
    "Follow the sound beyond the gate.",
    false,
    true,
    "ct-cache-benchmark",
    [],
    nodes
  ).prompt;
}

function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

function largeStory(): Story {
  const nodes: StoryNode[] = Array.from({ length: PART_COUNT }, (_, index) => {
    const phrase = `part-${index.toString().padStart(3, "0")} rain lantern cobblestone `;
    const text = phrase.repeat(Math.ceil(PART_CHARACTERS / phrase.length)).slice(0, PART_CHARACTERS);
    return {
      id: `part-${index}`,
      parentId: index === 0 ? null : `part-${index - 1}`,
      activeChildId: index + 1 === PART_COUNT ? null : `part-${index + 1}`,
      instruction: `Continue part ${index}.`,
      text,
      model: "benchmark",
      createdAt: "2025-01-01T00:00:00.000Z"
    };
  });
  return {
    id: "story-benchmark",
    title: "Benchmark Story",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    facts: [],
    nodes,
    activeRootId: nodes[0]!.id,
    tags: [],
    recentNodeIds: [],
    chapterBreaks: []
  };
}
