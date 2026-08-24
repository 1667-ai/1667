import path from "node:path";
import type { SettingsStateEnvelope } from "../shared/settings-v2-types.js";
import type { CredentialBearingSettingsDocument } from "../shared/settings-credential-slots.js";
import {
  SETTINGS_STATE_V2_FILE,
  SETTINGS_STATE_V2_NEXT_FILE
} from "./data-directory-layout.js";
import { MAX_SETTINGS_STATE_V5_BYTES } from "../shared/settings-v5-limits.js";
import { formatSettingsStateV2Bytes, hashSettingsStateV2 } from "./settings-v2-codec.js";
import { formatSettingsStateV3, hashSettingsStateV3 } from "./settings-v3-codec.js";
import { formatSettingsStateV4Bytes, hashSettingsStateV4 } from "./settings-v4-codec.js";
import { formatSettingsStateV5Bytes, hashSettingsStateV5 } from "./settings-v5-codec.js";
import {
  convertSettingsStateV2ToV5,
  convertSettingsStateV3ToV5,
  convertSettingsStateV4ToV5
} from "./settings-v5-conversion.js";
import type { SettingsStateV5 } from "../shared/settings-v5-types.js";
import {
  parseSettingsStateSlotBytes,
  type SettingsStateSlot
} from "./settings-state-slot.js";
import {
  readOptionalMutableSettingsAuthority,
  readOptionalSettingsFile,
  writePrivateSettingsFile
} from "./settings-file-io.js";
import { discardStagedSettingsState } from "./settings-state-file.js";

export interface SettingsStateAuthority {
  readonly current: SettingsStateSlot;
  readonly next: SettingsStateSlot | null;
}

export async function readSettingsStateAuthority(
  dataDir: string
): Promise<SettingsStateAuthority> {
  const [currentBytes, nextBytes] = await Promise.all([
    readOptionalMutableSettingsAuthority(currentPath(dataDir), MAX_SETTINGS_STATE_V5_BYTES),
    readOptionalSettingsFile(nextPath(dataDir), MAX_SETTINGS_STATE_V5_BYTES)
  ]);
  if (currentBytes === null) throw new Error("Format-2 settings state is missing");
  return {
    current: parseSettingsStateSlotBytes(currentBytes),
    next: nextBytes === null ? null : parseSettingsStateSlotBytes(nextBytes)
  };
}

export function hashSettingsStateSlot(slot: SettingsStateSlot): string {
  switch (slot.kind) {
    case "v2": return hashSettingsStateV2(slot.state);
    case "v3": return hashSettingsStateV3(slot.state);
    case "v4": return hashSettingsStateV4(slot.state);
    case "v5": return hashSettingsStateV5(slot.state);
  }
}

export function formatSettingsStateSlotBytes(slot: SettingsStateSlot): Uint8Array {
  switch (slot.kind) {
    case "v2": return formatSettingsStateV2Bytes(slot.state);
    case "v3": return Buffer.from(formatSettingsStateV3(slot.state), "utf8");
    case "v4": return formatSettingsStateV4Bytes(slot.state);
    case "v5": return formatSettingsStateV5Bytes(slot.state);
  }
}

export function convertSettingsStateSlotToV5(slot: SettingsStateSlot): SettingsStateV5 {
  switch (slot.kind) {
    case "v2": return convertSettingsStateV2ToV5(slot.state);
    case "v3": return convertSettingsStateV3ToV5(slot.state);
    case "v4": return convertSettingsStateV4ToV5(slot.state);
    case "v5": return slot.state;
  }
}

export function sourceSchemaVersionOf(
  slot: SettingsStateSlot
): 2 | 3 | 4 | 5 {
  switch (slot.kind) {
    case "v2": return 2;
    case "v3": return 3;
    case "v4": return 4;
    case "v5": return 5;
  }
}

export async function stageSettingsStateBytes(
  dataDir: string,
  bytes: Uint8Array
): Promise<void> {
  await writePrivateSettingsFile(nextPath(dataDir), bytes, MAX_SETTINGS_STATE_V5_BYTES);
}

export async function stageSettingsStateSlot(
  dataDir: string,
  slot: SettingsStateSlot
): Promise<void> {
  await stageSettingsStateBytes(dataDir, formatSettingsStateSlotBytes(slot));
}

export async function stageSettingsStateV5(
  dataDir: string,
  state: SettingsStateV5
): Promise<void> {
  await stageSettingsStateBytes(dataDir, formatSettingsStateV5Bytes(state));
}

export { discardStagedSettingsState };

export function envelopeStateGeneration(
  state: SettingsStateEnvelope<2 | 3 | 4 | 5, CredentialBearingSettingsDocument>
): number {
  return state.stateGeneration;
}

function currentPath(dataDir: string): string {
  return path.join(dataDir, SETTINGS_STATE_V2_FILE);
}

function nextPath(dataDir: string): string {
  return path.join(dataDir, SETTINGS_STATE_V2_NEXT_FILE);
}
