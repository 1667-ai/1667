import { isSemVer } from "../shared/semver.js";
import { GitHubRefStore } from "./release-github-ref-store.js";
import {
  NpmOperationRefNotYetVisibleError,
  type NpmOperationLeaseRequest
} from "./release-npm-operation-lease-state.js";

const COMMIT = /^[0-9a-f]{40}$/u;
const ATTEMPT =
  /^_attempt_(launcher|darwin-arm64|darwin-x64|linux-arm64|linux-x64)_[0-9a-f]{64}$/u;

export interface NpmOperationAuthorizationRequest {
  readonly operation: "promotion" | "quarantine";
  readonly version: string;
  readonly sourceCommit: string;
}

export interface NpmOperationAuthorizationRef {
  readonly ref: string;
  readonly object: {
    readonly type: string;
    readonly sha: string;
  };
}

export async function authorizeNpmOperationRelease(
  store: GitHubRefStore,
  request: NpmOperationLeaseRequest
): Promise<void> {
  requireNpmOperationReleaseAuthorization(
    request,
    await store.matchingRefs(`tags/released/v${request.version}`)
  );
}

export async function authorizeNpmOperationClaim(
  store: GitHubRefStore,
  request: NpmOperationLeaseRequest
): Promise<void> {
  requireNpmOperationClaimAuthorization(
    request,
    await store.matchingRefs(`tags/released/v${request.version}`)
  );
}

export function requireNpmOperationReleaseAuthorization(
  request: NpmOperationAuthorizationRequest,
  refs: readonly NpmOperationAuthorizationRef[]
): void {
  const state = operationAuthorizationState(request, refs);
  if (request.operation === "promotion") {
    requirePromotionAuthorization(request.version, state);
  } else if (!state.quarantined) {
    throw new NpmOperationRefNotYetVisibleError(
      `Release ${request.version} has no quarantine marker`
    );
  }
}

export function requireNpmOperationClaimAuthorization(
  request: NpmOperationAuthorizationRequest,
  refs: readonly NpmOperationAuthorizationRef[]
): void {
  const state = operationAuthorizationState(request, refs);
  if (request.operation === "promotion") {
    requirePromotionAuthorization(request.version, state);
  }
}

function operationAuthorizationState(
  request: NpmOperationAuthorizationRequest,
  refs: readonly NpmOperationAuthorizationRef[]
): { readonly completed: boolean; readonly quarantined: boolean } {
  if ((request.operation !== "promotion" && request.operation !== "quarantine")
    || !isSemVer(request.version) || !COMMIT.test(request.sourceCommit)) {
    throw new Error("npm operation release authorization request is invalid");
  }
  const base = `refs/tags/released/v${request.version}`;
  let completed = false;
  let quarantined = false;
  const seen = new Set<string>();
  for (const entry of refs) {
    if (seen.has(entry.ref)) {
      throw new Error("npm operation release authorization repeats a ref");
    }
    seen.add(entry.ref);
    if (entry.object.type !== "commit" || !COMMIT.test(entry.object.sha)) {
      throw new Error(
        `npm operation release authorization ref ${entry.ref} is not a commit`
      );
    }
    if (entry.ref !== base && !entry.ref.startsWith(`${base}_`)) {
      if (isReleaseRef(entry.ref)) continue;
      throw new Error(`npm operation release authorization ref ${entry.ref} is malformed`);
    }
    if (entry.object.sha !== request.sourceCommit) {
      throw new Error(
        `npm operation release authorization ref ${entry.ref}`
        + " targets a different source commit"
      );
    }
    const suffix = entry.ref.slice(base.length);
    if (suffix === "") completed = true;
    else if (suffix === "_quarantined") quarantined = true;
    else if (!ATTEMPT.test(suffix)) {
      throw new Error(`npm operation release authorization ref ${entry.ref} is malformed`);
    }
  }
  return Object.freeze({ completed, quarantined });
}

function requirePromotionAuthorization(
  version: string,
  state: { readonly completed: boolean; readonly quarantined: boolean }
): void {
  if (!state.completed) throw new Error(`Release ${version} is not complete`);
  if (state.quarantined) throw new Error(`Release ${version} is quarantined`);
}

function isReleaseRef(ref: string): boolean {
  const prefix = "refs/tags/released/v";
  if (!ref.startsWith(prefix)) return false;
  const suffix = ref.slice(prefix.length);
  if (validSemVer(suffix)) return true;
  if (suffix.endsWith("_quarantined")) {
    return validSemVer(suffix.slice(0, -"_quarantined".length));
  }
  const separator = suffix.indexOf("_attempt_");
  return separator > 0
    && validSemVer(suffix.slice(0, separator))
    && ATTEMPT.test(suffix.slice(separator));
}

function validSemVer(value: string): boolean {
  return isSemVer(value as unknown);
}
