import { parseJsonRejectingDuplicateKeys } from "./strict-json.js";
import {
  isBuiltArtifactTarget,
  type BuiltArtifactTarget
} from "./release-targets.js";
import { AI_1667_PRODUCT } from "./build-identity.js";

export const INSTALL_OWNERSHIP_FILE = ".1667-install.json" as const;
/**
 * Canonical active executable basename under the Install Root. Shell Installer
 * and managed upgrade share this name; the Ownership Record layout invariant
 * requires `executable === installRoot + "/" + INSTALL_ACTIVE_EXECUTABLE`.
 */
export const INSTALL_ACTIVE_EXECUTABLE = "1667" as const;
export const INSTALL_CHANNELS = ["stable", "beta"] as const;
export type InstallChannel = typeof INSTALL_CHANNELS[number];
export type InstallMethod = "shell";

export interface InstallOwnershipRecord {
  readonly schemaVersion: 1;
  readonly product: typeof AI_1667_PRODUCT;
  readonly installationId: string;
  readonly method: InstallMethod;
  readonly channel: InstallChannel;
  readonly installRoot: string;
  readonly executable: string;
  readonly artifactTarget: BuiltArtifactTarget;
}

/** Canonical absolute path for the active managed executable under installRoot. */
export function installActiveExecutablePath(installRoot: string): string {
  return `${installRoot}/${INSTALL_ACTIVE_EXECUTABLE}`;
}

/**
 * The exact Ownership Record field set. The PowerShell Installer and the
 * Windows authority check both derive their key list from this one, so a schema
 * change cannot leave a hand-written copy behind.
 */
export const RECORD_KEYS = Object.freeze([
  "schemaVersion",
  "product",
  "installationId",
  "method",
  "channel",
  "installRoot",
  "executable",
  "artifactTarget"
] as const);
const KEY_SET = new Set<string>(RECORD_KEYS);
const INSTALLATION_ID = /^[0-9a-f]{32}$/;
const ABSOLUTE_PATH = /^\/(?:[^/\0]+\/)*[^/\0]+$/;

export function parseInstallOwnershipRecord(value: unknown): InstallOwnershipRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Ownership Record must be an object");
  }
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input);
  if (keys.length !== KEY_SET.size || keys.some((key) => !KEY_SET.has(key))) {
    throw new Error("Ownership Record has unknown or missing fields");
  }
  if (input.schemaVersion !== 1) throw new Error("Ownership Record schema is unsupported");
  if (input.product !== AI_1667_PRODUCT) throw new Error("Ownership Record product is invalid");
  if (input.method !== "shell") throw new Error("Ownership Record method is invalid");
  if (typeof input.installationId !== "string" || !INSTALLATION_ID.test(input.installationId)) {
    throw new Error("Ownership Record installation id is invalid");
  }
  if (input.channel !== "stable" && input.channel !== "beta") {
    throw new Error("Ownership Record channel is invalid");
  }
  if (typeof input.installRoot !== "string" || !isAbsoluteOwnershipPath(input.installRoot)) {
    throw new Error("Ownership Record install root is invalid");
  }
  if (typeof input.executable !== "string" || !isAbsoluteOwnershipPath(input.executable)) {
    throw new Error("Ownership Record executable path is invalid");
  }
  // Layout invariant: active executable is exactly installRoot/INSTALL_ACTIVE_EXECUTABLE.
  if (input.executable !== installActiveExecutablePath(input.installRoot)) {
    throw new Error("Ownership Record executable layout is invalid");
  }
  if (!isBuiltArtifactTarget(input.artifactTarget)) {
    throw new Error("Ownership Record artifact target is invalid");
  }
  return Object.freeze({
    schemaVersion: 1,
    product: AI_1667_PRODUCT,
    installationId: input.installationId,
    method: "shell",
    channel: input.channel,
    installRoot: input.installRoot,
    executable: input.executable,
    artifactTarget: input.artifactTarget
  });
}

export function parseInstallOwnershipRecordText(text: string): InstallOwnershipRecord {
  if (text.length === 0 || text.length > 16_384) {
    throw new Error("Ownership Record text is outside the size bound");
  }
  return parseInstallOwnershipRecord(parseJsonRejectingDuplicateKeys(text));
}

export function serializeInstallOwnershipRecord(record: InstallOwnershipRecord): string {
  const ordered: InstallOwnershipRecord = {
    schemaVersion: 1,
    product: record.product,
    installationId: record.installationId,
    method: record.method,
    channel: record.channel,
    installRoot: record.installRoot,
    executable: record.executable,
    artifactTarget: record.artifactTarget
  };
  return `${JSON.stringify(ordered)}\n`;
}

export function createInstallOwnershipRecord(input: {
  readonly installationId: string;
  readonly channel: InstallChannel;
  readonly installRoot: string;
  readonly executable: string;
  readonly artifactTarget: BuiltArtifactTarget;
}): InstallOwnershipRecord {
  return parseInstallOwnershipRecord({
    schemaVersion: 1,
    product: AI_1667_PRODUCT,
    installationId: input.installationId,
    method: "shell",
    channel: input.channel,
    installRoot: input.installRoot,
    executable: input.executable,
    artifactTarget: input.artifactTarget
  });
}

export function isAbsoluteOwnershipPath(value: string): boolean {
  return ABSOLUTE_PATH.test(value) && !value.includes("//") && !/(^|\/)\.\.?($|\/)/u.test(value);
}
