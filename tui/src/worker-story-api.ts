import type {
  WorkerInput,
  WorkerMethod,
  WorkerOutput
} from "../../shared/worker-protocol.js";
import type { StoryAggregateVersion } from "../../shared/story-aggregate-version.js";
import type { ProviderRecoveryContext } from "../../shared/provider-recovery.js";
import { textHash, type StoryApi } from "./api.js";
import type { StoryPayload, StorySummary } from "../../shared/types.js";
import { normalizeMarkdownDefaultTitle } from "../../shared/import-markdown-wire.js";

export interface StoryWorkerTransport {
  call<M extends WorkerMethod>(
    method: M,
    input: WorkerInput<M>,
    options?: {
      onDelta?: (text: string) => void;
      signal?: AbortSignal;
      expectedAggregateVersion?: StoryAggregateVersion;
    }
  ): Promise<WorkerOutput<M>>;
  dismissArchivedMutation?(mutationId: string): Promise<void>;
}

export function storyApiFromWorkerTransport(transport: StoryWorkerTransport): StoryApi {
  const versions = new Map<string, StoryAggregateVersion>();
  const rememberPayload = (payload: StoryPayload): StoryPayload => {
    if (payload.aggregateVersion !== undefined) {
      versions.set(payload.id, payload.aggregateVersion);
    }
    return payload;
  };
  const rememberSummaries = (summaries: StorySummary[]): StorySummary[] => {
    for (const summary of summaries) {
      if (summary.aggregateVersion !== undefined) {
        const held = versions.get(summary.id);
        if (held === undefined
          || held.kind !== "v6"
          || (summary.aggregateVersion.kind === "v6"
            && summary.aggregateVersion.revision >= held.revision)) {
          versions.set(summary.id, summary.aggregateVersion);
        }
      }
    }
    return summaries;
  };
  const expectedVersion = async (storyId: string): Promise<StoryAggregateVersion> => {
    const held = versions.get(storyId);
    if (held !== undefined) return held;
    const loaded = rememberPayload(await transport.call("loadStory", { id: storyId }));
    if (loaded.aggregateVersion === undefined) {
      throw new Error("This story was loaded without successor-Q version metadata.");
    }
    return loaded.aggregateVersion;
  };
  const runProviderMutation = async <T>(
    storyId: string,
    work: () => Promise<T>
  ): Promise<T> => {
    try {
      const result = await work();
      if (result === null) versions.delete(storyId);
      return result;
    } catch (error) {
      // A terminal provider failure can advance the receipt-only story
      // revision without returning a payload that carries the new token.
      versions.delete(storyId);
      throw error;
    }
  };
  const dismissArchivedMutation = async (
    mutationId: string
  ): Promise<void> => {
    await transport.dismissArchivedMutation?.(
      mutationId
    ).catch(() => undefined);
  };
  return {
    listStories: async () => {
      const held = new Map<string, StorySummary>();
      let cursor: string | null = null;
      do {
        const page: WorkerOutput<"listStoriesPage"> = await transport.call("listStoriesPage", {
          cursor,
          maxEntries: 64
        });
        for (const summary of page.items) {
          const current = held.get(summary.id);
          if (current === undefined || summaryIsNewer(summary, current)) {
            held.set(summary.id, summary);
          }
        }
        cursor = page.cursor;
      } while (cursor !== null);
      return rememberSummaries(
        [...held.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      );
    },
    searchStories: async (search, signal) => {
      const response = await transport.call(
        "searchStories",
        search,
        signal === undefined ? {} : { signal }
      );
      // The transport answers an aborted call with null rather than rejecting.
      // Search reports cancellation the same way over both backends, so the
      // caller never has to know which one it is talking to.
      if (response === null) throw new Error("Search was superseded or cancelled");
      return response;
    },
    createStory: async (title) => rememberPayload(
      await transport.call("createStory", title === undefined ? {} : { title }, {
        expectedAggregateVersion: { kind: "absent" }
      })
    ),
    loadStory: async (id) => rememberPayload(await transport.call("loadStory", { id })),
    renameStory: async (id, title) => rememberPayload(await transport.call(
      "renameStory",
      { id, title },
      { expectedAggregateVersion: await expectedVersion(id) }
    )),
    setAuthorsNote: async (storyId, note, depth) => rememberPayload(await transport.call(
      "setAuthorsNote",
      { storyId, note, ...(depth === undefined ? {} : { depth }) },
      { expectedAggregateVersion: await expectedVersion(storyId) }
    )),
    setAuthorBrief: async (storyId, brief) => rememberPayload(await transport.call(
      "setAuthorBrief",
      { storyId, brief },
      { expectedAggregateVersion: await expectedVersion(storyId) }
    )),
    autonameStory: async (id) => {
      return await runProviderMutation(id, async () => {
        const current = rememberPayload(await transport.call("loadStory", { id }));
        return rememberPayload(await transport.call(
          "autonameStory",
          { id, expectedTitle: current.title },
          { expectedAggregateVersion: await expectedVersion(id) }
        ));
      });
    },
    acknowledgeUnknownOutcomes: async (
      storyId,
      originalProviderMutationId,
      providerRecovery
    ) => {
      const status = await transport.call("getUnknownOutcomeStatus", {
        storyId,
        originalProviderMutationId,
        ...(providerRecovery === undefined
          ? {}
          : { providerRecovery })
      });
      if (status.state === "resolved") {
        await dismissArchivedMutation(originalProviderMutationId);
        if (status.deleted) {
          versions.delete(storyId);
          return null;
        }
        return rememberPayload(await transport.call("loadStory", { id: storyId }));
      }
      versions.set(storyId, status.aggregateVersion);
      const payload = await transport.call(
        "acknowledgeUnknownOutcomes",
        {
          storyId,
          originalProviderMutationId,
          ...(providerRecovery === undefined
            ? {}
            : { providerRecovery })
        },
        { expectedAggregateVersion: status.aggregateVersion }
      );
      await dismissArchivedMutation(originalProviderMutationId);
      if (payload === null) {
        versions.delete(storyId);
        return null;
      }
      return rememberPayload(payload);
    },
    deleteStory: async (id) => {
      const result = await transport.call(
        "deleteStory",
        { id },
        { expectedAggregateVersion: await expectedVersion(id) }
      );
      versions.delete(id);
      return result;
    },
    exportMarkdown: (id) => transport.call("exportMarkdown", { id }),
    switchLine: async (storyId, nodeId, options = {}) => rememberPayload(
      await transport.call(
        "switchLine",
        { storyId, nodeId, options },
        { expectedAggregateVersion: await expectedVersion(storyId) }
      )
    ),
    createNode: async (storyId, body) => rememberPayload(await transport.call(
      "createNode",
      { storyId, body },
      { expectedAggregateVersion: await expectedVersion(storyId) }
    )),
    editNode: async (storyId, node, patch) => rememberPayload(await transport.call(
      "editNode",
      {
        storyId,
        nodeId: node.id,
        body: { ...patch, expectedTextHash: await textHash(node.text) }
      },
      { expectedAggregateVersion: await expectedVersion(storyId) }
    )),
    deleteNode: async (storyId, nodeId, expectedSubtreeCount) =>
      rememberPayload(await transport.call(
        "deleteNode",
        { storyId, nodeId, expectedSubtreeCount },
        { expectedAggregateVersion: await expectedVersion(storyId) }
      )),
    pruneUnusedTakes: async (storyId, body) => rememberPayload(await transport.call(
      "pruneUnusedTakes",
      { storyId, body },
      { expectedAggregateVersion: await expectedVersion(storyId) }
    )),
    takeFromCut: async (storyId, nodeId, body) => rememberPayload(await transport.call(
      "takeFromCut",
      { storyId, nodeId, body },
      { expectedAggregateVersion: await expectedVersion(storyId) }
    )),
    putBookmark: async (storyId, nodeId, name, label) => rememberPayload(
      await transport.call(
        "putBookmark",
        { storyId, nodeId, name, label },
        { expectedAggregateVersion: await expectedVersion(storyId) }
      )
    ),
    deleteBookmark: async (storyId, nodeId) => rememberPayload(await transport.call(
      "deleteBookmark",
      { storyId, nodeId },
      { expectedAggregateVersion: await expectedVersion(storyId) }
    )),
    createFact: async (storyId, body) => rememberPayload(await transport.call(
      "createFact",
      { storyId, body },
      { expectedAggregateVersion: await expectedVersion(storyId) }
    )),
    patchFact: async (storyId, factId, body) => rememberPayload(await transport.call(
      "patchFact",
      { storyId, factId, body },
      { expectedAggregateVersion: await expectedVersion(storyId) }
    )),
    deleteFact: async (storyId, factId) => rememberPayload(await transport.call(
      "deleteFact",
      { storyId, factId },
      { expectedAggregateVersion: await expectedVersion(storyId) }
    )),
    createChapterBreak: async (storyId, parentPartId, title = "") => {
      const result = await transport.call(
        "createChapterBreak",
        { storyId, parentPartId, title },
        { expectedAggregateVersion: await expectedVersion(storyId) }
      );
      rememberPayload(result.payload);
      return result;
    },
    renameChapterBreak: async (storyId, breakId, title) => rememberPayload(
      await transport.call(
        "renameChapterBreak",
        { storyId, breakId, title },
        { expectedAggregateVersion: await expectedVersion(storyId) }
      )
    ),
    removeChapterBreak: async (storyId, breakId) => {
      const preview = await transport.call(
        "previewChapterBreakRemoval",
        { storyId, breakId }
      );
      const result = await transport.call(
        "removeChapterBreak",
        {
          storyId,
          breakId,
          removedFingerprint: preview.removedFingerprint
        },
        { expectedAggregateVersion: preview.aggregateVersion }
      );
      rememberPayload(result.payload);
      return result;
    },
    restoreChapterBreak: async (storyId, breakId, removed) => rememberPayload(
      await transport.call(
        "restoreChapterBreak",
        { storyId, breakId, removed },
        { expectedAggregateVersion: await expectedVersion(storyId) }
      )
    ),
    summarizeChapter: async (storyId, breakId) => runProviderMutation(
      storyId,
      async () => rememberPayload(
        await transport.call(
          "summarizeChapter",
          { storyId, breakId },
          { expectedAggregateVersion: await expectedVersion(storyId) }
        )
      )
    ),
    editChapterSummary: async (storyId, summaryId, text, expected) =>
      rememberPayload(await transport.call(
        "editNode",
        {
          storyId,
          nodeId: summaryId,
          body: { text, expectedTextHash: await textHash(expected) }
        },
        { expectedAggregateVersion: await expectedVersion(storyId) }
      )),
    getSettings: () => transport.call("getSettings", {}),
    saveSettings: (command) => transport.call("saveSettings", { command }),
    discardPendingSettings: (command) => transport.call("discardPendingSettings", { command }),
    checkModelServer: (settings) => transport.call("checkModelServer", { settings }),
    probeContextWindow: (settings) => transport.call("probeContextWindow", { settings }),
    discoverModels: (settings, signal) => transport.call(
      "discoverModels",
      { settings },
      { signal }
    ),
    importSillyTavern: async (jsonl) => rememberPayload(await transport.call(
      "importSillyTavern",
      { jsonl },
      { expectedAggregateVersion: { kind: "absent" } }
    )),
    importMarkdown: async (markdown, defaultTitle) => rememberPayload(await transport.call(
      "importMarkdown",
      {
        markdown,
        ...(defaultTitle !== undefined
          ? { defaultTitle: normalizeMarkdownDefaultTitle(defaultTitle) }
          : {})
      },
      { expectedAggregateVersion: { kind: "absent" } }
    )),
    importNovelAI: async (storyContainerJson) => {
      const result = await transport.call(
        "importNovelAI",
        { storyContainerJson },
        { expectedAggregateVersion: { kind: "absent" } }
      );
      rememberPayload(result.payload);
      return result;
    },
    importScenario: async (jsonText) => {
      const result = await transport.call(
        "importScenario",
        { jsonText },
        { expectedAggregateVersion: { kind: "absent" } }
      );
      rememberPayload(result.payload);
      return result;
    },
    importLorebook: async (storyId, archiveBytes) => {
      const result = await transport.call(
        "importLorebook",
        { storyId, archiveBytes },
        { expectedAggregateVersion: await expectedVersion(storyId) }
      );
      rememberPayload(result.payload);
      return result;
    },

    continueStory: async (storyId, instruction, genId, target, onDelta, signal) => {
      return await runProviderMutation(storyId, async () => {
        const result = await transport.call(
          "continueStory",
          { storyId, instruction, genId, target },
          {
            onDelta,
            signal,
            expectedAggregateVersion: await expectedVersion(storyId)
          }
        );
        return result === null ? null : rememberPayload(result);
      });
    },
    rewriteNode: async (storyId, nodeId, body, onDelta, signal, onCommitted) => {
      return await runProviderMutation(storyId, async () => {
        const result = await transport.call(
          "rewriteNode",
          { storyId, nodeId, body },
          {
            onDelta,
            signal,
            expectedAggregateVersion: await expectedVersion(storyId)
          }
        );
        if (result !== null) {
          // Same ordering as the HTTP adapter: durable the moment the call
          // resolves an id, recorded before the loadStory refresh that could
          // itself reject and hide that the take already landed.
          onCommitted?.(result);
          rememberPayload(await transport.call("loadStory", { id: storyId }));
        }
        return result;
      });
    },
    createSummaryTake: async (storyId, body, onDelta, signal) => {
      return await runProviderMutation(storyId, async () => {
        const result = await transport.call(
          "createSummaryTake",
          { storyId, body },
          {
            onDelta,
            signal,
            expectedAggregateVersion: await expectedVersion(storyId)
          }
        );
        if (result !== null) {
          rememberPayload(await transport.call("loadStory", { id: storyId }));
        }
        return result;
      });
    }
  };
}

function summaryIsNewer(candidate: StorySummary, current: StorySummary): boolean {
  const candidateVersion = candidate.aggregateVersion;
  const currentVersion = current.aggregateVersion;
  if (candidateVersion?.kind === "v6" && currentVersion?.kind === "v6") {
    return candidateVersion.revision > currentVersion.revision;
  }
  return candidateVersion?.kind === "v6" && currentVersion?.kind !== "v6";
}
