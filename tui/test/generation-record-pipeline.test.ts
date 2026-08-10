import { describe, expect, test } from "bun:test";
import type { ResolvedGenerationRecord } from "../../shared/generation-record.js";
import type { StoryNode } from "../../shared/types.js";
import {
  adjustmentNotices,
  generationRecordFieldText,
  generationRecordKindLabel,
  generationRecordOperationLabel,
  generationRecordPipelineRows,
  humanEditWarning,
  pipelineCharacterCount,
  visibleEntryCount
} from "../src/generation-record-pipeline.js";

/**
 * Unit coverage for the Generation Record Viewer's pure read model. The
 * ordering, adjustment-stage, and human-edit rules here are not easy to
 * reach end-to-end through the dry-run provider (it never renames or drops
 * a field, and a fresh take is never hand-edited) — the two cases AGENTS.md
 * carves out an exception for. `generation-record-viewer-e2e.test.ts` covers
 * the reachable end-to-end paths, including the real Author's Note split.
 */

const ROOT_REVISION = "a".repeat(64);
const CHILD_REVISION = "b".repeat(64);

const RECORD: ResolvedGenerationRecord = {
  format: "1667-generation-record",
  schemaVersion: 1,
  kind: "continue",
  createdAt: "2026-01-01T00:00:00.000Z",
  provider: { provider: "dry-run", model: "dry-run" },
  effective: {
    wireProtocol: "dry-run",
    fields: [{ field: "temperature", value: 0.8 }],
    adjustments: [
      { stage: "construction", field: "top_p", action: "skipped-cached-refusal" },
      { stage: "retry", field: "max_tokens", action: "renamed", toField: "max_completion_tokens", attempt: 1 },
      { stage: "retry", field: "stop", action: "dropped", attempt: 0 },
      { stage: "construction", field: "seed", action: "added" }
    ]
  },
  prompt: {
    operation: "continue",
    entries: [
      { role: "system", stability: "stable", kind: "author-brief", source: "text", text: "Write vividly." },
      { role: "user", stability: "stable", kind: "facts", source: "text", text: "The keeper is kind." },
      {
        stability: "stable",
        kind: "source",
        source: "revisions",
        parts: [{
          nodeId: "root",
          category: "recent",
          instruction: "Chapter one begins.",
          revisionId: ROOT_REVISION,
          text: "The lighthouse stood alone."
        }]
      },
      { role: "user", stability: "stable", kind: "authors-note", source: "text", text: "Foreshadow the storm." },
      {
        stability: "stable",
        kind: "source",
        source: "revisions",
        parts: [{
          nodeId: "child",
          category: "recent",
          instruction: "Then the storm came.",
          revisionId: CHILD_REVISION,
          text: "Rain lashed the windows."
        }]
      },
      { role: "user", stability: "volatile", kind: "request", source: "text", text: "Continue the story." }
    ]
  }
};

describe("generation record pipeline rows", () => {
  test("flattens text entries and expands source parts, preserving exact order", () => {
    const rows = generationRecordPipelineRows(RECORD);
    expect(rows.map((row) => row.content)).toEqual([
      "Write vividly.",
      "The keeper is kind.",
      "Chapter one begins.",
      "The lighthouse stood alone.",
      "Foreshadow the storm.",
      "Then the storm came.",
      "Rain lashed the windows.",
      "Continue the story."
    ]);
    expect(rows.map((row) => row.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  test("labels text entries with role and kind, and source parts with category and node id", () => {
    const rows = generationRecordPipelineRows(RECORD);
    expect(rows[0]!.label).toBe("system · author brief");
    expect(rows[1]!.label).toBe("user · facts");
    expect(rows[2]!.label).toBe("user · source instruction · recent · root");
    expect(rows[3]!.label).toBe("assistant · source prose · recent · root");
    expect(rows[4]!.label).toBe("user · author's note");
    expect(rows[5]!.label).toBe("user · source instruction · recent · child");
    expect(rows[6]!.label).toBe("assistant · source prose · recent · child");
    expect(rows[7]!.label).toBe("user · request");
  });

  test("restores user and assistant roles for each compact source part", () => {
    const rows = generationRecordPipelineRows(RECORD);
    expect(rows[0]!.role).toBe("system");
    expect(rows[2]!.role).toBe("user");
    expect(rows[3]!.role).toBe("assistant");
    expect(rows[5]!.role).toBe("user");
    expect(rows[6]!.role).toBe("assistant");
  });

  test("a source part with no instruction keeps the empty user turn before its prose", () => {
    const noInstruction: ResolvedGenerationRecord = {
      ...RECORD,
      prompt: {
        operation: "continue",
        entries: [{
          stability: "stable",
          kind: "source",
          source: "revisions",
          parts: [{ nodeId: "root", category: "summary", instruction: "", revisionId: ROOT_REVISION, text: "A quiet morning." }]
        }]
      }
    };
    const rows = generationRecordPipelineRows(noInstruction);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.content).toBe("");
    expect(rows[0]!.role).toBe("user");
    expect(rows[1]!.content).toBe("A quiet morning.");
    expect(rows[1]!.label).toBe("assistant · source prose · summary · root");
  });

  test("visibleEntryCount matches the row count, and is zero for a missing detail", () => {
    expect(visibleEntryCount(RECORD)).toBe(8);
    expect(visibleEntryCount(null)).toBe(0);
  });

  test("pipelineCharacterCount sums every row's exact content length", () => {
    const expected = generationRecordPipelineRows(RECORD).reduce((sum, row) => sum + row.content.length, 0);
    expect(pipelineCharacterCount(RECORD)).toBe(expected);
    expect(expected).toBeGreaterThan(0);
  });
});

describe("generation record labels", () => {
  test("every kind has a distinct human label", () => {
    expect(generationRecordKindLabel("continue")).toBe("continuation");
    expect(generationRecordKindLabel("rewrite-take")).toContain("rewrite");
    expect(generationRecordKindLabel("rewrite-in-place")).toContain("in place");
    expect(generationRecordKindLabel("unsupported")).toBe("unsupported");
  });

  test("operation labels are plain words", () => {
    expect(generationRecordOperationLabel("continue")).toBe("continue");
    expect(generationRecordOperationLabel("rewrite")).toBe("rewrite");
    expect(generationRecordOperationLabel("summary")).toBe("summary");
  });

  test("a field renders as field: value", () => {
    expect(generationRecordFieldText({ field: "temperature", value: 0.8 })).toBe("temperature: 0.8");
    expect(generationRecordFieldText({ field: "stream", value: false })).toBe("stream: false");
  });
});

describe("generation record adjustment notices", () => {
  test("construction and retry stages stay apart", () => {
    const construction = adjustmentNotices(RECORD.effective.adjustments, "construction");
    const retry = adjustmentNotices(RECORD.effective.adjustments, "retry");
    expect(construction).toEqual([
      "top_p skipped · a prior request already learned this model refuses it",
      "seed added"
    ]);
    expect(retry).toEqual([
      "max_tokens renamed to max_completion_tokens (attempt 1)",
      "stop dropped (attempt 0)"
    ]);
  });

  test("an empty adjustment list produces no notices for either stage", () => {
    expect(adjustmentNotices([], "construction")).toEqual([]);
    expect(adjustmentNotices([], "retry")).toEqual([]);
  });
});

describe("human edit warning", () => {
  const BASE_NODE: StoryNode = {
    id: "n1",
    parentId: null,
    instruction: "",
    text: "The old cat sat on the mat.",
    model: "dry-run",
    createdAt: "2026-01-01T00:00:00.000Z",
    activeChildId: null
  };

  test("absent for an undefined node, no attribution, or empty ranges", () => {
    expect(humanEditWarning(undefined)).toBe(null);
    expect(humanEditWarning(BASE_NODE)).toBe(null);
    expect(humanEditWarning({ ...BASE_NODE, attribution: { source: "human", ranges: [] } })).toBe(null);
  });

  test("present once the node carries a nonempty human-edit range", () => {
    const warning = humanEditWarning({
      ...BASE_NODE,
      attribution: { source: "human", ranges: [{ start: 0, end: 3 }] }
    });
    expect(warning).not.toBe(null);
    expect(warning).toContain("edited by hand");
  });

  test("present for a deletion-only edit — empty ranges, characters removed", () => {
    const warning = humanEditWarning({
      ...BASE_NODE,
      attribution: { source: "human", ranges: [], deletedCharacters: 4 }
    });
    expect(warning).not.toBe(null);
    expect(warning).toContain("edited by hand");
  });

  test("present for a node stub whose deletion-only edit was already reduced to editedByUser", () => {
    const warning = humanEditWarning({
      id: "n1", parentId: null, preview: "The cat sat.", words: 3, tokens: 4, childCount: 0, leafCount: 1,
      lastTouched: BASE_NODE.createdAt, hasInstruction: false, activeChildId: null,
      editedByUser: true
    });
    expect(warning).not.toBe(null);
    expect(warning).toContain("edited by hand");
  });
});
