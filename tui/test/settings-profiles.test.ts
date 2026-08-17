import { describe, expect, test } from "bun:test";
import { resolveSettingsProfile, selectSettingsRoute } from "../../shared/settings-route.js";
import type {
  SaveSettingsCommand,
  ProviderProbeTarget
} from "../../shared/settings-v2-types.js";
import { MAX_ALTERNATIVE_TOKENS } from "../../shared/token-probabilities.js";
import { setComposerText } from "../src/composer-model.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { frameText } from "../src/screens/story/frame.js";
import { settingsTextDraftForDocument } from "../src/settings-text.js";
import { publishCurrentSettingsModelDiscovery } from "../src/settings-model-discovery.js";
import {
  draftRow,
  key,
  openSettings,
  selectRow,
  settingsHarness
} from "./settings-test-harness.js";
import {
  declareSelectedModelReturnsReasoning,
  declareSelectedModelSupportsEffort,
  installNetworkSettings,
  savedResult,
  savedView
} from "./settings-profiles-test-helpers.js";

describe("Generation Profile settings", () => {
  test("saves the complete profile document, routes, and selected profile behavior", async () => {
    const { source, state, press } = settingsHarness();
    const current = installNetworkSettings(source);
    const commands: SaveSettingsCommand[] = [];
    source.api.saveSettings = async (command) => {
      commands.push(command);
      const saved = savedView(current, command.document);
      source.settingsView = saved;
      return savedResult(saved);
    };
    source.api.getSettings = async () => source.settingsView;

    await openSettings(press);
    await selectRow(press, state, "profile");
    await press(key("n"));
    await press(key("e"));
    expect(state.settings?.edit?.row).toBe("profile");
    setComposerText(state.settings!.edit!.composer, "Utility");
    await press(key("return"));

    await draftRow(press, state, "model", "gpt-5.6-terra");
    declareSelectedModelSupportsEffort(state);
    await selectRow(press, state, "effort");
    await press(key("right"));
    await selectRow(press, state, "cache-policy");
    await press(key("right"));
    await selectRow(press, state, "utility-route");
    await press(key("right"));
    await press(key("right"));
    await press(key("s"));

    expect(commands).toHaveLength(1);
    const document = commands[0]!.document;
    const utility = document.profiles["profile.1"];
    if (utility === undefined) throw new Error("new profile was not saved");
    expect(utility).toMatchObject({ name: "Utility", effort: "off", cachePolicy: "auto" });
    expect(document.routing.utility).toBe("profile.1");
    expect(document.routing.prose).toBe(undefined);
    expect(selectSettingsRoute(document, "utility").profileId).toBe("profile.1");
    expect(document.models[document.profiles.default!.modelId]!.remoteId).toBe("gpt-5.6");
    expect(document.models[utility.modelId]!.remoteId).toBe("gpt-5.6-terra");
    expect(utility.modelId).not.toBe(document.profiles.default!.modelId);
  });

  test("edits a duplicated profile connection without changing its original", async () => {
    const { source, state, press } = settingsHarness();
    installNetworkSettings(source);
    await openSettings(press);
    await selectRow(press, state, "profile");
    await press(key("n"));
    await draftRow(press, state, "base-url", "https://example.com/v1");

    const document = state.settings?.draft.document;
    if (document === null || document === undefined) throw new Error("editable document missing");
    const original = selectSettingsRoute(document, "default");
    const selectedProfile = state.settings?.draft.selectedProfileId;
    if (selectedProfile === null || selectedProfile === undefined) throw new Error("selected profile missing");
    const selectedRoute = resolveSettingsProfile(document, selectedProfile);
    expect(original.connection.baseUrl).toBe("https://api.openai.com/v1");
    expect(original.model.connectionId).not.toBe(selectedRoute.model.connectionId);
    expect(selectedRoute.connection.baseUrl).toBe("https://example.com/v1");
  });

  test("clearing a duplicated stored key preserves the original profile credential", async () => {
    const { source, state, press } = settingsHarness();
    const current = installNetworkSettings(source, "demo.saved-key");
    const commands: SaveSettingsCommand[] = [];
    source.api.saveSettings = async (command) => {
      commands.push(command);
      return savedResult(current);
    };
    await openSettings(press);
    await selectRow(press, state, "profile");
    await press(key("n"));
    await draftRow(press, state, "api-key", "");

    const document = state.settings?.draft.document;
    if (document === null || document === undefined) throw new Error("editable document missing");
    const original = selectSettingsRoute(document, "default");
    const selectedId = state.settings?.draft.selectedProfileId;
    if (selectedId === null || selectedId === undefined) throw new Error("selected profile missing");
    expect(original.connection.auth).toEqual({ type: "bearer-stored", secretId: "demo.saved-key" });
    expect(resolveSettingsProfile(document, selectedId).connection.auth).toEqual({ type: "none" });
    expect(state.settings?.connectionSecrets["demo.saved-key"]).toBe(undefined);

    await press(key("s"));
    expect(commands).toHaveLength(1);
    expect(commands[0]!.connectionSecrets).toBe(undefined);
  });

  test("profile rename has an inline editor and a visible compact footer at 80 columns", async () => {
    const { state, cache, press } = settingsHarness();
    await openSettings(press);
    await selectRow(press, state, "profile");
    expect(frameText(renderStoryScreen(state, { width: 80, height: 24, wrapCache: cache }).lines))
      .toContain("↑↓ ←→ n N i e d s esc");
    await press(key("e"));
    expect(state.settings?.edit?.row).toBe("profile");
  });

  test("shows profile actions and pending discard together", async () => {
    const { state, cache, press } = settingsHarness();
    await openSettings(press);
    await selectRow(press, state, "profile");
    if (state.settings?.view.dataFormat !== 2) throw new Error("editable settings missing");
    state.settings!.view = { ...state.settings!.view, pendingRevision: 2 };
    const frame = frameText(renderStoryScreen(
      state,
      { width: 120, height: 30, wrapCache: cache }
    ).lines);
    expect(frame).toContain("n new · ⇧n copy · i import · e rename · d delete · s · x · esc");
  });

  test("requires two uninterrupted delete commands for a profile", async () => {
    const { source, state, press } = settingsHarness();
    installNetworkSettings(source);
    await openSettings(press);
    await selectRow(press, state, "profile");
    await press(key("n"));

    await press(key("d"));
    expect(state.settings?.deleteArmedProfileId).toBe("profile.1");
    await press(key("e"));
    setComposerText(state.settings!.edit!.composer, "Renamed");
    await press(key("return"));
    expect(state.settings?.deleteArmedProfileId).toBe(null);

    await press(key("d"));
    expect(state.settings?.draft.document?.profiles["profile.1"]?.name).toBe("Renamed");
    expect(state.settings?.deleteArmedProfileId).toBe("profile.1");
  });

  test("duplicates a 256-scalar profile name with a bounded unique suffix", async () => {
    const { source, state, press } = settingsHarness();
    installNetworkSettings(source);
    const name = "a".repeat(256);
    await openSettings(press);
    await selectRow(press, state, "profile");
    await press(key("e"));
    setComposerText(state.settings!.edit!.composer, name);
    await press(key("return"));
    await press(key("N"));

    const duplicate = state.settings?.draft.document?.profiles["profile.1"];
    expect(duplicate?.name).toBe(`${"a".repeat(251)} copy`);
    expect([...duplicate!.name]).toHaveLength(256);
  });

  test("cycles default and prose routes, then deletes a routed profile and rejects the last delete", async () => {
    const { source, state, press } = settingsHarness();
    installNetworkSettings(source);
    await openSettings(press);
    await selectRow(press, state, "profile");
    await press(key("n"));

    await selectRow(press, state, "default-route");
    await press(key("right"));
    await selectRow(press, state, "prose-route");
    await press(key("right"));
    await press(key("right"));
    await selectRow(press, state, "utility-route");
    await press(key("right"));
    await press(key("right"));
    let document = state.settings?.draft.document;
    expect(document?.routing).toEqual({
      default: "profile.1",
      prose: "profile.1",
      utility: "profile.1"
    });

    await selectRow(press, state, "profile");
    await press(key("d"));
    await press(key("d"));
    document = state.settings?.draft.document;
    expect(document?.profiles.default !== undefined).toBeTrue();
    expect(document?.profiles["profile.1"]).toBe(undefined);
    expect(document?.routing).toEqual({ default: "default" });

    await press(key("d"));
    expect(state.settings?.deleteArmedProfileId).toBe(null);
    expect(state.toast).toBe("profile kept · the last profile cannot be removed");
  });

  test("deleting a profile removes only its private model and connection", async () => {
    const { source, state, press } = settingsHarness();
    installNetworkSettings(source);
    await openSettings(press);
    await selectRow(press, state, "profile");
    await press(key("n"));
    await draftRow(press, state, "base-url", "https://profile.example/v1");

    let document = state.settings?.draft.document;
    expect(Object.keys(document?.profiles ?? {})).toHaveLength(2);
    expect(Object.keys(document?.models ?? {})).toHaveLength(2);
    expect(Object.keys(document?.connections ?? {})).toHaveLength(2);

    await selectRow(press, state, "profile");
    await press(key("d"));
    await press(key("d"));

    document = state.settings?.draft.document;
    expect(Object.keys(document?.profiles ?? {})).toHaveLength(1);
    expect(Object.keys(document?.models ?? {})).toHaveLength(1);
    expect(Object.keys(document?.connections ?? {})).toHaveLength(1);
    expect(selectSettingsRoute(document!, "default").connection.baseUrl)
      .toBe("https://api.openai.com/v1");
  });

  test("drops a dry-run profile's pending key but preserves another profile's key", async () => {
    const { source, state, press } = settingsHarness();
    installNetworkSettings(source);
    const probes: ProviderProbeTarget[] = [];
    source.api.discoverModels = async (target) => {
      probes.push(target);
      return { observedAt: "2026-08-01T00:00:00.000Z", models: [] };
    };
    await openSettings(press);
    await draftRow(press, state, "api-key", "default-key");
    const defaultSecretId = Object.keys(state.settings!.connectionSecrets)[0]!;

    await selectRow(press, state, "profile");
    await press(key("N"));
    await draftRow(press, state, "api-key", "profile-key");
    const profileSecretId = Object.keys(state.settings!.connectionSecrets)
      .find((id) => id !== defaultSecretId)!;
    const selectedProbe = probes.at(-1);
    if (selectedProbe === undefined || !("kind" in selectedProbe)) {
      throw new Error("expected a settings-document probe");
    }
    expect(selectedProbe.secrets).toEqual({ [profileSecretId]: "profile-key" });
    await selectRow(press, state, "provider");
    await press(key("left"));

    const document = state.settings?.draft.document;
    if (document === null || document === undefined) throw new Error("editable document missing");
    expect(state.settings?.draft.generation.provider).toBe("dry-run");
    expect(state.settings?.connectionSecrets).toEqual({ [defaultSecretId]: "default-key" });
    expect(state.settings?.connectionSecrets[profileSecretId]).toBe(undefined);
    expect(resolveSettingsProfile(document, "default").connection.auth)
      .toEqual({ type: "bearer-stored", secretId: defaultSecretId });
    expect(resolveSettingsProfile(document, "profile.1").connection.auth).toEqual({ type: "none" });
  });

  test("shows an unavailable imported effort and resets it to default in either direction", async () => {
    const { source, state, cache, press } = settingsHarness();
    installNetworkSettings(source);
    await openSettings(press);
    const document = state.settings?.draft.document;
    if (document === null || document === undefined) throw new Error("editable document missing");
    const modelId = document.profiles.default!.modelId;
    const unsupported = {
      ...document,
      profiles: {
        ...document.profiles,
        default: { ...document.profiles.default!, effort: "high" as const }
      },
      models: {
        ...document.models,
        [modelId]: {
          ...document.models[modelId]!,
          capabilities: {
            ...document.models[modelId]!.capabilities,
            reasoningEffort: "unknown" as const
          }
        }
      }
    };
    state.settings!.draft = settingsTextDraftForDocument(
      unsupported,
      undefined
    );
    await selectRow(press, state, "effort");
    expect(frameText(renderStoryScreen(state, { width: 80, height: 24, wrapCache: cache }).lines))
      .toContain("‹ high ›");
    expect(frameText(renderStoryScreen(state, { width: 80, height: 24, wrapCache: cache }).lines))
      .toContain("This model does not support reasoning effort.");
    await press(key("left"));
    expect(state.settings?.draft.document?.profiles.default?.effort).toBe("default");

    state.settings!.draft = settingsTextDraftForDocument(
      unsupported,
      undefined
    );
    await press(key("right"));
    expect(state.settings?.draft.document?.profiles.default?.effort).toBe("default");
  });

  test("alternatives writes the count on, and clears the field entirely on off", async () => {
    const { source, state, press } = settingsHarness();
    const current = installNetworkSettings(source);
    const commands: SaveSettingsCommand[] = [];
    source.api.saveSettings = async (command) => {
      commands.push(command);
      const saved = savedView(current, command.document);
      source.settingsView = saved;
      return savedResult(saved);
    };

    await openSettings(press);
    expect(state.settings?.draft.document?.profiles.default?.tokenProbabilities).toBe(undefined);
    await selectRow(press, state, "token-probabilities");
    await press(key("right"));
    await press(key("right"));
    expect(state.settings?.draft.document?.profiles.default?.tokenProbabilities).toBe(2);
    await press(key("s"));

    expect(commands).toHaveLength(1);
    expect(commands[0]!.document.profiles.default!.tokenProbabilities).toBe(2);

    await selectRow(press, state, "token-probabilities");
    await press(key("left"));
    await press(key("left"));
    expect(state.settings?.draft.document?.profiles.default?.tokenProbabilities).toBe(undefined);
    await press(key("s"));

    expect(commands).toHaveLength(2);
    // Absent, not written as `tokenProbabilities: 0` and not written as
    // `undefined` — the key itself must be gone from the saved document.
    expect(Object.hasOwn(commands[1]!.document.profiles.default!, "tokenProbabilities")).toBe(false);
  });

  test("alternatives cycles off and 1..20 without ever landing on 0 or 21", async () => {
    const { source, state, press } = settingsHarness();
    installNetworkSettings(source);
    await openSettings(press);
    await selectRow(press, state, "token-probabilities");
    const current = () => state.settings?.draft.document?.profiles.default?.tokenProbabilities;

    for (let count = 1; count <= MAX_ALTERNATIVE_TOKENS; count += 1) {
      await press(key("right"));
      expect(current()).toBe(count);
    }
    // One more step past the ceiling wraps back to off, never 21.
    await press(key("right"));
    expect(current()).toBe(undefined);

    // Stepping down from off wraps to the top of the range, never 0 or negative.
    await press(key("left"));
    expect(current()).toBe(MAX_ALTERNATIVE_TOKENS);
  });

  test("alternatives shows the capability matrix's reason instead of a value on an unavailable preset", async () => {
    const { source, state, cache, press } = settingsHarness();
    installNetworkSettings(source);
    await openSettings(press);
    const document = state.settings?.draft.document;
    if (document === null || document === undefined) throw new Error("editable document missing");
    const modelId = document.profiles.default!.modelId;
    const connectionId = document.models[modelId]!.connectionId;
    // Ollama documents no token-probability fields (shared/token-probability-
    // capabilities.ts), while remaining a perfectly ordinary openai-chat-
    // completions connection — the same "preset-unknown" case a live Ollama
    // endpoint hits.
    const unavailable = {
      ...document,
      connections: {
        ...document.connections,
        [connectionId]: { ...document.connections[connectionId]!, preset: "ollama" as const }
      }
    };
    state.settings!.draft = settingsTextDraftForDocument(
      unavailable,
      undefined
    );
    await selectRow(press, state, "token-probabilities");
    const frame = frameText(renderStoryScreen(state, { width: 80, height: 24, wrapCache: cache }).lines);
    expect(frame).toContain("‹ — ›");
    expect(frame).toContain("· Alternative token data might not be available from");
    expect(frame).toContain("· this provider.");

    // Cycling an unavailable row is a no-op: it never writes a count the
    // request was never going to carry.
    await press(key("right"));
    expect(state.settings?.draft.document?.profiles.default?.tokenProbabilities).toBe(undefined);
  });

  test("prompt cache explains provider-managed retention in Settings", async () => {
    const { source, state, cache, press } = settingsHarness();
    installNetworkSettings(source);
    await openSettings(press);
    const document = state.settings?.draft.document;
    if (document === null || document === undefined) throw new Error("editable document missing");
    const profileId = state.settings!.draft.selectedProfileId!;
    const modelId = document.profiles[profileId]!.modelId;
    await selectRow(press, state, "cache-policy");
    const offFrame = frameText(renderStoryScreen(state, {
      width: 120,
      height: 36,
      wrapCache: cache
    }).lines);
    expect(offFrame).toContain("Prompt caching is off for this profile.");

    const connectionId = document.models[modelId]!.connectionId;
    state.settings!.draft = settingsTextDraftForDocument({
      ...document,
      connections: {
        ...document.connections,
        [connectionId]: {
          ...document.connections[connectionId]!,
          baseUrl: "https://models.example.com/v1"
        }
      }
    }, profileId);
    const compatibleFrame = frameText(renderStoryScreen(state, {
      width: 120,
      height: 36,
      wrapCache: cache
    }).lines);
    expect(compatibleFrame).toContain("The provider might manage prompt caching.");

    state.settings!.draft = settingsTextDraftForDocument({
      ...document,
      profiles: {
        ...document.profiles,
        [profileId]: { ...document.profiles[profileId]!, cachePolicy: "auto" }
      },
      models: {
        ...document.models,
        [modelId]: { ...document.models[modelId]!, remoteId: "gpt-4o" }
      }
    }, profileId);

    const frame = frameText(renderStoryScreen(state, { width: 120, height: 36, wrapCache: cache }).lines);
    expect(frame).toContain("The provider decides how long");
    expect(frame).toContain("· to keep it.");
    expect(frame).not.toContain("for provider");

    const shortFrame = frameText(renderStoryScreen(state, {
      width: 40,
      height: 14,
      wrapCache: cache
    }).lines);
    expect(shortFrame).toContain("▸ prompt cache");
    expect(shortFrame).toContain("Lets the");
    expect(shortFrame.split("\n").some((line) => line.includes("·") && line.includes("…")))
      .toBeTrue();
  });

  test("reasoning is disabled only where the model reports it returns none", async () => {
    const { source, state, cache, press } = settingsHarness();
    installNetworkSettings(source);
    await openSettings(press);
    declareSelectedModelReturnsReasoning(state, "unsupported");
    await selectRow(press, state, "reasoning");
    const frame = frameText(renderStoryScreen(state, { width: 120, height: 24, wrapCache: cache }).lines);
    expect(frame).toContain("‹ — ›");
    expect(frame).toContain("This model does not provide reasoning.");

    // Cycling a disabled row only ever snaps to its one available choice,
    // `off` — the same "resets to the sole available choice" behavior the
    // effort row's own unavailable-import test exercises above — never a
    // fold state the route was never going to populate.
    await press(key("right"));
    expect(state.settings?.draft.document?.profiles.default?.reasoning).toBe("off");
    await press(key("left"));
    expect(state.settings?.draft.document?.profiles.default?.reasoning).toBe("off");
  });

  test("reasoning stays usable on a model that never declared the capability", async () => {
    // Discovery never promotes a model to "supported", so gating on that
    // would leave this row reading `‹ — ›` on every real route.
    const { source, state, cache, press } = settingsHarness();
    installNetworkSettings(source);
    await openSettings(press);
    await selectRow(press, state, "reasoning");
    const frame = frameText(renderStoryScreen(state, { width: 120, height: 24, wrapCache: cache }).lines);
    expect(frame).toContain("‹ marker ›");
    expect(frame).not.toContain("returns none");

    await press(key("right"));
    expect(state.settings?.draft.document?.profiles.default?.reasoning).toBe("open");
  });

  test("reasoning cycles off/marker/open once the model confirms it, and drops the key back at marker", async () => {
    const { source, state, press } = settingsHarness();
    installNetworkSettings(source);
    await openSettings(press);
    declareSelectedModelReturnsReasoning(state);
    await selectRow(press, state, "reasoning");
    const current = () => state.settings?.draft.document?.profiles.default?.reasoning;

    // marker is the default fold state and starts absent.
    expect(current()).toBe(undefined);
    await press(key("right"));
    expect(current()).toBe("open");
    await press(key("right"));
    expect(current()).toBe("off");
    await press(key("right"));
    // Wraps back to marker, written as absent, not the literal string.
    expect(current()).toBe(undefined);
    expect(Object.hasOwn(state.settings!.draft.document!.profiles.default!, "reasoning")).toBe(false);
    await press(key("left"));
    expect(current()).toBe("off");
  });

  test("keep thoughts defaults on and toggles discardReasoning independent of the reasoning capability", async () => {
    const { source, state, press } = settingsHarness();
    const current = installNetworkSettings(source);
    const commands: SaveSettingsCommand[] = [];
    source.api.saveSettings = async (command) => {
      commands.push(command);
      const saved = savedView(current, command.document);
      source.settingsView = saved;
      return savedResult(saved);
    };
    await openSettings(press);
    expect(state.settings?.draft.document?.profiles.default?.discardReasoning).toBe(undefined);
    await selectRow(press, state, "keep-thoughts");
    await press(key("right"));
    expect(state.settings?.draft.document?.profiles.default?.discardReasoning).toBe(true);
    await press(key("s"));

    expect(commands).toHaveLength(1);
    expect(commands[0]!.document.profiles.default!.discardReasoning).toBe(true);

    await selectRow(press, state, "keep-thoughts");
    await press(key("left"));
    expect(state.settings?.draft.document?.profiles.default?.discardReasoning).toBe(undefined);
    expect(
      Object.hasOwn(state.settings!.draft.document!.profiles.default!, "discardReasoning")
    ).toBe(false);
  });

  test("a nonmatching discovery result does not allocate a model during save", async () => {
    const { source, state, press } = settingsHarness();
    const current = installNetworkSettings(source);
    const commands: SaveSettingsCommand[] = [];
    source.api.saveSettings = async (command) => {
      commands.push(command);
      const saved = savedView(current, command.document);
      source.settingsView = saved;
      return savedResult(saved);
    };
    source.api.getSettings = async () => source.settingsView;

    await openSettings(press);
    await selectRow(press, state, "profile");
    await press(key("n"));
    await press(key("e"));
    setComposerText(state.settings!.edit!.composer, "Utility");
    await press(key("return"));

    const draft = state.settings!.draft;
    if (draft.document === null || draft.selectedProfileId === null) {
      throw new Error("editable document missing");
    }
    const selected = resolveSettingsProfile(draft.document, draft.selectedProfileId);
    const models = { ...draft.document.models };
    for (let number = 1; Object.keys(models).length < 64; number += 1) {
      models[`imported.${number}`] = {
        ...selected.model,
        remoteId: `imported-${number}`,
        name: `Imported ${number}`
      };
    }
    state.settings!.draft = settingsTextDraftForDocument({
      ...draft.document,
      models
    }, draft.selectedProfileId);
    publishCurrentSettingsModelDiscovery(state.settings!, {
      observedAt: "2026-08-01T00:00:00.000Z",
      models: [{
        remoteId: "some-other-model",
        name: "Some other model",
        contextWindow: null,
        maxOutputTokens: null,
        source: "openai-models"
      }]
    });

    await press(key("s"));

    expect(commands).toHaveLength(1);
    expect(Object.keys(commands[0]!.document.models)).toHaveLength(64);
  });

});
