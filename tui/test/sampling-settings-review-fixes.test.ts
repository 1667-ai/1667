import { describe, expect, test } from "bun:test";
import {
  applyBasicSettingsDraft,
  basicSettingsFromDocument
} from "../../shared/settings-basic-draft.js";
import { applySamplingSettings } from "../../shared/sampling-capabilities.js";
import { EMPTY_SAMPLING_V2 } from "../../shared/settings-v2-types.js";
import type { SaveSettingsCommand } from "../../shared/settings-v2-types.js";
import { initialState } from "../src/app.js";
import { demoAppSource } from "../src/demo.js";
import { publishSettingsView } from "../src/overlay-publication.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { frameText } from "../src/screens/story/frame.js";
import { setComposerText } from "../src/composer-model.js";
import {
  SAMPLING_LAYER_ROWS,
  samplingContextForOverlay,
  samplingScalarRows
} from "../src/sampling-model.js";
import { resolveSettingsProfile } from "../../shared/settings-route.js";
import { SETTINGS_ROW_IDS } from "../src/settings-overlay-model.js";
import { createWrapCache } from "../src/wrap.js";
import {
  installSave,
  key,
  openSettings,
  selectRow,
  settingsHarness
} from "./settings-test-harness.js";

// Rows moved once #292 appended the DRY/XTC/temperature-shaping sections
// after `stop` and `logit bias` — derive the index instead of hardcoding it.
const STOP_ROW = SAMPLING_LAYER_ROWS.findIndex((row) => row.kind === "list" && row.panel === "stop");
const LOGIT_BIAS_ROW = SAMPLING_LAYER_ROWS.findIndex((row) => row.kind === "list" && row.panel === "logit-bias");

describe("Sampling Settings review regressions", () => {
  test("authoritative publish closes a clean Sampling panel before the next key", async () => {
    const { source, state, press } = settingsHarness();
    useSupportedSettings(source);
    await enterSampling(state, press);

    const current = source.settingsView;
    if (!current.editable) throw new Error("demo settings must be editable");
    const profile = current.document.profiles[current.document.routing.default];
    if (profile === undefined) throw new Error("default profile is missing");
    const document = applySamplingSettings(current.document, {
      ...(profile.sampling ?? EMPTY_SAMPLING_V2),
      topP: 0.8
    });
    publishSettingsView(state, source, {
      ...current,
      stateGeneration: current.stateGeneration + 1,
      activeRevision: current.activeRevision + 1,
      document,
      effective: basicSettingsFromDocument(document)
    });

    expect(state.settings?.sampling).toBe(null);
    expect(state.settings?.draft.sampling.topP).toBe(0.8);
    await press(key("return"));
    expect(state.settings?.sampling?.panel).toBe("sampling");
  });

  test("short Settings cursor window keeps utility route visible and nameable", async () => {
    const { state, press } = settingsHarness();
    await openSettings(press);
    const utilityIndex = SETTINGS_ROW_IDS.indexOf("utility-route");
    state.settings!.cursor = utilityIndex;
    const height = 32;

    const rendered = renderStoryScreen(state, {
      width: 120,
      height,
      wrapCache: createWrapCache()
    });
    Object.assign(state, rendered.derived);

    expect(frameText(rendered.lines)).toContain("utility");
    expect(rendered.lines).toHaveLength(height);
    expect(state.hitRows).toHaveLength(height);
    const selectable = rendered.selectable;
    if (selectable === null) throw new Error("Settings panel is not selectable");

    const listHits = state.hitRows.flatMap((row, y) => row === null
      ? []
      : [row, ...(row.overrides ?? [])].flatMap((region) =>
          region.target.kind === "list" ? [{ y, index: region.target.index }] : []
        ));
    // The C-03 form groups the rows under section rules, so a short panel
    // windows them. What has to hold is that the cursor's own row is painted
    // and clickable, that the window is contiguous and in order, and that no
    // row answers a click outside the panel.
    const shown = [...new Set(listHits.map((hit) => hit.index))];
    expect(shown.length).toBeGreaterThan(0);
    expect(shown).toEqual(shown.map((_, offset) => shown[0]! + offset));
    expect(shown).toContain(utilityIndex);
    expect(listHits.every((hit) => hit.y >= selectable.top && hit.y < selectable.bottom)).toBeTrue();
    expect(state.hitRows.slice(selectable.bottom).every((row) =>
      ![row, ...(row?.overrides ?? [])].some((region) => region?.target.kind === "list")
    )).toBeTrue();
  });

  test("cancelling a pending stop or logit row keeps the persisted row selected for the next action", async () => {
    const { source, state, press } = settingsHarness();
    useSupportedSettings(source);
    await enterSampling(state, press);

    await moveLayer2Cursor(press, STOP_ROW);
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
    await moveLayer2Cursor(press, LOGIT_BIAS_ROW);
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

    await moveLayer2Cursor(press, STOP_ROW);
    await press(key("return"));
    const stopFrame = render(state, 120, 24);
    expect(stopFrame).toContain("reorder");

    await press(key("escape"));
    await moveLayer2Cursor(press, LOGIT_BIAS_ROW);
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

  test("keeps one projected Sampling route while an endpoint edit is incomplete", async () => {
    const { source, state, press } = settingsHarness();
    useSupportedSettings(source);

    await openSettings(press);
    await selectRow(press, state, "base-url");
    await press(key("return"));
    const edit = state.settings?.edit;
    if (edit?.kind !== "inline") throw new Error("base URL edit did not open");
    setComposerText(edit.composer, "");
    await press(key("return"));

    const overlay = state.settings;
    if (overlay === null || overlay.draft.document === null
      || overlay.draft.selectedProfileId === null) {
      throw new Error("editable Settings draft did not remain available");
    }
    const route = resolveSettingsProfile(
      overlay.draft.document,
      overlay.draft.selectedProfileId
    );
    const context = samplingContextForOverlay(overlay);
    expect(context).toEqual({
      protocol: route.connection.protocol,
      preset: route.connection.preset,
      remoteModelId: route.model.remoteId,
      temperatureSupport: route.model.capabilities.temperature
    });
    expect(samplingScalarRows(overlay)[0]).toMatchObject({
      label: "top p",
      available: true
    });
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
