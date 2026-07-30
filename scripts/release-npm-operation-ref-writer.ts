import { setTimeout as wait } from "node:timers/promises";
import {
  GitHubRefAlreadyExistsError,
  GitHubRefStore
} from "./release-github-ref-store.js";
import {
  NpmOperationRefNotYetVisibleError
} from "./release-npm-operation-lease-state.js";

const VERIFY_MAX_ATTEMPTS = 21;
const VERIFY_DELAY_MS = 250;

export interface CreateNpmOperationRefOptions {
  readonly signal?: AbortSignal;
}

export async function createOrVerifyNpmOperationRef(
  store: GitHubRefStore,
  ref: string,
  sha: string,
  type: "commit" | "tag",
  label: string,
  verify: () => Promise<void>,
  options?: CreateNpmOperationRefOptions
): Promise<void> {
  async function verifyWithRetry(): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= VERIFY_MAX_ATTEMPTS; attempt += 1) {
      options?.signal?.throwIfAborted();
      try {
        await verify();
        return;
      } catch (error) {
        if (!(error instanceof NpmOperationRefNotYetVisibleError)) {
          throw error;
        }
        lastError = error;
        if (attempt < VERIFY_MAX_ATTEMPTS) {
          await waitForRetry(options?.signal);
        }
      }
    }
    throw lastError;
  }

  try {
    await store.createRef(ref, sha, type, label);
  } catch (error) {
    try {
      await verifyWithRetry();
      return;
    } catch (verificationError) {
      if (error instanceof GitHubRefAlreadyExistsError) {
        throw verificationError;
      }
      throw error;
    }
  }
  await verifyWithRetry();
}

async function waitForRetry(signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) {
    await wait(VERIFY_DELAY_MS);
    return;
  }
  await wait(VERIFY_DELAY_MS, undefined, { signal });
}
