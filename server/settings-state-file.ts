import path from "node:path";
import type { SettingsStateV2 } from "../shared/settings-v2-types.js";
import {
  SETTINGS_STATE_V2_FILE,
  SETTINGS_STATE_V2_NEXT_FILE
} from "./data-directory-layout.js";
import {
  formatSettingsStateV2Bytes,
  parseSettingsStateV2Bytes
} from "./settings-v2-codec.js";
import {
  parseSettingsStateSlotBytes,
  settingsStateSlotReadOnlyView,
  upgradeSettingsStateV2ToV3,
  type SettingsStateSlot
} from "./settings-state-slot.js";
import { formatSettingsStateV3 } from "./settings-v3-codec.js";
import {
  settingsWriteSchemaVersion,
  type SettingsWriteSchemaOptions
} from "./settings-v3-conversion.js";
import { MAX_SETTINGS_STATE_BYTES } from "./settings-v2-scalars.js";
import {
  publishSettingsFile,
  readOptionalMutableSettingsAuthority,
  readOptionalSettingsFile,
  removeSettingsFile,
  writePrivateSettingsFile,
  type SettingsPublicationOptions
} from "./settings-file-io.js";

export interface SettingsStateFiles {
  readonly current: SettingsStateV2;
  readonly next: SettingsStateV2 | null;
}

/** Strictly schema 2, current and staged-next together. The mutation-recovery
 *  path (`SettingsV2Store.recoverReceiptTransaction`) is the only caller, and
 *  it only ever reaches this after `readSettingsStateSlot` has already
 *  confirmed the current authority is schema 2 — see settings-v2-store.ts.
 *  A schema-3 `.next` residue is out of scope for this release: nothing here
 *  ever writes one, and a successor that left one behind resolves it on its
 *  own restart. */
export async function readSettingsStateFiles(dataDir: string): Promise<SettingsStateFiles> {
  const [currentBytes, nextBytes] = await Promise.all([
    readOptionalMutableSettingsAuthority(currentPath(dataDir), MAX_SETTINGS_STATE_BYTES),
    readOptionalSettingsFile(nextPath(dataDir), MAX_SETTINGS_STATE_BYTES)
  ]);
  if (currentBytes === null) throw new Error("Format-2 settings state is missing");
  return {
    current: parseSettingsStateV2Bytes(currentBytes),
    next: nextBytes === null ? null : parseSettingsStateV2Bytes(nextBytes)
  };
}

/** The current settings-state authority's exact kind: schema 2 (mutable) or
 *  schema 3 (successor-owned, read-only). A mutation must call this and
 *  `requireMutableSettingsStateSlot` (server/settings-state-slot.ts) before
 *  it stages or writes anything. */
export async function readSettingsStateSlot(dataDir: string): Promise<SettingsStateSlot> {
  const bytes = await readOptionalMutableSettingsAuthority(
    currentPath(dataDir),
    MAX_SETTINGS_STATE_BYTES
  );
  if (bytes === null) throw new Error("Format-2 settings state is missing");
  return parseSettingsStateSlotBytes(bytes);
}

/** The current settings state, presented transparently to schema version: a
 *  genuine schema-2 state as itself, a schema-3 state downgraded to a
 *  read-only schema-2 view. Every plain read (`loadView`, `loadRuntime`, and
 *  their kin) goes through this; no mutation path may. */
export async function readSettingsState(dataDir: string): Promise<SettingsStateV2> {
  return settingsStateSlotReadOnlyView(await readSettingsStateSlot(dataDir));
}

/** Stage one settings-state replacement. `writeSchemaOptions` is the one
 *  site (`settingsWriteSchemaVersion`, server/settings-v3-conversion.ts)
 *  that decides which schema the bytes on disk use. Every production caller
 *  passes no options, so `settingsWriteSchemaVersion` resolves through
 *  `resolveImageInputActivation()` — a hardcoded false in this release —
 *  and this always writes schema 2, exactly as before. Only a test that
 *  overrides `imageInputActivation` reaches the schema-3 branch. */
export async function stageSettingsState(
  dataDir: string,
  state: SettingsStateV2,
  writeSchemaOptions: SettingsWriteSchemaOptions = {}
): Promise<void> {
  await writePrivateSettingsFile(nextPath(dataDir), formatSettingsStateForWrite(state, writeSchemaOptions));
}

function formatSettingsStateForWrite(
  state: SettingsStateV2,
  writeSchemaOptions: SettingsWriteSchemaOptions
): Uint8Array {
  if (settingsWriteSchemaVersion(writeSchemaOptions) === 2) {
    return formatSettingsStateV2Bytes(state);
  }
  return Buffer.from(formatSettingsStateV3(upgradeSettingsStateV2ToV3(state)), "utf8");
}

export async function publishStagedSettingsState(
  dataDir: string,
  options: SettingsPublicationOptions = {}
): Promise<void> {
  await publishSettingsFile(
    nextPath(dataDir),
    currentPath(dataDir),
    options
  );
}

export async function discardStagedSettingsState(dataDir: string): Promise<void> {
  await removeSettingsFile(nextPath(dataDir));
}

function currentPath(dataDir: string): string {
  return path.join(dataDir, SETTINGS_STATE_V2_FILE);
}

function nextPath(dataDir: string): string {
  return path.join(dataDir, SETTINGS_STATE_V2_NEXT_FILE);
}
