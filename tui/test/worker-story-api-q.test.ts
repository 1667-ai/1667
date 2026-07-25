import { expect, test } from "bun:test";
import { demoAppSource } from "../src/demo.js";
import { storyApiFromWorkerTransport } from "../src/worker-story-api.js";

test("catalog summaries cannot regress a newer held Q revision", async () => {
  const source = demoAppSource();
  const payload = {
    ...structuredClone(source.payload),
    id: "versioned-story",
    aggregateVersion: {
      kind: "v6" as const,
      revision: "00000000000000000005" as const
    }
  };
  const summary = {
    ...structuredClone(source.stories[0]!),
    id: payload.id,
    aggregateVersion: {
      kind: "v6" as const,
      revision: "00000000000000000004" as const
    }
  };
  let expectedVersion: unknown;
  const api = storyApiFromWorkerTransport({
    call: async (method: string, _input: unknown, options?: {
      expectedAggregateVersion?: unknown;
    }) => {
      if (method === "loadStory") return payload;
      if (method === "listStoriesPage") {
        return {
          scanId: "0".repeat(32),
          items: [summary],
          cursor: null,
          done: true
        };
      }
      if (method === "renameStory") {
        expectedVersion = options?.expectedAggregateVersion;
        return payload;
      }
      throw new Error(`Unexpected method: ${method}`);
    }
  } as never);

  await api.loadStory(payload.id);
  await api.listStories();
  await api.renameStory(payload.id, "Renamed");
  expect(expectedVersion).toEqual(payload.aggregateVersion);
});

test("deleted unknown outcomes use status revision and retire their archive", async () => {
  const dismissed: string[] = [];
  let acknowledgementVersion: unknown;
  const mutationId = "m1.1767225600000.0123456789abcdef0123456789abcdef";
  const api = storyApiFromWorkerTransport({
    call: async (method: string, _input: unknown, options?: {
      expectedAggregateVersion?: unknown;
    }) => {
      if (method === "getUnknownOutcomeStatus") {
        return {
          state: "pending",
          deleted: true,
          aggregateVersion: {
            kind: "v6",
            revision: "00000000000000000007"
          }
        };
      }
      if (method === "acknowledgeUnknownOutcomes") {
        acknowledgementVersion = options?.expectedAggregateVersion;
        return null;
      }
      throw new Error(`Unexpected method: ${method}`);
    },
    dismissArchivedMutation: async (id: string) => { dismissed.push(id); }
  } as never);

  expect(await api.acknowledgeUnknownOutcomes("deleted-story", mutationId))
    .toBe(null);
  expect(acknowledgementVersion).toEqual({
    kind: "v6",
    revision: "00000000000000000007"
  });
  expect(dismissed).toEqual([mutationId]);
});

test("restart reconciliation dismisses an already resolved archive without a second mutation", async () => {
  const dismissed: string[] = [];
  let mutations = 0;
  const mutationId = "m1.1767225600000.1123456789abcdef0123456789abcdef";
  const api = storyApiFromWorkerTransport({
    call: async (method: string) => {
      if (method === "getUnknownOutcomeStatus") {
        return { state: "resolved", deleted: true };
      }
      if (method === "acknowledgeUnknownOutcomes") mutations += 1;
      throw new Error(`Unexpected method: ${method}`);
    },
    dismissArchivedMutation: async (id: string) => { dismissed.push(id); }
  } as never);

  expect(await api.acknowledgeUnknownOutcomes("deleted-story", mutationId))
    .toBe(null);
  expect(mutations).toBe(0);
  expect(dismissed).toEqual([mutationId]);
});

test("chapter removal sends the bounded preview fingerprint and exact version", async () => {
  const calls: Array<{
    method: string;
    input: unknown;
    expectedAggregateVersion?: unknown;
  }> = [];
  const version = {
    kind: "v6" as const,
    revision: "00000000000000000009"
  };
  const removed = {
    break: {
      id: "break",
      parentPartId: "part",
      title: "Chapter",
      createdAt: "2026-01-01T00:00:00.000Z"
    },
    summaries: []
  };
  const payload = {
    ...structuredClone(demoAppSource().payload),
    id: "story",
    aggregateVersion: version
  };
  const api = storyApiFromWorkerTransport({
    call: async (
      method: string,
      input: unknown,
      options?: { expectedAggregateVersion?: unknown }
    ) => {
      calls.push({
        method,
        input,
        expectedAggregateVersion: options?.expectedAggregateVersion
      });
      if (method === "previewChapterBreakRemoval") {
        return {
          removedFingerprint: "a".repeat(64),
          aggregateVersion: version
        };
      }
      if (method === "removeChapterBreak") {
        return { payload, removed };
      }
      throw new Error(`Unexpected method: ${method}`);
    }
  } as never);

  expect(await api.removeChapterBreak("story", "break"))
    .toEqual({ payload, removed });
  expect(calls[1]).toEqual({
    method: "removeChapterBreak",
    input: {
      storyId: "story",
      breakId: "break",
      removedFingerprint: "a".repeat(64)
    },
    expectedAggregateVersion: version
  });
});
