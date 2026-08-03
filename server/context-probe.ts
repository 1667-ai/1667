import type { GenerationSettings } from "../shared/types.js";
import { getProviderJson, postProviderJson } from "./provider-json.js";
import {
  hasProviderRuntime,
  providerRuntimeFor
} from "./provider-runtime.js";
import { providerRoot, providerUrl } from "./providers.js";
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
  const root = providerRoot(settings);
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
 * Response shape is llama.cpp's own, quoted from
 * https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
 * ("POST /tokenize: Tokenize a given text"): a JSON object with a `tokens`
 * field containing the tokenization result — plain token IDs when
 * `with_pieces` is omitted (default `false`), which is what 1667 sends. See
 * `postLlamaCppTokenize` below for the request body this sends.
 *
 * `parse_special: false` (issue #282 review round 3, finding 4b): the same
 * README documents `parse_special` on `/tokenize` with "Default: `true`",
 * and states "When `false` special tokens are treated as plaintext."
 * Phrase-bias and banned-string text is literal writer text, never a
 * control marker, so leaving the default `true` would let a model's own
 * special-token syntax (for example `<|eot_id|>`) tokenize to that one
 * control token instead of the ordinary tokens that spell the literal
 * text — resolving an ID that does not represent what the writer actually
 * typed. This is the llama.cpp counterpart of the `encode_ordinary` fix
 * already applied to the OpenAI tokenizer path
 * (server/openai-prompt-tokenizer.ts).
 */
export async function probeLlamaCppTokenize(
  settings: GenerationSettings,
  text: string,
  signal?: AbortSignal
): Promise<readonly number[] | null> {
  try {
    const data = await postLlamaCppTokenize(settings, text, { parse_special: false }, signal);
    if (!isObject(data) || !Array.isArray(data.tokens)) return null;
    const tokens = data.tokens.filter((token): token is number =>
      typeof token === "number" && Number.isSafeInteger(token) && token >= 0);
    return tokens.length === data.tokens.length ? tokens : null;
  } catch {
    signal?.throwIfAborted();
    return null;
  }
}

/**
 * The one call site for llama.cpp's `POST /tokenize`, shared by the two
 * probes that need it — `probeLlamaCppTokenize` above (phrase-bias and
 * banned-strings resolution) and `countLlamaCpp` (server/tokenize-probe.ts,
 * prompt token counting) — so the `model` decision is made once instead of
 * risking the two probes disagreeing about it. `extras` carries whatever
 * else the caller's own endpoint semantics need: `parse_special: false` for
 * the bias path, `add_special: true` for the count path.
 *
 * `model` rides the body, not a query parameter (issue #282 review round 2,
 * finding 3), because `/tokenize` is a POST and the GET `/props` probe
 * above selects a model through `?model=` instead. Sending it is a routing
 * convenience for a multi-model (router-mode) server, needed so a server
 * hosting more than one model does not either reject the request outright
 * or answer from whichever model it defaults to — silently keying the
 * resolved token IDs to the wrong vocabulary. It is not a documented
 * `/tokenize` field: the README linked above lists exactly `content`,
 * `add_special`, `parse_special`, and `with_pieces` (issue #282 review
 * round 3, finding 4c corrected an earlier comment that overstated this as
 * documented).
 *
 * A blank `settings.model` is 1667's own placeholder for "the connection
 * names no model; use whatever the server has loaded" (both the llama-cpp
 * and koboldcpp presets allow leaving it blank), not an actual model named
 * the empty string — so it is left out of the body rather than sent as
 * `model: ""` (issue #282 review round 5, finding 1). A router-mode server
 * has no model named `""`; sending it that way makes every phrase-bias and
 * banned-string probe fail on an otherwise reachable, correctly configured
 * server. `countLlamaCpp` (server/tokenize-probe.ts) drew the same
 * distinction for this same endpoint first; this is now the one place both
 * probes get it from.
 */
export async function postLlamaCppTokenize(
  settings: GenerationSettings,
  content: string,
  extras: Readonly<Record<string, unknown>>,
  signal?: AbortSignal
): Promise<unknown> {
  const root = providerRoot(settings);
  const route: Record<string, unknown> = settings.model.length === 0
    ? {}
    : { model: settings.model };
  return await postProviderJson(
    settings,
    `${root}/tokenize`,
    { ...route, content, ...extras },
    {},
    { signal, timeoutMs: probeTimeout(settings) }
  );
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
