import { describe, expect, test } from "bun:test";
import type {
  SettingsPresetV2,
  SettingsProtocolV2,
  SettingsView
} from "../../shared/settings-v2-types.js";
import type { TokenProbabilityStep } from "../../shared/token-probabilities.js";
import { DEMO_SETTINGS_DOCUMENT, DEMO_SETTINGS_VIEW } from "../src/demo.js";
import {
  resolveTokenProbabilityEmptyReason,
  tokenDisplayGlyph,
  tokenProbabilityAlternativeRows,
  tokenProbabilityExcerpt,
  tokenProbabilitySpan
} from "../src/token-probabilities-model.js";

/**
 * Unit coverage for the one module in issue #291 phase 4 whose branches an
 * end-to-end or integration test cannot pin down one at a time: the
 * alternatives collapse/expand split, the whitespace placeholder mapping,
 * the excerpt window's truncation flags, and which route text each capability
 * gate produces. `alignTokenProbabilities` earned the same treatment in
 * shared/token-probabilities.ts for the same reason (see CLAUDE.md's test
 * rules).
 */

function step(token: string, alternatives: readonly [string, number][]): TokenProbabilityStep {
  return {
    token,
    logprob: alternatives[0]?.[1] ?? -0.05,
    alternatives: alternatives.map(([alternativeToken, logprob]) => ({ token: alternativeToken, logprob }))
  };
}

describe("tokenProbabilityAlternativeRows", () => {
  test("keeps every alternative when none fall under 1 %", () => {
    const rows = tokenProbabilityAlternativeRows(
      step("pit", [["pit", -0.05], ["dark", -0.5], ["well", -1]]),
      false
    );
    expect(rows).toEqual([
      { kind: "alternative", index: 0, token: "pit", logprob: -0.05, p: Math.exp(-0.05), sampled: true },
      { kind: "alternative", index: 1, token: "dark", logprob: -0.5, p: Math.exp(-0.5), sampled: false },
      { kind: "alternative", index: 2, token: "well", logprob: -1, p: Math.exp(-1), sampled: false }
    ]);
  });

  test("collapses everything under 1 % into one row until expanded", () => {
    const fixture = step("pit", [
      ["pit", -0.05],
      ["dark", -0.5],
      ["gloom", -4.074], // ~1.7 %, stays visible
      ["a", -5], // ~0.67 %, collapses
      ["an", -6] // ~0.25 %, collapses
    ]);
    const collapsed = tokenProbabilityAlternativeRows(fixture, false);
    expect(collapsed).toHaveLength(4);
    expect(collapsed.at(-1)).toEqual({ kind: "collapsed", hiddenCount: 2 });

    const expanded = tokenProbabilityAlternativeRows(fixture, true);
    expect(expanded).toHaveLength(5);
    expect(expanded.map((row) => row.kind === "alternative" ? row.token : null)).toEqual([
      "pit", "dark", "gloom", "a", "an"
    ]);
  });

  test("marks only the first alternative whose token matches the sampled token", () => {
    const rows = tokenProbabilityAlternativeRows(
      step("the", [["dark", -0.2], ["the", -0.3], ["the", -0.4]]),
      false
    );
    expect(rows.map((row) => row.kind === "alternative" ? row.sampled : null)).toEqual([false, true, false]);
  });

  test("a step whose sampled token never appears among its alternatives marks none", () => {
    const rows = tokenProbabilityAlternativeRows(step("pit", [["dark", -0.2], ["well", -0.4]]), false);
    expect(rows.every((row) => row.kind !== "alternative" || !row.sampled)).toBe(true);
  });

  test("a boundary-narrowed step still finds its sampled alternative by trimming", () => {
    // alignTokenProbabilities (shared/token-probabilities.ts) narrows a
    // boundary token to drop leading or trailing whitespace the stored take
    // already dropped, but never touches the alternatives list — so the
    // sampled entry a real dry-run take captures reads " The" while the
    // step's own (narrowed) token reads "The". This is the exact shape that
    // slipped through review until the phase-4 end-to-end test caught it.
    const rows = tokenProbabilityAlternativeRows(step("The", [[" The", -0.05], ["a", -0.45]]), false);
    expect(rows[0]).toMatchObject({ token: " The", sampled: true });
    expect(rows[1]).toMatchObject({ token: "a", sampled: false });
  });

  test("an exact match wins even when a trimmed alternative sits earlier in the list", () => {
    const rows = tokenProbabilityAlternativeRows(
      step("the", [[" the", -0.1], ["the", -0.05]]),
      false
    );
    expect(rows[0]).toMatchObject({ token: " the", sampled: false });
    expect(rows[1]).toMatchObject({ token: "the", sampled: true });
  });
});

describe("tokenDisplayGlyph", () => {
  test("leaves visible text untouched, even with leading or trailing whitespace", () => {
    expect(tokenDisplayGlyph("pit")).toBe("pit");
    expect(tokenDisplayGlyph(" pit")).toBe(" pit");
    expect(tokenDisplayGlyph("pit ")).toBe("pit ");
  });

  test("maps a whitespace-only token to a legible placeholder", () => {
    expect(tokenDisplayGlyph(" ")).toBe("·");
    expect(tokenDisplayGlyph("  ")).toBe("··");
    expect(tokenDisplayGlyph("\n")).toBe("↵");
    expect(tokenDisplayGlyph("\t")).toBe("→");
    expect(tokenDisplayGlyph(" \n")).toBe("·↵");
  });

  test("an empty token stays empty", () => {
    expect(tokenDisplayGlyph("")).toBe("");
  });
});

describe("tokenProbabilitySpan", () => {
  test("sums the earlier steps' token lengths, offset by textOffset", () => {
    const record = {
      format: "1667-token-probabilities" as const,
      schemaVersion: 1 as const,
      requested: 3,
      textOffset: 5,
      steps: [step("ab", [["ab", -0.1]]), step("cd", [["cd", -0.1]]), step("ef", [["ef", -0.1]])]
    };
    expect(tokenProbabilitySpan(record, 0)).toEqual({ start: 5, end: 7 });
    expect(tokenProbabilitySpan(record, 1)).toEqual({ start: 7, end: 9 });
    expect(tokenProbabilitySpan(record, 2)).toEqual({ start: 9, end: 11 });
  });
});

describe("tokenProbabilityExcerpt", () => {
  test("a short passage needs no truncation on either side", () => {
    const text = "the lantern guttered as Aldric stepped into the pit and went quiet";
    const highlight = { start: text.indexOf("pit"), end: text.indexOf("pit") + 3 };
    const excerpt = tokenProbabilityExcerpt(text, highlight, 72);
    expect(excerpt.truncatedStart).toBe(false);
    expect(excerpt.truncatedEnd).toBe(false);
    expect(excerpt.lines.map((line) => line.text).join(" ")).toContain("pit");
  });

  test("a long passage windows around the highlight and flags both cut ends", () => {
    const words = Array.from({ length: 60 }, (_, index) => `word${index}`);
    words[30] = "pit";
    const text = words.join(" ");
    const highlight = { start: text.indexOf(" pit ") + 1, end: text.indexOf(" pit ") + 4 };
    const excerpt = tokenProbabilityExcerpt(text, highlight, 20, 1);
    expect(excerpt.truncatedStart).toBe(true);
    expect(excerpt.truncatedEnd).toBe(true);
    expect(excerpt.lines.length).toBeGreaterThan(0);
    expect(excerpt.lines.length).toBeLessThan(4);
    const hit = excerpt.lines.find((line) => line.text.includes("pit"));
    expect(hit).toBeDefined();
    const run = hit!.styleRuns[0];
    expect(run).toBeDefined();
    expect(hit!.text.slice(run!.start, run!.end)).toBe("pit");
  });

  test("either an empty text or a zero-width highlight refuses no line, but paints nothing", () => {
    const excerpt = tokenProbabilityExcerpt("", { start: 0, end: 0 }, 20);
    expect(excerpt.lines).toHaveLength(1);
    expect(excerpt.lines[0]?.styleRuns).toEqual([]);
  });
});

describe("resolveTokenProbabilityEmptyReason", () => {
  const legacyView: SettingsView = {
    dataFormat: 1,
    editable: false,
    stateGeneration: null,
    activeRevision: null,
    pendingRevision: null,
    document: null,
    effective: DEMO_SETTINGS_VIEW.effective,
    effectiveProse: DEMO_SETTINGS_VIEW.effectiveProse,
    lastActivationOutcome: null
  };

  test("format 1 settings resolve legacy-v1, with no preset list", () => {
    const reason = resolveTokenProbabilityEmptyReason(legacyView);
    expect(reason.text).toBe("Format 1 settings are read-only.");
    expect(reason.supportedPresets).toBe(undefined);
  });

  test("an Anthropic Messages route resolves protocol, naming the presets that do work", () => {
    const reason = resolveTokenProbabilityEmptyReason(routeView("anthropic", "anthropic-messages"));
    expect(reason.text).toBe("This provider does not support token probabilities.");
    expect(reason.supportedPresets).toEqual(["OpenAI", "OpenRouter", "llama.cpp", "KoboldCpp", "LM Studio"]);
  });

  test("an unlisted OpenAI-compatible preset resolves preset-unknown, naming the presets that do work", () => {
    const reason = resolveTokenProbabilityEmptyReason(routeView("ollama", "openai-chat-completions"));
    expect(reason.text).toBe("Token probability support is unknown for this provider.");
    expect(reason.supportedPresets).toEqual(["OpenAI", "OpenRouter", "llama.cpp", "KoboldCpp", "LM Studio"]);
  });

  test("a route that supports the feature today reports the take as simply not asked, with no preset list", () => {
    // DEMO_SETTINGS_VIEW's route is dry-run, which resolveTokenProbabilities
    // reports available — this is the "off for this take" case, not a
    // capability gate, so it carries no reason from the shared module.
    const reason = resolveTokenProbabilityEmptyReason(DEMO_SETTINGS_VIEW);
    expect(reason.text).toBe(
      "Press , for Settings. Set alt count (alternatives per token) to 1–20. Save, then generate again."
    );
    expect(reason.supportedPresets).toBe(undefined);
  });
});

/** A format-2 settings view whose one connection uses the given preset and
 *  protocol — built from the ground up as the dataFormat-2 branch, rather
 *  than spread from `DEMO_SETTINGS_VIEW`'s union type, which TypeScript
 *  cannot narrow through a spread. */
function routeView(preset: SettingsPresetV2, protocol: SettingsProtocolV2): SettingsView {
  return {
    dataFormat: 2,
    editable: true,
    stateGeneration: 1,
    activeRevision: 1,
    pendingRevision: null,
    document: {
      ...DEMO_SETTINGS_DOCUMENT,
      connections: {
        demo: { ...DEMO_SETTINGS_DOCUMENT.connections.demo!, preset, protocol }
      }
    },
    effective: DEMO_SETTINGS_VIEW.effective,
    effectiveProse: DEMO_SETTINGS_VIEW.effectiveProse,
    lastActivationOutcome: null
  };
}
