import { describe, expect, test } from "bun:test";
import {
  applyBasicSettingsDraft,
  basicSettingsFromDocument
} from "../../shared/settings-basic-draft.js";
import type { SaveSettingsCommand, SettingsView } from "../../shared/settings-v2-types.js";
import { initialState } from "../src/app.js";
import { demoAppSource } from "../src/demo.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { frameText, visibleWidth } from "../src/screens/story/frame.js";
import { setComposerText } from "../src/composer-model.js";
import { mouseToAction } from "../src/mouse-actions.js";
import { samplingLogitBiasEntries } from "../src/sampling-model.js";
import { createWrapCache } from "../src/wrap.js";
import {
  key,
  openSettings,
  selectRow,
  settingsHarness
} from "./settings-test-harness.js";

describe("Sampling Settings user flow", () => {
  test("starts collapsed, opens through the Settings row, and shows a shared disabled reason", async () => {
    const { state, press } = settingsHarness();
    await openSettings(press);

    expect(state.settings?.sampling).toBe(null);
    const collapsed = render(state, 120, 36);
    expect(collapsed).toContain("sampling");
    expect(collapsed).not.toContain("┏━ sampling");

    await enterSampling(state, press);
    const opened = render(state, 80, 24);
    expect(opened).toContain("┏━ sampling");
    expect(opened).toContain("‹ — ›");
    expect(opened).toContain("Dry run does not send provider requests.");
    expect(opened.split("\n").every((line) => visibleWidth(line) <= 80)).toBeTrue();

    await press(key("return"));
    expect(state.settings?.sampling?.edit).toBe(null);
    expect(state.settings?.sampling?.result).toContain("disabled · dry run");
  });

  test("edits a scalar and saves the sampling payload through Settings actions", async () => {
    const { source, state, press } = settingsHarness();
    useSupportedSettings(source);
    const saved: SaveSettingsCommand[] = [];
    installSave(source, saved);

    await enterSampling(state, press);
    await press(key("return"));
    setSamplingEdit(state, "0.7");
    await press(key("return"));
    expect(state.settings?.draft.sampling.topP).toBe(0.7);

    for (const [width, height] of [[120, 36], [80, 24]] as const) {
      const frame = render(state, width, height);
      expect(frame).toContain("top p");
      expect(frame.split("\n").every((line) => visibleWidth(line) <= width)).toBeTrue();
    }

    await press(key("s"));
    expect(saved).toHaveLength(0);
    expect(state.settings?.sampling).not.toBe(null);
    await press(key("escape"));
    await press(key("s"));
    expect(saved).toHaveLength(1);
    const profile = saved[0]!.document.profiles[saved[0]!.document.routing.default]!;
    expect(profile.sampling?.topP).toBe(0.7);

    await closeSamplingSettings(state, press);
    await openSettings(press);
    await selectRow(press, state, "sampling");
    await press(key("return"));
    expect(state.settings?.draft.sampling.topP).toBe(0.7);
  });

  test("scalar arrows use exact steps, neutral entry, unset crossing, and max limits", async () => {
    const { source, state, press } = settingsHarness();
    useSupportedSettings(source);
    await enterSampling(state, press);

    await press(key("left"));
    expect(state.settings?.draft.sampling.topP).toBe(null);
    await press(key("right"));
    expect(state.settings?.draft.sampling.topP).toBe(1);
    await press(key("right"));
    expect(state.settings?.draft.sampling.topP).toBe(1);
    expect(state.settings?.sampling?.result).toBe("top p at max");
    await press(key("left"));
    expect(state.settings?.draft.sampling.topP).toBe(0.95);

    await press(key("down"));
    await press(key("left"));
    expect(state.settings?.draft.sampling.topK).toBe(null);
    await press(key("right"));
    expect(state.settings?.draft.sampling.topK).toBe(0);
    await press(key("right"));
    expect(state.settings?.draft.sampling.topK).toBe(1);

    await press(key("down"));
    await press(key("right"));
    expect(state.settings?.draft.sampling.minP).toBe(0);
    await press(key("right"));
    expect(state.settings?.draft.sampling.minP).toBe(0.01);

    await press(key("down"));
    await press(key("right"));
    expect(state.settings?.draft.sampling.frequencyPenalty).toBe(0);
    await press(key("right"));
    expect(state.settings?.draft.sampling.frequencyPenalty).toBe(0.1);

    await press(key("down"));
    await press(key("right"));
    expect(state.settings?.draft.sampling.presencePenalty).toBe(0);
    await press(key("right"));
    expect(state.settings?.draft.sampling.presencePenalty).toBe(0.1);

    await press(key("down"));
    await press(key("right"));
    expect(state.settings?.draft.sampling.repeatPenalty).toBe(1);
    await press(key("right"));
    expect(state.settings?.draft.sampling.repeatPenalty).toBe(1.05);
    await press(key("left"));
    await press(key("left"));
    expect(state.settings?.draft.sampling.repeatPenalty).toBe(null);
  });

  test("adds, edits, reorders, and deletes stop sequences", async () => {
    const { source, state, press } = settingsHarness();
    useSupportedSettings(source);
    await enterSampling(state, press);
    await moveLayer2Cursor(press, 6);
    await press(key("return"));

    await press(key("n"));
    setSamplingEdit(state, "END");
    await press(key("return"));
    await press(key("n"));
    setSamplingEdit(state, "DONE");
    await press(key("return"));
    expect(state.settings?.draft.sampling.stop).toEqual(["END", "DONE"]);

    await press(key("left"));
    expect(state.settings?.draft.sampling.stop).toEqual(["DONE", "END"]);
    await press(key("return"));
    setSamplingEdit(state, "START");
    await press(key("return"));
    await press(key("d"));
    expect(state.settings?.draft.sampling.stop).toEqual(["END"]);
  });

  test("edits a token-ID row in place and rejects duplicate IDs without mutation", async () => {
    const { source, state, press } = settingsHarness();
    useSupportedSettings(source);
    await enterSampling(state, press);
    await moveLayer2Cursor(press, 7);
    await press(key("return"));

    await press(key("n"));
    setSamplingEdit(state, "1:");
    await press(key("return"));
    expect(state.settings?.sampling?.edit).not.toBe(null);
    expect(state.settings?.draft.sampling.logitBias).toEqual({});
    await press(key("escape"));
    await press(key("n"));
    setSamplingEdit(state, "42:7");
    await press(key("return"));
    await press(key("n"));
    setSamplingEdit(state, "9:-3");
    await press(key("return"));
    expect(samplingLogitBiasEntries(state.settings!)).toEqual([
      ["42", 7],
      ["9", -3]
    ]);
    await press(key("up"));
    await press(key("return"));
    setSamplingEdit(state, "10:5");
    await press(key("return"));
    expect(samplingLogitBiasEntries(state.settings!)).toEqual([
      ["10", 5],
      ["9", -3]
    ]);
    expect(state.settings?.sampling?.cursor).toBe(0);

    await press(key("return"));
    setSamplingEdit(state, "9:99");
    await press(key("return"));
    expect(state.settings?.sampling?.edit).not.toBe(null);
    expect(samplingLogitBiasEntries(state.settings!)).toEqual([
      ["10", 5],
      ["9", -3]
    ]);
    expect(state.settings?.sampling?.cursor).toBe(0);
    await press(key("escape"));
  });

  test("selected nested rows open with a mouse click", async () => {
    const { source, state, press } = settingsHarness();
    useSupportedSettings(source);
    await enterSampling(state, press);

    render(state, 80, 24);
    const hit = selectedNestedHit(state, 0);
    expect(hit).not.toBe(null);
    if (hit === null) throw new Error("selected Sampling row has no hit target");
    expect(mouseToAction(click(hit.x, hit.y), state)).toEqual({ action: "open-selected" });
  });

  test("renders the exact empty list states", async () => {
    const { source, state, press } = settingsHarness();
    useSupportedSettings(source);
    await enterSampling(state, press);

    await moveLayer2Cursor(press, 6);
    await press(key("return"));
    const stopFrame = render(state, 80, 24);
    expect(stopFrame).toContain("no stop sequences yet.");
    expect(stopFrame).toContain("n writes one · the model stops when it types one");
    expect(stopFrame.split("\n").every((line) => visibleWidth(line) <= 80)).toBeTrue();

    await press(key("escape"));
    await moveLayer2Cursor(press, 7);
    await press(key("return"));
    const logitFrame = render(state, 80, 24);
    expect(logitFrame).toContain("no biased tokens yet.");
    expect(logitFrame).toContain("n writes one · token IDs come from the model's tokenizer.");
    expect(logitFrame.split("\n").every((line) => visibleWidth(line) <= 80)).toBeTrue();
  });

  test("escape peels list, sampling, and Settings layers in order", async () => {
    const { source, state, press } = settingsHarness();
    useSupportedSettings(source);
    await enterSampling(state, press);
    await moveLayer2Cursor(press, 6);
    await press(key("return"));
    expect(state.settings?.sampling?.panel).toBe("stop");
    await press(key("escape"));
    expect(state.settings?.sampling?.panel).toBe("sampling");
    await press(key("escape"));
    expect(state.settings?.sampling).toBe(null);
    await press(key("escape"));
    expect(state.settings).toBe(null);
    expect(state.mode).toBe("NAV");
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

async function closeSamplingSettings(
  state: ReturnType<typeof settingsHarness>["state"],
  press: ReturnType<typeof settingsHarness>["press"]
): Promise<void> {
  if (state.settings?.sampling !== null) await press(key("escape"));
  if (state.settings !== null) await press(key("escape"));
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
  } satisfies SettingsView;
  source.api.getSettings = async () => source.settingsView;
}

function installSave(
  source: ReturnType<typeof demoAppSource>,
  saved: SaveSettingsCommand[]
): void {
  source.api.saveSettings = async (command) => {
    saved.push(command);
    const current = source.settingsView;
    if (!current.editable) throw new Error("demo settings must be editable");
    const effective = basicSettingsFromDocument(command.document);
    source.settingsView = {
      ...current,
      stateGeneration: current.stateGeneration + 1,
      activeRevision: current.activeRevision + 1,
      document: command.document,
      effective
    };
    return {
      kind: "settings" as const,
      settingsStateGeneration: source.settingsView.stateGeneration,
      activeSettingsRevision: source.settingsView.activeRevision,
      pendingSettingsRevision: null,
      activationOutcome: null
    };
  };
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

function click(x: number, y: number) {
  return {
    type: "down",
    button: 0,
    x,
    y,
    modifiers: { shift: false, alt: false, ctrl: false }
  } as never;
}

function selectedNestedHit(
  state: ReturnType<typeof initialState>,
  index: number
): { x: number; y: number } | null {
  for (const [y, row] of state.hitRows.entries()) {
    if (row === null) continue;
    const region = [row, ...row.overrides ?? []].find((candidate) =>
      candidate.target.kind === "list"
        && candidate.target.index === index
        && candidate.target.selected === true);
    if (region !== undefined) return { x: region.left, y };
  }
  return null;
}
