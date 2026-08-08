import type { GenerationSettings } from "../shared/types.js";
import { withCallerCancellation } from "../shared/promise-cancellation.js";
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
        { signal, timeoutMs: probeTimeoutMs(settings) }
      );
      return isObject(data) ? positive(data.max_input_tokens) : null;
    });
  }

  if (
    settings.provider === "openai-compatible"
    || settings.provider === "text-completion"
  ) {
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
 * for phraseBias on a preset with no live tokenize probe of its own).
 * KoboldCpp clears the same bar its own way — see `probeKoboldCppTokenize`
 * below. Returns null on any failure (network, timeout, malformed
 * response) — the caller (server/sampling-phrase-bias.ts) treats null as
 * "tokenizer unavailable", the same systemic outcome a failed local
 * tokenizer load already reports.
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
    { signal, timeoutMs: probeTimeoutMs(settings) }
  );
}

/** What one call to `probeKoboldCppTokenize` found — a discriminated result
 * rather than `readonly number[] | null` (issue #311 review, second pass,
 * finding E), so a caller can tell "the server answered, but without token
 * IDs" apart from "the server did not answer at all". Collapsing both into
 * `null`, as an earlier version of this function did, blamed a `probe-failed`
 * network message on a server that had, in fact, answered — an old KoboldCpp
 * build that reports only `value` (see the doc comment on
 * `probeKoboldCppTokenize` below) is a supported configuration, not a
 * transient outage.
 * - "ok": a well-formed `ids` array — possibly empty, which is legitimate
 *   only for the empty-string calibration probe (`server/sampling-phrase-
 *   bias.ts`, `koboldCppLiveTokenizeProbe`); see `probeKoboldCppTokenize`'s
 *   own comment for why a non-empty prompt tokenizing to zero IDs is instead
 *   "failed".
 * - "no-ids": the response was a JSON object, but had no `ids` array at all
 *   — the release-old-enough-to-read-only-`prompt` case.
 * - "failed": network failure, timeout, non-JSON response, or an `ids`
 *   array that failed validation (a non-integer entry, for example) — every
 *   case where 1667 cannot trust anything the server said. */
export type KoboldCppTokenizeProbeResult =
  | { readonly kind: "ok"; readonly ids: readonly number[] }
  | { readonly kind: "no-ids" }
  | { readonly kind: "failed" };

/**
 * Ask a KoboldCpp server to tokenize `text` against whatever model it
 * actually has loaded — the same authority-by-construction llama.cpp's
 * `/tokenize` gives `probeLlamaCppTokenize` above, and the second caller of
 * `postKoboldCppTokenCount` below (server/tokenize-probe.ts's `countKoboldCpp`
 * is the first).
 *
 * Response shape is KoboldCpp's own, quoted from its API document
 * (https://github.com/LostRuins/koboldcpp/blob/concedo/embd_res/kcpp_docs.embd,
 * the `/api/extra/tokencount` schema — "Counts the number of tokens in a
 * string, and returns their token IDs"): a JSON object with a `value` field
 * (the count) and an `ids` field, `"type": "array", "items": { "type":
 * "integer" }`, example `"ids": [1, 22557, 28725, …]`. Issue #311 is the
 * first caller to read `ids` — `countKoboldCpp` already posts to this same
 * endpoint and already validates `value`, but only ever reads that field.
 *
 * That same documented example is also why a naive request needs a fix: its
 * `ids` begins `1`, the model's BOS token, for text that is otherwise nine
 * ordinary tokens. A lexically single-token phrase therefore comes back as
 * two IDs — `[BOS, token]` — on any BOS-adding build, which is the normal
 * case, and every surface variant of it would be misclassified multi-token
 * and rejected, unless the request asks otherwise. The published request
 * schema for this endpoint names exactly one field, `prompt` — but the
 * implementation accepts a second, undocumented one. `koboldcpp.py:6680`:
 *
 *     tcaddspecial = genparams.get('special', True)
 *     countdata = tokenize_ids(countprompt, tcaddspecial)
 *
 * `special` defaults to `true` and reaches the tokenizer as `addbos`
 * (`token_count(const char* input, bool addbos)` in the C++ layer below
 * that Python) — the same flag that decides whether BOS is prepended. This
 * function sends `special: false` (issue #311 review, round five), which on
 * a build that honours it makes `ids` come back without the prefix in the
 * first place. An earlier version of this fix rejected sending this flag at
 * all, on the strength of the published schema alone, which lists only
 * `prompt`; the schema is incomplete, and the source is what actually
 * ships.
 *
 * `server/sampling-phrase-bias.ts`'s `koboldCppLiveTokenizeProbe` still
 * tokenizes the empty string once per resolution through this same
 * function and strips whatever prefix comes back (`stripKoboldCppBosPrefix`
 * below) — kept as a fallback, not removed, because `special` is
 * undocumented: a build that does not read it (an older release, or a
 * fork) still returns whatever raw `ids` it always did, and only the
 * calibration catches that honestly instead of silently trusting a flag
 * the build may have ignored. The two compose safely rather than duplicate
 * each other: on a build that honours `special: false`, the calibration
 * probe's own prefix comes back empty and every later strip is a no-op;
 * only a build that ignores the flag needs the strip to do real work. This
 * does not touch the special-token guard elsewhere on this path
 * (`SPECIAL_TOKEN_SYNTAX`, server/sampling-phrase-bias.ts): `addbos`/
 * `special` controls only whether BOS is prepended, not whether text like
 * `<end_of_turn>` parses as a control token rather than the literal
 * characters a writer typed — the two are unrelated hazards with unrelated
 * fixes. This function itself stays a thin, honest wrapper around the wire
 * response — the calibration and stripping live one layer up, where the
 * "once per resolution, not per phrase" batching already happens.
 *
 * A non-empty `text` that tokenizes to zero IDs is treated the same as a
 * missing `ids` field — "failed", not a legitimate zero-token outcome
 * (issue #311 review, second pass, finding E): no real tokenizer maps
 * non-empty text to nothing, so an empty array here is itself evidence the
 * response cannot be trusted, the same systemic fact a malformed response
 * already is. The one legitimate empty `ids` response is for `text === ""`
 * itself — the calibration probe — where it means "this build adds no BOS",
 * not "did not answer".
 *
 * KoboldCpp is a single loaded model per server instance, unlike llama.cpp's
 * router mode, so unlike `postLlamaCppTokenize` this sends no `model`
 * routing field at all — matching the existing `countKoboldCpp` and
 * `probeContextWindow`'s koboldcpp branch (both above/below in this file's
 * neighborhood), neither of which sends one either.
 */
export async function probeKoboldCppTokenize(
  settings: GenerationSettings,
  text: string,
  signal?: AbortSignal
): Promise<KoboldCppTokenizeProbeResult> {
  try {
    const data = await postKoboldCppTokenCount(settings, { prompt: text, special: false }, signal);
    if (!isObject(data)) return { kind: "failed" };
    if (!Array.isArray(data.ids)) return { kind: "no-ids" };
    const tokens = data.ids.filter((token): token is number =>
      typeof token === "number" && Number.isSafeInteger(token) && token >= 0);
    if (tokens.length !== data.ids.length) return { kind: "failed" };
    if (tokens.length === 0 && text.length > 0) return { kind: "failed" };
    return { kind: "ok", ids: tokens };
  } catch {
    signal?.throwIfAborted();
    return { kind: "failed" };
  }
}

/**
 * Strips a KoboldCpp build's calibrated, constant tokenization prefix
 * (`server/sampling-phrase-bias.ts`, `koboldCppLiveTokenizeProbe`) from one
 * phrase's `ids`, or reports that the assumption did not hold for this
 * response.
 *
 * Two edge cases the issue #311 review (first pass) asked to be handled
 * explicitly:
 * - `ids` does not actually begin with `prefix` — the build's prefix turned
 *   out not to be the constant the calibration probe assumed it was. Rather
 *   than guess which part of `ids` is the "real" tokenization, this reports
 *   the same honest failure a calibration probe that never answered would
 *   (`server/sampling-phrase-bias.ts` maps it to `"probe-failed"`) — the
 *   review's own words: "if the prefix cannot be established, return
 *   tokenizer-unavailable rather than guessing."
 * - `ids` equals `prefix` exactly, leaving zero tokens once stripped. No
 *   special case is needed for this one: an empty result flows back to the
 *   ordinary classification (`tokenIds.length === 1 ? "single-token" :
 *   "multi-token"`) the same as any other non-single-token count, landing as
 *   "multi-token" with an empty `tokenIds` — rejected, the same honest
 *   outcome a phrase that needs two or more tokens gets, never approximated
 *   as free or as single-token.
 */
export function stripKoboldCppBosPrefix(
  ids: readonly number[],
  prefix: readonly number[]
): readonly number[] | null {
  if (ids.length < prefix.length) return null;
  for (let index = 0; index < prefix.length; index += 1) {
    if (ids[index] !== prefix[index]) return null;
  }
  return ids.slice(prefix.length);
}

/**
 * The one call site for KoboldCpp's `POST /api/extra/tokencount`, shared by
 * the two callers that need it — `probeKoboldCppTokenize` above (phrase-bias
 * resolution) and `countKoboldCpp` (server/tokenize-probe.ts, prompt token
 * counting) — the same one-endpoint, two-caller shape
 * `postLlamaCppTokenize` already keeps for llama.cpp's `/tokenize`, so a
 * phrase-bias probe and a prompt count can never quietly diverge on the URL.
 * `body` is the caller's own: `countKoboldCpp` sends `{ messages }`, an
 * undocumented but already-shipped form (see its own comment in
 * server/tokenize-probe.ts) that lets a release compile a full chat
 * template; `probeKoboldCppTokenize` sends `{ prompt, special: false }`.
 *
 * Every call here is serialized per server root through
 * `withKoboldCppTokenCountLock` below (issue #311 review, round five,
 * blocker) — see that function's own comment for why this endpoint, unlike
 * llama.cpp's `/tokenize`, cannot safely answer two requests at once.
 */
export async function postKoboldCppTokenCount(
  settings: GenerationSettings,
  body: Readonly<Record<string, unknown>>,
  signal?: AbortSignal
): Promise<unknown> {
  const root = providerRoot(settings);
  return await withKoboldCppTokenCountLock(
    root,
    () => postProviderJson(
      settings,
      `${root}/api/extra/tokencount`,
      body,
      {},
      { signal, timeoutMs: probeTimeoutMs(settings) }
    ),
    signal
  );
}

/**
 * Serializes every call to KoboldCpp's `POST /api/extra/tokencount` against
 * one server root — per root, not a single process-wide queue, so two
 * different KoboldCpp servers (or two settings values that happen to
 * normalize to two different roots) queue independently, and a llama.cpp
 * route (`postLlamaCppTokenize` above) is entirely unaffected and keeps its
 * full `LIVE_TOKENIZE_PROBE_CONCURRENCY` (issue #311 review, round five,
 * blocker).
 *
 * KoboldCpp's own upstream source is the evidence this is required, not
 * merely cautious. `expose.cpp`'s `token_count` handler answers from a
 * process-global buffer, by its own comment:
 *
 *     static std::vector<int> toks; //just share a static object for token counting
 *     ...
 *     toks = gpttype_get_token_arr(inputstr, addbos);
 *     output.count = toks.size();
 *     output.ids = toks.data(); //this may be slightly unsafe
 *
 * `output.ids` is a raw pointer into `toks`, and `koboldcpp.py`'s
 * `tokenize_ids` only copies out of that pointer *after* `token_count`
 * returns. The request handler itself answers `/api/extra/tokencount`
 * before ever taking KoboldCpp's own generation lock — the handler sits at
 * `koboldcpp.py:6674`, `modelbusy.acquire` not until `:7091` — so two
 * requests genuinely can reach `token_count` at the same time on a real
 * server, not only in principle. `server/sampling-phrase-bias.ts`'s
 * `liveProbeVariantTokenizer` fans out up to `LIVE_TOKENIZE_PROBE_CONCURRENCY`
 * (8) probes at once for exactly this endpoint; without serialization, two
 * overlapping calls can reallocate or overwrite the buffer the other is
 * still reading out of, and the failure is silent — a phrase resolves to
 * plausible-looking but wrong token ids, quietly biasing a token the writer
 * never asked for.
 *
 * Only `postKoboldCppTokenCount` routes through this (`serializeLiveProbe`,
 * `SamplingBiasPresetRules`, shared/sampling-phrase-resolution.ts, is how
 * `resolveWithLiveProbe` decides to reach it in the first place) — so
 * `countKoboldCpp` (server/tokenize-probe.ts), which shares this same
 * function, joins the same per-root queue automatically: the buffer it
 * shares with `probeKoboldCppTokenize` is the same one for either caller.
 *
 * Implementation: `koboldCppTokenCountLocks` holds, per root, a promise
 * that resolves once every call queued against that root so far has
 * settled. `previous.then(run, run)` runs `run` only after `previous`
 * settles, whether `previous` fulfilled or rejected — a failed call must
 * never leave the next one waiting forever. The tail stored back into the
 * map never itself rejects (`.then(() => undefined, () => undefined)`), so
 * one caller's failure cannot poison the queue for the next.
 *
 * Caller cancellation races the caller's wait. The queued slot stays in the
 * chain and checks the signal before it starts provider work. Thus, a
 * cancelled slot cannot overlap another call or stall the next call.
 */
const koboldCppTokenCountLocks = new Map<string, Promise<unknown>>();

function withKoboldCppTokenCountLock<T>(
  root: string,
  run: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  signal?.throwIfAborted();

  const previous = koboldCppTokenCountLocks.get(root) ?? Promise.resolve();
  const runUnlessAborted = () => (signal?.aborted ? Promise.reject(signal.reason) : run());
  const current = previous.then(runUnlessAborted, runUnlessAborted);
  koboldCppTokenCountLocks.set(root, current.then(() => undefined, () => undefined));
  return withCallerCancellation(current, signal);
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
      timeoutMs: probeTimeoutMs(settings)
    }
  );
}

/** Exported so `server/tokenize-probe.ts` shares this one definition instead
 * of keeping a byte-identical private copy (issue #311 review, second pass,
 * finding F): before this change the divergence was cosmetic, since both
 * copies computed the same number; `countKoboldCpp`'s own probe now shares
 * `postKoboldCppTokenCount` with `probeKoboldCppTokenize`, so a future edit
 * to one copy and not the other would make the two callers of that one
 * shared endpoint disagree about how long to wait on it. */
export function probeTimeoutMs(settings: GenerationSettings): number {
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
