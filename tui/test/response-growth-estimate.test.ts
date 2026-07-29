import { describe, expect, test } from "bun:test";
import { estimateTokens } from "../../shared/tokens.js";
import type { StoryNode, StoryPayload } from "../../shared/types.js";
import {
  COLD_START_RESPONSE_GROWTH_TOKENS,
  estimateResponseGrowthTokens,
  likelyResponseTokens,
  recentProviderProseTokenCounts
} from "../src/response-growth-estimate.js";

function growthPathPayload(
  nodes: Array<{
    id: string;
    text: string;
    instruction?: string;
    human?: boolean;
    role?: "summary";
    chapterBreakId?: string;
    genId?: string;
    updatedAt?: string;
    attribution?: StoryNode["attribution"];
    editedByUser?: true;
  }>
): Pick<StoryPayload, "path"> {
  return {
    path: nodes.map((node, index): StoryNode => ({
      id: node.id,
      parentId: index === 0 ? null : nodes[index - 1]!.id,
      instruction: node.instruction ?? "write",
      text: node.text,
      model: "test",
      createdAt: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
      activeChildId: index === nodes.length - 1 ? null : nodes[index + 1]!.id,
      ...(node.human === true ? { human: true as const } : {}),
      ...(node.role === undefined ? {} : { role: node.role }),
      ...(node.chapterBreakId === undefined ? {} : { chapterBreakId: node.chapterBreakId }),
      ...(node.genId === undefined ? {} : { genId: node.genId }),
      ...(node.updatedAt === undefined ? {} : { updatedAt: node.updatedAt }),
      ...(node.attribution === undefined ? {} : { attribution: node.attribution }),
      ...(node.editedByUser === true ? { editedByUser: true as const } : {})
    }))
  };
}

function provider(
  id: string,
  text: string,
  extra: Omit<Parameters<typeof growthPathPayload>[0][number], "id" | "text" | "genId"> & {
    genId?: string;
  } = {}
): Parameters<typeof growthPathPayload>[0][number] {
  const { genId, ...rest } = extra;
  return { id, text, genId: genId ?? `gen-${id}`, ...rest };
}

function tokensOf(text: string): number {
  return estimateTokens(text);
}

describe("response growth estimate", () => {
  test("estimates growth from the recent-history median of path prose text", () => {
    const texts = {
      a: "a".repeat(400),
      b: "b".repeat(1_200),
      c: "c".repeat(2_000),
      d: "d".repeat(2_800),
      e: "e".repeat(3_600)
    };
    const payload = growthPathPayload([
      provider("a", texts.a),
      provider("b", texts.b),
      provider("c", texts.c),
      provider("d", texts.d),
      provider("e", texts.e)
    ]);
    expect(recentProviderProseTokenCounts(payload)).toEqual([
      tokensOf(texts.e),
      tokensOf(texts.d),
      tokensOf(texts.c),
      tokensOf(texts.b),
      tokensOf(texts.a)
    ]);
    expect(likelyResponseTokens(payload)).toBe(tokensOf(texts.c));
    expect(estimateResponseGrowthTokens({
      payload,
      maxOutputTokens: 8_000,
      requestTokens: 1_000,
      contextWindow: 32_000
    })).toBe(tokensOf(texts.c));
  });

  test("samples estimateTokens of text only, never instruction size", () => {
    const shortText = "short prose response";
    const hugeInstruction = "x".repeat(8_000);
    const payload = growthPathPayload([
      provider("only", shortText, { instruction: hugeInstruction })
    ]);
    const textOnly = tokensOf(shortText);
    expect(recentProviderProseTokenCounts(payload)).toEqual([textOnly]);
    expect(likelyResponseTokens(payload)).toBe(textOnly);
    // Stub-style instruction+text would overstate; prove we do not.
    expect(likelyResponseTokens(payload)).toBeLessThan(
      tokensOf(hugeInstruction) + tokensOf(shortText)
    );
  });

  test("excludes human and summary nodes from the growth sample", () => {
    const payload = growthPathPayload([
      { id: "human", text: "h".repeat(9_000), human: true },
      { id: "legacy-summary", text: "l".repeat(8_000), role: "summary" },
      {
        id: "chapter-summary",
        text: "s".repeat(7_000),
        role: "summary",
        chapterBreakId: "break-1"
      },
      provider("prose-a", "a".repeat(800)),
      provider("prose-b", "b".repeat(1_600)),
      provider("prose-c", "c".repeat(2_400))
    ]);
    expect(recentProviderProseTokenCounts(payload)).toEqual([
      tokensOf("c".repeat(2_400)),
      tokensOf("b".repeat(1_600)),
      tokensOf("a".repeat(800))
    ]);
    expect(likelyResponseTokens(payload)).toBe(tokensOf("b".repeat(1_600)));
  });

  test("excludes nodes with updatedAt (append, rewrite, in-place edit)", () => {
    const payload = growthPathPayload([
      provider("clean", "c".repeat(800)),
      provider("appended", "a".repeat(9_000), {
        // Append rewrites genId on the node and sets updatedAt; both mark impure.
        genId: "append-gen",
        updatedAt: "2026-02-01T00:00:00.000Z"
      })
    ]);
    expect(recentProviderProseTokenCounts(payload)).toEqual([tokensOf("c".repeat(800))]);
    expect(likelyResponseTokens(payload)).toBe(tokensOf("c".repeat(800)));
  });

  test("excludes attribution markers without updatedAt (edit-as-sibling)", () => {
    const payload = growthPathPayload([
      provider("clean", "c".repeat(800)),
      {
        // Edited sibling: no genId (not copied), may carry attribution spans.
        id: "sibling-edit",
        text: "e".repeat(9_000),
        attribution: { source: "human", ranges: [{ start: 0, end: 10 }] }
      },
      {
        id: "summary-edit-marker",
        text: "m".repeat(8_000),
        role: "summary",
        chapterBreakId: "break-1",
        editedByUser: true
      }
    ]);
    expect(recentProviderProseTokenCounts(payload)).toEqual([tokensOf("c".repeat(800))]);
  });

  test("excludes cut-like unattributed takes that omit genId", () => {
    // createCutTake: no human, no updatedAt, no genId; attribution can stay
    // undefined when the source had none — genId is the provenance gate.
    const payload = growthPathPayload([
      provider("clean", "c".repeat(800)),
      {
        id: "cut-take",
        text: "k".repeat(9_000)
      }
    ]);
    expect(recentProviderProseTokenCounts(payload)).toEqual([tokensOf("c".repeat(800))]);
    expect(likelyResponseTokens(payload)).toBe(tokensOf("c".repeat(800)));
  });

  test("does not guess legacy provider nodes without genId", () => {
    const payload = growthPathPayload([
      // Pre-provenance provider prose: large but must not enter the sample.
      { id: "legacy-provider", text: "L".repeat(9_000) },
      provider("clean", "c".repeat(800))
    ]);
    expect(recentProviderProseTokenCounts(payload)).toEqual([tokensOf("c".repeat(800))]);
    expect(likelyResponseTokens(payload)).toBe(tokensOf("c".repeat(800)));
  });

  test("falls back when only legacy / no-provenance nodes exist", () => {
    const payload = growthPathPayload([
      { id: "legacy-only", text: "L".repeat(9_000) },
      { id: "cut-only", text: "k".repeat(4_000) }
    ]);
    expect(recentProviderProseTokenCounts(payload)).toEqual([]);
    expect(likelyResponseTokens(payload)).toBe(COLD_START_RESPONSE_GROWTH_TOKENS);
  });

  test("does not sample off-path stubs; only active-path full text", () => {
    // A path with only excluded nodes must cold-start even if huge off-path
    // prose would exist as stubs elsewhere (stubs are not consulted).
    const payload = growthPathPayload([
      { id: "human-only", text: "h".repeat(4_000), human: true },
      {
        id: "appended-only",
        text: "a".repeat(4_000),
        genId: "append-only",
        updatedAt: "2026-02-01T00:00:00.000Z"
      }
    ]);
    expect(recentProviderProseTokenCounts(payload)).toEqual([]);
    expect(likelyResponseTokens(payload)).toBe(COLD_START_RESPONSE_GROWTH_TOKENS);
  });

  test("falls back to a conservative cold-start when no clean evidence exists", () => {
    const payload = growthPathPayload([
      { id: "human-only", text: "h".repeat(2_000), human: true },
      {
        id: "summary-only",
        text: "s".repeat(1_500),
        role: "summary",
        chapterBreakId: "break-1"
      },
      {
        id: "updated-only",
        text: "u".repeat(3_000),
        genId: "updated-gen",
        updatedAt: "2026-02-01T00:00:00.000Z"
      },
      {
        id: "attributed-only",
        text: "t".repeat(3_000),
        attribution: { source: "human", ranges: [{ start: 0, end: 4 }] }
      }
    ]);
    expect(recentProviderProseTokenCounts(payload)).toEqual([]);
    expect(likelyResponseTokens(payload)).toBe(COLD_START_RESPONSE_GROWTH_TOKENS);
    expect(estimateResponseGrowthTokens({
      payload,
      maxOutputTokens: 8_000,
      requestTokens: 100,
      contextWindow: 32_000
    })).toBe(COLD_START_RESPONSE_GROWTH_TOKENS);
  });

  test("clamps the growth estimate to max output tokens and free capacity", () => {
    const payload = growthPathPayload([
      provider("a", "a".repeat(3_200)),
      provider("b", "b".repeat(3_600)),
      provider("c", "c".repeat(4_000))
    ]);
    expect(estimateResponseGrowthTokens({
      payload,
      maxOutputTokens: 256,
      requestTokens: 100,
      contextWindow: 32_000
    })).toBe(256);
    expect(estimateResponseGrowthTokens({
      payload,
      maxOutputTokens: 8_000,
      requestTokens: 9_700,
      contextWindow: 10_000
    })).toBe(300);
  });
});
