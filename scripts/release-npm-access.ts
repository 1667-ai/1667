import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync
} from "node:fs";
import path from "node:path";
import {
  PUBLISHED_PLATFORM_PACKAGES,
  RELEASE_LAUNCHER_PACKAGE
} from "../shared/release-targets.js";
import { parseJsonRejectingDuplicateKeys } from "../shared/strict-json.js";
import { NPM_PUBLIC_REGISTRY } from "./release-npm-public-client.js";

const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_TOOL_BYTES = 256 * 1024 * 1024;
const ACCESS_TIMEOUT_MS = 30_000;
const NPM_WRITER = "1667.ai";
const USER = /^[a-z0-9][a-z0-9._-]*$/u;
const PACKAGES = Object.freeze([
  ...PUBLISHED_PLATFORM_PACKAGES,
  RELEASE_LAUNCHER_PACKAGE
]);

export interface NpmWriteAccess {
  verify(packageNames: readonly string[]): Promise<void>;
}

export interface NpmWriteAccessVerifierOptions {
  readonly environment: NodeJS.ProcessEnv;
  readonly nodeExecutable: string;
  readonly npmCli: string;
  readonly timeoutMs?: number;
}

export class NpmWriteAccessVerifier implements NpmWriteAccess {
  readonly #environment: NodeJS.ProcessEnv;
  readonly #node: ToolIdentity;
  readonly #npmCli: ToolIdentity;
  readonly #timeoutMs: number;

  constructor(options: NpmWriteAccessVerifierOptions) {
    this.#environment = npmAccessEnvironment(options.environment);
    this.#node = toolIdentity(options.nodeExecutable, true, "Release Node executable");
    this.#npmCli = toolIdentity(options.npmCli, false, "Release npm CLI");
    this.#timeoutMs = positiveDuration(options.timeoutMs ?? ACCESS_TIMEOUT_MS);
  }

  async verify(packageNames: readonly string[]): Promise<void> {
    if (packageNames.length !== PACKAGES.length
      || new Set(packageNames).size !== packageNames.length
      || PACKAGES.some((name) => !packageNames.includes(name))) {
      throw new Error("npm write access package list is invalid");
    }
    for (const name of packageNames) {
      await this.#verifyPackage(name);
    }
  }

  async #verifyPackage(name: string): Promise<void> {
    if (!PACKAGES.includes(name as typeof PACKAGES[number])) {
      throw new Error("npm write access package name is invalid");
    }
    requireUnchangedTool(this.#node, true, "Release Node executable");
    requireUnchangedTool(this.#npmCli, false, "Release npm CLI");
    const stdout = await executeNpmAccess({
      node: this.#node.path,
      npmCli: this.#npmCli.path,
      environment: this.#environment,
      name,
      timeoutMs: this.#timeoutMs
    });
    requireSoleWriter(parseJsonRejectingDuplicateKeys(stdout), name);
  }
}

interface ToolIdentity {
  readonly path: string;
  readonly sha256: string;
}

function executeNpmAccess(options: {
  readonly node: string;
  readonly npmCli: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly name: string;
  readonly timeoutMs: number;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      options.node,
      [
        options.npmCli,
        "--user-agent=1667-npm-access-verifier",
        "--json",
        `--registry=${NPM_PUBLIC_REGISTRY}`,
        "access",
        "list",
        "collaborators",
        "--",
        options.name
      ],
      {
        encoding: "utf8",
        env: options.environment,
        killSignal: "SIGKILL",
        maxBuffer: MAX_OUTPUT_BYTES,
        shell: false,
        timeout: options.timeoutMs,
        windowsHide: true
      },
      (error, stdout) => {
        if (error !== null) {
          reject(new Error(`${options.name} npm access verification failed`, {
            cause: error
          }));
          return;
        }
        resolve(stdout);
      }
    );
  });
}

function requireSoleWriter(value: unknown, name: string): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} npm collaborators must be an object`);
  }
  const writers: string[] = [];
  for (const [user, permission] of Object.entries(value)) {
    if (!USER.test(user)
      || (permission !== "read-only" && permission !== "read-write")) {
      throw new Error(`${name} npm collaborator access is invalid`);
    }
    if (permission === "read-write") writers.push(user);
  }
  if (writers.length !== 1 || writers[0] !== NPM_WRITER) {
    throw new Error(`${name} npm write access must belong only to ${NPM_WRITER}`);
  }
}

function npmAccessEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const child = { ...environment };
  delete child.GH_TOKEN;
  delete child.GITHUB_TOKEN;
  delete child.NPM_OPERATION_CLAIM_SECRET;
  delete child.NPM_OPERATION_WRITER_SECRET;
  return child;
}

function toolIdentity(
  value: string,
  executable: boolean,
  label: string
): ToolIdentity {
  const path = boundedTool(value, executable, label);
  return Object.freeze({ path, sha256: hashFile(path) });
}

function requireUnchangedTool(
  expected: ToolIdentity,
  executable: boolean,
  label: string
): void {
  const path = boundedTool(expected.path, executable, label);
  if (path !== expected.path || hashFile(path) !== expected.sha256) {
    throw new Error(`${label} changed after verification`);
  }
}

function boundedTool(value: string, executable: boolean, label: string): string {
  if (!path.isAbsolute(value)) throw new Error(`${label} must use an absolute path`);
  const stat = lstatSync(value);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0
    || stat.size > MAX_TOOL_BYTES || (executable && (stat.mode & 0o111) === 0)) {
    throw new Error(`${label} must be a usable regular file`);
  }
  return realpathSync(value);
}

function hashFile(file: string): string {
  const stat = statSync(file);
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_TOOL_BYTES) {
    throw new Error(`Release tool is invalid: ${file}`);
  }
  const descriptor = openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const hash = createHash("sha256");
  try {
    let bytes = 0;
    while ((bytes = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

function positiveDuration(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > ACCESS_TIMEOUT_MS) {
    throw new Error("npm write access timeout is invalid");
  }
  return value;
}
