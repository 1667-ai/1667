import path from "node:path";
import type { SettingsStateV2, SettingsStateV3 } from "../shared/settings-v2-types.js";
import {
  SETTINGS_STATE_V2_FILE,
  SETTINGS_STATE_V2_NEXT_FILE
} from "./data-directory-layout.js";
import { formatSettingsStateV2Bytes } from "./settings-v2-codec.js";
import {
  parseSettingsStateSlotBytes,
  settingsStateSlotPriorV3,
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
  /** `current`'s own schema-3 authority, when the file on disk is schema 3
   *  and this build's activation makes it mutable. This is the mutation
   *  pipeline's `imageInput`/`imageTokenCeiling` carry-forward source for
   *  whatever this read starts (`settingsStateSlotPriorV3`,
   *  `upgradeSettingsStateV2ToV3`). Null for a schema-2 authority, which has
   *  no schema-3 data to carry. */
  readonly currentPriorV3: SettingsStateV3 | null;
}

/** Both settings-state files together, each schema-2-or-3-transparent: a
 *  genuine schema-2 file parses as itself, and a schema-3 file downgrades to
 *  the same schema-2-shaped working view. A schema-3 file can be this
 *  release's own prior write, or a predecessor-refused one; the caller
 *  decides which by calling `requireMutableSettingsStateSlot` first, see
 *  settings-v2-store.ts. That downgraded view is what the whole mutation
 *  pipeline (`server/settings-v2-reducer.ts`, `server/settings-v2-mutation.ts`)
 *  already operates on. A `.next` residue can be either schema too, exactly
 *  like `current`: this release's own crash between staging a schema-3
 *  replacement and publishing it leaves one behind the same way a schema-2
 *  crash always has. */
export async function readSettingsStateFiles(dataDir: string): Promise<SettingsStateFiles> {
  const [currentBytes, nextBytes] = await Promise.all([
    readOptionalMutableSettingsAuthority(currentPath(dataDir), MAX_SETTINGS_STATE_BYTES),
    readOptionalSettingsFile(nextPath(dataDir), MAX_SETTINGS_STATE_BYTES)
  ]);
  if (currentBytes === null) throw new Error("Format-2 settings state is missing");
  const currentSlot = parseSettingsStateSlotBytes(currentBytes);
  return {
    current: settingsStateSlotReadOnlyView(currentSlot),
    currentPriorV3: settingsStateSlotPriorV3(currentSlot),
    next: nextBytes === null ? null : settingsStateSlotReadOnlyView(parseSettingsStateSlotBytes(nextBytes))
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
 *  that decides which schema the bytes on disk use; every production caller
 *  passes no options, so it resolves through `resolveImageInputActivation()`,
 *  the release-wide switch. `priorV3` is this same directory's own prior
 *  schema-3 authority, if any (`SettingsStateFiles.currentPriorV3`, read at
 *  the start of the same mutation this call settles). It is passed through
 *  so a schema-3 write carries `imageInput`/`imageTokenCeiling` forward
 *  instead of resetting it (`upgradeSettingsStateV2ToV3`). Absent for a directory's
 *  first-ever schema-3 write, exactly like a fresh migration. */
export async function stageSettingsState(
  dataDir: string,
  state: SettingsStateV2,
  writeSchemaOptions: SettingsWriteSchemaOptions = {},
  priorV3: SettingsStateV3 | null = null
): Promise<void> {
  await writePrivateSettingsFile(
    nextPath(dataDir),
    formatSettingsStateForWrite(state, writeSchemaOptions, priorV3)
  );
}

function formatSettingsStateForWrite(
  state: SettingsStateV2,
  writeSchemaOptions: SettingsWriteSchemaOptions,
  priorV3: SettingsStateV3 | null
): Uint8Array {
  if (settingsWriteSchemaVersion(writeSchemaOptions) === 2) {
    return formatSettingsStateV2Bytes(state);
  }
  return Buffer.from(formatSettingsStateV3(upgradeSettingsStateV2ToV3(state, priorV3)), "utf8");
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
