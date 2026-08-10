import { cp, lstat, open, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import {
  LEGACY_DATA_OWNER_MARKER,
  LEGACY_PREVIEW_DATA_MARKER,
  LEGACY_PREVIEW_DATA_MARKER_TEXT,
  LEGACY_PROCESS_OWNER_LOCK,
  PROJECT_CONTROL_ENTRY_NAMES,
  PROVIDER_SECRETS_FILE,
  SETTINGS_STATE_V2_FILE,
  type DataDirectoryFormat
} from "./data-directory-layout.js";
import { RuntimeDataDirectoryLock } from "./runtime-data-directory.js";
import {
  MAX_DATA_DIRECTORY_OWNER_MARKER_BYTES,
  parseDataDirectoryOwnerMarkerBytes,
  publishDataDirectoryOwnerMarker
} from "./data-directory-format.js";
import { readBoundedRegularFile } from "./data-directory-file-read.js";
import { loadGenerationSettingsV1 } from "./settings-v1-store.js";
import { parseSettingsStateSlotBytes } from "./settings-state-slot.js";
import { syncDirectory } from "./story-lifecycle.js";
import { MAX_SETTINGS_STATE_BYTES } from "./settings-v2-scalars.js";
import { ServiceError } from "./errors.js";
import { lockFile } from "./os-file-lock.js";
import { initializeProject, type ResolvedProject } from "./project-discovery.js";
import {
  readProviderSecrets,
  writeProviderSecret
} from "./provider-secret-store.js";

const CONTROL_NAMES = new Set<string>(PROJECT_CONTROL_ENTRY_NAMES);

export interface ProjectAdoption {
  readonly project: ResolvedProject;
  readonly source: string;
  readonly movedEntries: readonly string[];
  readonly relocatedSecretIds: readonly string[];
}

/**
 * Adopt a legacy machine data root as this folder's project.
 *
 * Secrets move to the machine tier **first** and are verified there before
 * anything is published into the project tier, so no window exists in which a
 * plaintext key sits inside a folder the user may commit. Adoption that cannot
 * complete the relocation refuses and moves nothing.
 */
export async function adoptDataDirectory(options: {
  readonly source: string;
  readonly projectRoot: string;
  readonly machineDir: string;
}): Promise<ProjectAdoption> {
  const source = path.resolve(options.source);
  const dataFormat = await legacyDataFormat(source);
  await requireReadableSettings(source, dataFormat);
  const release = await lockLegacySource(source);
  try {
    const payload = (await readdir(source)).filter(
      (entry) => !CONTROL_NAMES.has(entry)
    );
    const project = await requireEmptyProject(options.projectRoot);
    const relocatedSecretIds = await relocateSecrets(source, options.machineDir);
    await movePayload(source, project.directory, payload);
    // Publishing the marker last is what makes the adopted directory a project.
    // Only the marker: the settings state, stories, and receipts that just
    // arrived are the adopted data, and no initializer may rewrite them.
    await publishDataDirectoryOwnerMarker(project.directory, dataFormat);
    // Open it the way the next `1667` start will, which both proves the adopted
    // project is readable and runs any settings-format migration it owes.
    const lock = new RuntimeDataDirectoryLock(project.directory);
    await lock.acquire();
    await lock.release();
    return {
      project,
      source,
      movedEntries: payload,
      relocatedSecretIds
    };
  } finally {
    await release();
  }
}

/**
 * Refuse before anything moves. A directory whose settings state this build
 * cannot read is not adoptable, and finding that out after the move would leave
 * the data stranded between two tiers.
 */
async function requireReadableSettings(
  source: string,
  dataFormat: DataDirectoryFormat
): Promise<void> {
  if (dataFormat === 1) {
    // The next ordinary open migrates v1 settings to v2. If they cannot be read
    // that migration fails after the source has already been emptied.
    try {
      await loadGenerationSettingsV1(source);
    } catch (error) {
      throw refused(
        `${source} holds settings this build cannot read `
          + `(${error instanceof Error ? error.message : String(error)})`
      );
    }
    return;
  }
  const file = path.join(source, SETTINGS_STATE_V2_FILE);
  if (!await exists(file)) {
    throw refused(`${file} is missing, so its settings cannot be adopted`);
  }
  try {
    // Read-only probe: a schema-3 authority is adoptable too, since this
    // build can read and present it, even though it cannot change it.
    parseSettingsStateSlotBytes(
      await readBoundedRegularFile(file, MAX_SETTINGS_STATE_BYTES)
    );
  } catch (error) {
    throw refused(
      `${file} is not settings state this build can read `
        + `(${error instanceof Error ? error.message : String(error)})`
    );
  }
}

/** Move every stored secret into the machine tier, then prove it arrived. */
async function relocateSecrets(
  source: string,
  machineDir: string
): Promise<readonly string[]> {
  const file = path.join(source, PROVIDER_SECRETS_FILE);
  if (!await exists(file)) return [];
  const [legacy, machine] = await Promise.all([
    readProviderSecrets(source),
    readProviderSecrets(machineDir)
  ]);
  for (const [secretId, value] of legacy) {
    const existing = machine.get(secretId);
    if (existing !== undefined && existing !== value) {
      throw refused(
        `the machine tier already holds a different secret for ${secretId}. `
          + "Remove one of them, then adopt again"
      );
    }
  }
  for (const [secretId, value] of legacy) {
    await writeProviderSecret(machineDir, secretId, value);
  }
  const arrived = await readProviderSecrets(machineDir);
  for (const [secretId, value] of legacy) {
    if (arrived.get(secretId) !== value) {
      throw refused(
        `${secretId} did not arrive in the machine tier at ${machineDir}; `
          + "nothing was moved out of the data directory"
      );
    }
  }
  await rm(file, { force: true });
  return [...legacy.keys()];
}

async function requireEmptyProject(projectRoot: string): Promise<ResolvedProject> {
  const project = await initializeProject(projectRoot);
  const existing = (await readdir(project.directory)).filter(
    (entry) => !CONTROL_NAMES.has(entry) && entry !== ".gitignore"
  );
  if (existing.length > 0) {
    throw refused(
      `${project.directory} already holds ${existing.join(", ")}. `
        + "Adopt into an empty project"
    );
  }
  return project;
}

/** Read the format an old directory declares under its legacy marker names. */
async function legacyDataFormat(source: string): Promise<DataDirectoryFormat> {
  if (!await exists(source)) {
    throw refused(`there is no 1667 data directory at ${source}`);
  }
  const marker = path.join(source, LEGACY_DATA_OWNER_MARKER);
  if (await exists(marker)) {
    const bytes = await readBoundedRegularFile(
      marker,
      MAX_DATA_DIRECTORY_OWNER_MARKER_BYTES
    );
    return parseDataDirectoryOwnerMarkerBytes(bytes, marker).dataFormat;
  }
  const legacyPreview = path.join(source, LEGACY_PREVIEW_DATA_MARKER);
  if (await exists(legacyPreview)) {
    const bytes = await readBoundedRegularFile(
      legacyPreview,
      MAX_DATA_DIRECTORY_OWNER_MARKER_BYTES
    ).catch(() => null);
    if (bytes === null
      || !bytes.equals(Buffer.from(LEGACY_PREVIEW_DATA_MARKER_TEXT, "utf8"))) {
      throw refused(
        `${legacyPreview} is not a 1667 legacy-preview marker, so this `
          + "directory cannot be adopted"
      );
    }
    return 1;
  }
  throw refused(
    `${source} carries no 1667 owner marker, so there is nothing to adopt`
  );
}

/**
 * Hold the old directory's own lock for the move. Nothing running today opens
 * these directories, but a 1667 that predates this build still can.
 */
async function lockLegacySource(source: string): Promise<() => Promise<void>> {
  const lockPath = path.join(source, LEGACY_PROCESS_OWNER_LOCK);
  const handle = await open(lockPath, "a+", 0o600);
  try {
    const lock = await lockFile(handle.fd, lockPath);
    return async () => {
      try {
        await lock.unlock();
      } finally {
        await handle.close();
      }
    };
  } catch {
    await handle.close();
    throw refused(
      `${source} is open in another 1667 process. Stop it, then adopt again`
    );
  }
}

/**
 * Move the payload, or leave both directories as they were.
 *
 * A half-moved adoption is the worst outcome available: the source has lost
 * data, the target is not yet a project, and a retry refuses because the target
 * is no longer empty. So a failure walks the completed moves back before
 * rethrowing, and the moves that did land are made durable before the marker
 * that claims them is published.
 */
async function movePayload(
  source: string,
  projectDirectory: string,
  payload: readonly string[]
): Promise<void> {
  const moved: string[] = [];
  try {
    for (const entry of payload) {
      await movePath(path.join(source, entry), path.join(projectDirectory, entry));
      moved.push(entry);
    }
  } catch (error) {
    for (const entry of moved.reverse()) {
      await movePath(
        path.join(projectDirectory, entry),
        path.join(source, entry)
      ).catch(() => undefined);
    }
    throw error;
  }
  await syncDirectory(projectDirectory);
  await syncDirectory(source);
}

/** Rename where the filesystem allows it; copy and remove across devices. */
async function movePath(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
    return;
  } catch (error) {
    if (!isErrorCode(error, "EXDEV")) throw error;
  }
  await cp(from, to, { recursive: true, errorOnExist: true, force: false });
  await rm(from, { recursive: true, force: true });
}

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

function refused(detail: string): ServiceError {
  return new ServiceError(
    409,
    `1667 could not adopt this data directory: ${detail}.`,
    "data_directory_unowned"
  );
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
