import {
  WRITING_PROMPT_FIELD_DEFINITIONS,
  type WritingPromptFieldDefinition
} from "../shared/settings-v5-writing.js";
import {
  SAMPLING_SCALAR_KNOB_V2_VALUES,
  SETTINGS_PRESET_V2_VALUES,
  SETTINGS_PROTOCOL_V2_VALUES,
  TEXT_PROMPT_FORMAT_V2_VALUES,
  type SamplingScalarKnobV2
} from "../shared/settings-v2-types.js";
import { SAMPLING_SCALAR_DESCRIPTORS } from "../shared/sampling-validation-policy.js";
import { samplingKnobLabel } from "../shared/sampling-capabilities.js";
import { profileRoute, samplingForProfile, type SamplingListName } from "./renderer-settings-model.js";
import {
  button,
  checkboxField,
  connectionForDraft,
  inputField,
  modelCapabilityValue,
  modelForDraft,
  node,
  profileForDraft,
  profileGenerationReasoning,
  providerLabel,
  routeLabel,
  samplingListValue,
  selectField,
  settingsConnectionSummary,
  settingsProfileSummary,
  textAreaField,
  type SettingsEditorActions,
  type SettingsEditorProps
} from "./renderer-settings-controls.js";
import type { SettingsActivationErrorCodeV2, SettingsActivationOutcomeV2 } from "../shared/settings-v2-types.js";

export function renderSettingsEditor(
  props: SettingsEditorProps,
  actions: SettingsEditorActions
): HTMLElement {
  const panel = node("div", "panel settings-panel settings-editor");
  panel.append(
    heading("Generation settings", "Edit provider connections, profiles, routes, sampling, and writing prompts."),
    renderProfileSection(props, actions),
    renderConnectionSection(props, actions),
    renderModelSection(props, actions),
    renderGenerationSection(props, actions),
    renderSamplingSection(props, actions),
    renderRoutingSection(props, actions),
    renderWritingSection(props, actions),
    renderSaveBar(props, actions)
  );
  if (props.busy !== null) {
    for (const control of panel.querySelectorAll("input, textarea, select, button")) {
      (control as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement).disabled = true;
    }
  }
  if (props.error !== null) panel.append(node("p", "settings-error settings-global-error", props.error));
  return panel;
}

function heading(title: string, description: string): HTMLElement {
  return node("div", "panel-heading settings-heading",
    node("div", "panel-heading-copy", node("span", "eyebrow", "Settings"), node("h2", "", title), node("p", "", description))
  );
}

function section(title: string, description: string, ...children: (Node | string)[]): HTMLElement {
  return node("section", "settings-section", node("div", "settings-section-heading", node("h3", "", title), node("p", "", description)), ...children);
}

function renderProfileSection(props: SettingsEditorProps, actions: SettingsEditorActions): HTMLElement {
  const draft = props.draft;
  const list = node("div", "settings-profile-list");
  const ids = Object.keys(props.document.profiles);
  for (const id of ids) {
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
    node("p", "settings-muted", `Editing ${profile.name || draft.selectedProfileId}. Changes stay in the typed draft until you save.`)
  );
}

function renderConnectionSection(props: SettingsEditorProps, actions: SettingsEditorActions): HTMLElement {
  const draft = props.draft;
  const connection = connectionForDraft(draft);
  const auth = connection.auth;
  const fields: Node[] = [
    inputField(props, actions, "Connection name", "connection.name", connection.name),
    selectField(props, actions, "Provider preset", "connection.preset", SETTINGS_PRESET_V2_VALUES, connection.preset, Object.fromEntries(SETTINGS_PRESET_V2_VALUES.map((value) => [value, providerLabel(value)]))),
    selectField(props, actions, "Transport protocol", "connection.protocol", SETTINGS_PROTOCOL_V2_VALUES, connection.protocol),
    inputField(props, actions, "Base URL", "connection.baseUrl", connection.baseUrl ?? "", "url", { wide: true }),
    checkboxField(props, actions, "Allow insecure HTTP on a LAN host", "connection.allowInsecureHttp", connection.allowInsecureHttp === true)
  ];
  if (connection.protocol === "text-completions") {
    fields.push(
      selectField(props, actions, "Text prompt format", "connection.textPromptFormat", ["", ...TEXT_PROMPT_FORMAT_V2_VALUES], connection.textPromptFormat ?? "", { "": "raw (default)" }),
      checkboxField(props, actions, "Split <think> tags into model thoughts", "connection.splitThinkTags", connection.splitThinkTags === true)
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
    inputField(props, actions, "Response headers (ms)", "connection.responseHeaderMs", String(connection.timeouts.responseHeaderMs), "number", { min: "1", max: "86400000", step: "1" }),
    inputField(props, actions, "First token (ms)", "connection.firstTokenMs", String(connection.timeouts.firstTokenMs), "number", { min: "1", max: "86400000", step: "1" }),
    inputField(props, actions, "Idle (ms)", "connection.idleMs", String(connection.timeouts.idleMs), "number", { min: "1", max: "86400000", step: "1" }),
    inputField(props, actions, "Total (ms)", "connection.totalMs", String(connection.timeouts.totalMs), "number", { min: "1", max: "86400000", step: "1" })
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
  return section("Provider connection", "The selected profile uses this provider route. Keys remain in the machine tier.", authFields, probe, status,
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

function renderModelSection(props: SettingsEditorProps, actions: SettingsEditorActions): HTMLElement {
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
    inputField(props, actions, "Image token ceiling", "model.imageTokenCeiling", model.capabilities.imageTokenCeiling === undefined ? "" : String(model.capabilities.imageTokenCeiling), "number", { min: "1", max: "1000000000", step: "1" })
  );
  return section("Model discovery and context", "Choose a remote model, then keep discovered values or set explicit overrides.",
    node("div", "settings-form",
      selectField(props, actions, "Model record", "profile.modelId", Object.keys(props.document.models), draft.document.profiles[draft.selectedProfileId]?.modelId ?? "", Object.fromEntries(Object.entries(props.document.models).map(([id, item]) => [id, item.name || id]))),
      inputField(props, actions, "Remote model ID", "model.remoteId", model.remoteId, "text", { wide: true }),
      inputField(props, actions, "Model display name", "model.name", model.name),
      inputField(props, actions, "Context window override", "model.contextWindow", model.overrides.contextWindow === undefined ? "" : String(model.overrides.contextWindow), "number", { min: "1", max: "1000000000", step: "1" }),
      inputField(props, actions, "Output limit override", "model.maxOutputTokens", model.overrides.maxOutputTokens === undefined ? "" : String(model.overrides.maxOutputTokens), "number", { min: "1", max: "1000000000", step: "1" })
    ),
    node("div", "settings-discovered-meta", `Discovered context ${model.discovered.contextWindow ?? "unknown"}; discovered output limit ${model.discovered.maxOutputTokens ?? "unknown"}.`),
    capabilities,
    cards
  );
}

function renderGenerationSection(props: SettingsEditorProps, actions: SettingsEditorActions): HTMLElement {
  const profile = profileForDraft(props.draft);
  const reasoning = profileGenerationReasoning(profile.generationReasoning);
  return section("Generation", "Set the model response shape, reasoning behavior, cache policy, and alternatives.",
    node("div", "settings-form",
      inputField(props, actions, "Temperature", "profile.temperature", profile.temperature === null ? "" : String(profile.temperature), "number", { min: "-100", max: "100", step: "0.01" }),
      inputField(props, actions, "Maximum output tokens", "profile.maxOutputTokens", String(profile.maxOutputTokens), "number", { min: "1", max: "1000000000", step: "1" }),
      selectField(props, actions, "Reasoning effort", "profile.effort", ["default", "minimal", "low", "medium", "high", "xhigh", "max"], reasoning.effort),
      selectField(props, actions, "Thinking mode", "profile.thinkingMode", ["default", "on", "off"], reasoning.thinkingMode),
      selectField(props, actions, "Reasoning display", "profile.reasoning", ["off", "marker", "open"], profile.reasoning ?? "marker"),
      selectField(props, actions, "Prompt cache", "profile.cachePolicy", ["off", "auto", "long"], profile.cachePolicy),
      inputField(props, actions, "Token alternatives", "profile.tokenProbabilities", profile.tokenProbabilities === undefined ? "" : String(profile.tokenProbabilities), "number", { min: "1", max: "20", step: "1" }),
      checkboxField(props, actions, "Keep model thoughts", "profile.discardReasoning", profile.discardReasoning !== true),
      selectField(props, actions, "Continuation prompt layout", "profile.continuationPromptOptimization", ["", "late-cache-stable"], profile.continuationPromptOptimization ?? "", { "": "Compatibility (default)", "late-cache-stable": "Late cache stable" })
    )
  );
}

function renderSamplingSection(props: SettingsEditorProps, actions: SettingsEditorActions): HTMLElement {
  const sampling = samplingForProfile(profileForDraft(props.draft));
  const scalarFields = SAMPLING_SCALAR_KNOB_V2_VALUES.map((knob) => samplingScalarField(props, actions, knob, sampling[knob]));
  const lists: [SamplingListName, string, string][] = [
    ["stop", "Stop sequences", sampling.stop.join("\n")],
    ["logitBias", "Logit bias", Object.entries(sampling.logitBias).map(([key, value]) => `${key} | ${value}`).join("\n")],
    ["phraseBias", "Phrase bias", sampling.phraseBias.map((entry) => `${entry.phrase} | ${entry.weight}`).join("\n")],
    ["bannedStrings", "Banned strings", sampling.bannedStrings.join("\n")],
    ["dryBreakers", "DRY breakers", sampling.dryBreakers.join("\n")]
  ];
  const listFields = lists.map(([list, title, value]) => samplingListField(props, actions, list, title, value));
  return section("Sampling", "All sampling scalars and list panels stay in the selected profile. Blank values use provider defaults.",
    node("div", "settings-form settings-sampling-scalars", ...scalarFields),
    node("div", "settings-sampling-lists", ...listFields)
  );
}

function samplingScalarField(props: SettingsEditorProps, actions: SettingsEditorActions, knob: SamplingScalarKnobV2, value: number | null): HTMLElement {
  const wrapper = labelForSampling(samplingKnobLabel(knob));
  const descriptor = SAMPLING_SCALAR_DESCRIPTORS[knob];
  const input = document.createElement("input");
  input.type = "text";
  input.inputMode = descriptor.integer ? "numeric" : "decimal";
  input.value = value === null ? "" : String(value);
  input.min = String(descriptor.minimum);
  input.max = String(descriptor.maximum);
  input.step = descriptor.integer ? "1" : "any";
  input.placeholder = "provider default";
  input.dataset.settingsField = `sampling.${knob}`;
  input.classList.add("settings-control", `settings-control-sampling-${knob}`);
  input.dataset.preserve = `settings:sampling:${knob}`;
  input.addEventListener("input", () => actions.editSamplingScalar(knob, input.value));
  wrapper.append(input);
  appendSettingsError(wrapper, props.fieldErrors[`sampling.${knob}`]);
  return wrapper;
}

function samplingListField(props: SettingsEditorProps, actions: SettingsEditorActions, list: SamplingListName, title: string, value: string): HTMLElement {
  const wrapper = labelForSampling(title);
  const text = document.createElement("textarea");
  text.rows = 4;
  text.value = value;
  text.placeholder = list === "phraseBias" || list === "logitBias" ? "one value | weight per line" : "one value per line";
  text.dataset.settingsField = `sampling.${list}`;
  text.classList.add("settings-control", `settings-control-sampling-${list}`);
  text.dataset.preserve = `settings:sampling:${list}`;
  text.addEventListener("input", () => actions.editSamplingList(list, text.value));
  wrapper.append(text);
  appendSettingsError(wrapper, props.fieldErrors[`sampling.${list}`]);
  return wrapper;
}

function labelForSampling(title: string): HTMLLabelElement {
  const wrapper = node("label", "settings-sampling-field", title) as HTMLLabelElement;
  return wrapper;
}

function appendSettingsError(parent: HTMLElement, error: string | undefined): void {
  if (error !== undefined && error.length > 0) parent.append(node("span", "settings-error", error));
}

function renderRoutingSection(props: SettingsEditorProps, actions: SettingsEditorActions): HTMLElement {
  const profiles = Object.keys(props.document.profiles);
  const labels = Object.fromEntries(profiles.map((id) => [id, props.document.profiles[id]?.name || id]));
  return section("Routing", "Choose the generation profile for the default, prose, and utility requests.",
    node("div", "settings-form",
      selectField(props, actions, "Default route", "route.default", profiles, props.document.routing.default, labels),
      selectField(props, actions, "Prose route", "route.prose", ["", ...profiles], props.document.routing.prose ?? "", { "": "Default route", ...labels }),
      selectField(props, actions, "Utility route", "route.utility", ["", ...profiles], props.document.routing.utility ?? "", { "": "Default route", ...labels })
    )
  );
}

function renderWritingSection(props: SettingsEditorProps, actions: SettingsEditorActions): HTMLElement {
  const fields = WRITING_PROMPT_FIELD_DEFINITIONS.map((definition) => writingField(props, actions, definition));
  return section("Writing prompts", "These prompts apply across prose, titles, summaries, rewrites, and Aside requests.", node("div", "settings-writing-fields", ...fields));
}

function writingField(props: SettingsEditorProps, actions: SettingsEditorActions, definition: WritingPromptFieldDefinition): HTMLElement {
  return textAreaField(props, actions, definition.title, `writing.${definition.field}`, props.document.writing[definition.field], `${definition.help} ${definition.emptyBehavior}.`);
}

function renderSaveBar(props: SettingsEditorProps, actions: SettingsEditorActions): HTMLElement {
  const invalidFieldCount = Object.keys(props.fieldErrors).length;
  const saveLabel = props.pendingRevision === null ? "Save settings" : "Retry activation";
  const save = button("settings-save", props.busy === "save" ? "Saving…" : saveLabel, actions.save);
  save.disabled = props.busy !== null || invalidFieldCount > 0;
  const discard = props.pendingRevision === null
    ? ""
    : button("settings-discard-pending", props.busy === "discard" ? "Discarding…" : "Discard pending", actions.discardPending);
  if (typeof discard !== "string") discard.disabled = props.busy !== null;
  const pendingNotice = props.pendingRevision === null
    ? ""
    : pendingSettingsNotice(props.lastActivationOutcome);
  return node("div", "settings-save-bar",
    node("div", "settings-actions", save, button("settings-reload", "Reload", actions.reload), discard),
    pendingNotice,
    invalidFieldCount === 0
      ? ""
      : node("p", "settings-error settings-save-validation", `Fix ${invalidFieldCount} invalid field${invalidFieldCount === 1 ? "" : "s"} before saving.`),
    node("p", "settings-muted", `Active revision ${props.activeRevision}; pending ${props.pendingRevision ?? "none"}.`)
  );
}

function pendingSettingsNotice(outcome: SettingsActivationOutcomeV2 | null): HTMLElement {
  const failure = activationFailureText(outcome);
  return node("div", "settings-pending-notice",
    node("strong", "", failure === null
      ? "Settings saved · not active yet."
      : `Settings saved · not active · ${failure}.`),
    node("p", "settings-help", failure === null
      ? "The saved candidate is pending. Retry activation checks it again. Discard pending removes it and keeps the active settings."
      : "Retry activation checks this saved candidate again. Discard pending removes it and keeps the active settings.")
  );
}

function activationFailureText(outcome: SettingsActivationOutcomeV2 | null): string | null {
  if (outcome === null || outcome.result === "committed") return null;
  return settingsActivationFailureText(outcome.errorCode);
}

function settingsActivationFailureText(errorCode: SettingsActivationErrorCodeV2): string {
  switch (errorCode) {
    case "credential_unresolved":
      return "credential not found (env var or stored key)";
    case "candidate_invalid":
      return "provider check failed";
    case "activation_crashed":
      return "activation was interrupted";
    case "activation_failed":
    case "readiness_failed":
      return "rolled back after an interruption";
  }
}
