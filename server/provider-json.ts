import type { GenerationSettings } from "../shared/types.js";
import { ProviderError } from "./errors.js";
import {
  providerFetch,
  providerFetchWithPresetQuery
} from "./provider-fetch.js";
import {
  providerErrorSummary,
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

interface ProviderJsonOptions {
  readonly allowPresetQuery?: boolean;
  readonly maxBytes?: number;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export async function getProviderJson(
  settings: GenerationSettings,
  url: string,
  baseHeaders: Readonly<Record<string, string>> = {},
  options: ProviderJsonOptions = {}
): Promise<unknown> {
  return await requestProviderJson(
    settings,
    url,
    { accept: "application/json", ...baseHeaders },
    { method: "GET" },
    options,
    "Model discovery"
  );
}

/** POST counterpart, for endpoints that count or resolve something rather than
 * list it (`count_tokens`, `apply-template`, `tokenize`, `tokencount`). Shares
 * `getProviderJson`'s timeout, redaction, and byte-ceiling behaviour through
 * `requestProviderJson` rather than duplicating it. */
export async function postProviderJson(
  settings: GenerationSettings,
  url: string,
  body: unknown,
  baseHeaders: Readonly<Record<string, string>> = {},
  options: ProviderJsonOptions = {}
): Promise<unknown> {
  return await requestProviderJson(
    settings,
    url,
    { accept: "application/json", "content-type": "application/json", ...baseHeaders },
    { method: "POST", body: JSON.stringify(body) },
    options,
    "Provider request"
  );
}

async function requestProviderJson(
  settings: GenerationSettings,
  url: string,
  headerInputs: Readonly<Record<string, string>>,
  requestInit: { readonly method: string; readonly body?: string },
  options: ProviderJsonOptions,
  operationLabel: string
): Promise<unknown> {
  const runtime = providerRuntimeFor(settings);
  const { headers, secrets } = resolveProviderHeaders(settings, headerInputs);
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
  // Keep the composite alive across Request's cloned signal. Node's follower
  // signal does not retain this source strongly; an inline AbortSignal.any()
  // can be collected before either deadline fires after GC-heavy work.
  const requestSignal = AbortSignal.any([
    headerDeadline.signal,
    totalDeadline.signal,
    ...(options.signal === undefined ? [] : [options.signal])
  ]);
  try {
    let response: Response;
    try {
      const fetchProvider = options.allowPresetQuery === true
        ? providerFetchWithPresetQuery
        : providerFetch;
      response = await fetchProvider(url, {
        method: requestInit.method,
        body: requestInit.body,
        headers,
        signal: requestSignal
      }, {
        allowInsecurePrivateHttp: runtime.allowInsecureHttp
      });
    } catch (error) {
      // Reading the composite here also keeps it live while fetch is pending.
      if (requestSignal.aborted
        && (headerDeadline.signal.aborted || totalDeadline.signal.aborted)) {
        throw new ProviderError(`${operationLabel} exceeded its configured deadline.`);
      }
      throw new ProviderError(
        `${operationLabel} failed: ${redactProviderSecrets(message(error), secrets)}`
      );
    }
    clearTimeout(headerTimer);
    let text: string;
    try {
      text = await boundedText(
        response,
        response.ok
          ? options.maxBytes ?? MAX_PROVIDER_CATALOG_BYTES
          : MAX_PROVIDER_ERROR_BYTES,
        operationLabel
      );
    } catch (error) {
      if (headerDeadline.signal.aborted || totalDeadline.signal.aborted) {
        throw new ProviderError(`${operationLabel} exceeded its configured deadline.`);
      }
      throw error;
    }
    if (!response.ok) {
      const detail = providerErrorSummary(redactProviderBody(text, secrets));
      throw new ProviderError(
        `${operationLabel} failed (${response.status})${detail === "" ? "." : `: ${detail}`}`,
        response.status
      );
    }
    try {
      return redactProviderJson(JSON.parse(text) as unknown, secrets);
    } catch {
      return null;
    }
  } finally {
    // Fetch resolves at response headers; retain the composite until the body
    // is consumed so total deadlines and caller cancellation remain live.
    void requestSignal.aborted;
    clearTimeout(headerTimer);
    clearTimeout(totalTimer);
  }
}

async function boundedText(
  response: Response,
  maximum: number,
  operationLabel: string
): Promise<string> {
  if (response.body === null) return "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let result = "";
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > maximum) {
      throw new ProviderError("provider_response_too_large: provider response exceeded its safety limit.");
    }
    try {
      result += decoder.decode(chunk, { stream: true });
    } catch {
      throw malformedProviderUtf8(operationLabel);
    }
  }
  try {
    return result + decoder.decode();
  } catch {
    throw malformedProviderUtf8(operationLabel);
  }
}

function malformedProviderUtf8(operationLabel: string): ProviderError {
  return new ProviderError(`${operationLabel} returned malformed UTF-8 provider JSON.`);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
