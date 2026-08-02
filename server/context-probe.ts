import type { GenerationSettings } from "../shared/types.js";
import { getProviderJson, postProviderJson } from "./provider-json.js";
import {
  hasProviderRuntime,
  providerRuntimeFor
} from "./provider-runtime.js";
import { providerUrl } from "./providers.js";
import {
  MAX_SETTINGS_TOKEN_COUNT
} from "./settings-v2-scalars.js";

/**
 * Ask the backend how big its context window is. There is no standard for this —
 * the OpenAI chat API doesn't report it at all — so each backend gets a best-effort
 * probe and we take the first answer. null means "couldn't tell"; the caller keeps
 * whatever the user set by hand.
 */
export async function probeContextWindow(
  settings: GenerationSettings,
  signal?: AbortSignal
): Promise<number | null> {
  const root = settings.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  const probes: (() => Promise<number | null>)[] = [];
  const runtime = providerRuntimeFor(settings);
  const legacyNativeFallback = !hasProviderRuntime(settings);
  signal?.throwIfAborted();

  if (settings.provider === "anthropic") {
    if (settings.model.length === 0) return null;
    probes.push(async () => {
      const data = await getProviderJson(
        settings,
        providerUrl(settings, `/v1/models/${encodeURIComponent(settings.model)}`),
        { "anthropic-version": "2023-06-01" },
        { signal, timeoutMs: probeTimeout(settings) }
      );
      return isObject(data) ? positive(data.max_input_tokens) : null;
    });
  }

  if (settings.provider === "openai-compatible") {
    if (runtime.preset === "openai"
      || runtime.preset === "openrouter"
      || runtime.preset === "custom"
      || legacyNativeFallback) {
      probes.push(async () => {
        const data = await getJson(settings, `${settings.baseUrl.replace(/\/+$/, "")}/models`, false, signal);
        const list = isObject(data) && Array.isArray(data.data) ? data.data : [];
        const entry = list.find((m) => isObject(m) && m.id === settings.model);
        return isObject(entry)
          ? positive(entry.context_length) ?? positive(entry.max_context_length)
          : null;
      });
    }
    if (runtime.preset === "lm-studio" || legacyNativeFallback) probes.push(async () => {
      const data = await getJson(settings, `${root}/api/v0/models`, false, signal);
      const list = isObject(data) && Array.isArray(data.data) ? data.data : [];
      const loaded = list.filter((entry) =>
        isObject(entry) && positive(entry.loaded_context_length) !== null
      );
      const entry = loaded.find((model) => model.id === settings.model)
        ?? ((settings.model === "" || settings.model === "local-model") && loaded.length === 1
          ? loaded[0]
          : undefined);
      return isObject(entry) ? positive(entry.loaded_context_length) : null;
    });
    if (runtime.preset === "koboldcpp" || legacyNativeFallback) probes.push(async () => {
      const data = await getJson(settings, `${root}/api/extra/true_max_context_length`, false, signal);
      return isObject(data) ? positive(data.value) : null;
    });
    if (runtime.preset === "ollama" || legacyNativeFallback) probes.push(async () => {
      const data = await getJson(settings, `${root}/api/ps`, false, signal);
      const running = isObject(data) && Array.isArray(data.models) ? data.models : [];
      const allocated = running.filter((entry) =>
        isObject(entry) && positive(entry.context_length) !== null
      );
      const entry = allocated.find((model) =>
        ollamaModelMatches(model, settings.model)
      );
      return isObject(entry) ? positive(entry.context_length) : null;
    });
    if (runtime.preset === "llama-cpp" || legacyNativeFallback) probes.push(async () => {
      const data = await getJson(
        settings,
        `${settings.baseUrl.replace(/\/+$/, "")}/models`,
        false,
        signal
      );
      const list = isObject(data) && Array.isArray(data.data)
        ? data.data.filter((entry) =>
            isObject(entry) && entry.owned_by === "llamacpp"
          )
        : [];
      const entry = list.find((model) => model.id === settings.model)
        ?? (settings.model === "" && list.length === 1 ? list[0] : undefined);
      if (entry === undefined || typeof entry.id !== "string") return null;
      const propsUrl = new URL(`${root}/props`);
      if (list.length > 1) {
        propsUrl.searchParams.set("model", entry.id);
        propsUrl.searchParams.set("autoload", "false");
      }
      let props: unknown = null;
      try {
        props = await getJson(
          settings,
          propsUrl.href,
          list.length > 1,
          signal
        );
      } catch {
        signal?.throwIfAborted();
      }
      const contextWindow = contextWindowFromLlamaProps(props);
      if (contextWindow !== null || list.length > 1) return contextWindow;

      propsUrl.searchParams.set("model", entry.id);
      propsUrl.searchParams.set("autoload", "false");
      return contextWindowFromLlamaProps(
        await getJson(settings, propsUrl.href, true, signal)
      );
    });
  }

  for (const probe of probes) {
    signal?.throwIfAborted();
    let value: number | null = null;
    try {
      value = await probe();
    } catch {
      signal?.throwIfAborted();
    }
    if (value !== null) return value;
  }
  signal?.throwIfAborted();
  return null;
}

/**
 * Ask a llama.cpp server to tokenize `text` against whatever model it
 * actually has loaded — authoritative by construction, unlike trusting the
 * server's reported model name (see the PRESET_SUBTRACTIONS comment in
 * shared/sampling-capabilities.ts for why the reported name is not trusted
 * for phraseBias/bannedStrings on any other self-hosted preset). Returns
 * null on any failure (network, timeout, malformed response) — the caller
 * (server/sampling-phrase-bias.ts) treats null as "tokenizer unavailable",
 * the same systemic outcome a failed local tokenizer load already reports.
 *
 * Request and response shapes are llama.cpp's own, quoted from
 * https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
 * ("POST /tokenize: Tokenize a given text"):
 *   `content`: (Required) The text to tokenize.
 *   Returns a JSON object with a `tokens` field containing the
 *   tokenization result — plain token IDs when `with_pieces` is omitted
 *   (default `false`), which is what 1667 sends.
 */
export async function probeLlamaCppTokenize(
  settings: GenerationSettings,
  text: string,
  signal?: AbortSignal
): Promise<readonly number[] | null> {
  const root = settings.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  try {
    const data = await postProviderJson(
      settings,
      `${root}/tokenize`,
      { content: text },
      {},
      { signal, timeoutMs: probeTimeout(settings) }
    );
    if (!isObject(data) || !Array.isArray(data.tokens)) return null;
    const tokens = data.tokens.filter((token): token is number =>
      typeof token === "number" && Number.isSafeInteger(token) && token >= 0);
    return tokens.length === data.tokens.length ? tokens : null;
  } catch {
    signal?.throwIfAborted();
    return null;
  }
}

function ollamaModelMatches(
  model: Record<string, unknown>,
  requested: string
): boolean {
  const names = [model.model, model.name].filter(
    (value): value is string => typeof value === "string"
  );
  const normalizedRequested = normalizeOllamaModelName(requested);
  return names.some((name) =>
    name === requested
    || normalizeOllamaModelName(name) === normalizedRequested
  );
}

function normalizeOllamaModelName(model: string): string {
  return model.endsWith(":latest")
    ? model.slice(0, -":latest".length)
    : model;
}

function contextWindowFromLlamaProps(props: unknown): number | null {
  if (!isObject(props) || !isObject(props.default_generation_settings)) return null;
  return positive(props.default_generation_settings.n_ctx);
}

async function getJson(
  settings: GenerationSettings,
  url: string,
  allowPresetQuery = false,
  signal?: AbortSignal
): Promise<unknown> {
  return await getProviderJson(
    settings,
    url,
    {},
    {
      allowPresetQuery,
      signal,
      timeoutMs: probeTimeout(settings)
    }
  );
}

function probeTimeout(settings: GenerationSettings): number {
  return Math.min(providerRuntimeFor(settings).timeouts.totalMs, 30_000);
}

function positive(value: unknown): number | null {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value > 0
    && value <= MAX_SETTINGS_TOKEN_COUNT
    ? value
    : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
