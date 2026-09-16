import type {
  ModelConnectionV2,
  SamplingScalarKnobV2,
  SettingsActivationOutcomeV2,
  SettingsPresetV2,
  SettingsProtocolV2
} from "../shared/settings-v2-types.js";
import { samplingKnobLabel } from "../shared/sampling-capabilities.js";
import type { GenerationProfileV5, ModelDefinitionV5, SettingsDocumentV5 } from "../shared/settings-v5-types.js";
import type { GenerationReasoningV5 } from "../shared/settings-v5-reasoning.js";
import { profileRoute, samplingForProfile, type SettingsEditorDraft, type SettingsEditorField, type SamplingListName } from "./renderer-settings-model.js";
import { scalar, select as controlSelect, toggle, type ScalarConfig } from "./renderer-controls.js";

export type Child = Node | string;

export interface SettingsEditorActions {
  readonly editField: (field: SettingsEditorField, value: string) => void;
  readonly editSamplingScalar: (knob: SamplingScalarKnobV2, value: string) => void;
  readonly editSamplingList: (list: SamplingListName, value: string) => void;
  readonly editHeader: (index: number, name: string, env: string) => void;
  readonly addHeader: () => void;
  readonly removeHeader: (index: number) => void;
  readonly selectProfile: (id: string) => void;
  readonly createProfile: () => void;
  readonly createConnection: () => void;
  readonly duplicateProfile: () => void;
  readonly renameProfile: () => void;
  readonly deleteProfile: () => void;
  readonly setSecret: (value: string) => void;
  readonly clearSecret: () => void;
  readonly useDiscoveredModel: (remoteId: string) => void;
  readonly discoverModels: () => void;
  readonly probeContext: () => void;
  readonly checkConnection: () => void;
  readonly save: () => void;
  readonly reload: () => void;
  readonly discardPending: () => void;
  /** Reverts the local draft to the last-applied document — no network
   * round trip, unlike `reload`, and distinct from `discardPending` (which
   * discards a saved-but-not-yet-active server candidate). */
  readonly discardDraft: () => void;
}

export interface SettingsEditorProps {
  /** The draft's own document — lists and pickers read this, so a record
   * created in the draft (a duplicated profile, say) shows immediately even
   * before it is applied. */
  readonly document: SettingsDocumentV5;
  /** The last-applied document, used only to name pending changes and mark
   * a route that points somewhere new (`describeSettingsChanges`). */
  readonly activeDocument: SettingsDocumentV5;
  readonly draft: SettingsEditorDraft;
  readonly discovery: readonly { remoteId: string; name: string; contextWindow: number | null; maxOutputTokens: number | null; source: string }[];
  readonly busy: string | null;
  readonly providerStatus?: { readonly kind: "ready" | "warning" | "error"; readonly message: string } | null;
  readonly error: string | null;
  readonly fieldErrors: Readonly<Record<string, string>>;
  readonly pendingRevision: number | null;
  readonly activeRevision: number;
  readonly lastActivationOutcome: SettingsActivationOutcomeV2 | null;
}

export function label(text: string): HTMLLabelElement {
  return node("label", "settings-field", text) as HTMLLabelElement;
}

export function node<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, ...children: Child[]): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className !== undefined) element.className = className;
  for (const child of children) {
    if (typeof child === "string") {
      if (child.length > 0) element.append(document.createTextNode(child));
    } else element.append(child);
  }
  return element;
}

export function button(className: string, text: string, action: () => void): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = `button ${className}`;
  element.textContent = text;
  element.addEventListener("click", action);
  return element;
}

export function inputField(
  props: SettingsEditorProps,
  actions: SettingsEditorActions,
  title: string,
  field: SettingsEditorField,
  value: string,
  type = "text",
  options: { min?: string; max?: string; step?: string; wide?: boolean; password?: boolean } = {}
): HTMLElement {
  const wrapper = label(title);
  if (options.wide === true) wrapper.classList.add("settings-field-wide");
  const input = document.createElement("input");
  const numeric = type === "number";
  input.type = options.password === true ? "password" : numeric ? "text" : type;
  if (numeric) input.inputMode = options.step !== undefined && options.step !== "1" ? "decimal" : "numeric";
  input.value = value;
  input.name = field;
  input.dataset.settingsField = field;
  input.classList.add("settings-control", settingsFieldClass(field));
  input.dataset.preserve = `settings:${field}`;
  input.setAttribute("aria-label", title);
  if (options.min !== undefined) input.min = options.min;
  if (options.max !== undefined) input.max = options.max;
  if (options.step !== undefined) input.step = options.step;
  input.addEventListener("input", () => actions.editField(field, input.value));
  wrapper.append(input);
  appendError(wrapper, props.fieldErrors[field]);
  return wrapper;
}

export function selectField(
  props: SettingsEditorProps,
  actions: SettingsEditorActions,
  title: string,
  field: SettingsEditorField,
  values: readonly string[],
  selected: string,
  labels?: Readonly<Record<string, string>>
): HTMLElement {
  const wrapper = label(title);
  const select = controlSelect(
    values.map((value) => ({ value, label: labels?.[value] ?? value })),
    selected,
    (value) => actions.editField(field, value)
  );
  select.name = field;
  select.dataset.settingsField = field;
  select.classList.add("settings-control", settingsFieldClass(field));
  select.dataset.preserve = `settings:${field}`;
  select.setAttribute("aria-label", title);
  wrapper.append(select);
  appendError(wrapper, props.fieldErrors[field]);
  return wrapper;
}

export function textAreaField(
  props: SettingsEditorProps,
  actions: SettingsEditorActions,
  title: string,
  field: SettingsEditorField,
  value: string,
  help?: string
): HTMLElement {
  const wrapper = label(title);
  wrapper.classList.add("settings-field-wide");
  const text = document.createElement("textarea");
  text.name = field;
  text.dataset.settingsField = field;
  text.classList.add("settings-control", settingsFieldClass(field));
  text.rows = 3;
  text.value = value;
  text.dataset.preserve = `settings:${field}`;
  text.setAttribute("aria-label", title);
  text.addEventListener("input", () => actions.editField(field, text.value));
  wrapper.append(text);
  if (help !== undefined) wrapper.append(node("small", "settings-help", help));
  appendError(wrapper, props.fieldErrors[field]);
  return wrapper;
}

/** D-21 toggle wired to a settings field. `positiveLabel`/`invert` cover the
 * one field (`profile.discardReasoning`) phrased as its own negation: the
 * control reads "Keep model thoughts" while the document stores the opposite
 * boolean. */
export function toggleField(
  props: SettingsEditorProps,
  actions: SettingsEditorActions,
  title: string,
  field: SettingsEditorField,
  on: boolean,
  invert = false
): HTMLElement {
  const control = toggle(title, on, (next) => actions.editField(field, String(invert ? !next : next)));
  control.dataset.settingsField = field;
  control.classList.add("settings-control", settingsFieldClass(field));
  control.dataset.preserve = `settings:${field}`;
  const wrapper = node("div", "settings-toggle-field", control);
  appendError(wrapper, props.fieldErrors[field]);
  return wrapper;
}

/** D-17 scalar wired to a settings field. `onChange` lets callers reuse this
 * for both plain profile/connection/model fields (`editField`) and sampling
 * scalars (`editSamplingScalar`), which take a different action shape. */
export function scalarField(
  props: SettingsEditorProps,
  title: string,
  field: string,
  bounds: Pick<ScalarConfig, "min" | "max" | "step" | "defaultValue">,
  value: number | null,
  onChange: (raw: string) => void
): HTMLElement {
  const wrapper = label(title);
  const control = scalar({
    ...bounds,
    value,
    id: `settings:${field}`,
    invalid: props.fieldErrors[field] !== undefined,
    onChange
  });
  const input = control.querySelector<HTMLInputElement>(".scalar-input")!;
  input.name = field;
  input.dataset.settingsField = field;
  input.classList.add("settings-control", settingsFieldClass(field));
  input.setAttribute("aria-label", title);
  wrapper.append(control);
  appendError(wrapper, props.fieldErrors[field]);
  return wrapper;
}

export function settingsProfileSummary(id: string, profile: GenerationProfileV5, route: string): HTMLElement {
  return node("article", `settings-profile-card ${route !== "unrouted" ? "routed" : ""}`,
    node("strong", "", profile.name || id),
    node("span", "settings-muted", `${route === "unrouted" ? "unrouted" : route} · ${profile.maxOutputTokens.toLocaleString()} max tokens`),
    node("span", "settings-muted", `${profile.modelId} · ${profile.cachePolicy}`)
  );
}

export function settingsConnectionSummary(id: string, connection: ModelConnectionV2): HTMLElement {
  const auth = connection.auth.type === "none" ? "no key" : connection.auth.type.replace("-stored", " key").replace("-env", " env");
  return node("article", "settings-connection-card",
    node("strong", "", connection.name || id),
    node("span", "settings-muted", `${connection.preset} · ${connection.protocol}`),
    node("span", "settings-muted", `${connection.baseUrl ?? "provider default"} · ${auth}`)
  );
}

export function providerLabel(preset: SettingsPresetV2): string {
  const labels: Partial<Record<SettingsPresetV2, string>> = {
    "dry-run": "Dry run",
    openai: "OpenAI",
    openrouter: "OpenRouter",
    anthropic: "Anthropic",
    "lm-studio": "LM Studio",
    ollama: "Ollama",
    "llama-cpp": "llama.cpp",
    koboldcpp: "KoboldCpp",
    custom: "Custom",
    "chatgpt-plan": "ChatGPT plan",
    "claude-plan": "Claude plan"
  };
  return labels[preset] ?? preset;
}

export function appendError(parent: HTMLElement, error: string | undefined): void {
  if (error !== undefined && error.length > 0) parent.append(node("span", "settings-error", error));
}

function settingsFieldClass(field: string): string {
  return `settings-control-${field.replace(/[^a-z0-9]+/giu, "-").replace(/^-|-$/gu, "")}`;
}

export function profileGenerationReasoning(reasoning: GenerationReasoningV5): { effort: string; thinkingMode: string } {
  return reasoning.kind === "independent"
    ? { effort: reasoning.effort, thinkingMode: reasoning.thinkingMode }
    : { effort: reasoning.effort, thinkingMode: "default" };
}

export function modelForDraft(draft: SettingsEditorDraft): ModelDefinitionV5 {
  return profileRoute(draft).model;
}

export function connectionForDraft(draft: SettingsEditorDraft): ModelConnectionV2 {
  return profileRoute(draft).connection;
}

export function profileForDraft(draft: SettingsEditorDraft): GenerationProfileV5 {
  return profileRoute(draft).profile;
}

export function samplingListValue(draft: SettingsEditorDraft, list: SamplingListName): string {
  const sampling = samplingForProfile(profileForDraft(draft));
  if (list === "logitBias") return Object.entries(sampling.logitBias).map(([key, value]) => `${key} | ${value}`).join("\n");
  if (list === "phraseBias") return sampling.phraseBias.map((entry) => `${entry.phrase} | ${entry.weight}`).join("\n");
  return (sampling[list] as readonly string[]).join("\n");
}

export function modelCapabilityValue(model: ModelDefinitionV5, key: keyof ModelDefinitionV5["capabilities"]): string {
  const value = model.capabilities[key];
  return value === undefined ? "unknown" : String(value);
}

export function routeLabel(document: SettingsDocumentV5, profileId: string): string {
  if (document.routing.default === profileId) return "default";
  if (document.routing.prose === profileId) return "prose";
  if (document.routing.utility === profileId) return "utility";
  return "unrouted";
}
