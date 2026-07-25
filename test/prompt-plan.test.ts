import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { autonamePrompt } from "../server/autoname.js";
import { phraseRewritePlan, rewritePlan } from "../server/generation-prompts.js";
import { streamCompletion } from "../server/providers.js";
import { summaryTakePrompt } from "../server/summary-take.js";
import { continuationPlan } from "../shared/continuation-plan.js";
import {
  renderPromptPlan,
  type PromptPlan,
  type PromptTurn
} from "../shared/prompt-plan.js";
import type { GenerationSettings, Story, StoryNode } from "../shared/types.js";

test("prompt renderer preserves roles and concatenates blocks without invented separators", () => {
  const prompt: PromptPlan = {
    operation: "continue",
    turns: [
      {
        role: "system",
        blocks: [
          stable("author-brief", "Voice."),
          stable("operation-contract", "\nContract.")
        ]
      },
      {
        role: "user",
        blocks: [
          stable("source", "Source:"),
          volatile("request", " request.")
        ]
      }
    ]
  };

  assert.deepEqual(renderPromptPlan(prompt), [
    { role: "system", content: "Voice.\nContract." },
    { role: "user", content: "Source: request." }
  ]);
});

test("prompt renderer rejects malformed plans before provider transport", () => {
  const stableAfterVolatile: PromptPlan = {
    operation: "continue",
    turns: [
      { role: "user", blocks: [volatile("request", "now")] },
      { role: "assistant", blocks: [stable("source", "too late")] }
    ]
  };
  const emptyTurn: PromptPlan = {
    operation: "continue",
    turns: [{ role: "user", blocks: [] }]
  };
  const emptyBlock: PromptPlan = {
    operation: "continue",
    turns: [{ role: "user", blocks: [volatile("request", "")] }]
  };

  assert.throws(() => renderPromptPlan(stableAfterVolatile), /Stable prompt content cannot follow volatile/);
  assert.throws(() => renderPromptPlan(emptyTurn), /turns cannot be empty/);
  assert.throws(() => renderPromptPlan(emptyBlock), /blocks cannot be empty/);
});

test("continue renders the existing provider wire shape exactly", () => {
  const source = node("part-1", "Open the door.", "The latch clicked.");
  const prompt = continuationPlan(
    "Write vivid prose.",
    "CANONICAL FACTS",
    [source],
    "A stranger enters.",
    false,
    true,
    "ct-11111111",
    [],
    [source]
  ).prompt;

  assert.deepEqual(renderPromptPlan(prompt), [
    { role: "system", content: "Write vivid prose." },
    { role: "system", content: "CANONICAL FACTS" },
    {
      role: "system",
      content: "Write the next passage of the story in response to the final user direction. Return only story prose: no summary, explanation, or commentary."
    },
    { role: "user", content: "Open the door." },
    { role: "assistant", content: "The latch clicked." },
    { role: "user", content: "A stranger enters." }
  ]);
});

test("continue omits a blank author brief instead of creating an empty block", () => {
  const source = node("part-1", "Open the door.", "The latch clicked.");
  const prompt = continuationPlan(
    " \n ",
    null,
    [source],
    "A stranger enters.",
    false,
    true,
    "ct-11111111",
    [],
    [source]
  ).prompt;

  assert.doesNotThrow(() => renderPromptPlan(prompt));
  assert.equal(
    prompt.turns.flatMap((turn) => turn.blocks).some((block) => block.kind === "author-brief"),
    false
  );
});

test("requested continuation defaults an empty instruction before rendering", () => {
  const source = node("part-1", "Open the door.", "The latch clicked.");
  const prompt = continuationPlan(
    "Voice.",
    null,
    [source],
    " \n ",
    false,
    true,
    "ct-11111111",
    [],
    [source]
  ).prompt;

  assert.deepEqual(renderPromptPlan(prompt).at(-1), {
    role: "user",
    content: "Continue the story."
  });
});

test("stable rendered-prefix hashes are golden for every generation operation", () => {
  const story = fixture("Before the lantern dimmed, rain crossed the glass. Dawn waited beyond it.");
  const target = "rain crossed the glass";
  const start = story.nodes[0]!.text.indexOf(target);
  const plans = {
    continue: continuationPlan(
      "Voice.", "Facts.", story.nodes, "Turn north.", false, true, "ct-11111111", [], story.nodes
    ).prompt,
    rewrite: rewritePlan({
      story,
      facts: "Facts.",
      partId: story.nodes[0]!.id,
      start,
      end: start + target.length,
      expected: target,
      instruction: "Make the weather threatening.",
      lengthTarget: "Length: four words.",
      authorBrief: "Voice.",
      tag: "rw-11111111",
      assistantPrefill: false
    }).prompt,
    phrase: phraseRewritePlan({
      story,
      facts: "Facts.",
      partId: story.nodes[0]!.id,
      start,
      end: start + target.length,
      expected: target,
      instruction: "Make the weather threatening.",
      lengthTarget: "Length: four words.",
      authorBrief: "Voice.",
      tag: "rw-11111111"
    }).prompt,
    title: autonamePrompt(story, "Voice.", 24_000, "Facts.").prompt,
    summary: summaryTakePrompt(story.title, story.nodes, 512, "11111111")
  };

  assert.deepEqual(Object.fromEntries(
    Object.entries(plans).map(([operation, prompt]) => [operation, prefixHash(prompt)])
  ), {
    continue: "1579f46b0d865dde5d634e8cae9bc3763c3f09dbf62ba72e3c8477d36931d9b3",
    rewrite: "915a92f74c89251f1a90cae595e7682f7f4287a1bc273ac9e2fc01099cbd4462",
    phrase: "928f1145fa90b9f398b67be8eb84164fdc17ce58b2e85704505f322ff8099752",
    title: "8ce79bf5ea50fb067d4a53a1f228b0df1b2a3c4ff6f4b698c781d00cbf3c8d72",
    summary: "d54ee9ebf17625fe1340410a18e8d2df4ace4c9a61bfd52d773e72bcc8133dc9"
  });
});

test("request changes and random tags affect only volatile suffixes", () => {
  const story = fixture("The bell rang once. Its bronze note crossed the empty square.");
  const expected = "bronze note";
  const start = story.nodes[0]!.text.indexOf(expected);
  const pairs: Array<readonly [PromptPlan, PromptPlan, string, string]> = [
    [
      continuationPlan("Voice.", null, story.nodes, "Continue.", true, false, "ct-aaaaaaaa", [], story.nodes).prompt,
      continuationPlan("Voice.", null, story.nodes, "Continue.", true, false, "ct-bbbbbbbb", [], story.nodes).prompt,
      "ct-aaaaaaaa",
      "ct-bbbbbbbb"
    ],
    [
      rewritePlan({
        story, facts: null, partId: story.nodes[0]!.id, start, end: start + expected.length, expected,
        instruction: "Make it ominous.", lengthTarget: "Length: two words.", authorBrief: "Voice.",
        tag: "rw-aaaaaaaa", assistantPrefill: false
      }).prompt,
      rewritePlan({
        story, facts: null, partId: story.nodes[0]!.id, start, end: start + expected.length, expected,
        instruction: "Make it ominous.", lengthTarget: "Length: two words.", authorBrief: "Voice.",
        tag: "rw-bbbbbbbb", assistantPrefill: false
      }).prompt,
      "rw-aaaaaaaa",
      "rw-bbbbbbbb"
    ],
    [
      phraseRewritePlan({
        story, facts: null, partId: story.nodes[0]!.id, start, end: start + expected.length, expected,
        instruction: "Make it ominous.", lengthTarget: "Length: two words.", authorBrief: "Voice.",
        tag: "rw-aaaaaaaa"
      }).prompt,
      phraseRewritePlan({
        story, facts: null, partId: story.nodes[0]!.id, start, end: start + expected.length, expected,
        instruction: "Make it ominous.", lengthTarget: "Length: two words.", authorBrief: "Voice.",
        tag: "rw-bbbbbbbb"
      }).prompt,
      "rw-aaaaaaaa",
      "rw-bbbbbbbb"
    ],
    [
      summaryTakePrompt(story.title, story.nodes, 512, "aaaaaaaa"),
      summaryTakePrompt(story.title, story.nodes, 512, "bbbbbbbb"),
      "aaaaaaaa",
      "bbbbbbbb"
    ]
  ];

  for (const [first, second, firstTag, secondTag] of pairs) {
    assert.equal(stablePrefix(first), stablePrefix(second));
    assert.notEqual(volatileSuffix(first), volatileSuffix(second));
    assertNonceIsVolatile(first, firstTag);
    assertNonceIsVolatile(second, secondTag);
  }

  const firstInstruction = continuationPlan(
    "Voice.", null, story.nodes, "Turn north.", false, true, "ct-unused", [], story.nodes
  ).prompt;
  const secondInstruction = continuationPlan(
    "Voice.", null, story.nodes, "Turn south.", false, true, "ct-unused", [], story.nodes
  ).prompt;
  assert.equal(stablePrefix(firstInstruction), stablePrefix(secondInstruction));

  const changedFacts = continuationPlan(
    "Voice.", "Changed facts.", story.nodes, "Turn north.", false, true, "ct-unused", [], story.nodes
  ).prompt;
  assert.notEqual(stablePrefix(firstInstruction), stablePrefix(changedFacts));
});

test("all declared cache candidates are stable and each operation ends its stable prefix at one", () => {
  const story = fixture("Rain crossed the courtyard.");
  const plans = [
    continuationPlan("Voice.", null, story.nodes, "Continue.", false, true, "ct-test", [], story.nodes).prompt,
    rewritePlan({
      story, facts: null, partId: story.nodes[0]!.id, start: 0, end: 4, expected: "Rain",
      instruction: "Change it.", lengthTarget: "Length: one word.", authorBrief: "Voice.",
      tag: "rw-aaaaaaaa", assistantPrefill: false
    }).prompt,
    autonamePrompt(story, "Voice.").prompt,
    summaryTakePrompt(story.title, story.nodes, 512, "aaaaaaaa")
  ];

  for (const prompt of plans) {
    const blocks = prompt.turns.flatMap((turn) => turn.blocks);
    const candidates = blocks.filter((block) => block.boundaryAfter === "candidate");
    assert.ok(candidates.length > 0);
    assert.ok(candidates.every((block) => block.stability === "stable"));
    const lastStable = blocks.findLast((block) => block.stability === "stable");
    assert.equal(lastStable?.boundaryAfter, "candidate");
  }
});

test("dry-run rewrite reads the semantic selection, not delimiter-like source prose", async () => {
  const collision = "<rw-deadbeef>bogus</rw-deadbeef>";
  const selected = "real target has four words";
  const story = fixture(`${collision} Before ${selected}. After.`);
  const start = story.nodes[0]!.text.indexOf(selected);
  const prompt = rewritePlan({
    story,
    facts: null,
    partId: story.nodes[0]!.id,
    start,
    end: start + selected.length,
    expected: selected,
    instruction: "Refresh it.",
    lengthTarget: "Length: five words.",
    authorBrief: "Voice.",
    tag: "rw-deadbeef",
    assistantPrefill: false
  }).prompt;
  let output = "";
  for await (const delta of streamCompletion(dryRunSettings(), prompt, new AbortController().signal)) {
    output += delta;
  }

  assert.match(output, /^placeholder prose from dry-run mode/);
  assert.match(output, /\[\[end-rw-deadbeef\]\]$/);
});

function stable(
  kind: "author-brief" | "facts" | "operation-contract" | "source",
  text: string
) {
  return { stability: "stable" as const, kind, text, boundaryAfter: "candidate" as const };
}

function volatile(
  kind: "request" | "selection" | "boundary" | "completion-marker",
  text: string
) {
  return { stability: "volatile" as const, kind, text, boundaryAfter: "none" as const };
}

function stablePrefix(prompt: PromptPlan): string {
  const turns: Array<{ role: PromptTurn["role"]; content: string }> = [];
  let reachedVolatile = false;
  for (const turn of prompt.turns) {
    let content = "";
    for (const block of turn.blocks) {
      if (block.stability === "volatile") {
        reachedVolatile = true;
        continue;
      }
      assert.equal(reachedVolatile, false, "stable content followed volatile content");
      content += block.text;
    }
    if (content.length > 0) turns.push({ role: turn.role, content });
  }
  return JSON.stringify(turns);
}

function volatileSuffix(prompt: PromptPlan): string {
  return prompt.turns.flatMap((turn) => turn.blocks)
    .filter((block) => block.stability === "volatile")
    .map((block) => block.text)
    .join("");
}

function prefixHash(prompt: PromptPlan): string {
  return createHash("sha256").update(stablePrefix(prompt)).digest("hex");
}

function assertNonceIsVolatile(prompt: PromptPlan, nonce: string): void {
  const containing = prompt.turns.flatMap((turn) => turn.blocks)
    .filter((block) => block.text.includes(nonce));
  assert.ok(containing.length > 0, `missing nonce ${nonce}`);
  assert.ok(containing.every((block) => block.stability === "volatile"), `${nonce} escaped the volatile suffix`);
}

function fixture(text: string): Story {
  const source = node("part-1", "Begin.", text);
  return {
    id: "story-1",
    title: "The Rain Bell",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    facts: [],
    nodes: [source],
    activeRootId: source.id,
    bookmarks: [],
    recentNodeIds: [],
    chapterBreaks: []
  };
}

function node(id: string, instruction: string, text: string): StoryNode {
  return {
    id,
    parentId: null,
    instruction,
    text,
    model: "test",
    createdAt: "2025-01-01T00:00:00.000Z",
    activeChildId: null
  };
}

function dryRunSettings(): GenerationSettings {
  return {
    provider: "dry-run",
    baseUrl: "",
    model: "dry-run",
    apiKeyEnv: null,
    temperature: null,
    maxTokens: 128,
    systemPrompt: "Voice.",
    contextWindow: null
  };
}
