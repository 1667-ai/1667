import type { GenerationSettings, ModelServerCheckResult } from "../shared/types.js";
import { providerFetch } from "./provider-fetch.js";
import { MAX_PROVIDER_CATALOG_BYTES } from "./provider-json.js";
import { providerUrl } from "./providers.js";
import {
  providerRuntimeFor,
  redactProviderBody,
  redactProviderSecrets,
  resolveProviderHeaders
} from "./provider-runtime.js";

const MAX_CHECK_ERROR_BYTES = 64 * 1024;
export const MAX_MODEL_SERVER_CHECK_MS = 5_000;

export interface ModelServerCheckOptions {
  /** Activation proves reachability and authentication only. Model discovery
   * remains advisory because some compatible gateways expose incomplete lists. */
  readonly validateSuccessfulResponse?: boolean;
  readonly signal?: AbortSignal;
}

/** Verify the submitted provider settings without saving them or generating text. */
export async function checkModelServer(
  settings: GenerationSettings,
  timeoutMs?: number,
  options: ModelServerCheckOptions = {}
): Promise<ModelServerCheckResult> {
  options.signal?.throwIfAborted();
  const runtime = providerRuntimeFor(settings);
  const headerTimeoutMs = timeoutMs
    ?? Math.min(runtime.timeouts.responseHeaderMs, MAX_MODEL_SERVER_CHECK_MS);
  const totalTimeoutMs = timeoutMs
    ?? Math.min(runtime.timeouts.totalMs, MAX_MODEL_SERVER_CHECK_MS);
  if (settings.provider === "dry-run") {
    return { state: "ready", message: "Dry-run mode is ready — no model server needed." };
  }
  if (settings.baseUrl.length === 0) {
    return { state: "error", message: "Enter a base URL before checking the server." };
  }

  let resolved: ReturnType<typeof resolveProviderHeaders>;
  try {
    resolved = resolveProviderHeaders(settings, {
      accept: "application/json",
      ...(settings.provider === "anthropic"
        ? { "anthropic-version": "2023-06-01" }
        : {})
    });
  } catch (error) {
    return {
      state: "error",
      message: `Can't check: ${
        error instanceof Error ? error.message : "provider credentials are invalid."
      }`
    };
  }

  const exactAnthropicModel = settings.provider === "anthropic"
    && settings.model.trim().length > 0;
  const path = exactAnthropicModel
    ? `/v1/models/${encodeURIComponent(settings.model)}`
    : settings.provider === "anthropic" ? "/v1/models" : "/models";
  const url = `${providerUrl(settings, path)}${
    settings.provider === "anthropic"
      && !exactAnthropicModel
      && new URL(settings.baseUrl).protocol === "https:"
      ? "?limit=1"
      : ""
  }`;

  const startedAt = Date.now();
  let deadlineMessage: string | null = null;
  const headerDeadline = new AbortController();
  const totalDeadline = new AbortController();
  const headerTimer = setTimeout(() => {
    deadlineMessage = `Server did not return response headers within ${headerTimeoutMs / 1_000} seconds.`;
    headerDeadline.abort();
  }, headerTimeoutMs);
  const totalTimer = setTimeout(() => {
    deadlineMessage = `Model server check exceeded its total deadline of ${totalTimeoutMs / 1_000} seconds.`;
    totalDeadline.abort();
  }, totalTimeoutMs);
  try {
    const response = await providerFetch(url, {
      headers: resolved.headers,
      signal: AbortSignal.any([
        headerDeadline.signal,
        totalDeadline.signal,
        ...(options.signal === undefined ? [] : [options.signal])
      ])
    }, {
      allowInsecurePrivateHttp: runtime.allowInsecureHttp
    });
    clearTimeout(headerTimer);
    const elapsed = Date.now() - startedAt;
    if (
      options.validateSuccessfulResponse === false
      && (response.ok || response.status === 404 || response.status === 405)
    ) {
      await response.body?.cancel();
      return {
        state: "ready",
        message: response.ok
          ? `Server is ready — ${path} replied in ${elapsed} ms.`
          : `Server is reachable — optional ${path} discovery is unavailable (${response.status}).`
      };
    }
    if (response.ok) {
      const data = await responseJson(response, MAX_PROVIDER_CATALOG_BYTES);
      if (exactAnthropicModel) {
        if (!isObject(data) || data.id !== settings.model) {
          return {
            state: "warning",
            message: `Server is reachable, but ${path} did not return the configured model.`
          };
        }
      } else if (!isObject(data) || !Array.isArray(data.data)) {
        return {
          state: "warning",
          message: `Server is reachable, but ${path} did not return a model list.`
        };
      } else if (settings.model.trim().length > 0 && !data.data.some((entry) =>
        isObject(entry)
        && entry.id === settings.model)) {
        return {
          state: "warning",
          message: `Server is reachable, but model ${settings.model} was not present in ${path}.`
        };
      }
      return { state: "ready", message: `Server is ready — ${path} replied in ${elapsed} ms.` };
    }
    const safeStatusText = redactProviderSecrets(response.statusText, resolved.secrets);
    const status = `${response.status}${safeStatusText.length > 0 ? ` ${safeStatusText}` : ""}`;
    const detail = responseDetail(redactProviderBody(
      await boundedResponseText(response, MAX_CHECK_ERROR_BYTES),
      resolved.secrets
    ));
    return {
      state: "warning",
      message: `Server is reachable, but ${path} returned ${status}${detail.length > 0 ? `: ${detail}` : "."}`
    };
  } catch (error) {
    options.signal?.throwIfAborted();
    if (deadlineMessage !== null) {
      return {
        state: "error",
        message: deadlineMessage
      };
    }
    if (isTimeout(error)) {
      return { state: "error", message: "Model server check timed out." };
    }
    return {
      state: "error",
      message: `Couldn't reach the server: ${redactProviderSecrets(
        errorMessage(error),
        resolved.secrets
      )}`
    };
  } finally {
    clearTimeout(headerTimer);
    clearTimeout(totalTimer);
  }
}

async function responseJson(response: Response, maximum: number): Promise<unknown> {
  try {
    return JSON.parse(await boundedResponseText(response, maximum)) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

async function boundedResponseText(response: Response, maximum: number): Promise<string> {
  if (response.body === null) return "";
  const decoder = new TextDecoder();
  let bytes = 0;
  let result = "";
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > maximum) {
      throw new Error("model server response exceeded the check limit");
    }
    result += decoder.decode(chunk, { stream: true });
  }
  return result + decoder.decode();
}

function responseDetail(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length === 0) return "";
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (isObject(parsed)) {
      if (typeof parsed.error === "string") return parsed.error.slice(0, 180);
      if (isObject(parsed.error) && typeof parsed.error.message === "string") return parsed.error.message.slice(0, 180);
      if (typeof parsed.message === "string") return parsed.message.slice(0, 180);
    }
  } catch {
    // Plain-text provider error.
  }
  return trimmed.slice(0, 180);
}

function isTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "TimeoutError" || error.name === "AbortError"
    || (error as NodeJS.ErrnoException).code === "ABORT_ERR") return true;
  return isTimeout((error as Error & { cause?: unknown }).cause);
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as Error & { cause?: unknown }).cause;
  return cause instanceof Error ? cause.message : error.message;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
