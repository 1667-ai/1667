/**
 * Configurable-prompt runtime: default request bytes, guidance placement,
 * adapter lowering, Continue direction, genuine append, and summary branches.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { autonamePrompt } from "../server/autoname.js";
import { rewritePlan, phraseRewritePlan } from "../server/generation-prompts.js";
import {
  buildAnthropicMessagesRequestBody,
  buildOpenAiChatRequestBody
} from "../server/provider-request-body.js";
import {
  attachProviderRuntime,
  type ProviderRuntime
} from "../server/provider-runtime.js";
import { summaryTakePrompt } from "../server/summary-take.js";
import { asidePlan } from "../shared/aside-plan.js";
import { continuationPlan } from "../shared/continuation-plan.js";
import { renderPromptPlan, type PromptPlan } from "../shared/prompt-plan.js";
import {
  EMPTY_SAMPLING_V2,
  GENERATION_EFFORT_V2_VALUES,
  type GenerationEffortV2
} from "../shared/settings-v2-types.js";
import { renderTextPrompt } from "../shared/text-prompt.js";
import type { GenerationSettings, Story, StoryNode } from "../shared/types.js";
import { generationEffortChoicesForTarget } from "../shared/generation-effort-capabilities.js";

const OMIT = { kind: "omit" as const, reason: "policy-off" as const };
const GUIDANCE = "Prefer short verbs.";
const CONTINUE = "Keep walking west.";

test("default writing adds no optional guidance and keeps Continue request bytes", () => {
  const parts = [part("Open.", "The latch clicked.")];
  const def = continuationPlan(
    "Write vivid prose.", null, null, parts, "Continue the story.", false, true, "ct-def", [], parts
  );
  const customEmpty = continuationPlan(
    "Write vivid prose.", null, null, parts, "Continue the story.", false, true, "ct-def", [], parts
  );
  assert.equal(canonicalPrompt(def.prompt), canonicalPrompt(customEmpty.prompt));
  assert.deepEqual(renderPromptPlan(def.prompt).at(-1), {
    role: "user",
    content: "Continue the story."
  });
});

test("nonempty operation guidance sits in its own system turn immediately before the contract", () => {
  const rewriteStory = fixture("The lantern dimmed.");
  const withGuidance = rewritePlan({
    story: rewriteStory,
    facts: null,
    partId: "part-1",
    start: 4,
    end: 11,
    expected: "lantern",
    instruction: "Sharpen it.",
    lengthTarget: "Length: one word.",
    authorBrief: "Write.",
    tag: "rw-g",
    assistantPrefill: false,
    guidance: GUIDANCE
  });
  const without = rewritePlan({
    story: rewriteStory,
    facts: null,
    partId: "part-1",
    start: 4,
    end: 11,
    expected: "lantern",
    instruction: "Sharpen it.",
    lengthTarget: "Length: one word.",
    authorBrief: "Write.",
    tag: "rw-g",
    assistantPrefill: false
  });
  const guided = renderPromptPlan(withGuidance.prompt);
  const baseline = renderPromptPlan(without.prompt);
  const guidanceIndex = guided.findIndex((message) => message.content === GUIDANCE);
  const contractIndex = guided.findIndex((message) => message.content.includes("skilled fiction editor"));
  assert.ok(guidanceIndex >= 0);
  assert.equal(guided[guidanceIndex]!.role, "system");
  assert.equal(guidanceIndex + 1, contractIndex);
  assert.equal(guided[contractIndex]!.content, baseline[contractIndex - 1]!.content);
  assert.equal(canonicalPrompt(without.prompt), canonicalPrompt(rewritePlan({
    ...rewriteArgs(rewriteStory),
    guidance: ""
  }).prompt));
});

test("title, summary, and Aside guidance apply only to their operations", () => {
  const story = fixture("Rain crossed the window.");
  const title = renderPromptPlan(autonamePrompt(story, "Write.", undefined, null, GUIDANCE).prompt);
  const summary = renderPromptPlan(summaryTakePrompt(story.title, story.nodes, 512, "aaaaaaaa", GUIDANCE));
  const aside = renderPromptPlan(asidePlan({
    facts: null,
    parts: story.nodes,
    chapterBreaks: [],
    nodes: story.nodes,
    history: [],
    question: "Why rain?",
    usableTokens: null,
    guidance: GUIDANCE
  }));
  const continueMessages = renderPromptPlan(continuationPlan(
    "Write.", null, null, story.nodes, "Continue the story.", false, true, "ct-x", [], story.nodes
  ).prompt);
  assert.equal(title.some((message) => message.content === GUIDANCE), true);
  assert.equal(summary.some((message) => message.content === GUIDANCE), true);
  assert.equal(aside.some((message) => message.content === GUIDANCE), true);
  assert.equal(continueMessages.some((message) => message.content === GUIDANCE), false);
  assert.equal(title[title.findIndex((message) => message.content === GUIDANCE) + 1]!.content.includes("literary title editor"), true);
  assert.equal(summary[0]!.content, GUIDANCE);
  assert.equal(summary[1]!.content.includes("continuity editor"), true);
  assert.equal(aside[0]!.content, GUIDANCE);
  assert.equal(aside[1]!.content.includes("Aside mode"), true);
});

test("summary-take and chapter-summary share the same guidance placement", () => {
  const parts = [part("Open.", "The first chapter ended at dusk.")];
  const take = renderPromptPlan(summaryTakePrompt("River", parts, 400, "11111111", GUIDANCE));
  const chapter = renderPromptPlan(summaryTakePrompt("River", parts, 400, "22222222", GUIDANCE));
  assert.equal(take[0]!.content, GUIDANCE);
  assert.equal(chapter[0]!.content, GUIDANCE);
  assert.equal(take[1]!.content, chapter[1]!.content);
});

test("a genuine append does not gain Continue direction", () => {
  const parts = [part("Open the door.", "The latch was unlo")];
  const append = continuationPlan(
    "Write.", null, null, parts, CONTINUE, true, true, "ct-ap", [], parts
  );
  const messages = renderPromptPlan(append.prompt);
  assert.equal(messages.at(-1)?.role, "assistant");
  assert.equal(messages.some((message) => message.content === CONTINUE), false);
  assert.equal(messages.some((message) => /unfinished passage/.test(message.content)), true);
});

test("empty Continue uses the configured default; a supplied direction wins", () => {
  const parts = [part("Open.", "The door opened.")];
  const fallback = continuationPlan(
    "Write.", null, null, parts, CONTINUE, false, true, "ct-fb", [], parts
  );
  const override = continuationPlan(
    "Write.", null, null, parts, "Turn toward the river.", false, true, "ct-ov", [], parts
  );
  assert.deepEqual(renderPromptPlan(fallback.prompt).at(-1), { role: "user", content: CONTINUE });
  assert.deepEqual(renderPromptPlan(override.prompt).at(-1), {
    role: "user",
    content: "Turn toward the river."
  });
});

test("legacy empty saved directions still rebuild with Continue the story.", () => {
  const parts = [part("", "The door opened.")];
  const messages = renderPromptPlan(continuationPlan(
    "Write.", null, null, parts, CONTINUE, false, true, "ct-leg", [], parts
  ).prompt);
  assert.equal(messages.some((message) => message.content === "Continue the story."), true);
});

test("default prompts lower to identical bodies across adapters and supported efforts", async () => {
  const parts = [part("Open.", "The latch clicked.")];
  const prompt = continuationPlan(
    "Write vivid prose.",
    null,
    null,
    parts,
    "Continue the story.",
    false,
    true,
    "ct-ad",
    [],
    parts
  ).prompt;
  const rewrite = rewritePlan(rewriteArgs(fixture("The lantern dimmed."))).prompt;
  const title = autonamePrompt(fixture("Rain crossed the window."), "Write.").prompt;
  const summary = summaryTakePrompt("Story", parts, 512, "aaaaaaaa");
  const aside = asidePlan({
    facts: null,
    parts,
    chapterBreaks: [],
    nodes: parts,
    history: [],
    question: "Why?",
    usableTokens: null
  });
  const plans = [
    ["continue", prompt],
    ["rewrite", rewrite],
    ["title", title],
    ["summary", summary],
    ["aside", aside]
  ] as const;

  for (const [name, plan] of plans) {
    const rendered = JSON.stringify(renderPromptPlan(plan));
    const chatml = renderTextPrompt(plan, "chatml");
    const raw = renderTextPrompt(plan, "raw");
    let previousOpenAiMessages: string | undefined;
    for (const effort of GENERATION_EFFORT_V2_VALUES) {
      const openAi = await buildOpenAiChatRequestBody(
        withEffort(settings("openai-compatible"), effort),
        plan,
        OMIT
      );
      const messages = JSON.stringify(openAi.messages);
      assert.equal(messages, rendered, name);
      if (previousOpenAiMessages !== undefined) {
        assert.equal(messages, previousOpenAiMessages, `${name} openai messages stay identical across effort`);
      }
      previousOpenAiMessages = messages;
    }
    let previousAnthropicPrompt: string | undefined;
    for (const effort of generationEffortChoicesForTarget({
      protocol: "anthropic-messages",
      reasoningEffort: "supported"
    })) {
      const anthropic = await buildAnthropicMessagesRequestBody(
        withEffort(settings("anthropic"), effort),
        plan,
        OMIT
      );
      const contents = JSON.stringify(anthropic);
      assert.equal(contents.includes(GUIDANCE), false, name);
      if (previousAnthropicPrompt !== undefined) {
        assert.equal(
          JSON.stringify(anthropic.messages ?? anthropic.system),
          previousAnthropicPrompt,
          `${name} anthropic prompt stays identical across effort`
        );
      }
      previousAnthropicPrompt = JSON.stringify(anthropic.messages ?? anthropic.system);
    }
    assert.match(chatml, /<\|im_start\|>/);
    assert.notEqual(raw.length, 0);
  }
});

test("nonempty guidance is present in every adapter body and does not replace the contract", async () => {
  const rewrite = rewritePlan({
    ...rewriteArgs(fixture("The lantern dimmed.")),
    guidance: GUIDANCE
  }).prompt;
  const openAi = await buildOpenAiChatRequestBody(
    withEffort(settings("openai-compatible"), "high"),
    rewrite,
    OMIT
  );
  const anthropic = await buildAnthropicMessagesRequestBody(
    withEffort(settings("anthropic"), "low"),
    rewrite,
    OMIT
  );
  const chatml = renderTextPrompt(rewrite, "chatml");
  const messages = openAi.messages as Array<{ role: string; content: string }>;
  const guidanceIndex = messages.findIndex((message) => message.content === GUIDANCE);
  assert.equal(messages[guidanceIndex]!.role, "system");
  assert.match(messages[guidanceIndex + 1]!.content, /skilled fiction editor/);
  assert.match(JSON.stringify(anthropic), /Prefer short verbs/);
  assert.match(JSON.stringify(anthropic), /skilled fiction editor/);
  assert.match(chatml, /Prefer short verbs/);
  assert.match(chatml, /skilled fiction editor/);
});

test("bare rewrite guidance still precedes the fixed contract", () => {
  const plan = phraseRewritePlan({
    story: fixture("The lantern dimmed."),
    facts: null,
    partId: "part-1",
    start: 4,
    end: 11,
    expected: "lantern",
    instruction: "",
    lengthTarget: "Length: one word.",
    authorBrief: "Write.",
    tag: "rw-bare",
    passage: true,
    guidance: GUIDANCE
  });
  const messages = renderPromptPlan(plan.prompt);
  const guidanceIndex = messages.findIndex((message) => message.content === GUIDANCE);
  assert.ok(guidanceIndex >= 0);
  assert.match(messages[guidanceIndex + 1]!.content, /skilled fiction editor/);
});

function canonicalPrompt(plan: PromptPlan): string {
  return createHash("sha256").update(JSON.stringify(renderPromptPlan(plan)), "utf8").digest("hex");
}

function rewriteArgs(story: Story) {
  return {
    story,
    facts: null,
    partId: "part-1",
    start: 4,
    end: 11,
    expected: "lantern",
    instruction: "Sharpen it.",
    lengthTarget: "Length: one word.",
    authorBrief: "Write.",
    tag: "rw-g",
    assistantPrefill: false
  };
}

function part(instruction: string, text: string): StoryNode {
  return {
    id: "part-1",
    parentId: null,
    instruction,
    text,
    model: "test",
    createdAt: "2026-01-01T00:00:00.000Z",
    activeChildId: null
  };
}

function fixture(text: string): Story {
  return {
    id: "story-1",
    title: "Test",
    facts: [],
    nodes: [part("Write it.", text)],
    activeRootId: "part-1",
    tags: [],
    recentNodeIds: [],
    chapterBreaks: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function settings(provider: GenerationSettings["provider"]): GenerationSettings {
  return {
    provider,
    baseUrl: "https://provider.example/v1",
    model: "model-fixture",
    apiKeyEnv: null,
    temperature: 0.25,
    maxTokens: 321,
    systemPrompt: "unused",
    contextWindow: null
  };
}

function withEffort(
  value: GenerationSettings,
  effort: GenerationEffortV2,
  reasoningEffort: ProviderRuntime["capabilities"]["reasoningEffort"] = "supported"
): GenerationSettings {
  return attachProviderRuntime(value, {
    preset: "custom",
    auth: { type: "none" },
    headers: [],
    timeouts: {
      responseHeaderMs: 1_000,
      firstTokenMs: 1_000,
      idleMs: 1_000,
      totalMs: 5_000
    },
    allowInsecureHttp: false,
    effort,
    tokenProbabilities: null,
    sampling: EMPTY_SAMPLING_V2,
    capabilities: {
      temperature: "supported",
      assistantPrefill: "unknown",
      reasoningEffort,
      promptCaching: "unknown"
    }
  }, true);
}
