import {
  foldAuthorsNoteAcross,
  renderPromptPlan,
  type PromptBlock,
  type PromptPlan,
  type PromptTurn
} from "../shared/prompt-plan.js";
import { promptCacheAdapter } from "./provider-cache-policy.js";
import type { GenerationSettings } from "../shared/types.js";
import type {
  PromptBlockLocation
} from "./prompt-cache-breakpoints.js";
import type { PromptCacheWirePlan } from "./provider-cache-policy.js";
import { ProviderError } from "./errors.js";
import { applySamplingFields } from "./provider-sampling.js";
import { providerRuntimeFor } from "./provider-runtime.js";
import { resolveTokenProbabilities } from "../shared/token-probability-capabilities.js";
import { generationEffortAvailabilityForTarget } from "../shared/generation-effort-capabilities.js";
import type { StorySamplingRequest } from "./sampling-phrase-bias.js";

type TextContentBlock = Record<string, unknown> & {
  type: "text";
  text: string;
};

/** No Image Object bytes are ever supplied by default: every existing caller
 *  that never sends an image gets exactly the same body it always did. */
const NO_IMAGE_BYTES: ReadonlyMap<string, Uint8Array> = new Map();

export async function buildOpenAiChatRequestBody(
  settings: GenerationSettings,
  prompt: PromptPlan,
  cache: PromptCacheWirePlan,
  request: StorySamplingRequest = {},
  /** Normalized Image bytes, by object id, supplied by the caller after local
   *  admission has already checked the active-prompt image budget. Base64
   *  encoding happens only here, inside the adapter: a block whose object is
   *  missing from this map is a programming error, not a request the writer
   *  could cause. */
  imageBytes: ReadonlyMap<string, Uint8Array> = NO_IMAGE_BYTES
): Promise<Record<string, unknown>> {
  const loweredPrompt = lowerPromptForProvider(settings, prompt);
  let messages: unknown;
  const cacheFields: Record<string, unknown> = {};
  switch (cache.kind) {
    case "omit":
      messages = stringMessages(loweredPrompt, imageBytes);
      break;
    case "openai-automatic":
      messages = stringMessages(loweredPrompt, imageBytes);
      cacheFields.prompt_cache_key = cache.key;
      if (cache.retention !== null) cacheFields.prompt_cache_retention = cache.retention;
      break;
    case "openai-explicit-off":
      messages = stringMessages(loweredPrompt, imageBytes);
      cacheFields.prompt_cache_options = { mode: "explicit" };
      break;
    case "openai-explicit":
      messages = structuredMessages(
        loweredPrompt,
        cacheableLocationKeys(loweredPrompt, cache.breakpoints),
        (block) => ({ ...block, prompt_cache_breakpoint: { mode: "explicit" } }),
        imageBytes
      );
      cacheFields.prompt_cache_key = cache.key;
      cacheFields.prompt_cache_options = { mode: "explicit" };
      break;
    case "anthropic-explicit":
      throw wrongAdapter(cache.kind, "OpenAI");
    default:
      return assertNever(cache);
  }
  const body: Record<string, unknown> = {
    model: settings.model,
    messages,
    max_tokens: settings.maxTokens,
    stream: true,
    ...cacheFields
  };
  if (sendsTemperature(settings)) body.temperature = settings.temperature;
  await applySamplingFields(body, settings, "openai-chat-completions", request);
  applyTokenProbabilities(body, settings);
  applyGenerationEffort(body, settings, "openai");
  return body;
}

/** `logprobs` / `top_logprobs` only when the route documents them (issue #291
 *  phase 2). A model that later 400s on these fields is handled downstream in
 *  server/providers.ts, which strips them and remembers the refusal per
 *  model — this function only decides whether to ask in the first place. */
function applyTokenProbabilities(
  body: Record<string, unknown>,
  settings: GenerationSettings
): void {
  const runtime = providerRuntimeFor(settings);
  if (runtime.tokenProbabilities === null) return;
  const resolution = resolveTokenProbabilities({
    protocol: "openai-chat-completions",
    preset: runtime.preset,
    remoteModelId: settings.model,
    temperatureSupport: runtime.capabilities.temperature
  });
  if (resolution.kind !== "available" || resolution.wire !== "openai-logprobs") return;
  body.logprobs = true;
  body.top_logprobs = runtime.tokenProbabilities;
}

/** A model that declares no sampling support rejects the whole request, so a
 * temperature left over from an earlier model must not be put on the wire. */
function sendsTemperature(settings: GenerationSettings): boolean {
  return settings.temperature !== null
    && providerRuntimeFor(settings).capabilities.temperature !== "unsupported";
}

export async function buildAnthropicMessagesRequestBody(
  settings: GenerationSettings,
  prompt: PromptPlan,
  cache: PromptCacheWirePlan,
  request: StorySamplingRequest = {},
  /** See `buildOpenAiChatRequestBody`'s `imageBytes`. */
  imageBytes: ReadonlyMap<string, Uint8Array> = NO_IMAGE_BYTES
): Promise<Record<string, unknown>> {
  const loweredPrompt = lowerPromptForProvider(settings, prompt);
  let system: string | readonly TextContentBlock[];
  let messages: unknown;
  switch (cache.kind) {
    case "omit": {
      const rendered = renderPromptPlan(loweredPrompt);
      assertAnthropicSystemIsTextOnly(loweredPrompt);
      system = rendered
        .filter((message) => message.role === "system")
        .map((message) => message.content)
        .join("\n\n");
      messages = loweredPrompt.turns.flatMap((turn, turnIndex) => {
        if (turn.role === "system") return [];
        const message = rendered[turnIndex]!;
        return [{
          role: message.role,
          content: turnHasImages(turn)
            ? turn.blocks.map((block) => anthropicContentBlock(block, imageBytes))
            : message.content
        }];
      });
      break;
    }
    case "anthropic-explicit": {
      assertAnthropicSystemIsTextOnly(loweredPrompt);
      const selected = [...cacheableLocationKeys(loweredPrompt, [cache.breakpoint])][0]!;
      const isSelected = (location: PromptBlockLocation): boolean => locationKey(location) === selected;
      const annotateSystem = (location: PromptBlockLocation, block: TextContentBlock): TextContentBlock =>
        isSelected(location) ? withAnthropicCacheControl(block, cache.ttl) : block;
      system = structuredAnthropicSystem(loweredPrompt, annotateSystem);
      messages = loweredPrompt.turns.flatMap((turn, turnIndex) =>
        turn.role === "system"
          ? []
          : [{
              role: turn.role,
              content: turn.blocks.map((block, blockIndex) => {
                const content = anthropicContentBlock(block, imageBytes);
                return isSelected({ turn: turnIndex, block: blockIndex })
                  ? withAnthropicCacheControl(content, cache.ttl)
                  : content;
              })
            }]);
      break;
    }
    case "openai-automatic":
    case "openai-explicit":
    case "openai-explicit-off":
      throw wrongAdapter(cache.kind, "Anthropic");
    default:
      return assertNever(cache);
  }
  const body: Record<string, unknown> = {
    model: settings.model,
    max_tokens: settings.maxTokens,
    messages,
    stream: true
  };
  if (system.length > 0) body.system = system;
  if (sendsTemperature(settings)) body.temperature = settings.temperature;
  await applySamplingFields(body, settings, "anthropic-messages", request);
  if ("top_p" in body) delete body.temperature;
  applyGenerationEffort(body, settings, "anthropic");
  // Anthropic Messages documents no logprobs field at all
  // (resolveTokenProbabilities always reports "protocol" here), so a profile
  // that configures tokenProbabilities on this route is deliberately not an
  // error the way an unsupported sampling knob is. A sampling knob's silent
  // loss would change what the provider actually samples; token
  // probabilities are a diagnostic the writer opted into, so simply never
  // sending it is the quiet, correct behavior (issue #291 phase 2).
  return body;
}

/** Fold the late note when the protocol has no in-conversation system turn. */
export function providerFoldsAuthorsNote(settings: GenerationSettings): boolean {
  if (settings.provider === "anthropic") return true;
  if (settings.provider !== "openai-compatible") return false;
  return promptCacheAdapter(
    "openai-chat-completions",
    providerRuntimeFor(settings).preset,
    settings.baseUrl
  ) !== "openai-official";
}

/** Return the exact prompt shape that the selected provider receives. */
export function lowerPromptForProvider(
  settings: GenerationSettings,
  prompt: PromptPlan
): PromptPlan {
  return providerFoldsAuthorsNote(settings) ? foldAuthorsNote(prompt) : prompt;
}

/** `foldAuthorsNoteAcross` (shared/prompt-plan.ts) folds into the first TEXT
 *  block of the following user turn: an image block, when the turn has one,
 *  always comes before that text block, so it is skipped rather than folded
 *  into. */
function foldAuthorsNote(plan: PromptPlan): PromptPlan {
  const turns = foldAuthorsNoteAcross(plan.turns, (turn) => turn, (_turn, folded) => folded);
  return turns === plan.turns ? plan : { ...plan, turns };
}

function applyGenerationEffort(
  body: Record<string, unknown>,
  settings: GenerationSettings,
  adapter: "openai" | "anthropic"
): void {
  const runtime = providerRuntimeFor(settings);
  const effortAvailability = generationEffortAvailabilityForTarget({
    protocol: adapter === "anthropic" ? "anthropic-messages" : "openai-chat-completions",
    reasoningEffort: runtime.capabilities.reasoningEffort
  }, runtime.effort);
  if (effortAvailability.kind === "unavailable") {
    throw new ProviderError(effortAvailability.code === "model-unsupported"
      ? "Generation effort is not supported by the selected model."
      : `${effortAvailability.reason}.`);
  }
  if (runtime.effort === "default") return;
  if (adapter === "openai") {
    body.reasoning_effort = runtime.effort === "off" ? "none" : runtime.effort;
    return;
  }
  if (runtime.effort === "off") {
    throw new ProviderError("Anthropic does not support generation effort set to off.");
  }
  body.output_config = { effort: runtime.effort };
}

/** A turn's `content` stays the plain string it always was unless the turn
 *  actually carries an image: this is what keeps every text-only body byte-
 *  identical while making images expressible in every cache mode. */
function turnHasImages(turn: PromptTurn): boolean {
  return turn.blocks.some((block) => block.kind === "image");
}

function stringMessages(
  prompt: PromptPlan,
  imageBytes: ReadonlyMap<string, Uint8Array>
): readonly Record<string, unknown>[] {
  const rendered = renderPromptPlan(prompt);
  return prompt.turns.map((turn, turnIndex) => {
    const message = rendered[turnIndex]!;
    return {
      role: message.role,
      content: turnHasImages(turn)
        ? turn.blocks.map((block) => openAiContentBlock(block, imageBytes))
        : message.content
    };
  });
}

function structuredMessages(
  prompt: PromptPlan,
  selected: ReadonlySet<string>,
  annotate: (block: Record<string, unknown>) => Record<string, unknown>,
  imageBytes: ReadonlyMap<string, Uint8Array>
): readonly Record<string, unknown>[] {
  return prompt.turns.map((turn, turnIndex) => ({
    role: turn.role,
    content: turn.blocks.map((block, blockIndex) => {
      const content = openAiContentBlock(block, imageBytes);
      return selected.has(locationKey({ turn: turnIndex, block: blockIndex }))
        ? annotate(content)
        : content;
    })
  }));
}

/** Anthropic `system` content stays text-only. `textBlock` throws if a system
 *  turn ever carries an image block, which asserts that promise here too. */
function structuredAnthropicSystem(
  prompt: PromptPlan,
  annotate: (location: PromptBlockLocation, block: TextContentBlock) => TextContentBlock
): readonly TextContentBlock[] {
  const systemTurns = prompt.turns
    .map((turn, turnIndex) => ({ turn, turnIndex }))
    .filter((entry) => entry.turn.role === "system");
  return systemTurns.flatMap(({ turn, turnIndex }, systemIndex) =>
    turn.blocks.map((block, blockIndex) => {
      const separator = blockIndex === turn.blocks.length - 1
        && systemIndex < systemTurns.length - 1
        ? "\n\n"
        : "";
      const content = textBlock(block);
      return annotate(
        { turn: turnIndex, block: blockIndex },
        { ...content, text: content.text + separator }
      );
    }));
}

/** Throws when any system turn carries an image block, ahead of building the
 *  actual system content, so the assertion covers both the "omit" plain-text
 *  system string and the "anthropic-explicit" structured one. */
function assertAnthropicSystemIsTextOnly(prompt: PromptPlan): void {
  const hasImage = prompt.turns.some((turn) => turn.role === "system" && turnHasImages(turn));
  if (hasImage) {
    throw new Error("Anthropic system content must be text-only");
  }
}

function withAnthropicCacheControl<T extends Record<string, unknown>>(
  block: T,
  ttl: "5m" | "1h"
): T & { cache_control: Record<string, unknown> } {
  return {
    ...block,
    cache_control: ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" }
  };
}

function cacheableLocationKeys(
  prompt: PromptPlan,
  locations: readonly PromptBlockLocation[]
): ReadonlySet<string> {
  // Validate stable/volatile ordering through the canonical renderer before
  // emitting provider-specific block arrays.
  renderPromptPlan(prompt);
  const keys = new Set<string>();
  for (const location of locations) {
    const block = prompt.turns[location.turn]?.blocks[location.block];
    if (block === undefined) {
      throw new Error(`Prompt-cache breakpoint is outside the prompt: ${locationKey(location)}`);
    }
    if (block.stability !== "stable" || block.boundaryAfter !== "candidate") {
      throw new Error(`Prompt-cache breakpoint is not a stable candidate: ${locationKey(location)}`);
    }
    keys.add(locationKey(location));
  }
  return keys;
}

/** Also the assertion that a given block is text: throws for an image block,
 *  which is exactly what a text-only surface (Anthropic `system`) must do if
 *  one ever reaches it. */
function textBlock(block: PromptBlock): TextContentBlock {
  if (block.kind === "image") {
    throw new Error("An image block cannot render as text content");
  }
  return { type: "text", text: block.text };
}

/** OpenAI Chat Completions image content part: a base64 data URL. Base64 is
 *  computed only here, from bytes the caller supplied after local admission;
 *  it never exists anywhere else in the prompt pipeline. */
function openAiContentBlock(
  block: PromptBlock,
  imageBytes: ReadonlyMap<string, Uint8Array>
): Record<string, unknown> {
  if (block.kind !== "image") return textBlock(block);
  const bytes = requireImageBytes(imageBytes, block.image.objectId);
  return {
    type: "image_url",
    image_url: { url: `data:${block.image.mediaType};base64,${base64Encode(bytes)}` }
  };
}

/** Anthropic Messages image content block: base64 with an explicit media
 *  type. Base64 is computed only here, same as `openAiContentBlock`. */
function anthropicContentBlock(
  block: PromptBlock,
  imageBytes: ReadonlyMap<string, Uint8Array>
): Record<string, unknown> {
  if (block.kind !== "image") return textBlock(block);
  const bytes = requireImageBytes(imageBytes, block.image.objectId);
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: block.image.mediaType,
      data: base64Encode(bytes)
    }
  };
}

/** A block naming an object absent from the supplied bytes is a programming
 *  error: local admission must already have refused any object the caller
 *  cannot supply. The object id is safe to name; the bytes never are. */
function requireImageBytes(
  imageBytes: ReadonlyMap<string, Uint8Array>,
  objectId: string
): Uint8Array {
  const bytes = imageBytes.get(objectId);
  if (bytes === undefined) {
    throw new Error(`Prompt image object has no supplied bytes: ${objectId}`);
  }
  return bytes;
}

function base64Encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function locationKey(location: PromptBlockLocation): string {
  return `${location.turn}:${location.block}`;
}

function wrongAdapter(kind: PromptCacheWirePlan["kind"], adapter: string): Error {
  return new Error(`${adapter} request serializer cannot lower ${kind}`);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled prompt-cache wire plan: ${JSON.stringify(value)}`);
}
