import type { SamplingPhraseBiasEntryV2 } from "../../../shared/settings-v2-types.js";
import { samplingBiasResolution } from "../sampling-bias-resolution.js";
import type { SamplingBiasResolution, SettingsOverlayState } from "../state.js";
import { cellPad, cellPadStart } from "./panel-table-layout.js";
import { raisedSegment } from "./overlay.js";
import { truncate, visibleWidth, type FrameLine } from "./story/frame.js";

/**
 * Row rendering for the two panels issue #282 added: phrase bias and banned
 * strings. Split out of sampling-panel.ts to keep that file under the
 * repository's file-size guideline. Both panels show the resolved token IDs
 * next to each entry (design goal: the mapping from typed text to what the
 * provider actually biases stays inspectable) — resolution itself runs
 * server-side and lands in `settings.sampling.biasTokenCache` via
 * ../sampling-bias-resolution.js; this module only reads that cache.
 */

export function phraseBiasValueRow(
  entry: SamplingPhraseBiasEntryV2,
  settings: SettingsOverlayState,
  selected: boolean,
  width: number
): FrameLine {
  const lead = selected ? "  ▸ " : "    ";
  const left = `${lead}${cellPad(entry.phrase, 18)}`;
  const right = `${cellPadStart(String(entry.weight), 5)}  ${resolvedTokensText(samplingBiasResolution(settings, entry.phrase))}`;
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
  const right = resolvedTokensText(samplingBiasResolution(settings, phrase));
  const role = selected ? "focus / accent" : "chrome";
  return [
    raisedSegment(left, role),
    raisedSegment(truncate(right, Math.max(1, width - visibleWidth(left))), selected ? "focus / accent" : "prose")
  ];
}

function resolvedTokensText(resolution: SamplingBiasResolution | null): string {
  if (resolution === null) return "";
  if (resolution.kind === "pending") return "resolving…";
  if (resolution.kind === "unavailable") return "tokenizer unavailable";
  if (resolution.tokenIds.length === 0) return "0 tokens";
  return `→ ${resolution.tokenIds.join(",")}`;
}
