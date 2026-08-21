import { describe, expect, test } from "bun:test";
import { ApiHttpError } from "../src/api.js";
import {
  parseSettings,
  serializeSettings,
  settingsTextDraftForView,
  settingsTextDraftWithGeneration
} from "../src/settings-text.js";
import { commandMatches } from "../src/command-model.js";
import { connectionFailed, connectionSucceeded, createConnectionMonitor, retrySeconds } from "../src/connection.js";
import {
  boundedFactSelection,
  factRows,
  factTagPresets,
  factTags
} from "../src/facts-model.js";
import { fuzzyFilter, fuzzyMatch } from "../src/fuzzy.js";
import { libraryRows, libraryTotals, typedTitleMatches } from "../src/library-model.js";
import { deriveSummaryProgress, narrowedSummaryToast, summaryStretch } from "../src/summary-model.js";
import { promptCacheRowValue } from "../src/settings-overlay-model.js";
import { promptCacheSummaryParts } from "../src/settings-cache-summary.js";
import { convertGenerationSettingsV1 } from "../../server/settings-v2-conversion.js";
import { basicSettingsFromDocument } from "../../shared/settings-basic-draft.js";
import { createFailureEnvelope } from "../../shared/failure-envelope.js";
import type {
  PromptCachePolicyV2,
  SettingsDocumentV2,
  SettingsView
} from "../../shared/settings-v2-types.js";
import { EMPTY_SAMPLING_V2 } from "../../shared/settings-v2-types.js";

describe("fuzzy matching", () => {
  test("orders contiguous early matches first", () => {
    const items = ["the winter orchard", "a glass tide", "the lantern keeper"];
    expect(fuzzyFilter(items, "lan", (item) => item)[0]).toBe("the lantern keeper");
    expect(fuzzyMatch("export markdown", "xpm")?.indices).toEqual([1, 2, 7]);
    expect(fuzzyMatch("salt road", "zz")).toBe(null);
  });
});

describe("library model", () => {
  const stories = [
    { id: "a", title: "the lantern keeper", updatedAt: "2026-07-18T10:00:00Z", partCount: 23, words: 307, forked: true, lineCount: 11 },
    { id: "b", title: "a glass tide", updatedAt: "2026-06-18T10:00:00Z", partCount: 9, words: 1884, forked: false, lineCount: 3 }
  ];
  test("filters by fuzzy title and totals the vault", () => {
    expect(libraryRows(stories, "glass").map((story) => story.id)).toEqual(["b"]);
    expect(libraryTotals(stories)).toEqual({ stories: 2, words: 2191, parts: 32, lines: 14 });
  });
  test("typed delete confirm is exact, not fuzzy", () => {
    expect(typedTitleMatches("the lantern keeper", "the lantern keeper")).toBeTrue();
    expect(typedTitleMatches("the lantern keeper", "the lantern")).toBeFalse();
    expect(typedTitleMatches("the lantern keeper", "The Lantern Keeper")).toBeFalse();
  });
});

describe("facts model", () => {
  const stamp = { createdAt: "2026-07-18T10:00:00Z", updatedAt: "2026-07-18T10:00:00Z" };
  const facts = [
    { id: "1", tag: "Character", text: "Maren\nKeeper of the lantern-house.", activation: "always" as const, keys: [], ...stamp },
    { id: "2", tag: "Item", text: "Brass compass\nPoints at want, not north.", activation: "always" as const, keys: [], ...stamp },
    { id: "3", tag: null, text: "The pass closes for three days in any real storm.", activation: "always" as const, keys: [], ...stamp }
  ];
  test("tags start with the all chip and sort", () => {
    expect(factTags(facts)).toEqual([null, "Character", "Item"]);
  });
  test("the editor slider keeps Storytavern defaults before saved custom tags", () => {
    expect(factTagPresets(facts)).toEqual([
      null, "people", "places", "rules", "items", "Character", "Item"
    ]);
    expect(factTagPresets(facts, "Weather").at(-1)).toBe("Weather");
  });
  test("rows respect chip and fuzzy query together", () => {
    expect(factRows(facts, "Item", "").map((fact) => fact.id)).toEqual(["2"]);
    expect(factRows(facts, null, "brass").map((fact) => fact.id)).toEqual(["2"]);
  });
  test("retains a tag identity when sorted chips shift and falls back to all when it disappears", () => {
    const selected = { chip: 2, cursor: 0, selectedTag: "Item" };
    const inserted = [{ id: "4", tag: "Artifact", text: "Map", activation: "always" as const, keys: [], ...stamp }, ...facts];
    expect(boundedFactSelection(inserted, selected, "")).toMatchObject({ chip: 3, selectedTag: "Item" });
    expect(boundedFactSelection(facts.filter((fact) => fact.tag !== "Item"), selected, ""))
      .toEqual({ chip: 0, cursor: 0, selectedTag: null });
  });
  test("multiline persisted Fact tags stay outside the reusable slider", () => {
    for (const separator of ["\n", "\r", "\u2028", "\u2029"]) {
      const tag = `weather${separator}urgent`;
      const fact = { id: "multiline", tag, text: "Body stays whole.", activation: "always" as const, keys: [], ...stamp };

      expect(factTagPresets([fact])).not.toContain(tag);
    }
  });
});

describe("command palette", () => {
  test("fuzzy filters and hides demo-only commands outside demo", () => {
    expect(commandMatches("", false).some((match) => match.command.id === "disconnect")).toBeFalse();
    expect(commandMatches("", true).some((match) => match.command.id === "disconnect")).toBeTrue();
    expect(commandMatches("sum", false)[0]?.command.id).toBe("summary");
    expect(commandMatches("prune", false)[0]?.command.id).toBe("prune");
  });
});

describe("summary model", () => {
  test("stretch spans from after the previous summary to the leaf", () => {
    const path = [{}, {}, {}, { role: "summary" as const }, {}, {}];
    expect(summaryStretch(path)).toEqual({ start: 5, end: 6, total: 2 });
    expect(summaryStretch([{}, {}])).toEqual({ start: 1, end: 2, total: 2 });
  });
  test("a summary narrowed by exactly one part reports one fewer part than the stretch total (issue #139 P2)", () => {
    const path = [
      { id: "root" },
      { id: "a" },
      { id: "b" },
      { id: "old-summary", role: "summary" as const },
      { id: "leaf-predecessor" },
      { id: "leaf" }
    ];
    const stretch = summaryStretch(path);
    expect(stretch).toEqual({ start: 5, end: 6, total: 2 });
    // The server dropped exactly the leaf, narrowing to the leaf's
    // immediate predecessor — one part short of the full stretch. Assert
    // the rendered toast text, the number the writer actually sees, not
    // summaryPointProgress's raw return value: an off-by-one here would
    // slip past a test that only checked the internal number in isolation
    // if the two ever used inconsistent 1-based/0-based conventions.
    const toast = narrowedSummaryToast(path, stretch, { nodeId: "leaf-predecessor" });
    expect(toast).toContain("covers 1 of 2 parts");
    expect(toast).not.toContain("covers 2 of 2");
    // Summarizing all the way through the leaf itself (not narrowed) covers
    // the full stretch — the boundary this off-by-one could also invert.
    expect(narrowedSummaryToast(path, stretch, { nodeId: "leaf" })).toContain("covers 2 of 2 parts");
  });
  test("progress honors a ¶ marker and falls back to words", () => {
    expect(deriveSummaryProgress("¶ 3 of 9 recorded so far", 9)).toMatchObject({ consumedParts: 3, totalParts: 9 });
    expect(deriveSummaryProgress("no markers, just prose here", 9)).toMatchObject({ consumedParts: null, words: 5 });
    expect(deriveSummaryProgress("¶ 12 of 9", 9).consumedParts).toBe(null);
  });
});

describe("settings text contract", () => {
  const base = {
    document: null,
    selectedProfileId: null,
    generation: {
      provider: "dry-run", baseUrl: "", model: "qwen3-32b", apiKeyEnv: null,
      temperature: 0.7, maxTokens: 2048, systemPrompt: "Continue.", contextWindow: 32768
    },
    cachePolicy: "off",
    sampling: EMPTY_SAMPLING_V2
  } as const;
  test("round-trips through the editor format", () => {
    const parsed = parseSettings(serializeSettings(base), base);
    expect(parsed).toEqual(base);
  });
  test("rejects typos and bad numbers loudly", () => {
    expect(parseSettings("modle: x", base)).toEqual({ error: 'unknown setting "modle"' });
    expect("error" in (parseSettings("maxTokens: many", base) as object)).toBeTrue();
  });
  test("rejects invalid sampling values before a settings save", () => {
    expect(parseSettings("sampling.topP: 2", base)).toEqual({
      error: "sampling.topP must be a finite number in 0..1"
    });
    expect(parseSettings('sampling.logitBias: {"1": 1.5}', base)).toEqual({
      error: "sampling.logitBias.1 must be an integer in -100..100"
    });
    expect(parseSettings('sampling.logitBias: {"1": 101}', base)).toEqual({
      error: "sampling.logitBias.1 must be an integer in -100..100"
    });
  });
  test("blank apiKeyEnv and contextWindow mean null", () => {
    const parsed = parseSettings("apiKeyEnv:\ncontextWindow:", base);
    expect(parsed).toMatchObject({
      generation: { apiKeyEnv: null, contextWindow: null },
      cachePolicy: "off"
    });
  });
  test("accepts only the closed Advanced cache policy values", () => {
    expect(parseSettings("cachePolicy: long", base)).toMatchObject({ cachePolicy: "long" });
    expect(parseSettings("cachePolicy: forever", base)).toEqual({
      error: 'cachePolicy must be off, auto, or long — "forever"'
    });
  });
});

describe("settings cache summary", () => {
  /** The narrowest panel that shows a full-width row. An 80-cell terminal
   * gives 68 cells of content, and the value starts 24 cells in. A longer
   * summary than this loses its write premium to the ellipsis. */
  const NARROWEST_VALUE_CELLS = 44;

  test("keeps TTL and write premium visible in the 80-cell terminal", () => {
    const summaries = [
      promptCacheRowValue(cacheView("anthropic", "claude-sonnet-5", "auto")),
      promptCacheRowValue(cacheView("anthropic", "claude-sonnet-5", "long")),
      promptCacheRowValue(cacheView("openai-compatible", "gpt-5.6", "auto")),
      promptCacheRowValue(cacheView("openai-compatible", "gpt-5.4", "long"))
    ];

    expect(summaries).toEqual([
      "‹ auto › · stable block · 5m · 1.25× writes",
      "‹ long › · stable block · 1h · 2× writes",
      "‹ auto › · breakpoints · ≥30m · 1.25× writes",
      "‹ long › · stable key · ≤24h · no premium"
    ]);
    const widest = Math.max(...summaries.map((summary) => [...summary].length));
    expect(widest).toBeLessThan(NARROWEST_VALUE_CELLS + 1);
  });

  test("derives capability from the complete unsaved route", () => {
    const view = cacheView("anthropic", "claude-sonnet-5", "auto");
    const base = settingsTextDraftForView(view);
    const summary = promptCacheRowValue(view, settingsTextDraftWithGeneration(
      base,
      {
        ...base.generation,
        provider: "dry-run",
        baseUrl: "",
        model: "",
        apiKeyEnv: null
      },
    ));

    expect(summary).toContain("Dry run");
    expect(summary).toContain("unavailable");
  });

  test("does not guess a successor prompt cache policy", () => {
    for (const cachePolicy of ["auto", "long"] as const) {
      const view = readOnlyCacheView(cachePolicy, "successor-schema");
      expect(promptCacheSummaryParts(view)).toEqual({
        kind: "unavailable",
        policy: "successor-owned",
        detail: "unavailable",
        reason: "newer settings are read-only · successor owns settings · update 1667",
        compactReason: "successor-owned · update 1667"
      });
      expect(promptCacheRowValue(view)).toBe(
        "‹ successor-owned › · unavailable · newer settings are read-only · successor owns settings · update 1667"
      );
    }

    const legacy = readOnlyCacheView("auto");
    expect(promptCacheSummaryParts(legacy)).toEqual({
      kind: "available",
      policy: "off",
      detail: "no opt-in controls · format 1",
      description: "Prompt caching is unavailable in legacy settings."
    });
    expect(promptCacheRowValue(legacy)).toBe(
      "‹ off › · no opt-in controls · format 1"
    );
  });
});

describe("connection monitor error classes", () => {
  test("application errors never raise the banner; transport errors do", async () => {
    const stub = {
      listStories: async () => {
        throw new ApiHttpError(createFailureEnvelope({
          code: "conflict",
          message: "Prune changed (409)",
          status: 409
        }));
      },
      loadStory: async () => { throw new TypeError("fetch failed"); }
    } as unknown as Parameters<typeof createConnectionMonitor>[0];
    const monitor = createConnectionMonitor(stub);
    await monitor.api.listStories().catch(() => undefined);
    expect(monitor.state().down).toBeFalse();
    await monitor.api.loadStory("x").catch(() => undefined);
    expect(monitor.state().down).toBeTrue();
    monitor.dispose();
  });

  test("an older retry failure cannot overwrite newer proven connectivity", async () => {
    let rejectOld!: (error: Error) => void;
    const oldProbe = new Promise<never>((_resolve, reject) => { rejectOld = reject; });
    let calls = 0;
    const stub = {
      listStories: async () => {
        calls += 1;
        if (calls === 1) throw new TypeError("initial outage");
        if (calls === 2) return await oldProbe;
        if (calls === 4) throw new TypeError("genuine later outage");
        return [];
      }
    } as unknown as Parameters<typeof createConnectionMonitor>[0];
    const monitor = createConnectionMonitor(stub);
    const transitions: boolean[] = [];
    monitor.subscribe(({ down }) => transitions.push(down));

    await monitor.api.listStories().catch(() => undefined);
    expect(monitor.state().down).toBeTrue();
    const obsolete = monitor.retryNow();

    expect(await monitor.retryNow()).toBeTrue();
    expect(monitor.state().down).toBeFalse();
    rejectOld(new TypeError("obsolete failure"));

    expect(await obsolete).toBeTrue();
    expect(monitor.state().down).toBeFalse();
    expect(transitions).toEqual([true, false]);

    expect(await monitor.retryNow()).toBeFalse();
    expect(monitor.state()).toMatchObject({
      down: true,
      attempt: 1,
      error: "genuine later outage"
    });
    expect(monitor.state().nextRetryAt).not.toBe(null);
    monitor.dispose();
  });

  test("an older proxied failure cannot overwrite a newer proxied success", async () => {
    let rejectOld!: (error: Error) => void;
    const oldRequest = new Promise<never>((_resolve, reject) => { rejectOld = reject; });
    let catalogCalls = 0;
    const stub = {
      listStories: async () => {
        catalogCalls += 1;
        if (catalogCalls === 1) throw new TypeError("initial outage");
        return [];
      },
      loadStory: async () => await oldRequest
    } as unknown as Parameters<typeof createConnectionMonitor>[0];
    const monitor = createConnectionMonitor(stub);

    await monitor.api.listStories().catch(() => undefined);
    const obsolete = monitor.api.loadStory("old").catch((error: unknown) => error);
    await monitor.api.listStories();
    rejectOld(new TypeError("obsolete request failure"));

    expect((await obsolete) instanceof TypeError).toBeTrue();
    expect(monitor.state().down).toBeFalse();
    monitor.dispose();
  });
});

describe("connection state machine", () => {
  test("fails with capped attempts, schedules retries, and recovers", () => {
    let state = connectionFailed(connectionSucceeded(), new Error("refused"), 1_000);
    expect(state).toMatchObject({ down: true, attempt: 1, nextRetryAt: 4_000 });
    for (let round = 0; round < 6; round += 1) state = connectionFailed(state, new Error("refused"), 10_000);
    expect(state.attempt).toBe(5);
    expect(state.nextRetryAt).toBe(null);
    expect(retrySeconds(connectionFailed(connectionSucceeded(), "x", 0), 1_500)).toBe(2);
    expect(connectionSucceeded().down).toBeFalse();
  });
});

function cacheView(
  provider: "openai-compatible" | "anthropic",
  model: string,
  cachePolicy: PromptCachePolicyV2
): SettingsView {
  const base = convertGenerationSettingsV1({
    provider,
    baseUrl: provider === "anthropic"
      ? "https://api.anthropic.com"
      : "https://api.openai.com/v1",
    model,
    apiKeyEnv: provider === "anthropic"
      ? "ANTHROPIC_API_KEY"
      : "OPENAI_API_KEY",
    temperature: 0.7,
    maxTokens: 2_048,
    systemPrompt: "Continue.",
    contextWindow: null
  });
  const modelId = base.profiles.default!.modelId;
  const document: SettingsDocumentV2 = {
    ...base,
    models: {
      ...base.models,
      [modelId]: {
        ...base.models[modelId]!,
        capabilities: {
          ...base.models[modelId]!.capabilities,
          promptCaching: "supported"
        }
      }
    },
    profiles: {
      ...base.profiles,
      default: { ...base.profiles.default!, cachePolicy }
    }
  };
  return {
    dataFormat: 2,
    editable: true,
    stateGeneration: 1,
    activeRevision: 1,
    pendingRevision: null,
    document,
    effective: basicSettingsFromDocument(document),
    effectiveProse: basicSettingsFromDocument(document),
    lastActivationOutcome: null
  };
}

function readOnlyCacheView(
  cachePolicy: PromptCachePolicyV2,
  readOnlyReason?: "successor-schema"
): Extract<SettingsView, { dataFormat: 1 }> {
  const editable = cacheView("anthropic", "claude-sonnet-5", cachePolicy);
  return {
    dataFormat: 1,
    editable: false,
    ...(readOnlyReason === undefined ? {} : { readOnlyReason }),
    stateGeneration: null,
    activeRevision: null,
    pendingRevision: null,
    document: null,
    effective: editable.effective,
    effectiveProse: editable.effectiveProse,
    lastActivationOutcome: null
  };
}
