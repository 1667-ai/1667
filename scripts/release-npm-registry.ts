import { execFile } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import {
  mkdtemp,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { canonicalJson } from "../server/canonical-json.js";
import { parseJsonRejectingDuplicateKeys } from "../shared/strict-json.js";
import {
  NpmRegistryPendingError,
  validateNpmAuditProvenance
} from "./release-npm-provenance.js";
import {
  NpmPublicationAlreadyExistsError,
  NpmPublicationPendingTimeoutError,
  type NpmPublicationPackage,
  type NpmPublicationRegistry
} from "./release-npm-publisher.js";

const execFileAsync = promisify(execFile);
const DEFAULT_REGISTRY = "https://registry.npmjs.org/";
const MAX_REGISTRY_BYTES = 1024 * 1024;
const MAX_NPM_OUTPUT_BYTES = 8 * 1024 * 1024;
const REGISTRY_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_VISIBILITY_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 10_000;
const COMMIT = /^[0-9a-f]{40}$/;
const NPM_CREDENTIAL_VARIABLE = /^(?:NODE_AUTH_TOKEN|NPM_TOKEN|NPM_AUTH_TOKEN)$/iu;
const GITHUB_CREDENTIAL_VARIABLE = /^(?:GH_TOKEN|GITHUB_TOKEN)$/iu;

export { validateNpmAuditProvenance } from "./release-npm-provenance.js";

export interface NpmCliInvocation {
  readonly nodeExecutable: string;
  readonly npmCli: string;
}

export interface NpmReleaseRegistryOptions {
  readonly npm: NpmCliInvocation;
  readonly sourceCommit: string;
  readonly sourceRef: string;
  readonly workflowPath?: string;
  readonly repositoryUrl?: string;
  readonly registry?: string;
  readonly visibilityTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly fetch?: typeof fetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export class NpmReleaseRegistry implements NpmPublicationRegistry {
  readonly #npm: NpmCliInvocation;
  readonly #sourceCommit: string;
  readonly #sourceRef: string;
  readonly #workflowPath: string;
  readonly #repositoryUrl: string;
  readonly #registry: string;
  readonly #visibilityTimeoutMs: number;
  readonly #pollIntervalMs: number;
  readonly #fetch: typeof fetch;
  readonly #sleep: (milliseconds: number) => Promise<void>;

  constructor(options: NpmReleaseRegistryOptions) {
    if (!COMMIT.test(options.sourceCommit)) {
      throw new Error("npm provenance source commit is not canonical");
    }
    if (!options.sourceRef.startsWith("refs/heads/")) {
      throw new Error("npm provenance source ref must be a branch");
    }
    this.#npm = validateNpmInvocation(options.npm);
    this.#sourceCommit = options.sourceCommit;
    this.#sourceRef = options.sourceRef;
    this.#workflowPath = options.workflowPath ?? ".github/workflows/release-npm.yml";
    this.#repositoryUrl = options.repositoryUrl ?? "https://github.com/1667-ai/1667";
    this.#registry = registryUrl(options.registry ?? DEFAULT_REGISTRY);
    this.#visibilityTimeoutMs = positiveDuration(
      options.visibilityTimeoutMs ?? DEFAULT_VISIBILITY_TIMEOUT_MS,
      "npm visibility timeout"
    );
    this.#pollIntervalMs = positiveDuration(
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      "npm visibility poll interval"
    );
    this.#fetch = options.fetch ?? fetch;
    this.#sleep = options.sleep ?? ((milliseconds) => {
      return new Promise((resolve) => setTimeout(resolve, milliseconds));
    });
    assertNoNpmCredentialEnvironment(process.env);
  }

  async inspect(packageToPublish: NpmPublicationPackage): Promise<"missing" | "present"> {
    const label = `${packageToPublish.name}@${packageToPublish.version}`;
    const response = await this.#metadataResponse(
      exactVersionUrl(
        this.#registry,
        packageToPublish.name,
        packageToPublish.version
      ),
      label
    );
    if (response.status === 404) return "missing";
    validateRegistryVersion(
      await boundedJsonResponse(response, label),
      packageToPublish
    );
    return "present";
  }

  async publish(packageToPublish: NpmPublicationPackage): Promise<void> {
    await this.#withNpmEnvironment(async ({ cwd, environment, commonArguments }) => {
      try {
        await runNpm(this.#npm, [
          "publish",
          packageToPublish.tarballPath,
          "--tag=next",
          "--access=public",
          "--provenance",
          "--ignore-scripts",
          ...commonArguments
        ], cwd, environment);
      } catch (error) {
        if (!npmVersionAlreadyExists(error)) throw error;
        throw new NpmPublicationAlreadyExistsError(
          `${packageToPublish.name}@${packageToPublish.version} already exists`,
          { cause: error }
        );
      }
    });
  }

  async waitUntilVerified(packages: readonly NpmPublicationPackage[]): Promise<void> {
    const deadline = Date.now() + this.#visibilityTimeoutMs;
    let lastError: unknown = new Error("npm package is not visible");
    while (Date.now() < deadline) {
      try {
        for (const packageToVerify of packages) {
          if (await this.inspect(packageToVerify) !== "present") {
            throw new NpmRegistryPendingError(
              `${packageToVerify.name}@${packageToVerify.version} is not visible`
            );
          }
          await this.#verifyNextTag(packageToVerify);
        }
        await this.#verifyProvenance(packages);
        return;
      } catch (error) {
        if (!(error instanceof NpmRegistryPendingError)) throw error;
        lastError = error;
        await this.#sleep(this.#pollIntervalMs);
      }
    }
    throw new NpmPublicationPendingTimeoutError(
      "npm package visibility or provenance did not settle in time", {
      cause: lastError
      }
    );
  }

  async #verifyNextTag(packageToVerify: NpmPublicationPackage): Promise<void> {
    const label = `${packageToVerify.name} package metadata`;
    const response = await this.#metadataResponse(
      packageUrl(this.#registry, packageToVerify.name),
      label
    );
    if (response.status === 404) {
      throw new NpmRegistryPendingError(`${packageToVerify.name} is not visible`);
    }
    validateRegistryNextTag(
      await boundedJsonResponse(response, label),
      packageToVerify
    );
  }

  async #metadataResponse(url: string, label: string): Promise<Response> {
    let response: Response;
    try {
      response = await this.#fetch(url, {
        headers: { accept: "application/json" },
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(REGISTRY_REQUEST_TIMEOUT_MS)
      });
    } catch (error) {
      throw new NpmRegistryPendingError(
        `npm registry request did not settle for ${label}`,
        { cause: error }
      );
    }
    if (response.status === 200 || response.status === 404) return response;
    if (response.status === 408 || response.status === 425 || response.status === 429
      || response.status >= 500) {
      throw new NpmRegistryPendingError(
        `npm registry returned ${response.status} for ${label}`
      );
    }
    throw new Error(`npm registry returned ${response.status} for ${label}`);
  }

  async #verifyProvenance(packages: readonly NpmPublicationPackage[]): Promise<void> {
    for (const packageToVerify of packages) {
      await this.#withNpmEnvironment(async ({ cwd, environment, commonArguments }) => {
        await writeFile(path.join(cwd, "package.json"), `${canonicalJson({
          name: "1667-release-provenance-check",
          version: "0.0.0",
          private: true,
          dependencies: {
            [packageToVerify.name]: packageToVerify.version
          }
        })}\n`, { encoding: "utf8", mode: 0o600 });
        try {
          await runNpm(this.#npm, [
            "install",
            "--force",
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            ...commonArguments
          ], cwd, environment);
        } catch (error) {
          throw new NpmRegistryPendingError(
            `${packageToVerify.name}@${packageToVerify.version}`
            + " provenance install did not settle",
            { cause: error }
          );
        }
        let stdout: string;
        let auditFailed = false;
        try {
          stdout = await runNpm(this.#npm, [
            "audit",
            "signatures",
            "--json",
            "--include-attestations",
            ...commonArguments
          ], cwd, environment);
        } catch (error) {
          const captured = npmFailureStdout(error);
          if (captured === null) {
            throw new NpmRegistryPendingError(
              `${packageToVerify.name}@${packageToVerify.version}`
              + " provenance audit did not settle",
              { cause: error }
            );
          }
          stdout = captured;
          auditFailed = true;
        }
        let audit: unknown;
        try {
          audit = parseJsonRejectingDuplicateKeys(stdout);
        } catch (error) {
          if (!auditFailed) throw error;
          throw new NpmRegistryPendingError(
            `${packageToVerify.name}@${packageToVerify.version}`
            + " provenance audit returned no structured result",
            { cause: error }
          );
        }
        validateNpmAuditProvenance(
          audit,
          packageToVerify,
          {
            sourceCommit: this.#sourceCommit,
            sourceRef: this.#sourceRef,
            workflowPath: this.#workflowPath,
            repositoryUrl: this.#repositoryUrl
          }
        );
        if (auditFailed) {
          throw new Error(
            `${packageToVerify.name}@${packageToVerify.version}`
            + " provenance audit exited unsuccessfully"
          );
        }
      });
    }
  }

  async #withNpmEnvironment<T>(
    operation: (input: {
      readonly cwd: string;
      readonly environment: NodeJS.ProcessEnv;
      readonly commonArguments: readonly string[];
    }) => Promise<T>
  ): Promise<T> {
    const directory = await mkdtemp(path.join(realpathSync(tmpdir()), "1667-npm-release-"));
    try {
      const userConfig = path.join(directory, "user.npmrc");
      const globalConfig = path.join(directory, "global.npmrc");
      await Promise.all([
        writeFile(userConfig, `registry=${this.#registry}\n`, { encoding: "utf8", mode: 0o600 }),
        writeFile(globalConfig, "", { encoding: "utf8", mode: 0o600 })
      ]);
      return await operation({
        cwd: directory,
        environment: npmEnvironment(directory, userConfig, globalConfig),
        commonArguments: Object.freeze([
          `--registry=${this.#registry}`,
          `--userconfig=${userConfig}`,
          `--globalconfig=${globalConfig}`
        ])
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

export function validateRegistryVersion(
  value: unknown,
  expected: NpmPublicationPackage
): void {
  const record = object(value, "npm exact-version metadata");
  if (record.name !== expected.name || record.version !== expected.version) {
    throw new Error(`npm registry returned the wrong package for ${expected.name}`);
  }
  if ("deprecated" in record && record.deprecated !== "") {
    if (typeof record.deprecated !== "string") {
      throw new Error(`${expected.name}@${expected.version} has invalid deprecation metadata`);
    }
    throw new Error(`${expected.name}@${expected.version} is deprecated`);
  }
  const dist = object(record.dist, `${expected.name}@${expected.version} distribution`);
  if (dist.integrity !== expected.integrity) {
    throw new Error(`${expected.name}@${expected.version} has a different registry digest`);
  }
  if (dist.attestations === undefined) {
    throw new NpmRegistryPendingError(
      `${expected.name}@${expected.version} has no registry attestations`
    );
  }
  const attestations = object(
    dist.attestations,
    `${expected.name}@${expected.version} attestations`
  );
  if (typeof attestations.url !== "string" || attestations.url.length === 0) {
    throw new Error(`${expected.name}@${expected.version} has no registry attestations`);
  }
}

export function validateRegistryNextTag(
  value: unknown,
  expected: NpmPublicationPackage
): void {
  const record = object(value, "npm package metadata");
  if (record.name !== expected.name) {
    throw new Error(`npm registry returned the wrong package for ${expected.name}`);
  }
  if (record["dist-tags"] === undefined) {
    throw new NpmRegistryPendingError(`${expected.name} has no npm dist-tags`);
  }
  const tags = object(record["dist-tags"], `${expected.name} npm dist-tags`);
  if (tags.next === undefined) {
    throw new NpmRegistryPendingError(`${expected.name} has no npm next tag`);
  }
  if (typeof tags.next !== "string") {
    throw new Error(`${expected.name} has invalid npm next tag metadata`);
  }
  if (tags.next !== expected.version) {
    throw new NpmRegistryPendingError(
      `${expected.name} npm next tag does not name ${expected.version}`
    );
  }
}

function validateNpmInvocation(value: NpmCliInvocation): NpmCliInvocation {
  return Object.freeze({
    nodeExecutable: boundedTool(value.nodeExecutable, true, "Release Node executable"),
    npmCli: boundedTool(value.npmCli, false, "Release npm CLI")
  });
}

function boundedTool(value: string, executable: boolean, label: string): string {
  if (!path.isAbsolute(value)) throw new Error(`${label} must use an absolute path`);
  const stat = lstatSync(value);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0
    || (executable && (stat.mode & 0o111) === 0)) {
    throw new Error(`${label} must be a usable regular file`);
  }
  return realpathSync(value);
}

async function runNpm(
  invocation: NpmCliInvocation,
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv
): Promise<string> {
  const { stdout } = await execFileAsync(invocation.nodeExecutable, [
    invocation.npmCli,
    ...args
  ], {
    cwd,
    encoding: "utf8",
    env: environment,
    maxBuffer: MAX_NPM_OUTPUT_BYTES,
    timeout: 5 * 60_000,
    windowsHide: true
  });
  return stdout;
}

function npmFailureStdout(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const stdout = (error as Error & { readonly stdout?: unknown }).stdout;
  return typeof stdout === "string" ? stdout : null;
}

function npmVersionAlreadyExists(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const stderr = (error as Error & { readonly stderr?: unknown }).stderr;
  if (typeof stderr !== "string") return false;
  return /\bEPUBLISHCONFLICT\b/u.test(stderr)
    || /cannot publish over (?:the )?previously published versions?/iu.test(stderr);
}

function npmEnvironment(
  home: string,
  userConfig: string,
  globalConfig: string
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || NPM_CREDENTIAL_VARIABLE.test(key)
      || GITHUB_CREDENTIAL_VARIABLE.test(key)
      || key.toLowerCase().startsWith("npm_config_")) {
      continue;
    }
    environment[key] = value;
  }
  return {
    ...environment,
    HOME: home,
    npm_config_globalconfig: globalConfig,
    npm_config_ignore_scripts: "true",
    npm_config_provenance: "true",
    npm_config_userconfig: userConfig
  };
}

function assertNoNpmCredentialEnvironment(environment: NodeJS.ProcessEnv): void {
  const variable = Object.keys(environment).find((key) => {
    return NPM_CREDENTIAL_VARIABLE.test(key) && environment[key] !== "";
  });
  if (variable !== undefined) {
    throw new Error(`npm publication refuses credential variable ${variable}`);
  }
}

function exactVersionUrl(registry: string, name: string, version: string): string {
  return new URL(`${encodeURIComponent(name)}/${encodeURIComponent(version)}`, registry).href;
}

function packageUrl(registry: string, name: string): string {
  return new URL(encodeURIComponent(name), registry).href;
}

function registryUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== ""
    || parsed.search !== "" || parsed.hash !== "") {
    throw new Error("npm registry must be a plain HTTPS origin");
  }
  return parsed.href.endsWith("/") ? parsed.href : `${parsed.href}/`;
}

async function boundedJsonResponse(response: Response, label: string): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json") throw new Error(`${label} is not JSON`);
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_REGISTRY_BYTES)) {
    throw new Error(`${label} exceeds the response bound`);
  }
  if (response.body === null) throw new Error(`${label} has no response body`);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > MAX_REGISTRY_BYTES) throw new Error(`${label} exceeds the response bound`);
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks, bytes);
  try {
    return parseJsonRejectingDuplicateKeys(
      new TextDecoder("utf-8", { fatal: true }).decode(body)
    );
  } catch (error) {
    throw new Error(`${label} has invalid JSON`, { cause: error });
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function positiveDuration(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 60 * 60_000) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}
