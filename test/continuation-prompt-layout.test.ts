import assert from "node:assert/strict";
import test from "node:test";
import { assembleContinuation } from "../server/continuation-assembly.js";
import { continuationRecordEntries } from "../server/generation-record-prompt.js";
import { buildOpenAiChatRequestBody } from "../server/provider-request-body.js";
import { effectiveGenerationRuntime } from "../server/settings-v2-conversion.js";
import {
  INITIAL_SETTINGS_DOCUMENT_V2,
  INITIAL_SETTINGS_DOCUMENT_V2_TEXT
} from "../server/settings-v2-default.js";
import { parseSettingsDocumentV2Text } from "../server/settings-v2-codec.js";
import {
  continuationPlan,
  type ContinuationPlan,
  type ContinuationPromptLayout
} from "../shared/continuation-plan.js";
import {
  renderPromptPlan,
  type PromptBlock,
  type PromptTurn,
  type StablePromptBlock
} from "../shared/prompt-plan.js";
import type { SettingsDocumentV2 } from "../shared/settings-v2-types.js";
import type { Story, StoryNode } from "../shared/types.js";

const LATE_CACHE_STABLE: ContinuationPromptLayout = "late-cache-stable";
const CONTINUE_CONTRACT = [
  "Write the next passage of the story in response to the final user direction.",
  "Return only story prose: no summary, explanation, or commentary."
].join(" ");
const APPEND_CONTRACT = [
  "Continuation mode: the final assistant message is an unfinished passage.",
  "Continue directly from its exact final character, even when that character is in the middle of a sentence or word.",
  "Return only the new characters after that boundary; do not repeat, restart, quote, or summarize existing text."
].join(" ");
const PREFILL_CONTINUITY_GUARD = "Preserve the established point of view and tense.";

test("compatibility is the default continuation prompt layout", () => {
  const parts = storyParts();
  const defaultPlan = buildPlan(parts, false, true);
  const explicitPlan = buildPlan(parts, false, true, "compatibility");

  assert.deepEqual(defaultPlan, explicitPlan);
  assert.deepEqual(renderPromptPlan(defaultPlan.prompt), [
    { role: "system", content: "Voice." },
    { role: "system", content: "Facts." },
    {
      role: "system",
      content: "Write the next passage of the story in response to the final user direction. Return only story prose: no summary, explanation, or commentary."
    },
    { role: "user", content: "Open the gate." },
    { role: "assistant", content: "The hinges groaned." },
    { role: "user", content: "Cross the courtyard." },
    { role: "assistant", content: "Rain filled the flagstones." },
    { role: "user", content: "Find the tower." }
  ]);
});

test("old, missing, fresh, and disabled settings keep the exact v0.8 request body", async () => {
  const old = parseSettingsDocumentV2Text(INITIAL_SETTINGS_DOCUMENT_V2_TEXT);
  const missing = parseSettingsDocumentV2Text(INITIAL_SETTINGS_DOCUMENT_V2_TEXT);
  const disabled = withoutContinuationPromptOptimization(
    withContinuationPromptOptimization(INITIAL_SETTINGS_DOCUMENT_V2)
  );
  const expected = {
    model: "dry-run",
    messages: [
      { role: "system", content: "Continue the story in its established voice." },
      {
        role: "system",
        content: "Write the next passage of the story in response to the final user direction. Return only story prose: no summary, explanation, or commentary."
      },
      { role: "user", content: "Open gate" },
      { role: "assistant", content: "Hinges groaned" },
      { role: "user", content: "Cross courtyard" }
    ],
    max_tokens: 2048,
    stream: true,
    temperature: 0.8
  };
  for (const document of [old, missing, INITIAL_SETTINGS_DOCUMENT_V2, disabled]) {
    assert.deepEqual(await continuationBody(document, false), expected);
  }
});

test("enabled Retake uses the exact v0.9.0 final user contract and route snapshot", async () => {
  const enabled = withContinuationPromptOptimization(INITIAL_SETTINGS_DOCUMENT_V2);
  const enabledBody = await continuationBody(enabled, false);
  assert.deepEqual(enabledBody.messages, [
    {
      role: "system",
      content: "Continue the story in its established voice."
    },
    { role: "user", content: "Open gate" },
    { role: "assistant", content: "Hinges groaned" },
    {
      role: "user",
      content: `${CONTINUE_CONTRACT}\n\nCross courtyard`
    }
  ]);
  const append = await continuationPlanFor(enabled, true);
  assert.deepEqual(finalBlockKinds(append), ["operation-contract", "boundary"]);

  const splitProfiles = {
    ...INITIAL_SETTINGS_DOCUMENT_V2,
    profiles: {
      ...INITIAL_SETTINGS_DOCUMENT_V2.profiles,
      prose: {
        ...INITIAL_SETTINGS_DOCUMENT_V2.profiles.default!,
        name: "Prose",
        continuationPromptOptimization: "late-cache-stable" as const
      }
    },
    routing: { ...INITIAL_SETTINGS_DOCUMENT_V2.routing, prose: "prose" }
  };
  assert.equal(
    effectiveGenerationRuntime(splitProfiles, "default").providerRuntime.continuationPromptLayout,
    "compatibility"
  );
  assert.equal(
    effectiveGenerationRuntime(splitProfiles, "prose").providerRuntime.continuationPromptLayout,
    "late-cache-stable"
  );
});

test("late-cache-stable keeps its v0.9.0 final contracts and guards only prefill Continue", async () => {
  const parts = storyParts();
  const authorsNote = { text: "Keep the rain close.", depth: 1 };
  const retake = buildPlan(parts, false, true, LATE_CACHE_STABLE, authorsNote);
  const prefillContinue = buildPlan(parts, true, true, LATE_CACHE_STABLE, authorsNote);
  const echoContinue = buildPlan(parts, true, false, LATE_CACHE_STABLE, authorsNote);

  for (const plan of [retake, prefillContinue, echoContinue]) {
    const noteIndex = plan.entries.findIndex((entry) => entry.category === "note");
    assert.notEqual(noteIndex, -1);
    assert.equal(plan.entries[noteIndex + 1]!.turn.role, "user");
  }

  assert.deepEqual(operationContracts(retake), [`${CONTINUE_CONTRACT}\n\n`]);
  assert.deepEqual(operationContracts(echoContinue), [`${APPEND_CONTRACT}\n\n`]);
  assert.deepEqual(operationContracts(prefillContinue), [`\n\n${PREFILL_CONTINUITY_GUARD}`]);
  assert.deepEqual(prefillContinue.prompt.turns.at(-2), {
    role: "user",
    blocks: [
      {
        stability: "stable",
        kind: "source",
        text: "Cross the courtyard.",
        boundaryAfter: "none"
      },
      {
        stability: "stable",
        kind: "operation-contract",
        text: `\n\n${PREFILL_CONTINUITY_GUARD}`,
        boundaryAfter: "none"
      }
    ]
  });
  assert.equal(echoContinue.leftAnchor, "n filled the flagstones.");
  const echoBody = await buildOpenAiChatRequestBody(
    effectiveGenerationRuntime(withContinuationPromptOptimization(INITIAL_SETTINGS_DOCUMENT_V2), "prose").settings,
    echoContinue.prompt,
    { kind: "omit", reason: "policy-off" }
  );
  assert.ok(Array.isArray(echoBody.messages));
  assert.deepEqual(echoBody.messages.at(-1), {
    role: "user",
    content: [
      APPEND_CONTRACT,
      "",
      "Continue the unfinished assistant passage from its exact final character.",
      "Start your response by copying the LEFT BOUNDARY text below byte-for-byte, then write only the new continuation after it.",
      "Do not restart, summarize, quote, or explain the passage.",
      "",
      "<ct-layout-left>n filled the flagstones.</ct-layout-left>"
    ].join("\n")
  });
  assert.equal(prefillContinue.prompt.turns.at(-1)?.role, "assistant");
  assert.equal(prefillContinue.requiresEcho, false);
  assert.equal(echoContinue.prompt.turns.at(-1)?.role, "user");
  assert.equal(echoContinue.requiresEcho, true);

  assert.deepEqual(finalBlockKinds(retake), ["operation-contract", "request"]);
  assert.deepEqual(finalBlockKinds(echoContinue), ["operation-contract", "boundary"]);
  assert.deepEqual(historyThroughLastPart(retake), historyThroughLastPart(echoContinue));
});

test("late-cache-stable has no operation-contract system prelude", () => {
  const parts = storyParts();
  const authorsNote = { text: "Keep the rain close.", depth: 1 };
  for (const plan of [
    buildPlan(parts, false, true, LATE_CACHE_STABLE, authorsNote),
    buildPlan(parts, true, true, LATE_CACHE_STABLE, authorsNote),
    buildPlan(parts, true, false, LATE_CACHE_STABLE, authorsNote)
  ]) {
    const firstPartIndex = plan.entries.findIndex((entry) => entry.partId !== undefined);
    assert.equal(
      plan.entries.slice(0, firstPartIndex).some((entry) =>
        entry.turn.blocks.some(isOperationContract)
      ),
      false
    );
  }
});

test("late-cache-stable Generation Records retain the final contract and request", () => {
  const plan = continuationPlan(
    "Voice.",
    null,
    null,
    [],
    "Find the tower.",
    false,
    true,
    null,
    [],
    [],
    [],
    LATE_CACHE_STABLE
  );
  const entries = continuationRecordEntries(emptyStory(), plan.entries);

  const finalEntries = entries.slice(-2).map((entry) => {
    if (entry.source !== "text") throw new Error("expected a text prompt entry");
    return { role: entry.role, kind: entry.kind, text: entry.text };
  });
  assert.deepEqual(finalEntries, [
    {
      role: "user",
      kind: "operation-contract",
      text: "Write the next passage of the story in response to the final user direction. Return only story prose: no summary, explanation, or commentary.\n\n"
    },
    { role: "user", kind: "request", text: "Find the tower." }
  ]);
});

function buildPlan(
  parts: readonly StoryNode[],
  appendLast: boolean,
  assistantPrefill: boolean,
  layout?: ContinuationPromptLayout,
  authorsNote: { text: string; depth: number } | null = null
): ContinuationPlan {
  return continuationPlan(
    "Voice.",
    "Facts.",
    authorsNote,
    parts,
    "Find the tower.",
    appendLast,
    assistantPrefill,
    "ct-layout",
    [],
    parts,
    [],
    layout
  );
}

async function continuationBody(
  document: SettingsDocumentV2,
  appendLast: boolean
): Promise<Record<string, unknown>> {
  const runtime = effectiveGenerationRuntime(document, "prose");
  const story = {
    chapterBreaks: [],
    nodes: [
      node("p1", "Open gate", "Hinges groaned")
    ]
  };
  const prompt = assembleContinuation({
    story,
    settings: runtime.settings,
    contextParts: story.nodes,
    instruction: "Cross courtyard",
    appendLast,
    images: []
  }).plan(null).prompt;
  return buildOpenAiChatRequestBody(
    runtime.settings,
    prompt,
    { kind: "omit", reason: "policy-off" }
  );
}

async function continuationPlanFor(
  document: SettingsDocumentV2,
  appendLast: boolean
): Promise<ContinuationPlan> {
  const runtime = effectiveGenerationRuntime(document, "prose");
  const story = { chapterBreaks: [], nodes: [node("p1", "Open gate", "Hinges groaned")] };
  return assembleContinuation({
    story,
    settings: runtime.settings,
    contextParts: story.nodes,
    instruction: "Cross courtyard",
    appendLast,
    images: []
  }).plan(null);
}

function finalBlockKinds(plan: ContinuationPlan): readonly string[] {
  return plan.prompt.turns.at(-1)!.blocks.map((block) => block.kind);
}

function operationContracts(plan: ContinuationPlan): readonly string[] {
  return plan.prompt.turns.flatMap((turn) => turn.blocks)
    .filter(isOperationContract)
    .map((block) => block.text);
}

function isOperationContract(
  block: PromptBlock
): block is StablePromptBlock & { kind: "operation-contract" } {
  return block.kind === "operation-contract";
}

function withContinuationPromptOptimization(
  document: SettingsDocumentV2
): SettingsDocumentV2 {
  const profileId = document.routing.default;
  return {
    ...document,
    profiles: {
      ...document.profiles,
      [profileId]: {
        ...document.profiles[profileId]!,
        continuationPromptOptimization: "late-cache-stable"
      }
    }
  };
}

function withoutContinuationPromptOptimization(
  document: SettingsDocumentV2
): SettingsDocumentV2 {
  const profileId = document.routing.default;
  const { continuationPromptOptimization: _dropped, ...profile } = document.profiles[profileId]!;
  return {
    ...document,
    profiles: { ...document.profiles, [profileId]: profile }
  };
}

function historyThroughLastPart(plan: ContinuationPlan): readonly PromptTurn[] {
  const lastPartIndex = plan.entries.findLastIndex((entry) => entry.partId !== undefined);
  if (lastPartIndex === -1) throw new Error("fixture needs story context");
  return plan.prompt.turns.slice(0, lastPartIndex + 1);
}

function storyParts(): readonly StoryNode[] {
  return [
    node("part-1", "Open the gate.", "The hinges groaned."),
    node("part-2", "Cross the courtyard.", "Rain filled the flagstones.")
  ];
}

function node(id: string, instruction: string, text: string): StoryNode {
  return {
    id,
    parentId: null,
    instruction,
    text,
    model: "test",
    createdAt: "2026-01-01T00:00:00.000Z",
    activeChildId: null
  };
}

function emptyStory(): Story {
  return {
    id: "story-1",
    title: "Story",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    nodes: [],
    activeRootId: null,
    tags: [],
    recentNodeIds: [],
    facts: [],
    chapterBreaks: []
  };
}
