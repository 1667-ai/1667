import { describe, expect, test } from "bun:test";
import {
  applyBasicSettingsDraft,
  basicSettingsFromDocument
} from "../../shared/settings-basic-draft.js";
import { applySamplingSettings } from "../../shared/sampling-capabilities.js";
import { EMPTY_SAMPLING_V2, SAMPLING_KNOB_V2_VALUES } from "../../shared/settings-v2-types.js";
import type { SaveSettingsCommand, SettingsView } from "../../shared/settings-v2-types.js";
import { initialState } from "../src/app.js";
import { demoAppSource } from "../src/demo.js";
import { publishSettingsView } from "../src/overlay-publication.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { frameText, visibleWidth } from "../src/screens/story/frame.js";
import { setComposerText } from "../src/composer-model.js";
import { mouseToAction } from "../src/mouse-actions.js";
import {
  SAMPLING_LAYER_ROWS,
  type SamplingLayerRowSpec
} from "../src/sampling-model.js";
import { samplingListPanelInfo } from "../src/sampling-list-model.js";
import { createWrapCache } from "../src/wrap.js";
import {
  installSave,
  key,
  openSettings,
  selectRow,
  settingsHarness
} from "./settings-test-harness.js";

// Rows moved once #292 appended the DRY/XTC/temperature-shaping sections
// after `stop` and `logit bias`. Deriving the index from SAMPLING_LAYER_ROWS,
// instead of a hardcoded number, keeps these tests honest the next time a
// knob is inserted.
const STOP_ROW = layerRowIndex((row) => row.kind === "list" && row.panel === "stop");
const LOGIT_BIAS_ROW = layerRowIndex((row) => row.kind === "list" && row.panel === "logit-bias");
const DRY_BREAKERS_ROW = layerRowIndex((row) => row.kind === "list" && row.panel === "dry-breakers");
const MIROSTAT_ROW = layerRowIndex((row) => row.kind === "scalar" && row.knob === "mirostat");
const MIROSTAT_TAU_ROW = layerRowIndex((row) => row.kind === "scalar" && row.knob === "mirostatTau");

function layerRowIndex(predicate: (row: SamplingLayerRowSpec) => boolean): number {
  const index = SAMPLING_LAYER_ROWS.findIndex(predicate);
  if (index < 0) throw new Error("row not found in SAMPLING_LAYER_ROWS");
  return index;
}

describe("Sampling Settings user flow", () => {
  test("every sampling parameter a profile can hold has a row in the panel", () => {
    // SAMPLING_LAYER_ROWS spells its order out, because the panel order is not
    // the knob declaration order. A knob that never reaches that list is a
    // parameter the writer cannot see or set, so hold the two together.
    const rows = SAMPLING_LAYER_ROWS.map((row) =>
      row.kind === "scalar" ? row.knob : samplingListPanelInfo(row.panel).knob);
    expect([...rows].sort()).toEqual([...SAMPLING_KNOB_V2_VALUES].sort());
  });

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

  test("refreshes a clean scalar editor before Enter can apply stale text", async () => {
    const { source, state, press } = settingsHarness();
    useSupportedSettings(source);
    await enterSampling(state, press);
    await press(key("return"));

    expect(state.settings?.sampling?.edit?.kind).toBe("scalar");
    publishSamplingRefresh(source, state, 0.7);

    expect(state.settings?.draft.sampling.topP).toBe(0.7);
    expect(state.settings?.sampling).toBe(null);

    await press(key("return"));
    expect(state.settings?.draft.sampling.topP).toBe(0.7);
  });

  test("retains a dirty scalar buffer and records a refresh conflict", async () => {
    const { source, state, press } = settingsHarness();
    useSupportedSettings(source);
    await enterSampling(state, press);
    await press(key("return"));
    setSamplingEdit(state, "0.7");

    publishSamplingRefresh(source, state, 0.9);

    expect(state.settings?.sampling?.edit?.composer.text).toBe("0.7");
    expect(state.settings?.draft.sampling.topP).toBe(0.9);
    expect(state.settings?.conflict).toEqual({
      message: "settings changed during refresh · draft kept",
      armed: false
    });
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
    await moveLayer2Cursor(press, STOP_ROW);
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
    const saved: SaveSettingsCommand[] = [];
    installSave(source, saved);
    await enterSampling(state, press);
    await moveLayer2Cursor(press, LOGIT_BIAS_ROW);
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
    let frame = render(state, 80, 24);
    expect(renderedLogitRows(frame, ["42", "9"]).map((line) => line.includes("42")))
      .toEqual([true, false]);
    await press(key("up"));
    await press(key("return"));
    setSamplingEdit(state, "10:5");
    await press(key("return"));
    frame = render(state, 80, 24);
    expect(renderedLogitRows(frame, ["10", "9"]).map((line) => line.includes("10")))
      .toEqual([true, false]);
    expect(state.settings?.sampling?.cursor).toBe(0);

    await press(key("return"));
    setSamplingEdit(state, "9:99");
    await press(key("return"));
    expect(state.settings?.sampling?.edit).not.toBe(null);
    expect(state.settings?.sampling?.cursor).toBe(0);
    await press(key("escape"));
    await press(key("escape"));
    await press(key("escape"));
    await press(key("s"));
    expect(saved).toHaveLength(1);
    const profile = saved[0]!.document.profiles[saved[0]!.document.routing.default]!;
    expect(profile.sampling?.logitBias).toEqual({ "10": 5, "9": -3 });
  });

  test("selected nested rows open with a mouse click", async () => {
    const { source, state, press } = settingsHarness();
    useSupportedSettings(source);
    await enterSampling(state, press);

    render(state, 80, 24);
    const hit = selectedNestedHit(state, 0);
    expect(hit).not.toBe(null);
    if (hit === null) throw new Error("selected Sampling row has no hit target");
    expect(mouseToAction(click(hit.x, hit.y), state)).toEqual({
      action: "open-selected",
      rowId: "sampling:scalar:topP"
    });
  });

  test("renders the exact empty list states", async () => {
    const { source, state, press } = settingsHarness();
    useSupportedSettings(source);
    await enterSampling(state, press);

    await moveLayer2Cursor(press, STOP_ROW);
    await press(key("return"));
    const stopFrame = render(state, 80, 24);
    expect(stopFrame).toContain("no stop sequences yet.");
    expect(stopFrame).toContain("n writes one · the model stops when it types one");
    expect(stopFrame.split("\n").every((line) => visibleWidth(line) <= 80)).toBeTrue();

    await press(key("escape"));
    await moveLayer2Cursor(press, LOGIT_BIAS_ROW);
    await press(key("return"));
    const logitFrame = render(state, 80, 24);
    expect(logitFrame).toContain("no biased tokens yet.");
    expect(logitFrame).toContain("n writes one · token IDs come from the model's tokenizer.");
    expect(logitFrame.split("\n").every((line) => visibleWidth(line) <= 80)).toBeTrue();
  });

  test("renders selected pending rows for empty and non-empty stop and logit lists", async () => {
    const { source, state, press } = settingsHarness();
    useSupportedSettings(source);
    await enterSampling(state, press);

    await moveLayer2Cursor(press, STOP_ROW);
    await press(key("return"));
    await press(key("n"));
    let frame = render(state, 80, 24);
    expect(frame).toContain("no stop sequences yet.");
    expect(frame).toContain("▸ 01");
    expect(selectedNestedHit(state, 0)).not.toBe(null);

    setSamplingEdit(state, "END");
    await press(key("return"));
    await press(key("n"));
    frame = render(state, 80, 24);
    expect(frame.indexOf('"END"')).toBeLessThan(frame.indexOf("▸ 02"));
    expect(selectedNestedHit(state, 1)).not.toBe(null);

    await press(key("escape"));
    await press(key("escape"));
    await moveLayer2Cursor(press, LOGIT_BIAS_ROW);
    await press(key("return"));
    await press(key("n"));
    frame = render(state, 80, 24);
    expect(frame).toContain("no biased tokens yet.");
    expect(frame).toContain("▸ 01");
    expect(selectedNestedHit(state, 0)).not.toBe(null);

    setSamplingEdit(state, "42:7");
    await press(key("return"));
    await press(key("n"));
    frame = render(state, 80, 24);
    expect(frame.indexOf("42")).toBeLessThan(frame.indexOf("▸ 02"));
    expect(selectedNestedHit(state, 1)).not.toBe(null);
  });

  test("escape peels list, sampling, and Settings layers in order", async () => {
    const { source, state, press } = settingsHarness();
    useSupportedSettings(source);
    await enterSampling(state, press);
    await moveLayer2Cursor(press, STOP_ROW);
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

  test("renders the dry, xtc, and temperature-shaping sections under their rule lines", async () => {
    const { source, state, press } = settingsHarness();
    useSupportedSettings(source);
    await enterSampling(state, press);
    const lines = render(state, 100, 48).split("\n");

    const dryRule = lines.findIndex((line) => line.includes("dry · don't repeat yourself"));
    const xtcRule = lines.findIndex((line) => line.includes("xtc · exclude top choices"));
    const tempRule = lines.findIndex((line) => line.includes("temperature shaping"));
    expect(dryRule).toBeGreaterThan(-1);
    expect(xtcRule).toBeGreaterThan(dryRule);
    expect(tempRule).toBeGreaterThan(xtcRule);

    expect(lines.findIndex((line) => line.includes("dry multiplier"))).toBeGreaterThan(dryRule);
    expect(lines.findIndex((line) => line.includes("dry breakers"))).toBeGreaterThan(dryRule);
    expect(lines.findIndex((line) => line.includes("xtc threshold"))).toBeGreaterThan(xtcRule);
    expect(lines.findIndex((line) => line.includes("dyn temp range"))).toBeGreaterThan(tempRule);
  });

  test("shows a 0 disables hint only on dry multiplier, dry range, xtc chance, and dyn temp range", async () => {
    const { source, state, press } = settingsHarness();
    useSupportedSettings(source);
    await enterSampling(state, press);
    const lines = render(state, 120, 48).split("\n");

    for (const label of ["dry multiplier", "dry range", "xtc chance", "dyn temp range"]) {
      const line = lines.find((candidate) => candidate.includes(label));
      expect(line).toContain("0 disables");
    }
    for (const label of ["dry base", "xtc threshold"]) {
      const line = lines.find((candidate) => candidate.includes(label));
      expect(line).not.toContain("0 disables");
    }
  });

  test("mirostat walks off to v1 to v2 and back to off through the existing stepper", async () => {
    const { source, state, press } = settingsHarness();
    useSupportedSettings(source);
    await enterSampling(state, press);
    await moveLayer2Cursor(press, MIROSTAT_ROW);

    expect(state.settings?.draft.sampling.mirostat).toBe(null);
    expect(mirostatRowLine(render(state, 100, 40))).toContain("‹ off ›");

    await press(key("right"));
    expect(state.settings?.draft.sampling.mirostat).toBe(1);
    expect(mirostatRowLine(render(state, 100, 40))).toContain("‹ v1 ›");

    await press(key("right"));
    expect(state.settings?.draft.sampling.mirostat).toBe(2);
    expect(mirostatRowLine(render(state, 100, 40))).toContain("‹ v2 ›");

    await press(key("right"));
    expect(state.settings?.draft.sampling.mirostat).toBe(2);

    await press(key("left"));
    expect(state.settings?.draft.sampling.mirostat).toBe(1);
    await press(key("left"));
    expect(state.settings?.draft.sampling.mirostat).toBe(null);
    expect(mirostatRowLine(render(state, 100, 40))).toContain("‹ off ›");
  });

  test("mirostat tau and eta stay unavailable while mirostat is off, and open once it is v1", async () => {
    const { source, state, press } = settingsHarness();
    useSupportedSettings(source);
    await enterSampling(state, press);
    await moveLayer2Cursor(press, MIROSTAT_TAU_ROW);

    const offFrame = render(state, 100, 40);
    expect(offFrame).toContain("Mirostat is off.");
    await press(key("return"));
    expect(state.settings?.sampling?.edit).toBe(null);
    expect(state.settings?.sampling?.result).toContain("mirostat off");

    await press(key("up"));
    await press(key("right"));
    expect(state.settings?.draft.sampling.mirostat).toBe(1);

    await press(key("down"));
    await press(key("return"));
    expect(state.settings?.sampling?.edit?.kind).toBe("scalar");
    setSamplingEdit(state, "6");
    await press(key("return"));
    expect(state.settings?.draft.sampling.mirostatTau).toBe(6);

    await press(key("down"));
    await press(key("return"));
    expect(state.settings?.sampling?.edit?.kind).toBe("scalar");
  });

  test("a save survives mirostat toggled back off after tau was set", async () => {
    const { source, state, press } = settingsHarness();
    useSupportedSettings(source);
    const saved: SaveSettingsCommand[] = [];
    installSave(source, saved);
    await enterSampling(state, press);
    await moveLayer2Cursor(press, MIROSTAT_ROW);

    await press(key("right"));
    expect(state.settings?.draft.sampling.mirostat).toBe(1);

    await press(key("down"));
    await press(key("return"));
    setSamplingEdit(state, "6");
    await press(key("return"));
    expect(state.settings?.draft.sampling.mirostatTau).toBe(6);

    await press(key("up"));
    await press(key("left"));
    expect(state.settings?.draft.sampling.mirostat).toBe(null);
    expect(state.settings?.draft.sampling.mirostatTau).toBe(6);

    await press(key("escape"));
    await press(key("s"));

    expect(saved).toHaveLength(1);
    const profile = saved[0]!.document.profiles[saved[0]!.document.routing.default]!;
    expect(profile.sampling?.mirostat).toBe(null);
    expect(profile.sampling?.mirostatTau).toBe(6);
  });

  test("an LM Studio route hides the extended samplers behind the preset reason", async () => {
    const { source, state, press } = settingsHarness();
    useSupportedSettings(source, "http://127.0.0.1:1234/v1");
    await enterSampling(state, press);
    const lines = render(state, 100, 48).split("\n");

    const dryLine = lines.find((line) => line.includes("dry multiplier"));
    expect(dryLine).toContain("‹ — ›");
    expect(dryLine).toContain("This endpoint does not document");
    // A baseline OpenAI field stays available on the same route.
    const topPLine = lines.find((line) => line.includes("top p"));
    expect(topPLine).toContain("‹ default ›");
  });

  test("adds, edits, reorders, and deletes dry breakers", async () => {
    const { source, state, press } = settingsHarness();
    useSupportedSettings(source);
    await enterSampling(state, press);
    await moveLayer2Cursor(press, DRY_BREAKERS_ROW);
    await press(key("return"));
    expect(state.settings?.sampling?.panel).toBe("dry-breakers");

    await press(key("n"));
    setSamplingEdit(state, "\n");
    await press(key("return"));
    await press(key("n"));
    setSamplingEdit(state, "*");
    await press(key("return"));
    expect(state.settings?.draft.sampling.dryBreakers).toEqual(["\n", "*"]);

    await press(key("left"));
    expect(state.settings?.draft.sampling.dryBreakers).toEqual(["*", "\n"]);

    await press(key("return"));
    setSamplingEdit(state, ":");
    await press(key("return"));
    expect(state.settings?.draft.sampling.dryBreakers).toEqual([":", "\n"]);

    await press(key("d"));
    expect(state.settings?.draft.sampling.dryBreakers).toEqual(["\n"]);
  });

  test("rejects a dry breaker over 40 UTF-8 bytes even under the 40-scalar cap", async () => {
    // llama.cpp's DRY sampler truncates a breaker at 40 bytes, not 40
    // scalars, so a breaker of well under 40 scalars can still overrun that
    // byte cap once its characters take more than one byte each. "€" is one
    // scalar and three UTF-8 bytes, so 14 of them is 14 scalars (inside the
    // scalar cap) but 42 bytes (outside the byte cap).
    const { source, state, press } = settingsHarness();
    useSupportedSettings(source);
    await enterSampling(state, press);
    await moveLayer2Cursor(press, DRY_BREAKERS_ROW);
    await press(key("return"));
    expect(state.settings?.sampling?.panel).toBe("dry-breakers");

    await press(key("n"));
    setSamplingEdit(state, "€".repeat(14));
    await press(key("return"));
    expect(state.settings?.sampling?.result).toContain("1..40 UTF-8 bytes");
    expect(state.settings?.sampling?.edit).not.toBe(null);
    expect(state.settings?.draft.sampling.dryBreakers).toEqual([]);

    setSamplingEdit(state, "€".repeat(13));
    await press(key("return"));
    expect(state.settings?.draft.sampling.dryBreakers).toEqual(["€".repeat(13)]);
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
  } satisfies SettingsView;
  source.api.getSettings = async () => source.settingsView;
}

function publishSamplingRefresh(
  source: ReturnType<typeof demoAppSource>,
  state: ReturnType<typeof initialState>,
  topP: number
): void {
  const current = source.settingsView;
  if (!current.editable) throw new Error("demo settings must be editable");
  const profileId = current.document.routing.default;
  const profile = current.document.profiles[profileId];
  if (profile === undefined) throw new Error("default profile is missing");
  const document = applySamplingSettings(current.document, {
    ...(profile.sampling ?? EMPTY_SAMPLING_V2),
    topP
  });
  const effective = basicSettingsFromDocument(document);
  publishSettingsView(state, source, {
    ...current,
    stateGeneration: current.stateGeneration + 1,
    activeRevision: current.activeRevision + 1,
    document,
    effective
  });
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

function renderedLogitRows(frame: string, tokens: readonly string[]): string[] {
  return frame.split("\n").filter((line) => tokens.some((token) => line.includes(token)));
}

// The bare `mirostat` row and the `mirostat tau` / `mirostat eta` rows all
// contain the substring "mirostat ", so this rules out the two dependent rows
// explicitly rather than guessing at column widths.
function mirostatRowLine(frame: string): string {
  const line = frame.split("\n")
    .find((candidate) => /mirostat(?! tau| eta)\s*‹/.test(candidate));
  if (line === undefined) throw new Error("mirostat row not found in frame");
  return line;
}
