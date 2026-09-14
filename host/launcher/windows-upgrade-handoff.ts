import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream,
  lstatSync,
  renameSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { INSTALL_OWNERSHIP_FILE } from "../../shared/install-ownership-record.js";
import { fsyncPath, removeQuietly } from "../../shared/safe-file-write.js";
import { acquireInstallationLock } from "./install-lock.js";
import type { InstallationAuthority } from "./install-ownership.js";
import type { UpgradeChannel } from "./upgrade-contract.js";
import {
  HANDOFF_REQUEST,
  HANDOFF_SCRIPT,
  WINDOWS_HANDOFF_BODY,
  WINDOWS_HANDOFF_BOOTSTRAP
} from "./windows-upgrade-handoff-script.js";
import {
  readPowerShellOwnershipRecord
} from "./windows-upgrade-state.js";

export interface WindowsUpgradeHandoffRequest {
  readonly authority: Extract<InstallationAuthority, { kind: "powershell" }>;
  readonly currentVersion: string;
  readonly targetVersion: string;
  readonly channel: UpgradeChannel;
  readonly updateChannel: boolean;
  readonly candidatePath: string;
  readonly candidateSha256: string;
  /** The handoff owns this directory after it starts. */
  readonly workRoot: string;
}

export type WindowsUpgradeHandoffStarter = (
  request: WindowsUpgradeHandoffRequest
) => void | Promise<void>;

export type WindowsUpgradeChannelSaver = (
  authority: Extract<InstallationAuthority, { kind: "powershell" }>,
  channel: UpgradeChannel
) => void | Promise<void>;

/**
 * Start a detached local helper. The helper retries the replacement until the
 * running Windows executable releases its file lock.
 */
export function startWindowsUpgradeHandoff(
  request: WindowsUpgradeHandoffRequest
): Promise<void> {
  const ownership = readPowerShellOwnershipRecord(request.authority);
  const scriptPath = path.win32.join(request.workRoot, HANDOFF_SCRIPT);
  const requestPath = path.win32.join(request.workRoot, HANDOFF_REQUEST);
  writeFileSync(scriptPath, WINDOWS_HANDOFF_BODY, { encoding: "utf8", flag: "wx", mode: 0o600 });
  writeFileSync(requestPath, `${JSON.stringify({
    installRoot: request.authority.installRoot,
    executable: request.authority.executable,
    installationId: ownership.installationId,
    expectedChannel: request.authority.channel,
    targetChannel: request.channel,
    updateChannel: request.updateChannel,
    candidate: request.candidatePath,
    candidateSha256: request.candidateSha256,
    currentVersion: request.currentVersion,
    targetVersion: request.targetVersion
  })}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  const bootstrapCommand = Buffer.from(
    WINDOWS_HANDOFF_BOOTSTRAP,
    "utf16le"
  ).toString("base64");
  const powerShell = windowsPowerShellPath();
  const child = spawn(
    powerShell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      bootstrapCommand
    ],
    {
      cwd: request.workRoot,
      stdio: "ignore",
      windowsHide: true
    }
  );
  return new Promise((resolve, reject) => {
    let settled = false;
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) resolve();
      else reject(new Error("Windows upgrade bootstrap failed"));
    });
  });
}

function windowsPowerShellPath(): string {
  const systemRoot = process.env.SystemRoot;
  if (systemRoot === undefined
    || !path.win32.isAbsolute(systemRoot)
    || systemRoot.startsWith("\\\\")) {
    throw new Error("Windows SystemRoot is invalid");
  }
  const executable = path.win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  const stats = lstatSync(executable);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error("Windows PowerShell is unavailable");
  }
  return executable;
}

/** Read a file without loading the release executable into memory. */
export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(file);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

/** Save a channel-only switch under the same lock used by the Installer. */
export async function saveWindowsUpgradeChannel(
  authority: Extract<InstallationAuthority, { kind: "powershell" }>,
  channel: UpgradeChannel
): Promise<void> {
  const lock = await acquireInstallationLock(authority.installRoot);
  try {
    const recordPath = path.win32.join(authority.installRoot, INSTALL_OWNERSHIP_FILE);
    const record = readPowerShellOwnershipRecord(authority);
    const temporary = path.win32.join(
      authority.installRoot,
      `${INSTALL_OWNERSHIP_FILE}.${randomUUID()}.tmp`
    );
    const next = `${JSON.stringify({ ...record, channel })}\n`;
    try {
      writeFileSync(temporary, next, { encoding: "utf8", flag: "wx", mode: 0o600 });
      fsyncPath(temporary);
      renameSync(temporary, recordPath);
      fsyncPath(recordPath);
    } catch (error) {
      try {
        removeQuietly(temporary);
      } catch {
        // Keep the channel-write failure.
      }
      throw error;
    }
  } finally {
    await lock.release();
  }
}
