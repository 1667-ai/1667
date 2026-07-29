import { isSemVer } from "../shared/semver.js";
import {
  npmReleaseOperationPackageOrder,
  type NpmTagRegistry
} from "./release-npm-operations.js";
import {
  GitHubRefStore,
  type GitHubRef
} from "./release-github-ref-store.js";
import {
  PublicNpmTagRegistry
} from "./release-npm-tag-registry.js";

export interface NpmSupersedingReleaseRefStore {
  matchingRefs(prefix: string): Promise<readonly GitHubRef[]>;
}

export interface NpmSupersedingReleaseProofOptions {
  readonly repository: string;
  readonly token: string;
  readonly version: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly refs?: NpmSupersedingReleaseRefStore;
  readonly registry?: NpmTagRegistry;
}

export interface NpmSupersedingReleaseVerifier {
  verify(version: string): Promise<void>;
}

export class PublicNpmSupersedingReleaseVerifier
implements NpmSupersedingReleaseVerifier {
  readonly #refs: NpmSupersedingReleaseRefStore;
  readonly #registry: NpmTagRegistry;

  constructor(options: {
    readonly repository: string;
    readonly token: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly refs?: NpmSupersedingReleaseRefStore;
    readonly registry?: NpmTagRegistry;
  }) {
    this.#refs = options.refs ?? new GitHubRefStore({
      repository: options.repository,
      token: options.token
    });
    this.#registry = options.registry ?? new PublicNpmTagRegistry({
      environment: options.environment ?? process.env,
      authorizeWrite: async () => {
        throw new Error("npm superseding release proof cannot authorize a write");
      }
    });
  }

  async verify(version: string): Promise<void> {
    await verifyNpmSupersedingRelease(version, this.#refs, this.#registry);
  }
}

export async function proveNpmSupersedingRelease(
  options: NpmSupersedingReleaseProofOptions
): Promise<void> {
  const verifier = new PublicNpmSupersedingReleaseVerifier(options);
  await verifier.verify(options.version);
}

async function verifyNpmSupersedingRelease(
  version: string,
  refs: NpmSupersedingReleaseRefStore,
  registry: NpmTagRegistry
): Promise<void> {
  if (!isSemVer(version)) {
    throw new Error("npm superseding release version is not SemVer");
  }
  const prefix = `refs/tags/released/v${version}`;
  const releaseRefs = await refs.matchingRefs(`tags/released/v${version}`);
  requireSupersedingReleaseRefs(version, prefix, releaseRefs);
  for (const name of npmReleaseOperationPackageOrder("quarantine")) {
    const state = await registry.inspect(name, version);
    if (state.name !== name || state.version !== version) {
      throw new Error(`npm superseding release proof returned the wrong package`);
    }
    if (!state.present) {
      throw new Error(`Superseding release does not contain ${name}@${version}`);
    }
    if (state.deprecated !== null) {
      throw new Error(`Superseding release ${name}@${version} is deprecated`);
    }
  }
  requireSupersedingReleaseRefs(
    version,
    prefix,
    await refs.matchingRefs(`tags/released/v${version}`)
  );
}

function requireSupersedingReleaseRefs(
  version: string,
  prefix: string,
  releaseRefs: readonly GitHubRef[]
): void {
  const completion = releaseRefs.find((entry) => entry.ref === prefix);
  if (completion?.object.type !== "commit") {
    throw new Error(`Superseding release ${version} is not complete`);
  }
  if (releaseRefs.some((entry) => entry.ref === `${prefix}_quarantined`)) {
    throw new Error(`Superseding release ${version} is quarantined`);
  }
}
