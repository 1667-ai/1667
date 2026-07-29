import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { parseSettingsDocumentV2 } from "../../server/settings-v2-codec.js";
import { effectiveGenerationRuntime } from "../../server/settings-v2-conversion.js";
import {
  applyBasicSettingsDraft,
  basicSettingsFromDocument
} from "../../shared/settings-basic-draft.js";
import type {
  ProviderProbeTarget,
  SaveSettingsCommand,
  SettingsView
} from "../../shared/settings-v2-types.js";
import { selectSettingsRoute } from "../../shared/settings-route.js";
import { createFailureEnvelope } from "../../shared/failure-envelope.js";
import { ActionRuntime } from "../src/action-runtime.js";
import { handleKey, initialState } from "../src/app.js";
import {
  selectedComposerText,
  setComposerText
} from "../src/composer-model.js";
import { demoAppSource } from "../src/demo.js";
import { pasteInto } from "../src/keys.js";
import {
  beginSettingsPasteEdit,
  SETTINGS_ROW_IDS,
  settingsDraftChanged,
  settingsRowCycles
} from "../src/settings-overlay-model.js";
import { publishSettingsView } from "../src/overlay-publication.js";
import {
  localProviderPresetsSupported,
  selectableSettingsProviderChoices,
  settingsProviderChoice,
  SETTINGS_PROVIDER_CHOICES,
  type SettingsProviderChoiceId
} from "../src/settings-provider-choices.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { frameText } from "../src/screens/story/frame.js";
import type { SettingsRowId } from "../src/state.js";
import { WorkerApiError } from "../src/worker-api.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";

function key(
  name: string,
  options: { sequence?: string; ctrl?: boolean; shift?: boolean; meta?: boolean } = {}
): KeyEvent {
  return {
    name,
    sequence: options.sequence ?? name,
    shift: options.shift ?? false,
    ctrl: options.ctrl ?? false,
    meta: options.meta ?? false
  } as KeyEvent;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function generationFromProbeTarget(target: ProviderProbeTarget) {
  return "kind" in target
    ? basicSettingsFromDocument(target.document)
    : target;
}

function harness() {
  const source = demoAppSource();
  const state = initialState(source, false);
  const cache = createWrapCache<ProseStyle>();
  const backend = new ActionRuntime(state, () => undefined);
  const press = (event: KeyEvent) => handleKey(
    event,
    state,
    source,
    cache,
    () => undefined,
    async () => undefined,
    () => undefined,
    null,
    (theme) => {
      state.config = { ...state.config, theme };
      source.config = state.config;
    },
    () => undefined,
    backend
  );
  return { source, state, cache, backend, press };
}

async function openSettings(
  press: (event: KeyEvent) => Promise<void>
): Promise<void> {
  await press(key(",", { sequence: "," }));
}

async function selectRow(
  press: (event: KeyEvent) => Promise<void>,
  state: ReturnType<typeof harness>["state"],
  row: SettingsRowId
): Promise<void> {
  const target = SETTINGS_ROW_IDS.indexOf(row);
  while (state.settings!.cursor < target) await press(key("down"));
  while (state.settings!.cursor > target) await press(key("up"));
}

async function draftRow(
  press: (event: KeyEvent) => Promise<void>,
  state: ReturnType<typeof harness>["state"],
  row: SettingsRowId,
  value: string
): Promise<void> {
  await selectRow(press, state, row);
  await press(key("return"));
  expect(state.mode).toBe("SETTINGS");
  expect(state.settings?.edit?.row).toBe(row);
  setComposerText(state.settings!.edit!.composer, value);
  await press(key("return"));
  expect(state.settings?.edit).toBe(null);
}

describe("inline settings menu", () => {
  test("up/down selects every row; Enter edits text and advances closed choices", async () => {
    const { state, press } = harness();
    await openSettings(press);

    for (const [index, row] of SETTINGS_ROW_IDS.entries()) {
      expect(state.settings?.cursor).toBe(index);
      await press(key("return"));
      expect(state.mode).toBe("SETTINGS");
      expect(state.editor).toBe(null);
      if (settingsRowCycles(row)) {
        expect(state.settings?.edit).toBe(null);
      } else {
        expect(state.settings?.edit?.row).toBe(row);
        await press(key("escape"));
        expect(state.mode).toBe("SETTINGS");
      }
      if (index < SETTINGS_ROW_IDS.length - 1) await press(key("down"));
    }

    await press(key("down"));
    expect(state.settings?.cursor).toBe(SETTINGS_ROW_IDS.length - 1);
    for (let index = 0; index < SETTINGS_ROW_IDS.length + 2; index += 1) {
      await press(key("up"));
    }
    expect(state.settings?.cursor).toBe(0);
  });

  test("typing replaces the selected inline value and Escape cancels only the row", async () => {
    const { state, press } = harness();
    await openSettings(press);
    await selectRow(press, state, "model");
    await press(key("return"));

    await press(key("x"));

    expect(state.settings?.edit?.composer.text).toBe("x");
    await press(key("escape"));
    expect(state.mode).toBe("SETTINGS");
    expect(state.settings?.draft.generation.model).toBe("");
    await press(key("escape"));
    expect(state.mode).toBe("NAV");
  });

  test("Shift+Arrow selects text inside an inline row", async () => {
    const { state, press } = harness();
    await openSettings(press);
    await selectRow(press, state, "model");
    await press(key("return"));
    setComposerText(state.settings!.edit!.composer, "draft-model");

    await press(key("left", { shift: true }));
    await press(key("left", { shift: true }));
    await press(key("home", { shift: true }));

    expect(selectedComposerText(state.settings!.edit!.composer)).toBe("draft-model");
  });

  test("row commits build a local draft and s saves it through one durable mutation", async () => {
    const { source, state, press } = harness();
    const commands: SaveSettingsCommand[] = [];
    let current = source.settingsView;
    source.api.saveSettings = async (command) => {
      commands.push(command);
      if (!current.editable) throw new Error("demo settings must be editable");
      const effective = basicSettingsFromDocument(command.document);
      current = {
        ...current,
        stateGeneration: current.stateGeneration + 1,
        activeRevision: current.activeRevision + 1,
        document: command.document,
        effective
      };
      return {
        kind: "settings",
        settingsStateGeneration: current.stateGeneration,
        activeSettingsRevision: current.activeRevision,
        pendingSettingsRevision: null,
        activationOutcome: null
      };
    };
    source.api.getSettings = async () => current;
    await openSettings(press);

    await selectRow(press, state, "provider");
    await press(key("right"));
    expect(state.settings?.draft.generation.provider).toBe("openai-compatible");
    await draftRow(press, state, "base-url", "https://api.openai.com/v1");
    await draftRow(press, state, "model", "gpt-5.6");

    expect(commands).toHaveLength(0);
    expect(state.settings?.draft.generation.model).toBe("gpt-5.6");
    expect(state.model).not.toBe("gpt-5.6");
    await press(key("s"));

    expect(commands).toHaveLength(1);
    expect(commands[0]!.document.connections.demo?.protocol)
      .toBe("openai-chat-completions");
    expect(commands[0]!.document.models.demo?.remoteId).toBe("gpt-5.6");
    expect(state.settings?.draft.generation.model).toBe("gpt-5.6");
    expect(state.toast).toBe("settings saved");
  });

  test("theme is a scoped selector and compose focus cycles as a closed choice", async () => {
    const { source, state, press } = harness();
    await openSettings(press);

    await press(key("right"));
    await press(key("right"));
    await press(key("right"));
    expect(state.config.theme).toBe("bond");
    expect(source.config.theme).toBe("bond");
    await selectRow(press, state, "model");
    await press(key("left"));
    expect(state.config.theme).toBe("bond");
    await selectRow(press, state, "compose-focus");
    expect(state.config.composeFocus).toBe("off");
    await press(key("return"));
    expect(state.settings?.edit).toBe(null);
    expect(state.config.composeFocus).toBe("on");
    expect(source.config.composeFocus).toBe("on");
    await press(key("right"));
    expect(state.config.composeFocus).toBe("off");
  });

  test("Enter on compose-focus toggles without opening a text field", async () => {
    const { state, press } = harness();
    await openSettings(press);
    await selectRow(press, state, "compose-focus");
    expect(state.config.composeFocus).toBe("off");

    await press(key("return"));
    expect(state.settings?.edit).toBe(null);
    expect(state.config.composeFocus).toBe("on");
    expect(state.toast).toBe("compose focus · on");

    await press(key("return"));
    expect(state.settings?.edit).toBe(null);
    expect(state.config.composeFocus).toBe("off");
  });

  test("paste refuses every closed choice and still opens text rows", async () => {
    const { state, press } = harness();
    await openSettings(press);

    for (const row of SETTINGS_ROW_IDS) {
      if (!settingsRowCycles(row)) continue;
      await selectRow(press, state, row);
      expect(beginSettingsPasteEdit(state.settings!, state.config)).toBeFalse();
      expect(state.settings?.edit).toBe(null);
      await press(key("v", { ctrl: true }));
      expect(state.settings?.edit).toBe(null);
      expect(state.toast).toBe("this row is a selector · use ←→");
    }

    await selectRow(press, state, "model");
    expect(beginSettingsPasteEdit(state.settings!, state.config)).toBeTrue();
    expect(state.settings?.edit?.row).toBe("model");
  });

  test("legacy settings keep local rows editable while server rows remain read-only", async () => {
    const { source, state, press } = harness();
    const legacy: SettingsView = {
      dataFormat: 1,
      editable: false,
      stateGeneration: null,
      activeRevision: null,
      pendingRevision: null,
      document: null,
      effective: source.settings,
      lastActivationOutcome: null
    };
    source.settingsView = legacy;
    source.api.getSettings = async () => legacy;
    await openSettings(press);

    await press(key("right"));
    await press(key("right"));
    await press(key("right"));
    expect(state.config.theme).toBe("bond");
    await selectRow(press, state, "provider");
    await press(key("return"));
    expect(state.settings?.edit).toBe(null);
    expect(state.toast).toBe("legacy settings are read-only");
  });

  test("system-prompt edits preserve unrelated stored whitespace", async () => {
    const { source, state, press } = harness();
    const prompt = "Keep  this\tspacing\nand indentation.";
    if (!source.settingsView.editable) throw new Error("demo settings must be editable");
    source.settingsView = {
      ...source.settingsView,
      document: applyBasicSettingsDraft(source.settingsView.document, {
        ...source.settings,
        systemPrompt: prompt
      }),
      effective: { ...source.settings, systemPrompt: prompt }
    };
    source.api.getSettings = async () => source.settingsView;
    await openSettings(press);

    await selectRow(press, state, "system-prompt");
    await press(key("return"));
    expect(state.settings?.edit?.composer.text).toBe(JSON.stringify(prompt));
    setComposerText(
      state.settings!.edit!.composer,
      state.settings!.edit!.composer.text.replace("indentation", "structure")
    );
    await press(key("return"));

    expect(state.settings?.draft.generation.systemPrompt)
      .toBe("Keep  this\tspacing\nand structure.");
    expect(settingsDraftChanged(state.settings!)).toBeTrue();
  });

  test("provider is a closed selector and invalid complete drafts never reach the backend", async () => {
    const { source, state, press } = harness();
    let saves = 0;
    source.api.saveSettings = async () => {
      saves += 1;
      throw new Error("must not reach backend");
    };
    await openSettings(press);

    await selectRow(press, state, "provider");
    await press(key("return"));
    expect(state.settings?.edit).toBe(null);
    expect(state.settings?.draft.generation.provider).toBe("openai-compatible");
    await press(key("left"));
    expect(state.settings?.draft.generation.provider).toBe("dry-run");
    expect(state.settings?.draft.generation.contextWindow).toBe(32_768);

    await selectRow(press, state, "cache-policy");
    await press(key("right"));
    await press(key("right"));
    expect(state.settings?.draft.cachePolicy).toBe("long");
    await press(key("s"));
    expect(saves).toBe(0);
    expect(state.toast).toContain("Dry run never calls a model provider");
  });

  test("local provider choices apply safe localhost defaults", async () => {
    const localChoices = SETTINGS_PROVIDER_CHOICES.filter(
      (choice) => choice.plaintextDefaultRequiresOwnedLoopback === true
    );
    expect(localChoices.map((choice) => ({
      label: choice.label,
      baseUrl: choice.defaults.baseUrl,
      model: choice.defaults.model
    }))).toEqual([
      {
        label: "LM Studio",
        baseUrl: "http://127.0.0.1:1234/v1",
        model: ""
      },
      {
        label: "Ollama",
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "llama3.2"
      },
      {
        label: "llama.cpp",
        baseUrl: "http://127.0.0.1:8080/v1",
        model: ""
      },
      {
        label: "KoboldCpp",
        baseUrl: "http://127.0.0.1:5001/v1",
        model: ""
      }
    ]);
    expect(selectableSettingsProviderChoices(false).some(
      (choice) => choice.plaintextDefaultRequiresOwnedLoopback === true
    )).toBeFalse();

    const { state, cache, press } = harness();
    await openSettings(press);
    await selectRow(press, state, "provider");

    await press(key("right"));
    await press(key("right"));
    if (!localProviderPresetsSupported()) {
      expect(state.settings?.draft.generation).toMatchObject({
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com"
      });
      expect(frameText(renderStoryScreen(
        state,
        { width: 80, height: 24, wrapCache: cache }
      ).lines)).not.toContain("‹ LM Studio ›");
      state.settings!.draft = {
        ...state.settings!.draft,
        generation: {
          ...state.settings!.draft.generation,
          provider: "openai-compatible",
          baseUrl: "https://127.0.0.1:1234/v1",
          model: "loaded-model"
        }
      };
      expect(frameText(renderStoryScreen(
        state,
        { width: 80, height: 24, wrapCache: cache }
      ).lines)).toContain("‹ LM Studio ›");
      return;
    }

    expect(state.settings?.draft.generation).toMatchObject({
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "",
      apiKeyEnv: null,
      contextWindow: null
    });
    const rendered = frameText(renderStoryScreen(
      state,
      { width: 80, height: 24, wrapCache: cache }
    ).lines);
    expect(rendered).toContain("‹ LM Studio ›");

    await press(key("left"));
    expect(state.settings?.draft.generation).toMatchObject({
      provider: "openai-compatible",
      baseUrl: "",
      model: ""
    });
    await press(key("right"));
    await press(key("right"));
    expect(state.settings?.draft.generation).toMatchObject({
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "llama3.2"
    });
    await press(key("right"));
    expect(state.settings?.draft.generation).toMatchObject({
      baseUrl: "http://127.0.0.1:8080/v1",
      model: ""
    });
    await press(key("right"));
    expect(state.settings?.draft.generation).toMatchObject({
      baseUrl: "http://127.0.0.1:5001/v1",
      model: ""
    });
  });

  test("paste opens the selected text row and replaces its seed inline", async () => {
    const { state, press } = harness();
    await openSettings(press);
    await selectRow(press, state, "base-url");

    expect(state.settings?.edit).toBe(null);
    expect(beginSettingsPasteEdit(state.settings!, state.config)).toBeTrue();
    expect(pasteInto(state, "http://127.0.0.1:11434/v1\r\n")).toBeTrue();
    expect(state.settings?.edit?.composer.text).toBe("http://127.0.0.1:11434/v1 ");

    await press(key("return"));
    expect(state.settings?.draft.generation.baseUrl)
      .toBe("http://127.0.0.1:11434/v1");
  });

  test("pasted API key uses the save sidecar and renders only a mask", async () => {
    const { source, state, cache, press } = harness();
    const commands: SaveSettingsCommand[] = [];
    let current = source.settingsView;
    source.api.saveSettings = async (command) => {
      commands.push(command);
      if (!current.editable) throw new Error("demo settings must be editable");
      current = {
        ...current,
        stateGeneration: current.stateGeneration + 1,
        activeRevision: current.activeRevision + 1,
        document: command.document,
        effective: basicSettingsFromDocument(command.document)
      };
      return {
        kind: "settings",
        settingsStateGeneration: current.stateGeneration,
        activeSettingsRevision: current.activeRevision,
        pendingSettingsRevision: null,
        activationOutcome: null
      };
    };
    source.api.getSettings = async () => current;
    await openSettings(press);
    await selectRow(press, state, "provider");
    await press(key("right"));
    await draftRow(press, state, "base-url", "https://api.openai.com/v1");
    await draftRow(press, state, "model", "gpt-5.6");
    await selectRow(press, state, "api-key");

    expect(beginSettingsPasteEdit(state.settings!, state.config)).toBeTrue();
    expect(pasteInto(state, "sk-pasted-secret")).toBeTrue();
    expect(state.settings?.edit?.mode).toBe("secret");
    const editingFrame = renderStoryScreen(
      state,
      { width: 80, height: 24, wrapCache: cache }
    );
    const editingText = frameText(editingFrame.lines);
    expect(editingText).toContain("••••••••");
    expect(editingText).not.toContain("sk-pasted-secret");
    expect(editingFrame.derived.composerSelectionProjection).not.toBe(null);
    await press(key("return"));

    expect(state.settings?.draft.generation.apiKeyEnv).toBe(null);
    expect(JSON.stringify(state.settings?.draft.generation))
      .not.toContain("sk-pasted-secret");
    const rendered = frameText(renderStoryScreen(
      state,
      { width: 80, height: 24, wrapCache: cache }
    ).lines);
    expect(rendered).toContain("•••••••• · stored");
    expect(rendered).not.toContain("sk-pasted-secret");

    await press(key("s"));
    expect(commands).toHaveLength(1);
    // Every entered key mints a fresh, crypto-strength secret ID: the server
    // refuses to rebind an ID the active document still resolves to a
    // different target, and the shared machine tier needs collision-proof
    // names across projects.
    const firstId = Object.keys(commands[0]!.connectionSecrets ?? {})[0]!;
    expect(firstId).toMatch(
      /^demo\.k[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(commands[0]!.connectionSecrets).toEqual({
      [firstId]: "sk-pasted-secret"
    });
    expect(commands[0]!.document.connections.demo?.auth).toEqual({
      type: "bearer-stored",
      secretId: firstId
    });
    expect(JSON.stringify(commands[0]!.document)).not.toContain("sk-pasted-secret");

    await draftRow(press, state, "api-key", "");
    await press(key("s"));
    expect(commands[1]!.connectionSecrets).toEqual({ [firstId]: null });
    expect(commands[1]!.document.connections.demo?.auth).toEqual({ type: "none" });

    await selectRow(press, state, "provider");
    for (let attempts = 0;
      state.settings?.draft.generation.provider !== "anthropic" && attempts < 8;
      attempts += 1) {
      await press(key("right"));
    }
    await draftRow(press, state, "model", "claude-sonnet");
    await selectRow(press, state, "api-key");
    expect(beginSettingsPasteEdit(state.settings!, state.config)).toBeTrue();
    expect(pasteInto(state, "anthropic-pasted-secret")).toBeTrue();
    await press(key("return"));
    await press(key("s"));

    const thirdId = Object.keys(commands[2]!.connectionSecrets ?? {})[0]!;
    expect(thirdId.startsWith("demo.k")).toBeTrue();
    expect(thirdId).not.toBe(firstId);
    expect(commands[2]!.connectionSecrets).toEqual({
      [thirdId]: "anthropic-pasted-secret"
    });
    expect(commands[2]!.document.connections.demo?.auth).toEqual({
      type: "header-stored",
      name: "x-api-key",
      secretId: thirdId
    });
  });

  test("provider cycling preserves and reshapes a saved stored API key", async () => {
    const { source, state, press } = harness();
    if (!source.settingsView.editable) throw new Error("demo settings must be editable");
    const openAiDocument = applyBasicSettingsDraft(source.settingsView.document, {
      ...source.settings,
      provider: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-5.6",
      apiKeyEnv: null,
      contextWindow: null
    });
    const savedDocument = {
      ...openAiDocument,
      connections: {
        ...openAiDocument.connections,
        demo: {
          ...openAiDocument.connections.demo!,
          auth: {
            type: "bearer-stored" as const,
            secretId: "saved-openai-secret"
          }
        }
      }
    };
    const savedView: SettingsView = {
      ...source.settingsView,
      document: savedDocument,
      effective: basicSettingsFromDocument(savedDocument)
    };
    source.settingsView = savedView;
    source.settings = savedView.effective;
    source.api.getSettings = async () => savedView;

    await openSettings(press);
    await selectRow(press, state, "provider");
    for (let attempts = 0;
      state.settings?.draft.generation.provider !== "anthropic" && attempts < 8;
      attempts += 1) {
      await press(key("right"));
    }

    expect(state.settings?.draft.generation.provider).toBe("anthropic");
    expect(state.settings?.draft.generation.apiKeyEnv).toBe(null);
    await draftRow(press, state, "model", "claude-sonnet-5");
    const switched = applyBasicSettingsDraft(
      savedDocument,
      state.settings!.draft.generation
    );
    expect(selectSettingsRoute(switched).connection.auth).toEqual({
      type: "header-stored",
      name: "x-api-key",
      secretId: "saved-openai-secret"
    });
  });

  test("LAN HTTP selector toggles and round-trips through the basic draft", async () => {
    const { source, state, press } = harness();
    await openSettings(press);
    await selectRow(press, state, "provider");
    await press(key("right"));
    await draftRow(press, state, "base-url", "http://gpu-box.local:11434/v1");
    await draftRow(press, state, "model", "lan-model");
    await selectRow(press, state, "allow-insecure-http");
    await press(key("right"));

    expect(state.settings?.draft.generation.allowInsecureHttp).toBeTrue();
    if (!source.settingsView.editable) throw new Error("demo settings must be editable");
    const document = applyBasicSettingsDraft(
      source.settingsView.document,
      state.settings!.draft.generation
    );
    expect(document.connections.demo?.allowInsecureHttp).toBeTrue();
    expect(basicSettingsFromDocument(document).allowInsecureHttp).toBeTrue();

    await press(key("left"));
    expect(state.settings?.draft.generation.allowInsecureHttp).toBe(undefined);
  });

  test("cache policy is a selector that keeps every policy reachable", async () => {
    const { state, cache, press } = harness();
    await openSettings(press);
    await selectRow(press, state, "cache-policy");
    expect(state.settings?.draft.cachePolicy).toBe("off");

    await press(key("return"));
    expect(state.settings?.edit).toBe(null);
    expect(state.settings?.draft.cachePolicy).toBe("auto");
    await press(key("right"));
    expect(state.settings?.draft.cachePolicy).toBe("long");
    await press(key("right"));
    expect(state.settings?.draft.cachePolicy).toBe("off");
    await press(key("left"));
    expect(state.settings?.draft.cachePolicy).toBe("long");

    // The demo route cannot honour a policy, and the row says so rather than
    // hiding the choice behind a skipped step.
    const rendered = frameText(renderStoryScreen(
      state,
      { width: 80, height: 24, wrapCache: cache }
    ).lines);
    expect(rendered).toContain("▸ cache policy");
    expect(rendered).toContain("‹ long ›");
    expect(rendered).toContain("↑↓ move · ←→ choose · ↵ next · s save");
  });

  test("cache policy states its cost beside the chosen policy", async () => {
    const { state, cache, press } = harness();
    await openSettings(press);
    await selectRow(press, state, "provider");
    while (state.settings?.draft.generation.provider !== "anthropic") {
      await press(key("right"));
    }
    await draftRow(press, state, "model", "claude-sonnet-5");
    await selectRow(press, state, "cache-policy");
    await press(key("right"));

    const rendered = frameText(renderStoryScreen(
      state,
      { width: 100, height: 30, wrapCache: cache }
    ).lines);
    expect(rendered).toContain("‹ auto › · stable block · 5m · 1.25× writes");
  });

  test("the selected row and inline field render inside Settings", async () => {
    const { state, cache, press } = harness();
    await openSettings(press);
    await selectRow(press, state, "provider");
    let rendered = frameText(renderStoryScreen(
      state,
      { width: 80, height: 24, wrapCache: cache }
    ).lines);
    expect(rendered).toContain("▸ provider");
    expect(rendered).toContain("‹ dry-run ›");
    expect(rendered).toContain("↑↓ move · ←→ choose · ↵ next · s save");

    await selectRow(press, state, "model");
    await press(key("return"));
    rendered = frameText(renderStoryScreen(
      state,
      { width: 80, height: 24, wrapCache: cache }
    ).lines);
    expect(rendered).toContain("▸ model");
    expect(rendered).toContain("←→ cursor · ↵ keep row · esc cancel");
  });

  test("short narrow panels keep the selected wide-character field and caret visible", async () => {
    const { state, cache, press } = harness();
    await openSettings(press);
    await selectRow(press, state, "system-prompt");
    await press(key("return"));
    setComposerText(state.settings!.edit!.composer, `${"界".repeat(40)}END`);

    let rendered = frameText(renderStoryScreen(
      state,
      { width: 60, height: 20, wrapCache: cache }
    ).lines);

    expect(rendered).toContain("▸ system prompt");
    expect(rendered).toContain("END▏]");
    expect(rendered).not.toContain("▸ provider");

    for (let height = 10; height <= 14; height += 1) {
      rendered = frameText(renderStoryScreen(
        state,
        { width: 60, height, wrapCache: cache }
      ).lines);
      expect(rendered).toContain("▸ system prompt");
      expect(rendered).toContain("END▏]");
    }
  });

  test("server checks use the unsaved inline draft", async () => {
    const { source, state, press } = harness();
    let checkedModel: string | null = null;
    source.api.checkModelServer = async (settings) => {
      checkedModel = generationFromProbeTarget(settings).model;
      return { state: "ready", message: "draft ready" };
    };
    await openSettings(press);
    await draftRow(press, state, "model", "draft-model");
    await press(key("c"));

    expect(checkedModel).toBe("draft-model");
    expect(state.settings?.result?.message).toBe("draft ready");
    await press(key("return"));
    expect(state.settings?.edit?.row).toBe("model");
    expect(state.settings?.result).toBe(null);
  });

  test("server checks retain LAN HTTP opt-in on an unsaved format-2 draft", async () => {
    const { source, state, press } = harness();
    const checks: ProviderProbeTarget[] = [];
    source.api.checkModelServer = async (target) => {
      checks.push(target);
      return { state: "ready", message: "LAN draft ready" };
    };
    await openSettings(press);
    await selectRow(press, state, "provider");
    await press(key("right"));
    await draftRow(press, state, "base-url", "http://gpu-box.local:11434/v1");
    await draftRow(press, state, "model", "lan-model");
    await selectRow(press, state, "allow-insecure-http");
    await press(key("right"));
    await press(key("c"));

    const checked = checks[0];
    if (checked === undefined || !("kind" in checked)) {
      throw new Error("expected a format-2 provider probe target");
    }
    expect(checked.kind).toBe("settings-document");
    const connection = selectSettingsRoute(checked.document).connection;
    expect(connection.baseUrl).toBe("http://gpu-box.local:11434/v1");
    expect(connection.allowInsecureHttp).toBeTrue();
    expect(state.settings?.result?.message).toBe("LAN draft ready");
  });

  test("p detects the context window from the unsaved provider draft", async () => {
    const { source, state, cache, press } = harness();
    let probedModel: string | null = null;
    const probes: ProviderProbeTarget[] = [];
    source.api.probeContextWindow = async (settings) => {
      probes.push(settings);
      probedModel = generationFromProbeTarget(settings).model;
      return { contextWindow: 65_536 };
    };
    await openSettings(press);
    await draftRow(press, state, "model", "draft-model");
    await selectRow(press, state, "context-window");

    let rendered = frameText(renderStoryScreen(
      state,
      { width: 80, height: 24, wrapCache: cache }
    ).lines);
    expect(rendered).toContain("p detect");
    await press(key("p"));

    expect(probedModel).toBe("draft-model");
    expect(probes[0] !== undefined && "kind" in probes[0]).toBeTrue();
    expect(state.settings?.draft.generation.contextWindow).toBe(65_536);
    expect(state.settings?.result).toEqual({
      state: "ready",
      message: "context window · 65,536 tokens · s saves"
    });
    expect(state.settings?.probing).toBeFalse();
    rendered = frameText(renderStoryScreen(
      state,
      { width: 80, height: 24, wrapCache: cache }
    ).lines);
    expect(rendered).toContain("context window · 65,536 tokens · s saves");
    await draftRow(press, state, "model", "another-model");
    expect(state.settings?.draft.generation.contextWindow).toBe(null);
  });

  test("p probes blank-model KoboldCpp and llama.cpp drafts at the real boundary", async () => {
    const cases = [
      { id: "koboldcpp", contextWindow: 65_536 },
      { id: "llama-cpp", contextWindow: 32_768 }
    ] as const satisfies readonly {
      id: SettingsProviderChoiceId;
      contextWindow: number;
    }[];

    for (const expected of cases) {
      const { source, state, press } = harness();
      const choice = SETTINGS_PROVIDER_CHOICES.find(
        (candidate) => candidate.id === expected.id
      )!;
      let probes = 0;
      source.api.probeContextWindow = async (target) => {
        probes += 1;
        if (!("kind" in target)) throw new Error("expected a settings document");
        const runtime = effectiveGenerationRuntime(
          parseSettingsDocumentV2(target.document),
          target.purpose,
          {},
          {},
          { allowBlankModel: true }
        );
        expect(runtime.settings.model).toBe("");
        expect(runtime.providerRuntime.preset).toBe(expected.id);
        return { contextWindow: expected.contextWindow };
      };
      await openSettings(press);
      state.settings!.draft = {
        ...state.settings!.draft,
        generation: {
          ...state.settings!.draft.generation,
          provider: choice.provider,
          ...choice.defaults
        }
      };
      expect(settingsProviderChoice(state.settings!.draft.generation).id).toBe(expected.id);
      expect(state.settings!.draft.generation.model).toBe("");
      await selectRow(press, state, "context-window");

      await press(key("p"));

      expect(probes).toBe(1);
      expect(state.settings?.draft.generation.contextWindow).toBe(expected.contextWindow);
      expect(state.settings?.result).toMatchObject({ state: "ready" });
    }
  });

  test("a probe that cannot answer sends the writer to manual entry", async () => {
    const { source, state, press } = harness();
    source.api.probeContextWindow = async () => ({ contextWindow: null });
    await openSettings(press);
    state.settings!.draft = {
      ...state.settings!.draft,
      generation: {
        ...state.settings!.draft.generation,
        provider: "openai-compatible",
        baseUrl: "https://127.0.0.1:1234/v1",
        model: ""
      }
    };
    await selectRow(press, state, "context-window");
    await press(key("p"));

    expect(state.settings?.result).toEqual({
      state: "warning",
      message: "context window unavailable · enter it here"
    });
  });

  test("a late context probe cannot overwrite a newer inline draft", async () => {
    const { source, state, press } = harness();
    const entered = deferred<void>();
    const gate = deferred<{ contextWindow: number | null }>();
    source.api.probeContextWindow = async () => {
      entered.resolve();
      return gate.promise;
    };
    await openSettings(press);
    await draftRow(press, state, "model", "model-a");
    await draftRow(press, state, "context-window", "8192");

    const probing = press(key("p"));
    await entered.promise;
    await draftRow(press, state, "model", "model-b");
    gate.resolve({ contextWindow: 32_768 });
    await probing;

    expect(state.settings?.draft.generation.model).toBe("model-b");
    expect(state.settings?.draft.generation.contextWindow).toBe(null);
    expect(state.settings?.result).toBe(null);
    expect(state.settings?.probing).toBeFalse();
  });

  test("a late server check cannot publish against a newer inline draft", async () => {
    const { source, state, press } = harness();
    const entered = deferred<void>();
    const gate = deferred<{ state: "ready"; message: string }>();
    source.api.checkModelServer = async () => {
      entered.resolve();
      return gate.promise;
    };
    await openSettings(press);
    await draftRow(press, state, "model", "model-a");

    const checking = press(key("c"));
    await entered.promise;
    await draftRow(press, state, "model", "model-b");
    gate.resolve({ state: "ready", message: "model A ready" });
    await checking;

    expect(state.settings?.draft.generation.model).toBe("model-b");
    expect(state.settings?.result).toBe(null);
    expect(state.settings?.checking).toBeFalse();
  });

  test("a server check cannot publish beneath an uncommitted row edit", async () => {
    const { source, state, press } = harness();
    const entered = deferred<void>();
    const gate = deferred<{ state: "ready"; message: string }>();
    source.api.checkModelServer = async () => {
      entered.resolve();
      return gate.promise;
    };
    await openSettings(press);
    await draftRow(press, state, "model", "model-a");

    const checking = press(key("c"));
    await entered.promise;
    await selectRow(press, state, "model");
    await press(key("return"));
    setComposerText(state.settings!.edit!.composer, "model-b");
    gate.resolve({ state: "ready", message: "model A ready" });
    await checking;

    expect(state.settings?.edit?.composer.text).toBe("model-b");
    expect(state.settings?.result).toBe(null);
    expect(state.settings?.checking).toBeFalse();
  });

  test("a save whose activation fails surfaces the reason and keeps editing available", async () => {
    const { source, state, press } = harness();
    if (!source.settingsView.editable) throw new Error("demo settings must be editable");
    const active = source.settingsView;
    source.api.saveSettings = async (command) => {
      const candidateRevision = active.activeRevision + 1;
      const outcome = {
        transactionId: command.mutationId,
        candidateRevision,
        result: "validation-failed" as const,
        errorCode: "candidate_invalid" as const,
        atStateGeneration: active.stateGeneration + 3
      };
      source.settingsView = {
        ...active,
        stateGeneration: active.stateGeneration + 3,
        pendingRevision: candidateRevision,
        document: command.document,
        lastActivationOutcome: outcome
      };
      return {
        kind: "settings",
        settingsStateGeneration: active.stateGeneration + 1,
        activeSettingsRevision: active.activeRevision,
        pendingSettingsRevision: candidateRevision,
        activationOutcome: outcome
      };
    };
    source.api.getSettings = async () => source.settingsView;

    await openSettings(press);
    await selectRow(press, state, "provider");
    await press(key("right"));
    await draftRow(press, state, "base-url", "https://api.openai.com/v1");
    await draftRow(press, state, "model", "gpt-5.6");
    await draftRow(press, state, "api-key-env", "NEW_PROVIDER_KEY");
    await press(key("s"));

    expect(state.toast).toBe("saved, not active · provider check failed");
    expect(state.settings?.view.pendingRevision).not.toBe(null);
    // Editing stays available for the retry.
    await selectRow(press, state, "model");
    await press(key("return"));
    expect(state.settings?.edit?.row).toBe("model");
  });

  test("a save whose activation commits reports active credentials without a restart", async () => {
    const { source, state, press } = harness();
    if (!source.settingsView.editable) throw new Error("demo settings must be editable");
    const active = source.settingsView;
    source.api.saveSettings = async (command) => {
      const candidateRevision = active.activeRevision + 1;
      const outcome = {
        transactionId: command.mutationId,
        candidateRevision,
        result: "committed" as const,
        errorCode: null,
        atStateGeneration: active.stateGeneration + 6
      };
      source.settingsView = {
        ...active,
        stateGeneration: active.stateGeneration + 6,
        activeRevision: candidateRevision,
        pendingRevision: null,
        document: command.document,
        effective: basicSettingsFromDocument(command.document),
        lastActivationOutcome: outcome
      };
      return {
        kind: "settings",
        settingsStateGeneration: active.stateGeneration + 1,
        activeSettingsRevision: active.activeRevision,
        pendingSettingsRevision: candidateRevision,
        activationOutcome: outcome
      };
    };
    source.api.getSettings = async () => source.settingsView;

    await openSettings(press);
    await selectRow(press, state, "provider");
    await press(key("right"));
    await draftRow(press, state, "base-url", "https://api.openai.com/v1");
    await draftRow(press, state, "model", "gpt-5.6");
    await draftRow(press, state, "api-key-env", "NEW_PROVIDER_KEY");
    await press(key("s"));

    expect(state.toast).toBe("settings saved · credentials active");
    expect(state.settings?.view.pendingRevision).toBe(null);
    expect(state.settings?.view.effective.model).toBe("gpt-5.6");
  });

  test("a staged view stays fully editable and can retry, check, or discard", async () => {
    const { source, state, press } = harness();
    if (!source.settingsView.editable) throw new Error("demo settings must be editable");
    const active = source.settingsView;
    const candidateSettings = { ...source.settings, model: "candidate-model" };
    const staged = {
      ...active,
      stateGeneration: active.stateGeneration + 3,
      pendingRevision: active.activeRevision + 1,
      document: applyBasicSettingsDraft(active.document, candidateSettings),
      lastActivationOutcome: {
        transactionId: "m1.0000000000000.00000000000000000000000000000000",
        candidateRevision: active.activeRevision + 1,
        result: "validation-failed" as const,
        errorCode: "candidate_invalid" as const,
        atStateGeneration: active.stateGeneration + 3
      }
    };
    source.settingsView = staged;
    source.api.getSettings = async () => source.settingsView;
    const probes: ProviderProbeTarget[] = [];
    source.api.checkModelServer = async (target) => {
      probes.push(target);
      return { state: "ready", message: "staged candidate is reachable" };
    };
    let expectedGeneration: number | null = null;
    source.api.discardPendingSettings = async (command) => {
      expectedGeneration = command.expectedStateGeneration;
      source.settingsView = {
        ...active,
        stateGeneration: staged.stateGeneration + 1,
        pendingRevision: null
      };
      return {
        kind: "settings",
        settingsStateGeneration: source.settingsView.stateGeneration,
        activeSettingsRevision: source.settingsView.activeRevision,
        pendingSettingsRevision: null,
        activationOutcome: null
      };
    };

    await openSettings(press);
    // The overlay edits the staged candidate document, not the active one.
    expect(state.settings?.draft.generation.model).toBe("candidate-model");
    await draftRow(press, state, "model", "fixed-model");
    expect(state.settings?.draft.generation.model).toBe("fixed-model");
    expect(settingsDraftChanged(state.settings!)).toBeTrue();

    // check server probes the edited draft over the staged document.
    await press(key("c"));
    expect(probes).toHaveLength(1);
    expect(generationFromProbeTarget(probes[0]!).model).toBe("fixed-model");

    await press(key("x"));
    expect(expectedGeneration).toBe(staged.stateGeneration);
    expect(state.settings?.view.pendingRevision).toBe(null);
  });

  test("s retries a staged activation without requiring an edit first", async () => {
    const { source, state, press } = harness();
    if (!source.settingsView.editable) throw new Error("demo settings must be editable");
    const active = source.settingsView;
    const candidateSettings = { ...source.settings, model: "candidate-model" };
    const staged = {
      ...active,
      stateGeneration: active.stateGeneration + 3,
      pendingRevision: active.activeRevision + 1,
      document: applyBasicSettingsDraft(active.document, candidateSettings),
      lastActivationOutcome: {
        transactionId: "m1.0000000000000.00000000000000000000000000000000",
        candidateRevision: active.activeRevision + 1,
        result: "validation-failed" as const,
        errorCode: "candidate_invalid" as const,
        atStateGeneration: active.stateGeneration + 3
      }
    };
    source.settingsView = staged;
    source.api.getSettings = async () => source.settingsView;
    const commands: SaveSettingsCommand[] = [];
    source.api.saveSettings = async (command) => {
      commands.push(command);
      const candidateRevision = staged.pendingRevision + 1;
      const outcome = {
        transactionId: command.mutationId,
        candidateRevision,
        result: "committed" as const,
        errorCode: null,
        atStateGeneration: staged.stateGeneration + 6
      };
      source.settingsView = {
        ...active,
        stateGeneration: staged.stateGeneration + 6,
        activeRevision: candidateRevision,
        pendingRevision: null,
        document: command.document,
        effective: basicSettingsFromDocument(command.document),
        lastActivationOutcome: outcome
      };
      return {
        kind: "settings",
        settingsStateGeneration: staged.stateGeneration + 1,
        activeSettingsRevision: staged.activeRevision,
        pendingSettingsRevision: candidateRevision,
        activationOutcome: outcome
      };
    };

    await openSettings(press);
    expect(settingsDraftChanged(state.settings!)).toBeFalse();
    await press(key("s"));

    expect(commands).toHaveLength(1);
    expect(basicSettingsFromDocument(commands[0]!.document).model)
      .toBe("candidate-model");
    expect(commands[0]!.expectedStateGeneration).toBe(staged.stateGeneration);
    expect(state.toast).toBe("settings saved · credentials active");
    expect(state.settings?.view.pendingRevision).toBe(null);
  });

  test("revision conflicts refresh the base while retaining the inline draft", async () => {
    const { source, state, press } = harness();
    if (!source.settingsView.editable) throw new Error("demo settings must be editable");
    const original = source.settingsView;
    const refreshedSettings = { ...original.effective, maxTokens: 4_096 };
    const refreshed = {
      ...original,
      stateGeneration: original.stateGeneration + 1,
      activeRevision: original.activeRevision + 1,
      document: applyBasicSettingsDraft(original.document, refreshedSettings),
      effective: refreshedSettings
    };
    const commands: SaveSettingsCommand[] = [];
    let current: SettingsView = original;
    source.api.saveSettings = async (command) => {
      commands.push(command);
      if (commands.length === 1) {
        current = refreshed;
        throw new WorkerApiError(createFailureEnvelope({
          code: "revision_conflict",
          message: "Settings changed since this edit began.",
          status: 409
        }));
      }
      if (!current.editable) throw new Error("refreshed settings must be editable");
      const effective = basicSettingsFromDocument(command.document);
      current = {
        ...current,
        stateGeneration: current.stateGeneration + 1,
        activeRevision: current.activeRevision + 1,
        document: command.document,
        effective
      };
      return {
        kind: "settings",
        settingsStateGeneration: current.stateGeneration,
        activeSettingsRevision: current.activeRevision,
        pendingSettingsRevision: null,
        activationOutcome: null
      };
    };
    source.api.getSettings = async () => current;
    await openSettings(press);
    await draftRow(press, state, "max-tokens", "1024");

    await press(key("s"));
    expect(commands).toHaveLength(1);
    expect(state.settings?.draft.generation.maxTokens).toBe(1_024);
    expect(state.settings?.base.generation.maxTokens).toBe(4_096);
    expect(state.settings?.conflict?.armed).toBeFalse();

    await press(key("s"));
    expect(commands).toHaveLength(1);
    expect(state.settings?.conflict?.armed).toBeTrue();
    await press(key("s"));
    expect(commands).toHaveLength(2);
    expect(commands[1]!.mutationId).not.toBe(commands[0]!.mutationId);
    expect(state.settings?.draft.generation.maxTokens).toBe(1_024);
  });

  test("an authoritative refresh matching the draft clears conflict state", async () => {
    const { source, state, press } = harness();
    let saves = 0;
    source.api.saveSettings = async () => {
      saves += 1;
      throw new Error("matching drafts must not save");
    };
    await openSettings(press);
    await draftRow(press, state, "max-tokens", "1024");
    const current = source.settingsView;
    if (!current.editable) throw new Error("demo settings must be editable");
    const document = applyBasicSettingsDraft(current.document, {
      ...state.settings!.draft.generation,
      maxTokens: 1_024
    });
    const converged: SettingsView = {
      ...current,
      stateGeneration: current.stateGeneration + 1,
      activeRevision: current.activeRevision + 1,
      document,
      effective: basicSettingsFromDocument(document)
    };

    publishSettingsView(state, source, converged);

    expect(state.settings?.conflict).toBe(null);
    expect(settingsDraftChanged(state.settings!)).toBeFalse();
    await press(key("s"));
    expect(saves).toBe(0);
    expect(state.toast).toBe("unchanged · no-op");
  });

  test("unknown save outcomes retry the frozen command and keep newer row drafts", async () => {
    const { source, state, press } = harness();
    let current = source.settingsView;
    const commands: SaveSettingsCommand[] = [];
    source.api.saveSettings = async (command) => {
      commands.push(command);
      if (commands.length === 1) throw new Error("lost reply");
      if (!current.editable) throw new Error("demo settings must be editable");
      const effective = basicSettingsFromDocument(command.document);
      current = {
        ...current,
        stateGeneration: current.stateGeneration + 1,
        activeRevision: current.activeRevision + 1,
        document: command.document,
        effective
      };
      return {
        kind: "settings",
        settingsStateGeneration: current.stateGeneration,
        activeSettingsRevision: current.activeRevision,
        pendingSettingsRevision: null,
        activationOutcome: null
      };
    };
    source.api.getSettings = async () => current;
    await openSettings(press);
    await draftRow(press, state, "max-tokens", "1024");
    try {
      await press(key("s"));
    } catch (error) {
      expect((error as Error).message).toBe("lost reply");
    }
    await draftRow(press, state, "max-tokens", "512");
    await press(key("s"));

    expect(commands).toHaveLength(2);
    const { transportOperationId: firstTransport, ...firstDurable } = commands[0]!;
    const { transportOperationId: secondTransport, ...secondDurable } = commands[1]!;
    expect(secondDurable).toEqual(firstDurable);
    expect(secondTransport).not.toBe(firstTransport);
    expect(state.settings?.draft.generation.maxTokens).toBe(512);
    expect(state.toast).toBe("settings saved · newer edits kept");

    await press(key("s"));
    expect(commands).toHaveLength(3);
    expect(commands[2]!.mutationId).not.toBe(commands[1]!.mutationId);
    expect(state.settings?.draft.generation.maxTokens).toBe(512);
  });
});
