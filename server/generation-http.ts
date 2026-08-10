import { randomUUID } from "node:crypto";
import { renderPromptPlan } from "../shared/prompt-plan.js";
import { resolveAuthorBrief } from "../shared/author-brief.js";
import { resolveAuthorsNoteDepth, type AuthorsNotePlacement } from "../shared/authors-note.js";
import { rewriteStreamDigest } from "../shared/rewrite-partial-contract.js";
import {
  GenerationResultError,
  GenerationStoppedError,
  ServiceError as HttpError,
  timeoutProvenanceOf
} from "./errors.js";
import {
  countWordsForTarget,
  maximumPartialRewriteRecordRetainedBytes,
  rewriteReplacement,
  wordBand,
  type PartialRewriteStash
} from "./rewrite-partial.js";
import { hasDefinedProperty, optionalString, requireString } from "./validation.js";
import { autonamePrompt, GeneratedTitleError, MAX_STORY_CONTEXT_CHARS, normalizeGeneratedTitle } from "./autoname.js";
import {
  activeHumanAttribution,
  attributionAfterReplacement,
  rewrittenSpansAfterReplacement
} from "../shared/human-edit.js";
import { streamCompletion, type ProviderSecretsCollector, type TokenProbabilityCollector } from "./providers.js";
import { reasoningCapture, reasoningSafeToStore } from "./reasoning-capture.js";
import { storySamplingBias } from "./sampling-phrase-bias.js";
import { AnchoredOutputFilter, continuationPlan, DEFAULT_INSTRUCTION, phraseRewritePlan, rewritePlan, supportsAssistantPrefill } from "./generation-prompts.js";
import { admitFactsIntoPrompt, type GenerationAdmissionRegistry } from "./generation-admission.js";
import type { FactBudgetDrop } from "../shared/fact-budget.js";
import type { SettingsStore } from "./settings.js";
import type { ProviderStoryRuntime } from "./story-mutation-runtime.js";
import { hasCommittedGeneration, requireNode } from "./story-nodes.js";
import { activeBudgetedFacts, activeBudgetedFactsForRewrite } from "../shared/fact-selection.js";
import { formatFactsMessage } from "../shared/story-facts.js";
import {
  streamModel,
  type DeltaConsumer,
  type ReasoningConsumer
} from "./generation-stream.js";
import { activeLeaf, activePath, nodeById, pathTo } from "../shared/story-tree.js";
import { resolveRewriteDestination, type GenerationSettings, type Story } from "../shared/types.js";
import { HASH_PATTERN, sha256 } from "./story-format.js";
import {
  createPromptCacheRequest,
  type PromptCacheRuntime
} from "./provider-cache-policy.js";
import {
  providerOutputRetainedByteLimit
} from "./provider-stream-output.js";

export type BindGenerationIntent = (settings: GenerationSettings, context: unknown) => Promise<void>;

/** The optional side channels a streamed generation call takes, bundled into
 *  one trailing parameter instead of a run of positional callbacks —
 *  `continueStory` and `rewriteNode` had each grown past a dozen positional
 *  parameters, `providerStarted`/`bindIntent`/`onReasoning` among them, with
 *  nothing at a call site naming which was which. `server/story-service-
 *  generation.ts`'s `GenerationMutationHooks` extends this with the one
 *  field that is a caller concern, not a generation concern:
 *  `mutationRequest`. */
export interface GenerationStreamHooks {
  providerStarted?: () => void | Promise<void>;
  bindIntent?: BindGenerationIntent;
  /** Reasoning ("thinking") text, kept apart from `onDelta`'s prose at every
   *  step between here and the provider. */
  onReasoning?: ReasoningConsumer;
}

/** `continueStory`'s own hooks bag: everything `GenerationStreamHooks` has,
 *  plus the one callback that is specific to a continuation. */
export interface ContinueStoryHooks extends GenerationStreamHooks {
  /** Fired once, synchronously, with whatever admission actually shed to fit
   *  the fixed prompt — the only place this real, post-shedding drop set
   *  exists. A caller that wants to tell the writer what happened (rather
   *  than the pre-flight guess the context meter shows before the request is
   *  sent) reads it here; the committed Story carries no trace of it. */
  onFactsDropped?: (dropped: readonly FactBudgetDrop[]) => void;
}

export async function autonameStory(
  id: string,
  stories: ProviderStoryRuntime<"autonameStory">,
  settingsStore: SettingsStore,
  promptCacheRuntime: PromptCacheRuntime,
  signal: AbortSignal,
  providerStarted: () => void | Promise<void> = () => {},
  autonameId?: string,
  expectedTitle?: string,
  bindIntent?: BindGenerationIntent
): Promise<Story> {
  const snapshot = await stories.loadForMutation(id);
  if (expectedTitle !== undefined && snapshot.title !== expectedTitle) {
    throw new HttpError(409, "The story title changed before naming began. Try again if you still want a new name.");
  }
  const line = activePath(snapshot);
  if (line.length === 0) throw new HttpError(400, "Write some of the story before asking the model to name it.");
  const { settings, promptCache } = await settingsStore.loadGeneration("utility");
  let raw = "";
  const titleSettings = { ...settings, maxTokens: Math.min(settings.maxTokens, 64) };
  // A known window shrinks the prose excerpt: ~3 chars/token, minus the facts,
  // author brief, and fixed framing that must ride along whole. The guard then
  // covers facts plus the builder-owned fixed texts, so a long story with a
  // small fact is shortened rather than refused. Factless stories keep the
  // pre-facts 24k excerpt byte-for-byte.
  const titleBudgeted = activeBudgetedFacts(snapshot);
  const titleFacts = formatFactsMessage(titleBudgeted.kept);
  const authorBrief = resolveAuthorBrief(snapshot.authorBrief, settings.systemPrompt);
  const briefChars = Math.min(authorBrief.trim().length, 2_000);
  const promptCharBudget = titleFacts === null || settings.contextWindow === null
    ? MAX_STORY_CONTEXT_CHARS
    : Math.min(
        MAX_STORY_CONTEXT_CHARS,
        Math.max(1_000, (settings.contextWindow - titleSettings.maxTokens) * 3
          - titleFacts.length - briefChars - 800)
      );
  // The char budget stays fixed across a possible rebuild below — a few Facts
  // shorter than assumed only makes it more conservative, never wrong.
  const { plan: titlePlan } = admitFactsIntoPrompt(
    titleSettings,
    titleBudgeted.kept,
    null,
    (factsMessage) => autonamePrompt(snapshot, authorBrief, promptCharBudget, factsMessage)
  );
  const titlePrompt = titlePlan.prompt;
  await bindIntent?.(titleSettings, { kind: "title", messages: renderPromptPlan(titlePrompt) });
  try {
    for await (const delta of streamCompletion(titleSettings, titlePrompt, signal, {
      providerStarted,
      promptCache: createPromptCacheRequest(promptCacheRuntime, promptCache, id, titlePrompt.operation),
      storySampling: storySamplingBias(snapshot)
    })) {
      raw += delta;
      if (raw.length > 4_096) throw new GeneratedTitleError("The model returned far more than a title. Try again.");
    }
  } catch (error) {
    if (error instanceof GeneratedTitleError) throw new GenerationResultError(502, error.message);
    throw error;
  }
  if (signal.aborted) {
    throw new GenerationStoppedError("Story naming was cancelled");
  }
  let title: string;
  try {
    title = normalizeGeneratedTitle(raw);
  } catch (error) {
    if (error instanceof GeneratedTitleError) throw new GenerationResultError(502, error.message);
    throw error;
  }
  try {
    return await stories.commitProviderEffect(id, {
      kind: "autoname",
      expectedTitle: snapshot.title,
      title,
      autonameId
    });
  } catch (error) {
    if (error instanceof HttpError && error.code === "story_manifest_requires_successor") throw error;
    if (error instanceof HttpError && !(error instanceof GenerationResultError)) {
      throw new GenerationResultError(error.status, error.message);
    }
    throw error;
  }
}
export async function currentModel(settingsStore: SettingsStore): Promise<string> {
  const settings = await settingsStore.load();
  return settings.provider === "dry-run" ? "dry-run" : settings.model;
}
export async function continueStory(
  id: string,
  body: Record<string, unknown>,
  stories: ProviderStoryRuntime<"continueStory">,
  settingsStore: SettingsStore,
  promptCacheRuntime: PromptCacheRuntime,
  generationAdmission: GenerationAdmissionRegistry,
  onDelta: DeltaConsumer,
  signal: AbortSignal,
  hooks: ContinueStoryHooks = {}
): Promise<Story | null> {
  const { providerStarted = () => {}, bindIntent, onFactsDropped, onReasoning } = hooks;
  if (signal.aborted) return null;
  const requestedInstruction = (optionalString(body.instruction) ?? "").trim();
  const instruction = requestedInstruction || DEFAULT_INSTRUCTION;
  // Stamped on whatever this generation commits, so a Stop that races the commit
  // can tell "already saved" from "nothing saved yet".
  const genId = requireString(body.genId, "genId");
  const hasParentId = hasDefinedProperty(body, "parentId");
  const requestedAppendTo = optionalString(body.appendTo);
  if (hasParentId && requestedAppendTo !== null) throw new HttpError(400, "Choose parentId or appendTo, not both");
  if (requestedAppendTo !== null && requestedInstruction.length > 0) {
    throw new HttpError(400, "Appending to a node requires an empty instruction");
  }
  const story = await stories.loadForMutation(id);
  if (hasCommittedGeneration(story, genId)) return story;
  if (signal.aborted) return null;
  let parentId: string | null;
  let appendTo = requestedAppendTo;
  let expectedTextHash: string | null = null;
  let contextParts;
  if (appendTo !== null) {
    const target = requireNode(story, appendTo);
    if (activeLeaf(story)?.id !== target.id) throw new HttpError(409, "The node being continued is no longer the active leaf.");
    if (target.role === "summary") throw new HttpError(400, "Cannot write inside a summary — continue with a new node.");
    const crossesChapterBreak = story.chapterBreaks.some((chapterBreak) => chapterBreak.parentPartId === target.id);
    parentId = crossesChapterBreak ? target.id : target.parentId;
    if (crossesChapterBreak) {
      appendTo = null;
    } else {
      expectedTextHash = requireString(body.expectedTextHash, "expectedTextHash");
      if (!HASH_PATTERN.test(expectedTextHash)) throw new HttpError(400, "Invalid expectedTextHash");
      if (sha256(target.text) !== expectedTextHash) throw new HttpError(409, "The node being continued changed before writing began.");
    }
    contextParts = activePath(story);
  } else {
    const supplied = body.parentId;
    if (hasParentId && supplied !== null && typeof supplied !== "string") {
      throw new HttpError(400, "parentId must be a string or null");
    }
    parentId = hasParentId ? supplied as string | null : activeLeaf(story)?.id ?? null;
    if (parentId !== null) {
      requireNode(story, parentId);
      await stories.hydratePath(story, parentId);
      if (signal.aborted) return null;
    }
    contextParts = parentId === null ? [] : pathTo(story, parentId);
  }
  const budgetedFacts = activeBudgetedFacts(story, {
    contextParts,
    chapterBreaks: story.chapterBreaks,
    nodes: story.nodes,
    instruction
  });
  const authorsNote = story.authorsNote ?? null;
  const authorsNotePlacement: AuthorsNotePlacement | null = authorsNote === null
    ? null
    : { text: authorsNote, depth: resolveAuthorsNoteDepth(story.authorsNoteDepth) };
  const { settings, promptCache } = await settingsStore.loadGeneration("prose");
  if (signal.aborted) return null;
  const authorBrief = resolveAuthorBrief(story.authorBrief, settings.systemPrompt);
  const model = settings.provider === "dry-run" ? "dry-run" : settings.model;
  // Record it now: a Stop that saves the partial must credit this model, even if
  // the user switches models while the stream is still running.
  generationAdmission.rememberModel(id, genId, model);
  // Compatible endpoints get SillyTavern-style assistant prefill. Providers that
  // reject prefill must first echo a short exact boundary which we strip below.
  const { plan: continuation, admission } = admitFactsIntoPrompt(
    settings,
    budgetedFacts.kept,
    authorsNote,
    (factsMessage) => continuationPlan(
      authorBrief,
      factsMessage,
      authorsNotePlacement,
      contextParts,
      instruction,
      appendTo !== null,
      supportsAssistantPrefill(settings),
      null,
      story.chapterBreaks,
      story.nodes
    )
  );
  // `admission.dropped` alone misses whatever the story's own Facts budget or
  // a Fact's own budgetTokens cap already removed from `budgetedFacts.kept`
  // before admission ever saw it — combine both so a Fact that never reached
  // the prompt is never reported as if nothing had been dropped (issue #281
  // review finding I).
  onFactsDropped?.([...budgetedFacts.dropped, ...admission.dropped]);
  await bindIntent?.(settings, {
    kind: "continue",
    story: { title: story.title, nodes: story.nodes, chapterBreaks: story.chapterBreaks },
    contextPartIds: contextParts.map((part) => part.id),
    facts: admission.factsMessage,
    authorsNote,
    authorsNoteDepth: story.authorsNoteDepth ?? null,
    authorBrief: story.authorBrief ?? null,
    instruction,
    appendTo,
    parentId
  });
  const continuationOutput = continuation.requiresEcho
    ? new AnchoredOutputFilter(continuation.leftAnchor, "", "", true)
    : undefined;
  // Filled only when the request actually asked for and received token
  // probabilities (server/token-probability-capture.ts decides that, not
  // here) — a failure anywhere in that path leaves this null rather than
  // failing the generation; token probabilities are a diagnostic.
  const tokenProbabilities: TokenProbabilityCollector = { record: null };
  const reasoning = reasoningCapture(settings, onReasoning);
  // Filled by whichever stream actually ran, with the exact credentials it
  // resolved (server/providers.ts's `ProviderSecretsCollector`) — read below
  // alongside the committed prose so a thought split across the reasoning
  // and prose channels can be caught jointly (`reasoningSafeToStore`).
  const providerSecrets: ProviderSecretsCollector = { secrets: [] };
  let raw: string | null;
  try {
    raw = await streamModel(settings, continuation.prompt, signal, onDelta, {
      output: continuationOutput,
      providerStarted,
      promptCache: createPromptCacheRequest(
        promptCacheRuntime,
        promptCache,
        id,
        continuation.prompt.operation
      ),
      storySampling: storySamplingBias(story),
      tokenProbabilities,
      onReasoning: reasoning.onReasoning,
      providerSecrets
    });
  } catch (error) {
    // A clean provider timeout after the opening already diverged from the
    // required echo is a timeout masking an echo rejection. The rejection
    // is the truth: rethrow it without the clean-timeout stamp, so a caller
    // that preserves streamed prose on timeouts keeps none of this output.
    if (timeoutProvenanceOf(error) !== null
      && continuationOutput?.prefixRejected === true) {
      throw rejectedContinuationEcho();
    }
    throw error;
  }
  if (raw === null) {
    if (continuationOutput?.prefixRejected === true) {
      throw rejectedContinuationEcho();
    }
    return null;
  }
  if (continuation.requiresEcho && continuationOutput?.matchedPrefix !== true) {
    throw rejectedContinuationEcho();
  }
  // A continuation owns its first character: it may be a space, punctuation,
  // newline, or the rest of an unfinished word. The prepared effect rechecks
  // the current story at the short terminal phase and deduplicates a racing
  // Stop by generation ID.
  try {
    const parent = parentId === null ? null : nodeById(story, parentId);
    const committedText = appendTo === null ? raw.trim() : raw;
    return await stories.commitProviderEffect(id, {
      kind: "continue",
      parentId,
      appendTo,
      expectedTextHash,
      instruction,
      text: committedText,
      model,
      genId,
      expectedParentActiveChildId: parent?.activeChildId ?? null,
      expectedAppendActiveChildId: appendTo === null
        ? null
        : nodeById(story, appendTo)?.activeChildId ?? null,
      expectedActiveRootId: story.activeRootId,
      expectedActiveLeafId: activePath(story).at(-1)?.id ?? null,
      tokenProbabilities: tokenProbabilities.record,
      reasoning: reasoningSafeToStore(reasoning.collector.record, committedText, providerSecrets.secrets),
      cancelled: signal
    });
  } catch (error) {
    if (error instanceof HttpError
      && error.code === "story_manifest_requires_successor") {
      throw error;
    }
    if (error instanceof GenerationResultError) throw error;
    if (error instanceof HttpError && error.status === 404) {
      throw new GenerationResultError(
        409,
        "The story was deleted while writing."
      );
    }
    throw error;
  }
}

export async function rewriteNode(
  id: string,
  partId: string,
  body: Record<string, unknown>,
  stories: ProviderStoryRuntime<"rewriteNode">,
  settingsStore: SettingsStore,
  promptCacheRuntime: PromptCacheRuntime,
  onDelta: DeltaConsumer,
  signal: AbortSignal,
  rewriteId?: string,
  takeId?: string,
  partials?: PartialRewriteStash,
  hooks: GenerationStreamHooks = {}
): Promise<string | null> {
  const { providerStarted = () => {}, bindIntent, onReasoning } = hooks;
  if (signal.aborted) return null;
  const start = body.start;
  const end = body.end;
  const expected = requireString(body.expected, "expected");
  const attemptId = body.attemptId === undefined
    ? undefined
    : requireString(body.attemptId, "attemptId");
  const destination = resolveRewriteDestination(body.destination);
  const requested = (optionalString(body.instruction) ?? "").trim();
  const selectionWords = countWordsForTarget(expected);
  // A few highlighted words is thesaurus use: bare replacement wording, no seam
  // contract — the contract's exact boundary echoes are what small models fail at.
  const phraseMode = selectionWords !== null && selectionWords <= PHRASE_REWRITE_MAX_WORDS;
  // Plain regenerates of any length also go bare: their word band is absolute
  // and their output budget tight, so a model that "continues the story" instead
  // of replacing still fails cleanly — and live testing showed the seam contract
  // failing on every small model while bare replacement succeeded.
  const bareMode = phraseMode || requested === "";
  // No instruction = the popover's Regenerate button: same events, fresh prose.
  const instruction = requested !== ""
    ? requested
    : phraseMode
      ? "Reword this: give a different word or short phrase with the same meaning that fits the sentence seamlessly."
      : "Write this passage again. Keep what happens the same, but find fresh words, images, and rhythm.";
  const story = await stories.loadForMutation(id);
  if (signal.aborted) return null;
  const part = activePath(story).find((node) => node.id === partId);
  if (part === undefined) throw new HttpError(404, `Node not found on the active path: ${partId}`);
  if (
    typeof start !== "number" || typeof end !== "number" ||
    !Number.isInteger(start) || !Number.isInteger(end) ||
    start < 0 || end <= start || end > part.text.length
  ) throw new HttpError(400, "Invalid selection range");
  if (part.text.slice(start, end) !== expected) {
    throw new HttpError(409, "The selection no longer matches the stored text — reload the story.");
  }
  const originalText = part.text;
  const budgetedFacts = activeBudgetedFactsForRewrite(story, partId, instruction, expected);
  const { settings, promptCache } = await settingsStore.loadGeneration("prose");
  if (signal.aborted) return null;
  // A fresh nonce makes the rewrite markers and output terminator impossible to
  // collide with prose already in the story.
  const tag = `rw-${randomUUID().slice(0, 8)}`;
  const rewriteAuthorBrief = resolveAuthorBrief(story.authorBrief, settings.systemPrompt);
  // Rewriting is a precision task: high temperatures break exact seam copying
  // long before they improve prose. A plain regenerate also gets a hard output
  // budget, so a model that ignores the word band runs out after a few dozen
  // tokens and fails cleanly instead of streaming paragraphs first.
  //
  // Computed before admission, and passed to it below, so admission reserves
  // the output budget this request actually sends. Passing the unmodified
  // `settings` there instead once reserved the far larger global maxTokens —
  // Facts could be shed, or the rewrite refused outright, to make room for an
  // output the request was never going to produce (issue #281 review finding
  // G).
  const rewriteSettings: GenerationSettings = {
    ...settings,
    // A null temperature normally defers to the provider default — too hot here.
    temperature: Math.min(settings.temperature ?? REWRITE_MAX_TEMPERATURE, REWRITE_MAX_TEMPERATURE),
    maxTokens: requested === "" && selectionWords !== null
      ? Math.min(settings.maxTokens, rewriteOutputBudget(selectionWords))
      : settings.maxTokens
  };
  // Measure the fixed rewrite prompt from the semantic plan so admission cannot
  // drift from later prompt wording.
  const { plan, admission } = admitFactsIntoPrompt(
    rewriteSettings,
    budgetedFacts.kept,
    null,
    (factsMessage) => {
      const common = {
        story,
        facts: factsMessage,
        partId,
        start,
        end,
        expected,
        instruction,
        lengthTarget: lengthTarget(expected, requested !== ""),
        authorBrief: rewriteAuthorBrief,
        tag
      };
      return bareMode
        ? phraseRewritePlan({ ...common, passage: !phraseMode })
        : rewritePlan({ ...common, assistantPrefill: supportsAssistantPrefill(settings) });
    }
  );
  await bindIntent?.(rewriteSettings, {
    kind: "rewrite",
    story: { title: story.title, nodes: activePath(story), chapterBreaks: story.chapterBreaks },
    facts: admission.factsMessage,
    authorBrief: story.authorBrief ?? null,
    partId,
    start,
    end,
    expected,
    instruction,
    bareMode,
    phraseMode,
    destination
  });
  const requireLeftAnchor = plan.leftAnchor.length > 0 && plan.prompt.turns.at(-1)?.role !== "assistant";
  const output = new AnchoredOutputFilter(plan.leftAnchor, plan.rightAnchor, plan.endMarker, requireLeftAnchor, {
    beforeTail: plan.beforeTail,
    anchorWrapTag: `${tag}-right`
  });
  const spliceReplacement = (streamed: string) => rewriteReplacement({
    streamed,
    tag,
    endMarker: plan.endMarker,
    phraseMode,
    bareMode,
    plainRegenerateWords: requested === "" ? selectionWords : null,
    originalText,
    start,
    end,
    leadingWhitespace: plan.leadingWhitespace,
    trailingWhitespace: plan.trailingWhitespace
  });
  const rewriteEffect = (replacementText: string) => ({
    kind: "rewrite" as const,
    nodeId: partId,
    expectedText: originalText,
    expectedInstruction: part.instruction,
    expectedUpdatedAt: part.updatedAt,
    text: originalText.slice(0, start) + replacementText + originalText.slice(end),
    attribution: attributionAfterReplacement(
      activeHumanAttribution(part),
      start,
      end,
      replacementText.length,
      originalText.length
    ),
    rewrittenSpans: rewrittenSpansAfterReplacement(part.rewrittenSpans, start, end, replacementText.length),
    rewriteId,
    takeId,
    destination
  });
  // What the stream delivered so far — the only prose a stopped or
  // timed-out rewrite can still keep (issue #339). The stash records it
  // with a ready splice only when the left seam held and the cleaned prose
  // is committable; every rejection stashes nothing, so a later settle
  // finds nothing and changes nothing.
  const reservation = partials === undefined || attemptId === undefined
    ? null
    : partials.reserve(
        id,
        partId,
        attemptId,
        maximumPartialRewriteRecordRetainedBytes({
          storyId: id,
          nodeId: partId,
          attemptId,
          streamedDigest: rewriteStreamDigest(""),
          // The complete original keeps every byte that can survive outside
          // the replacement. The provider limit below covers all new text.
          effect: rewriteEffect(originalText.slice(start, end))
        }, providerOutputRetainedByteLimit(rewriteSettings))
      );
  const reasoning = reasoningCapture(rewriteSettings, onReasoning);
  // See continueStory's own comment on this box: filled by whichever stream
  // actually ran, read alongside the committed replacement below.
  const providerSecrets: ProviderSecretsCollector = { secrets: [] };
  try {
    let streamed = "";
    const stashPartial = () => {
      if (partials === undefined || reservation === null || output.prefixRejected) return null;
      const result = spliceReplacement(streamed);
      if (result.kind !== "replacement") return null;
      const record = {
        storyId: id,
        nodeId: partId,
        attemptId: reservation.attemptId,
        streamedDigest: rewriteStreamDigest(streamed),
        effect: rewriteEffect(result.text)
      };
      partials.remember(reservation, record);
      return record;
    };
    let replacement: string | null;
    try {
      replacement = await streamModel(rewriteSettings, plan.prompt, signal, async (delta) => {
        streamed += delta;
        await onDelta(delta);
      }, {
        output,
        providerStarted,
        promptCache: createPromptCacheRequest(promptCacheRuntime, promptCache, id, plan.prompt.operation),
        storySampling: storySamplingBias(story),
        onReasoning: reasoning.onReasoning,
        providerSecrets
      });
    } catch (error) {
      if (timeoutProvenanceOf(error) !== null) {
        // A clean provider timeout after the opening already diverged from
        // the required echo is a timeout masking a seam rejection: rethrow
        // the rejection without the clean-timeout stamp, and stash nothing.
        if (output.prefixRejected) throw rejectedRewriteLeftAnchor();
        stashPartial();
      }
      throw error;
    }
    if (replacement === null) {
      stashPartial();
      return null;
    }
    if (requireLeftAnchor && !output.matchedPrefix) {
      throw rejectedRewriteLeftAnchor();
    }
    // The end marker is required even when nothing follows the selection: without
    // it, a rewrite at the end of the story is an unverifiable free continuation.
    if (plan.endMarker.length > 0 && !output.matchedContract) {
      throw new GenerationResultError(502, (plan.rightAnchor.length > 0
        ? "The model did not reconnect the replacement to the exact text after it; nothing was saved."
        : "The model did not finish its replacement cleanly; nothing was saved.") + SMALL_MODEL_POINTER);
    }
    const spliced = spliceReplacement(replacement);
    if (spliced.kind === "empty") {
      throw new GenerationResultError(502, "The model returned only markers; nothing was saved.");
    }
    if (spliced.kind === "over-band") {
      throw new GenerationResultError(
        502,
        `The model replaced ${spliced.selectionWords} ${spliced.selectionWords === 1 ? "word" : "words"} with ${spliced.replacementWords}; ` +
          "nothing was saved. Try again, or add an instruction if you want something longer."
      );
    }
    // The provider output is now fully verified. Preserve the ready effect
    // before entering the cancellable commit so Stop or a deadline during the
    // story lock wait can settle the exact prose the writer already received.
    const fullRecord = stashPartial();
    try {
      const node = await stories.commitProviderEffect(id, {
        ...rewriteEffect(spliced.text),
        updatedAt: new Date().toISOString(),
        reasoning: reasoningSafeToStore(reasoning.collector.record, spliced.text, providerSecrets.secrets),
        cancelled: signal
      });
      if (fullRecord !== null) partials?.clear(fullRecord);
      return node.id;
    } catch (error) {
      if (!(error instanceof GenerationStoppedError) && fullRecord !== null) {
        partials?.clear(fullRecord);
      }
      if (error instanceof HttpError
        && error.code === "story_manifest_requires_successor") {
        throw error;
      }
      if (error instanceof HttpError && error.status === 404) {
        throw new GenerationResultError(
          409,
          "The story was deleted while rewriting."
        );
      }
      throw error;
    }
  } finally {
    if (partials !== undefined && reservation !== null) {
      partials.releaseEmpty(reservation);
    }
  }
}
/**
 * A concrete word target beats "about the same length": models act on numbers and
 * ignore vague guidance, and a rewrite that silently triples the passage disturbs
 * the pacing of everything around it. The band is ±20%, with a floor of ±3 words
 * so a short phrase isn't given an absurdly tight range. An instruction that asks
 * for something longer or shorter still wins — but a plain regenerate has no
 * instruction to defer to, so its ceiling is absolute.
 */
function lengthTarget(passage: string, instructed: boolean): string {
  const words = countWordsForTarget(passage);
  // No word-like segments at all (a lone em-dash, an ellipsis): there is no honest
  // number to give, but the model still needs a length rule or it will run on.
  if (words === null) {
    return instructed
      ? "Length: keep your replacement about as long as the passage it replaces, unless the instruction asks otherwise."
      : "Length: keep your replacement about as long as the passage it replaces.";
  }
  const { low, high } = wordBand(words);
  return (
    `Length: the passage you are replacing is ${words} ${words === 1 ? "word" : "words"}. ` +
    `Your replacement should be about the same length — roughly ${low}–${high} words. ` +
    (instructed
      ? "Only depart from that if the instruction explicitly asks for something longer or shorter."
      : `Never exceed ${high} words.`)
  );
}
/** Selections at or below this word count skip the seam contract entirely. */
const PHRASE_REWRITE_MAX_WORDS = 4;
// Issue #277 stage 1: point a writer whose seam contract just failed at the
// reliable fallback — a plain regenerate skips the exact-boundary step
// entirely. Remove this pointer once stage 2 gives an instructed rewrite a
// bare mode of its own, so the seam contract stops being the only path.
const SMALL_MODEL_POINTER = " Smaller models often cannot complete this exact-boundary step; a plain regenerate (a rewrite with no instruction) is the reliable alternative.";
function rejectedRewriteLeftAnchor(): GenerationResultError {
  return new GenerationResultError(502, "The model did not reconnect the replacement to the exact text before it; nothing was saved." + SMALL_MODEL_POINTER);
}
function rejectedContinuationEcho(): GenerationResultError {
  return new GenerationResultError(502, "The model did not continue from the exact final characters; nothing was saved.");
}
/** Exact boundary copying degrades quickly above this temperature. */
const REWRITE_MAX_TEMPERATURE = 0.6;
/** Output budget for a plain regenerate: the largest replacement the word-band
 *  guard would accept, at a generous 4 tokens per word (safe for non-Latin
 *  scripts), plus room for the seam contract (echoed left anchor, right anchor,
 *  end marker). A model that ignores the band is truncated a few dozen tokens
 *  in — and, lacking the contract, fails cleanly instead of splicing. */
function rewriteOutputBudget(selectionWords: number): number {
  const { high, slack } = wordBand(selectionWords);
  return 48 + 4 * (high + slack);
}
