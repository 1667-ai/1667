import { isSemVer } from "../shared/semver.js";
import {
  PUBLISHED_ARTIFACT_TARGETS
} from "../shared/release-targets.js";
import {
  type NpmPublicationLedger,
  type NpmPublicationPackage
} from "./release-npm-publisher.js";
import {
  GitHubRefAlreadyExistsError,
  GitHubRefStore,
  type GitHubRef
} from "./release-github-ref-store.js";

const COMMIT = /^[0-9a-f]{40}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const TARGETS = new Set(["launcher", ...PUBLISHED_ARTIFACT_TARGETS]);

export interface GitHubNpmPublicationLedgerOptions {
  readonly repository: string;
  readonly sourceCommit: string;
  readonly token: string;
  readonly apiUrl?: string;
  readonly fetch?: typeof fetch;
}

export type GitReference = GitHubRef;

/**
 * Immutable release refs record an attempted npm write before the write starts.
 * A retry first waits for the original write to become visible. If the bounded
 * wait expires, it retries the same immutable version. npm refuses replacement.
 */
export class GitHubNpmPublicationLedger implements NpmPublicationLedger {
  readonly #repository: string;
  readonly #sourceCommit: string;
  readonly #store: GitHubRefStore;

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
    this.#store = new GitHubRefStore(options);
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
    try {
      await this.#store.createRef(
        ref,
        this.#sourceCommit,
        "commit",
        `publication attempt for ${packageToPublish.name}`
      );
    } catch (error) {
      if (!(error instanceof GitHubRefAlreadyExistsError)) throw error;
      if (await this.status(packageToPublish) === "attempted") return "attempted";
      throw new Error(`Publication ledger refused attempt ref for ${packageToPublish.name}`);
    }
    return "created";
  }

  async #refs(version: string): Promise<readonly GitReference[]> {
    requirePackageVersion(version);
    return this.#store.matchingRefs(`tags/released/v${version}`);
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
