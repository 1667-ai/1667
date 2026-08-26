/**
 * Aside v2 service boundary.
 *
 * Reads, session-local mutations, and provider-backed retakes share the same
 * session ref/CAS hooks. Legacy story-wide Aside remains in the generation
 * service and is intentionally not called from these methods.
 */
import type { AsideAnchor } from "../shared/aside-session.js";
import { randomUUID } from "node:crypto";
import type {
  AsideAskInput,
  AsideAskResponse,
  AsideReadResponse,
  AsideRetakeInput,
  AsideSessionMutationInput,
  AsideSessionMutationResponse
} from "../shared/aside-transport.js";
import { asideEntryPointsOpen } from "../shared/aside-release.js";
import { migrateAsideDocumentToUnanchored } from "../shared/aside.js";
import type { DeltaConsumer } from "./generation-stream.js";
import {
  askAsideSession,
  retakeAsideSession,
  viewAsideSessionDocument,
  type AskAsideSessionHooks,
  type AsideSessionView
} from "./aside-session-http.js";
import { readAsideSessions } from "./aside-session-read.js";
import {
  asideSessionRefById,
  effectiveAsideSessionAnchor,
  legacyAsideDocumentIdForSession
} from "./aside-session-store.js";
import {
  applyPreparedAsideSessionMutation,
  parseAsideSessionMutation,
  prepareAsideSessionMutation
} from "./aside-session-mutation.js";
import { buildStoryPayload } from "./story-payload.js";
import { ServiceError } from "./errors.js";
import type {
  GenerationMutationHooks,
  StoryServiceGenerationDependencies
} from "./story-service-generation.js";
import type { ProviderStoryRuntime } from "./story-mutation-runtime.js";
import { mintStoryMutationRequest } from "./story-mutation-request.js";
import type { StoryAggregateSession } from "./story-aggregate-session.js";

export class StoryServiceAside {
  constructor(
    private readonly dependencies: StoryServiceGenerationDependencies
  ) {}

  async getAsideV2(
    id: string,
    anchor?: AsideAnchor | null
  ): Promise<AsideReadResponse> {
    this.dependencies.ensureOpen();
    this.requireAsideOpen();
    return await readAsideSessions(this.dependencies.stories, id, anchor);
  }

  async askAsideV2(
    id: string,
    body: AsideAskInput,
    onDelta: DeltaConsumer,
    signal: AbortSignal,
    hooks: GenerationMutationHooks = {}
  ): Promise<AsideAskResponse | null> {
    this.dependencies.ensureOpen();
    this.requireAsideOpen(hooks.mutationRequest);
    return await this.dependencies.cancellable(signal, async (active) => {
      const requestAnchor = body.anchor;
      const requestedSessionId = body.sessionId;
      const mutationRequest = hooks.mutationRequest
        ?? await mintStoryMutationRequest(
          this.dependencies.stories,
          id,
          "askAside",
          JSON.stringify(body)
        );
      const sessionId = typeof requestedSessionId === "string" && requestedSessionId.length > 0
        ? requestedSessionId
        : asideSessionIdForMutation(mutationRequest);
      const requestBody = { ...body, sessionId };
      const committed = await this.dependencies.storyMutations.runProviderOperation(
        mutationRequest,
        "askAside",
        {
          signal: active,
          work: async ({ stories, providerStarted, signal: providerSignal }) =>
            await askAsideSession(
              id,
              requestBody,
              stories,
              this.dependencies.settings,
              this.dependencies.promptCache,
              onDelta,
              providerSignal,
              this.sessionHooks(
                id,
                hooks,
                stories,
                providerSignal,
                providerStarted
              )
            ),
          replayValue: async (session) =>
            await this.replaySessionFromAggregate(session, sessionId, requestAnchor)
        }
      );
      if (committed.value === null) return null;
      return {
        ...committed.value,
        payload: buildStoryPayload(committed.story, committed.aggregateVersion)
      };
    });
  }

  async asideSessionMutation(
    id: string,
    body: AsideSessionMutationInput,
    mutationRequest?: unknown
  ): Promise<AsideSessionMutationResponse> {
    this.dependencies.ensureOpen();
    this.requireAsideOpen(mutationRequest);
    const target = parseAsideSessionMutation(body);
    const request = mutationRequest
      ?? await mintStoryMutationRequest(
        this.dependencies.stories,
        id,
        "asideSessionMutation",
        JSON.stringify(body)
      );
    const committed = await this.dependencies.storyMutations.runLocal<AsideSessionView>(
      request,
      "asideSessionMutation",
      async (story, session) => {
        const prepared = await prepareAsideSessionMutation(story, session, target);
        return await applyPreparedAsideSessionMutation(story, session, prepared);
      },
      async (session) => {
        const replayed = await this.replaySessionFromAggregate(
          session,
          target.sessionId,
          target.anchor
        );
        if (replayed === null) {
          throw new ServiceError(404, "Aside session was not found.", "not_found");
        }
        return replayed;
      }
    );
    if (committed.value === null) {
      throw new ServiceError(404, "Aside session was not found.", "not_found");
    }
    return {
      ...committed.value,
      payload: buildStoryPayload(committed.story, committed.aggregateVersion)
    };
  }

  async retakeAside(
    id: string,
    body: AsideRetakeInput,
    onDelta: DeltaConsumer,
    signal: AbortSignal,
    hooks: GenerationMutationHooks = {}
  ): Promise<AsideAskResponse | null> {
    this.dependencies.ensureOpen();
    this.requireAsideOpen(hooks.mutationRequest);
    return await this.dependencies.cancellable(signal, async (active) => {
      const requestAnchor = body.anchor;
      const sessionId = body.sessionId;
      const mutationRequest = hooks.mutationRequest
        ?? await mintStoryMutationRequest(
          this.dependencies.stories,
          id,
          "retakeAside",
          JSON.stringify(body)
        );
      const committed = await this.dependencies.storyMutations.runProviderOperation(
        mutationRequest,
        "retakeAside",
        {
          signal: active,
          work: async ({ stories, providerStarted, signal: providerSignal }) =>
            await retakeAsideSession(
              id,
              body,
              stories,
              this.dependencies.settings,
              this.dependencies.promptCache,
              onDelta,
              providerSignal,
              this.sessionHooks(
                id,
                hooks,
                stories,
                providerSignal,
                providerStarted
              )
            ),
          replayValue: async (session) =>
            await this.replaySessionFromAggregate(session, sessionId, requestAnchor)
        }
      );
      if (committed.value === null) return null;
      return {
        ...committed.value,
        payload: buildStoryPayload(committed.story, committed.aggregateVersion)
      };
    });
  }

  private requireAsideOpen(mutationRequest?: unknown): void {
    if (!asideEntryPointsOpen(this.dependencies.stories.asideActivation)
      && mutationRequest === undefined) {
      throw new ServiceError(400, "Aside is not available in this release.", "aside_not_supported");
    }
  }

  private async replaySessionFromAggregate(
    session: StoryAggregateSession,
    sessionId: string,
    _anchor: AsideAnchor | null
  ): Promise<AsideSessionView | null> {
    const story = await session.loadLive();
    const ref = asideSessionRefById(story, sessionId);
    let document = ref === null
      ? null
      : await session.readAsideSessionDocument(ref.documentId);
    const legacyDocumentId = ref === null
      ? legacyAsideDocumentIdForSession(story, sessionId)
      : null;
    if (document === null && legacyDocumentId !== null) {
      document = migrateAsideDocumentToUnanchored(
        await session.readAsideDocument(legacyDocumentId)
      );
    }
    if (document === null) return null;
    const effectiveAnchor = ref === null
      ? null
      : effectiveAsideSessionAnchor(story, ref, document.anchor);
    const view = viewAsideSessionDocument(document, sessionId);
    return view === null ? null : { ...view, anchor: effectiveAnchor };
  }

  private sessionHooks(
    id: string,
    hooks: GenerationMutationHooks,
    stories: ProviderStoryRuntime,
    signal: AbortSignal,
    providerStarted: () => Promise<void>
  ): AskAsideSessionHooks {
    return {
      ...hooks,
      entryPointsOpen: this.dependencies.stories.asideActivation,
      loadSession: async (story, requestedId) => {
        const ref = asideSessionRefById(story, requestedId);
        if (ref !== null) {
          return await this.dependencies.stories.readAsideSessionDocument(id, ref.documentId);
        }
        const legacyDocumentId = legacyAsideDocumentIdForSession(story, requestedId);
        if (legacyDocumentId === null) return null;
        return migrateAsideDocumentToUnanchored(
          await this.dependencies.stories.readAsideDocument(id, legacyDocumentId)
        );
      },
      commitSession: async (story, requestedId, _expected, replacement, expectedAnchor) => {
        const ref = asideSessionRefById(story, requestedId);
        const legacyDocumentId = ref === null
          ? legacyAsideDocumentIdForSession(story, requestedId)
          : null;
        const materializesLegacy = legacyDocumentId !== null;
        const effect = {
          kind: "aside" as const,
          expectedAsideSessionDocumentId: ref?.documentId ?? null,
          expectedAsideSessionAnchor: expectedAnchor,
          sessionId: requestedId,
          sessionDocument: replacement,
          cancelled: signal,
          canCommitStoppedAside: hooks.canCommitStoppedAside
        };
        if (materializesLegacy) {
          await stories.commitProviderEffect(id, {
            ...effect,
            expectedAsideDocumentId: legacyDocumentId,
            materializesLegacy: true
          });
        } else {
          await stories.commitProviderEffect(id, effect);
        }
      },
      providerStarted: async () => {
        await providerStarted();
        await hooks.providerStarted?.();
      }
    };
  }
}

function asideSessionIdForMutation(request: unknown): string {
  if (typeof request === "object" && request !== null
    && "mutationId" in request
    && typeof request.mutationId === "string"
    && request.mutationId.length > 0) {
    return `session-${request.mutationId}`;
  }
  return `session-${randomUUID()}`;
}
