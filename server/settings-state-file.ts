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
  readonly next: SettingsStateSlot | null;
}

/** Both settings-state files together. `current` is always mutable by this
 *  build (a schema-3 `current` never reaches here; the caller that needs to
 *  branch on that reads `readSettingsStateSlot` instead), so it is safe to
 *  present as the plain schema-2-shaped read-only view. `next` is returned
 *  as its full slot, undowngraded: it can be either schema, exactly like
 *  `current` can, because a later release's own crash between staging a
 *  schema-3 replacement and publishing it leaves one behind the same way a
 *  schema-2 crash always has, and the caller (`recoverUnpublishedNext`,
 *  server/settings-v2-store.ts) needs to see which schema it is to decide
 *  whether a receipt could ever apply to it. */
export async function readSettingsStateFiles(dataDir: string): Promise<SettingsStateFiles> {
  const [currentBytes, nextBytes] = await Promise.all([
    readOptionalMutableSettingsAuthority(currentPath(dataDir), MAX_SETTINGS_STATE_BYTES),
    readOptionalSettingsFile(nextPath(dataDir), MAX_SETTINGS_STATE_BYTES)
  ]);
  if (currentBytes === null) throw new Error("Format-2 settings state is missing");
  const currentSlot = parseSettingsStateSlotBytes(currentBytes);
  return {
    current: settingsStateSlotReadOnlyView(currentSlot),
    next: nextBytes === null ? null : parseSettingsStateSlotBytes(nextBytes)
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

/** Stage one settings-state replacement. Always schema 2: this release's
 *  settings writer never produces schema 3, so a schema-2 `current` file can
 *  never stage a schema-3 `.next`, and a predecessor can never find a
 *  `.next` residue its strict reader cannot parse
 *  (test/settings-schema-successor.test.ts). */
export async function stageSettingsState(
  dataDir: string,
  state: SettingsStateV2
): Promise<void> {
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
