import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { estimateTokens } from "../../shared/tokens.js";
import {
  createDemoController,
  demoStoryApi,
  DEMO_CONTINUE_TEXT,
  DEMO_GENERATED_TEXT
} from "../src/demo.js";
import {
  COLD_START_RESPONSE_GROWTH_TOKENS,
  likelyResponseTokens,
  recentProviderProseTokenCounts
} from "../src/response-growth-estimate.js";

function textHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

describe("demo generation provenance for response growth", () => {
  test("fixture prose is not sample evidence without provider genId", () => {
    const payload = createDemoController().payload();
    expect(payload.path.every((node) => node.genId === undefined)).toBe(true);
    expect(recentProviderProseTokenCounts(payload)).toEqual([]);
    expect(likelyResponseTokens(payload)).toBe(COLD_START_RESPONSE_GROWTH_TOKENS);
  });

  test("completed demo continue becomes a clean growth sample", async () => {
    const demo = createDemoController();
    const api = demoStoryApi(demo);
    const storyId = demo.payload().id;
    const parentId = demo.payload().path.at(-1)!.id;
    const genId = "demo-continue-clean";

    const payload = await api.continueStory(
      storyId,
      "keep the compass in view",
      genId,
      { parentId },
      () => {},
      new AbortController().signal
    );

    expect(payload).not.toBe(null);
    const leaf = payload!.path.at(-1)!;
    expect(leaf.genId).toBe(genId);
    expect(leaf.human).toBe(undefined);
    expect(leaf.updatedAt).toBe(undefined);
    expect(leaf.text).toBe(DEMO_GENERATED_TEXT);
    expect(recentProviderProseTokenCounts(payload!)).toEqual([
      estimateTokens(DEMO_GENERATED_TEXT)
    ]);
    expect(likelyResponseTokens(payload!)).toBe(estimateTokens(DEMO_GENERATED_TEXT));
  });

  test("appended demo continue keeps genId but stays excluded by updatedAt", async () => {
    const demo = createDemoController();
    const api = demoStoryApi(demo);
    const storyId = demo.payload().id;
    const leafBefore = demo.payload().path.at(-1)!;
    const genId = "demo-append-gen";

    const payload = await api.continueStory(
      storyId,
      "",
      genId,
      {
        appendTo: leafBefore.id,
        expectedTextHash: textHash(leafBefore.text)
      },
      () => {},
      new AbortController().signal
    );

    expect(payload).not.toBe(null);
    const leaf = payload!.path.at(-1)!;
    expect(leaf.id).toBe(leafBefore.id);
    expect(leaf.genId).toBe(genId);
    expect(leaf.updatedAt).not.toBe(undefined);
    expect(leaf.text.endsWith(DEMO_CONTINUE_TEXT)).toBe(true);
    // Impure multi-generation text must not enter the sample.
    expect(recentProviderProseTokenCounts(payload!)).toEqual([]);
    expect(likelyResponseTokens(payload!)).toBe(COLD_START_RESPONSE_GROWTH_TOKENS);
  });

  test("stopped createNode preserves genId; human createNode stays unprovenanced", async () => {
    const demo = createDemoController();
    const api = demoStoryApi(demo);
    const storyId = demo.payload().id;
    const parentId = demo.payload().path.at(-1)!.id;
    const stoppedText = "The lantern held still while the storm found its breath.";
    const stoppedGenId = "demo-stopped-gen";

    const stopped = await api.createNode(storyId, {
      parentId,
      instruction: "hold the light",
      text: stoppedText,
      genId: stoppedGenId
    });
    const stoppedLeaf = stopped.path.at(-1)!;
    expect(stoppedLeaf.genId).toBe(stoppedGenId);
    expect(stoppedLeaf.human).toBe(undefined);
    expect(stoppedLeaf.updatedAt).toBe(undefined);
    expect(recentProviderProseTokenCounts(stopped)).toEqual([
      estimateTokens(stoppedText)
    ]);

    const human = await api.createNode(storyId, {
      parentId: stoppedLeaf.id,
      instruction: "type a seam",
      text: "Maren wrote the next line herself."
    });
    const humanLeaf = human.path.at(-1)!;
    expect(humanLeaf.human).toBe(true);
    expect(humanLeaf.genId).toBe(undefined);
    // Human take is excluded; stopped provider take remains the only sample.
    expect(recentProviderProseTokenCounts(human)).toEqual([
      estimateTokens(stoppedText)
    ]);
  });

  test("stopped append createNode rewrites genId and remains excluded", async () => {
    const demo = createDemoController();
    const api = demoStoryApi(demo);
    const storyId = demo.payload().id;
    const leafBefore = demo.payload().path.at(-1)!;
    const genId = "demo-stopped-append";

    const payload = await api.createNode(storyId, {
      appendTo: leafBefore.id,
      expectedTextHash: textHash(leafBefore.text),
      instruction: "",
      text: " and the wick answered.",
      genId
    });
    const leaf = payload.path.at(-1)!;
    expect(leaf.id).toBe(leafBefore.id);
    expect(leaf.genId).toBe(genId);
    expect(leaf.updatedAt).not.toBe(undefined);
    expect(recentProviderProseTokenCounts(payload)).toEqual([]);
  });

  test("edited sibling createNode stays unprovenanced", async () => {
    const demo = createDemoController();
    const api = demoStoryApi(demo);
    const storyId = demo.payload().id;
    // Seed a provenanced take, then edit-as-sibling from it.
    const provenanced = await api.createNode(storyId, {
      parentId: demo.payload().path.at(-1)!.id,
      instruction: "seed",
      text: "Provider seed for sibling edit.",
      genId: "demo-edit-source"
    });
    const source = provenanced.path.at(-1)!;
    expect(source.genId).toBe("demo-edit-source");

    const edited = await api.createNode(storyId, {
      sourceNodeId: source.id,
      expectedTextHash: textHash(source.text),
      instruction: source.instruction,
      text: "Human-edited sibling without provenance."
    });
    const sibling = edited.path.at(-1)!;
    expect(sibling.id).not.toBe(source.id);
    expect(sibling.genId).toBe(undefined);
    expect(sibling.human).toBe(undefined);
    // Sibling is not a sample; the original seed is off the active path after
    // the sibling switch.
    expect(recentProviderProseTokenCounts(edited).every(
      (tokens) => tokens !== estimateTokens(sibling.text)
    )).toBe(true);
  });
});
