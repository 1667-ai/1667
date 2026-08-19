import assert from "node:assert/strict";
import test from "node:test";
import {
  AnchoredOutputFilter,
  continuationPlan,
  rewritePlan,
  supportsAssistantPrefill
} from "../server/generation-prompts.js";
import {
  attachProviderRuntime,
  providerRuntimeFor
} from "../server/provider-runtime.js";
import { renderPromptPlan, type PromptPlan } from "../shared/prompt-plan.js";
import type { Story, StoryNode } from "../shared/types.js";

test("empty Continue ends on the unfinished assistant passage", () => {
  const parts = [part("Open the door.", "The latch was unlo")];
  const messages = rendered(continuationPlan(
    "Write vivid prose.", null, null, parts, "Continue the story.", true, true, "ct-test", [], parts
  ));

  assert.equal(messages.at(-1)?.role, "assistant");
  assert.equal(messages.at(-1)?.content, "The latch was unlo");
  assert.equal(messages.some((message) => /exact final character/.test(message.content)), true);
  assert.equal(messages.some((message) => message.role === "user" && /final character/i.test(message.content)), false);
});

test("requested continuation remains a new user turn", () => {
  const messages = rendered(continuationPlan(
    "Write vivid prose.",
    null,
    null,
    [part("Open the door.", "The latch clicked.")],
    "A stranger enters.",
    false,
    true,
    "ct-test",
    [],
    [part("Open the door.", "The latch clicked.")]
  ));

  assert.deepEqual(messages.at(-1), { role: "user", content: "A stranger enters." });
});

test("structural empty endpoints never become empty assistant messages", () => {
  const empty = { ...part("", ""), id: "empty", parentId: "prior" };
  const parts = [{ ...part("Set the scene.", "Prior prose."), id: "prior", activeChildId: "empty" }, empty];

  const requested = continuationPlan("Write.", null, null, parts, "Go elsewhere.", false, true, "ct-empty", [], parts);
  const requestedMessages = rendered(requested);
  assert.equal(requestedMessages.some(({ role, content }) => role === "assistant" && content.trim().length === 0), false);
  assert.deepEqual(requestedMessages.at(-1), { role: "user", content: "Go elsewhere." });

  const appended = continuationPlan("Write.", null, null, [empty], "Continue the story.", true, true, "ct-empty", [], [empty]);
  const appendedMessages = rendered(appended);
  assert.equal(appendedMessages.some(({ role }) => role === "assistant"), false);
  assert.deepEqual(appendedMessages.at(-1), { role: "user", content: "Continue the story." });
  assert.equal(appendedMessages.some(({ content }) => /unfinished passage/.test(content)), false);
});

test("highlight regeneration bridges exact left and right character boundaries", () => {
  const text = "The latch was unloXXed. Dawn found it open.";
  const start = text.indexOf("XX");
  const story = fixture(text);
  const plan = rewritePlan({
    story,
    facts: null,
    partId: story.nodes[0]!.id,
    start,
    end: start + 2,
    expected: "XX",
    instruction: "Repair the word.",
    lengthTarget: "Length: two letters.",
    authorBrief: "Rewrite precisely.",
    tag: "rw-test",
    assistantPrefill: true
  });

  const messages = rendered(plan);
  assert.equal(messages.at(-1)?.role, "assistant");
  assert.equal(messages.at(-1)?.content, "The latch was unlo");
  assert.equal(plan.rightAnchor, "ed. Dawn found it open.");

  const filter = new AnchoredOutputFilter(plan.leftAnchor, plan.rightAnchor, plan.endMarker);
  const generated = plan.leftAnchor + "ck" + plan.rightAnchor + plan.endMarker + "ignored";
  const chunks = [generated.slice(0, 5), generated.slice(5, 23), generated.slice(23, 31), generated.slice(31)];
  const replacement = chunks.map((chunk) => filter.push(chunk)).join("") + filter.finish();

  assert.equal(replacement, "ck");
  assert.equal(filter.matchedContract, true);
  assert.equal(text.slice(0, start) + replacement + text.slice(start + 2), "The latch was unlocked. Dawn found it open.");
});

test("whitespace around the seams is forgiven; the seams themselves stay exact", () => {
  const text = "The latch was unloXXed. Dawn found it open.";
  const start = text.indexOf("XX");
  const story = fixture(text);
  const plan = rewritePlan({
    story,
    facts: null,
    partId: story.nodes[0]!.id,
    start,
    end: start + 2,
    expected: "XX",
    instruction: "Repair the word.",
    lengthTarget: "Length: two letters.",
    authorBrief: "Rewrite precisely.",
    tag: "rw-seams",
    assistantPrefill: false
  });

  // Marker on its own line after the right boundary, stray newline before the echo.
  const tolerant = new AnchoredOutputFilter(plan.leftAnchor, plan.rightAnchor, plan.endMarker, true);
  const replacement = tolerant.push("\n" + plan.leftAnchor + "ck" + plan.rightAnchor + "\n\n" + plan.endMarker) + tolerant.finish();
  assert.equal(replacement, "ck");
  assert.equal(tolerant.matchedPrefix, true);
  assert.equal(tolerant.matchedContract, true);

  // A bare end marker is not proof of reconnection: the boundary echo is.
  const strict = new AnchoredOutputFilter("", plan.rightAnchor, plan.endMarker);
  strict.push("detached replacement" + plan.endMarker);
  strict.finish();
  assert.equal(strict.matchedContract, false);
});

test("rewrite plan preserves selected boundary whitespace outside generated prose", () => {
  const text = "She raised the chipped glass slowly.";
  const expected = " the chipped glass ";
  const start = text.indexOf(expected);
  const story = fixture(text);
  const plan = rewritePlan({
    story,
    facts: null,
    partId: story.nodes[0]!.id,
    start,
    end: start + expected.length,
    expected,
    instruction: "Make it elegant.",
    lengthTarget: "Length: four words.",
    authorBrief: "Rewrite precisely.",
    tag: "rw-space",
    assistantPrefill: true
  });

  assert.equal(plan.leadingWhitespace, " ");
  assert.equal(plan.trailingWhitespace, " ");
  assert.equal(plan.leftAnchor, "She raised");
  assert.equal(plan.rightAnchor, "slowly.");
});

test("rewrite fallback verifies an echoed left anchor when prefill is unavailable", () => {
  const text = "The latch was unloXXed.";
  const start = text.indexOf("XX");
  const story = fixture(text);
  const plan = rewritePlan({
    story,
    facts: null,
    partId: story.nodes[0]!.id,
    start,
    end: start + 2,
    expected: "XX",
    instruction: "Repair the word.",
    lengthTarget: "Length: two letters.",
    authorBrief: "Rewrite precisely.",
    tag: "rw-no-prefill",
    assistantPrefill: false
  });
  const messages = rendered(plan);
  assert.equal(messages.at(-1)?.role, "user");
  assert.match(messages.at(-1)?.content ?? "", /LEFT BOUNDARY/);

  const filter = new AnchoredOutputFilter(plan.leftAnchor, plan.rightAnchor, plan.endMarker, true);
  const replacement = filter.push(plan.leftAnchor + "ck" + plan.rightAnchor + plan.endMarker) + filter.finish();
  assert.equal(replacement, "ck");
  assert.equal(filter.matchedPrefix, true);
  assert.equal(filter.matchedContract, true);
});

test("new Claude models use required boundary echoes instead of rejected prefills", () => {
  const settings = {
    provider: "anthropic" as const,
    baseUrl: "https://api.anthropic.com",
    model: "claude-sonnet-4-6",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    temperature: 0,
    maxTokens: 100,
    systemPrompt: "Write.",
    contextWindow: null
  };
  assert.equal(supportsAssistantPrefill(settings), false);

  const plan = continuationPlan(
    settings.systemPrompt,
    null,
    null,
    [part("Open the door.", "The latch was unlo")],
    "Continue the story.",
    true,
    supportsAssistantPrefill(settings),
    "ct-claude",
    [],
    [part("Open the door.", "The latch was unlo")]
  );
  const messages = rendered(plan);
  assert.equal(messages.at(-1)?.role, "user");
  assert.match(messages.at(-1)?.content ?? "", /The latch was unlo/);
  assert.equal(plan.requiresEcho, true);

  const filter = new AnchoredOutputFilter(plan.leftAnchor, "", "", true);
  assert.equal(filter.push("The latch was unlo"), "");
  assert.equal(filter.push("cked."), "cked.");
  assert.equal(filter.matchedPrefix, true);
});

test("continuation boundary tags stay stable when derived from the left anchor", () => {
  const parts = [part("Open the door.", "The latch was unlo")];
  const first = continuationPlan(
    "Write vivid prose.", null, null, parts, "Continue the story.", true, false, null, [], parts
  );
  const second = continuationPlan(
    "Write vivid prose.", null, null, parts, "Continue the story.", true, false, null, [], parts
  );
  const firstBoundary = rendered(first).filter((message) => message.content.includes("LEFT BOUNDARY"));
  const secondBoundary = rendered(second).filter((message) => message.content.includes("LEFT BOUNDARY"));

  assert.equal(first.requiresEcho, true);
  assert.equal(second.requiresEcho, true);
  assert.equal(firstBoundary.length, 1);
  assert.deepEqual(firstBoundary, secondBoundary);
  assert.match(firstBoundary[0]!.content, /<ct-[0-9a-f]{8}-left>The latch was unlo<\/ct-[0-9a-f]{8}-left>/);
});

test("legacy Anthropic prefill defaults cannot override official Claude incompatibility", () => {
  const settings = {
    provider: "anthropic" as const,
    baseUrl: "https://api.anthropic.com",
    model: "claude-sonnet-4-6",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    temperature: 0,
    maxTokens: 100,
    systemPrompt: "Write.",
    contextWindow: null
  };
  const runtime = providerRuntimeFor(settings);

  assert.equal(supportsAssistantPrefill(attachProviderRuntime(settings, {
    ...runtime,
    capabilities: {
      ...runtime.capabilities,
      assistantPrefill: "supported"
    }
  })), false);
});

test("official OpenAI chat uses a verified echo because assistant messages are history, not prefill", () => {
  for (const baseUrl of [
    "https://api.openai.com/v1",
    "https://fixture.openai.azure.com/openai"
  ]) {
    const settings = {
      provider: "openai-compatible" as const,
      baseUrl,
      model: "gpt-5.4",
      apiKeyEnv: "OPENAI_API_KEY",
      temperature: 0,
      maxTokens: 100,
      systemPrompt: "Write.",
      contextWindow: null
    };
    const runtime = providerRuntimeFor(settings);
    assert.equal(supportsAssistantPrefill(settings), false);
    assert.equal(supportsAssistantPrefill(attachProviderRuntime(settings, {
      ...runtime,
      capabilities: {
        ...runtime.capabilities,
        assistantPrefill: "supported"
      }
    })), false);
  }
});

test("ChatGPT plan continuation uses a boundary user turn and exact echo", () => {
  const settings = {
    provider: "openai-compatible" as const,
    baseUrl: "",
    model: "gpt-5.4",
    apiKeyEnv: null,
    temperature: 0,
    maxTokens: 100,
    systemPrompt: "Write.",
    contextWindow: null
  };
  const runtime = providerRuntimeFor(settings);
  const planSettings = attachProviderRuntime(settings, {
    ...runtime,
    preset: "chatgpt-plan",
    protocol: "openai-codex-responses",
    capabilities: {
      ...runtime.capabilities,
      assistantPrefill: "unknown"
    }
  });
  assert.equal(supportsAssistantPrefill(planSettings), false);

  const parts = [part("Open the door.", "The latch was unlo")];
  const plan = continuationPlan(
    planSettings.systemPrompt,
    null,
    null,
    parts,
    "Continue the story.",
    true,
    supportsAssistantPrefill(planSettings),
    "ct-chatgpt",
    [],
    parts
  );
  const messages = rendered(plan);
  const boundary = messages.at(-1);
  assert.equal(boundary?.role, "user");
  assert.match(boundary?.content ?? "", /LEFT BOUNDARY/);
  assert.match(
    boundary?.content ?? "",
    /<ct-chatgpt-left>The latch was unlo<\/ct-chatgpt-left>/
  );
  assert.equal(plan.requiresEcho, true);

  const filter = new AnchoredOutputFilter(plan.leftAnchor, "", "", true);
  assert.equal(filter.push(plan.leftAnchor), "");
  assert.equal(filter.matchedPrefix, true);
  assert.equal(filter.push("cked."), "cked.");

  const claudeSettings = {
    provider: "anthropic" as const,
    baseUrl: "",
    model: "claude-sonnet-4-6",
    apiKeyEnv: null,
    temperature: 0,
    maxTokens: 100,
    systemPrompt: "Write.",
    contextWindow: null
  };
  const claudeRuntime = providerRuntimeFor(claudeSettings);
  assert.equal(
    supportsAssistantPrefill(attachProviderRuntime(claudeSettings, {
      ...claudeRuntime,
      preset: "claude-plan",
      protocol: "anthropic-subscription-messages"
    })),
    false
  );
});

test("continuation context resets at the last summary and keeps its instruction and text", () => {
  const before = { ...part("Old direction", "Old prose"), id: "before" };
  const summary = { ...part("Use this recap", "Continuity recap"), id: "summary", role: "summary" as const };
  const after = { ...part("Continue onward", "Fresh prose"), id: "after" };
  const parts = [before, summary, after];
  const plan = continuationPlan("Write.", null, null, parts, "Continue.", false, true, "ct-summary", [], parts);
  const content = rendered(plan).map((message) => message.content).join("\n");
  assert.doesNotMatch(content, /Old prose|Old direction/);
  assert.match(content, /Use this recap[\s\S]*Continuity recap[\s\S]*Fresh prose/);
});

test("instructed rewrite context resets only at a summary at or before its target", () => {
  const before = { ...part("Old direction", "Ancient prose"), id: "before", activeChildId: "summary" };
  const summary = {
    ...part("Use this recap", "Continuity recap"), id: "summary", parentId: "before",
    activeChildId: "after", role: "summary" as const
  };
  const after = { ...part("Continue onward", "Fresh XX prose"), id: "after", parentId: "summary" };
  const story: Story = {
    ...fixture("unused"), nodes: [before, summary, after], activeRootId: before.id
  };
  const afterPlan = rewritePlan({
    story, facts: null, partId: after.id, start: 6, end: 8, expected: "XX",
    instruction: "Repair it.", lengthTarget: "Length: two words.", authorBrief: "Write.",
    tag: "rw-after-summary", assistantPrefill: true
  });
  const afterContent = rendered(afterPlan).map((message) => message.content).join("\n");
  assert.doesNotMatch(afterContent, /Ancient prose|Old direction/);
  assert.match(afterContent, /Continuity recap[\s\S]*Fresh/);

  const beforePlan = rewritePlan({
    story, facts: null, partId: before.id, start: 0, end: 7, expected: "Ancient",
    instruction: "Repair it.", lengthTarget: "Length: one word.", authorBrief: "Write.",
    tag: "rw-before-summary", assistantPrefill: true
  });
  const beforeContent = rendered(beforePlan).map((message) => message.content).join("\n");
  assert.match(beforeContent, /Ancient[\s\S]*Continuity recap/);
});

function rendered(value: { prompt: PromptPlan }) {
  return renderPromptPlan(value.prompt);
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
