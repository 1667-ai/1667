import { canonicalJson } from "../server/canonical-json.js";
import { GitHubHttpTransport } from "./release-github-http.js";

const MAX_API_BYTES = 1024 * 1024;
const SHA = /^[0-9a-f]{40}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

export interface GitHubRef {
  readonly ref: string;
  readonly object: { readonly type: string; readonly sha: string };
}

export interface GitHubAnnotatedTag {
  readonly sha: string;
  readonly tag: string;
  readonly message: string;
  readonly object: { readonly type: string; readonly sha: string };
}

export interface GitHubRefStoreOptions {
  readonly repository: string;
  readonly token: string;
  readonly apiUrl?: string;
  readonly fetch?: typeof fetch;
  readonly requestSignal?: () => AbortSignal | undefined;
}

export class GitHubRefAlreadyExistsError extends Error {}

export class GitHubRefStore {
  readonly #repository: string;
  readonly #http: GitHubHttpTransport;

  constructor(
    options: GitHubRefStoreOptions,
    http?: GitHubHttpTransport
  ) {
    if (!REPOSITORY.test(options.repository)) {
      throw new Error("GitHub ref store repository is invalid");
    }
    if (options.token === "") throw new Error("GitHub ref store token is required");
    this.#repository = options.repository;
    this.#http = http ?? new GitHubHttpTransport({
      token: options.token,
      apiUrl: options.apiUrl,
      fetch: options.fetch,
      requestSignal: options.requestSignal,
      maxResponseBytes: MAX_API_BYTES,
      userAgent: "1667-release-github-ref-store"
    });
  }

  async matchingRefs(prefix: string): Promise<readonly GitHubRef[]> {
    const encoded = refPath(prefix);
    const response = await this.#request(
      `repos/${this.#repository}/git/matching-refs/${encoded}`,
      { method: "GET" }
    );
    if (response.status !== 200) {
      throw new Error(`GitHub ref store returned ${response.status} while reading refs`);
    }
    const value = await this.#http.readJson(response, "GitHub ref store refs");
    if (!Array.isArray(value)) throw new Error("GitHub ref store refs must be an array");
    return Object.freeze(value.map(gitReference));
  }

  async getRef(ref: string, label: string): Promise<GitHubRef | null> {
    const encoded = exactRefPath(ref);
    const response = await this.#request(
      `repos/${this.#repository}/git/ref/${encoded}`,
      { method: "GET" }
    );
    if (response.status === 404) return null;
    if (response.status !== 200) {
      throw new Error(`GitHub ref store returned ${response.status} while reading ${label}`);
    }
    const value = gitReference(await this.#http.readJson(response, `${label} ref`));
    if (value.ref !== ref) {
      throw new Error(`GitHub ref store returned the wrong ${label} ref`);
    }
    return value;
  }

  async createRef(
    ref: string,
    sha: string,
    type: "commit" | "tag",
    label: string
  ): Promise<void> {
    requireSha(sha, `${label} target`);
    const response = await this.#request(`repos/${this.#repository}/git/refs`, {
      body: canonicalJson({ ref, sha }),
      method: "POST"
    });
    if (response.status === 422) {
      throw new GitHubRefAlreadyExistsError(`${label} already exists`);
    }
    if (response.status !== 201) {
      throw new Error(`GitHub ref store returned ${response.status} while creating ${label}`);
    }
    const created = gitReference(
      await this.#http.readJson(response, `${label} ref`)
    );
    if (created.ref !== ref || created.object.type !== type
      || created.object.sha !== sha) {
      throw new Error(`GitHub ref store created the wrong ${label} ref`);
    }
  }

  async deleteRef(ref: string, label: string): Promise<void> {
    const encoded = exactRefPath(ref);
    const response = await this.#request(
      `repos/${this.#repository}/git/refs/${encoded}`,
      { method: "DELETE" }
    );
    if (response.status !== 204) {
      throw new Error(`GitHub ref store returned ${response.status} while deleting ${label}`);
    }
  }

  async createAnnotatedTag(
    tag: string,
    message: string,
    objectSha: string,
    label: string
  ): Promise<GitHubAnnotatedTag> {
    requireSha(objectSha, `${label} object`);
    const response = await this.#request(`repos/${this.#repository}/git/tags`, {
      body: canonicalJson({ message, object: objectSha, tag, type: "commit" }),
      method: "POST"
    });
    if (response.status !== 201) {
      throw new Error(
        `GitHub ref store returned ${response.status} while creating ${label} tag`
      );
    }
    const created = gitTag(await this.#http.readJson(response, `${label} tag`));
    requireTag(created, { tag, message, objectSha }, label);
    return created;
  }

  async getAnnotatedTag(sha: string, label: string): Promise<GitHubAnnotatedTag> {
    requireSha(sha, `${label} tag`);
    const response = await this.#request(
      `repos/${this.#repository}/git/tags/${sha}`,
      { method: "GET" }
    );
    if (response.status !== 200) {
      throw new Error(`GitHub ref store returned ${response.status} while reading ${label}`);
    }
    const tag = gitTag(await this.#http.readJson(response, `${label} tag`));
    if (tag.sha !== sha) throw new Error(`GitHub ref store returned the wrong ${label} tag`);
    return tag;
  }

  async #request(
    pathname: string,
    init: RequestInit,
    apiVersion = "2022-11-28"
  ): Promise<Response> {
    return this.#http.request(pathname, {
      body: typeof init.body === "string" ? init.body : undefined,
      method: requestMethod(init.method),
      apiVersion
    }, "GitHub ref store");
  }
}

function requireTag(
  actual: GitHubAnnotatedTag,
  expected: { tag: string; message: string; objectSha: string },
  label: string
): void {
  if (actual.tag !== expected.tag || actual.message !== expected.message
    || actual.object.type !== "commit"
    || actual.object.sha !== expected.objectSha) {
    throw new Error(`GitHub ref store created the wrong ${label} tag`);
  }
}

function gitReference(value: unknown): GitHubRef {
  const record = object(value, "GitHub ref store ref");
  const target = object(record.object, "GitHub ref store ref target");
  if (typeof record.ref !== "string" || typeof target.type !== "string"
    || typeof target.sha !== "string" || !SHA.test(target.sha)) {
    throw new Error("GitHub ref store returned a malformed ref");
  }
  return Object.freeze({
    ref: record.ref,
    object: Object.freeze({ type: target.type, sha: target.sha })
  });
}

function gitTag(value: unknown): GitHubAnnotatedTag {
  const record = object(value, "GitHub ref store tag");
  const target = object(record.object, "GitHub ref store tag target");
  if (typeof record.sha !== "string" || !SHA.test(record.sha)
    || typeof record.tag !== "string" || typeof record.message !== "string"
    || target.type !== "commit" || typeof target.sha !== "string"
    || !SHA.test(target.sha)) {
    throw new Error("GitHub ref store returned a malformed annotated tag");
  }
  return Object.freeze({
    sha: record.sha,
    tag: record.tag,
    message: record.message,
    object: Object.freeze({ type: "commit", sha: target.sha })
  });
}

function refPath(value: string): string {
  const trailingSlash = value.endsWith("/");
  const path = trailingSlash ? value.slice(0, -1) : value;
  if (path === "" || path.startsWith("/") || path.endsWith("/..")
    || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("GitHub ref store prefix is invalid");
  }
  const encoded = path.split("/").map((part) => encodeURIComponent(part)).join("/");
  return trailingSlash ? `${encoded}/` : encoded;
}

function exactRefPath(value: string): string {
  const prefix = "refs/";
  if (!value.startsWith(prefix)) {
    throw new Error("GitHub ref store ref is invalid");
  }
  return refPath(value.slice(prefix.length));
}

function requireSha(value: string, label: string): void {
  if (!SHA.test(value)) throw new Error(`GitHub ref store ${label} is invalid`);
}

function requestMethod(value: string | undefined): "DELETE" | "GET" | "POST" {
  if (value === "DELETE" || value === "GET" || value === "POST") return value;
  throw new Error("GitHub ref store request method is invalid");
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}
