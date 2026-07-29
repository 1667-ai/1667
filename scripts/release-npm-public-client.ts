import { parseJsonRejectingDuplicateKeys } from "../shared/strict-json.js";
import { NpmRegistryPendingError } from "./release-npm-provenance.js";

export const NPM_PUBLIC_REGISTRY = "https://registry.npmjs.org/" as const;

const MAX_REGISTRY_BYTES = 1024 * 1024;
const REGISTRY_REQUEST_TIMEOUT_MS = 30_000;

export interface NpmPublicClientOptions {
  readonly registry?: string;
  readonly fetch?: typeof fetch;
  readonly requestTimeoutMs?: number;
}

export class NpmPublicClient {
  readonly registry: string;
  readonly #fetch: typeof fetch;
  readonly #requestTimeoutMs: number;

  constructor(options: NpmPublicClientOptions = {}) {
    this.registry = registryUrl(options.registry ?? NPM_PUBLIC_REGISTRY);
    this.#fetch = options.fetch ?? fetch;
    this.#requestTimeoutMs = positiveDuration(
      options.requestTimeoutMs ?? REGISTRY_REQUEST_TIMEOUT_MS,
      "npm registry request timeout"
    );
  }

  async read(
    name: string,
    version: string | null,
    label: string
  ): Promise<unknown | null> {
    let response: Response;
    try {
      response = await this.#fetch(metadataUrl(this.registry, name, version), {
        headers: { accept: "application/json" },
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(this.#requestTimeoutMs)
      });
    } catch (error) {
      throw new NpmRegistryPendingError(
        `npm registry request did not settle for ${label}`,
        { cause: error }
      );
    }
    if (response.status === 404) return null;
    if (response.status !== 200) {
      if (response.status === 408 || response.status === 425
        || response.status === 429 || response.status >= 500) {
        throw new NpmRegistryPendingError(
          `npm registry returned ${response.status} for ${label}`
        );
      }
      throw new Error(`npm registry returned ${response.status} for ${label}`);
    }
    return boundedJsonResponse(response, label);
  }
}

function metadataUrl(
  registry: string,
  name: string,
  version: string | null
): string {
  const suffix = version === null
    ? encodeURIComponent(name)
    : `${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
  return new URL(suffix, registry).href;
}

function registryUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== ""
    || parsed.search !== "" || parsed.hash !== "") {
    throw new Error("npm registry must be a plain HTTPS origin");
  }
  return parsed.href.endsWith("/") ? parsed.href : `${parsed.href}/`;
}

async function boundedJsonResponse(
  response: Response,
  label: string
): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json") throw new Error(`${label} is not JSON`);
  const declared = response.headers.get("content-length");
  if (declared !== null
    && (!/^\d+$/u.test(declared) || Number(declared) > MAX_REGISTRY_BYTES)) {
    throw new Error(`${label} exceeds the response bound`);
  }
  if (response.body === null) throw new Error(`${label} has no response body`);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > MAX_REGISTRY_BYTES) {
      throw new Error(`${label} exceeds the response bound`);
    }
    chunks.push(chunk);
  }
  try {
    return parseJsonRejectingDuplicateKeys(
      new TextDecoder("utf-8", { fatal: true })
        .decode(Buffer.concat(chunks, bytes))
    );
  } catch (error) {
    throw new Error(`${label} has invalid JSON`, { cause: error });
  }
}

function positiveDuration(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 60 * 60_000) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}
