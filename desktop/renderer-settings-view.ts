import {
  WRITING_PROMPT_FIELD_DEFINITIONS,
  type WritingPromptFieldDefinition
} from "../shared/settings-v5-writing.js";
import {
  SAMPLING_SCALAR_KNOB_V2_VALUES,
  SETTINGS_PRESET_V2_VALUES,
  SETTINGS_PROTOCOL_V2_VALUES,
  TEXT_PROMPT_FORMAT_V2_VALUES
} from "../shared/settings-v2-types.js";
import { SAMPLING_SCALAR_DESCRIPTORS } from "../shared/sampling-validation-policy.js";
import { samplingKnobLabel } from "../shared/sampling-capabilities.js";
import { MAX_ALTERNATIVE_TOKENS } from "../shared/token-probability-policy.js";
import { profileRoute, samplingForProfile } from "./renderer-settings-model.js";
import {
  button,
  connectionForDraft,
  inputField,
  modelCapabilityValue,
  modelForDraft,
  node,
  profileForDraft,
  profileGenerationReasoning,
  providerLabel,
  routeLabel,
  scalarField,
  selectField,
  settingsConnectionSummary,
  settingsProfileSummary,
  textAreaField,
  toggleField,
  type SettingsEditorActions,
  type SettingsEditorProps
} from "./renderer-settings-controls.js";

/** Renderer-only defaults for the D-17 `┆` tick. The settings document has
 * no canonical "default" for these — sampling knobs go blank to mean
 * "provider default" and the timeouts are client-side operational bounds —
 * so these follow common llama.cpp/OpenAI-compatible baselines. Documented
 * here rather than silently invented in `shared/`, which this phase does
 * not touch. */
const SAMPLING_SCALAR_DEFAULTS: Readonly<Record<string, number>> = {
  topP: 1, topK: 0, minP: 0, frequencyPenalty: 0, presencePenalty: 0, repeatPenalty: 1,
  seed: 0, dryMultiplier: 0, dryBase: 1.75, dryRange: 0, xtcThreshold: 0.1, xtcProbability: 0,
  dynatempRange: 0, mirostat: 0, mirostatTau: 5, mirostatEta: 0.1
};
const TIMEOUT_DEFAULTS_MS = { responseHeaderMs: 30_000, firstTokenMs: 30_000, idleMs: 30_000, totalMs: 300_000 } as const;

export function section(title: string, description: string, ...children: (Node | string)[]): HTMLElement {
  return node("section", "settings-section",
    node("div", "settings-section-heading", node("span", "eyebrow", title), node("h3", "", title), node("p", "", description)),
    ...children
  );
}

export function renderProfilesSection(props: SettingsEditorProps, actions: SettingsEditorActions): HTMLElement {
  const draft = props.draft;
  const list = node("div", "settings-profile-list");
  for (const id of Object.keys(props.document.profiles)) {
    const profile = props.document.profiles[id];
    if (profile === undefined) continue;
    const row = node("button", `settings-profile-select ${draft.selectedProfileId === id ? "active" : ""}`);
    row.type = "button";
    row.dataset.preserve = `settings:profile:${id}`;
    row.setAttribute("aria-pressed", String(draft.selectedProfileId === id));
    row.append(settingsProfileSummary(id, profile, routeLabel(props.document, id)));
    row.addEventListener("click", () => actions.selectProfile(id));
    list.append(row);
  }
  const controls = node("div", "settings-profile-actions",
    button("settings-profile-create", "+ New profile", actions.createProfile),
    button("settings-connection-create", "+ New connection", actions.createConnection),
    button("settings-profile-duplicate", "Duplicate", actions.duplicateProfile),
    button("settings-profile-rename", "Rename", actions.renameProfile),
    button("settings-profile-delete", "Delete", actions.deleteProfile)
  );
  const profile = profileForDraft(draft);
  return section("Profiles", "Profiles group a model with generation controls. Routes point to these profile IDs.", list, controls,
    node("p", "settings-muted", `Editing ${profile.name || draft.selectedProfileId}. Changes stay in the typed draft until you apply them.`)
  );
}

export function renderConnectionsSection(props: SettingsEditorProps, actions: SettingsEditorActions): HTMLElement {
  const draft = props.draft;
  const connection = connectionForDraft(draft);
  const auth = connection.auth;
  const fields: Node[] = [
    inputField(props, actions, "Connection name", "connection.name", connection.name),
    selectField(props, actions, "Provider preset", "connection.preset", SETTINGS_PRESET_V2_VALUES, connection.preset, Object.fromEntries(SETTINGS_PRESET_V2_VALUES.map((value) => [value, providerLabel(value)]))),
    selectField(props, actions, "Transport protocol", "connection.protocol", SETTINGS_PROTOCOL_V2_VALUES, connection.protocol),
    inputField(props, actions, "Base URL", "connection.baseUrl", connection.baseUrl ?? "", "url", { wide: true }),
    toggleField(props, actions, "Allow insecure HTTP on a LAN host", "connection.allowInsecureHttp", connection.allowInsecureHttp === true)
  ];
  if (connection.protocol === "text-completions") {
    fields.push(
      selectField(props, actions, "Text prompt format", "connection.textPromptFormat", ["", ...TEXT_PROMPT_FORMAT_V2_VALUES], connection.textPromptFormat ?? "", { "": "raw (default)" }),
      toggleField(props, actions, "Split <think> tags into model thoughts", "connection.splitThinkTags", connection.splitThinkTags === true)
    );
  }
  const authFields = node("div", "settings-form", ...fields,
    selectField(props, actions, "Authentication", "connection.authType", ["none", "bearer-env", "bearer-stored", "header-env", "header-stored"], auth.type, {
      none: "None",
      "bearer-env": "Bearer from environment",
      "bearer-stored": "Bearer stored in machine tier",
      "header-env": "Header from environment",
      "header-stored": "Header stored in machine tier"
    })
  );
  if (auth.type === "bearer-env" || auth.type === "header-env") {
    authFields.append(inputField(props, actions, "Environment variable", "connection.authEnv", auth.env));
  }
  if (auth.type === "header-env" || auth.type === "header-stored") {
    authFields.append(inputField(props, actions, "Authentication header", "connection.authHeader", auth.name));
  }
  if (auth.type === "bearer-stored" || auth.type === "header-stored") {
    const key = document.createElement("label");
    key.className = "settings-field settings-field-wide";
    key.append(node("span", "", "Pending secret"));
    const input = document.createElement("input");
    input.type = "password";
    input.value = draft.connectionSecrets[auth.secretId] ?? "";
    input.placeholder = "Leave blank to keep the stored key";
    input.dataset.preserve = `settings:secret:${auth.secretId}`;
    input.addEventListener("input", () => actions.setSecret(input.value));
    key.append(input, button("settings-secret-clear", "Remove stored key", actions.clearSecret), node("small", "settings-help", `Secret ID: ${auth.secretId}. The value stays outside the settings document.`));
    authFields.append(key);
  }
  authFields.append(renderHeaders(connection, actions));
  authFields.append(node("div", "settings-subheading", node("strong", "", "Request timeouts")));
  authFields.append(
    scalarField(props, "Response headers (ms)", "connection.responseHeaderMs", { min: 1, max: 86_400_000, step: 1_000, defaultValue: TIMEOUT_DEFAULTS_MS.responseHeaderMs }, connection.timeouts.responseHeaderMs, (raw) => actions.editField("connection.responseHeaderMs", raw)),
    scalarField(props, "First token (ms)", "connection.firstTokenMs", { min: 1, max: 86_400_000, step: 1_000, defaultValue: TIMEOUT_DEFAULTS_MS.firstTokenMs }, connection.timeouts.firstTokenMs, (raw) => actions.editField("connection.firstTokenMs", raw)),
    scalarField(props, "Idle (ms)", "connection.idleMs", { min: 1, max: 86_400_000, step: 1_000, defaultValue: TIMEOUT_DEFAULTS_MS.idleMs }, connection.timeouts.idleMs, (raw) => actions.editField("connection.idleMs", raw)),
    scalarField(props, "Total (ms)", "connection.totalMs", { min: 1, max: 86_400_000, step: 1_000, defaultValue: TIMEOUT_DEFAULTS_MS.totalMs }, connection.timeouts.totalMs, (raw) => actions.editField("connection.totalMs", raw))
  );
  const probe = node("div", "settings-probe-actions",
    button("settings-check", props.busy === "check" ? "Checking…" : "Check connection", actions.checkConnection),
    button("settings-probe", props.busy === "probe" ? "Probing…" : "Probe context", actions.probeContext),
    button("settings-discover", props.busy === "discover" ? "Discovering…" : "Discover models", actions.discoverModels)
  );
  for (const control of probe.querySelectorAll("button")) (control as HTMLButtonElement).disabled = props.busy !== null;
  const status = props.providerStatus === undefined || props.providerStatus === null
    ? ""
    : node("p", `settings-provider-status ${props.providerStatus.kind}`, props.providerStatus.message);
  return section("Connections", "The selected profile uses this provider route. Keys remain in the machine tier.", authFields, probe, status,
    renderModelSubsection(props, actions),
    node("div", "settings-connection-catalog", ...Object.entries(props.document.connections).map(([id, item]) => settingsConnectionSummary(id, item)))
  );
}

function renderHeaders(connection: ReturnType<typeof connectionForDraft>, actions: SettingsEditorActions): HTMLElement {
  const wrapper = node("div", "settings-headers settings-field-wide", node("div", "settings-subheading", node("strong", "", "Secret headers")));
  connection.headers.forEach((header, index) => {
    const row = node("div", "settings-header-row");
    row.dataset.preserve = `settings:header:${index}`;
    const name = document.createElement("input");
    name.value = header.name;
    name.placeholder = "Header name";
    name.dataset.preserve = `settings:header:${index}:name`;
    const env = document.createElement("input");
    env.value = header.value.env;
    env.placeholder = "Environment variable";
    env.dataset.preserve = `settings:header:${index}:env`;
    const update = (): void => actions.editHeader(index, name.value, env.value);
    name.addEventListener("input", update);
    env.addEventListener("input", update);
    row.append(name, env, button("settings-header-remove", "Remove", () => {
      actions.removeHeader(index);
      const fallbackIndex = Math.min(index, connection.headers.length - 2);
      if (fallbackIndex >= 0) {
        queueMicrotask(() => {
          document.querySelector<HTMLElement>(
            `[data-preserve="settings:header:${fallbackIndex}"] .settings-header-remove`
          )?.focus();
        });
      }
    }));
    wrapper.append(row);
  });
  wrapper.append(button("settings-header-add", "+ Add secret header", actions.addHeader));
  return wrapper;
}

function renderModelSubsection(props: SettingsEditorProps, actions: SettingsEditorActions): HTMLElement {
  const draft = props.draft;
  const model = modelForDraft(draft);
  const discovered = props.discovery;
  const cards = discovered.length === 0
    ? node("p", "settings-muted", "No discovery result. Use Discover models for this provider.")
    : node("div", "settings-discovery-list", ...discovered.map((item) => {
        const use = button("settings-model-use", "Use", () => actions.useDiscoveredModel(item.remoteId));
        const card = node("article", "settings-discovery-card", node("strong", "", item.name), node("span", "settings-muted", `${item.remoteId} · ${item.source}`), node("span", "settings-muted", `${item.contextWindow ?? "?"} context · ${item.maxOutputTokens ?? "?"} max tokens`), use);
        card.dataset.preserve = `settings:discovery:${item.remoteId}`;
        return card;
      }));
  const capabilities = node("div", "settings-form settings-capabilities",
    selectField(props, actions, "Temperature support", "model.temperature", ["supported", "unsupported", "unknown"], modelCapabilityValue(model, "temperature")),
    selectField(props, actions, "Assistant prefill", "model.assistantPrefill", ["supported", "unsupported", "unknown"], modelCapabilityValue(model, "assistantPrefill")),
    selectField(props, actions, "Image input", "model.imageInput", ["supported", "unsupported", "unknown"], modelCapabilityValue(model, "imageInput")),
    selectField(props, actions, "Reasoning effort support", "model.reasoningEffort", ["supported", "unsupported", "unknown"], modelCapabilityValue(model, "reasoningEffort")),
    selectField(props, actions, "Reasoning content", "model.reasoningContent", ["supported", "unsupported", "unknown"], modelCapabilityValue(model, "reasoningContent")),
    selectField(props, actions, "Prompt caching", "model.promptCaching", ["supported", "unsupported", "unknown"], modelCapabilityValue(model, "promptCaching")),
    scalarField(props, "Image token ceiling", "model.imageTokenCeiling", { min: 1, max: 1_000_000_000, step: 1_000, defaultValue: model.discovered.maxOutputTokens ?? 0 }, model.capabilities.imageTokenCeiling ?? null, (raw) => actions.editField("model.imageTokenCeiling", raw))
  );
  return node("div", "settings-model-subsection",
    node("div", "settings-subheading", node("strong", "", "Model discovery and context")),
    node("div", "settings-form",
      selectField(props, actions, "Model record", "profile.modelId", Object.keys(props.document.models), draft.document.profiles[draft.selectedProfileId]?.modelId ?? "", Object.fromEntries(Object.entries(props.document.models).map(([id, item]) => [id, item.name || id]))),
      inputField(props, actions, "Remote model ID", "model.remoteId", model.remoteId, "text", { wide: true }),
      inputField(props, actions, "Model display name", "model.name", model.name),
      scalarField(props, "Context window override", "model.contextWindow", { min: 1, max: 1_000_000_000, step: 1_000, defaultValue: model.discovered.contextWindow ?? 0 }, model.overrides.contextWindow ?? null, (raw) => actions.editField("model.contextWindow", raw)),
      scalarField(props, "Output limit override", "model.maxOutputTokens", { min: 1, max: 1_000_000_000, step: 100, defaultValue: model.discovered.maxOutputTokens ?? 0 }, model.overrides.maxOutputTokens ?? null, (raw) => actions.editField("model.maxOutputTokens", raw))
    ),
    node("div", "settings-discovered-meta", `Discovered context ${model.discovered.contextWindow ?? "unknown"}; discovered output limit ${model.discovered.maxOutputTokens ?? "unknown"}.`),
    capabilities,
    cards
  );
}

export function renderSamplingSection(props: SettingsEditorProps, actions: SettingsEditorActions): HTMLElement {
  const profile = profileForDraft(props.draft);
  const sampling = samplingForProfile(profile);
  const temperatureField = scalarField(
    props,
    "Temperature",
    "profile.temperature",
    { min: -100, max: 100, step: 0.01, defaultValue: 1 },
    profile.temperature,
    (raw) => actions.editField("profile.temperature", raw)
  );
  const scalarFields = SAMPLING_SCALAR_KNOB_V2_VALUES.map((knob) => {
    const descriptor = SAMPLING_SCALAR_DESCRIPTORS[knob];
    return scalarField(
      props,
      samplingKnobLabel(knob),
      `sampling.${knob}`,
      { min: descriptor.minimum, max: descriptor.maximum, step: descriptor.integer ? 1 : 0.01, defaultValue: SAMPLING_SCALAR_DEFAULTS[knob] ?? descriptor.minimum },
      sampling[knob],
      (raw) => actions.editSamplingScalar(knob, raw)
    );
  });
  const lists: [string, string, string][] = [
    ["stop", "Stop sequences", sampling.stop.join("\n")],
    ["logitBias", "Logit bias", Object.entries(sampling.logitBias).map(([key, value]) => `${key} | ${value}`).join("\n")],
    ["phraseBias", "Phrase bias", sampling.phraseBias.map((entry) => `${entry.phrase} | ${entry.weight}`).join("\n")],
    ["bannedStrings", "Banned strings", sampling.bannedStrings.join("\n")],
    ["dryBreakers", "DRY breakers", sampling.dryBreakers.join("\n")]
  ];
  const listFields = lists.map(([list, title, value]) => samplingListField(props, actions, list, title, value));
  return section("Sampling", "Bars are output, brackets are input: ‹ › opens a typed field, and ┆ marks a renderer-assumed default. Blank values use the provider's own default.",
    node("div", "settings-form settings-sampling-scalars", temperatureField, ...scalarFields),
    node("div", "settings-sampling-lists", ...listFields)
  );
}

function samplingListField(props: SettingsEditorProps, actions: SettingsEditorActions, list: string, title: string, value: string): HTMLElement {
  const wrapper = node("label", "settings-sampling-field", title) as HTMLLabelElement;
  const text = document.createElement("textarea");
  text.rows = 4;
  text.value = value;
  text.placeholder = list === "phraseBias" || list === "logitBias" ? "one value | weight per line" : "one value per line";
  text.dataset.settingsField = `sampling.${list}`;
  text.classList.add("settings-control", `settings-control-sampling-${list}`);
  text.dataset.preserve = `settings:sampling:${list}`;
  text.addEventListener("input", () => actions.editSamplingList(list as Parameters<SettingsEditorActions["editSamplingList"]>[0], text.value));
  wrapper.append(text);
  const error = props.fieldErrors[`sampling.${list}`];
  if (error !== undefined && error.length > 0) wrapper.append(node("span", "settings-error", error));
  return wrapper;
}

export function renderRoutesSection(props: SettingsEditorProps, actions: SettingsEditorActions): HTMLElement {
  const profiles = Object.keys(props.document.profiles);
  const labels = { "": "Same as the default route", ...Object.fromEntries(profiles.map((id) => [id, props.document.profiles[id]?.name || id])) };
  const routeCard = (title: string, hint: string, field: "route.default" | "route.prose" | "route.utility", options: readonly string[], selected: string): HTMLElement => {
    const active = props.activeDocument.routing;
    const pending = selected !== (field === "route.default" ? active.default : field === "route.prose" ? active.prose ?? "" : active.utility ?? "");
    return node("article", "settings-route-card",
      node("div", "settings-route-copy", node("h4", "", title), node("p", "", hint)),
      selectField(props, actions, "Profile", field, options, selected, labels),
      pending ? node("span", "chip outline settings-route-pending", "PENDING") : ""
    );
  };
  return section("Routes", "Each operation reads one Generation Profile. An unset prose or utility route falls back to the default.",
    routeCard("Default route", "Used when a task does not have its own profile.", "route.default", profiles, props.document.routing.default),
    routeCard("Prose route", "Used to write and rewrite story prose.", "route.prose", ["", ...profiles], props.document.routing.prose ?? ""),
    routeCard("Utility route", "Used for summaries and other support tasks (aside, autoname, fact check).", "route.utility", ["", ...profiles], props.document.routing.utility ?? "")
  );
}

export function renderOutputReasoningSection(props: SettingsEditorProps, actions: SettingsEditorActions): HTMLElement {
  const profile = profileForDraft(props.draft);
  const reasoning = profileGenerationReasoning(profile.generationReasoning);
  const model = modelForDraft(props.draft);
  return section("Output & reasoning", "Set the model response shape, reasoning behavior, and cache policy.",
    node("div", "settings-form",
      scalarField(props, "Maximum output tokens", "profile.maxOutputTokens", { min: 1, max: 1_000_000_000, step: 100, defaultValue: model.discovered.maxOutputTokens ?? 1_024 }, profile.maxOutputTokens, (raw) => actions.editField("profile.maxOutputTokens", raw)),
      selectField(props, actions, "Reasoning effort", "profile.effort", ["default", "minimal", "low", "medium", "high", "xhigh", "max"], reasoning.effort),
      selectField(props, actions, "Thinking mode", "profile.thinkingMode", ["default", "on", "off"], reasoning.thinkingMode),
      selectField(props, actions, "Reasoning display", "profile.reasoning", ["off", "marker", "open"], profile.reasoning ?? "marker"),
      selectField(props, actions, "Prompt cache", "profile.cachePolicy", ["off", "auto", "long"], profile.cachePolicy),
      scalarField(props, "Token alternatives", "profile.tokenProbabilities", { min: 1, max: MAX_ALTERNATIVE_TOKENS, step: 1, defaultValue: 1 }, profile.tokenProbabilities ?? null, (raw) => actions.editField("profile.tokenProbabilities", raw)),
      toggleField(props, actions, "Keep model thoughts", "profile.discardReasoning", profile.discardReasoning !== true, true),
      selectField(props, actions, "Continuation prompt layout", "profile.continuationPromptOptimization", ["", "late-cache-stable"], profile.continuationPromptOptimization ?? "", { "": "Compatibility (default)", "late-cache-stable": "Late cache stable" })
    )
  );
}

export function renderWritingPromptsSection(props: SettingsEditorProps, actions: SettingsEditorActions): HTMLElement {
  const fields = WRITING_PROMPT_FIELD_DEFINITIONS.map((definition) => writingField(props, actions, definition));
  return section("Writing prompts", "These prompts apply across prose, titles, summaries, rewrites, and Aside requests.", node("div", "settings-writing-fields", ...fields));
}

function writingField(props: SettingsEditorProps, actions: SettingsEditorActions, definition: WritingPromptFieldDefinition): HTMLElement {
  return textAreaField(props, actions, definition.title, `writing.${definition.field}`, props.document.writing[definition.field], `${definition.help} ${definition.emptyBehavior}.`);
}
