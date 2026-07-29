import {
  GitHubRefAlreadyExistsError,
  GitHubRefStore
} from "./release-github-ref-store.js";

export async function createOrVerifyNpmOperationRef(
  store: GitHubRefStore,
  ref: string,
  sha: string,
  type: "commit" | "tag",
  label: string,
  verify: () => Promise<void>
): Promise<void> {
  try {
    await store.createRef(ref, sha, type, label);
  } catch (error) {
    try {
      await verify();
      return;
    } catch (verificationError) {
      if (error instanceof GitHubRefAlreadyExistsError) {
        throw verificationError;
      }
      throw error;
    }
  }
  await verify();
}
