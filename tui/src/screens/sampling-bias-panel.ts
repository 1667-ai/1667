import {
  samplingBiasShadowOwners,
  samplingBiasShadowOwnerText,
  type SamplingBiasVariant
} from "../../../shared/sampling-capabilities.js";
import type { SamplingPhraseBiasEntryV2 } from "../../../shared/settings-v2-types.js";
import { samplingBiasRowResolution, type SamplingBiasRowResolution } from "../sampling-bias-resolution.js";
import type { SettingsOverlayState } from "../state.js";
import { cellPad, cellPadStart } from "./panel-table-layout.js";
import { raisedSegment } from "./overlay.js";
import { truncate, visibleWidth, type FrameLine } from "./story/frame.js";

/**
 * Row rendering for the two panels issue #282 added: phrase bias and
 * banned strings. Split out of sampling-panel.ts to keep that file under
 * the repository's file-size guideline. Both panels show the resolved
 * token IDs next to each entry, one per surface variant (design goal,
 * stage 1: "the editor must show the resolved IDs per variant, not one
 * list per phrase" — that is what keeps the mapping inspectable, since a
 * phrase only biases what it means once every variant resolves).
 * Resolution itself runs server-side and lands in
 * `settings.sampling.biasResolution` via ../sampling-bias-resolution.js;
 * this module only reads that cache.
 */

export function phraseBiasValueRow(
  entry: SamplingPhraseBiasEntryV2,
  settings: SettingsOverlayState,
  selected: boolean,
  width: number
): FrameLine {
  const lead = selected ? "  ▸ " : "    ";
  const left = `${lead}${cellPad(entry.phrase, 18)}`;
  const resolution = samplingBiasRowResolution(settings, "phraseBias", entry.phrase);
  const right = `${cellPadStart(String(entry.weight), 5)}  ${resolvedTokensText(resolution)}`;
  const role = selected ? "focus / accent" : "chrome";
  return [
    raisedSegment(left, role),
    raisedSegment(truncate(right, Math.max(1, width - visibleWidth(left))), selected ? "focus / accent" : "prose")
  ];
}

export function bannedStringValueRow(
  phrase: string,
  settings: SettingsOverlayState,
  selected: boolean,
  width: number
): FrameLine {
  const lead = selected ? "  ▸ " : "    ";
  const left = `${lead}${cellPad(JSON.stringify(phrase), 24)}`;
  const resolution = samplingBiasRowResolution(settings, "bannedStrings", phrase);
  const right = resolvedTokensText(resolution);
  const role = selected ? "focus / accent" : "chrome";
  return [
    raisedSegment(left, role),
    raisedSegment(truncate(right, Math.max(1, width - visibleWidth(left))), selected ? "focus / accent" : "prose")
  ];
}

/** Short tags for the four surface variants (shared/sampling-capabilities.ts,
 * SAMPLING_BIAS_VARIANT_VALUES) — a label a row has room for, in the fixed
 * order every entry expands in: typed, leading space, capitalized, leading
 * space capitalized. */
function variantTag(variant: SamplingBiasVariant): string {
  switch (variant) {
    case "typed": return "t";
    case "leading-space": return "␣";
    case "capitalized": return "Cap";
    case "leading-space-capitalized": return "␣Cap";
  }
}

function resolvedTokensText(resolution: SamplingBiasRowResolution): string {
  if (resolution.kind === "idle") return "";
  if (resolution.kind === "pending") return "resolving…";
  if (resolution.kind === "failed") return `‹ — › check failed · ${resolution.message}`;
  if (resolution.kind === "tokenizer-unavailable") return "‹ — › tokenizer unavailable";
  if (resolution.kind === "rejected") {
    return `‹ — › ${resolution.entry.variants.map(variantOutcomeText).join(" ")}`;
  }
  if (resolution.kind === "shadowed") {
    const owners = samplingBiasShadowOwners(resolution.entry).map(samplingBiasShadowOwnerText);
    return `‹ — › shadowed by ${owners.join(" and ")}`;
  }
  // `SamplingBiasRowResolution` has no "overridden" member at all — the
  // settings overlay never combines a story, so `samplingBiasRowResolution`
  // (../sampling-bias-resolution.js) throws rather than producing one — so
  // "resolved" really is the only kind left here. Checked explicitly instead
  // of falling through to it (issue #341 finding 3: an earlier version fell
  // through here too, which would have silently reported an overridden
  // entry's discarded weight as though it had shipped, the moment anything
  // upstream started producing one), so a new row kind added later fails to
  // compile here instead of rendering as "resolved" by default.
  if (resolution.kind !== "resolved") {
    throw new Error(`Unhandled sampling-bias row resolution: ${JSON.stringify(resolution)}`);
  }
  return resolution.tokenIds.length === 0
    ? "0 tokens"
    : `→ ${resolution.tokenIds.join(",")}`;
}

function variantOutcomeText(variant: {
  readonly variant: SamplingBiasVariant;
  readonly outcome:
    | { readonly kind: "single-token"; readonly tokenId: number }
    | { readonly kind: "multi-token"; readonly tokenIds: readonly number[] }
    | { readonly kind: "unencodable" };
}): string {
  const tag = variantTag(variant.variant);
  if (variant.outcome.kind === "single-token") return `${tag}:${variant.outcome.tokenId}`;
  if (variant.outcome.kind === "multi-token") return `${tag}:${variant.outcome.tokenIds.length}tok`;
  return `${tag}:×`;
}
