import {
  probabilityOf,
  type TokenProbabilityRecord,
  type TokenProbabilityStep
} from "../../shared/token-probabilities.js";
import {
  resolveTokenProbabilities,
  tokenProbabilityUnavailableReason,
  TOKEN_PROBABILITY_SUPPORTED_PRESETS
} from "../../shared/token-probability-capabilities.js";
import { samplingContextForRoute } from "../../shared/sampling-capabilities.js";
import { selectSettingsRoute } from "../../shared/settings-route.js";
import type { SettingsPresetV2, SettingsView } from "../../shared/settings-v2-types.js";
import { type StyleRun, type WrappedLine, wrapText } from "./wrap.js";

/** Alternatives at or above this probability are always shown; the rest
 *  collapse into one "n more under 1%" row (issue #291 §4.1). */
const COLLAPSE_THRESHOLD = 0.01;

export type TokenProbabilityAlternativeRow =
  | {
      readonly kind: "alternative";
      /** Index into `step.alternatives` — what `altIndex` steps land on
       *  once expanded, and what a reducer needs to tell "the collapsed
       *  row" apart from "the last real one". */
      readonly index: number;
      readonly token: string;
      readonly logprob: number;
      readonly p: number;
      /** The alternative whose token equals the step's own generated
       *  token — first match only (issue #291 §4.1's "✓ sampled"). */
      readonly sampled: boolean;
    }
  | { readonly kind: "collapsed"; readonly hiddenCount: number };

/** Split one step's alternatives into the rows the table paints: everything
 *  at or above 1% individually, then either the remainder individually
 *  (`expanded`) or one summarizing row. Order is preserved from the
 *  provider's own list — most likely first — rather than re-sorted, since a
 *  provider is not contractually required to hand back a monotone list and
 *  this must not silently reorder one that isn't. */
export function tokenProbabilityAlternativeRows(
  step: TokenProbabilityStep,
  expanded: boolean
): readonly TokenProbabilityAlternativeRow[] {
  const sampledAt = sampledAlternativeIndex(step);
  const shown: TokenProbabilityAlternativeRow[] = [];
  const hidden: TokenProbabilityAlternativeRow[] = [];
  step.alternatives.forEach((alternative, index) => {
    const row: TokenProbabilityAlternativeRow = {
      kind: "alternative",
      index,
      token: alternative.token,
      logprob: alternative.logprob,
      p: probabilityOf(alternative.logprob),
      sampled: index === sampledAt
    };
    (row.p >= COLLAPSE_THRESHOLD ? shown : hidden).push(row);
  });
  if (hidden.length === 0 || expanded) return [...shown, ...hidden];
  return [...shown, { kind: "collapsed", hiddenCount: hidden.length }];
}

/** Exact match first, everywhere in the list. `alignTokenProbabilities`
 *  (shared/token-probabilities.ts) narrows a boundary step's own `token` to
 *  drop leading or trailing whitespace the take's stored text already
 *  discarded, but it leaves every alternative — this one included — exactly
 *  as the provider returned it, so the sampled entry for a narrowed step no
 *  longer matches byte for byte. A trimmed fallback recovers it, guarded to
 *  the whole list only once no exact match exists anywhere, so a provider
 *  that genuinely lists both `"the"` and `" the"` as distinct candidates
 *  keeps them distinct whenever an exact match is possible at all. */
function sampledAlternativeIndex(step: TokenProbabilityStep): number {
  const exact = step.alternatives.findIndex((alternative) => alternative.token === step.token);
  if (exact !== -1) return exact;
  const trimmedToken = step.token.trim();
  if (trimmedToken.length === 0) return -1;
  return step.alternatives.findIndex((alternative) => alternative.token.trim() === trimmedToken);
}

/** Whitespace-only content renders as nothing in a plain text cell — this
 *  maps it to a glyph already in the app's approved mark set (issue #291
 *  §4.1: "a token whose text is whitespace or a newline must still be
 *  selectable and legible"). A token that mixes whitespace with visible
 *  characters keeps its own text; only a token that is *entirely*
 *  whitespace needs the substitution. */
export function tokenDisplayGlyph(token: string): string {
  if (token.length === 0 || token.trim().length > 0) return token;
  return [...token].map((char) => WHITESPACE_GLYPH[char] ?? "·").join("");
}

const WHITESPACE_GLYPH: Readonly<Record<string, string>> = {
  "\n": "↵",
  "\t": "→",
  " ": "·"
};

/** UTF-16 span of one step's token inside the take's stored text — the
 *  concatenation of every earlier step's token, offset by `textOffset`
 *  (shared/token-probabilities.ts). */
export function tokenProbabilitySpan(
  record: TokenProbabilityRecord,
  tokenIndex: number
): { readonly start: number; readonly end: number } {
  let start = record.textOffset;
  for (let index = 0; index < tokenIndex; index += 1) start += record.steps[index]?.token.length ?? 0;
  const token = record.steps[tokenIndex]?.token ?? "";
  return { start, end: start + token.length };
}

export type TokenProbabilityExcerptLine = WrappedLine<"selected">;

export interface TokenProbabilityExcerpt {
  readonly lines: readonly TokenProbabilityExcerptLine[];
  readonly truncatedStart: boolean;
  readonly truncatedEnd: boolean;
}

/** Wrap the take's whole text with the selected token as a style run, then
 *  keep only the window of lines around it — the whole part can run to
 *  thousands of words, and the viewer shows a passage, not the take. */
export function tokenProbabilityExcerpt(
  text: string,
  highlight: { readonly start: number; readonly end: number },
  measure: number,
  contextLines = 1
): TokenProbabilityExcerpt {
  const runs: StyleRun<"selected">[] = highlight.end > highlight.start
    ? [{ start: highlight.start, end: highlight.end, style: "selected" }]
    : [];
  const wrapped = wrapText(text, runs, Math.max(1, measure));
  const centerIndex = Math.max(0, wrapped.findIndex((line) =>
    line.start < highlight.end && line.end > highlight.start
  ));
  const from = Math.max(0, centerIndex - contextLines);
  const to = Math.min(wrapped.length, centerIndex + contextLines + 1);
  return {
    lines: wrapped.slice(from, to),
    truncatedStart: from > 0,
    truncatedEnd: to < wrapped.length
  };
}

/** Why the take has no token probabilities to show, and — only when the
 *  reason is one a different route could fix — which presets would. */
export interface TokenProbabilityEmptyReason {
  readonly text: string;
  readonly supportedPresets?: readonly string[];
}

const PRESET_LABEL: Readonly<Record<SettingsPresetV2, string>> = {
  "dry-run": "dry-run",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  anthropic: "Anthropic",
  "lm-studio": "LM Studio",
  ollama: "Ollama",
  "llama-cpp": "llama.cpp",
  koboldcpp: "KoboldCpp",
  custom: "custom"
};

const SUPPORTED_PRESET_LABELS: readonly string[] =
  TOKEN_PROBABILITY_SUPPORTED_PRESETS.map((preset) => PRESET_LABEL[preset]);

/** A take with no stored record still needs an honest reason. It reads the
 *  route that a *new* generation would use right now — the take's own
 *  history (feature off, a rewrite/summary/human take, a model refusal, an
 *  alignment that could not be reconciled) is not recoverable from the
 *  story alone, so a route that supports the feature today reports the
 *  plain "not requested" reason rather than guessing which of those it was. */
export function resolveTokenProbabilityEmptyReason(view: SettingsView): TokenProbabilityEmptyReason {
  if (view.dataFormat === 1) {
    return { text: tokenProbabilityUnavailableReason("legacy-v1") };
  }
  const route = selectSettingsRoute(view.document, "prose");
  const resolution = resolveTokenProbabilities(samplingContextForRoute(route));
  if (resolution.kind === "available") {
    return {
      text: "Press , for Settings. Set alt count (alternatives per token) to 1–20. Save, then generate again."
    };
  }
  const text = tokenProbabilityUnavailableReason(resolution.reason);
  return resolution.reason === "protocol" || resolution.reason === "preset-unknown"
    ? { text, supportedPresets: SUPPORTED_PRESET_LABELS }
    : { text };
}
