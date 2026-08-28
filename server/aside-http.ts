/**
 * Aside provider operation helpers.
 *
 * Side Note text is loaded only here and in the Aside prompt plan. Write
 * prompt builders must not import this module for document text.
 */
import {
  appendSideNote,
  AsideDocumentError,
  assertAsideQuestion,
  canAdmitAsidePair,
  emptyAsideDocument,
  MAX_ASIDE_ANSWER_SCALARS,
  serializeAsideDocument,
  type AsideDocument
} from "../shared/aside.js";
import { asideEntryPointsOpen } from "../shared/aside-release.js";
import {
  AsideContextAdmissionError,
  asideHistoryFromDocument,
  asidePlan
} from "../shared/aside-plan.js";
import { renderPromptPlan } from "../shared/prompt-plan.js";
import { activeBudgetedFacts } from "../shared/fact-selection.js";
import { activePath } from "../shared/story-tree.js";
import type { Story } from "../shared/types.js";
import {
  GenerationResultError,
  ServiceError as HttpError
} from "./errors.js";
import {
  classifyProviderAbort,
  providerAbortForError
} from "./provider-abort.js";
import type { DeltaConsumer } from "./generation-stream.js";
import type { GenerationStreamHooks } from "./generation-http.js";
import { streamCompletion } from "./providers.js";
import {
  createPromptCacheRequest,
  type PromptCacheRuntime
} from "./provider-cache-policy.js";
import type { SettingsStore } from "./settings.js";
import type { ProviderStoryRuntime } from "./story-mutation-runtime.js";
import { requireString } from "./validation.js";

const ASIDE_OUTPUT_LIMIT = MAX_ASIDE_ANSWER_SCALARS * 4;

export interface AsideDocumentView {
  readonly notes: readonly { readonly question: string; readonly answer: string }[];
}

export function viewAsideDocument(document: AsideDocument | null): AsideDocumentView {
  return {
    notes: (document?.notes ?? []).map((note) => ({
      question: note.question,
      answer: note.answer
    }))
  };
}

export interface AskAsideHooks extends GenerationStreamHooks {
  readonly entryPointsOpen?: boolean;
  /** Mutable cancellation authority owned by the active transport operation. */
  readonly canCommitStoppedAside?: () => boolean;
  /** Load the current Aside document for the admitted story snapshot. */
  readonly loadDocument: (story: Story) => Promise<AsideDocument | null>;
}

/**
 * Stream one Aside question. On success, commits one replacement Aside
 * document via the provider effect. A user Stop after output commits the text
 * that already streamed. Other cancellation sources and failures save nothing.
 *
 * Uses the `utility` Generation Profile (falls back to `default` when the
 * utility route is unset — `selectSettingsRoute`).
 */
export async function askAside(
  id: string,
  body: Record<string, unknown>,
  stories: ProviderStoryRuntime<"askAside">,
  settingsStore: SettingsStore,
  promptCacheRuntime: PromptCacheRuntime,
  onDelta: DeltaConsumer,
  signal: AbortSignal,
  hooks: AskAsideHooks
): Promise<AsideDocumentView | null> {
  const {
    bindIntent,
    canCommitStoppedAside,
    providerStarted = () => {},
    loadDocument,
    onReasoning
  } = hooks;
  if (!asideEntryPointsOpen(hooks.entryPointsOpen)) {
    throw new HttpError(400, "Aside is not available in this release.", "aside_not_supported");
  }
  if (signal.aborted) return null;
  const question = requireString(body.question, "question").trim();
  try {
    assertAsideQuestion(question);
  } catch (error) {
    if (error instanceof AsideDocumentError) {
      throw new HttpError(400, error.message, "invalid_request");
    }
    throw error;
  }

  const story = await stories.loadForMutation(id);
  if (signal.aborted) return null;
  const leaf = activePath(story).at(-1);
  if (leaf !== undefined) {
    await stories.hydratePath(story, leaf.id);
    if (signal.aborted) return null;
  }

  const document = await loadDocument(story);
  if (signal.aborted) return null;
  const currentBytes = Buffer.byteLength(
    serializeAsideDocument(document ?? emptyAsideDocument()),
    "utf8"
  );
  const admission = canAdmitAsidePair(document, question, currentBytes);
  if (!admission.ok) {
    const message = admission.reason === "count"
      ? "This story already has the maximum number of Side Notes. Clear Aside before asking again."
      : admission.reason === "size"
        ? "This story's Aside document cannot hold another Side Note. Clear Aside before asking again."
        : "The question is not valid.";
    throw new HttpError(422, message, "content_too_large");
  }

  const contextParts = activePath(story);
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

  // utility → default fallback is owned by selectSettingsRoute.
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
      history: asideHistoryFromDocument(document),
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

  // Bind the exact effective utility settings and rendered prompt before the
  // provider can start. A retained outer mutation must reject a retry whose
  // settings or prompt changed, instead of dispatching different work under
  // the same mutation identity.
  await bindIntent?.(settings, {
    kind: "aside",
    messages: renderPromptPlan(plan)
  });

  let raw = "";
  try {
    for await (const delta of streamCompletion(settings, plan, signal, {
      providerStarted,
      onReasoning,
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

  let nextDocument: AsideDocument;
  try {
    nextDocument = appendSideNote(document, question, answer);
  } catch (error) {
    if (error instanceof AsideDocumentError) {
      throw new GenerationResultError(422, error.message);
    }
    throw error;
  }

  await stories.commitProviderEffect(id, {
    kind: "aside",
    expectedAsideDocumentId: story.asideDocumentId,
    document: nextDocument,
    cancelled: signal,
    canCommitStoppedAside
  });
  // The provider runtime has now prepared the durable effect. A Stop that
  // arrives after this point must not turn a committed answer into a null
  // response: the outer mutation coordinator will publish the prepared
  // effect, and returning null would make the TUI restore the question and
  // invite a duplicate Side Note.
  return viewAsideDocument(nextDocument);
}

// Stable v2 transport re-exports. V2 orchestration lives in its focused module.
export {
  askAsideSession,
  viewAsideSessionDocument
} from "./aside-session-http.js";
export type {
  AskAsideSessionHooks,
  AsideSessionCommitHooks,
  AsideSessionView
} from "./aside-session-http.js";
