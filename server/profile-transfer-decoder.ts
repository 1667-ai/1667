import { importNovelAiSamplerPresetRecord, MAX_SAMPLER_PRESET_BYTES } from "./import-nai-preset.js";
import { readImportBytes } from "./import-file.js";
import { importProfileExportRecord } from "./import-profile-export.js";
import { parseJsonRejectingDuplicateKeys } from "./strict-json.js";
import type { ProfileTransferCandidate } from "../shared/generation-profile-transfer.js";

export { MAX_SAMPLER_PRESET_BYTES } from "./import-nai-preset.js";

/**
 * The two largest canonical collections are 256 64-scalar strings (banned
 * strings and phrase bias). Their JSON-escaped strings can use 192KiB. The
 * bounded collection syntax, name, route, stop, DRY, and logit-bias fields
 * fit within the remaining 64KiB. Keep one bounded ceiling for either
 * transfer format before reading or parsing the file.
 */
export const MAX_PROFILE_TRANSFER_BYTES = 256 * 1024;
const PROFILE_TRANSFER_TOO_LARGE = "Generation Profile transfer is larger than the 256KB import limit";

/** Decode one bounded Generation Profile transfer file. */
export function decodeProfileTransfer(text: string): ProfileTransferCandidate {
  const byteLength = Buffer.byteLength(text);
  if (byteLength > MAX_PROFILE_TRANSFER_BYTES) {
    throw new Error(PROFILE_TRANSFER_TOO_LARGE);
  }
  const raw = record(parseJsonRejectingDuplicateKeys(text, "profile import", { maxValues: 4_096 }));
  if (raw.profileExportVersion !== undefined) return importProfileExportRecord(raw);
  if (raw.presetVersion !== undefined) {
    if (byteLength > MAX_SAMPLER_PRESET_BYTES) {
      throw new Error("Sampler Preset is larger than the 64KB import limit");
    }
    return importNovelAiSamplerPresetRecord(raw);
  }
  throw new Error("file is neither a NovelAI Sampler Preset nor a Profile Export; use 1667 import for stories");
}

/** Read and decode one profile transfer without allocating beyond its ceiling. */
export async function readProfileTransferFile(file: string): Promise<ProfileTransferCandidate> {
  const bytes = await readImportBytes(file, {
    maximumBytes: MAX_PROFILE_TRANSFER_BYTES,
    tooLargeMessage: PROFILE_TRANSFER_TOO_LARGE
  });
  return decodeProfileTransfer(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("file is neither a NovelAI Sampler Preset nor a Profile Export");
  }
  return value as Record<string, unknown>;
}
