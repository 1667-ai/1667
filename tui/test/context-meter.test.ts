import { describe, expect, test } from "bun:test";
import { AI_1667_VERSION_TAG } from "../../shared/build-identity.js";
import { dispatch, initialState } from "../src/app.js";
import { createDemoController, demoAppSource } from "../src/demo.js";
import {
  buildRailModel,
  contextSeverity,
  gaugeFill,
  formatTokensEstimate,
  requestWindow,
  type RailModel
} from "../src/rail.js";
import type { HitRows } from "../src/hit.js";
import { nextRequestEstimate, type NextRequestContext } from "../src/request-projection.js";
import { nextRequestContext } from "../src/request-context.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { contextMeterLines } from "../src/screens/story/context-meter.js";
import { renderFactsRail } from "../src/screens/story/facts-rail.js";
import { frameText, plainLine, segment, sliceFrame, splitFrame, visibleWidth } from "../src/screens/story/frame.js";
import { createWrapCache } from "../src/wrap.js";
import { deriveStoryFrameLayout } from "../src/story-frame-layout.js";
import { estimateTokens } from "../../shared/tokens.js";
import { summaryNodeInstruction } from "../../shared/chapters.js";
import { formatFactsMessage } from "../../shared/story-facts.js";
import { continuationPlan, DEFAULT_INSTRUCTION } from "../../shared/continuation-plan.js";
import { renderPromptPlan } from "../../shared/prompt-plan.js";
import { assertPromptReadyStoryPayload } from "../../shared/types.js";
import { continuationIntent } from "../src/continuation-intent.js";

function request(
  systemPrompt: string,
  targetId: string | null,
  instruction = "",
  assistantPrefill = true,
  retakeNodeId: string | null = null
): NextRequestContext {
  const base = { systemPrompt, instruction, assistantPrefill };
  return retakeNodeId === null
    ? { ...base, operation: "continue", targetId }
    : { ...base, operation: "retake", targetId: retakeNodeId };
}

/** The meter as the rail actually paints it, at the real split geometry. */
function railLines(model: RailModel, expanded = false, height = 16) {
  return railFrame(model, expanded, height).lines;
}

function railFrame(model: RailModel, expanded: boolean, height: number) {
  const layout = deriveStoryFrameLayout(140, demoAppSource().config);
  const hits: HitRows = Array.from({ length: height }, () => null);
  const painted = renderFactsRail(
    Array.from({ length: height }, () => [segment(" ".repeat(layout.pageWidth))]), model,
    hits, height, layout, expanded
  );
  return {
    lines: sliceFrame(
      painted,
      layout.pageWidth,
      (layout.railRight ?? layout.fullWidth) - layout.pageWidth
    ),
    hits
  };
}

describe("honest next-request context meter", () => {
  test("never invents a percentage or a bar when the model window is unknown", () => {
    const payload = createDemoController().payload();
    const next = request("Write vivid prose.", payload.path.at(-1)!.id);
    const model = buildRailModel(payload, "", null, nextRequestEstimate(payload, next));
    const collapsed = frameText(railLines(model));
    const expanded = frameText(railLines(model, true));

    expect(collapsed).toContain(`next request  ~${model.contextTokens.toLocaleString("en-US")} tokens`);
    expect(collapsed).toContain("set context window · settings (,)");
    // Category totals are still knowable without a window; only bars are not.
    expect(expanded).toContain("voice");
    for (const text of [collapsed, expanded]) {
      // No window sizes no bar: the track and the ink are the same cell now,
      // so the absence to assert is any run of gauge cells at all.
      expect(text).not.toContain("▮▮");
      expect(/\d+%/.test(text)).toBeFalse();
    }
  });

  test("reports free space and a breakdown whose categories equal the estimate", () => {
    const payload = createDemoController().payload();
    const systemPrompt = "Keep voice close, concrete, and restrained.";
    const next = request(systemPrompt, payload.path.at(-1)!.id);
    const estimate = nextRequestEstimate(payload, next);
    const window = estimate.tokens + 5_300;
    const model = buildRailModel(payload, "", window, estimate);
    const values = Object.values(model.breakdown);
    const collapsed = frameText(railLines(model));

    expect(values.reduce((sum, value) => sum + value, 0)).toBe(model.contextTokens);
    expect(model.window?.free).toBe(5_300);
    expect(collapsed).toContain(`next request  ${formatTokensEstimate(model.contextTokens)} / ${formatTokensEstimate(window).replace("~", "")}`);
    expect(collapsed).toContain("5.3k free");
    expect(Object.keys(model.breakdown)).toEqual(["voice", "facts", "recent", "summary"]);
  });

  test("formats large request values with bounded k/m/b/t units", () => {
    expect(formatTokensEstimate(999)).toBe("~999");
    expect(formatTokensEstimate(1_250)).toBe("~1.3k");
    expect(formatTokensEstimate(1_250_000)).toBe("~1.3m");
    expect(formatTokensEstimate(1_250_000_000)).toBe("~1.3b");
    expect(formatTokensEstimate(1.25e12)).toBe("~1.3t");
    // Nothing a settings file can hold prints digits a rail column cannot.
    expect(formatTokensEstimate(1e30)).toBe("~999t+");
    const huge = frameText(railLines({
      ...buildRailModel(createDemoController().payload(), "", 1e30,
        nextRequestEstimate(createDemoController().payload(),
          request("Write vivid prose.", null))),
      contextTokens: 1e28
    }));
    expect(huge).toContain("t+");
    expect(huge).toContain("free");
  });

  test("matches the server plan for append, focused-seam, and prompted-retake drafts", () => {
    const payload = createDemoController().payload();
    const systemPrompt = "Keep voice close, concrete, and restrained.";
    const facts = formatFactsMessage(payload.facts);
    const retake = payload.path.at(-1)!;
    const retakeParentIndex = payload.path.findIndex((part) => part.id === retake.parentId);
    const cases = [
      {
        request: request(systemPrompt, payload.path.at(-1)!.id),
        parts: payload.path,
        instruction: DEFAULT_INSTRUCTION,
        appendLast: true,
        assistantPrefill: true
      },
      {
        request: request(systemPrompt, payload.path.at(-2)!.id, "Turn the compass toward the sea.", false),
        parts: payload.path.slice(0, -1),
        instruction: "Turn the compass toward the sea.",
        appendLast: false,
        assistantPrefill: false
      },
      {
        request: request(systemPrompt, retake.id, "Make the lantern answer Maren.", true, retake.id),
        parts: payload.path.slice(0, retakeParentIndex + 1),
        instruction: "Make the lantern answer Maren.",
        appendLast: false,
        assistantPrefill: true
      },
      {
        request: request(systemPrompt, retake.id, "", true, retake.id),
        parts: payload.path.slice(0, retakeParentIndex + 1),
        instruction: DEFAULT_INSTRUCTION,
        appendLast: false,
        assistantPrefill: true
      }
    ] as const;
    const promptNodes = payload.nodes.flatMap((node) => node.text === undefined ? [] : [{
      ...node,
      text: node.text,
      instruction: node.instruction ?? summaryNodeInstruction(payload.title)
    }]);

    for (const item of cases) {
      const messages = renderPromptPlan(continuationPlan(
        systemPrompt, facts, item.parts, item.instruction, item.appendLast,
        item.assistantPrefill, "ct-00000000", payload.chapterBreaks, promptNodes
      ).prompt);
      const expected = messages.reduce((sum, message) => sum + estimateTokens(message.content) + 4, 0);
      const estimate = nextRequestEstimate(payload, item.request);
      expect(estimate.tokens).toBe(expected);
      expect(Object.values(estimate.breakdown).reduce((sum, value) => sum + value, 0)).toBe(expected);
    }
  });

  test("models a chapter-boundary Continue as a new child with full prior context", () => {
    const payload = structuredClone(createDemoController().payload());
    const leaf = payload.path.at(-1)!;
    payload.chapterBreaks.push({
      id: "break-after-leaf",
      parentPartId: leaf.id,
      title: "Beyond the Storm",
      createdAt: "1667-07-19T16:09:00.000Z"
    });

    const intent = continuationIntent(payload, leaf.id, "");
    expect(intent.requestAppend).toBeTrue();
    expect(intent.appendLast).toBeFalse();
    expect(intent.parentId).toBe(leaf.id);
    expect(intent.contextParts.map((part) => part.id)).toEqual(payload.path.map((part) => part.id));
  });

  test("rejects a non-provider-ready chapter summary at the protocol boundary", () => {
    const payload = createDemoController().payload();
    const production = {
      ...payload,
      nodes: payload.nodes.map((node) => node.role === "summary" && node.chapterBreakId !== undefined
        ? { ...node, instruction: summaryNodeInstruction(payload.title) }
        : node)
    };
    const legacy = structuredClone(production) as unknown;
    const legacyNodes = (legacy as { nodes: Array<Record<string, unknown>> }).nodes;
    const summary = legacyNodes.find((node) => node.chapterBreakId !== undefined)!;
    delete summary.instruction;
    let error = "";
    try { assertPromptReadyStoryPayload(legacy); } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    expect(error).toContain("not provider-ready");
    assertPromptReadyStoryPayload(production);

    const withLegacySummary = structuredClone(production);
    const ordinary = withLegacySummary.nodes.find((node) => node.chapterBreakId === undefined)!;
    ordinary.role = "summary";
    assertPromptReadyStoryPayload(withLegacySummary);
  });

  test("uses lantern, amber, and danger at the exact meter thresholds", () => {
    expect(contextSeverity(requestWindow(790, 1_000))).toBe("normal");
    expect(contextSeverity(requestWindow(800, 1_000))).toBe("warning");
    expect(contextSeverity(requestWindow(1_000, 1_000))).toBe("over");
    expect(contextSeverity(requestWindow(500, null))).toBe("normal");
    // A window of zero is no window, not a request that overflows it.
    expect(contextSeverity(requestWindow(500, 0))).toBe("normal");

    const payload = createDemoController().payload();
    const estimate = nextRequestEstimate(payload, request("Write vivid prose.", payload.path.at(-1)!.id));
    const banded = (fill: number): Array<string | undefined> => {
      const model = { ...buildRailModel(payload, "", 1_000, estimate), window: requestWindow(fill * 1_000, 1_000) };
      const parts = railLines(model).flat();
      return [
        parts.find((part) => part.text.startsWith("▮"))?.role,
        parts.find((part) => part.text.includes(" / "))?.role
      ];
    };

    // Doc 12a: the gauge carries the band; an untroubled value stays sepia and
    // only the amber and ember bands reach the number.
    expect(banded(0.5)).toEqual(["focus / accent", "summary"]);
    expect(banded(0.85)).toEqual(["context warning", "context warning"]);
    expect(banded(1.2)).toEqual(["danger", "danger text"]);

    // Collapsed and expanded state the free readout the same way, in the same
    // band — it is one sentence rendered in two places.
    const tight = { ...buildRailModel(payload, "", 1_000, estimate), window: requestWindow(850, 1_000) };
    for (const expanded of [false, true]) {
      const free = railLines(tight, expanded).flat().find((part) => part.text.includes("free"));
      expect(free?.role).toBe("context warning");
    }
    expect(frameText(railLines({
      ...buildRailModel(payload, "", 1_000, estimate), window: requestWindow(1_200, 1_000)
    }))).toContain("near full");
  });

  test("a gauge never reads empty or full until the fill exactly is", () => {
    expect(gaugeFill(0, 20)).toBe(0);
    expect(gaugeFill(0.001, 20)).toBe(1);
    expect(gaugeFill(0.999, 20)).toBe(19);
    expect(gaugeFill(1, 20)).toBe(20);
    expect(gaugeFill(1.5, 20)).toBe(20);
    expect(gaugeFill(0.5, 0)).toBe(0);
  });

  test("wide rail exposes a clickable expanded breakdown without adding other cards", () => {
    const source = demoAppSource();
    const state = initialState(source, true);
    state.contextMeterExpanded = true;
    const frame = renderStoryScreen(state, { width: 140, height: 36 });
    const text = frameText(frame.lines);

    // The breakdown replaces the collapsed three lines rather than stacking
    // under them: one meter, two states, one place in the rail.
    expect(text).toContain("context · next request");
    expect(text).not.toContain("next request  ~");
    for (const category of ["voice", "facts", "recent", "summary"]) expect(text).toContain(`▮ ${category}`);
    expect(frame.derived.hitRows.some((row) => row?.overrides?.some((hit) =>
      hit.target.kind === "action" && hit.target.action === "toggle-context-meter"))).toBeTrue();
    // A 2.6% request inks one cell of the 33 and leaves the rest visibly free.
    // Ink and track share a glyph, so the free run is the dimmed one.
    const gauge = frame.lines.find((line) =>
      line.some((part) => part.text.includes("▮") && part.role === "dimmed page")
      && line.some((part) => part.text.includes("▮") && part.role !== "dimmed page"))!;
    expect(gauge).toBeDefined();
    expect(frameText(renderStoryScreen(initialState(demoAppSource(), true), { width: 140, height: 36 }).lines))
      .not.toContain("context · next request");
  });

  test("right-edge breathing space stays visually blank and inert", () => {
    const source = demoAppSource();
    const layout = deriveStoryFrameLayout(140, source.config);
    const frame = renderStoryScreen(initialState(source, true), { width: 140, height: 36 });
    const railRight = layout.railRight;

    expect(railRight === null).toBeFalse();
    if (railRight === null) throw new Error("wide layout requires a facts rail");
    for (const line of frame.lines) expect(plainLine(line).endsWith("  ")).toBeTrue();
    for (const row of frame.derived.hitRows) {
      if (row === null) continue;
      const regions = [row, ...row.overrides ?? []];
      for (const region of regions) {
        if (region.left >= layout.pageWidth) expect(region.right <= railRight).toBeTrue();
      }
    }
  });

  test("expanded high fill uses the real rail width and retains a free cell", () => {
    const source = demoAppSource();
    const payload = source.payload;
    const next = request("Write vivid prose.", payload.path.at(-1)!.id);
    const model = {
      ...buildRailModel(payload, "", 1_000, nextRequestEstimate(payload, next)),
      contextTokens: 990,
      window: requestWindow(990, 1_000),
      breakdown: { voice: 300, facts: 200, recent: 300, summary: 190 }
    };
    const rail = railLines(model, true);
    const bar = rail.find((line) => plainLine(line).includes("▮▮"))!;
    const text = plainLine(bar);

    expect(visibleWidth(text)).toBe(35);
    expect(text.endsWith("▮".repeat(33))).toBeTrue();
    // The last cell stays free, which now reads as the dimmed role rather than
    // a different glyph.
    expect(bar.at(-1)!.role).toBe("dimmed page");
    expect(bar.at(-1)!.text).toBe("▮");
    // The inked run carries the four category colours; the free cell is the
    // dimmed one asserted above.
    expect(new Set(bar
      .filter((part) => part.text.includes("▮") && part.role !== "dimmed page")
      .map((part) => part.role)))
      .toEqual(new Set(["context voice", "context facts", "context recent", "context summary"]));
  });

  test("a long unknown-window estimate never clips the way to set a window", () => {
    const payload = createDemoController().payload();
    const model = {
      ...buildRailModel(payload, "", null,
        nextRequestEstimate(payload, request("Write vivid prose.", payload.path.at(-1)!.id))),
      contextTokens: 1_234_567_890
    };

    for (const [expanded, value] of [[false, "~1.2b tokens"], [true, "~1,234,567,890 tokens"]] as const) {
      const rail = railLines(model, expanded);
      const text = frameText(rail);
      expect(text).toContain("set context window · settings (,)");
      // Beside the `next request` label the exact count no longer fits, so it
      // yields to the scaled form rather than losing `tokens` off the rail
      // edge; the expanded totals line has the width to spell it out.
      expect(text).toContain(value);
      for (const line of rail) expect(visibleWidth(plainLine(line))).toBe(35);
    }
  });

  test("a short rail never trades all of its facts away", () => {
    const payload = createDemoController().payload();
    const model = buildRailModel(payload, "", 8_000,
      nextRequestEstimate(payload, request("Write vivid prose.", payload.path.at(-1)!.id)));
    const seen = (height: number, expanded: boolean) => {
      const { lines: rail, hits } = railFrame(model, expanded, height);
      const text = frameText(rail);
      for (const line of rail) expect(visibleWidth(plainLine(line))).toBe(35);
      return {
        // Counted from the hit map, so this measures facts the reader can
        // actually click rather than a spacing pattern in the painted text.
        facts: new Set(hits.flatMap((row) => row === null
          ? [] : [row.target, ...row.overrides?.map((override) => override.target) ?? []])
          .flatMap((target) => target.kind === "fact" ? [target.index] : [])).size,
        meter: rail.filter((line) => /free|next request|─{12}/.test(plainLine(line))).length,
        header: text.includes("facts · 5"),
        expanded: text.includes("context · next request"),
        request: text.includes("next request  ~953 / 8k") || text.includes("~953 / 8k · 7k free")
      };
    };

    // The meter is what a rail keeps when it can keep only one thing, and the
    // rail names itself as soon as it can afford to.
    expect(seen(2, true)).toMatchObject({ facts: 0, header: false, expanded: false, request: true });
    expect(seen(5, true)).toMatchObject({ facts: 0, header: true, expanded: false, request: true });

    let collapsed = seen(4, false);
    for (let height = 5; height <= 20; height += 1) {
      const current = seen(height, false);
      // Growing the pane may never take content away — not a fact, not the
      // header, and not a row of the meter either.
      expect(current.facts >= collapsed.facts).toBeTrue();
      expect(current.meter >= collapsed.meter).toBeTrue();
      expect(current.header || !collapsed.header).toBeTrue();
      collapsed = current;

      // Opening the breakdown costs fact rows — it may never cost all of them.
      const expanded = seen(height, true);
      expect(expanded.request).toBeTrue();
      if (expanded.expanded) expect(expanded.facts).toBeGreaterThan(0);
    }
    expect(seen(20, true).expanded).toBeTrue();
  });

  test("a short meter sheds decoration before it sheds meaning", () => {
    const payload = createDemoController().payload();
    const model = {
      ...buildRailModel(payload, "", 8_000,
        nextRequestEstimate(payload, request("Write vivid prose.", payload.path.at(-1)!.id))),
      chapterNotice: "ch 12 · summarize frees ~12.3k"
    };
    const meter = (rows: number) => contextMeterLines(model, false, rows).map((line) => plainLine(line).trim());

    expect(meter(4)).toEqual([
      "─".repeat(33), "next request  ~953 / 8k", `▮▮${"▮".repeat(18)}      7k free`,
      "ch 12 · summarize frees ~12.3k"
    ]);
    // The rule is decoration; the gauge repeats what the numbers already say.
    // Both go before the chapter's fix, which is the one actionable line here.
    expect(meter(3)).toEqual([
      "next request  ~953 / 8k", `▮▮${"▮".repeat(18)}      7k free`, "ch 12 · summarize frees ~12.3k"
    ]);
    expect(meter(2)).toEqual(["next request  ~953 / 8k", "ch 12 · summarize frees ~12.3k"]);
    expect(meter(1)).toEqual(["next request  ~953 / 8k"]);
    expect(meter(0)).toEqual([]);

    // With no window there is no gauge to shed, and the way to set one is the
    // line that outlives the rule.
    const unknown = (rows: number) =>
      contextMeterLines({ ...model, window: null, chapterNotice: null }, false, rows)
        .map((line) => plainLine(line).trim());
    expect(unknown(2)).toEqual(["next request  ~953 tokens", "set context window · settings (,)"]);
  });

  test("relevant CJK facts keep their cell-aligned tag at the rail edge", () => {
    const source = demoAppSource();
    const payload = structuredClone(source.payload);
    payload.facts = [{
      id: "fact-cjk",
      tag: "人物界",
      text: "玲珑守望者守望者守望者守望者\nShe waits beside the eastern gate.",
      createdAt: "1667-07-19T16:09:00.000Z",
      updatedAt: "1667-07-19T16:09:00.000Z"
    }];
    const next = request("Write vivid prose.", payload.path.at(-1)!.id);
    const model = buildRailModel(
      payload, "玲珑守望者守望者守望者守望者 returns", 10_000,
      nextRequestEstimate(payload, next)
    );
    const height = 14;
    const layout = deriveStoryFrameLayout(140, source.config);
    const lines = renderFactsRail(
      Array.from({ length: height }, () => [segment(" ".repeat(layout.pageWidth))]), model,
      Array.from({ length: height }, () => null), height, layout
    );
    const rail = sliceFrame(
      lines,
      layout.pageWidth,
      (layout.railRight ?? layout.fullWidth) - layout.pageWidth
    );
    const fact = rail.find((line) => plainLine(line).includes("玲珑"))!;

    expect(model.facts[0]?.relevant).toBeTrue();
    expect(visibleWidth(plainLine(fact))).toBe(35);
    expect(plainLine(fact).startsWith("│ ▸ 玲珑")).toBeTrue();
    expect(plainLine(fact).endsWith("人物界")).toBeTrue();
  });

  test("demo facts expand a focused name while unrelated facts stay one line", () => {
    const source = demoAppSource();
    const state = initialState(source, true);
    const layout = deriveStoryFrameLayout(140, state.config);
    const rail = splitFrame(
      renderStoryScreen(state, { width: 140, height: 36 }).lines,
      layout.pageWidth
    )[1];
    const text = frameText(rail);

    expect(text).toContain("▸ Maren");
    expect(text).toContain("Keeps the lantern-house and");
    expect(text).toContain("  Ashe");
    expect(text).not.toContain("Carries a brass compass");
  });

  test("keeps every expanded category total inside the fixed-width rail", () => {
    const source = demoAppSource();
    const payload = source.payload;
    const next = request("Write vivid prose.", payload.path.at(-1)!.id);
    const estimate = nextRequestEstimate(payload, next);
    const model = {
      ...buildRailModel(payload, "", 10_000, estimate),
      contextTokens: 4_936,
      window: requestWindow(4_936, 10_000),
      breakdown: { voice: 1_234, facts: 1_234, recent: 1_234, summary: 1_234 }
    };
    const rail = railLines(model, true);
    const text = frameText(rail);

    expect(text).toContain("▮ voice   ~1.2k   ▮ facts   ~1.2k");
    expect(text).toContain("▮ recent  ~1.2k   ▮ summary ~1.2k");
    for (const line of rail) expect(visibleWidth(plainLine(line))).toBe(35);

    // A category that rounds up into the next unit must take the unit with it,
    // or `~10.0k`/`~1000k` would push the legend past the rail edge.
    const rounded = frameText(railLines({
      ...model,
      contextTokens: 2_019_997,
      window: requestWindow(2_019_997, 4_000_000),
      breakdown: { voice: 9_999, facts: 999_999, recent: 1_000_000, summary: 9_999 }
    }, true));

    expect(rounded).toContain("▮ voice    ~10k   ▮ facts     ~1m");
    expect(rounded).toContain("▮ recent    ~1m   ▮ summary  ~10k");

    // Nothing a settings file can hold may widen the legend, however absurd —
    // or lose its unit to the truncation that keeps it narrow.
    const offScale = railLines({
      ...model,
      contextTokens: 4e15,
      window: requestWindow(4e15, 8e15),
      breakdown: { voice: 1e15, facts: 1e15, recent: 1e15, summary: 1e15 }
    }, true);
    for (const line of offScale) expect(visibleWidth(plainLine(line))).toBe(35);
    expect(frameText(offScale)).toContain("▮ summary 999t+");
    expect(frameText(offScale)).not.toContain("…");
  });

  test("chapter recommendation preserves both chapter and savings in the fixed rail", () => {
    const source = demoAppSource();
    const payload = source.payload;
    const estimate = nextRequestEstimate(payload, request("Write vivid prose.", payload.path.at(-1)!.id));
    const model = {
      ...buildRailModel(payload, "", 10_000, estimate),
      chapterNotice: "ch 12 · summarize frees ~12.3k"
    };
    const height = 14;
    const layout = deriveStoryFrameLayout(140, source.config);
    const painted = renderFactsRail(
      Array.from({ length: height }, () => [segment(" ".repeat(layout.pageWidth))]), model,
      Array.from({ length: height }, () => null), height, layout
    );
    const rail = sliceFrame(
      painted,
      layout.pageWidth,
      (layout.railRight ?? layout.fullWidth) - layout.pageWidth
    );
    const notice = rail.find((line) => plainLine(line).includes("summarize"));

    expect(notice).toBeDefined();
    expect(plainLine(notice!)).toContain("ch 12 · summarize frees ~12.3k");
    expect(visibleWidth(plainLine(notice!))).toBe(35);
  });

  test("unknown windows omit both collapsed and expanded gauges", () => {
    const source = demoAppSource();
    source.settings = { ...source.settings, contextWindow: null };
    const state = initialState(source, true);
    state.contextMeterExpanded = true;
    const text = frameText(renderStoryScreen(state, { width: 140, height: 36 }).lines);

    expect(text).not.toContain("▯");
    expect(text).not.toContain("▮▮");
    expect(/\d+%/.test(text)).toBeFalse();
    expect(text).toContain("▮ voice");
    expect(text).toContain("▮ recent");
    expect(text).toContain("set context window · settings (,)");
  });

  test("meter clicks toggle while the visible page is composing", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    state.mode = "COMPOSE";

    await dispatch(
      { action: "toggle-context-meter" }, state, source, createWrapCache(),
      () => undefined, async () => undefined, () => undefined
    );
    expect(state.contextMeterExpanded).toBeTrue();
  });

  test("the full rail follows compose accent and opt-in focus dim", () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    state.mode = "COMPOSE";
    const layout = deriveStoryFrameLayout(140, state.config);
    // The status bar spans the whole frame beneath the split, so the rail is
    // every right-hand row above it.
    const railRoles = () => splitFrame(
      renderStoryScreen(state, { width: 140, height: 36 }).lines.slice(0, -1), layout.pageWidth
    )[1].flat().filter((part) => part.text.trim().length > 0).map((part) => part.role);

    expect(railRoles()).toContain("compose accent");
    expect(railRoles()).not.toContain("focus / accent");
    state.contextWindow = 1_000;
    state.contextMeterExpanded = true;
    expect(railRoles()).toContain("context warning");
    expect(railRoles()).toContain("compose accent");
    expect(railRoles()).not.toContain("accent · deep");
    // The demo request has no separate voice slice; every nonzero category
    // keeps its meter identity instead of collapsing into compose accent.
    for (const role of ["context facts", "context recent", "context summary"] as const) {
      expect(railRoles()).toContain(role);
    }
    state.config = { ...state.config, composeFocus: "on" };
    expect(new Set(railRoles())).toEqual(new Set(["dimmed page"]));
  });

  test("80-column status retains the complete next-request value", () => {
    const source = demoAppSource();
    const state = initialState(source, true);
    const estimate = nextRequestEstimate(state.payload, nextRequestContext(state));
    const expected = `next ${formatTokensEstimate(estimate.tokens)}/${formatTokensEstimate(state.contextWindow!).replace("~", "")}`;
    const frame = renderStoryScreen(state, { width: 80, height: 24 });
    const status = plainLine(frame.lines.at(-1)!);

    expect(status).toContain("NAV   the lantern keeper · ⚑ canon-storm · ¶ 12/13 · 3/5");
    expect(status).toContain(expected);
    expect(status.slice(status.indexOf("next"))).not.toContain("…");
  });

  test("status identity uses each tag label's glyph and semantic role", () => {
    const variants = [
      ["", "⚑", "prose · dim"],
      ["Canon", "⚑", "tag · canon"],
      ["Alt", "⚑", "tag · alt"],
      ["Draft", "~", "tag · draft"],
      ["Discarded", "✕", "tag · discarded"],
      ["Summary", "◈", "summary"]
    ] as const;

    for (const [label, glyph, role] of variants) {
      const state = initialState(demoAppSource(), true);
      const leafId = state.payload.path.at(-1)!.id;
      const tag = state.payload.tags.find((item) => item.nodeId === leafId)!;
      tag.status = label;
      const status = renderStoryScreen(state, { width: 120, height: 36 }).lines.at(-1)!;
      const identity = status.find((part) => part.text.includes(`${glyph} ${tag.name}`));

      expect(identity?.role).toBe(role);
    }
  });

  test("over-window color belongs only to status segments that show the request", () => {
    const state = initialState(demoAppSource(), true);
    state.contextWindow = 1;

    const wide = renderStoryScreen(state, { width: 120, height: 36 }).lines.at(-1)!;
    expect(wide.find((part) => part.text.includes("local ✓"))?.role).toBe("chrome");

    const compact = renderStoryScreen(state, { width: 80, height: 24 }).lines.at(-1)!;
    expect(compact.find((part) => part.text.includes("next "))?.role).toBe("danger text");
  });

  test("NAV prune confirmation reserves its exact action suffix at 80 and 100 columns", () => {
    const state = initialState(demoAppSource(), true);
    state.prune = {
      kind: "subtree",
      nodeId: state.payload.path.at(-1)!.id,
      part: 13,
      take: 3,
      takeCount: 5,
      parts: 123,
      lines: 42,
      tags: [
        { name: "canon-storm", status: "Canon" },
        { name: "a-very-long-tag-name", status: "Draft" }
      ]
    };
    const expected = new Map([
      [80, " PRUNE   ⚑ canon-storm, ~ a-very-long-tag-name · ¶ 13 … · d confirms · esc keeps"],
      [100, " PRUNE   ⚑ canon-storm, ~ a-very-long-tag-name · ¶ 13 take 3/5 → 123 parts… · d confirms · esc keeps"]
    ]);

    for (const [width, text] of expected) {
      const status = plainLine(renderStoryScreen(state, { width, height: 24 }).lines.at(-1)!);
      expect(visibleWidth(status)).toBe(width);
      expect(status.trimEnd()).toBe(text);
      expect(status.trimEnd().endsWith("d confirms · esc keeps")).toBeTrue();
    }
  });

  test("fullscreen compose preserves complete location and request status before optional words", () => {
    const state = initialState(demoAppSource(), true);
    state.mode = "COMPOSE";
    state.composer.fullscreen = true;
    const expected = new Map([
      [80, " COMPOSE · fullscreen   the la… · ⚑ canon-storm · ¶ 12/13 · 3/5 next ~884/32.8k"],
      [100, " COMPOSE · fullscreen   the lantern ke… · ⚑ canon-storm · part 12/13 · take 3/5 qwen3-32b · local ✓"],
      [110, " COMPOSE · fullscreen   the lantern keeper · ⚑ canon-storm · part 12/13 · take 3/5        qwen3-32b · local ✓"],
      [120, " COMPOSE · fullscreen   the lantern keeper · ⚑ canon-storm · part 12/13 · take 3/5 · 307 words      qwen3-32b · local ✓"]
    ]);

    for (const [width, text] of expected) {
      const status = plainLine(renderStoryScreen(state, { width, height: 24 }).lines.at(-1)!);
      expect(visibleWidth(status)).toBe(width);
      expect(status.trimEnd()).toBe(text);
      expect(/(?:part |take |¶ )?\d+\/…/.test(status)).toBeFalse();
      // This story fills the line, so the build tag has no slack to take.
      expect(status).not.toContain(AI_1667_VERSION_TAG);
    }
  });

  test("the build tag takes the corner on slack and yields it on demand", () => {
    const state = initialState(demoAppSource(), true);
    // A short title and no tag leave the room the demo fixture does not.
    state.payload = { ...state.payload, title: "untitled", tags: [] };

    const roomy = plainLine(renderStoryScreen(state, { width: 120, height: 24 }).lines.at(-1)!);
    expect(roomy.trimEnd().endsWith(`local ✓ · ${AI_1667_VERSION_TAG}`)).toBeTrue();
    expect(roomy).toContain("untitled");
    expect(visibleWidth(roomy)).toBe(120);

    // The story's own identity outranks it: the tag goes before a title does.
    const tight = plainLine(renderStoryScreen(
      { ...state, payload: { ...state.payload, title: "a title long enough to fill this line completely" } },
      { width: 120, height: 24 }
    ).lines.at(-1)!);
    expect(tight).not.toContain(AI_1667_VERSION_TAG);
    expect(tight).toContain("a title long enough to fill this line");
    expect(tight.trimEnd().endsWith("local ✓")).toBeTrue();

    // Narrow keeps the request meter; the key reference carries the tag there.
    const narrow = plainLine(renderStoryScreen(state, { width: 80, height: 24 }).lines.at(-1)!);
    expect(narrow).not.toContain(AI_1667_VERSION_TAG);
    expect(narrow).toContain("next ");
  });
});
