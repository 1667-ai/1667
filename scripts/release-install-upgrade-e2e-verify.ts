import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  INSTALL_ACTIVE_EXECUTABLE,
  INSTALL_OWNERSHIP_FILE,
  parseInstallOwnershipRecordText
} from "../shared/install-ownership-record.js";
import { parseBuildIdentity } from "../shared/build-identity.js";
import { execProcess, type CommandResult } from "./release-install-upgrade-e2e-process.js";

export const NPM_RELEASE_SIGNER = "1667-ai/1667/.github/workflows/release-npm.yml";
export const GITHUB_RELEASE_SIGNER = "1667-ai/1667/.github/workflows/release-github.yml";

/** Every `1667 upgrade --json` envelope carries exactly these keys. */
const ENVELOPE_KEYS = [
  "channel",
  "command",
  "current",
  "error",
  "latest",
  "method",
  "restartRequired",
  "status",
  "target"
] as const;

export class StepError extends Error {
  constructor(
    public readonly stepNum: number,
    message: string
  ) {
    super(`FAIL [${stepNum}/10] ${message}`);
    this.name = "StepError";
  }
}

export function logStepPass(stepNum: number, description: string): void {
  process.stdout.write(`PASS [${stepNum}/10] ${description}\n`);
}

export function parseJsonOutput(
  result: CommandResult,
  stepNum: number,
  label: string
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new StepError(stepNum, `${label} did not print JSON:\n${result.stdout}${result.stderr}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new StepError(stepNum, `${label} printed ${JSON.stringify(parsed)}, expected an object.`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Checks the published envelope against the contract as well as the fields the
 * caller names. A gate that inspects only named fields accepts an envelope that
 * omits a contract field or contradicts itself, so it can pass while the
 * published JSON interface is broken.
 */
export function assertEnvelope(
  env: Record<string, unknown>,
  expected: Record<string, unknown>,
  stepNum: number,
  label: string
): void {
  const actualKeys = Object.keys(env).sort();
  if (actualKeys.join(",") !== [...ENVELOPE_KEYS].join(",")) {
    throw new StepError(
      stepNum,
      `${label} envelope keys are ${JSON.stringify(actualKeys)}, expected ${JSON.stringify(ENVELOPE_KEYS)}.`
    );
  }
  for (const [key, value] of Object.entries(expected)) {
    if (env[key] !== value) {
      throw new StepError(
        stepNum,
        `${label} envelope field '${key}' is ${JSON.stringify(env[key])}, expected ${JSON.stringify(value)}.`
      );
    }
  }
  if (env.command !== null) {
    throw new StepError(
      stepNum,
      `${label} envelope command is ${JSON.stringify(env.command)}, expected null.`
    );
  }
  const restartRequired = env.status === "applied" || env.status === "staged";
  if (env.restartRequired !== restartRequired) {
    throw new StepError(
      stepNum,
      `${label} envelope restartRequired is ${JSON.stringify(env.restartRequired)}, expected ${restartRequired}.`
    );
  }
  if (env.status === "error") {
    if (typeof env.error !== "object" || env.error === null) {
      throw new StepError(stepNum, `${label} error envelope is missing error details object.`);
    }
  } else if (env.error !== null) {
    throw new StepError(
      stepNum,
      `${label} success envelope carries error ${JSON.stringify(env.error)}, expected null.`
    );
  }
}

/** Runs the action and refuses any change to the named file. Every lane that
 *  must stay read-only proves it the same way. */
export async function withUnchangedBytes<T>(
  file: string,
  stepNum: number,
  message: string,
  action: () => Promise<T>
): Promise<T> {
  const before = await readFile(file);
  const result = await action();
  const after = await readFile(file);
  if (!before.equals(after)) {
    throw new StepError(stepNum, message);
  }
  return result;
}

export interface IdentityExpectation {
  readonly version: string;
  readonly artifactTarget: string;
}

/**
 * A version string alone does not prove a released build. A development build,
 * or a build for another architecture that runs under emulation, reports the
 * expected version, so the gate checks the complete identity every time.
 */
export async function probeIdentity(
  executable: string,
  expected: IdentityExpectation,
  stepNum: number,
  label: string
): Promise<void> {
  const probe = await execProcess(executable, ["--version", "--json"]);
  if (probe.exitCode !== 0) {
    throw new StepError(stepNum, `${label} --version --json failed:\n${probe.stderr}`);
  }
  const identity = parseBuildIdentity(parseJsonOutput(probe, stepNum, `${label} --version --json`));
  if (identity.productVersion !== expected.version) {
    throw new StepError(
      stepNum,
      `${label} version is ${identity.productVersion}, expected ${expected.version}`
    );
  }
  if (identity.buildKind !== "release") {
    throw new StepError(stepNum, `${label} buildKind is ${identity.buildKind}, expected release`);
  }
  if (identity.artifactTarget !== expected.artifactTarget) {
    throw new StepError(
      stepNum,
      `${label} artifactTarget is ${identity.artifactTarget}, expected ${expected.artifactTarget}`
    );
  }
}

export async function verifyOwnershipRecord(
  prefix: string,
  expectedChannel: string,
  stepNum: number,
  label: string
): Promise<void> {
  const recordPath = path.join(prefix, INSTALL_OWNERSHIP_FILE);
  const recordStat = await stat(recordPath);
  if ((recordStat.mode & 0o777) !== 0o600) {
    throw new StepError(
      stepNum,
      `${label} Ownership Record file mode is ${recordStat.mode.toString(8)}, expected 0600`
    );
  }
  const record = parseInstallOwnershipRecordText(await readFile(recordPath, "utf8"));
  if (record.method !== "shell" || record.channel !== expectedChannel) {
    throw new StepError(
      stepNum,
      `${label} ownership record method/channel invalid: ${JSON.stringify(record)}`
    );
  }
  // The prefix is already canonical, so the record must repeat it exactly.
  if (
    record.installRoot !== prefix
    || record.executable !== path.join(prefix, INSTALL_ACTIVE_EXECUTABLE)
  ) {
    throw new StepError(stepNum, `${label} ownership record canonical paths do not match realpath`);
  }
}

export async function verifyAttestation(
  scriptPath: string,
  signerWorkflows: readonly string[],
  stepNum: number,
  label: string
): Promise<void> {
  const failures: string[] = [];
  for (const signerWorkflow of signerWorkflows) {
    const result = await execProcess("gh", [
      "attestation",
      "verify",
      scriptPath,
      "--repo",
      "1667-ai/1667",
      "--signer-workflow",
      signerWorkflow,
      "--deny-self-hosted-runners",
      "--format",
      "json"
    ]);
    if (result.exitCode !== 0) {
      failures.push(`${signerWorkflow}: ${result.stderr || result.stdout}`);
      continue;
    }
    try {
      const attestations: unknown = JSON.parse(result.stdout);
      if (Array.isArray(attestations) && attestations.length > 0) return;
      failures.push(`${signerWorkflow}: verification returned no attestation entries`);
    } catch (error: unknown) {
      failures.push(
        `${signerWorkflow}: invalid verification JSON: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  throw new StepError(
    stepNum,
    `gh attestation verify failed for ${label} with each approved signer workflow:\n${failures.join("\n")}`
  );
}

export function executeInstaller(script: Buffer, prefix: string): Promise<CommandResult> {
  return execProcess("sh", ["-s", "--", "--prefix", prefix], { input: script });
}

export interface ManagedInstallation {
  readonly prefix: string;
  readonly executable: string;
}

/** Installs verified installer bytes into a private prefix and proves the
 *  result is the expected Managed Installation. */
export async function installIntoPrefix(options: {
  readonly scratchRoot: string;
  readonly directoryName: string;
  readonly script: Buffer;
  readonly expected: IdentityExpectation;
  readonly channel: string;
  readonly stepNum: number;
  readonly label: string;
}): Promise<ManagedInstallation> {
  const rawPrefix = path.join(options.scratchRoot, options.directoryName);
  await mkdir(rawPrefix, { mode: 0o755 });
  const prefix = await realpath(rawPrefix);
  const install = await executeInstaller(options.script, prefix);
  if (install.exitCode !== 0) {
    throw new StepError(
      options.stepNum,
      `${options.label} installer execution failed:\n${install.stderr}`
    );
  }
  const executable = path.join(prefix, INSTALL_ACTIVE_EXECUTABLE);
  await probeIdentity(executable, options.expected, options.stepNum, `${options.label} executable`);
  await verifyOwnershipRecord(prefix, options.channel, options.stepNum, options.label);
  return { prefix, executable };
}

/** Runs one `1667 upgrade` command and returns its envelope. A non-zero exit
 *  code is a step failure, so no caller repeats that check. */
export async function runUpgrade(
  executable: string,
  args: readonly string[],
  stepNum: number,
  label: string
): Promise<Record<string, unknown>> {
  const result = await execProcess(executable, ["upgrade", ...args, "--json"]);
  if (result.exitCode !== 0) {
    throw new StepError(stepNum, `${label} failed:\n${result.stderr || result.stdout}`);
  }
  return parseJsonOutput(result, stepNum, label);
}
