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
import { MAX_SETTINGS_STATE_BYTES } from "./settings-v2-scalars.js";
import {
  publishSettingsFile,
  readOptionalMutableSettingsAuthority,
  readOptionalSettingsFile,
  removeSettingsFile,
  writePrivateSettingsFile
} from "./settings-file-io.js";

export interface SettingsStateFiles {
  readonly current: SettingsStateV2;
  readonly next: SettingsStateV2 | null;
}

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

export async function readSettingsState(dataDir: string): Promise<SettingsStateV2> {
  const bytes = await readOptionalMutableSettingsAuthority(
    currentPath(dataDir),
    MAX_SETTINGS_STATE_BYTES
  );
  if (bytes === null) throw new Error("Format-2 settings state is missing");
  return parseSettingsStateV2Bytes(bytes);
}

export async function stageSettingsState(
  dataDir: string,
  state: SettingsStateV2
): Promise<void> {
  await writePrivateSettingsFile(nextPath(dataDir), formatSettingsStateV2Bytes(state));
}

export async function publishStagedSettingsState(dataDir: string): Promise<void> {
  await publishSettingsFile(nextPath(dataDir), currentPath(dataDir));
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
