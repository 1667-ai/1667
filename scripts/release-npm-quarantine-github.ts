import { createHash } from "node:crypto";
import { canonicalJson } from "../server/canonical-json.js";
import { isSemVer } from "../shared/semver.js";
import { GitHubHttpTransport } from "./release-github-http.js";
import {
  validateNpmQuarantineRequest,
  type NpmQuarantineRequest
} from "./release-npm-operations.js";
import { GitHubRefStore } from "./release-github-ref-store.js";

const MAX_API_BYTES = 2 * 1024 * 1024;
const MAX_NOTES_BYTES = 128 * 1024;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

export interface GitHubQuarantineAnnotationOptions {
  readonly repository: string;
  readonly token: string;
  readonly version: string;
  readonly sourceCommit: string;
  readonly quarantine: NpmQuarantineRequest;
  readonly apiUrl?: string;
  readonly fetch?: typeof fetch;
  readonly requestSignal?: () => AbortSignal | undefined;
}

interface GitHubQuarantineEvidenceBase {
  readonly schemaVersion: 1;
  readonly tag: string;
  readonly incidentReference: string;
  readonly supersedingVersion: string;
}

export type GitHubQuarantineAnnotationEvidence =
  | GitHubQuarantineEvidenceBase & {
    readonly notice: "release-notes";
    readonly releaseId: number;
    readonly notesSha256: string;
    readonly assetsSha256: string;
  }
  | GitHubQuarantineEvidenceBase & {
    readonly notice: "release-absent";
    readonly releaseId: null;
    readonly quarantineRef: string;
    readonly sourceCommit: string;
    readonly notesSha256: null;
    readonly assetsSha256: null;
  };

export async function annotateQuarantinedGitHubRelease(
  options: GitHubQuarantineAnnotationOptions
): Promise<GitHubQuarantineAnnotationEvidence> {
  if (!REPOSITORY.test(options.repository)) {
    throw new Error("GitHub quarantine repository is invalid");
  }
  if (options.token === "") throw new Error("GitHub quarantine token is required");
  if (!isSemVer(options.version)) {
    throw new Error("GitHub quarantine version is not SemVer");
  }
  if (!/^[0-9a-f]{40}$/u.test(options.sourceCommit)) {
    throw new Error("GitHub quarantine source commit is invalid");
  }
  const quarantine = validateNpmQuarantineRequest(
    options.version,
    options.quarantine
  );
  const client = new GitHubReleaseNotesClient(options);
  const before = await client.release(options.version);
  if (before === null) {
    const quarantineRef = `refs/tags/released/v${options.version}_quarantined`;
    const refs = (await new GitHubRefStore(options).matchingRefs(
      `tags/released/v${options.version}_quarantined`
    )).filter((ref) => ref.ref === quarantineRef);
    if (refs.length !== 1 || refs[0]!.object.type !== "commit"
      || refs[0]!.object.sha !== options.sourceCommit) {
      throw new Error("GitHub quarantine ref does not authorize an absent release");
    }
    if (await client.release(options.version) !== null) {
      throw new Error("GitHub quarantine release appeared during absence verification");
    }
    return Object.freeze({
      schemaVersion: 1 as const,
      notice: "release-absent" as const,
      releaseId: null,
      tag: `v${options.version}`,
      incidentReference: quarantine.incidentReference,
      supersedingVersion: quarantine.supersedingVersion,
      quarantineRef,
      sourceCommit: options.sourceCommit,
      notesSha256: null,
      assetsSha256: null
    });
  }
  requireQuarantineRelease(before, options.version);
  const identity = releaseIdentity(before);
  const expectedBody = quarantinedBody(
    before.body,
    options.version,
    quarantine
  );
  if (before.body !== expectedBody) {
    // GitHub does not document a conditional release update. The operation
    // lease is the sole writer. This read detects a change before the write.
    const current = await client.release(options.version);
    if (current === null) {
      throw new Error("GitHub quarantine release disappeared before the notes update");
    }
    requireSameRelease(identity, current);
    if (current.body !== before.body) {
      throw new Error("GitHub quarantine release changed before the notes update");
    }
    const patched = await client.updateNotes(
      before.id,
      expectedBody
    );
    requireSameRelease(identity, patched);
    if (patched.body !== expectedBody) {
      throw new Error("GitHub quarantine notes update returned the wrong notes");
    }
  }
  const verified = await client.release(options.version);
  if (verified === null) {
    throw new Error("GitHub quarantine release disappeared after the notes update");
  }
  requireSameRelease(identity, verified);
  if (verified.body !== expectedBody) {
    throw new Error("GitHub quarantine notes were not retained");
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    notice: "release-notes" as const,
    releaseId: verified.id,
    tag: verified.tagName,
    incidentReference: quarantine.incidentReference,
    supersedingVersion: quarantine.supersedingVersion,
    notesSha256: sha256(verified.body),
    assetsSha256: sha256(canonicalJson(verified.assets))
  });
}

interface ReleaseAsset {
  readonly id: number;
  readonly name: string;
  readonly label: string | null;
  readonly state: "uploaded";
  readonly contentType: string;
  readonly size: number;
  readonly digest: string | null;
}

interface GitHubRelease {
  readonly id: number;
  readonly tagName: string;
  readonly targetCommitish: string;
  readonly name: string | null;
  readonly body: string;
  readonly draft: boolean;
  readonly prerelease: boolean;
  readonly immutable: boolean;
  readonly assets: readonly ReleaseAsset[];
}

class GitHubReleaseNotesClient {
  readonly #repository: string;
  readonly #http: GitHubHttpTransport;

  constructor(options: GitHubQuarantineAnnotationOptions) {
    this.#repository = options.repository;
    this.#http = new GitHubHttpTransport({
      token: options.token,
      apiUrl: options.apiUrl,
      fetch: options.fetch,
      requestSignal: options.requestSignal,
      maxResponseBytes: MAX_API_BYTES,
      userAgent: "1667-release-npm-quarantine"
    });
  }

  async release(version: string): Promise<GitHubRelease | null> {
    const response = await this.#request(
      `repos/${this.#repository}/releases/tags/v${encodeURIComponent(version)}`,
      { method: "GET" }
    );
    if (response.status === 404) return null;
    if (response.status !== 200) {
      throw new Error(`GitHub quarantine release lookup returned ${response.status}`);
    }
    return githubRelease(
      await this.#http.readJson(response, "GitHub quarantine release")
    );
  }

  async updateNotes(
    releaseId: number,
    body: string
  ): Promise<GitHubRelease> {
    const response = await this.#request(
      `repos/${this.#repository}/releases/${releaseId}`,
      {
        body: canonicalJson({ body }),
        method: "PATCH"
      }
    );
    if (response.status !== 200) {
      throw new Error(`GitHub quarantine notes update returned ${response.status}`);
    }
    return githubRelease(
      await this.#http.readJson(response, "GitHub quarantine notes update")
    );
  }

  async #request(pathname: string, init: RequestInit): Promise<Response> {
    return this.#http.request(pathname, {
      body: typeof init.body === "string" ? init.body : undefined,
      method: init.method === "PATCH" ? "PATCH" : "GET"
    }, "GitHub quarantine");
  }
}

function requireQuarantineRelease(release: GitHubRelease, version: string): void {
  if (release.tagName !== `v${version}` || release.draft
    || !release.prerelease || !release.immutable) {
    throw new Error("GitHub quarantine target is not the immutable prerelease");
  }
}

function quarantinedBody(
  body: string,
  version: string,
  quarantine: NpmQuarantineRequest
): string {
  const markerPrefix = "<!-- 1667-quarantine:";
  const marker = `${markerPrefix}v1:${version} -->`;
  const annotation = [
    marker,
    "## Quarantine notice",
    "",
    "This release is quarantined.",
    "Do not use this release.",
    `Use version \`v${quarantine.supersedingVersion}\`.`,
    `Incident: ${quarantine.incidentReference}`,
    "",
    "Published package versions can remain available by exact version."
  ].join("\n");
  if (body.includes(markerPrefix)) {
    const suffix = `\n\n${annotation}`;
    if (body === annotation || body.endsWith(suffix)) return body;
    throw new Error("GitHub release has a different quarantine notice");
  }
  if (Buffer.byteLength(body) > MAX_NOTES_BYTES - Buffer.byteLength(annotation) - 2) {
    throw new Error("GitHub release notes exceed the quarantine update bound");
  }
  return body === "" ? annotation : `${body}\n\n${annotation}`;
}

function releaseIdentity(release: GitHubRelease): string {
  return canonicalJson({
    id: release.id,
    tagName: release.tagName,
    targetCommitish: release.targetCommitish,
    name: release.name,
    draft: release.draft,
    prerelease: release.prerelease,
    immutable: release.immutable,
    assets: release.assets
  });
}

function requireSameRelease(identity: string, release: GitHubRelease): void {
  if (releaseIdentity(release) !== identity) {
    throw new Error("GitHub quarantine update changed immutable release identity");
  }
}

function githubRelease(value: unknown): GitHubRelease {
  const record = object(value, "GitHub quarantine release");
  const assets = Array.isArray(record.assets)
    ? record.assets.map(releaseAsset)
    : invalid("GitHub quarantine release assets are invalid");
  if (!Number.isSafeInteger(record.id) || Number(record.id) < 1
    || typeof record.tag_name !== "string"
    || typeof record.target_commitish !== "string"
    || (record.name !== null && typeof record.name !== "string")
    || (record.body !== null && typeof record.body !== "string")
    || typeof record.draft !== "boolean"
    || typeof record.prerelease !== "boolean"
    || typeof record.immutable !== "boolean") {
    throw new Error("GitHub quarantine release is invalid");
  }
  if (new Set(assets.map((asset) => asset.name)).size !== assets.length
    || new Set(assets.map((asset) => asset.id)).size !== assets.length) {
    throw new Error("GitHub quarantine release repeats an asset");
  }
  return Object.freeze({
    id: Number(record.id),
    tagName: record.tag_name,
    targetCommitish: record.target_commitish,
    name: record.name,
    body: record.body ?? "",
    draft: record.draft,
    prerelease: record.prerelease,
    immutable: record.immutable,
    assets: Object.freeze(assets)
  });
}

function releaseAsset(value: unknown): ReleaseAsset {
  const record = object(value, "GitHub quarantine release asset");
  if (!Number.isSafeInteger(record.id) || Number(record.id) < 1
    || typeof record.name !== "string" || record.name === ""
    || (record.label !== null && typeof record.label !== "string")
    || record.state !== "uploaded" || typeof record.content_type !== "string"
    || !Number.isSafeInteger(record.size) || Number(record.size) < 0
    || (record.digest !== null && typeof record.digest !== "string")) {
    throw new Error("GitHub quarantine release asset is invalid");
  }
  return Object.freeze({
    id: Number(record.id),
    name: record.name,
    label: record.label,
    state: "uploaded" as const,
    contentType: record.content_type,
    size: Number(record.size),
    digest: record.digest
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function invalid(message: string): never {
  throw new Error(message);
}
