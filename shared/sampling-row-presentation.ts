import type { SamplingScalarKnobV2 } from "./settings-v2-types.js";

export type SamplingScalarKnob = SamplingScalarKnobV2;
export type SamplingListPanel = "stop" | "logit-bias" | "phrase-bias" | "banned-strings" | "dry-breakers";

export interface SamplingScalarPresentation {
  /** Amount `←→` moves the value by, in the knob's own unit. */
  readonly step: number;
  /** Where `←→` lands when nudging off a blank (`null`) field. */
  readonly neutral: number;
  readonly precision: number;
  /** How the numeric value reads when it is not a plain number — e.g.
   *  Mirostat's three states read `off` / `v1` / `v2`. Absent for every knob
   *  whose value is its own display string. */
  readonly format?: (value: number | null) => string;
  /** A standing hint shown only while the row is available. Absent for every
   *  knob whose zero has no documented, non-obvious meaning. */
  readonly hint?: string;
}

/** One entry per scalar knob, covering both its stepper geometry (read by
 *  `sampling-actions.ts`'s `←→` handler) and its presentation (read by
 *  `samplingScalarRows` below). A knob earns a `format` or `hint` entry here
 *  instead of a special case in the renderer, so the two tables this branch
 *  once kept alongside `sampling-actions.ts`'s stepper table cannot drift
 *  from each other or from the table they were merged into. */
export const SAMPLING_SCALAR_PRESENTATION: Readonly<Record<SamplingScalarKnob, SamplingScalarPresentation>> = {
  topP: { step: 0.05, neutral: 1, precision: 2 },
  topK: { step: 1, neutral: 0, precision: 0 },
  minP: { step: 0.01, neutral: 0, precision: 2 },
  frequencyPenalty: { step: 0.1, neutral: 0, precision: 1 },
  presencePenalty: { step: 0.1, neutral: 0, precision: 1 },
  repeatPenalty: { step: 0.05, neutral: 1, precision: 2 },
  seed: { step: 1, neutral: 1, precision: 0 },
  dryMultiplier: { step: 0.05, neutral: 0, precision: 2, hint: "0 disables" },
  dryBase: { step: 0.05, neutral: 1.75, precision: 2 },
  dryRange: { step: 64, neutral: 0, precision: 0, hint: "0 disables" },
  xtcThreshold: { step: 0.01, neutral: 0.1, precision: 2 },
  xtcProbability: { step: 0.05, neutral: 0, precision: 2, hint: "0 disables" },
  dynatempRange: { step: 0.05, neutral: 0, precision: 2, hint: "0 disables" },
  // Mirostat is the existing stepper, not new cycler machinery: `neutral: 1`
  // and `step: 1` make `←→` walk off (null) to v1 to v2 and back off through
  // the same crossing/clamping stepSamplingScalar already does for every
  // other scalar.
  mirostat: {
    step: 1,
    neutral: 1,
    precision: 0,
    format: (value) => value === null ? "off" : value === 1 ? "v1" : value === 2 ? "v2" : String(value)
  },
  mirostatTau: { step: 0.1, neutral: 5, precision: 1 },
  mirostatEta: { step: 0.01, neutral: 0.1, precision: 2 }
};

export function samplingScalarDisplay(knob: SamplingScalarKnob, value: number | null): string {
  const format = SAMPLING_SCALAR_PRESENTATION[knob].format;
  if (format !== undefined) return format(value);
  return value === null ? "default" : String(value);
}

export function samplingScalarHint(knob: SamplingScalarKnob): string {
  return SAMPLING_SCALAR_PRESENTATION[knob].hint ?? "";
}

export type SamplingLayerRowSpec =
  | { readonly kind: "scalar"; readonly knob: SamplingScalarKnob; readonly section?: string }
  | { readonly kind: "list"; readonly panel: SamplingListPanel; readonly section?: string };

/** The Sampling panel's focus stops, top to bottom. One entry per row —
 *  headings are never a focus stop. `section` marks the first row of a C-04
 *  group and carries the rule text the renderer paints above it; every other
 *  row leaves it unset. The four issue #282 list panels (stop, logit bias,
 *  phrase bias, banned strings) keep their existing order; every #292 knob
 *  is appended after them, per that branch's own ordering rule. */
export const SAMPLING_LAYER_ROWS: readonly SamplingLayerRowSpec[] = [
  { kind: "scalar", knob: "topP" },
  { kind: "scalar", knob: "topK" },
  { kind: "scalar", knob: "minP" },
  { kind: "scalar", knob: "frequencyPenalty" },
  { kind: "scalar", knob: "presencePenalty" },
  { kind: "scalar", knob: "repeatPenalty" },
  { kind: "scalar", knob: "seed" },
  { kind: "list", panel: "stop" },
  { kind: "list", panel: "logit-bias" },
  { kind: "list", panel: "phrase-bias" },
  { kind: "list", panel: "banned-strings" },
  { kind: "scalar", knob: "dryMultiplier", section: "dry · don't repeat yourself" },
  { kind: "scalar", knob: "dryBase" },
  { kind: "scalar", knob: "dryRange" },
  { kind: "list", panel: "dry-breakers" },
  { kind: "scalar", knob: "xtcThreshold", section: "xtc · exclude top choices" },
  { kind: "scalar", knob: "xtcProbability" },
  { kind: "scalar", knob: "dynatempRange", section: "temperature shaping" },
  { kind: "scalar", knob: "mirostat" },
  { kind: "scalar", knob: "mirostatTau" },
  { kind: "scalar", knob: "mirostatEta" }
];

