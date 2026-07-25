import type { GenerationSettings } from "../shared/types.js";
import { ProviderError } from "./errors.js";
import {
  providerFetch,
  providerFetchWithPresetQuery
} from "./provider-fetch.js";
import {
  providerRuntimeFor,
  redactProviderBody,
  redactProviderJson,
  redactProviderSecrets,
  resolveProviderHeaders
} from "./provider-runtime.js";

/** OpenRouter's intentionally unpaginated catalog is currently over 500 KiB.
 * Keep a reviewed bounded ceiling with growth headroom; extracted model counts
 * remain capped separately. */
export const MAX_PROVIDER_CATALOG_BYTES = 4 * 1024 * 1024;
const MAX_PROVIDER_ERROR_BYTES = 64 * 1024;

export async function getProviderJson(
  settings: GenerationSettings,
  url: string,
  baseHeaders: Readonly<Record<string, string>> = {},
  options: {
    readonly allowPresetQuery?: boolean;
    readonly maxBytes?: number;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
  } = {}
): Promise<unknown> {
  const runtime = providerRuntimeFor(settings);
  const { headers, secrets } = resolveProviderHeaders(settings, {
    accept: "application/json",
    ...baseHeaders
  });
  const totalMs = Math.min(
    options.timeoutMs ?? runtime.timeouts.totalMs,
    runtime.timeouts.totalMs
  );
  const headerDeadline = new AbortController();
  const totalDeadline = new AbortController();
  const headerTimer = setTimeout(
    () => headerDeadline.abort(),
    Math.min(runtime.timeouts.responseHeaderMs, totalMs)
  );
  const totalTimer = setTimeout(() => totalDeadline.abort(), totalMs);
  try {
    let response: Response;
    try {
      const fetchProvider = options.allowPresetQuery === true
        ? providerFetchWithPresetQuery
        : providerFetch;
      response = await fetchProvider(url, {
        headers,
        signal: AbortSignal.any([
          headerDeadline.signal,
          totalDeadline.signal,
          ...(options.signal === undefined ? [] : [options.signal])
        ])
      }, {
        allowInsecurePrivateHttp: runtime.allowInsecureHttp
      });
    } catch (error) {
      if (headerDeadline.signal.aborted || totalDeadline.signal.aborted) {
        throw new ProviderError("Model discovery exceeded its configured deadline.");
      }
      throw new ProviderError(
        `Model discovery failed: ${redactProviderSecrets(message(error), secrets)}`
      );
    }
    clearTimeout(headerTimer);
    let text: string;
    try {
      text = await boundedText(
        response,
        response.ok
          ? options.maxBytes ?? MAX_PROVIDER_CATALOG_BYTES
          : MAX_PROVIDER_ERROR_BYTES
      );
    } catch (error) {
      if (headerDeadline.signal.aborted || totalDeadline.signal.aborted) {
        throw new ProviderError("Model discovery exceeded its configured deadline.");
      }
      throw error;
    }
    if (!response.ok) {
      const detail = redactProviderBody(text, secrets)
        .replace(/\s+/gu, " ")
        .trim()
        .slice(0, 300);
      throw new ProviderError(
        `Model discovery failed (${response.status})${detail === "" ? "." : `: ${detail}`}`,
        response.status
      );
    }
    try {
      return redactProviderJson(JSON.parse(text) as unknown, secrets);
    } catch {
      return null;
    }
  } finally {
    clearTimeout(headerTimer);
    clearTimeout(totalTimer);
  }
}

async function boundedText(response: Response, maximum: number): Promise<string> {
  if (response.body === null) return "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let result = "";
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > maximum) {
      throw new ProviderError("provider_response_too_large: discovery response exceeded its safety limit.");
    }
    try {
      result += decoder.decode(chunk, { stream: true });
    } catch {
      throw malformedProviderUtf8();
    }
  }
  try {
    return result + decoder.decode();
  } catch {
    throw malformedProviderUtf8();
  }
}

function malformedProviderUtf8(): ProviderError {
  return new ProviderError("Model discovery returned malformed UTF-8 provider JSON.");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
