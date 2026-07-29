import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  realpath
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  NpmOperationLeaseRequest
} from "./release-npm-operation-lease-state.js";
import type {
  NpmOperationStatePaths,
  NpmOperationStateStore,
  NpmOperationWorkspace
} from "./release-npm-operation-orchestration.js";

const execFileAsync = promisify(execFile);

export class ProtectedMainWorkspace implements NpmOperationWorkspace {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = directory;
  }

  async verifyProtectedMain(expectedCommit?: string): Promise<void> {
    await git(this.#directory, [
      "fetch", "--no-tags", "origin",
      "+refs/heads/main:refs/remotes/origin/main"
    ]);
    const head = await git(this.#directory, ["rev-parse", "HEAD"]);
    const main = await git(this.#directory, [
      "rev-parse", "refs/remotes/origin/main"
    ]);
    if (head !== main || (expectedCommit !== undefined && head !== expectedCommit)) {
      throw new Error("npm operation tooling is not the protected main commit");
    }
    if (await git(this.#directory, ["status", "--porcelain"]) !== "") {
      throw new Error("npm operation tooling worktree is not clean");
    }
  }
}

export class DurableNpmOperationState implements NpmOperationStateStore {
  readonly #root: string;

  constructor(environment: NodeJS.ProcessEnv) {
    const stateHome = environment.XDG_STATE_HOME
      ?? path.join(requiredValue(environment.HOME, "HOME"), ".local", "state");
    if (!path.isAbsolute(stateHome)) {
      throw new Error("npm operation state home must be absolute");
    }
    this.#root = path.join(stateHome, "1667", "npm-operations");
  }

  async prepareRoot(): Promise<void> {
    await secureDirectory(this.#root);
  }

  async paths(request: NpmOperationLeaseRequest): Promise<NpmOperationStatePaths> {
    const stateDirectory = path.join(
      this.#root,
      npmOperationStateDirectoryName(request)
    );
    await secureDirectory(stateDirectory);
    return npmOperationStatePaths(stateDirectory);
  }
}

export async function npmOperationRecoveryPaths(
  value: string,
  request: NpmOperationLeaseRequest
): Promise<NpmOperationStatePaths> {
  if (!path.isAbsolute(value)
    || path.basename(value) !== npmOperationStateDirectoryName(request)) {
    throw new Error("npm operation recovery state directory does not match the lease");
  }
  const stat = await lstat(value);
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || await realpath(value) !== value) {
    throw new Error("npm operation recovery state directory is invalid");
  }
  return npmOperationStatePaths(value);
}

export function npmOperationStatePaths(
  stateDirectory: string
): NpmOperationStatePaths {
  return Object.freeze({
    stateDirectory,
    operationJournal: path.join(stateDirectory, "journal.jsonl"),
    processJournal: path.join(stateDirectory, "processes.jsonl"),
    reconciliationRecord: path.join(stateDirectory, "reconciliation.json")
  });
}

export function npmOperationStateDirectoryName(
  request: NpmOperationLeaseRequest
): string {
  return `run-${request.runId}-attempt-${request.runAttempt}`
    + `-${request.operation}-v${request.version}`;
}

async function secureDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || await realpath(directory) !== directory) {
    throw new Error("npm operation state directory is invalid");
  }
  await chmod(directory, 0o700);
}

async function git(directory: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd: directory,
    encoding: "utf8",
    maxBuffer: 1024 * 1024
  });
  return result.stdout.trim();
}

function requiredValue(value: string | undefined, name: string): string {
  if (value === undefined || value === "") {
    throw new Error(`npm operation orchestration requires ${name}`);
  }
  return value;
}
