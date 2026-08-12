import path from "node:path";
import type { SettingsStateV2, SettingsStateV3 } from "../shared/settings-v2-types.js";
import {
  SETTINGS_STATE_V2_FILE,
  SETTINGS_STATE_V2_NEXT_FILE
} from "./data-directory-layout.js";
import { formatSettingsStateV2Bytes } from "./settings-v2-codec.js";
import {
  parseSettingsStateSlotBytes,
  requireSettingsWriteAuthority,
  settingsStateSlotReadOnlyView,
  upgradeSettingsStateV2ToV3,
  type SettingsStateSlot
} from "./settings-state-slot.js";
import { formatSettingsStateV3 } from "./settings-v3-codec.js";
import {
  settingsStateNeedsSuccessorSchema,
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

/** Both settings-state files together, each schema-2-or-3-transparent: a
 *  genuine schema-2 file parses as itself, and a schema-3 file downgrades to
 *  the same schema-2-shaped working view. A schema-3 file can be this
 *  release's own prior write, or a predecessor-refused one; the caller
 *  decides which by calling `requireSettingsWriteAuthority` first, see
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

/** Stage one settings-state replacement. `writeSchemaOptions` feeds
 *  `settingsWriteSchemaVersion` (server/settings-v3-conversion.ts), the one
 *  site that decides which schema the bytes on disk use; every production
 *  caller passes no options, so activation resolves through
 *  `resolveImageInputActivation()`, the release-wide switch.
 *  `formatSettingsStateForWrite` below reads this directory's own current
 *  authority itself, at the moment it needs it, rather than trusting a
 *  `priorV3` value a caller captured earlier in the same mutation: this is
 *  what keeps every write's schema decision, and its
 *  `imageInput`/`imageTokenCeiling` carry-forward source when it writes
 *  schema 3, grounded in what is actually on disk right now, including
 *  every write this same activation dance already published
 *  (`SettingsV2Store.activateStaged` stages and publishes up to six times in
 *  one activation). It also means a schema-2 `current` file can never stage
 *  a schema-3 `.next`: with no schema-3 authority to read, the write stays
 *  schema 2 regardless of what the caller asked for, so a predecessor can
 *  never find a `.next` residue its strict reader cannot parse
 *  (test/settings-schema-successor.test.ts). */
export async function stageSettingsState(
  dataDir: string,
  state: SettingsStateV2,
  writeSchemaOptions: SettingsWriteSchemaOptions = {}
): Promise<void> {
  await writePrivateSettingsFile(
    nextPath(dataDir),
    await formatSettingsStateForWrite(dataDir, state, writeSchemaOptions)
  );
}

async function formatSettingsStateForWrite(
  dataDir: string,
  state: SettingsStateV2,
  writeSchemaOptions: SettingsWriteSchemaOptions
): Promise<Uint8Array> {
  const priorV3 = await currentPriorV3ForWrite(dataDir, writeSchemaOptions);
  const needsSuccessorSchema = settingsStateNeedsSuccessorSchema(state, priorV3);
  if (settingsWriteSchemaVersion(needsSuccessorSchema, writeSchemaOptions) === 2) {
    return formatSettingsStateV2Bytes(state);
  }
  return Buffer.from(formatSettingsStateV3(upgradeSettingsStateV2ToV3(state, priorV3)), "utf8");
}

/** This directory's own current schema-3 authority, read fresh, for
 *  `formatSettingsStateForWrite` above. Absent when there is no current file
 *  yet (a directory's first-ever write, the format-2 bootstrap in
 *  server/settings-format-migration.ts, which stages before `current` exists),
 *  or when the current file is schema 2. Goes through the same
 *  `requireSettingsWriteAuthority` gate every other write boundary uses
 *  (server/settings-state-slot.ts), so a build that cannot own a schema-3
 *  authority never carries one forward here either, even if a caller's
 *  `writeSchemaOptions` disagreed with what an earlier check in the same
 *  mutation already established. */
async function currentPriorV3ForWrite(
  dataDir: string,
  writeSchemaOptions: SettingsWriteSchemaOptions
): Promise<SettingsStateV3 | null> {
  const bytes = await readOptionalMutableSettingsAuthority(currentPath(dataDir), MAX_SETTINGS_STATE_BYTES);
  if (bytes === null) return null;
  const authority = requireSettingsWriteAuthority(
    parseSettingsStateSlotBytes(bytes),
    writeSchemaOptions.imageInputActivation
  );
  return authority.kind === "v3-owned" ? authority.prior : null;
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
