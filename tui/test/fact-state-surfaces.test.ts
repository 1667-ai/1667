import { describe, expect, test } from "bun:test";
import { initialState } from "../src/app.js";
import { demoAppSource } from "../src/demo.js";
import { nextRequestContext } from "../src/request-context.js";
import { nextRequestEstimate } from "../src/request-projection.js";
import { buildRailModel } from "../src/rail.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { renderFactsRail } from "../src/screens/story/facts-rail.js";
import { frameText, plainLine, segment, sliceFrame } from "../src/screens/story/frame.js";
import { deriveStoryFrameLayout } from "../src/story-frame-layout.js";
import { hitAt } from "../src/hit.js";

const STAMP = "2026-01-01T00:00:00.000Z";

describe("branch-scoped Fact reading surfaces", () => {
  test("rail names the current line, whispers state scope, and keeps the anchor card clickable", () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const base = state.payload.facts[0]!;
    state.payload = {
      ...state.payload,
      facts: [
        {
          ...base,
          id: "evolving",
          name: "ama",
          activation: "always",
          keys: [],
          states: [
            { id: "s1", anchorPartId: "p11", text: "Old keeper text.", createdAt: STAMP, updatedAt: STAMP },
            { id: "s2", anchorPartId: "p12", text: "New keeper text.", createdAt: STAMP, updatedAt: STAMP },
            { id: "end", anchorPartId: "p13", ends: true, createdAt: STAMP, updatedAt: STAMP },
            { id: "sibling", anchorPartId: "p3-alt", text: "Harbor keeper text.", createdAt: STAMP, updatedAt: STAMP }
          ]
        },
        {
          ...base,
          id: "other-line",
          name: "the-signaler",
          activation: "always",
          keys: [],
          states: [{ id: "other", anchorPartId: "p3-alt", text: "Harbor only.", createdAt: STAMP, updatedAt: STAMP }]
        },
        {
          ...base,
          id: "keyed-no-hit",
          name: "quiet keeper",
          activation: "keyed",
          keys: ["never-matches"],
          states: [
            { id: "quiet", anchorPartId: "p12", text: "Not carried without a key.", createdAt: STAMP, updatedAt: STAMP },
            { id: "quiet-end", anchorPartId: "p13", ends: true, createdAt: STAMP, updatedAt: STAMP }
          ]
        }
      ]
    };
    const estimate = nextRequestEstimate(state.payload, nextRequestContext(state));
    const model = buildRailModel(
      state.payload,
      "",
      state.contextWindow,
      estimate,
      0,
      0,
      null,
      "p12"
    );
    const layout = deriveStoryFrameLayout(140, state.config);
    const height = 24;
    const hits = Array.from({ length: height }, () => null);
    const painted = renderFactsRail(
      Array.from({ length: height }, () => [segment(" ".repeat(layout.pageWidth))]),
      model,
      hits,
      height,
      layout
    );
    const rail = sliceFrame(
      painted,
      layout.pageWidth,
      (layout.railRight ?? layout.fullWidth) - layout.pageWidth
    );
    const text = frameText(rail);

    expect(text).toContain("line canon-storm");
    expect(text).toContain("✕ at ¶13 ↓");
    expect(text).toContain("st.2/4");
    expect(text).toContain("st.4 still rides · other line");
    expect(text).toContain("since ◆ ¶12");
    expect(text).toContain("⊘ the-signaler");
    expect(text).toContain("other line");
    const noHit = model.facts.find(({ name }) => name === "quiet keeper");
    expect(noHit?.status.kind).toBe("not-matched");
    expect(noHit?.stateWhisper).toBe("st.1/2");
    for (const status of [
      { kind: "not-matched" as const },
      { kind: "unevaluated" as const },
      { kind: "dropped" as const, reason: "fact-budget" as const }
    ]) {
      const statusEstimate = {
        ...estimate,
        factStatuses: new Map(estimate.factStatuses).set("evolving", status)
      };
      const statusModel = buildRailModel(
        state.payload, "", state.contextWindow, statusEstimate, 0, 0, null, "p12"
      );
      expect(statusModel.facts.find(({ name }) => name === "ama")?.stateWhisper).toBe("st.2/4");
    }

    const cardRow = rail.findIndex((line) => plainLine(line).includes("since ◆ ¶12"));
    expect(cardRow).toBeGreaterThan(-1);
    expect(hitAt(hits, layout.factLeft!, cardRow)).toEqual({ kind: "fact", index: 0 });
  });

  test("gutter marks a state anchor and leaves the prose row under the normal part hit", () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const base = state.payload.facts[0]!;
    state.payload = {
      ...state.payload,
      facts: [{
        ...base,
        id: "anchored",
        name: "keeper",
        activation: "always",
        keys: [],
        states: [{ id: "anchored-state", anchorPartId: "p12", text: "Keeper state.", createdAt: STAMP, updatedAt: STAMP }]
      }]
    };
    const frame = renderStoryScreen(state, { width: 140, height: 36 });
    const row = frame.lines.findIndex((line) => plainLine(line).includes("◆ ¶ 12"));

    expect(row).toBeGreaterThan(-1);
    expect(frame.lines[row]!.some((part) => part.text === "◆" && part.role === "focus / accent")).toBeTrue();
    expect(hitAt(frame.derived.hitRows, 5, row)).toEqual({ kind: "part", index: state.focusIndex, rowId: "p12" });
  });
});
