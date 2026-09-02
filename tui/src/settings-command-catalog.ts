import { samplingKnobLabel } from "../../shared/sampling-capabilities.js";
import {
  SAMPLING_LAYER_ROWS,
  samplingLayerRowIdentity,
  type SamplingListPanel,
  type SamplingLayerRowSpec,
  type SamplingScalarKnob
} from "./sampling-model.js";
import { samplingListPanelSpec } from "./sampling-panel-spec.js";
import { SETTINGS_ROW_IDS } from "./settings-row-navigation.js";

/** Rows that have a first-class command-palette entry. This is deliberately
 * derived from the Settings form registry so a new row cannot be added to the
 * form without a corresponding shortcut. */
export type SettingsShortcutRow = (typeof SETTINGS_ROW_IDS)[number];

export interface SettingsRowCommandTarget {
  readonly kind: "row";
  readonly row: SettingsShortcutRow;
}

export interface SamplingCommandTarget {
  readonly kind: "sampling";
  readonly row: SamplingLayerRowSpec;
}

export type SettingsCommandTarget = SettingsRowCommandTarget | SamplingCommandTarget;

export type SamplingCommandId =
  | `setting:sampling:scalar:${SamplingScalarKnob}`
  | `setting:sampling:list:${SamplingListPanel}`;

export type SettingsCommandId = `setting:${SettingsShortcutRow}` | SamplingCommandId;

export interface SettingsCommandCatalogEntry {
  readonly name: string;
  readonly description: string;
  /** Terms that should find this command without changing its visible name. */
  readonly searchTerms?: readonly string[];
}

/** The one metadata table for top-level Settings shortcuts. `satisfies` is
 * intentional: it turns a missing row into a compile-time error. */
export const SETTINGS_COMMAND_CATALOG = {
  theme: { name: "theme", description: "change the application colors" },
  apparatus: { name: "apparatus", description: "turn on the experimental apparatus" },
  "compose-focus": { name: "focus mode", description: "dim the story while writing" },
  "word-wrap": { name: "word wrap", description: "keep whole words together on wrapped lines" },
  "aside-thoughts": { name: "aside Thoughts", description: "show or hide render-only Aside thoughts" },
  "update-checks": { name: "update checks", description: "choose whether to check for newer versions" },
  "default-author-brief": {
    name: "default author brief",
    description: "set the machine-wide brief for prose and story names",
    searchTerms: ["system prompt", "default authors note", "default author's note"]
  },
  "default-continue-direction": {
    name: "default continue direction",
    description: "set the direction for a new empty Continue request"
  },
  "rewrite-guidance": { name: "rewrite guidance", description: "set standing Rewrite guidance" },
  "title-guidance": { name: "title guidance", description: "set standing Title guidance" },
  "summary-guidance": { name: "summary guidance", description: "set standing Summary guidance" },
  "aside-guidance": { name: "aside guidance", description: "set standing Aside guidance" },
  provider: { name: "provider", description: "choose the service that runs the model" },
  "text-prompt-format": {
    name: "prompt format",
    description: "choose the format for text-completion prompts"
  },
  "split-think-tags": {
    name: "split thoughts",
    description: "keep provider reasoning separate from story prose"
  },
  "base-url": { name: "base URL", description: "edit the model service address" },
  "allow-insecure-http": {
    name: "plain HTTP",
    description: "allow plain HTTP for a service you control"
  },
  "api-key": { name: "API key", description: "edit the saved service credential" },
  "timeout-headers": {
    name: "headers timeout",
    description: "set the response-header timeout"
  },
  "timeout-idle": { name: "idle timeout", description: "set the response idle timeout" },
  "timeout-total": { name: "total timeout", description: "set the total generation timeout" },
  profile: { name: "profile", description: "choose the active generation profile" },
  model: { name: "model", description: "choose the model" },
  "image-input": { name: "image input", description: "configure image input for the model" },
  temperature: { name: "temperature", description: "set response randomness" },
  "max-tokens": { name: "max tokens", description: "set the response length limit" },
  sampling: { name: "sampling", description: "open word-choice and repetition controls" },
  "context-window": { name: "context size", description: "set how much story context the model reads" },
  effort: { name: "effort", description: "choose the model reasoning effort" },
  "cache-policy": { name: "prompt cache", description: "choose the prompt cache policy" },
  "continuation-prompt": { name: "prompt layout", description: "choose the continuation prompt layout" },
  "token-probabilities": { name: "alternatives", description: "choose whether to request token alternatives" },
  reasoning: { name: "reasoning", description: "choose how model reasoning is handled" },
  "keep-thoughts": { name: "save thoughts", description: "choose whether to save model reasoning" },
  "default-route": { name: "default route", description: "choose the fallback generation profile" },
  "prose-route": { name: "prose route", description: "choose the profile for story prose" },
  "utility-route": { name: "utility route", description: "choose the profile for support tasks" }
} as const satisfies Readonly<Record<SettingsShortcutRow, SettingsCommandCatalogEntry>>;

export interface SettingsCommandDefinition {
  readonly id: SettingsCommandId;
  readonly section: "settings";
  readonly name: string;
  readonly description: string;
  readonly searchTerms?: readonly string[];
  readonly settingsTarget: SettingsCommandTarget;
}

export function settingsCommandId(row: SettingsShortcutRow): `setting:${SettingsShortcutRow}` {
  return `setting:${row}`;
}

export function samplingCommandId(row: SamplingLayerRowSpec): SamplingCommandId {
  return `setting:${samplingLayerRowIdentity(row)}` as SamplingCommandId;
}

export function settingsCommandTargetIdentity(target: SettingsCommandTarget): string {
  return target.kind === "row"
    ? target.row
    : samplingLayerRowIdentity(target.row);
}

function samplingCommandEntry(row: SamplingLayerRowSpec): SettingsCommandDefinition {
  const label = row.kind === "scalar"
    ? samplingKnobLabel(row.knob)
    : samplingKnobLabel(samplingListPanelSpec(row.panel).knob);
  return {
    id: samplingCommandId(row),
    section: "settings",
    name: `sampling ${label}`,
    description: `open the Sampling control for ${label}`,
    settingsTarget: { kind: "sampling", row }
  };
}

/** Canonical order: every top-level Settings row, followed by every Sampling
 * focus stop. The registries above own both completeness and ordering. */
export const SETTINGS_COMMAND_DEFINITIONS: readonly SettingsCommandDefinition[] = [
  ...SETTINGS_ROW_IDS.map((row): SettingsCommandDefinition => ({
    id: settingsCommandId(row),
    section: "settings",
    ...SETTINGS_COMMAND_CATALOG[row],
    settingsTarget: { kind: "row", row }
  })),
  ...SAMPLING_LAYER_ROWS.map(samplingCommandEntry)
];
