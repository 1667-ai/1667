import { describe, expect, test } from "bun:test";
import type { StoryFact, StoryPayload } from "../../shared/types.js";
import { createStoryViewModel } from "../src/model.js";
import {
  emptyFactConsistencyRun,
  factConsistencyFindingIsStale,
  factConsistencyPreflight,
  factConsistencyPreflightForPart,
  factConsistencyRunView,
  type FactConsistencyFinding,
  type FactConsistencyRun
} from "../src/fact-consistency-check.js";
import {
  completedFactConsistency,
  confirmingFactConsistency,
  factConsistencyKeyAction,
  runningFactConsistency
} from "../src/fact-consistency-actions.js";
import { demoAppSource } from "../src/demo.js";
import { initialState, requestQuitForState } from "../src/app.js";
import { renderFactConsistencyPanel } from "../src/screens/fact-consistency-panel.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { frameText } from "../src/screens/story/frame.js";
import { createWrapCache } from "../src/wrap.js";
import {
  commandContext,
  commandMatches
} from "../src/command-model.js";

const source = demoAppSource();

function fact(id: string, states: StoryFact["states"]): StoryFact {
  return {
    id,
    name: id,
    tag: null,
    states,
    activation: "always",
    keys: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function payloadWithFacts(facts: StoryFact[]): StoryPayload {
  return { ...source.payload, facts };
}

function textState(id: string, text: string, anchorPartId?: string): StoryFact["states"][number] {
  return {
    id,
    text,
    ...(anchorPartId === undefined ? {} : { anchorPartId }),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function endState(id: string, anchorPartId: string): StoryFact["states"][number] {
  return {
    id,
    ends: true,
    anchorPartId,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

describe("Fact consistency preflight", () => {
  test("uses the focused chapter and skips parts with no active Fact State", () => {
    const payload = payloadWithFacts([
      fact("unscoped", [textState("u", "A truth")]),
      fact("scoped", [textState("s", "Later truth", source.payload.path[2]!.id)])
    ]);
    const view = createStoryViewModel(payload);
    const preflight = factConsistencyPreflight(payload, view, "chapter", 1);

    expect(preflight.totalPartCount).toBe(view.chapters[0]!.parts.length);
    expect(preflight.eligiblePartCount).toBe(preflight.totalPartCount);
    expect(preflight.skippedPartCount).toBe(0);
    expect(preflight.requestCount).toBe(preflight.eligiblePartCount);
    expect(preflight.checkedParts[0]).toEqual({
      partId: source.payload.path[0]!.id,
      takeId: source.payload.path[0]!.id
    });
  });

  test("follows unscoped, anchored, and ended Fact State resolution", () => {
    const path = source.payload.path;
    const view = createStoryViewModel(source.payload);
    const beforeAnchor = factConsistencyPreflight(
      payloadWithFacts([fact("scoped", [textState("s", "Later", path[2]!.id)])]),
      createStoryViewModel(payloadWithFacts([fact("scoped", [textState("s", "Later", path[2]!.id)])])),
      "line",
      0
    );
    expect(beforeAnchor.eligiblePartCount).toBe(path.length - 2);

    const endedPayload = payloadWithFacts([
      fact("ended", [textState("s", "Before", path[0]!.id), endState("e", path[1]!.id)])
    ]);
    const ended = factConsistencyPreflight(
      endedPayload,
      createStoryViewModel(endedPayload),
      "line",
      0
    );
    expect(ended.eligiblePartCount).toBe(1);

    const unscoped = factConsistencyPreflight(
      payloadWithFacts([fact("all", [textState("a", "Everywhere")])]),
      view,
      "line",
      0
    );
    expect(unscoped.eligiblePartCount).toBe(path.length);
  });

  test("keeps a 5,000-part and 128-Fact preflight bounded", () => {
    const partCount = 5_000;
    const template = source.payload.nodes.find(({ role }) => role !== "summary")
      ?? source.payload.nodes[0]!;
    const nodes = Array.from({ length: partCount }, (_, index) => ({
      ...template,
      id: "perf-" + index,
      parentId: index === 0 ? null : "perf-" + (index - 1),
      preview: "part",
      childCount: index + 1 < partCount ? 1 : 0,
      leafCount: 1,
      activeChildId: index + 1 < partCount ? "perf-" + (index + 1) : null
    }));
    const payload = {
      ...source.payload,
      nodes,
      activeRootId: "perf-0",
      facts: Array.from({ length: 128 }, (_, index) =>
        fact("perf-fact-" + index, [textState("perf-state-" + index, "A truth")])),
    };
    const started = performance.now();
    const preflight = factConsistencyPreflightForPart(
      payload,
      "perf-" + (partCount - 1),
      "line"
    );
    const elapsed = performance.now() - started;

    expect(preflight.totalPartCount).toBe(partCount);
    expect(preflight.eligiblePartCount).toBe(partCount);
    // The previous prefix Map per Fact would make this valid input quadratic
    // in path length and exceed this generous CI-independent bound.
    expect(elapsed).toBeLessThan(2_000);
  });

  test("marks a finding stale when its recorded take is no longer selected", () => {
    const current = source.payload.path[0]!.id;
    const finding: FactConsistencyFinding = {
      factId: "fact",
      factName: "Fact",
      partId: current,
      takeId: current,
      lineIndex: 0,
      quote: "Maren lit",
      statement: "the prose disagrees"
    };
    expect(factConsistencyFindingIsStale(source.payload, finding)).toBeFalse();
    expect(factConsistencyFindingIsStale(source.payload, { ...finding, takeId: "other-take" })).toBeTrue();
    expect(factConsistencyFindingIsStale({
      ...source.payload,
      path: source.payload.path.map((part, index) => index === 0
        ? { ...part, text: "rewritten prose" }
        : part)
    }, finding)).toBeTrue();
  });

  test("projects the backend run into Fact Names and a flat finding list", () => {
    const partId = source.payload.path[0]!.id;
    const payload = payloadWithFacts([fact("fact", [textState("state", "A truth")])]);
    const view = factConsistencyRunView({
      format: "1667-fact-consistency-run",
      schemaVersion: 1,
      runId: "run-1",
      scope: "story-line",
      anchor: { partId, takeId: partId },
      checkedAt: "2026-01-01T00:00:00.000Z",
      provider: { profile: "utility", preset: "custom", model: "test" },
      storyLineTakeIds: [partId],
      parts: [{
        partId,
        takeId: partId,
        findings: [{ fact_id: "fact", quote: "quoted", statement: "the prose differs" }],
        droppedFindings: 1,
        uncheckedReason: "provider retry limit"
      }],
      droppedFindings: 1
    }, payload, {
      selectedTakeIds: new Set(payload.path.map(({ id }) => id))
    });
    expect(view.scope).toBe("line");
    expect(view.checkedParts).toEqual([]);
    expect(view.uncheckedParts).toEqual([{
      partId,
      takeId: partId,
      lineIndex: 0,
      reason: "provider retry limit"
    }]);
    expect(view.findings[0]).toMatchObject({ factId: "fact", factName: "fact", partId });
    expect(view.rejectedCount).toBe(1);
  });

  test("resolves an unnamed Fact against an off-active finding take", () => {
    const partId = "p5-alt";
    const unnamed = fact("off-line", [textState(
      "off-line-state",
      "Traveler refuses shelter",
      partId
    )]);
    unnamed.name = undefined;
    const payload = {
      ...source.payload,
      facts: [unnamed]
    };
    const run = factConsistencyRunView({
      format: "1667-fact-consistency-run",
      schemaVersion: 1,
      runId: "run-off-active",
      scope: "story-line",
      anchor: { partId, takeId: partId },
      checkedAt: "2026-01-01T00:00:00.000Z",
      provider: { profile: "utility", preset: "custom", model: "test" },
      storyLineTakeIds: ["p1", "p2", "p3", "p4", partId],
      parts: [{
        partId,
        takeId: partId,
        findings: [{ fact_id: "off-line", quote: "Maren barred", statement: "the prose differs" }],
        droppedFindings: 0
      }],
      droppedFindings: 0
    }, payload, {
      selectedTakeIds: new Set(payload.path.map(({ id }) => id))
    });
    expect(run.findings[0]?.factName).toBe("Traveler refuses shelter");

    const surface = completedFactConsistency({
      scope: "line",
      totalPartCount: 1,
      eligiblePartCount: 1,
      skippedPartCount: 0,
      checkedParts: [{ partId, takeId: partId }]
    }, run);
    const rendered = frameText(renderFactConsistencyPanel(
      [], surface, payload, { width: 80, height: 24 }
    ).lines);
    expect(rendered).toContain("Traveler refuses shelter [off line]");
    expect(rendered).toContain("↵ view in MAP · f open Fact · esc close");
    expect(rendered).not.toContain("not selected");
  });

  test("requires two Ctrl+C requests while a Fact consistency run is hidden", () => {
    const state = initialState(source, false);
    state.factConsistency = {
      surface: runningFactConsistency({
        scope: "chapter",
        totalPartCount: 1,
        eligiblePartCount: 1,
        skippedPartCount: 0,
        checkedParts: []
      }),
      input: {
        storyId: state.payload.id,
        focusedPartId: state.payload.path[0]!.id,
        scope: "chapter"
      },
      returnMode: "NAV"
    };
    let repaints = 0;
    let quits = 0;
    const quit = () => { quits += 1; };

    requestQuitForState(state, () => { repaints += 1; }, quit);
    expect(quits).toBe(0);
    expect(repaints).toBe(1);
    expect(state.quitArmed).toBeTrue();
    expect(state.toast).toBe("Fact consistency check running · press Ctrl+C again to abandon check and quit");

    requestQuitForState(state, () => { repaints += 1; }, quit);
    expect(quits).toBe(1);
    expect(repaints).toBe(1);
  });
});

describe("Fact consistency surface", () => {
  const preflight = {
    scope: "chapter" as const,
    totalPartCount: 3,
    eligiblePartCount: 2,
    skippedPartCount: 1,
    // Fact States batch per part. Two eligible parts can still require three
    // model requests when one part has more than one request batch.
    requestCount: 3,
    requestCountExact: true,
    checkedParts: [
      { partId: "part-1", takeId: "take-1" },
      { partId: "part-2", takeId: "take-2" }
    ]
  };
  const run = {
    scope: "chapter" as const,
    checkedParts: preflight.checkedParts,
    uncheckedParts: [],
    rejectedCount: 2,
    findings: [{
      factId: "fact-1",
      factName: "Captain's eye color",
      partId: source.payload.path[0]!.id,
      takeId: source.payload.path[0]!.id,
      lineIndex: 0,
      quote: "Maren lit",
      statement: "Fact says blue; prose says green"
    }]
  };

  test("requires explicit confirmation before entering the running phase", () => {
    const confirmation = confirmingFactConsistency(preflight);
    const cancelled = factConsistencyKeyAction(confirmation, "escape");
    expect(cancelled.action).toEqual({ kind: "close" });
    expect(confirmation.phase).toBe("confirm");

    const confirmed = factConsistencyKeyAction(confirmation, "enter");
    expect(confirmed.action).toEqual({ kind: "confirm" });
    expect(confirmed.surface.phase).toBe("running");
  });

  test("moves through findings and Enter returns the story-line position", () => {
    const results = completedFactConsistency(preflight, run);
    expect(factConsistencyKeyAction(results, "up").surface).toMatchObject({ cursor: 0 });
    expect(factConsistencyKeyAction(results, "enter").action).toEqual({
      kind: "open",
      partId: source.payload.path[0]!.id
    });
    expect(factConsistencyKeyAction(runningFactConsistency(preflight), "escape").action)
      .toEqual({ kind: "close" });
    expect(emptyFactConsistencyRun(preflight).findings).toHaveLength(0);
  });

  test("renders confirmation and completed findings with the required fields", () => {
    const confirmation = frameText(renderFactConsistencyPanel(
      [], confirmingFactConsistency(preflight), source.payload, { width: 100, height: 24 }
    ).lines);
    expect(confirmation).toContain("check chapter against Facts");
    expect(confirmation).toContain("2 eligible parts");
    expect(confirmation).toContain("3 model requests");
    expect(confirmation).toContain("1 skipped (no applicable Fact State)");
    expect(confirmation).toContain("read-only · no prose changes");
    expect(confirmation).toContain("esc cancel");

    const pluralRequests = frameText(renderFactConsistencyPanel(
      [], confirmingFactConsistency({ ...preflight, requestCount: 4 }), source.payload,
      { width: 100, height: 24 }
    ).lines);
    expect(pluralRequests).toContain("4 model requests");

    const lineConfirmation = frameText(renderFactConsistencyPanel(
      [], confirmingFactConsistency({ ...preflight, scope: "line" }), source.payload,
      { width: 100, height: 24 }
    ).lines);
    expect(lineConfirmation).toContain("larger checks can take time · runs in background");

    const completed = frameText(renderFactConsistencyPanel(
      [], completedFactConsistency(preflight, run), source.payload, { width: 100, height: 24 }
    ).lines);
    expect(completed).toContain("fact consistency · chapter · 1 finding");
    expect(completed).toContain("findings · 1–1/1 · 2 rejected");
    expect(completed).toContain("Fact Name: Captain's eye color");
    expect(completed).toContain("exact quote: Maren lit");
    expect(completed).toContain("contradiction: Fact says blue; prose says green");
    expect(completed).toContain("↵ focus part");
  });

  test("keeps the results title and counts readable on a narrow panel", () => {
    const rendered = frameText(renderFactConsistencyPanel(
      [], completedFactConsistency(preflight, run), source.payload, { width: 44, height: 24 }
    ).lines);
    const title = rendered.split("\n").find((line) => line.includes("┏━"));
    expect(title).toContain("fact consistency · chapter");
    expect(title).not.toContain("· 1");
    expect(rendered).toContain("findings · 1–1/1 · 2 rejected");
  });

  test("keeps wrapped confirmation hints indented inside the panel", () => {
    const rendered = frameText(renderFactConsistencyPanel(
      [], confirmingFactConsistency(preflight), source.payload, { width: 44, height: 24 }
    ).lines);
    const hintLines = rendered.split("\n").filter((line) => line.includes("press Enter")
      || line.includes("to check") || line.includes("Escape") || line.includes("to cancel"));
    expect(hintLines.length).toBeGreaterThan(1);
    expect(hintLines.every((line) => /^\s*┃ {3}/u.test(line))).toBeTrue();
  });

  test("keeps the batched request count readable on a narrow confirmation", () => {
    const rendered = frameText(renderFactConsistencyPanel(
      [], confirmingFactConsistency(preflight), source.payload, { width: 44, height: 24 }
    ).lines);
    expect(rendered).toContain("2 eligible parts");
    expect(rendered).toContain("3 model");
    expect(rendered).toContain("requests · 1 skipped");
  });

  test("keeps unchecked reasons visible and does not let a long quote hide the statement", () => {
    const uncheckedRun = {
      ...run,
      uncheckedParts: [
        ...Array.from({ length: 12 }, (_, index) => ({
          partId: `part-${index + 3}`,
          takeId: `take-${index + 3}`,
          lineIndex: index + 2,
          reason: index === 0
            ? "missing completion marker"
            : index === 1 ? "request size limit" : "provider retry failed"
        }))
      ],
      findings: [{
        ...run.findings[0]!,
        quote: "a very long exact quote that wraps across many rows and should be capped",
        statement: "The Fact says blue, but this prose says green, so the selected take contradicts the saved state."
      },
      ...Array.from({ length: 4 }, (_, index) => ({
        ...run.findings[0]!,
        factName: `Fact ${index + 2}`,
        quote: `quoted prose ${index + 2}`
      }))]
    };
    const rendered = frameText(renderFactConsistencyPanel(
      [], completedFactConsistency(preflight, uncheckedRun), source.payload, { width: 72, height: 24 }
    ).lines);
    expect(rendered).toContain("unchecked parts · 12");
    expect(rendered).toContain("! story part 3 · missing completion marker");
    expect(rendered).toContain("! story part 4 · request size limit");
    expect(rendered).toContain("unchecked parts not shown");
    expect(rendered).toContain("findings · 1–3/5");
    expect(rendered).toContain("contradiction: The Fact says blue");
    expect(rendered).toContain("f open Fact");
  });

  test("reports unchecked overflow instead of clipping it silently", () => {
    const uncheckedRun = {
      ...run,
      uncheckedParts: Array.from({ length: 12 }, (_, index) => ({
        partId: `part-${index}`,
        takeId: `take-${index}`,
        lineIndex: index,
        reason: `provider retry failed ${index}`
      }))
    };
    const rendered = frameText(renderFactConsistencyPanel(
      [], completedFactConsistency(preflight, uncheckedRun), source.payload, { width: 80, height: 20 }
    ).lines);
    expect(rendered).toContain("unchecked parts · 12");
    expect(rendered).toContain("unchecked parts not shown");
    expect(rendered).toContain("selected finding");
    expect(rendered).toContain("contradiction:");
  });

  test("warns when no parts were checked and keeps narrow unchecked reasons readable", () => {
    const uncheckedRun: FactConsistencyRun = {
      scope: "chapter",
      checkedParts: [],
      uncheckedParts: [
        { partId: "part-1", takeId: "take-1", lineIndex: 0, reason: "missing completion marker" },
        { partId: "part-2", takeId: "take-2", lineIndex: 1, reason: "request size limit" }
      ],
      findings: [],
      rejectedCount: 0
    };
    const rendered = frameText(renderFactConsistencyPanel(
      [],
      completedFactConsistency({
        ...preflight,
        totalPartCount: 2,
        eligiblePartCount: 0,
        skippedPartCount: 0,
        checkedParts: []
      }, uncheckedRun),
      source.payload,
      { width: 44, height: 24 }
    ).lines);
    expect(rendered).toContain("⚠ 2 unchecked · none checked");
    expect(rendered).not.toContain("no contradictions found");
    expect(rendered).toContain("missing");
    expect(rendered).toContain("completion");
    expect(rendered).toContain("request size");
    expect(rendered).toContain("esc close");
    expect(rendered).not.toContain("f open Fact");
  });

  test("explains an empty preflight without offering a check action", () => {
    const rendered = frameText(renderFactConsistencyPanel(
      [], confirmingFactConsistency({
        ...preflight,
        eligiblePartCount: 0,
        skippedPartCount: 3,
        checkedParts: []
      }), source.payload, { width: 100, height: 24 }
    ).lines);
    expect(rendered).toContain("nothing to check");
    expect(rendered).toContain("esc cancel");
    expect(rendered).not.toContain("↵ check");
  });
});

test("Fact consistency commands are contextual and chapter is the suggestion", () => {
  const context = commandContext(source.payload, {
    connectionDown: false,
    requestActive: false,
    canRewriteSelection: false
  });
  expect(commandMatches("", false, context)[0]?.command.id)
    .toBe("check-chapter-against-facts");
  expect(commandMatches("check story line", false, context)
    .some(({ command }) => command.id === "check-story-line-against-facts"))
    .toBeTrue();
  const withoutFacts = commandContext({ ...source.payload, facts: [] }, {
    connectionDown: false,
    requestActive: false,
    canRewriteSelection: false
  });
  expect(commandMatches("fact consistency", false, withoutFacts)).toHaveLength(0);
  const withFindings = commandContext({
    ...source.payload,
    hasFactConsistencyRun: true
  }, {
    connectionDown: false,
    requestActive: false,
    canRewriteSelection: false
  });
  expect(commandMatches("", false, withFindings)[0]?.command.id)
    .toBe("show-fact-findings");
});
