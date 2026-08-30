import { describe, expect, test } from "bun:test";
import { initialState } from "../src/app.js";
import { demoAppSource } from "../src/demo.js";
import type { HitRows } from "../src/hit.js";
import { buildRailModel } from "../src/rail.js";
import { nextRequestEstimate, type NextRequestContext } from "../src/request-projection.js";
import { renderFactsPanel } from "../src/screens/facts-panel.js";
import { renderFactsRail } from "../src/screens/story/facts-rail.js";
import { frameText, segment, sliceFrame } from "../src/screens/story/frame.js";
import { deriveStoryFrameLayout } from "../src/story-frame-layout.js";
import { factWithText } from "./fact-fixture.js";
import { effectiveFactAtPath } from "../../shared/fact-state.js";

describe("Fact activation projections", () => {
  test("the Facts panel and side rail distinguish regex, chained, and unevaluated Facts", () => {
    const state = initialState(demoAppSource(), false);
    const template = state.payload.facts[0]!;
    const facts = [
      factWithText(template, "Regex Fact", { id: "regex", tag: "Regex", activation: "keyed", keys: ["/Maren/"] }),
      factWithText(template, "Chain Fact", { id: "chain", tag: "Chain", activation: "keyed", keys: ["chain source"] }),
      factWithText(template, "Unchecked Fact", { id: "unchecked", tag: "Unchecked", activation: "keyed", keys: ["/never/"] })
    ];
    state.payload = { ...state.payload, facts };
    const estimate = projectedEstimate(state.payload, facts);

    state.mode = "FACTS";
    state.facts = {
      cursor: 0,
      query: "",
      chip: 0,
      selectedTag: null,
      filtering: false,
      deleteArmedId: null
    };
    const panelHeight = 28;
    state.hitRows = Array.from({ length: panelHeight }, () => null);
    const panel = frameText(renderFactsPanel(
      Array.from({ length: panelHeight }, () => []),
      state,
      120,
      panelHeight,
      estimate
    ).lines);

    expect(panel).toContain("✓ regex");
    expect(panel).toContain("✓ chain");
    expect(panel).toContain("⚠ keyed");
    expect(panel).toContain("⚠1 unchecked");

    const model = buildRailModel(state.payload, "", 32_768, estimate);
    const railHeight = 20;
    const layout = deriveStoryFrameLayout(140, state.config);
    const rail = renderFactsRail(
      Array.from({ length: railHeight }, () => [segment(" ".repeat(layout.pageWidth))]),
      model,
      Array.from({ length: railHeight }, () => null) as HitRows,
      railHeight,
      layout
    );
    const railText = frameText(sliceFrame(
      rail,
      layout.pageWidth,
      (layout.railRight ?? layout.fullWidth) - layout.pageWidth
    ));

    expect(railText).toContain("✓ Regex Fact");
    expect(railText).toContain("✓ Chain Fact");
    expect(railText).toContain("⚠ Unchecked Fact");
  });
});

function projectedEstimate(
  payload: ReturnType<typeof demoAppSource>["payload"],
  facts: typeof payload.facts
) {
  const request: NextRequestContext = {
    systemPrompt: "Continue.",
    instruction: "",
    assistantPrefill: true,
    operation: "continue",
    targetId: payload.path.at(-1)!.id,
    contextWindow: null,
    maxTokens: 0
  };
  const base = nextRequestEstimate(payload, request);
  const [regex, chain, unchecked] = facts;
  return {
    ...base,
    factStatuses: new Map([
      [regex!.id, { kind: "sent" as const }],
      [chain!.id, { kind: "sent" as const }],
      [unchecked!.id, { kind: "unevaluated" as const }]
    ]),
    activation: {
      facts: [regex!, chain!].map((fact) => effectiveFactAtPath(fact, payload.path)!).filter((fact) => fact !== null),
      traces: new Map([
        [regex!.id, { kind: "regex" as const, key: "/Maren/", round: 0, gate: null }],
        [chain!.id, { kind: "literal" as const, key: "chain source", round: 1, gate: null }]
      ]),
      unevaluated: [unchecked!.id],
      outOfScope: [],
      ended: [],
      keyedMiss: []
    }
  };
}
