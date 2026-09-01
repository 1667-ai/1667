import { describe, expect, test } from "bun:test";
import {
  applyBasicSettingsDraft,
  basicSettingsFromDocument
} from "../../shared/settings-basic-draft.js";
import { applySamplingSettings } from "../../shared/sampling-capabilities.js";
import type { SamplingBiasResolutionResult } from "../../shared/sampling-capabilities.js";
import {
  EMPTY_SAMPLING_V2,
  SAMPLING_KNOB_V2_VALUES
} from "../../shared/settings-v2-types.js";
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
  samplingLayerRowIndex
} from "../src/sampling-model.js";
import { samplingListPanelSpec } from "../src/sampling-panel-spec.js";
import { phraseBiasValueRow } from "../src/screens/sampling-bias-panel.js";
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
  test("every sampling parameter a profile can hold has a row in the panel", () => {
    // SAMPLING_LAYER_ROWS spells its order out, because the panel order is not
    // the knob declaration order. A knob that never reaches that list is a
    // parameter the writer cannot see or set, so hold the two together.
    const rows = SAMPLING_LAYER_ROWS.map((row) =>
      row.kind === "scalar" ? row.knob : samplingListPanelSpec(row.panel).knob);
    expect([...rows].sort()).toEqual([...SAMPLING_KNOB_V2_VALUES].sort());
  });

  test("starts collapsed, opens through the Settings row, and shows a shared disabled reason", async () => {
    const { state, press } = settingsHarness();
    await openSettings(press);

    expect(state.settings?.sampling).toBe(null);
    await selectRow(press, state, "sampling");
    const collapsed = render(state, 120, 36);
    expect(collapsed).toContain("sampling");
    expect(collapsed).not.toContain("┏━ sampling");

    await enterSampling(state, press);
    const opened = render(state, 80, 24);
    expect(opened).toContain("┏━ sampling");
    expect(opened).toContain("—");
    expect(opened).not.toContain("←→ adjust");
    expect(opened).not.toContain("↵ open");
    expect(opened).toContain("Dry run does not send provider requests.");
    expect(opened.split("\n").every((line) => visibleWidth(line) <= 80)).toBeTrue();

    await press(key("return"));
    expect(state.settings?.sampling?.edit).toBe(null);
    expect(state.settings?.sampling?.result).toContain("disabled · dry run");
  });

  test("an unavailable stored list stays open for cleanup", async () => {
    const { state, press } = settingsHarness();
    await openSettings(press);
    state.settings!.draft = {
      ...state.settings!.draft,
      sampling: {
        ...state.settings!.draft.sampling,
        logitBias: { "42": 7 }
      }
    };

    await enterSampling(state, press);
    await moveLayer2Cursor(press, samplingLayerRowIndex("logit-bias"));
    const layer = render(state, 100, 36);
    expect(layer).toContain("stored · ↵ open · disabled");
    expect(layer).not.toContain("←→ adjust");

    await press(key("return"));
    expect(state.settings?.sampling?.panel).toBe("logit-bias");
    const stored = render(state, 100, 36);
    expect(stored).toContain("↵ edit");
    expect(stored).toContain("D delete");
    expect(stored).not.toContain("n add");
    expect(stored).not.toContain("←→ reorder");

    await press(key("return"));
    expect(state.settings?.sampling?.edit).not.toBe(null);
    await press(key("escape"));
    expect(state.settings?.sampling?.edit).toBe(null);

    await press(key("n"));
    expect(state.settings?.sampling?.edit).toBe(null);
    expect(state.settings?.sampling?.result).toContain("disabled · dry run");

    await press(key("D"));
    await press(key("D"));
    expect(state.settings?.draft.sampling.logitBias).toEqual({});
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

  test("seed is disabled for Anthropic with a provider-facing reason", async () => {
    const { source, state, press } = settingsHarness();
    useAnthropicSettings(source);
    await enterSampling(state, press);
    await moveLayer2Cursor(press, samplingLayerRowIndex("seed"));

    const frame = render(state, 80, 24);
    const seedLine = frame.split("\n").find((line) => line.includes("seed"));
    expect(seedLine).toContain("—");

    await press(key("return"));
    expect(state.settings?.sampling?.result).toBe("seed disabled · not supported by provider");
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
    await press(key("D"));
    expect(state.settings?.draft.sampling.stop).toEqual(["START", "END"]);
    await press(key("D"));
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
    // LM Studio has no native tokenize side channel 1667 uses, and its
    // reported model name is not trustworthy for tokenizer selection either
    // — phraseBias and bannedStrings stay subtracted for this preset
    // regardless of model (see PRESET_SUBTRACTIONS in
    // shared/sampling-capabilities.ts). KoboldCpp used to be the example
    // here too, before issue #311 gave it its own live tokenize probe — see
    // "phrase bias opens for the KoboldCpp preset" below.
    useLmStudioSettings(source);
    await enterSampling(state, press);
    await moveLayer2Cursor(press, samplingLayerRowIndex("phrase-bias"));
    await press(key("return"));
    expect(state.settings?.sampling?.panel).toBe("sampling");
    expect(state.settings?.sampling?.result).toContain("not supported by provider");
  });

  test("an unavailable frequency penalty names the provider limitation", async () => {
    const { source, state, press } = settingsHarness();
    useKoboldcppSettings(source);
    await enterSampling(state, press);
    await moveLayer2Cursor(press, samplingLayerRowIndex("frequencyPenalty"));

    expect(render(state, 120, 36)).toContain("Not supported by this provider.");

    await press(key("return"));
    expect(state.settings?.sampling?.result)
      .toBe("frequency penalty disabled · not supported by provider");
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

  // Issue #311: KoboldCpp is no longer subtracted for phraseBias either — it
  // resolves through its own live tokenize probe (POST
  // /api/extra/tokencount, server/context-probe.ts), the same reasoning that
  // already applies to llama.cpp above.
  test("phrase bias opens for the KoboldCpp preset instead of reporting it unavailable", async () => {
    const { source, state, press } = settingsHarness();
    useKoboldcppSettings(source);
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
        scope: "profile",
        tokenIds: [84021, 45342, 91530, 34057],
        variants: [
          { variant: "typed", text: "dragon", outcome: { kind: "single-token", tokenId: 84021 } },
          { variant: "leading-space", text: " dragon", outcome: { kind: "single-token", tokenId: 45342 } },
          { variant: "capitalized", text: "Dragon", outcome: { kind: "single-token", tokenId: 91530 } },
          { variant: "leading-space-capitalized", text: " Dragon", outcome: { kind: "single-token", tokenId: 34057 } }
        ]
      }],
      bannedStrings: [],
      nativeBannedStrings: [],
      resolvedEntryCount: 4
    });
    await pending.promise;
    await Promise.resolve();
    const frame = render(state, 80, 24);
    expect(frame).toContain("84021");
  });

  // Issue #311: a KoboldCpp banned string reaches the panel as a "native"
  // entry — no token IDs, no variant breakdown — because 1667 sends it as
  // literal text to KoboldCpp's own anti-slop field rather than tokenizing
  // it. The row must show that plainly, and the entry must stay committed:
  // "native" never blocks a commit (server/sampling-phrase-bias.ts,
  // resolveSamplingLogitBias's "native" transport), unlike "rejected" or
  // "shadowed". Carried on its own `nativeBannedStrings` field, never as a
  // member of `bannedStrings` (issue #311 review, second pass, finding A).
  test("a KoboldCpp banned string renders as native text, not resolved token IDs", async () => {
    const { source, state, press } = settingsHarness();
    useEncodedModelSettings(source);
    const pending = deferred<SamplingBiasResolutionResult>();
    source.api.resolveSamplingBias = async () => await pending.promise;

    await enterSampling(state, press);
    await moveLayer2Cursor(press, samplingLayerRowIndex("banned-strings"));
    await press(key("return"));
    expect(state.settings?.sampling?.panel).toBe("banned-strings");

    await press(key("n"));
    setSamplingEdit(state, "a phrase with several words");
    await press(key("return"));

    pending.resolve({
      kind: "resolved",
      logitBias: {},
      phraseBias: [],
      bannedStrings: [],
      nativeBannedStrings: [{ kind: "native", phrase: "a phrase with several words", scope: "profile" }],
      resolvedEntryCount: 0
    });
    await pending.promise;
    await Promise.resolve();

    // Never un-committed: "native" is not a rejection.
    expect(state.settings?.draft.sampling.bannedStrings).toEqual(["a phrase with several words"]);
    const frame = render(state, 100, 24);
    expect(frame).toContain("literal text");
    expect(frame).not.toContain("‹ — ›");
  });

  // Regression test for issue #282 review round 2, finding 4: the panel
  // displayed the raw entry-list length against the resolved-token bound,
  // so a phrase-bias entry that expands to more than one token (any phrase,
  // ordinarily) understated how much of the shared 200-entry cap it used.
  // "dragon" is one entry that resolves to four tokens — the header and the
  // new-entry gate must both read from the resolved count (4), not the raw
  // list length (1).
  test("phrase bias panel displays and enforces the resolved token count, not the raw entry count", async () => {
    const { source, state, press } = settingsHarness();
    useEncodedModelSettings(source);
    const pending = deferred<SamplingBiasResolutionResult>();
    source.api.resolveSamplingBias = async () => await pending.promise;

    await enterSampling(state, press);
    await moveLayer2Cursor(press, samplingLayerRowIndex("phrase-bias"));
    await press(key("return"));
    await press(key("n"));
    setSamplingEdit(state, "dragon:5");
    await press(key("return"));

    pending.resolve({
      kind: "resolved",
      logitBias: { "84021": 5, "45342": 5, "91530": 5, "34057": 5 },
      phraseBias: [{
        kind: "resolved",
        phrase: "dragon",
        scope: "profile",
        tokenIds: [84021, 45342, 91530, 34057],
        variants: [
          { variant: "typed", text: "dragon", outcome: { kind: "single-token", tokenId: 84021 } },
          { variant: "leading-space", text: " dragon", outcome: { kind: "single-token", tokenId: 45342 } },
          { variant: "capitalized", text: "Dragon", outcome: { kind: "single-token", tokenId: 91530 } },
          { variant: "leading-space-capitalized", text: " Dragon", outcome: { kind: "single-token", tokenId: 34057 } }
        ]
      }],
      bannedStrings: [],
      nativeBannedStrings: [],
      // Deliberately the shared 200-entry cap itself, not 4 — this proves
      // the displayed count and the new-entry gate both read the resolved
      // total (server/sampling-phrase-bias.ts, resolvedEntryCount), the
      // number that actually binds a save, not this one entry's own token
      // count.
      resolvedEntryCount: 200
    });
    await pending.promise;
    await Promise.resolve();

    expect(state.settings?.draft.sampling.phraseBias).toHaveLength(1);
    const frame = render(state, 100, 24);
    expect(frame).toContain("200/200");
    expect(frame).not.toContain("1/200");

    await press(key("n"));
    expect(state.settings?.sampling?.result).toContain("list limit reached");
    expect(state.settings?.sampling?.edit).toBe(null);
  });

  // Regression test for issue #282 review round 3, finding 5: the "kept
  // out" branch un-commits a rejected entry and updates the result line,
  // then starts a second round trip to re-resolve the remaining draft — but
  // used to return without repainting first, so the screen kept the old
  // frame (row still shown, no result line) until that second, slower call
  // landed. Comparing the repaint count at the start of each call proves a
  // repaint lands between them: with the fix, the second call always starts
  // with the count already one higher than the first.
  test("repaints before the recursive re-resolution starts, not only after it lands", async () => {
    const { source, state, press, repaints } = settingsHarness();
    useEncodedModelSettings(source);
    const repaintsAtCallStart: number[] = [];
    const { promise: thirdCallStarted, resolve: notifyThirdCallStarted } = deferred<void>();
    source.api.resolveSamplingBias = async (): Promise<SamplingBiasResolutionResult> => {
      repaintsAtCallStart.push(repaints());
      // Call 1: opening the sampling panel itself resolves once with nothing
      // committed yet (tui/src/settings-overlay-actions.ts) — not the call
      // this test is about. Call 2 is the just-committed check for
      // "dragon:5"; failing it here — a whole-panel "tokenizer-unavailable"
      // kept an entry out even before issue #282 review round 2, finding
      // 5 — is what starts call 3, the recursive re-resolution this test
      // is timing against.
      if (repaintsAtCallStart.length === 2) {
        return { kind: "tokenizer-unavailable", cause: "probe-failed" };
      }
      if (repaintsAtCallStart.length === 3) notifyThirdCallStarted();
      return {
        kind: "resolved",
        logitBias: {},
        phraseBias: [],
        bannedStrings: [],
        nativeBannedStrings: [],
        resolvedEntryCount: 0
      };
    };

    await enterSampling(state, press);
    await moveLayer2Cursor(press, samplingLayerRowIndex("phrase-bias"));
    await press(key("return"));
    await press(key("n"));
    setSamplingEdit(state, "dragon:5");
    await press(key("return"));
    await thirdCallStarted;

    expect(repaintsAtCallStart.length).toBe(3);
    expect(repaintsAtCallStart[2]).toBeGreaterThan(repaintsAtCallStart[1]!);
  });

  // Regression test for issue #282 review round 2, finding 5: a worker call
  // that throws — the provider-check timeout elapsing against a slow
  // llama.cpp server is the everyday case — used to leave the panel pinned
  // at "resolving…" forever, with the entry just committed never un-checked.
  test("a resolveSamplingBias transport failure clears the pending state and keeps the just-committed entry out of the draft", async () => {
    const { source, state, press } = settingsHarness();
    useEncodedModelSettings(source);
    let failure: Promise<never> | undefined;
    source.api.resolveSamplingBias = () => {
      failure = Promise.reject(new Error("connection reset"));
      return failure;
    };

    await enterSampling(state, press);
    await moveLayer2Cursor(press, samplingLayerRowIndex("phrase-bias"));
    await press(key("return"));
    await press(key("n"));
    setSamplingEdit(state, "dragon:5");
    await press(key("return"));

    expect(failure).toBeDefined();
    await failure!.catch(() => {});
    await Promise.resolve();

    expect(state.settings?.draft.sampling.phraseBias).toEqual([]);
    expect(state.settings?.sampling?.biasResolution.kind).toBe("failed");
    expect(state.settings?.sampling?.result).toContain("connection reset");

    const frame = render(state, 100, 24);
    expect(frame).not.toContain("resolving…");
  });

  test("adds banned strings, rejects a duplicate, and saves the sampling payload", async () => {
    const { source, state, press } = settingsHarness();
    useEncodedModelSettings(source);
    // The demo backend's default resolver (tui/src/demo-token-ids.ts) always
    // resolves, unlike the tokenizer-unavailable stub this test used to
    // install: since issue #282 review round 2, finding 5, a
    // tokenizer-unavailable result un-commits the entry a writer just
    // typed — correctly, but that would make the duplicate check below moot,
    // because the first "forbidden word" would never stay committed to be a
    // duplicate of.
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

  // Issue #311 review, second pass, finding C: `demoResolveSamplingBias`
  // (tui/src/demo-token-ids.ts) calls the real shared merge
  // (resolveSamplingLogitBias, server/sampling-phrase-bias.ts) rather than
  // re-implementing it, precisely so demo mode and the real backend can
  // never disagree about what a draft resolves to (issue #282 round 4). An
  // earlier version of the KoboldCpp native-transport fix moved that
  // decision above the function demo calls, without also teaching demo mode
  // to derive it — so a KoboldCpp demo profile rendered a banned string
  // "resolved" with fake token IDs while the real backend renders literal
  // text, the exact divergence #282 round 4 exists to rule out. Unlike the
  // KoboldCpp row test above, this leaves `source.api.resolveSamplingBias`
  // untouched — the point is proving the real demo resolver, not a mock of
  // it, derives "native" from the routed KoboldCpp preset on its own.
  test("a KoboldCpp banned string renders as native text through the real demo resolver, not fake resolved token IDs", async () => {
    const { source, state, press } = settingsHarness();
    useKoboldcppSettings(source);
    await enterSampling(state, press);
    await moveLayer2Cursor(press, samplingLayerRowIndex("banned-strings"));
    await press(key("return"));
    expect(state.settings?.sampling?.panel).toBe("banned-strings");

    await press(key("n"));
    setSamplingEdit(state, "a phrase with several words");
    await press(key("return"));
    await Promise.resolve();

    // Never un-committed: "native" is not a rejection, the same as the
    // mocked-resolver test above.
    expect(state.settings?.draft.sampling.bannedStrings).toEqual(["a phrase with several words"]);
    const frame = render(state, 100, 24);
    expect(frame).toContain("literal text");
    expect(frame).not.toContain("‹ — ›");
  });

  // Regression test for issue #311 review, third pass, finding M:
  // `demoResolveSamplingBias`'s special-token guard (finding I) lived inside
  // the live-probe layer only a real network request reaches; demo mode's
  // own synchronous fake tokenizer went through `resolveSamplingLogitBias`
  // directly and never saw it, so a KoboldCpp demo profile rendered
  // `<|eot_id|>` as a healthy `resolved` phrase-bias row — exactly the
  // truncate-every-generation case the guard exists to make unreachable,
  // rendered as safe. This is the third time the editor-preview-versus-
  // request guarantee has broken on this exact path (#282 round 4, this
  // issue's first pass finding C, and now this rule) — like the banned-
  // string test above, this leaves `source.api.resolveSamplingBias`
  // untouched, so it proves the real demo resolver itself carries the
  // guard, not a mock of it.
  test("a KoboldCpp phrase bias spelling special-token syntax is kept out by the real demo resolver, not accepted as resolved", async () => {
    const { source, state, press } = settingsHarness();
    useKoboldcppSettings(source);
    await enterSampling(state, press);
    await moveLayer2Cursor(press, samplingLayerRowIndex("phrase-bias"));
    await press(key("return"));
    expect(state.settings?.sampling?.panel).toBe("phrase-bias");

    await press(key("n"));
    setSamplingEdit(state, "<|eot_id|>:-10");
    await press(key("return"));
    await Promise.resolve();

    // Kept out, the same as any other phrase the resolver cannot honestly
    // bias — never accepted as a healthy "resolved" row with a fake token
    // ID standing in for what a real KoboldCpp server might have answered.
    expect(state.settings?.draft.sampling.phraseBias).toEqual([]);
    expect(state.settings?.sampling?.result).toContain("kept out");
    expect(state.settings?.sampling?.result).toContain("no exact token");
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
    await moveLayer2Cursor(press, samplingLayerRowIndex("mirostat"));

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
    await moveLayer2Cursor(press, samplingLayerRowIndex("mirostatTau"));

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
    await moveLayer2Cursor(press, samplingLayerRowIndex("mirostat"));

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

  test("an LM Studio route explains that extended sampler support is unknown", async () => {
    const { source, state, press } = settingsHarness();
    useSupportedSettings(source, "http://127.0.0.1:1234/v1");
    await enterSampling(state, press);
    const lines = render(state, 100, 48).split("\n");

    const dryLine = lines.find((line) => line.includes("dry multiplier"));
    expect(dryLine).toContain("—");
    expect(dryLine).toContain("Provider support is unknown.");
    // A baseline OpenAI field stays available on the same route.
    const topPLine = lines.find((line) => line.includes("top p"));
    expect(topPLine).toContain("‹ default ›");
  });

  test("adds, edits, reorders, and deletes dry breakers", async () => {
    const { source, state, press } = settingsHarness();
    useSupportedSettings(source);
    await enterSampling(state, press);
    await moveLayer2Cursor(press, samplingLayerRowIndex("dry-breakers"));
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

    await press(key("D"));
    expect(state.settings?.draft.sampling.dryBreakers).toEqual([":", "\n"]);
    await press(key("D"));
    expect(state.settings?.draft.sampling.dryBreakers).toEqual(["\n"]);
  });

  test("the Settings sampling row names a counted list, so breakers do not read as stop", async () => {
    // The summary once spelled every array knob `stop`, which held only while
    // `stop` was the one list. A dry breaker then counted itself as a stop
    // sequence on the Settings row.
    const { source, state, press } = settingsHarness();
    useSupportedSettings(source);
    await enterSampling(state, press);

    await moveLayer2Cursor(press, samplingLayerRowIndex("dry-breakers"));
    await press(key("return"));
    await press(key("n"));
    setSamplingEdit(state, "*");
    await press(key("return"));
    await press(key("escape"));
    await press(key("escape"));

    const row = render(state, 120, 36).split("\n").find((line) => line.includes("▸ sampling"));
    expect(row).toContain("dry breakers 1");
    expect(row).not.toContain("stop");
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
    await moveLayer2Cursor(press, samplingLayerRowIndex("dry-breakers"));
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

  // Regression test for issue #341 finding 3: the row-resolution dispatch
  // used to fall through into "resolved" for any entry kind it did not
  // explicitly recognize, so an "overridden" entry — a real outcome
  // (shared/sampling-phrase-resolution.ts) that just cannot reach this
  // profile-only panel today, since the settings overlay never combines a
  // story with the profile it edits — would have rendered as a working
  // phrase bias, listing its token IDs, when the weight it named never
  // reached the merged map at all. Proven with a mocked resolveSamplingBias
  // result, the only way to construct one today: a real "overridden" entry
  // needs a story in the combined set, and this panel never supplies one.
  test("an overridden phrase-bias entry throws instead of rendering as resolved", async () => {
    const { state, press } = settingsHarness();
    await enterSampling(state, press);
    const sampling = state.settings?.sampling;
    if (sampling === null || sampling === undefined) throw new Error("sampling editor did not open");
    const overriddenResult: SamplingBiasResolutionResult = {
      kind: "resolved",
      logitBias: {},
      phraseBias: [{
        kind: "overridden",
        phrase: "hello",
        scope: "profile",
        variants: [],
        tokenIds: [123],
        conflicts: [{ tokenId: 123, owner: { source: "phraseBias", scope: "story", phrase: "other" } }]
      }],
      bannedStrings: [],
      nativeBannedStrings: [],
      resolvedEntryCount: 1
    };
    sampling.biasResolution = { kind: "ready", result: overriddenResult };
    expect(() => phraseBiasValueRow({ phrase: "hello", weight: 5 }, state.settings!, false, 80))
      .toThrow();
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

// KoboldCpp resolves phraseBias through its own live tokenize probe (POST
// /api/extra/tokencount, server/context-probe.ts — issue #311) instead of
// trusting a reported model name, the same reason llama.cpp is not
// subtracted either. bannedStrings is available too, sent to KoboldCpp's
// native anti-slop field instead of being tokenized (PRESET_SUBTRACTIONS,
// PRESET_WIRE_OVERRIDES in shared/sampling-capabilities.ts).
function useKoboldcppSettings(source: ReturnType<typeof demoAppSource>): void {
  useProviderSettings(source, {
    provider: "openai-compatible", baseUrl: "http://127.0.0.1:5001/v1", model: "gpt-5.2"
  });
}

// LM Studio has no native tokenize side channel 1667 uses, and its reported
// model name is not trustworthy for tokenizer selection either — phraseBias
// and bannedStrings stay subtracted for this preset regardless of model
// (see PRESET_SUBTRACTIONS in shared/sampling-capabilities.ts).
function useLmStudioSettings(source: ReturnType<typeof demoAppSource>): void {
  useProviderSettings(source, {
    provider: "openai-compatible", baseUrl: "http://127.0.0.1:1234/v1", model: "gpt-5.2"
  });
}

// llama.cpp resolves phraseBias/bannedStrings through its own live tokenize
// probe (server/context-probe.ts) instead of trusting a reported model name,
// so it is not subtracted — this preset name stays "supported" for that
// reason, not because the reported name "gpt-5.2" is trustworthy.
function useSupportedSettings(
  source: ReturnType<typeof demoAppSource>,
  baseUrl = "http://127.0.0.1:8080/v1"
): void {
  useProviderSettings(source, {
    provider: "openai-compatible", baseUrl, model: "gpt-5.2"
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
 * for every self-hosted local preset without a trusted tokenizer or a live
 * probe of its own (LM Studio, Ollama, OpenRouter — see
 * PRESET_SUBTRACTIONS in shared/sampling-capabilities.ts) regardless of
 * what model name it reports, so this test needs a preset the model name is
 * trustworthy for. KoboldCpp and llama.cpp are not in that list — issue
 * #311 gave KoboldCpp the same live tokenize probe llama.cpp already had —
 * but this test still picks "openai" specifically to exercise the
 * allow-list path itself, not either preset's live-probe path. */
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
  const document = applySamplingSettings(current.document as never, {
    ...(profile.sampling ?? EMPTY_SAMPLING_V2),
    topP
  });
  const effective = basicSettingsFromDocument(document);
  publishSettingsView(state, source, {
    ...current,
    stateGeneration: current.stateGeneration + 1,
    activeRevision: current.activeRevision + 1,
    document: document as never,
    effective
  });
}

// The status row clipped to one line, which is worst for the message that
// most needs reading: a refused save states its reason in the tail, so the
// writer saw a sentence cut mid-word with no way to reach the rest.
test("a long sampling status wraps instead of losing its tail", async () => {
  const { state, press } = settingsHarness();
  await enterSampling(state, press);
  // Comfortably past one row of a panel this wide, so a clip would have to
  // drop something, and the tail is what a clip drops.
  const reason = "logitBias must be an object, and the provider refused this"
    + " draft because the phrase resolved to no usable token identifier at all"
    + " · clear the entry or choose a model with an exact tokenizer";
  state.settings!.sampling!.result = reason;

  const frame = render(state, 80, 24);

  // The tail carries the recovery, which is exactly what a one-line clip
  // loses. Assert on fragments that survive a wrap boundary rather than the
  // whole sentence, which the border splits across rows.
  expect(frame).toContain("exact tokenizer");
  expect(frame).toContain("logitBias must be an object");
  expect(frame.split("\n").every((line) => visibleWidth(line) <= 80)).toBeTrue();
});

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

/** Rows inside the panel frame only. Matching the whole frame also caught the
 *  status bar, whose next-request estimate contains the same digits as a
 *  token ID, so an unrelated change to prompt size could fail this. */
function renderedLogitRows(frame: string, tokens: readonly string[]): string[] {
  return frame.split("\n")
    .filter((line) => line.includes("┃"))
    .filter((line) => tokens.some((token) => line.includes(token)));
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
