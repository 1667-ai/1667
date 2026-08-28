/**
 * Aside v2 session provider helpers.
 *
 * This module owns session transport views and provider orchestration. Durable
 * replacement is supplied by the caller so story manifest versions remain
 * independent of provider streaming.
 */
import {
  appendAsideTurn,
  AsideDocumentError,
  asideTitleFromQuestion,
  assertAsideAnchor,
  assertAsideQuestion,
  canAdmitAsideTurn,
  emptyAsideSessionDocument,
  MAX_ASIDE_ANSWER_SCALARS,
  replaceAsideTurn,
  serializeAsideSessionDocument,
  truncateAsideThoughtsToFit,
  type AsideAnchor,
  type AsideSessionDocument
} from "../shared/aside.js";
import type {
  AsideAskInput,
  AsideRetakeInput
} from "../shared/aside-transport.js";
import type { AsideSessionRef } from "../shared/aside-session-index.js";
import { randomUUID } from "node:crypto";
import { asideEntryPointsOpen } from "../shared/aside-release.js";
import { AsideContextAdmissionError, asidePlan } from "../shared/aside-plan.js";
import { renderPromptPlan } from "../shared/prompt-plan.js";
import { activeBudgetedFacts } from "../shared/fact-selection.js";
import { activePath, isChapterSummary, pathTo } from "../shared/story-tree.js";
import type { Story } from "../shared/types.js";
import { GenerationResultError, ServiceError as HttpError } from "./errors.js";
import { classifyProviderAbort, providerAbortForError } from "./provider-abort.js";
import type { DeltaConsumer } from "./generation-stream.js";
import type { GenerationStreamHooks } from "./generation-http.js";
import { streamCompletion } from "./providers.js";
import { createPromptCacheRequest, type PromptCacheRuntime } from "./provider-cache-policy.js";
import type { SettingsStore } from "./settings.js";
import type { ProviderStoryRuntime } from "./story-mutation-runtime.js";
import { requireString } from "./validation.js";
import { reasoningCapture, reasoningSafeToStore } from "./reasoning-capture.js";
import type { ProviderSecretsCollector } from "./providers.js";
import { hasUnpairedSurrogate, unicodeScalarLength } from "../shared/unicode.js";
import { MAX_SESSION_REFS_PER_BUCKET } from "./story-v11-strict.js";
import {
  parseManifestV11,
  serializeManifestContent,
  type StoryManifestV11
} from "./story-format.js";
import {
  formatV12
} from "./story-v6-codec.js";
import type { StoryEnvelopeManifest } from "./story-v6-types.js";
import type { LiveStoryManifestV12 } from "./story-v12-types.js";
import { MAX_STORY_MANIFEST_BYTES } from "./story-v5-strict.js";
import {
  asideSessionRefById,
  effectiveAsideSessionAnchor,
  hasLegacyAsideVirtualSessionPrefix,
  legacyAsideDocumentIdForSession,
  LEGACY_ASIDE_SESSION_ID,
  sameAsideAnchor,
  retainAsideSessionBucket
} from "./aside-session-store.js";

const ASIDE_OUTPUT_LIMIT = MAX_ASIDE_ANSWER_SCALARS * 4;

/** Wire view for one v2 session. Reasoning is optional and render-only. */
export interface AsideSessionView {
  readonly schemaVersion: 2;
  readonly id: string;
  readonly anchor: AsideAnchor | null;
  readonly title: string;
  readonly turns: readonly {
    readonly q: string;
    readonly a: string;
    readonly thoughts?: string;
    readonly thoughtTokens?: number;
  }[];
}

export function viewAsideSessionDocument(
  document: AsideSessionDocument | null,
  id = "",
  effectiveAnchor: AsideAnchor | null | undefined = undefined
): AsideSessionView | null {
  if (document === null) return null;
  const anchor = effectiveAnchor === undefined ? document.anchor : effectiveAnchor;
  const title = document.title === "" && document.turns.length > 0
    ? asideTitleFromQuestion(document.turns[0]!.q)
    : document.title;
  return {
    schemaVersion: 2,
    id,
    anchor: anchor === null ? null : { ...anchor },
    title,
    turns: document.turns.map((turn) => ({
      q: turn.q,
      a: turn.a,
      ...(turn.thoughts === undefined ? {} : { thoughts: turn.thoughts }),
      ...(turn.thoughtTokens === undefined ? {} : { thoughtTokens: turn.thoughtTokens })
    }))
  };
}

/** A transport-neutral v2 session replacement. */
export interface AsideSessionCommitHooks {
  readonly entryPointsOpen?: boolean;
  readonly loadSession: (
    story: Story,
    sessionId: string
  ) => Promise<AsideSessionDocument | null>;
  readonly commitSession: (
    story: Story,
    sessionId: string,
    expected: AsideSessionDocument | null,
    replacement: AsideSessionDocument,
    expectedAnchor: AsideAnchor | null
  ) => Promise<void>;
}

export interface AskAsideSessionHooks extends GenerationStreamHooks, AsideSessionCommitHooks {
  readonly canCommitStoppedAside?: () => boolean;
}

/**
 * Stream one v2 session turn. The caller owns durable session-index mutation
 * through `commitSession`; this keeps the provider path independent of the
 * manifest version used by the story aggregate.
 */
export async function askAsideSession(
  id: string,
  body: AsideAskInput,
  stories: ProviderStoryRuntime<"askAside">,
  settingsStore: SettingsStore,
  promptCacheRuntime: PromptCacheRuntime,
  onDelta: DeltaConsumer,
  signal: AbortSignal,
  hooks: AskAsideSessionHooks
): Promise<AsideSessionView | null> {
  return await runAsideSession(
    id,
    body,
    stories,
    settingsStore,
    promptCacheRuntime,
    onDelta,
    signal,
    hooks,
    { retakeTurnIndex: null }
  );
}

/** Stream a replacement for the selected session's last answer. The prompt
 * uses the same q/a history as askAsideSession; stored thoughts remain
 * render-only because asidePlan strips them from history. */
export async function retakeAsideSession(
  id: string,
  body: AsideRetakeInput,
  stories: ProviderStoryRuntime<"retakeAside">,
  settingsStore: SettingsStore,
  promptCacheRuntime: PromptCacheRuntime,
  onDelta: DeltaConsumer,
  signal: AbortSignal,
  hooks: AskAsideSessionHooks
): Promise<AsideSessionView | null> {
  return await runAsideSession(
    id,
    body,
    stories,
    settingsStore,
    promptCacheRuntime,
    onDelta,
    signal,
    hooks,
    { retakeTurnIndex: requireTurnIndex(body.turnIndex) }
  );
}

interface AsideGenerationMode {
  readonly retakeTurnIndex: number | null;
}

async function runAsideSession(
  id: string,
  body: AsideAskInput | AsideRetakeInput,
  stories: ProviderStoryRuntime,
  settingsStore: SettingsStore,
  promptCacheRuntime: PromptCacheRuntime,
  onDelta: DeltaConsumer,
  signal: AbortSignal,
  hooks: AskAsideSessionHooks,
  mode: AsideGenerationMode
): Promise<AsideSessionView | null> {
  const {
    bindIntent,
    canCommitStoppedAside,
    providerStarted = () => {},
    onReasoning,
    loadSession,
    commitSession
  } = hooks;
  if (!asideEntryPointsOpen(hooks.entryPointsOpen)) {
    throw new HttpError(400, "Aside is not available in this release.", "aside_not_supported");
  }
  if (signal.aborted) return null;

  const anchor = asideAnchorFromBody(body);
  const requestedSessionId = body.sessionId;
  const sessionId = requestedSessionId === undefined
    ? mode.retakeTurnIndex === null
      ? `session-${randomUUID()}`
      : requireAsideSessionId(requestedSessionId)
    : requireAsideSessionId(requestedSessionId);

  const story = await stories.loadForMutation(id);
  if (signal.aborted) return null;
  const leaf = activePath(story).at(-1);
  if (leaf !== undefined) {
    await stories.hydratePath(story, leaf.id);
    if (signal.aborted) return null;
  }

  const ref = asideSessionRefById(story, sessionId);
  const legacySourceDocumentId = ref === null
    ? legacyAsideDocumentIdForSession(story, sessionId)
    : null;
  // The virtual V1 view owns this stable id. A new ordinary session cannot
  // claim it before a V1 document exists, or a later V1 write would be hidden
  // by the ref with the same id.
  const unresolvedLegacyTarget = ref === null
    && (sessionId === LEGACY_ASIDE_SESSION_ID
      ? story.asideDocumentId === undefined || story.asideDocumentId === null
      : hasLegacyAsideVirtualSessionPrefix(sessionId)
        && legacyAsideDocumentIdForSession(story, sessionId) === null);
  if (unresolvedLegacyTarget) {
    throw new HttpError(
      400,
      "The legacy Aside session id is reserved for V1 materialization.",
      "invalid_request"
    );
  }
  const loaded = await loadSession(story, sessionId);
  if (signal.aborted) return null;
  const question = mode.retakeTurnIndex === null
    ? requireAsideQuestion("question" in body ? body.question : undefined)
    : requireRetakeQuestion(loaded, mode.retakeTurnIndex);
  const expectedAnchor = ref === null
    ? anchor
    : effectiveAsideSessionAnchor(story, ref, loaded?.anchor);
  if (loaded !== null && !sameAsideAnchor(expectedAnchor, anchor)) {
    throw new HttpError(
      409,
      "This Aside session is anchored to a different take.",
      "conflict"
    );
  }
  const document = loaded ?? emptyAsideSessionDocument(anchor);
  // A retake is an in-place replacement. Do not feed the answer being
  // replaced (or its stored Thoughts) back to the provider; it is retained
  // only as the CAS predecessor and replacement source below.
  const promptDocument = mode.retakeTurnIndex === null
    ? document
    : {
        ...document,
        turns: document.turns.slice(0, mode.retakeTurnIndex)
      };
  const replacementTurnCount = loaded === null
    ? 1
    : loaded.turns.length + (mode.retakeTurnIndex === null ? 1 : 0);
  stories.declareAsideSessionResolution?.(
    sessionId,
    ref?.documentId ?? null,
    expectedAnchor
  );
  const promptBytes = Buffer.byteLength(serializeAsideSessionDocument(promptDocument), "utf8");
  const admission = canAdmitAsideTurn(promptDocument, question, promptBytes);
  if (!admission.ok) {
    const message = admission.reason === "count"
      ? "This Aside session already has the maximum number of turns. Start a new session."
      : admission.reason === "size"
        ? "This Aside session cannot hold another turn. Start a new session."
        : "The question is not valid.";
    throw new HttpError(422, message, "content_too_large");
  }

  const anchorNode = anchor === null
    ? undefined
    : story.nodes.find((node) => node.id === anchor.takeId);
  if (anchor !== null && (anchorNode === undefined || isChapterSummary(anchorNode))) {
    throw new HttpError(409, "This Aside anchor no longer exists.", "conflict");
  }
  if (ref === null) {
    const targetRefs = anchor === null
      ? story.asideUnanchoredSessionRefs ?? []
      : story.asideSessionRefs ?? [];
    if (targetRefs.length >= MAX_SESSION_REFS_PER_BUCKET) {
      throw new HttpError(
        422,
        "This Aside session bucket already has the maximum number of sessions. Start a new session elsewhere.",
        "content_too_large"
      );
    }
    assertAsideSessionManifestFits(
      stories.asideManifest,
      stories.asideMutationId,
      sessionId,
      anchor,
      legacySourceDocumentId ?? undefined,
      replacementTurnCount
    );
  } else {
    assertAsideSessionManifestFits(
      stories.asideManifest,
      stories.asideMutationId,
      sessionId,
      expectedAnchor,
      ref.sourceAsideDocumentId,
      replacementTurnCount,
      projectExistingAsideSessionRef(story, ref, expectedAnchor, replacementTurnCount)
    );
  }
  const contextParts = anchorNode === undefined
    ? activePath(story)
    : pathTo(story, anchorNode.id);
  if (anchorNode !== undefined) {
    const contextLeaf = contextParts.at(-1);
    if (contextLeaf !== undefined) await stories.hydratePath(story, contextLeaf.id);
  }
  const budgetedFacts = activeBudgetedFacts(story, {
    contextParts,
    chapterBreaks: story.chapterBreaks,
    nodes: story.nodes,
    instruction: question
  });
  const factsMessage = budgetedFacts.kept.length === 0
    ? null
    : budgetedFacts.kept.map((fact) => {
      const tag = fact.tag === null || fact.tag === "" ? "" : `[${fact.tag}] `;
      return `${tag}${fact.text}`;
    }).join("\n\n");

  const { settings, promptCache, writing } = await settingsStore.loadGeneration("utility");
  if (signal.aborted) return null;
  const usableTokens = settings.contextWindow === null
    ? null
    : Math.max(0, settings.contextWindow - settings.maxTokens);
  let plan;
  try {
    plan = asidePlan({
      facts: factsMessage,
      parts: contextParts,
      chapterBreaks: story.chapterBreaks,
      nodes: story.nodes,
      session: promptDocument,
      question,
      usableTokens,
      guidance: writing?.asideGuidance ?? ""
    });
  } catch (error) {
    if (error instanceof AsideContextAdmissionError) {
      throw new HttpError(422, error.message, "content_too_large");
    }
    throw error;
  }

  await bindIntent?.(settings, {
    kind: "aside-session",
    anchor,
    messages: renderPromptPlan(plan)
  });

  const reasoning = reasoningCapture(settings, onReasoning);
  const providerSecrets: ProviderSecretsCollector = { secrets: [] };
  let raw = "";
  try {
    for await (const delta of streamCompletion(settings, plan, signal, {
      providerStarted,
      onReasoning: reasoning.onReasoning,
      providerSecrets,
      promptCache: createPromptCacheRequest(
        promptCacheRuntime,
        promptCache,
        id,
        plan.operation
      )
    })) {
      raw += delta;
      if (raw.length > ASIDE_OUTPUT_LIMIT) {
        throw new GenerationResultError(
          502,
          "The model returned an unexpectedly large Aside answer; nothing was saved."
        );
      }
      await onDelta(delta);
    }
  } catch (error) {
    const abort = providerAbortForError(signal, error);
    const userStopped = abort.kind === "terminal" && abort.userInitiated;
    if (!signal.aborted) throw error;
    if (!userStopped
      || canCommitStoppedAside?.() !== true
      || raw.trim().length === 0) return null;
  }
  if (signal.aborted) {
    const abort = classifyProviderAbort(signal);
    if (abort.kind !== "terminal"
      || !abort.userInitiated
      || canCommitStoppedAside?.() !== true
      || raw.trim().length === 0) return null;
  }

  const answer = raw.trim();
  if (answer.length === 0) {
    throw new GenerationResultError(502, "The model returned no Aside answer; nothing was saved.");
  }
  const safeReasoning = reasoningSafeToStore(
    reasoning.collector.record,
    answer,
    providerSecrets.secrets
  );
  const safeThoughts = safeReasoning?.text;
  const safeThoughtTokens = safeReasoning?.tokenCount;
  let replacement: AsideSessionDocument;
  try {
    const fittedThoughts = truncateAsideThoughtsToFit(
      promptDocument,
      question,
      answer,
      safeThoughts,
      safeThoughtTokens
    );
    replacement = mode.retakeTurnIndex === null
      ? appendAsideTurn(
          document,
          question,
          answer,
          fittedThoughts,
          fittedThoughts === undefined ? undefined : safeThoughtTokens
        )
      : replaceAsideTurn(
          document,
          mode.retakeTurnIndex,
          answer,
          fittedThoughts,
          fittedThoughts === undefined ? undefined : safeThoughtTokens
        );
  } catch (error) {
    if (error instanceof AsideDocumentError) throw new GenerationResultError(422, error.message);
    throw error;
  }
  await commitSession(story, sessionId, loaded, replacement, expectedAnchor);
  return viewAsideSessionDocument(replacement, sessionId, expectedAnchor);
}

/** Check the exact persisted V11 content and V12 envelope that adding this
 * ref would produce. The object itself is not stored until the provider
 * effect commits, so a valid 64-byte placeholder is sufficient here. */
function assertAsideSessionManifestFits(
  manifest: StoryEnvelopeManifest | undefined,
  mutationId: string | undefined,
  sessionId: string,
  anchor: AsideAnchor | null,
  sourceAsideDocumentId?: string,
  turnCount = 1,
  projectedRef?: AsideSessionRef
): void {
  if (manifest === undefined || manifest.kind !== "live") return;
  const source = manifest.content;
  const anchoredRefs = "asideSessionRefs" in source ? source.asideSessionRefs : [];
  const unanchoredRefs = "asideUnanchoredSessionRefs" in source
    ? source.asideUnanchoredSessionRefs
    : [];
  const placeholder = projectedRef ?? {
    id: sessionId,
    documentId: "0".repeat(64),
    anchor: anchor === null ? null : { ...anchor },
    ...(sourceAsideDocumentId === undefined ? {} : { sourceAsideDocumentId }),
    turnCount
  };
  const nextAnchoredRefs = anchoredRefs.filter((ref) => ref.id !== sessionId);
  const nextUnanchoredRefs = unanchoredRefs.filter((ref) => ref.id !== sessionId);
  if (placeholder.anchor === null) nextUnanchoredRefs.push(placeholder);
  else nextAnchoredRefs.push(placeholder);
  const content: StoryManifestV11 = {
    ...source,
    schemaVersion: 11,
    asideDocumentId: "asideDocumentId" in source ? source.asideDocumentId : null,
    asideSessionRefs: nextAnchoredRefs,
    asideUnanchoredSessionRefs: nextUnanchoredRefs
  } as StoryManifestV11;
  const contentText = serializeManifestContent(content);
  if (Buffer.byteLength(contentText, "utf8") > MAX_STORY_MANIFEST_BYTES) {
    throw new HttpError(
      422,
      "This story manifest cannot hold another Aside session.",
      "content_too_large"
    );
  }
  const terminalEnvelope = mutationId === undefined
    ? {
        ...manifest,
        schemaVersion: 12,
        content
      } as LiveStoryManifestV12
    : {
        ...manifest,
        schemaVersion: 12,
        revision: nextRevision(manifest.revision),
        previousManifestHash: "0".repeat(64),
        unresolvedProvider: null,
        lastTransaction: {
          receiptKind: "user" as const,
          mutationId,
          phase: "prepared" as const
        },
        content
      } as LiveStoryManifestV12;
  let envelopeText: string;
  try {
    envelopeText = formatV12(terminalEnvelope);
  } catch (error) {
    if (error instanceof Error && /manifest exceeds.*size limit|manifest replacement exceeds/u.test(error.message)) {
      throw new HttpError(
        422,
        "This story manifest cannot hold another Aside session.",
        "content_too_large"
      );
    }
    throw error;
  }
  if (Buffer.byteLength(envelopeText, "utf8") > MAX_STORY_MANIFEST_BYTES) {
    throw new HttpError(
      422,
      "This story manifest cannot hold another Aside session.",
      "content_too_large"
    );
  }
  // Run the same strict V11 parser used by encodeStoryBundle. This keeps the
  // admission calculation aligned with the bare content size gate as well as
  // the canonical V12 envelope gate above.
  parseManifestV11(contentText, manifest.id);
}

function projectExistingAsideSessionRef(
  story: Story,
  current: AsideSessionRef,
  anchor: AsideAnchor | null,
  turnCount: number
): AsideSessionRef {
  const stored = findStoredAsideSessionRef(story, current.id);
  const anchoredRefs = (story.asideSessionRefs ?? []).filter((ref) => ref.id !== current.id);
  const unanchoredRefs = (story.asideUnanchoredSessionRefs ?? [])
    .filter((ref) => ref.id !== current.id);
  const originAnchor = anchor === null
    ? current.originAnchor
      ?? (current.anchor === null ? undefined : current.anchor)
    : undefined;
  const next: AsideSessionRef = {
    id: current.id,
    documentId: "0".repeat(64),
    anchor: anchor === null ? null : { ...anchor },
    ...(current.sourceAsideDocumentId === undefined
      ? {}
      : { sourceAsideDocumentId: current.sourceAsideDocumentId }),
    ...(originAnchor === undefined
      ? {}
      : { originAnchor: { ...originAnchor } }),
    turnCount
  };
  return retainAsideSessionBucket(
    next,
    stored?.ref,
    stored?.bucket,
    anchoredRefs.length,
    unanchoredRefs.length
  );
}

function findStoredAsideSessionRef(
  story: Story,
  sessionId: string
): { readonly ref: AsideSessionRef; readonly bucket: "anchored" | "unanchored" } | null {
  const anchored = (story.asideSessionRefs ?? []).find((ref) => ref.id === sessionId);
  if (anchored !== undefined) return { ref: anchored, bucket: "anchored" };
  const unanchored = (story.asideUnanchoredSessionRefs ?? [])
    .find((ref) => ref.id === sessionId);
  return unanchored === undefined ? null : { ref: unanchored, bucket: "unanchored" };
}

function nextRevision(revision: string): string {
  return (BigInt(revision) + 1n).toString().padStart(20, "0");
}

function asideAnchorFromBody(
  body: AsideAskInput | AsideRetakeInput
): AsideAnchor | null {
  const value = body.anchor;
  if (value === null) return null;
  try {
    assertAsideAnchor(value);
  } catch (error) {
    if (error instanceof AsideDocumentError) {
      throw new HttpError(400, error.message, "invalid_request");
    }
    throw error;
  }
  return { partId: value.partId, takeId: value.takeId };
}

function requireAsideSessionId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0
    || hasUnpairedSurrogate(value)
    || value.normalize("NFC") !== value
    || unicodeScalarLength(value, 129) > 128) {
    throw new HttpError(
      400,
      "sessionId must be a non-empty, well-formed NFC-normalized string",
      "invalid_request"
    );
  }
  return value;
}

function requireAsideQuestion(value: unknown): string {
  const question = requireString(value, "question").trim();
  try {
    assertAsideQuestion(question);
  } catch (error) {
    if (error instanceof AsideDocumentError) {
      throw new HttpError(400, error.message, "invalid_request");
    }
    throw error;
  }
  return question;
}

function requireTurnIndex(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new HttpError(400, "turnIndex must be a non-negative integer", "invalid_request");
  }
  return value as number;
}

function requireRetakeQuestion(
  document: AsideSessionDocument | null,
  turnIndex: number
): string {
  if (document === null || document.turns.length === 0) {
    throw new HttpError(409, "This Aside session has no turn to retake.", "conflict");
  }
  if (turnIndex !== document.turns.length - 1) {
    throw new HttpError(409, "Only the last Aside turn can be retaken.", "conflict");
  }
  return document.turns[turnIndex]!.q;
}
