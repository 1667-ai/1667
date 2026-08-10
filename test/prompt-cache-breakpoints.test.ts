import assert from "node:assert/strict";
import test from "node:test";
import { countO200kPromptTextTokens } from "../server/openai-prompt-tokenizer.js";
import {
  PromptCacheBreakpointRegistry,
  planRollingOpenAiBreakpoints,
  promptCacheBoundaries
} from "../server/prompt-cache-breakpoints.js";
import { continuationPlan } from "../shared/continuation-plan.js";
import type { PromptBlock, PromptPlan, StablePromptBlock, VolatilePromptBlock } from "../shared/prompt-plan.js";
import type { StoryNode } from "../shared/types.js";

/** Every block these fixtures build is text. Narrows an indexed lookup back
 *  to a text block, so a fixture can still edit `.text` on a copy. */
function asTextBlock(block: PromptBlock): StablePromptBlock | VolatilePromptBlock {
  if (block.kind === "image") throw new Error("test fixture block must be text");
  return block;
}

test("o200k tokenizer uses exact model tokens", () => {
  assert.equal(countO200kPromptTextTokens(["hello world"]), 2);
  assert.equal(countO200kPromptTextTokens(["The lantern is blue."]), 5);
});

test("new OpenAI breakpoints require the exact token minimum", () => {
  const prompt = fixture();
  assert.deepEqual(
    planRollingOpenAiBreakpoints(prompt, null, 1_024, 4, () => 1_023),
    { locations: [], newestBoundaryHash: null }
  );
  assert.deepEqual(
    planRollingOpenAiBreakpoints(prompt, null, 1_024, 4, () => null),
    { locations: [], newestBoundaryHash: null },
    "tokenizer failure remains conservative"
  );
  assert.deepEqual(
    planRollingOpenAiBreakpoints(prompt, null, 1_024, 4, () => 1_024).locations,
    [{ turn: 0, block: 1 }]
  );
});

test("rolling OpenAI breakpoints preserve the prior readable prefix", () => {
  const first = fixture();
  const prior = promptCacheBoundaries(first).at(-1)!.hash;
  const grown: PromptPlan = {
    ...first,
    turns: [{
      ...first.turns[0]!,
      blocks: [
        ...first.turns[0]!.blocks.slice(0, 2),
        {
          stability: "stable",
          kind: "source",
          text: "A new stable paragraph.",
          boundaryAfter: "candidate"
        },
        first.turns[0]!.blocks[2]!
      ]
    }]
  };
  assert.deepEqual(
    planRollingOpenAiBreakpoints(grown, prior, 1_024, 4, () => 1_024),
    {
      locations: [
        { turn: 0, block: 1 },
        { turn: 0, block: 2 }
      ],
      newestBoundaryHash: promptCacheBoundaries(grown).at(-1)!.hash
    }
  );
  assert.deepEqual(
    planRollingOpenAiBreakpoints(grown, prior, 1_024, 1, () => 1_024),
    {
      locations: [{ turn: 0, block: 1 }],
      newestBoundaryHash: null
    },
    "a model limit that cannot preserve the prior read never evicts it"
  );
});

test("a moving Author's Note preserves request k's newest boundary in request k+1", () => {
  const parts = Array.from({ length: 4 }, (_, index) => cacheNode(index + 1));
  const requestK = continuationPlan(
    "Voice.", null, { text: "Keep the danger quiet.", depth: 1 }, parts.slice(0, 3),
    "Continue.", false, true, "ct-k", [], parts.slice(0, 3)
  ).prompt;
  const requestK1 = continuationPlan(
    "Voice.", null, { text: "Keep the danger quiet.", depth: 1 }, parts,
    "Continue.", false, true, "ct-k1", [], parts
  ).prompt;
  const prior = promptCacheBoundaries(requestK).at(-1)!;
  const grown = promptCacheBoundaries(requestK1);

  assert.deepEqual(
    grown.find((boundary) => boundary.hash === prior.hash)?.location,
    prior.location
  );
  assert.ok(grown.every((boundary) =>
    requestK1.turns[boundary.location.turn]!.blocks[boundary.location.block]!.kind !== "authors-note"
  ));
  assert.deepEqual(
    planRollingOpenAiBreakpoints(requestK1, prior.hash, 1, 4, () => 1),
    {
      locations: [prior.location, grown.at(-1)!.location],
      newestBoundaryHash: grown.at(-1)!.hash
    }
  );
});

test("volatile edits preserve boundary identity while stable edits invalidate it", () => {
  const first = fixture();
  const prior = promptCacheBoundaries(first).at(-1)!.hash;
  const volatileEdit: PromptPlan = {
    ...first,
    turns: [{
      ...first.turns[0]!,
      blocks: [
        ...first.turns[0]!.blocks.slice(0, 2),
        {
          ...asTextBlock(first.turns[0]!.blocks[2]!),
          text: "Do something wholly different."
        }
      ]
    }]
  };
  assert.equal(promptCacheBoundaries(volatileEdit).at(-1)!.hash, prior);
  let tokenCounts = 0;
  assert.deepEqual(
    planRollingOpenAiBreakpoints(volatileEdit, prior, 1_024, 4, () => {
      tokenCounts += 1;
      return 1_024;
    }),
    {
      locations: [{ turn: 0, block: 1 }],
      newestBoundaryHash: prior
    },
    "a registry-qualified unchanged prefix is reused without retokenizing"
  );
  assert.equal(tokenCounts, 0);

  const stableEdit: PromptPlan = {
    ...first,
    turns: [{
      ...first.turns[0]!,
      blocks: [
        first.turns[0]!.blocks[0]!,
        {
          ...asTextBlock(first.turns[0]!.blocks[1]!),
          text: "The canonical facts changed."
        },
        first.turns[0]!.blocks[2]!
      ]
    }]
  };
  assert.notEqual(promptCacheBoundaries(stableEdit).at(-1)!.hash, prior);
  assert.deepEqual(
    planRollingOpenAiBreakpoints(stableEdit, prior, 1_024, 4, () => 1_024).locations,
    [{ turn: 0, block: 1 }],
    "an invalidated prior boundary is not carried into the next request"
  );
});

test("breakpoint registry is bounded and stores hashes, never prompt text", () => {
  const registry = new PromptCacheBreakpointRegistry(3);
  registry.commit("scope-a", "hash-a");
  registry.commit("scope-b", "hash-b");
  registry.commit("scope-c", "hash-c");
  registry.commit("scope-d", "hash-d");
  assert.equal(registry.size, 3);
  assert.equal(registry.previous("scope-a"), null);
  assert.deepEqual(registry.hashes(), ["hash-b", "hash-c", "hash-d"]);
  assert.equal(JSON.stringify(registry.hashes()).includes("story prose"), false);
  registry.clear();
  assert.equal(registry.size, 0);
});

test("stable content after the volatile suffix is rejected", () => {
  const prompt = fixture();
  assert.throws(
    () => promptCacheBoundaries({
      ...prompt,
      turns: [{
        ...prompt.turns[0]!,
        blocks: [
          ...prompt.turns[0]!.blocks,
          {
            stability: "stable",
            kind: "source",
            text: "too late",
            boundaryAfter: "candidate"
          }
        ]
      }]
    }),
    /Stable prompt content cannot follow volatile content/
  );
});

function fixture(): PromptPlan {
  return {
    operation: "continue",
    turns: [{
      role: "user",
      blocks: [
        {
          stability: "stable",
          kind: "author-brief",
          text: "Write closely.",
          boundaryAfter: "candidate"
        },
        {
          stability: "stable",
          kind: "source",
          text: "The lantern burned.",
          boundaryAfter: "candidate"
        },
        {
          stability: "volatile",
          kind: "request",
          text: "Continue.",
          boundaryAfter: "none"
        }
      ]
    }]
  };
}

function cacheNode(index: number): StoryNode {
  return {
    id: `part-${index}`,
    parentId: index === 1 ? null : `part-${index - 1}`,
    instruction: `Direction ${index}.`,
    text: `Passage ${index}.`,
    model: "test",
    createdAt: "2025-01-01T00:00:00.000Z",
    activeChildId: null
  };
}
