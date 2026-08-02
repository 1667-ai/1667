import { randomUUID } from "node:crypto";
import { fixedPromptTexts, renderPromptPlan } from "../shared/prompt-plan.js";
import { resolveAuthorBrief } from "../shared/author-brief.js";
import { resolveAuthorsNoteDepth, type AuthorsNotePlacement } from "../shared/authors-note.js";
import {
  GenerationResultError,
  GenerationStoppedError,
  ServiceError as HttpError
} from "./errors.js";
import { hasDefinedProperty, optionalString, requireString } from "./validation.js";
import { autonamePrompt, GeneratedTitleError, MAX_STORY_CONTEXT_CHARS, normalizeGeneratedTitle } from "./autoname.js";
import { activeHumanAttribution, attributionAfterReplacement } from "../shared/human-edit.js";
import { streamCompletion } from "./providers.js";
import { AnchoredOutputFilter, continuationPlan, DEFAULT_INSTRUCTION, phraseRewritePlan, rewritePlan, stripEchoedContext, supportsAssistantPrefill } from "./generation-prompts.js";
import { assertFixedContextFits, type GenerationAdmissionRegistry } from "./generation-admission.js";
import type { SettingsStore } from "./settings.js";
import type { ProviderStoryRuntime } from "./story-mutation-runtime.js";
import { hasCommittedGeneration, requireNode } from "./story-nodes.js";
import { factsSystemMessage, rewriteFactsSystemMessage } from "./story-facts.js";
import {
  streamModel,
  type DeltaConsumer
} from "./generation-stream.js";
import { activeLeaf, activePath, nodeById, pathTo } from "../shared/story-tree.js";
import type { GenerationSettings, Story } from "../shared/types.js";
import { HASH_PATTERN, sha256 } from "./story-format.js";
import {
  createPromptCacheRequest,
  type PromptCacheRuntime
} from "./provider-cache-policy.js";

export type BindGenerationIntent = (settings: GenerationSettings, context: unknown) => Promise<void>;

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
  const titleFacts = factsSystemMessage(snapshot);
  const authorBrief = resolveAuthorBrief(snapshot.authorBrief, settings.systemPrompt);
  const briefChars = Math.min(authorBrief.trim().length, 2_000);
  const promptCharBudget = titleFacts === null || settings.contextWindow === null
    ? MAX_STORY_CONTEXT_CHARS
    : Math.min(
        MAX_STORY_CONTEXT_CHARS,
        Math.max(1_000, (settings.contextWindow - titleSettings.maxTokens) * 3
          - titleFacts.length - briefChars - 800)
      );
  const { prompt: titlePrompt } = autonamePrompt(snapshot, authorBrief, promptCharBudget, titleFacts);
  assertFixedContextFits(titleSettings, titleFacts, null, fixedPromptTexts(titlePrompt));
  await bindIntent?.(titleSettings, { kind: "title", messages: renderPromptPlan(titlePrompt) });
  try {
    for await (const delta of streamCompletion(
      titleSettings,
      titlePrompt,
      signal,
      undefined,
      providerStarted,
      createPromptCacheRequest(promptCacheRuntime, promptCache, id, titlePrompt.operation)
    )) {
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
  providerStarted: () => void | Promise<void> = () => {},
  bindIntent?: BindGenerationIntent
): Promise<Story | null> {
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
  const facts = factsSystemMessage(story, {
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
  const continuation = continuationPlan(
    authorBrief,
    facts,
    authorsNotePlacement,
    contextParts,
    instruction,
    appendTo !== null,
    supportsAssistantPrefill(settings),
    null,
    story.chapterBreaks,
    story.nodes
  );
  assertFixedContextFits(settings, facts, authorsNote, fixedPromptTexts(continuation.prompt));
  await bindIntent?.(settings, {
    kind: "continue",
    story: { title: story.title, nodes: story.nodes, chapterBreaks: story.chapterBreaks },
    contextPartIds: contextParts.map((part) => part.id),
    facts,
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
  const raw = await streamModel(
    settings,
    continuation.prompt,
    signal,
    onDelta,
    continuationOutput,
    providerStarted,
    createPromptCacheRequest(
      promptCacheRuntime,
      promptCache,
      id,
      continuation.prompt.operation
    )
  );
  if (raw === null) return null;
  if (continuation.requiresEcho && continuationOutput?.matchedPrefix !== true) {
    throw new GenerationResultError(502, "The model did not continue from the exact final characters; nothing was saved.");
  }
  // A continuation owns its first character: it may be a space, punctuation,
  // newline, or the rest of an unfinished word. The prepared effect rechecks
  // the current story at the short terminal phase and deduplicates a racing
  // Stop by generation ID.
  try {
    const parent = parentId === null ? null : nodeById(story, parentId);
    return await stories.commitProviderEffect(id, {
      kind: "continue",
      parentId,
      appendTo,
      expectedTextHash,
      instruction,
      text: appendTo === null ? raw.trim() : raw,
      model,
      genId,
      expectedParentActiveChildId: parent?.activeChildId ?? null,
      expectedAppendActiveChildId: appendTo === null
        ? null
        : nodeById(story, appendTo)?.activeChildId ?? null,
      expectedActiveRootId: story.activeRootId,
      expectedActiveLeafId: activePath(story).at(-1)?.id ?? null,
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
  providerStarted: () => void | Promise<void> = () => {},
  rewriteId?: string,
  bindIntent?: BindGenerationIntent
): Promise<boolean> {
  if (signal.aborted) return false;
  const start = body.start;
  const end = body.end;
  const expected = requireString(body.expected, "expected");
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
  if (signal.aborted) return false;
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
  const facts = rewriteFactsSystemMessage(story, partId, instruction, expected);
  const { settings, promptCache } = await settingsStore.loadGeneration("prose");
  if (signal.aborted) return false;
  // A fresh nonce makes the rewrite markers and output terminator impossible to
  // collide with prose already in the story.
  const tag = `rw-${randomUUID().slice(0, 8)}`;
  const common = {
    story,
    facts,
    partId,
    start,
    end,
    expected,
    instruction,
    lengthTarget: lengthTarget(expected, requested !== ""),
    authorBrief: resolveAuthorBrief(story.authorBrief, settings.systemPrompt),
    tag
  };
  const plan = bareMode
    ? phraseRewritePlan({ ...common, passage: !phraseMode })
    : rewritePlan({ ...common, assistantPrefill: supportsAssistantPrefill(settings) });
  // Measure the fixed rewrite prompt from the semantic plan so admission cannot
  // drift from later prompt wording.
  assertFixedContextFits(settings, facts, null, fixedPromptTexts(plan.prompt));
  // Rewriting is a precision task: high temperatures break exact seam copying
  // long before they improve prose. A plain regenerate also gets a hard output
  // budget, so a model that ignores the word band runs out after a few dozen
  // tokens and fails cleanly instead of streaming paragraphs first.
  const rewriteSettings: GenerationSettings = {
    ...settings,
    // A null temperature normally defers to the provider default — too hot here.
    temperature: Math.min(settings.temperature ?? REWRITE_MAX_TEMPERATURE, REWRITE_MAX_TEMPERATURE),
    maxTokens: requested === "" && selectionWords !== null
      ? Math.min(settings.maxTokens, rewriteOutputBudget(selectionWords))
      : settings.maxTokens
  };
  await bindIntent?.(rewriteSettings, {
    kind: "rewrite",
    story: { title: story.title, nodes: activePath(story), chapterBreaks: story.chapterBreaks },
    facts,
    authorBrief: story.authorBrief ?? null,
    partId,
    start,
    end,
    expected,
    instruction,
    bareMode,
    phraseMode
  });
  const requireLeftAnchor = plan.leftAnchor.length > 0 && plan.prompt.turns.at(-1)?.role !== "assistant";
  const output = new AnchoredOutputFilter(plan.leftAnchor, plan.rightAnchor, plan.endMarker, requireLeftAnchor, {
    beforeTail: plan.beforeTail,
    anchorWrapTag: `${tag}-right`
  });
  const replacement = await streamModel(
    rewriteSettings,
    plan.prompt,
    signal,
    onDelta,
    output,
    providerStarted,
    createPromptCacheRequest(promptCacheRuntime, promptCache, id, plan.prompt.operation)
  );
  if (replacement === null) return false;
  if (requireLeftAnchor && !output.matchedPrefix) {
    throw new GenerationResultError(502, "The model did not reconnect the replacement to the exact text before it; nothing was saved.");
  }
  // The end marker is required even when nothing follows the selection: without
  // it, a rewrite at the end of the story is an unverifiable free continuation.
  if (plan.endMarker.length > 0 && !output.matchedContract) {
    throw new GenerationResultError(502, plan.rightAnchor.length > 0
      ? "The model did not reconnect the replacement to the exact text after it; nothing was saved."
      : "The model did not finish its replacement cleanly; nothing was saved.");
  }
  // Small models echo the markers back despite being told not to; splicing that
  // in would put a literal <rewrite> tag into the prose. Strip them defensively,
  // including the -left/-right/-excerpt/-story wrapper variants.
  let cleaned = replacement.replace(new RegExp(`</?${tag}(?:-[a-z]+)?>`, "gi"), "");
  if (plan.endMarker.length > 0) cleaned = cleaned.replaceAll(plan.endMarker, "");
  if (phraseMode) cleaned = stripWrappingQuotes(cleaned.trim());
  // A bare passage reply sometimes opens or closes by repeating adjacent story
  // text; that text survives the splice on both sides, so drop the overlap.
  if (bareMode && !phraseMode) cleaned = stripEchoedContext(cleaned.trim(), originalText.slice(0, start), originalText.slice(end));
  if (cleaned.trim().length === 0) {
    throw new GenerationResultError(502, "The model returned only markers; nothing was saved.");
  }
  // The word band is advisory when the user gave an instruction (it may ask for
  // more), but a plain regenerate promises "the same passage, fresh words" — a
  // model that ignores the band must not silently splice paragraphs into the story.
  if (requested === "" && selectionWords !== null) {
    const { high, slack } = wordBand(selectionWords);
    const replacementWords = countWordsForTarget(cleaned) ?? 0;
    if (replacementWords > high + slack) {
      throw new GenerationResultError(502,
          `The model replaced ${selectionWords} ${selectionWords === 1 ? "word" : "words"} with ${replacementWords}; ` +
          "nothing was saved. Try again, or add an instruction if you want something longer."
      );
    }
  }
  const replacementText =
    plan.leadingWhitespace + cleaned.trim() + plan.trailingWhitespace;
  try {
    return await stories.commitProviderEffect(id, {
      kind: "rewrite",
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
      updatedAt: new Date().toISOString(),
      rewriteId,
      cancelled: signal
    });
  } catch (error) {
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
function wordBand(words: number): { low: number; high: number; slack: number } {
  const slack = Math.max(3, Math.round(words * 0.2));
  return { low: Math.max(1, words - slack), high: words + slack, slack };
}
/** Selections at or below this word count skip the seam contract entirely. */
const PHRASE_REWRITE_MAX_WORDS = 4;
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
/** Small models often wrap a bare-phrase reply in quotes despite being told not
 *  to. Strip one matched surrounding pair; interior quotes are prose and stay. */
function stripWrappingQuotes(value: string): string {
  const pairs: Record<string, string> = { '"': '"', "'": "'", "“": "”", "‘": "’", "«": "»" };
  const first = value.length >= 2 ? value[0] : undefined;
  if (first !== undefined && pairs[first] === value.at(-1)) return value.slice(1, -1).trim();
  return value;
}
/** Unicode word segmentation, because splitting on whitespace counts a whole
 *  Chinese, Japanese, or Thai paragraph as one "word" — and the target would then
 *  order the model to collapse it into a handful. null = no trustworthy count, in
 *  which case no numeric target is sent at all. */
function countWordsForTarget(passage: string): number | null {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
  let count = 0;
  for (const segment of segmenter.segment(passage)) {
    if (segment.isWordLike === true) count++;
  }
  return count > 0 ? count : null;
}
