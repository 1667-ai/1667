import { canonicalJson } from "../server/canonical-json.js";
import { isSemVer } from "../shared/semver.js";
import {
  PUBLISHED_ARTIFACT_TARGETS
} from "../shared/release-targets.js";
import { parseJsonRejectingDuplicateKeys } from "../shared/strict-json.js";
import {
  type NpmPublicationLedger,
  type NpmPublicationPackage
} from "./release-npm-publisher.js";

const COMMIT = /^[0-9a-f]{40}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const API_TIMEOUT_MS = 30_000;
const MAX_API_BYTES = 1024 * 1024;
const TARGETS = new Set(["launcher", ...PUBLISHED_ARTIFACT_TARGETS]);

export interface GitHubNpmPublicationLedgerOptions {
  readonly repository: string;
  readonly sourceCommit: string;
  readonly token: string;
  readonly apiUrl?: string;
  readonly fetch?: typeof fetch;
}

export interface GitReference {
  readonly ref: string;
  readonly object: {
    readonly type: string;
    readonly sha: string;
  };
}

/**
 * Immutable release refs record an attempted npm write before the write starts.
 * A retry first waits for the original write to become visible. If the bounded
 * wait expires, it retries the same immutable version. npm refuses replacement.
 */
export class GitHubNpmPublicationLedger implements NpmPublicationLedger {
  readonly #repository: string;
  readonly #sourceCommit: string;
  readonly #token: string;
  readonly #apiUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: GitHubNpmPublicationLedgerOptions) {
    if (!REPOSITORY.test(options.repository)) {
      throw new Error("Publication ledger repository is invalid");
    }
    if (!COMMIT.test(options.sourceCommit)) {
      throw new Error("Publication ledger commit is not canonical");
    }
    if (options.token === "") throw new Error("Publication ledger token is required");
    this.#repository = options.repository;
    this.#sourceCommit = options.sourceCommit;
    this.#token = options.token;
    this.#apiUrl = githubApiUrl(options.apiUrl ?? "https://api.github.com/");
    this.#fetch = options.fetch ?? fetch;
  }

  async status(
    packageToPublish: NpmPublicationPackage
  ): Promise<"fresh" | "attempted"> {
    const refs = await this.#refs(packageToPublish.version);
    return publicationStatus(refs, packageToPublish, this.#sourceCommit);
  }

  async recordAttempt(
    packageToPublish: NpmPublicationPackage
  ): Promise<"created" | "attempted"> {
    if (await this.status(packageToPublish) === "attempted") return "attempted";
    const ref = attemptRef(packageToPublish);
    const response = await this.#request(
      `repos/${this.#repository}/git/refs`,
      {
        body: canonicalJson({ ref, sha: this.#sourceCommit }),
        method: "POST"
      }
    );
    if (response.status === 422) {
      if (await this.status(packageToPublish) === "attempted") return "attempted";
      throw new Error(`Publication ledger refused attempt ref for ${packageToPublish.name}`);
    }
    if (response.status !== 201) {
      throw new Error(
        `Publication ledger returned ${response.status} while recording`
        + ` ${packageToPublish.name}`
      );
    }
    const created = gitReference(
      await boundedJsonResponse(response, "Publication attempt ref")
    );
    if (created.ref !== ref || created.object.type !== "commit"
      || created.object.sha !== this.#sourceCommit) {
      throw new Error(`Publication ledger created the wrong ref for ${packageToPublish.name}`);
    }
    return "created";
  }

  async #refs(version: string): Promise<readonly GitReference[]> {
    requirePackageVersion(version);
    const response = await this.#request(
      `repos/${this.#repository}/git/matching-refs/tags/released/v${version}`,
      { method: "GET" }
    );
    if (response.status !== 200) {
      throw new Error(`Publication ledger returned ${response.status} while reading release refs`);
    }
    const value = await boundedJsonResponse(response, "Publication ledger refs");
    if (!Array.isArray(value)) throw new Error("Publication ledger refs must be an array");
    return Object.freeze(value.map(gitReference));
  }

  async #request(pathname: string, init: RequestInit): Promise<Response> {
    try {
      return await this.#fetch(new URL(pathname, this.#apiUrl), {
        ...init,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${this.#token}`,
          "content-type": "application/json",
          "user-agent": "1667-release-npm",
          "x-github-api-version": "2022-11-28"
        },
        redirect: "error",
        signal: AbortSignal.timeout(API_TIMEOUT_MS)
      });
    } catch (error) {
      throw new Error("Publication ledger request did not settle", { cause: error });
    }
  }
}

export function publicationStatus(
  refs: readonly GitReference[],
  packageToPublish: NpmPublicationPackage,
  sourceCommit: string
): "fresh" | "attempted" {
  requirePackageVersion(packageToPublish.version);
  if (!TARGETS.has(packageToPublish.artifactTarget) || !DIGEST.test(packageToPublish.sha256)) {
    throw new Error("Publication ledger package identity is invalid");
  }
  if (!COMMIT.test(sourceCommit)) {
    throw new Error("Publication ledger commit is not canonical");
  }
  const prefix = `refs/tags/released/v${packageToPublish.version}`;
  let attempted = false;
  for (const entry of refs) {
    if (entry.ref === `${prefix}_quarantined`) {
      throw new Error(`Release ${packageToPublish.version} is quarantined`);
    }
    if (!entry.ref.startsWith(`${prefix}_attempt_`)) continue;
    if (entry.object.type !== "commit" || !COMMIT.test(entry.object.sha)) {
      throw new Error(`Publication ledger ref ${entry.ref} does not target a commit`);
    }
    const suffix = entry.ref.slice(`${prefix}_attempt_`.length);
    const separator = suffix.lastIndexOf("_");
    const target = suffix.slice(0, separator);
    const digest = suffix.slice(separator + 1);
    if (separator <= 0 || !TARGETS.has(target) || !DIGEST.test(digest)) {
      throw new Error(`Publication ledger ref ${entry.ref} is malformed`);
    }
    if (target !== packageToPublish.artifactTarget) continue;
    if (digest !== packageToPublish.sha256 || entry.object.sha !== sourceCommit) {
      throw new Error(
        `Publication ledger has a different attempt for ${packageToPublish.name}`
      );
    }
    if (attempted) {
      throw new Error(`Publication ledger repeats an attempt for ${packageToPublish.name}`);
    }
    attempted = true;
  }
  return attempted ? "attempted" : "fresh";
}

function attemptRef(packageToPublish: NpmPublicationPackage): string {
  return `refs/tags/released/v${packageToPublish.version}`
    + `_attempt_${packageToPublish.artifactTarget}_${packageToPublish.sha256}`;
}

function requirePackageVersion(version: string): void {
  if (!isSemVer(version)) throw new Error("Publication ledger version is not SemVer");
}

function gitReference(value: unknown): GitReference {
  const record = object(value, "Publication ledger ref");
  const target = object(record.object, "Publication ledger target");
  if (typeof record.ref !== "string" || typeof target.type !== "string"
    || typeof target.sha !== "string") {
    throw new Error("Publication ledger returned a malformed ref");
  }
  return Object.freeze({
    ref: record.ref,
    object: Object.freeze({ type: target.type, sha: target.sha })
  });
}

function githubApiUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== ""
    || parsed.search !== "" || parsed.hash !== "") {
    throw new Error("GitHub API must use a plain HTTPS URL");
  }
  return parsed.href.endsWith("/") ? parsed.href : `${parsed.href}/`;
}

async function boundedJsonResponse(response: Response, label: string): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared)
    || Number(declared) > MAX_API_BYTES)) {
    throw new Error(`${label} exceeds the response bound`);
  }
  if (response.body === null) throw new Error(`${label} has no response body`);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > MAX_API_BYTES) throw new Error(`${label} exceeds the response bound`);
    chunks.push(chunk);
  }
  try {
    return parseJsonRejectingDuplicateKeys(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes))
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
