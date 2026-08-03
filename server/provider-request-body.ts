import {
  renderPromptPlan,
  type PromptBlock,
  type PromptPlan
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

type TextContentBlock = Record<string, unknown> & {
  type: "text";
  text: string;
};

export async function buildOpenAiChatRequestBody(
  settings: GenerationSettings,
  prompt: PromptPlan,
  cache: PromptCacheWirePlan,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  const loweredPrompt = promptCacheAdapter(
    "openai-chat-completions",
    providerRuntimeFor(settings).preset,
    settings.baseUrl
  ) === "openai-official"
    ? prompt
    : foldAuthorsNote(prompt);
  let messages: unknown;
  const cacheFields: Record<string, unknown> = {};
  switch (cache.kind) {
    case "omit":
      messages = stringMessages(loweredPrompt);
      break;
    case "openai-automatic":
      messages = stringMessages(loweredPrompt);
      cacheFields.prompt_cache_key = cache.key;
      if (cache.retention !== null) cacheFields.prompt_cache_retention = cache.retention;
      break;
    case "openai-explicit-off":
      messages = stringMessages(loweredPrompt);
      cacheFields.prompt_cache_options = { mode: "explicit" };
      break;
    case "openai-explicit":
      messages = structuredMessages(loweredPrompt, cacheableLocationKeys(loweredPrompt, cache.breakpoints), (block) => ({
        ...block,
        prompt_cache_breakpoint: { mode: "explicit" }
      }));
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
  await applySamplingFields(body, settings, "openai-chat-completions", signal);
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
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  const loweredPrompt = foldAuthorsNote(prompt);
  let system: string | readonly TextContentBlock[];
  let messages: unknown;
  switch (cache.kind) {
    case "omit": {
      const rendered = renderPromptPlan(loweredPrompt);
      system = rendered
        .filter((message) => message.role === "system")
        .map((message) => message.content)
        .join("\n\n");
      messages = rendered
        .filter((message) => message.role !== "system")
        .map((message) => ({ role: message.role, content: message.content }));
      break;
    }
    case "anthropic-explicit": {
      const selected = [...cacheableLocationKeys(loweredPrompt, [cache.breakpoint])][0]!;
      const annotate = (location: PromptBlockLocation, block: TextContentBlock): TextContentBlock =>
        locationKey(location) !== selected
          ? block
          : {
              ...block,
              cache_control: cache.ttl === "1h"
                ? { type: "ephemeral", ttl: "1h" }
                : { type: "ephemeral" }
            };
      system = structuredAnthropicSystem(loweredPrompt, annotate);
      messages = loweredPrompt.turns.flatMap((turn, turnIndex) =>
        turn.role === "system"
          ? []
          : [{
              role: turn.role,
              content: turn.blocks.map((block, blockIndex) =>
                annotate({ turn: turnIndex, block: blockIndex }, textBlock(block)))
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
  await applySamplingFields(body, settings, "anthropic-messages", signal);
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
function foldAuthorsNote(plan: PromptPlan): PromptPlan {
  const noteIndex = plan.turns.findIndex((turn) =>
    turn.blocks.some((block) => block.kind === "authors-note")
  );
  if (noteIndex === -1) return plan;
  const noteTurn = plan.turns[noteIndex]!;
  const noteText = noteTurn.blocks
    .filter((block) => block.kind === "authors-note")
    .map((block) => block.text)
    .join("");
  const following = plan.turns[noteIndex + 1];
  if (following === undefined || following.role !== "user") {
    throw new Error("Author's Note must be followed by a user turn");
  }
  return {
    ...plan,
    turns: plan.turns.flatMap((turn, index) => {
      if (index === noteIndex) return [];
      if (index !== noteIndex + 1) return [turn];
      const first = turn.blocks[0];
      if (first === undefined) throw new Error("Prompt turns cannot be empty");
      return [{
        ...turn,
        blocks: [{ ...first, text: `${noteText}\n\n${first.text}` }, ...turn.blocks.slice(1)]
      }];
    })
  };
}

function applyGenerationEffort(
  body: Record<string, unknown>,
  settings: GenerationSettings,
  adapter: "openai" | "anthropic"
): void {
  const runtime = providerRuntimeFor(settings);
  if (runtime.effort === "default") return;
  if (runtime.capabilities.reasoningEffort !== "supported") {
    throw new ProviderError("The selected model does not declare generation-effort support.");
  }
  if (adapter === "openai") {
    body.reasoning_effort = runtime.effort === "off" ? "none" : runtime.effort;
    return;
  }
  if (runtime.effort === "off") {
    throw new ProviderError("Anthropic does not define a generation-effort mapping for off.");
  }
  body.output_config = { effort: runtime.effort };
}

function stringMessages(prompt: PromptPlan): readonly Record<string, string>[] {
  return renderPromptPlan(prompt)
    .map((message) => ({ role: message.role, content: message.content }));
}

function structuredMessages(
  prompt: PromptPlan,
  selected: ReadonlySet<string>,
  annotate: (block: TextContentBlock) => TextContentBlock
): readonly Record<string, unknown>[] {
  return prompt.turns.map((turn, turnIndex) => ({
    role: turn.role,
    content: turn.blocks.map((block, blockIndex) => {
      const content = textBlock(block);
      return selected.has(locationKey({ turn: turnIndex, block: blockIndex }))
        ? annotate(content)
        : content;
    })
  }));
}

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
      return annotate(
        { turn: turnIndex, block: blockIndex },
        { type: "text", text: block.text + separator }
      );
    }));
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

function textBlock(block: PromptBlock): TextContentBlock {
  return { type: "text", text: block.text };
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
