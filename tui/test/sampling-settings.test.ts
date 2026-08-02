import { describe, expect, test } from "bun:test";
import {
  applyBasicSettingsDraft,
  basicSettingsFromDocument
} from "../../shared/settings-basic-draft.js";
import { applySamplingSettings } from "../../shared/sampling-capabilities.js";
import type { SamplingBiasResolutionResult } from "../../shared/sampling-capabilities.js";
import { EMPTY_SAMPLING_V2 } from "../../shared/settings-v2-types.js";
import type { SaveSettingsCommand, SettingsView } from "../../shared/settings-v2-types.js";
import { initialState } from "../src/app.js";
import { demoAppSource } from "../src/demo.js";
import { publishSettingsView } from "../src/overlay-publication.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { frameText, visibleWidth } from "../src/screens/story/frame.js";
import { setComposerText } from "../src/composer-model.js";
import { mouseToAction } from "../src/mouse-actions.js";
import { samplingLayerRowIndex } from "../src/sampling-model.js";
import { createWrapCache } from "../src/wrap.js";
import {
  deferred,
  installSave,
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

    await press(key("down"));
    await press(key("right"));
    expect(state.settings?.draft.sampling.seed).toBe(1);
    await press(key("right"));
    expect(state.settings?.draft.sampling.seed).toBe(2);
    await press(key("left"));
    await press(key("left"));
    expect(state.settings?.draft.sampling.seed).toBe(null);
  });

  test("seed accepts direct integer entry and rejects non-integer text", async () => {
    const { source, state, press } = settingsHarness();
    useSupportedSettings(source);
    await enterSampling(state, press);
    await moveLayer2Cursor(press, samplingLayerRowIndex("seed"));
    await press(key("return"));

    setSamplingEdit(state, "1.5");
    await press(key("return"));
    expect(state.settings?.sampling?.edit).not.toBe(null);
    expect(state.settings?.draft.sampling.seed).toBe(null);

    setSamplingEdit(state, "42");
    await press(key("return"));
    expect(state.settings?.sampling?.edit).toBe(null);
    expect(state.settings?.draft.sampling.seed).toBe(42);
  });

  test("seed is disabled for Anthropic with the same protocol reason as other OpenAI-only scalars", async () => {
    const { source, state, press } = settingsHarness();
    useAnthropicSettings(source);
    await enterSampling(state, press);
    await moveLayer2Cursor(press, samplingLayerRowIndex("seed"));

    const frame = render(state, 80, 24);
    const seedLine = frame.split("\n").find((line) => line.includes("seed"));
    expect(seedLine).toContain("‹ — ›");

    await press(key("return"));
    expect(state.settings?.sampling?.result).toBe("seed disabled · not in protocol");
    expect(state.settings?.draft.sampling.seed).toBe(null);
  });

  test("adds, edits, reorders, and deletes stop sequences", async () => {
    const { source, state, press } = settingsHarness();
    useSupportedSettings(source);
    await enterSampling(state, press);
    await moveLayer2Cursor(press, samplingLayerRowIndex("stop"));
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
    await moveLayer2Cursor(press, samplingLayerRowIndex("logit-bias"));
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

    await moveLayer2Cursor(press, samplingLayerRowIndex("stop"));
    await press(key("return"));
    const stopFrame = render(state, 80, 24);
    expect(stopFrame).toContain("no stop sequences yet.");
    expect(stopFrame).toContain("n writes one · the model stops when it types one");
    expect(stopFrame.split("\n").every((line) => visibleWidth(line) <= 80)).toBeTrue();

    await press(key("escape"));
    await moveLayer2Cursor(press, samplingLayerRowIndex("logit-bias"));
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

    await moveLayer2Cursor(press, samplingLayerRowIndex("stop"));
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
    await moveLayer2Cursor(press, samplingLayerRowIndex("logit-bias"));
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

  test("phrase bias is unavailable for a self-hosted preset with no trusted tokenizer", async () => {
    const { source, state, press } = settingsHarness();
    // KoboldCpp has no native tokenize side channel 1667 uses yet (deferred
    // to a follow-up stage) and its reported model name is not trustworthy
    // for tokenizer selection either — phraseBias and bannedStrings stay
    // subtracted for this preset regardless of model (see
    // PRESET_SUBTRACTIONS in shared/sampling-capabilities.ts).
    useKoboldcppSettings(source);
    await enterSampling(state, press);
    await moveLayer2Cursor(press, samplingLayerRowIndex("phrase-bias"));
    await press(key("return"));
    expect(state.settings?.sampling?.panel).toBe("sampling");
    expect(state.settings?.sampling?.result).toContain("not in preset");
  });

  // Issue #282 stage 1, point 5: llama.cpp is no longer subtracted — it
  // resolves phraseBias/bannedStrings through its own live tokenize probe
  // (server/context-probe.ts) instead of trusting a reported model name.
  test("phrase bias opens for the llama.cpp preset instead of reporting it unavailable", async () => {
    const { source, state, press } = settingsHarness();
    useSupportedSettings(source);
    await enterSampling(state, press);
    await moveLayer2Cursor(press, samplingLayerRowIndex("phrase-bias"));
    await press(key("return"));
    expect(state.settings?.sampling?.panel).toBe("phrase-bias");
  });

  test("phrase bias is unavailable for a model with no exact tokenizer", async () => {
    const { source, state, press } = settingsHarness();
    // A real OpenAI host, so the preset itself is trustworthy, but the model
    // name is not on the closed tokenizer allow-list.
    const active = source.settingsView;
    if (!active.editable) throw new Error("demo settings must be editable");
    const document = applyBasicSettingsDraft(active.document, {
      ...source.settings,
      provider: "openai-compatible" as const,
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-5.2",
      apiKeyEnv: null
    });
    source.settingsView = { ...active, document, effective: basicSettingsFromDocument(document) } satisfies SettingsView;
    source.api.getSettings = async () => source.settingsView;

    await enterSampling(state, press);
    await moveLayer2Cursor(press, samplingLayerRowIndex("phrase-bias"));
    await press(key("return"));
    expect(state.settings?.sampling?.panel).toBe("sampling");
    expect(state.settings?.sampling?.result).toContain("no exact tokenizer");
  });

  test("phrase bias resolves token IDs through the resolveSamplingBias worker call", async () => {
    const { source, state, press } = settingsHarness();
    useEncodedModelSettings(source);
    const pending = deferred<SamplingBiasResolutionResult>();
    const calls: Array<{
      settings: unknown;
      logitBias: Readonly<Record<string, number>>;
      phraseBias: readonly { phrase: string; weight: number }[];
      bannedStrings: readonly string[];
    }> = [];
    source.api.resolveSamplingBias = async (request) => {
      calls.push(request);
      return await pending.promise;
    };

    await enterSampling(state, press);
    await moveLayer2Cursor(press, samplingLayerRowIndex("phrase-bias"));
    await press(key("return"));
    expect(state.settings?.sampling?.panel).toBe("phrase-bias");

    await press(key("n"));
    setSamplingEdit(state, "dragon:5");
    await press(key("return"));
    expect(state.settings?.draft.sampling.phraseBias).toEqual([{ phrase: "dragon", weight: 5 }]);
    // One worker call for the whole draft, carrying the routed connection
    // as a provider-probe target — this is the boundary crossing design
    // decision #6 calls out as the main integration risk: the WASM
    // tokenizer lives in server/, so the editor reaches it through this
    // call rather than importing it directly. Issue #282 review finding E:
    // one call per commit, not one per phrase.
    const lastCall = calls.at(-1)!;
    expect(lastCall.settings).toBeDefined();
    expect({ ...lastCall, settings: undefined }).toEqual({
      settings: undefined,
      logitBias: {},
      phraseBias: [{ phrase: "dragon", weight: 5 }],
      bannedStrings: []
    });

    // Exact IDs confirmed against the compiled tiktoken o200k_base encoder
    // for "dragon" typed, " dragon", "Dragon", and " Dragon" — "dragon" is
    // single-token in every surface variant, so it resolves.
    pending.resolve({
      kind: "resolved",
      logitBias: { "84021": 5, "45342": 5, "91530": 5, "34057": 5 },
      phraseBias: [{
        kind: "resolved",
        phrase: "dragon",
        tokenIds: [84021, 45342, 91530, 34057],
        variants: [
          { variant: "typed", text: "dragon", outcome: { kind: "single-token", tokenId: 84021 } },
          { variant: "leading-space", text: " dragon", outcome: { kind: "single-token", tokenId: 45342 } },
          { variant: "capitalized", text: "Dragon", outcome: { kind: "single-token", tokenId: 91530 } },
          { variant: "leading-space-capitalized", text: " Dragon", outcome: { kind: "single-token", tokenId: 34057 } }
        ]
      }],
      bannedStrings: [],
      resolvedEntryCount: 4
    });
    await pending.promise;
    await Promise.resolve();
    const frame = render(state, 80, 24);
    expect(frame).toContain("84021");
  });

  test("adds banned strings, rejects a duplicate, and saves the sampling payload", async () => {
    const { source, state, press } = settingsHarness();
    useEncodedModelSettings(source);
    source.api.resolveSamplingBias = async () => ({ kind: "tokenizer-unavailable" });
    const saved: SaveSettingsCommand[] = [];
    installSave(source, saved);
    await enterSampling(state, press);
    await moveLayer2Cursor(press, samplingLayerRowIndex("banned-strings"));
    await press(key("return"));
    expect(state.settings?.sampling?.panel).toBe("banned-strings");

    await press(key("n"));
    setSamplingEdit(state, "forbidden word");
    await press(key("return"));
    await press(key("n"));
    setSamplingEdit(state, "forbidden word");
    await press(key("return"));
    expect(state.settings?.sampling?.edit).not.toBe(null);
    expect(state.settings?.sampling?.result).toContain("repeats");
    await press(key("escape"));
    expect(state.settings?.draft.sampling.bannedStrings).toEqual(["forbidden word"]);

    await press(key("escape"));
    await press(key("escape"));
    expect(state.settings?.sampling).toBe(null);
    await press(key("s"));
    expect(saved).toHaveLength(1);
    const profile = saved[0]!.document.profiles[saved[0]!.document.routing.default]!;
    expect(profile.sampling?.bannedStrings).toEqual(["forbidden word"]);
  });

  test("escape peels list, sampling, and Settings layers in order", async () => {
    const { source, state, press } = settingsHarness();
    useSupportedSettings(source);
    await enterSampling(state, press);
    await moveLayer2Cursor(press, samplingLayerRowIndex("stop"));
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

function useProviderSettings(
  source: ReturnType<typeof demoAppSource>,
  provider: { provider: "openai-compatible" | "anthropic"; baseUrl: string; model: string }
): void {
  const active = source.settingsView;
  if (!active.editable) throw new Error("demo settings must be editable");
  const generation = { ...source.settings, ...provider, apiKeyEnv: null };
  const document = applyBasicSettingsDraft(active.document, generation);
  source.settingsView = {
    ...active,
    document,
    effective: basicSettingsFromDocument(document)
  } satisfies SettingsView;
  source.api.getSettings = async () => source.settingsView;
}

// KoboldCpp has no native tokenize side channel 1667 uses yet (deferred to a
// follow-up stage) and its reported model name is not trustworthy for
// tokenizer selection either — phraseBias and bannedStrings stay subtracted
// for this preset regardless of model (see PRESET_SUBTRACTIONS in
// shared/sampling-capabilities.ts).
function useKoboldcppSettings(source: ReturnType<typeof demoAppSource>): void {
  useProviderSettings(source, {
    provider: "openai-compatible", baseUrl: "http://127.0.0.1:5001/v1", model: "gpt-5.2"
  });
}

// llama.cpp resolves phraseBias/bannedStrings through its own live tokenize
// probe (server/context-probe.ts) instead of trusting a reported model name,
// so it is not subtracted — this preset name stays "supported" for that
// reason, not because the reported name "gpt-5.2" is trustworthy.
function useSupportedSettings(source: ReturnType<typeof demoAppSource>): void {
  useProviderSettings(source, {
    provider: "openai-compatible", baseUrl: "http://127.0.0.1:8080/v1", model: "gpt-5.2"
  });
}

function useAnthropicSettings(source: ReturnType<typeof demoAppSource>): void {
  useProviderSettings(source, {
    provider: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-fixture"
  });
}

/** "gpt-4o" is on the closed tokenizer allow-list
 * (shared/sampling-capabilities.ts), so phrase bias and banned strings
 * resolve instead of reporting "no exact tokenizer". The real api.openai.com
 * host, not a loopback port: phraseBias and bannedStrings are subtracted
 * for every self-hosted local preset without a trusted tokenizer (KoboldCpp,
 * LM Studio, Ollama, OpenRouter — see PRESET_SUBTRACTIONS in
 * shared/sampling-capabilities.ts) regardless of what model name it reports,
 * so this test needs a preset the model name is trustworthy for. */
function useEncodedModelSettings(source: ReturnType<typeof demoAppSource>): void {
  useProviderSettings(source, {
    provider: "openai-compatible", baseUrl: "https://api.openai.com/v1", model: "gpt-4o"
  });
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
