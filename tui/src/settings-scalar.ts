import {
  DEFAULT_PROFILE_MAX_OUTPUT_TOKENS,
  DEFAULT_PROFILE_TEMPERATURE
} from "../../shared/settings-v2-types.js";
import type { GenerationSettings } from "../../shared/types.js";
import type { SettingsRowId } from "./state.js";

/** The three settable numbers on the Settings surface. Every one of them is a
 *  C-08 scalar: a stepper chip, a positional track, and `↵` to type. */
export type SettingsScalarRow = "temperature" | "max-tokens" | "context-window";

const SCALAR_ROWS: ReadonlySet<SettingsRowId> = new Set<SettingsRowId>([
  "temperature",
  "max-tokens",
  "context-window"
]);

export function isSettingsScalarRow(row: SettingsRowId): row is SettingsScalarRow {
  return SCALAR_ROWS.has(row);
}

/** One scalar's bounds, its stepping, and what an unset value means.
 *
 *  `max === null` is C-08's unbounded variant: the chip stays, the track goes,
 *  because a track against an unknown wall would be a bar against a guess. */
export interface SettingsScalar {
  readonly row: SettingsScalarRow;
  /** null means the sentinel is showing rather than a number. */
  readonly value: number | null;
  readonly min: number;
  readonly max: number | null;
  readonly step: number;
  /** Where the `┊` tick sits, or null when the row has no default to mark. */
  readonly defaultValue: number | null;
  readonly decimals: number;
  /** What `null` reads as (C-08 sentinel variant), or null on a row that always
   *  holds a number. A row with no sentinel can never be unset. */
  readonly sentinel: string | null;
  /** The value the sentinel opens on when the writer steps off it. */
  readonly sentinelEntry: number;
}

/** `⇧` multiplies the step by ten, on every scalar. */
export const SCALAR_COARSE_MULTIPLIER = 10;

/** How far one stepping key moves a scalar. Declared once, here, so a fourth
 *  magnitude is one edit rather than three. */
export type ScalarMagnitude = "step" | "coarse" | "end";

/** The widest context window worth stepping to. Not a hard limit — the typed
 *  field still accepts anything the parser does — it is the wall the track
 *  measures against, and stepping stops there rather than clamping a keystroke
 *  the writer typed. */
const CONTEXT_WINDOW_CEILING = 1_000_000;

/** Where the `┊` tick sits: the value a fresh profile ships with, so the
 *  writer can see at a glance how far from it they have moved. */
const DEFAULT_TEMPERATURE = DEFAULT_PROFILE_TEMPERATURE;
const DEFAULT_MAX_TOKENS = DEFAULT_PROFILE_MAX_OUTPUT_TOKENS;

export function settingsScalar(
  row: SettingsScalarRow,
  settings: GenerationSettings
): SettingsScalar {
  if (row === "temperature") {
    return {
      row,
      value: settings.temperature,
      min: 0,
      max: 2,
      step: 0.05,
      defaultValue: DEFAULT_TEMPERATURE,
      decimals: 2,
      sentinel: "default",
      sentinelEntry: DEFAULT_TEMPERATURE
    };
  }
  if (row === "max-tokens") {
    // The response cannot outgrow the window it has to fit inside, so a known
    // window is the honest wall. Without one there is no wall to measure
    // against: C-08's unbounded variant keeps the chip and drops the track,
    // rather than inventing a ceiling that would call a valid value invalid.
    return {
      row,
      value: settings.maxTokens,
      min: 1,
      max: settings.contextWindow,
      step: 64,
      defaultValue: DEFAULT_MAX_TOKENS,
      decimals: 0,
      // Max tokens always holds a number, so it has no sentinel to fall to.
      sentinel: null,
      sentinelEntry: DEFAULT_MAX_TOKENS
    };
  }
  return {
    row,
    value: settings.contextWindow,
    min: 1,
    max: CONTEXT_WINDOW_CEILING,
    step: 1_024,
    defaultValue: null,
    decimals: 0,
    sentinel: "auto",
    sentinelEntry: 8_192
  };
}

/** The value after one step. Stepping never leaves the bounds, and stepping
 *  down off the floor returns to the sentinel where a row has one, so `auto`
 *  and `default` stay reachable without typing. */
export function steppedScalarValue(
  scalar: SettingsScalar,
  direction: -1 | 1,
  magnitude: ScalarMagnitude
): number | null {
  const max = scalar.max ?? Number.POSITIVE_INFINITY;
  if (magnitude === "end") return direction === 1 ? scalar.max ?? scalar.value : scalar.min;
  if (scalar.value === null) return direction === 1 ? scalar.sentinelEntry : null;
  const step = scalar.step * (magnitude === "coarse" ? SCALAR_COARSE_MULTIPLIER : 1);
  const raw = scalar.value + step * direction;
  if (raw < scalar.min) {
    // Stepping down off the floor returns to the sentinel where the row has
    // one, so `auto` and `default` stay reachable without typing.
    return scalar.sentinel !== null && scalar.value === scalar.min ? null : scalar.min;
  }
  return round(Math.min(max, raw), scalar.decimals);
}

/** The chip's text: the number as the row spells it, or the sentinel word.
 *  C-08 keeps `◇` out of the chip — it sits left of the track, which stays on
 *  screen so the range is still readable while the row is unset. */
export function scalarChipText(scalar: SettingsScalar): string {
  if (scalar.value === null) return scalar.sentinel ?? "unset";
  return scalar.decimals > 0
    ? scalar.value.toFixed(scalar.decimals)
    : Math.round(scalar.value).toLocaleString("en-US");
}

/** The same scalar carrying whatever has been typed into its field, so C-08's
 *  typing state keeps its live track and its limit: "it updates live as you
 *  type", and "out of range pins the handle to the wall … it never clamps your
 *  keystrokes". Returns null while the text is not a number the row accepts. */
export function typedScalarValue(
  scalar: SettingsScalar,
  text: string
): { scalar: SettingsScalar } | { refused: string } {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return scalar.sentinel === null
      ? { refused: "this row needs a number" }
      : { scalar: { ...scalar, value: null } };
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return { refused: "not a number" };
  if (scalar.decimals === 0 && !Number.isInteger(value)) {
    return { refused: "whole numbers only" };
  }
  return { scalar: { ...scalar, value } };
}

/** Why the current value is refused, or null while it is fine. The reason is
 *  what F-2 shows in the hint slot; it never blocks a keystroke. */
export function scalarInvalidReason(scalar: SettingsScalar): string | null {
  if (scalar.value === null) return null;
  if (scalar.value < scalar.min) {
    return `min is ${formatBound(scalar, scalar.min)}`;
  }
  if (scalar.max !== null && scalar.value > scalar.max) {
    return `max is ${formatBound(scalar, scalar.max)}`;
  }
  return null;
}

export interface ScalarTrack {
  /** Cells before the handle, filled. */
  readonly filled: number;
  /** Cells after the handle. */
  readonly rest: number;
  /** Offset of the `┊` default tick within the track, or null. */
  readonly tick: number | null;
  /** The handle glyph: `◆` in range, `▌` pinned to a wall it ran past, and
   *  null while the sentinel holds the row — there is no position to mark. */
  readonly handle: string | null;
  /** `◇` where the sentinel is showing, otherwise the low bound. */
  readonly minLabel: string;
  readonly maxLabel: string;
}

/** The positional track: filled to the handle, dim after it, with a `┊` tick
 *  where the default sits. Out of range pins the handle to the wall as `▌`
 *  rather than clamping the value the writer asked for.
 *
 *  The sentinel keeps the track: `◇` takes the low-bound slot and the run stays
 *  dim, so an unset row still shows the range its default sits in. */
export function scalarTrack(scalar: SettingsScalar, cells: number): ScalarTrack | null {
  if (scalar.max === null || cells < 3) return null;
  const span = scalar.max - scalar.min;
  if (span <= 0) return null;
  const tick = scalar.defaultValue === null
    ? null
    : Math.round(Math.min(1, Math.max(0, (scalar.defaultValue - scalar.min) / span)) * (cells - 1));
  const maxLabel = formatBound(scalar, scalar.max);
  if (scalar.value === null) {
    return { filled: 0, rest: cells, tick, handle: null, minLabel: "◇", maxLabel };
  }
  const share = (scalar.value - scalar.min) / span;
  const pinned = share < 0 || share > 1;
  const position = Math.round(Math.min(1, Math.max(0, share)) * (cells - 1));
  return {
    filled: position,
    rest: cells - position - 1,
    tick,
    handle: pinned ? "▌" : "◆",
    minLabel: formatBound(scalar, scalar.min),
    maxLabel
  };
}

function formatBound(scalar: SettingsScalar, value: number): string {
  if (scalar.decimals > 0) return value.toFixed(scalar.decimals);
  return value >= 1_000
    ? `${Math.round(value / 1_000).toLocaleString("en-US")}k`
    : value.toLocaleString("en-US");
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
