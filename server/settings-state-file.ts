import path from "node:path";
import type { SettingsStateV2 } from "../shared/settings-v2-types.js";
import {
  SETTINGS_STATE_V2_FILE,
  SETTINGS_STATE_V2_NEXT_FILE
} from "./data-directory-layout.js";
import { formatSettingsStateV2Bytes } from "./settings-v2-codec.js";
import {
  parseSettingsStateSlotBytes,
  settingsStateSlotReadOnlyView,
  type SettingsStateSlot
} from "./settings-state-slot.js";
import { type SettingsWriteSchemaOptions } from "./settings-v3-conversion.js";
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

/** Both settings-state files together, each schema-2-or-3-transparent: a
 *  genuine schema-2 file parses as itself, and a schema-3 file downgrades to
 *  the same schema-2-shaped read-only view. A schema-3 file is always a
 *  later release's write: this release's own writer never produces one
 *  (`settingsWriteSchemaVersion`, server/settings-v3-conversion.ts), so
 *  `requireSettingsWriteAuthority` (server/settings-state-slot.ts) refuses
 *  every mutation against it, unconditionally. That downgraded view is what
 *  the whole read pipeline (`server/settings-v2-reducer.ts`,
 *  `server/settings-v2-mutation.ts`) operates on for its non-mutating
 *  reads. A `.next` residue can be either schema too, exactly like
 *  `current`: a later release's own crash between staging a schema-3
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
    next: nextBytes === null ? null : settingsStateSlotReadOnlyView(parseSettingsStateSlotBytes(nextBytes))
  };
}

/** The current settings-state authority's exact kind: schema 2 (mutable) or
 *  schema 3 (successor-owned, read-only). A mutation must call this and
 *  `requireSettingsWriteAuthority` (server/settings-state-slot.ts) before
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

/** Stage one settings-state replacement, always as schema 2
 *  (`settingsWriteSchemaVersion`, server/settings-v3-conversion.ts, never
 *  resolves to schema 3 in this release). `writeSchemaOptions` no longer
 *  changes the outcome; it stays a parameter only because this function's
 *  own callers (`SettingsV2Store`, server/settings-format-migration.ts)
 *  still pass one.
 *
 *  An earlier version of this function read this directory's own current
 *  schema-3 authority fresh, at the moment it staged, to decide whether the
 *  write needed schema 3 and, when it did, to carry a model's
 *  `imageInput`/`imageTokenCeiling` forward from that authority. Neither
 *  decision exists anymore: this release's settings writer never produces
 *  schema 3, so there is nothing to decide and nothing to carry forward.
 *  That is also what keeps a schema-2 `current` file from ever staging a
 *  schema-3 `.next`, so a predecessor can never find a `.next` residue its
 *  strict reader cannot parse (test/settings-schema-successor.test.ts). */
export async function stageSettingsState(
  dataDir: string,
  state: SettingsStateV2,
  writeSchemaOptions: SettingsWriteSchemaOptions = {}
): Promise<void> {
  void writeSchemaOptions;
  await writePrivateSettingsFile(nextPath(dataDir), formatSettingsStateV2Bytes(state));
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
