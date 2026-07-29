import { parseJsonRejectingDuplicateKeys } from "../shared/strict-json.js";

const DEFAULT_API_URL = "https://api.github.com/";
const DEFAULT_API_VERSION = "2022-11-28";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_ENDPOINT_BYTES = 16 * 1024;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BOUND = 8 * 1024 * 1024;
const MAX_TIMEOUT_MS = 2 * 60_000;
const MAX_TOKEN_BYTES = 64 * 1024;

export interface GitHubHttpTransportOptions {
  readonly token: string;
  readonly apiUrl?: string;
  readonly fetch?: typeof fetch;
  readonly requestSignal?: () => AbortSignal | undefined;
  readonly timeoutMs?: number;
  readonly maxResponseBytes: number;
  readonly userAgent: string;
}

export interface GitHubHttpRequest {
  readonly method: "DELETE" | "GET" | "PATCH" | "POST";
  readonly body?: string;
  readonly apiVersion?: string;
}

export class GitHubHttpTransport {
  readonly apiUrl: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #requestSignal: () => AbortSignal | undefined;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #userAgent: string;

  constructor(options: GitHubHttpTransportOptions) {
    if (options.token === "" || Buffer.byteLength(options.token) > MAX_TOKEN_BYTES
      || /[\r\n]/u.test(options.token)) {
      throw new Error("GitHub HTTP token is invalid");
    }
    this.apiUrl = githubApiUrl(options.apiUrl ?? DEFAULT_API_URL);
    this.#token = options.token;
    this.#fetch = options.fetch ?? fetch;
    this.#requestSignal = options.requestSignal ?? (() => undefined);
    this.#timeoutMs = positiveInteger(
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
      "GitHub HTTP timeout"
    );
    this.#maxResponseBytes = positiveInteger(
      options.maxResponseBytes,
      MAX_RESPONSE_BOUND,
      "GitHub HTTP response bound"
    );
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(options.userAgent)) {
      throw new Error("GitHub HTTP user agent is invalid");
    }
    this.#userAgent = options.userAgent;
  }

  async request(
    endpoint: string,
    request: GitHubHttpRequest,
    label: string
  ): Promise<Response> {
    const url = endpointUrl(endpoint, this.apiUrl);
    requireRequest(request);
    try {
      const external = this.#requestSignal();
      const timeout = AbortSignal.timeout(this.#timeoutMs);
      return await this.#fetch(url, {
        body: request.body,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${this.#token}`,
          "content-type": "application/json",
          "user-agent": this.#userAgent,
          "x-github-api-version": request.apiVersion ?? DEFAULT_API_VERSION
        },
        method: request.method,
        redirect: "error",
        signal: external === undefined
          ? timeout
          : AbortSignal.any([external, timeout])
      });
    } catch (error) {
      throw new Error(`${label} request did not settle`, { cause: error });
    }
  }

  async readJson(response: Response, label: string): Promise<unknown> {
    const type = response.headers.get("content-type");
    if (type === null
      || !/^application\/(?:[\w.+-]+\+)?json(?:;|$)/iu.test(type)) {
      throw new Error(`${label} has the wrong content type`);
    }
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^\d+$/u.test(declared)
      || !Number.isSafeInteger(Number(declared))
      || Number(declared) > this.#maxResponseBytes)) {
      throw new Error(`${label} exceeds the response bound`);
    }
    if (response.body === null) throw new Error(`${label} has no response body`);
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > this.#maxResponseBytes) {
          throw new Error(`${label} exceeds the response bound`);
        }
        chunks.push(chunk);
      }
      const text = new TextDecoder("utf-8", { fatal: true })
        .decode(Buffer.concat(chunks, bytes));
      return parseJsonRejectingDuplicateKeys(text);
    } catch (error) {
      if (error instanceof Error
        && error.message === `${label} exceeds the response bound`) {
        throw error;
      }
      throw new Error(`${label} has invalid JSON`, { cause: error });
    }
  }
}

function requireRequest(request: GitHubHttpRequest): void {
  if (!["DELETE", "GET", "PATCH", "POST"].includes(request.method)
    || (request.body !== undefined && (typeof request.body !== "string"
      || Buffer.byteLength(request.body) > MAX_REQUEST_BYTES))
    || (request.apiVersion !== undefined
      && !/^\d{4}-\d{2}-\d{2}$/u.test(request.apiVersion))) {
    throw new Error("GitHub HTTP request is invalid");
  }
}

function endpointUrl(endpoint: string, apiUrl: string): URL {
  if (endpoint === "" || Buffer.byteLength(endpoint) > MAX_ENDPOINT_BYTES
    || endpoint.startsWith("/") || endpoint.startsWith("\\")
    || endpoint.includes("\\") || endpoint.includes("#")
    || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(endpoint)) {
    throw new Error("GitHub HTTP endpoint is invalid");
  }
  const rawPath = endpoint.split("?", 1)[0]!;
  const segments = rawPath.split("/");
  for (const [index, segment] of segments.entries()) {
    if (segment === "" && index === segments.length - 1) continue;
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new Error("GitHub HTTP endpoint is invalid");
    }
    if (decoded === "" || decoded === "." || decoded === ".."
      || decoded.includes("/") || decoded.includes("\\")) {
      throw new Error("GitHub HTTP endpoint is invalid");
    }
  }
  const base = new URL(apiUrl);
  const value = new URL(endpoint, base);
  if (value.origin !== base.origin || !value.pathname.startsWith(base.pathname)
    || value.username !== "" || value.password !== "" || value.hash !== "") {
    throw new Error("GitHub HTTP endpoint is outside the API");
  }
  return value;
}

function githubApiUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username !== ""
    || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "") {
    throw new Error("GitHub HTTP API must use a plain HTTPS URL");
  }
  return parsed.href.endsWith("/") ? parsed.href : `${parsed.href}/`;
}

function positiveInteger(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}
