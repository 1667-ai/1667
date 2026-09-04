import type {
  WorkerInput,
  WorkerMethod,
  WorkerOutput
} from "../../shared/worker-protocol.js";
import {
  storyAggregateVersionIsAtLeast,
  type StoryAggregateVersion
} from "../../shared/story-aggregate-version.js";
import type { ProviderRecoveryContext } from "../../shared/provider-recovery.js";
import {
  textHash,
  type StoryApi,
  type StreamCallbacks,
  type SummaryStreamCallbacks
} from "./api.js";
import { explicitMutationUnsentFromCause } from "./api-error.js";
import type { StoryPayload, StorySummary } from "../../shared/types.js";
import { normalizeMarkdownDefaultTitle } from "../../shared/import-markdown-wire.js";
import type { SaveSettingsCommand } from "../../shared/settings-v2-types.js";
import type {
  AsideAskRequest,
  AsideAskResponse,
  AsideReadRequest,
  AsideReadResponse,
  AsideLegacyReadResponse,
  AsideSessionMutationRequest,
  AsideSessionMutationResponse
} from "../../shared/aside-transport.js";
import {
  parseAsideAskResponse,
  parseAsideLegacyReadResponse,
  parseAsideReadResponse,
  parseAsideSessionMutationResponse
} from "../../shared/aside-transport-codec.js";
import type { ReasoningDelta } from "./worker-pending.js";
import {
  decodeFactConsistencyCheckResponse,
  decodeFactConsistencyPlanResponse,
  decodeFactConsistencyRunResponse
} from "./fact-consistency-api.js";

export interface StoryWorkerTransport {
  call<M extends WorkerMethod>(
    method: M,
    input: WorkerInput<M>,
    options?: {
      onDelta?: (text: string) => void;
      onStopped?: (text: string) => void;
      onReasoning?: (delta: ReasoningDelta) => void;
      onReasoningStopped?: (text: string) => void;
      signal?: AbortSignal;
      expectedAggregateVersion?: StoryAggregateVersion;
    }
  ): Promise<WorkerOutput<M>>;
  dismissArchivedMutation?(mutationId: string): Promise<void>;
}

function legacyAside(value: unknown): AsideLegacyReadResponse | null {
  if (value === null) return null;
  try {
    return parseAsideLegacyReadResponse(value);
  } catch {
    return null;
  }
}

function v2Aside(value: unknown): AsideAskResponse | null {
  if (value === null) return null;
  try {
    return parseAsideAskResponse(value);
  } catch {
    return null;
  }
}

function v2Read(value: unknown): AsideReadResponse | null {
  if (value === null) return null;
  try {
    return parseAsideReadResponse(value);
  } catch {
    return null;
  }
}

function legacyNotes(
  value: AsideLegacyReadResponse | AsideAskResponse | AsideReadResponse
): AsideLegacyReadResponse {
  if ("notes" in value) return value;
  const sessions = "sessions" in value ? value.sessions : [value];
  return {
    notes: sessions.flatMap((session) =>
      session.turns.map((turn) => ({ question: turn.q, answer: turn.a })))
  };
}

function asideMutationSession(value: unknown): AsideSessionMutationResponse | null {
  if (value === null) return null;
  try {
    return parseAsideSessionMutationResponse(value);
  } catch {
    return null;
  }
}

/** Materialize the JSON settings command before the Worker boundary. A draft
 * can share nested profile values; JSON wire materialization keeps each
 * profile's reasoning union in its own value instead of relying on the
 * runtime's structured-clone alias handling. */
function materializeSaveSettingsCommand(
  command: SaveSettingsCommand
): SaveSettingsCommand {
  return JSON.parse(JSON.stringify(command)) as SaveSettingsCommand;
}

export function storyApiFromWorkerTransport(transport: StoryWorkerTransport): StoryApi {
  const versions = new Map<string, StoryAggregateVersion>();
  const rememberPayload = (payload: StoryPayload): StoryPayload => {
    const candidate = payload.aggregateVersion;
    const held = versions.get(payload.id);
    if (candidate !== undefined
      && (held === undefined || storyAggregateVersionIsAtLeast(candidate, held))) {
      versions.set(payload.id, candidate);
    }
    return payload;
  };
  const rememberSummaries = (summaries: StorySummary[]): StorySummary[] => {
    for (const summary of summaries) {
      if (summary.aggregateVersion !== undefined) {
        const held = versions.get(summary.id);
        if (held === undefined
          || storyAggregateVersionIsAtLeast(summary.aggregateVersion, held)) {
          versions.set(summary.id, summary.aggregateVersion);
        }
      }
    }
    return summaries;
  };
  const expectedVersion = async (
    storyId: string,
    signal?: AbortSignal
  ): Promise<StoryAggregateVersion> => {
    const held = versions.get(storyId);
    if (held !== undefined) return held;
    const payload = await transport.call(
      "loadStory",
      { id: storyId },
      signal === undefined ? {} : { signal }
    );
    signal?.throwIfAborted();
    const loaded = rememberPayload(payload);
    if (loaded.aggregateVersion === undefined) {
      throw new Error("This story was loaded without successor-Q version metadata.");
    }
    return loaded.aggregateVersion;
  };
  const refreshAsideMutation = async (
    storyId: string,
    value: unknown
  ): Promise<AsideSessionMutationResponse> => {
    const response = asideMutationSession(value);
    if (response === null) {
      throw new Error("The worker returned an invalid Aside session mutation.");
    }
    if (response.payload !== undefined) {
      rememberPayload(response.payload);
      return response;
    }
    let payload: StoryPayload | undefined;
    try {
      payload = rememberPayload(await transport.call("loadStory", { id: storyId }));
    } catch {
      // The local verb is already committed. Keep its canonical session id,
      // and force the next story mutation to refresh its version lazily.
      versions.delete(storyId);
    }
    return payload === undefined ? response : { ...response, payload };
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
    setFactsBudget: async (storyId, budgetTokens) => rememberPayload(await transport.call(
      "setFactsBudget",
      { storyId, budgetTokens },
      { expectedAggregateVersion: await expectedVersion(storyId) }
    )),
    setPhraseBias: async (storyId, phraseBias) => rememberPayload(await transport.call(
      "setPhraseBias",
      { storyId, phraseBias },
      { expectedAggregateVersion: await expectedVersion(storyId) }
    )),
    setBannedStrings: async (storyId, bannedStrings) => rememberPayload(await transport.call(
      "setBannedStrings",
      { storyId, bannedStrings },
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
    // createNode only: cold-cache version preflight is adapter-owned and runs
    // before any createNode worker post or mutation id. Failures here are
    // definitely unsent. Do not widen this to other mutations; post-send
    // WorkerApiError with null outcome stays conservatively uncertain.
    createNode: async (storyId, body) => {
      let expectedAggregateVersion: StoryAggregateVersion;
      try {
        expectedAggregateVersion = await expectedVersion(storyId);
      } catch (error) {
        throw explicitMutationUnsentFromCause(
          error,
          "createNode was not sent",
          "createNode was not sent; story version preflight failed."
        );
      }
      return rememberPayload(await transport.call(
        "createNode",
        { storyId, body },
        { expectedAggregateVersion }
      ));
    },
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
    pasteStoryLine: async (storyId, targetParentId, body) => rememberPayload(await transport.call(
      "pasteStoryLine",
      { storyId, nodeId: targetParentId, body },
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
    createFactState: async (storyId, factId, body) => rememberPayload(await transport.call(
      "createFactState",
      { storyId, factId, body },
      { expectedAggregateVersion: await expectedVersion(storyId) }
    )),
    patchFactState: async (storyId, factId, stateId, body) => rememberPayload(await transport.call(
      "patchFactState",
      { storyId, factId, stateId, body },
      { expectedAggregateVersion: await expectedVersion(storyId) }
    )),
    deleteFactState: async (storyId, factId, stateId) => rememberPayload(await transport.call(
      "deleteFactState",
      { storyId, factId, stateId },
      { expectedAggregateVersion: await expectedVersion(storyId) }
    )),
    reorderFact: async (storyId, factId, toIndex) => rememberPayload(await transport.call(
      "reorderFact",
      { storyId, factId, body: { toIndex } },
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
    getTokenProbabilities: async (storyId, nodeId) =>
      await transport.call("getTokenProbabilities", { storyId, nodeId }),
    getGenerationRecords: async (storyId, nodeId) =>
      await transport.call("getGenerationRecords", { storyId, nodeId }),
    getGenerationRecord: async (storyId, nodeId, recordId) =>
      await transport.call("getGenerationRecord", { storyId, nodeId, recordId }),
    getReasoning: async (storyId, nodeId) =>
      await transport.call("getReasoning", { storyId, nodeId }),
    planFactConsistency: async (input) => decodeFactConsistencyPlanResponse(
      await transport.call("planFactConsistency", input)
    ),
    checkFactConsistency: async (input) => {
      const result = decodeFactConsistencyCheckResponse(
        await transport.call(
          "checkFactConsistency",
          input,
          { expectedAggregateVersion: await expectedVersion(input.storyId) }
        )
      );
      rememberPayload(result.payload);
      return result;
    },
    getFactConsistencyRun: async (storyId) => decodeFactConsistencyRunResponse(
      await transport.call("getFactConsistencyRun", { storyId })
    ),
    getAside: async (storyId) => {
      const result = await transport.call("getAside", { storyId });
      const legacy = legacyAside(result);
      if (legacy !== null) return legacy;
      const read = v2Read(result);
      if (read !== null) return legacyNotes(read);
      const session = v2Aside(result);
      if (session === null) {
        throw new Error("The worker returned an invalid Aside document.");
      }
      return legacyNotes(session);
    },
    getAsideV2: async (asideRequest) => {
      const result = await transport.call("getAside", asideRequest);
      const legacy = legacyAside(result);
      if (legacy !== null) return null;
      const read = v2Read(result);
      if (read !== null) return read;
      const session = v2Aside(result);
      if (session === null) {
        throw new Error("The worker returned an invalid Aside v2 read.");
      }
      return {
        schemaVersion: 2,
        anchor: session.anchor,
        sessions: [session],
        anchors: session.anchor === null
          ? [] : [{ ...session.anchor, sessionCount: 1 }],
        unanchoredCount: session.anchor === null ? 1 : 0
      } satisfies AsideReadResponse;
    },
    askAside: async (storyId, question, onDelta, signal) => {
      return await runProviderMutation(storyId, async () => {
        const result = await transport.call(
          "askAside",
          { storyId, question },
          {
            onDelta,
            expectedAggregateVersion: await expectedVersion(storyId),
            signal
          }
        );
        if (result !== null) {
          const legacy = legacyAside(result);
          const session = v2Aside(result);
          const read = v2Read(result);
          if (legacy === null && session === null && read === null) {
            throw new Error("The worker returned an invalid Aside document.");
          }
          const normalized = legacyNotes(legacy ?? session ?? read!);
          // askAside returns a document view rather than a StoryPayload, so
          // load the new aggregate version before the next mutation. The
          // terminal result is already committed. A transient refresh failure
          // must not hide it and invite a duplicate question; forget the
          // stale token so the next mutation loads it lazily.
          let payload: StoryPayload | undefined;
          try {
            payload = rememberPayload(await transport.call("loadStory", { id: storyId }));
          } catch {
            versions.delete(storyId);
          }
          if (payload !== undefined) return { ...normalized, payload };
          return normalized;
        }
        return null;
      });
    },
    askAsideV2: async (asideRequest, onDelta, callbacks, signal) => {
      return await runProviderMutation(asideRequest.storyId, async () => {
        const result = await transport.call(
          "askAside",
          asideRequest,
          {
            onDelta: (text) => {
              callbacks?.onPhase?.("writing");
              onDelta(text);
            },
            onStopped: callbacks?.onStopped,
            onReasoning: (delta) => {
              callbacks?.onPhase?.("thinking");
              callbacks?.onReasoning?.(delta);
            },
            onReasoningStopped: callbacks?.onReasoningStopped,
            expectedAggregateVersion: await expectedVersion(asideRequest.storyId, signal),
            signal
          }
        );
        if (result === null) return null;
        const session = v2Aside(result);
        if (session === null) {
          throw new Error("The worker returned an invalid Aside v2 result.");
        }
        if (session.payload !== undefined) {
          rememberPayload(session.payload);
          return session;
        }
        let payload: StoryPayload | undefined;
        try {
          payload = rememberPayload(await transport.call("loadStory", { id: asideRequest.storyId }));
        } catch {
          versions.delete(asideRequest.storyId);
        }
        return payload === undefined ? session : { ...session, payload };
      });
    },
    deleteAsideTurn: async (mutation) => await runProviderMutation(
      mutation.storyId,
      async () => await refreshAsideMutation(
        mutation.storyId,
        await transport.call(
          "asideSessionMutation",
          {
            operation: "delete-turn",
            storyId: mutation.storyId,
            sessionId: mutation.sessionId,
            turnIndex: mutation.turnIndex,
            anchor: mutation.anchor
          } satisfies AsideSessionMutationRequest,
          { expectedAggregateVersion: await expectedVersion(mutation.storyId) }
        )
      )
    ),
    resetAside: async (mutation) => await runProviderMutation(
      mutation.storyId,
      async () => await refreshAsideMutation(
        mutation.storyId,
        await transport.call(
          "asideSessionMutation",
          {
            operation: "reset",
            storyId: mutation.storyId,
            sessionId: mutation.sessionId,
            turnIndex: mutation.turnIndex,
            anchor: mutation.anchor
          } satisfies AsideSessionMutationRequest,
          { expectedAggregateVersion: await expectedVersion(mutation.storyId) }
        )
      )
    ),
    clearAsideSession: async (mutation) => await runProviderMutation(
      mutation.storyId,
      async () => await refreshAsideMutation(
        mutation.storyId,
        await transport.call(
          "asideSessionMutation",
          {
            operation: "clear",
            storyId: mutation.storyId,
            sessionId: mutation.sessionId,
            anchor: mutation.anchor
          } satisfies AsideSessionMutationRequest,
          { expectedAggregateVersion: await expectedVersion(mutation.storyId) }
        )
      )
    ),
    retakeAside: async (mutation, onDelta, callbacks, signal) => await runProviderMutation(
      mutation.storyId,
      async () => {
        const result = await transport.call(
          "retakeAside",
          mutation,
          {
            onDelta: (text) => {
              callbacks?.onPhase?.("writing");
              onDelta(text);
            },
            onStopped: callbacks?.onStopped,
            onReasoning: (delta) => {
              callbacks?.onPhase?.("thinking");
              callbacks?.onReasoning?.(delta);
            },
            onReasoningStopped: callbacks?.onReasoningStopped,
            expectedAggregateVersion: await expectedVersion(mutation.storyId, signal),
            signal
          }
        );
        if (result === null) return null;
        const session = v2Aside(result);
        if (session === null) {
          throw new Error("The worker returned an invalid Aside retake result.");
        }
        if (session.payload !== undefined) {
          rememberPayload(session.payload);
          return session;
        }
        let payload: StoryPayload | undefined;
        try {
          payload = rememberPayload(await transport.call("loadStory", { id: mutation.storyId }));
        } catch {
          versions.delete(mutation.storyId);
        }
        return payload === undefined ? session : { ...session, payload };
      }
    ),
    clearAside: async (storyId) => rememberPayload(await transport.call(
      "clearAside",
      { storyId },
      { expectedAggregateVersion: await expectedVersion(storyId) }
    )),
    stageStoryImage: async (storyId, mediaType, bytes) =>
      await transport.call("stageStoryImage", { storyId, mediaType, bytes }),
    releaseStoryImage: async (storyId, leaseId) => {
      await transport.call("releaseStoryImage", { storyId, leaseId });
    },
    restoreChapterBreak: async (storyId, breakId, removed) => rememberPayload(
      await transport.call(
        "restoreChapterBreak",
        { storyId, breakId, removed },
        { expectedAggregateVersion: await expectedVersion(storyId) }
      )
    ),
    summarizeChapter: async (storyId, breakId, signal) => runProviderMutation(
      storyId,
      async () => {
        const expectedAggregateVersion = await expectedVersion(storyId, signal);
        signal?.throwIfAborted();
        const payload = await transport.call(
          "summarizeChapter",
          { storyId, breakId },
          {
            expectedAggregateVersion,
            ...(signal === undefined ? {} : { signal })
          }
        );
        if (payload === null) {
          signal?.throwIfAborted();
          throw new Error("Chapter summary returned no story payload.");
        }
        return rememberPayload(payload);
      }
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
    saveSettings: (command) => transport.call(
      "saveSettings",
      { command: materializeSaveSettingsCommand(command) }
    ),
    discardPendingSettings: (command) => transport.call("discardPendingSettings", { command }),
    checkModelServer: (settings) => transport.call("checkModelServer", { settings }),
    probeContextWindow: (settings) => transport.call("probeContextWindow", { settings }),
    resolveSamplingBias: (request) => transport.call("resolveSamplingBias", request),
    discoverModels: (settings, signal) => transport.call(
      "discoverModels",
      { settings },
      { signal }
    ),
    countPromptTokens: (messages, signal) => transport.call(
      "countPromptTokens",
      { messages },
      { signal }
    ),
    importSillyTavern: async (jsonl) => {
      const result = await transport.call(
        "importSillyTavern",
        { jsonl },
        { expectedAggregateVersion: { kind: "absent" } }
      );
      rememberPayload(result.payload);
      return result;
    },
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
    importCard: async (storyId, cardBytes) => {
      const result = await transport.call(
        "importCard",
        { storyId, cardBytes },
        { expectedAggregateVersion: await expectedVersion(storyId) }
      );
      rememberPayload(result.payload);
      return result;
    },

    continueStory: async (storyId, instruction, genId, target, onDelta, signal, callbacks: StreamCallbacks = {}, images) => {
      const { onStopped, onReasoning, onReasoningStopped } = callbacks;
      return await runProviderMutation(storyId, async () => {
        const result = await transport.call(
          "continueStory",
          {
            storyId,
            instruction,
            genId,
            target,
            // Absent rather than empty when there are no images. The mutation
            // fingerprint canonicalizes this input, so a text-only request
            // must keep exactly the shape it had before image input existed.
            ...(images === undefined || images.length === 0 ? {} : { images })
          },
          {
            onDelta,
            ...(onStopped === undefined ? {} : { onStopped }),
            ...(onReasoning === undefined ? {} : { onReasoning }),
            ...(onReasoningStopped === undefined ? {} : { onReasoningStopped }),
            signal,
            expectedAggregateVersion: await expectedVersion(storyId)
          }
        );
        return result === null
          ? null
          : { payload: rememberPayload(result.payload), droppedFacts: result.droppedFacts };
      });
    },
    rewriteNode: async (storyId, nodeId, body, onDelta, signal, onCommitted, callbacks: StreamCallbacks = {}) => {
      const { onStopped, onReasoning, onReasoningStopped } = callbacks;
      return await runProviderMutation(storyId, async () => {
        const result = await transport.call(
          "rewriteNode",
          { storyId, nodeId, body },
          {
            onDelta,
            ...(onStopped === undefined ? {} : { onStopped }),
            ...(onReasoning === undefined ? {} : { onReasoning }),
            ...(onReasoningStopped === undefined ? {} : { onReasoningStopped }),
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
    commitPartialRewrite: async (storyId, nodeId, streamedDigest, attemptId) => {
      const result = await transport.call(
        "commitPartialRewrite",
        { storyId, nodeId, streamedDigest, attemptId },
        { expectedAggregateVersion: await expectedVersion(storyId) }
      );
      if (result === null) return null;
      return {
        payload: rememberPayload(result.payload),
        nodeId: result.nodeId
      };
    },
    createSummaryTake: async (storyId, body, onDelta, signal, callbacks: SummaryStreamCallbacks = {}) => {
      const { onReasoning } = callbacks;
      return await runProviderMutation(storyId, async () => {
        const result = await transport.call(
          "createSummaryTake",
          { storyId, body },
          {
            onDelta,
            ...(onReasoning === undefined ? {} : { onReasoning }),
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
