import { parseFactKeys } from "./fact-keys.js";
import {
  DEFAULT_FACT_SCAN_PARTS,
  parseFactActivation,
  parseFactPriority,
  parseFactRecursion,
  parseFactScanDepth,
  parseFactSecondaryMode,
  type FactActivation,
  type FactPriority,
  type FactRecursion,
  type FactSecondaryMode
} from "./fact-metadata.js";

export interface FactMetadata {
  activation: FactActivation;
  keys: string[];
  priority: FactPriority;
  secondaryKeys: string[];
  secondaryMode: FactSecondaryMode;
  scanDepth: number;
  recursion: FactRecursion;
}

export interface FactMetadataInput {
  readonly activation?: unknown;
  readonly keys?: unknown;
  readonly priority?: unknown;
  readonly secondaryKeys?: unknown;
  readonly secondaryMode?: unknown;
  readonly scanDepth?: unknown;
  readonly recursion?: unknown;
}

export function parseFactMetadata(values: FactMetadataInput, label = "Fact"): FactMetadata {
  return {
    activation: values.activation === undefined ? "always" : parseFactActivation(values.activation, `${label} activation`),
    keys: values.keys === undefined ? [] : parseFactKeys(values.keys, `${label} keys`),
    priority: values.priority === undefined ? "normal" : parseFactPriority(values.priority, `${label} priority`),
    secondaryKeys: values.secondaryKeys === undefined ? [] : parseFactKeys(values.secondaryKeys, `${label} secondaryKeys`),
    secondaryMode: values.secondaryMode === undefined ? "and" : parseFactSecondaryMode(values.secondaryMode, `${label} secondaryMode`),
    scanDepth: values.scanDepth === undefined ? DEFAULT_FACT_SCAN_PARTS : parseFactScanDepth(values.scanDepth, `${label} scanDepth`),
    recursion: values.recursion === undefined ? "on" : parseFactRecursion(values.recursion, `${label} recursion`)
  };
}
