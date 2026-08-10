import type { FeatureSupportV2, SettingsProtocolV2 } from "./settings-v2-types.js";

/**
 * Whether a route may attach an image, and how to estimate the visual tokens
 * it costs. Structural sibling of shared/prompt-cache-capabilities.ts: a flat
 * context in, a closed resolution out, a closed allow-list of exact model IDs
 * for built-in knowledge.
 *
 * The gate is strict, unlike shared/reasoning-display-capabilities.ts's
 * permissive one: an image is a request field, so sending one to a model
 * that does not take it fails the generation the same way an unproven
 * sampling knob would. Only `"supported"` ever authorizes an image.
 */

export type ImageInputCapabilityReason =
  | "protocol-unsupported"
  | "explicit-unsupported"
  | "unknown-model";

export type ImageInputCapabilityResolution =
  | Readonly<{ readonly support: "supported"; readonly strategy: ImageTokenStrategy }>
  | Readonly<{ readonly support: "unsupported" | "unknown"; readonly reason: ImageInputCapabilityReason }>;

/** How to estimate the visual tokens one image costs, without asking a
 *  provider. Every kind is a pure function of width/height (or a flat
 *  ceiling); none of them tokenizes base64 text or calls a remote endpoint. */
export type ImageTokenStrategy =
  | Readonly<{
      readonly kind: "anthropic-patch";
      /** Anthropic's documented approximation: tokens = (w px * h px) / divisor,
       *  after scaling so the long edge is at most resizeLongEdgePx. */
      readonly divisor: 750;
      readonly resizeLongEdgePx: 1568;
    }>
  | Readonly<{
      readonly kind: "openai-tile";
      /** OpenAI's documented high-detail formula: baseTokens + tileTokens *
       *  (tiles across) * (tiles down), after fitting inside fitBoxPx and
       *  scaling the shortest side to shortestSidePx. */
      readonly baseTokens: number;
      readonly tileTokens: number;
      readonly fitBoxPx: 2048;
      readonly shortestSidePx: 768;
      readonly tilePx: 512;
    }>
  | Readonly<{
      readonly kind: "explicit-ceiling";
      /** A flat per-image ceiling for an explicit override with no known
       *  formula. Independent of the image's actual dimensions, because
       *  nothing here knows the target's vision encoder. */
      readonly ceiling: number;
    }>;

export interface ImageInputContext {
  readonly protocol: SettingsProtocolV2;
  readonly remoteModelId: string;
  /** Explicit user override, when a schema-3 document stores one for this
   *  model. A stored `"unknown"` counts as no override, the same rule every
   *  other explicit override in this codebase follows. */
  readonly override?: FeatureSupportV2;
  /** Rides beside an explicit `"supported"` override; see
   *  `ModelCapabilitiesV3.imageTokenCeiling`. Ignored for any other override
   *  value. */
  readonly overrideTokenCeiling?: number;
}

/** Protocols that carry an image in their request shape. `dry-run` never
 *  calls a provider, and neither text-completion protocol has an image
 *  content block to put one in. */
const IMAGE_CAPABLE_PROTOCOLS: ReadonlySet<SettingsProtocolV2> = new Set([
  "openai-chat-completions",
  "anthropic-messages"
]);

const ANTHROPIC_PATCH_STRATEGY: ImageTokenStrategy = {
  kind: "anthropic-patch",
  divisor: 750,
  resizeLongEdgePx: 1568
};

function openAiTileStrategy(baseTokens: number, tileTokens: number): ImageTokenStrategy {
  return {
    kind: "openai-tile",
    baseTokens,
    tileTokens,
    fitBoxPx: 2048,
    shortestSidePx: 768,
    tilePx: 512
  };
}

// Closed allow-list of exact model IDs with a safe image-token strategy,
// mirroring the policy in shared/sampling-phrase-resolution.ts:20-31: exact
// IDs rather than a prefix match, so an unlisted model resolves to no
// strategy instead of a guessed one. A model can be vision-capable (present
// in shared/prompt-cache-capabilities.ts's tables) and still be absent here:
// the rollout rule is "do not use a fixed fallback estimate", so a model
// enters this table only when its exact vendor contract defines a formula.
//
// Anthropic: the (width px * height px) / 750 approximation is documented
// for the whole Claude vision family, with a resize to a 1568 px long edge
// first when the source exceeds it. Every model already known to accept
// prompt caching (shared/prompt-cache-capabilities.ts's ANTHROPIC_MINIMUM_TOKENS)
// is Claude-family vision-capable, so the same closed set gets the same
// formula here.
const ANTHROPIC_PATCH_MODELS: ReadonlySet<string> = new Set([
  "claude-fable-5",
  "claude-mythos-5",
  "claude-mythos-preview",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-opus-4-5",
  "claude-opus-4-5-20251101",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "claude-sonnet-4-5-20250929",
  "claude-haiku-4-5",
  "claude-haiku-4-5-20251001"
]);

// OpenAI: the high-detail tile formula (baseTokens + tileTokens per 512x512
// tile, after fitting inside 2048x2048 and scaling the shortest side to
// 768px) is documented for the GPT-4o and GPT-4 vision family. gpt-4o-mini
// counts a documented 33.3x multiplier on the same base/tile shape. Newer
// point releases (gpt-4.1, gpt-4.5-preview, the o-series, and every gpt-5.x
// entry) do not have an exact published multiplier confirmed here, so they
// stay off this table and resolve to "unknown" rather than guess one.
const OPENAI_TILE_MODELS: ReadonlyMap<string, ImageTokenStrategy> = new Map([
  ["gpt-4o", openAiTileStrategy(85, 170)],
  ["chatgpt-4o-latest", openAiTileStrategy(85, 170)],
  ["gpt-4-turbo", openAiTileStrategy(85, 170)],
  ["gpt-4o-mini", openAiTileStrategy(2_833, 5_667)]
]);

function builtinImageTokenStrategy(remoteModelId: string): ImageTokenStrategy | undefined {
  if (ANTHROPIC_PATCH_MODELS.has(remoteModelId)) return ANTHROPIC_PATCH_STRATEGY;
  return OPENAI_TILE_MODELS.get(remoteModelId);
}

/** Resolve whether one route may attach an image, and with what strategy.
 *
 * Resolution order: the protocol must support images at all; then an
 * explicit user override (a stored `"unknown"` counts as no override); then
 * exact built-in model knowledge; otherwise `"unknown"`. A `"supported"`
 * verdict always carries a strategy. An override that claims `"supported"`
 * without a ceiling and without built-in knowledge has no safe strategy, so
 * it resolves to `"unknown"`, never to a guessed fallback. */
export function resolveImageInputCapability(
  context: ImageInputContext
): ImageInputCapabilityResolution {
  if (!IMAGE_CAPABLE_PROTOCOLS.has(context.protocol)) {
    return { support: "unsupported", reason: "protocol-unsupported" };
  }
  const override = context.override ?? "unknown";
  if (override === "unsupported") {
    return { support: "unsupported", reason: "explicit-unsupported" };
  }
  if (override === "supported") {
    const strategy: ImageTokenStrategy | undefined = context.overrideTokenCeiling !== undefined
      ? { kind: "explicit-ceiling", ceiling: context.overrideTokenCeiling }
      : builtinImageTokenStrategy(context.remoteModelId);
    return strategy === undefined
      ? { support: "unknown", reason: "unknown-model" }
      : { support: "supported", strategy };
  }
  const strategy = builtinImageTokenStrategy(context.remoteModelId);
  return strategy === undefined
    ? { support: "unknown", reason: "unknown-model" }
    : { support: "supported", strategy };
}

/** The strict gate: only a `"supported"` resolution authorizes an image. */
export function imageInputAuthorized(resolution: ImageInputCapabilityResolution): boolean {
  return resolution.support === "supported";
}

/** Estimate one image's visual tokens from its normalized dimensions.
 *  `"explicit-ceiling"` ignores the dimensions: it is a flat worst case for
 *  a model whose vision encoder is not known locally. */
export function estimateImageTokens(
  strategy: ImageTokenStrategy,
  widthPx: number,
  heightPx: number
): number {
  if (strategy.kind === "explicit-ceiling") return strategy.ceiling;
  if (strategy.kind === "anthropic-patch") {
    const [scaledWidth, scaledHeight] = scaleToLongEdge(widthPx, heightPx, strategy.resizeLongEdgePx);
    return Math.ceil((scaledWidth * scaledHeight) / strategy.divisor);
  }
  const [fitWidth, fitHeight] = scaleToLongEdge(widthPx, heightPx, strategy.fitBoxPx);
  const [scaledWidth, scaledHeight] = scaleToShortEdge(fitWidth, fitHeight, strategy.shortestSidePx);
  const tilesAcross = Math.ceil(scaledWidth / strategy.tilePx);
  const tilesDown = Math.ceil(scaledHeight / strategy.tilePx);
  return strategy.baseTokens + strategy.tileTokens * tilesAcross * tilesDown;
}

function scaleToLongEdge(widthPx: number, heightPx: number, maxLongEdgePx: number): readonly [number, number] {
  const longEdge = Math.max(widthPx, heightPx);
  if (longEdge <= maxLongEdgePx) return [widthPx, heightPx];
  const scale = maxLongEdgePx / longEdge;
  return [widthPx * scale, heightPx * scale];
}

function scaleToShortEdge(widthPx: number, heightPx: number, shortEdgePx: number): readonly [number, number] {
  const shortEdge = Math.min(widthPx, heightPx);
  if (shortEdge <= shortEdgePx) return [widthPx, heightPx];
  const scale = shortEdgePx / shortEdge;
  return [widthPx * scale, heightPx * scale];
}
