import { describe, expect, test } from "bun:test";
import { SETTINGS_PROVIDER_CHOICES } from "../src/settings-provider-choices.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { frameText } from "../src/screens/story/frame.js";
import {
  draftRow,
  key,
  openSettings,
  selectRow,
  settingsHarness
} from "./settings-test-harness.js";

describe("Settings cache policy panel", () => {
  test("keeps every policy reachable", async () => {
    const { state, cache, press } = settingsHarness();
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

    const rendered = frameText(renderStoryScreen(
      state,
      { width: 80, height: 24, wrapCache: cache }
    ).lines);
    expect(rendered).toContain("▸ cache policy");
    expect(rendered).toContain("‹ long ›");
    expect(rendered).toContain("↑↓ move · ←→ choose · ↵ next · s save");
  });

  test("states the cost beside the chosen policy", async () => {
    const { state, cache, press } = settingsHarness();
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

  test("wraps KoboldCpp unavailable reasons without clipping", async () => {
    for (const policy of ["auto", "long"] as const) {
      const { source, state, cache, press } = settingsHarness();
      await openSettings(press);
      const choice = SETTINGS_PROVIDER_CHOICES.find(
        (candidate) => candidate.id === "koboldcpp"
      )!;
      state.settings!.draft = {
        ...state.settings!.draft,
        cachePolicy: policy,
        generation: {
          ...state.settings!.draft.generation,
          provider: choice.provider,
          ...choice.defaults
        }
      };
      await selectRow(press, state, "cache-policy");

      const rendered = frameText(renderStoryScreen(
        state,
        { width: 80, height: 24, wrapCache: cache }
      ).lines);
      expect(rendered).toContain(`‹ ${policy} › · unavailable`);
      expect(rendered).toContain("Only exact official provider presets");
      expect(rendered).toContain("receive cache fields.");
      expect(rendered).not.toContain("Model name cannot …");
      expect(source.settingsView.editable).toBeTrue();
    }
  });

  test("keeps the complete cache reason in a short window", async () => {
    const { state, cache, press } = settingsHarness();
    await openSettings(press);
    const choice = SETTINGS_PROVIDER_CHOICES.find(
      (candidate) => candidate.id === "koboldcpp"
    )!;
    state.settings!.draft = {
      ...state.settings!.draft,
      cachePolicy: "auto",
      generation: {
        ...state.settings!.draft.generation,
        provider: choice.provider,
        ...choice.defaults
      }
    };
    await selectRow(press, state, "cache-policy");

    const rendered = frameText(renderStoryScreen(
      state,
      { width: 60, height: 10, wrapCache: cache }
    ).lines);
    expect(rendered).toContain("Only exact official provider presets receive");
    expect(rendered).toContain("cache fields.");
    expect(rendered).not.toContain("cache fields…");
  });

  test("names unsupported long retention without denying automatic caching", async () => {
    const { state, cache, press } = settingsHarness();
    await openSettings(press);
    const choice = SETTINGS_PROVIDER_CHOICES.find(
      (candidate) => candidate.id === "openai-compatible"
    )!;
    state.settings!.draft = {
      ...state.settings!.draft,
      cachePolicy: "long",
      generation: {
        ...state.settings!.draft.generation,
        provider: choice.provider,
        ...choice.defaults,
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4o-mini"
      }
    };
    await selectRow(press, state, "cache-policy");

    const rendered = frameText(renderStoryScreen(
      state,
      { width: 60, height: 10, wrapCache: cache }
    ).lines);
    expect(rendered).toContain("Long retention is not supported for this");
    expect(rendered).toContain("exact model.");
  });

  test("uses a complete compact reason at the minimum panel size", async () => {
    const { state, cache, press } = settingsHarness();
    await openSettings(press);
    const choice = SETTINGS_PROVIDER_CHOICES.find(
      (candidate) => candidate.id === "koboldcpp"
    )!;
    state.settings!.draft = {
      ...state.settings!.draft,
      cachePolicy: "long",
      generation: {
        ...state.settings!.draft.generation,
        provider: choice.provider,
        ...choice.defaults
      }
    };
    await selectRow(press, state, "cache-policy");

    const rendered = frameText(renderStoryScreen(
      state,
      { width: 20, height: 10, wrapCache: cache }
    ).lines);
    expect(rendered).toContain("Official");
    expect(rendered).toContain("API only.");
    const notice = rendered.split("\n")
      .filter((line) => line.includes("Preset."));
    expect(notice.join("\n")).not.toContain("…");
  });

  test("keeps long-cache and unknown-model reasons in one minimum-width row", async () => {
    for (const fixture of [
      { policy: "long" as const, model: "gpt-4o-mini", reason: "No long cache." },
      { policy: "auto" as const, model: "unlisted-model", reason: "Set model ID." }
    ]) {
      const { state, cache, press } = settingsHarness();
      await openSettings(press);
      const choice = SETTINGS_PROVIDER_CHOICES.find(
        (candidate) => candidate.id === "openai-compatible"
      )!;
      state.settings!.draft = {
        ...state.settings!.draft,
        cachePolicy: fixture.policy,
        generation: {
          ...state.settings!.draft.generation,
          provider: choice.provider,
          ...choice.defaults,
          baseUrl: "https://api.openai.com/v1",
          model: fixture.model
        }
      };
      await selectRow(press, state, "cache-policy");

      const rendered = frameText(renderStoryScreen(
        state,
        { width: 20, height: 10, wrapCache: cache }
      ).lines);
      for (const word of fixture.reason.split(" ")) {
        expect(rendered).toContain(word);
      }
    }
  });

  test("uses complete canonical compact copy when height is limited", async () => {
    const { state, cache, press } = settingsHarness();
    await openSettings(press);
    const choice = SETTINGS_PROVIDER_CHOICES.find(
      (candidate) => candidate.id === "koboldcpp"
    )!;
    state.settings!.draft = {
      ...state.settings!.draft,
      cachePolicy: "auto",
      generation: {
        ...state.settings!.draft.generation,
        provider: choice.provider,
        ...choice.defaults
      }
    };
    await selectRow(press, state, "cache-policy");

    const rendered = frameText(renderStoryScreen(
      state,
      { width: 36, height: 10, wrapCache: cache }
    ).lines);
    expect(rendered).toContain("Official");
    expect(rendered).toContain("API only.");
  });

  test("keeps the cache reason ahead of a check result in a short window", async () => {
    const { state, cache, press } = settingsHarness();
    await openSettings(press);
    const choice = SETTINGS_PROVIDER_CHOICES.find(
      (candidate) => candidate.id === "koboldcpp"
    )!;
    state.settings!.draft = {
      ...state.settings!.draft,
      cachePolicy: "auto",
      generation: {
        ...state.settings!.draft.generation,
        provider: choice.provider,
        ...choice.defaults
      }
    };
    state.settings!.result = { state: "warning", message: "probe rejected" };
    await selectRow(press, state, "cache-policy");

    const rendered = frameText(renderStoryScreen(
      state,
      { width: 60, height: 10, wrapCache: cache }
    ).lines);
    expect(rendered).toContain("Only exact official provider presets receive");
    expect(rendered).toContain("cache fields.");
    expect(rendered).not.toContain("probe rejected");
  });
});
