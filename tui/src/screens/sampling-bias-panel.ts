import type { SamplingPhraseBiasEntryV2 } from "../../../shared/settings-v2-types.js";
import { samplingBiasRowResolution } from "../sampling-bias-resolution.js";
import type { SettingsOverlayState } from "../state.js";
import { cellPad, cellPadStart } from "./panel-table-layout.js";
import { raisedSegment } from "./overlay.js";
import { truncate, visibleWidth, type FrameLine } from "./story/frame.js";

/**
 * Row rendering for the two panels issue #282 added: phrase bias and banned
 * strings. Split out of sampling-panel.ts to keep that file under the
 * repository's file-size guideline. Both panels show the resolved token IDs
 * next to each entry (design goal: the mapping from typed text to what the
 * provider actually biases stays inspectable) — resolution itself runs
 * server-side and lands in `settings.sampling.biasResolution` via
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

function resolvedTokensText(resolution: ReturnType<typeof samplingBiasRowResolution>): string {
  if (resolution.kind === "idle") return "";
  if (resolution.kind === "pending") return "resolving…";
  if (resolution.kind === "tokenizer-unavailable") return "tokenizer unavailable";
  if (resolution.kind === "phrase-unencodable") return "could not be tokenized";
  if (resolution.tokenIds.length === 0) return "0 tokens";
  return `→ ${resolution.tokenIds.join(",")}`;
}
