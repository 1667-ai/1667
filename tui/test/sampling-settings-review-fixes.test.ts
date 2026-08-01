import { describe, expect, test } from "bun:test";
import {
  applyBasicSettingsDraft,
  basicSettingsFromDocument
} from "../../shared/settings-basic-draft.js";
import { initialState } from "../src/app.js";
import { demoAppSource } from "../src/demo.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { frameText } from "../src/screens/story/frame.js";
import { setComposerText } from "../src/composer-model.js";
import { createWrapCache } from "../src/wrap.js";
import {
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

function useSupportedSettings(source: ReturnType<typeof demoAppSource>): void {
  const active = source.settingsView;
  if (!active.editable) throw new Error("demo settings must be editable");
  const generation = {
    ...source.settings,
    provider: "openai-compatible" as const,
    baseUrl: "http://127.0.0.1:8080/v1",
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
