/**
 * Marks a published GitHub release as the current release.
 *
 * The release workflow publishes every GitHub release with `--prerelease
 * --latest=false`, because publication puts the packages on the npm `next` tag
 * and promotion is a separate maintainer action. npm promotion moved the npm
 * dist-tags and nothing else, so a promoted release still showed as a
 * pre-release on GitHub and the repository named no current release at all.
 *
 * This step closes that gap. It runs after the npm dist-tags are verified, so
 * npm stays the authority for what a release channel contains.
 */
import { canonicalJson } from "../server/canonical-json.js";
import { GitHubHttpTransport } from "./release-github-http.js";
import { isSemVer } from "../shared/semver.js";

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const MAX_API_BYTES = 4 * 1024 * 1024;

export interface GitHubReleasePromotionOptions {
  readonly repository: string;
  readonly token: string;
  readonly version: string;
  readonly apiUrl?: string;
  readonly fetch?: typeof fetch;
  readonly requestSignal?: () => AbortSignal | undefined;
}

export interface GitHubReleasePromotionEvidence {
  readonly schemaVersion: 1;
  readonly tag: string;
  readonly releaseId: number;
  readonly prerelease: false;
  readonly latest: true;
}

interface PromotionRelease {
  readonly id: number;
  readonly tagName: string;
  readonly draft: boolean;
  readonly prerelease: boolean;
}

/**
 * Sets the release for `version` to a full release and to the current release.
 * Verifies both facts by reading GitHub again, so a silently ignored write
 * fails closed. Repeating the operation is safe.
 */
export async function promoteGitHubRelease(
  options: GitHubReleasePromotionOptions
): Promise<GitHubReleasePromotionEvidence> {
  if (!REPOSITORY.test(options.repository)) {
    throw new Error("GitHub promotion repository is invalid");
  }
  if (!isSemVer(options.version)) {
    throw new Error("GitHub promotion version is not SemVer");
  }
  const tag = `v${options.version}`;
  const client = new GitHubReleasePromotionClient(options);

  const before = await client.release(options.version);
  if (before === null) {
    throw new Error(`GitHub release ${tag} does not exist`);
  }
  if (before.draft) {
    throw new Error(`GitHub release ${tag} is a draft`);
  }
  if (before.tagName !== tag) {
    throw new Error(`GitHub release ${tag} names tag ${before.tagName}`);
  }

  const updated = await client.promote(before.id);
  if (updated.prerelease) {
    throw new Error(`GitHub release ${tag} is still a pre-release`);
  }

  // The current-release designation is repository state, not a field of the
  // release, so it is confirmed against the repository.
  const latest = await client.latestRelease();
  if (latest === null || latest.tagName !== tag) {
    throw new Error(
      `GitHub names ${latest === null ? "no release" : latest.tagName} as the current release, expected ${tag}`
    );
  }

  return Object.freeze({
    schemaVersion: 1 as const,
    tag,
    releaseId: before.id,
    prerelease: false as const,
    latest: true as const
  });
}

class GitHubReleasePromotionClient {
  readonly #repository: string;
  readonly #http: GitHubHttpTransport;

  constructor(options: GitHubReleasePromotionOptions) {
    this.#repository = options.repository;
    this.#http = new GitHubHttpTransport({
      token: options.token,
      apiUrl: options.apiUrl,
      fetch: options.fetch,
      requestSignal: options.requestSignal,
      maxResponseBytes: MAX_API_BYTES,
      userAgent: "1667-release-github-promotion"
    });
  }

  async release(version: string): Promise<PromotionRelease | null> {
    const response = await this.#request(
      `repos/${this.#repository}/releases/tags/v${encodeURIComponent(version)}`,
      "GET"
    );
    if (response.status === 404) return null;
    if (response.status !== 200) {
      throw new Error(`GitHub promotion release lookup returned ${response.status}`);
    }
    return promotionRelease(await this.#http.readJson(response, "GitHub promotion release"));
  }

  async latestRelease(): Promise<PromotionRelease | null> {
    const response = await this.#request(
      `repos/${this.#repository}/releases/latest`,
      "GET"
    );
    if (response.status === 404) return null;
    if (response.status !== 200) {
      throw new Error(`GitHub promotion current release lookup returned ${response.status}`);
    }
    return promotionRelease(
      await this.#http.readJson(response, "GitHub promotion current release")
    );
  }

  async promote(releaseId: number): Promise<PromotionRelease> {
    const response = await this.#request(
      `repos/${this.#repository}/releases/${releaseId}`,
      "PATCH",
      // GitHub takes make_latest as a string, not a boolean.
      canonicalJson({ make_latest: "true", prerelease: false })
    );
    if (response.status !== 200) {
      throw new Error(`GitHub promotion update returned ${response.status}`);
    }
    return promotionRelease(await this.#http.readJson(response, "GitHub promotion update"));
  }

  async #request(pathname: string, method: "GET" | "PATCH", body?: string): Promise<Response> {
    return this.#http.request(pathname, { body, method }, "GitHub promotion");
  }
}

function promotionRelease(value: unknown): PromotionRelease {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("GitHub promotion release must be an object");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "number" || !Number.isSafeInteger(record.id) || record.id <= 0) {
    throw new Error("GitHub promotion release id is invalid");
  }
  if (typeof record.tag_name !== "string" || record.tag_name === "") {
    throw new Error("GitHub promotion release tag is invalid");
  }
  if (typeof record.draft !== "boolean" || typeof record.prerelease !== "boolean") {
    throw new Error("GitHub promotion release state is invalid");
  }
  return Object.freeze({
    id: record.id,
    tagName: record.tag_name,
    draft: record.draft,
    prerelease: record.prerelease
  });
}
