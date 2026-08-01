import { describe, expect, test } from "bun:test";
import {
  applyBasicSettingsDraft,
  basicSettingsFromDocument
} from "../../shared/settings-basic-draft.js";
import type { SaveSettingsCommand } from "../../shared/settings-v2-types.js";
import { initialState } from "../src/app.js";
import { demoAppSource } from "../src/demo.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { frameText } from "../src/screens/story/frame.js";
import { setComposerText } from "../src/composer-model.js";
import { createWrapCache } from "../src/wrap.js";
import {
  installSave,
  key,
  openSettings,
  selectRow,
  settingsHarness
} from "./settings-test-harness.js";

describe("Sampling Settings review regressions", () => {
  test("cancelling a pending stop or logit row keeps the persisted row selected for the next action", async () => {
    const { source, state, press } = settingsHarness();
    useSupportedSettings(source);
    await enterSampling(state, press);

    await moveLayer2Cursor(press, 6);
    await press(key("return"));
    await press(key("n"));
    setSamplingEdit(state, "END");
    await press(key("return"));
    await press(key("n"));
    await press(key("escape"));
    expect(render(state, 80, 24)).toContain("▸ 01");
    await press(key("d"));
    expect(state.settings?.draft.sampling.stop).toEqual([]);

    await press(key("escape"));
    await moveLayer2Cursor(press, 7);
    await press(key("return"));
    await press(key("n"));
    setSamplingEdit(state, "42:7");
    await press(key("return"));
    await press(key("n"));
    await press(key("escape"));
    expect(render(state, 80, 24).split("\n").some((line) =>
      line.includes("▸") && line.includes("42")
    )).toBeTrue();
    await press(key("d"));
    expect(state.settings?.draft.sampling.logitBias).toEqual({});
  });

  test("renders reorder controls for stop sequences but not logit bias", async () => {
    const { source, state, press } = settingsHarness();
    useSupportedSettings(source);
    await enterSampling(state, press);

    await moveLayer2Cursor(press, 6);
    await press(key("return"));
    const stopFrame = render(state, 120, 24);
    expect(stopFrame).toContain("reorder");

    await press(key("escape"));
    await moveLayer2Cursor(press, 7);
    await press(key("return"));
    const logitFrame = render(state, 120, 24);
    expect(logitFrame).not.toContain("reorder");
    expect(logitFrame).toContain("n add · d delete · esc back");
  });

  test("retains sampling when a profile control changes before save", async () => {
    const { source, state, press } = settingsHarness();
    useSupportedSettings(source, "https://api.openai.com/v1");
    const saved: SaveSettingsCommand[] = [];
    installSave(source, saved);

    await enterSampling(state, press);
    await press(key("return"));
    setSamplingEdit(state, "0.7");
    await press(key("return"));
    await press(key("escape"));

    await selectRow(press, state, "cache-policy");
    await press(key("right"));
    await press(key("s"));

    expect(saved).toHaveLength(1);
    const profile = saved[0]!.document.profiles[saved[0]!.document.routing.default]!;
    expect(profile.cachePolicy).toBe("auto");
    expect(profile.sampling?.topP).toBe(0.7);
  });

  test("uses an unsaved selected profile for Sampling capability and save", async () => {
    const { source, state, press } = settingsHarness();
    useSupportedSettings(source);
    const saved: SaveSettingsCommand[] = [];
    installSave(source, saved);

    await openSettings(press);
    await selectRow(press, state, "profile");
    await press(key("N"));
    const selectedProfileId = state.settings?.draft.selectedProfileId;
    expect(selectedProfileId).toBe("profile.1");

    await selectRow(press, state, "sampling");
    await press(key("return"));
    expect(render(state, 80, 24)).toContain("top p");
    await press(key("return"));
    setSamplingEdit(state, "0.8");
    await press(key("return"));
    await press(key("escape"));
    await press(key("s"));

    expect(saved).toHaveLength(1);
    const document = saved[0]!.document;
    expect(document.profiles[selectedProfileId!]!.sampling?.topP).toBe(0.8);
    expect(document.profiles.default!.sampling).toBe(undefined);
  });
});

async function enterSampling(
  state: ReturnType<typeof settingsHarness>["state"],
  press: ReturnType<typeof settingsHarness>["press"]
): Promise<void> {
  await openSettings(press);
  await selectRow(press, state, "sampling");
  await press(key("return"));
  expect(state.settings?.sampling?.panel).toBe("sampling");
}

function setSamplingEdit(
  state: ReturnType<typeof settingsHarness>["state"],
  value: string
): void {
  const edit = state.settings?.sampling?.edit;
  if (edit === null || edit === undefined) throw new Error("sampling edit did not open");
  setComposerText(edit.composer, value);
}

async function moveLayer2Cursor(
  press: ReturnType<typeof settingsHarness>["press"],
  target: number
): Promise<void> {
  for (let index = 0; index < target; index += 1) await press(key("down"));
}

function useSupportedSettings(
  source: ReturnType<typeof demoAppSource>,
  baseUrl = "http://127.0.0.1:8080/v1"
): void {
  const active = source.settingsView;
  if (!active.editable) throw new Error("demo settings must be editable");
  const generation = {
    ...source.settings,
    provider: "openai-compatible" as const,
    baseUrl,
    model: "gpt-5.2",
    apiKeyEnv: null
  };
  const document = applyBasicSettingsDraft(active.document, generation);
  source.settingsView = {
    ...active,
    document,
    effective: basicSettingsFromDocument(document)
  } satisfies typeof source.settingsView;
  source.api.getSettings = async () => source.settingsView;
}

function render(
  state: ReturnType<typeof initialState>,
  width: number,
  height: number
): string {
  const rendered = renderStoryScreen(state, {
    width,
    height,
    wrapCache: createWrapCache()
  });
  Object.assign(state, rendered.derived);
  return frameText(rendered.lines);
}
