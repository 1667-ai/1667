import { describe, expect, test } from "bun:test";
import { initialState } from "../src/app.js";
import { openRetakeComposer, suspendRetakeComposer } from "../src/composer-ownership.js";
import { createDemoController, demoAppSource } from "../src/demo.js";
import { createStoryViewModel, lastPartRowIndex, rowIndexForNode } from "../src/model.js";
import { nextRequestContext, projectNextRequest } from "../src/request-context.js";
import { nextRequestEstimate } from "../src/request-projection.js";
import { formatTokensEstimate, formatTokensScaled } from "../src/rail.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { frameText } from "../src/screens/story/frame.js";
import type { RuntimeState, StreamView } from "../src/state.js";
import { assertPromptReadyStoryPayload, type StoryPayload } from "../../shared/types.js";

const STREAM_STARTED_AT = "2026-07-22T00:00:00.000Z";

function stateWith(payload: StoryPayload): RuntimeState {
  const state = initialState(demoAppSource(), true);
  state.payload = payload;
  state.focusIndex = lastPartRowIndex(createStoryViewModel(payload));
  return state;
}

function landedEstimate(state: RuntimeState, payload: StoryPayload) {
  const landed = {
    ...state,
    payload,
    stream: null,
    focusIndex: lastPartRowIndex(createStoryViewModel(payload))
  };
  const request = projectNextRequest(landed);
  return nextRequestEstimate(request.payload, request.context);
}

function expectRenderedEstimate(state: RuntimeState, tokens: number): void {
  const text = frameText(renderStoryScreen(state, { width: 140, height: 36 }).lines);
  const value = `next request  ${formatTokensEstimate(tokens)}`;
  if (state.stream === null) {
    expect(text).toContain(`${value} +≤${formatTokensScaled(state.maxTokens)} /`);
  } else {
    expect(text).toContain(`${value} /`);
    expect(text).not.toContain("+≤");
  }
}

describe("stream-aware next-request projection", () => {
  test("append deltas measure exactly like the manually landed payload", () => {
    const controller = createDemoController();
    const payload = controller.payload();
    const state = stateWith(payload);
    const leaf = payload.path.at(-1)!;
    const delta = " while rain worried the shutters".repeat(160);
    state.stream = {
      targetId: leaf.id,
      parentId: leaf.parentId,
      append: true,
      startedAt: STREAM_STARTED_AT,
      instruction: "",
      text: delta,
      genId: "append-projection"
    };

    const visibleView = createStoryViewModel(payload, state.stream);
    const projected = projectNextRequest(state, visibleView);
    assertPromptReadyStoryPayload(projected.payload);
    expect(projected.payload).toBe(visibleView.visiblePayload);
    expect(projected.payload.path.at(-1)?.text).toBe(`${leaf.text}${delta}`);
    const actual = nextRequestEstimate(projected.payload, projected.context);
    const expected = landedEstimate(state, controller.appendGenerated("", delta, true));
    const stale = nextRequestEstimate(
      payload,
      nextRequestContext(state, createStoryViewModel(payload, state.stream))
    );

    expect(actual).toEqual(expected);
    expect(formatTokensEstimate(actual.tokens)).not.toBe(formatTokensEstimate(stale.tokens));
    expectRenderedEstimate(state, actual.tokens);
  });

  test("direct and retake streams truncate the path and measure like landed takes", () => {
    const cases = [
      { kind: "direct", parentId: "p7", partNumber: 8, instruction: "Turn toward the flooded road." },
      { kind: "retake", parentId: "p11", partNumber: 12, instruction: "Make the compass choose again." }
    ] as const;

    for (const item of cases) {
      const controller = createDemoController();
      const payload = controller.payload();
      const state = stateWith(payload);
      const stream: StreamView = {
        targetId: `stream-${item.kind}`,
        parentId: item.parentId,
        append: false,
        startedAt: STREAM_STARTED_AT,
        instruction: item.instruction,
        text: `  \n${`The ${item.kind} line gathered weight. `.repeat(180)}\n  `,
        partNumber: item.partNumber,
        genId: `${item.kind}-projection`
      };
      state.stream = stream;
      state.focusIndex = rowIndexForNode(createStoryViewModel(payload, stream), stream.targetId);
      expect(state.focusIndex >= 0).toBeTrue();

      const projected = projectNextRequest(state);
      assertPromptReadyStoryPayload(projected.payload);
      expect(projected.payload.path).toHaveLength(item.partNumber);
      expect(projected.payload.path.at(-1)).toMatchObject({
        id: stream.targetId,
        parentId: item.parentId,
        instruction: item.instruction,
        text: stream.text.trim()
      });
      expect(projected.payload.path.some((node) => node.id === `p${item.partNumber}`)).toBeFalse();
      const actual = nextRequestEstimate(projected.payload, projected.context);
      const landed = controller.createChild(item.parentId, item.instruction, stream.text.trim());
      const expected = landedEstimate(state, landed);
      const stale = nextRequestEstimate(
        payload,
        nextRequestContext(state, createStoryViewModel(payload, stream))
      );

      expect(actual).toEqual(expected);
      expect(formatTokensEstimate(actual.tokens)).not.toBe(formatTokensEstimate(stale.tokens));
      expectRenderedEstimate(state, actual.tokens);
    }
  });

  test("prompted retakes project their session target for nonempty and empty drafts", () => {
    for (const instruction of ["Make the lantern answer Maren.", ""]) {
      const payload = createDemoController().payload();
      const state = stateWith(payload);
      const target = payload.path.at(-1)!;
      const prompt = openRetakeComposer(state, target.id, instruction);
      state.focusIndex = rowIndexForNode(createStoryViewModel(payload), "p5");

      const projected = projectNextRequest(state);
      const estimate = nextRequestEstimate(projected.payload, projected.context);
      const directEstimate = nextRequestEstimate(projected.payload, {
        ...projected.context,
        operation: "continue",
        targetId: "p5"
      });

      expect(projected.context).toMatchObject({
        instruction,
        operation: "retake",
        targetId: prompt.nodeId
      });
      expect(estimate.tokens).not.toBe(directEstimate.tokens);
      expectRenderedEstimate(state, estimate.tokens);

      suspendRetakeComposer(state, prompt);
      state.mode = "NAV";
      state.stream = {
        targetId: "pending-retake",
        parentId: target.parentId,
        append: false,
        startedAt: STREAM_STARTED_AT,
        instruction,
        text: "",
        retakeNodeId: target.id
      };
      expect(projectNextRequest(state).context.operation).toBe("continue");
    }
  });

  test("preserves focused identity when a pending take has no bytes that can land", () => {
    const cases = [
      { kind: "direct", parentId: "p7", partNumber: 8 },
      { kind: "retake", parentId: "p11", partNumber: 12 }
    ] as const;

    for (const item of cases) {
      for (const text of ["", "  \n\t  "]) {
        const payload = createDemoController().payload();
        const state = stateWith(payload);
        const stream: StreamView = {
          targetId: `pending-${item.kind}`,
          parentId: item.parentId,
          append: false,
          startedAt: STREAM_STARTED_AT,
          instruction: `Start the ${item.kind} line.`,
          text,
          partNumber: item.partNumber
        };
        state.stream = stream;
        const visibleView = createStoryViewModel(payload, stream);
        state.focusIndex = rowIndexForNode(visibleView, stream.targetId);

        const projected = projectNextRequest(state, visibleView);

        expect(state.focusIndex >= 0).toBeTrue();
        expect(projected.payload).toBe(payload);
        expect(projected.context.targetId).toBe(payload.path.at(-1)?.id);
        expect(nextRequestEstimate(projected.payload, projected.context))
          .toEqual(landedEstimate(state, payload));
      }
    }
  });

  test("structural focus falls back to the projected endpoint child", () => {
    const controller = createDemoController();
    const payload = controller.payload();
    const state = stateWith(payload);
    const leaf = payload.path.at(-1)!;
    const stream: StreamView = {
      targetId: "stream-endpoint-child",
      parentId: leaf.id,
      append: false,
      startedAt: STREAM_STARTED_AT,
      instruction: "Continue beyond the named endpoint.",
      text: "The new line opened beyond the storm."
    };
    state.stream = stream;
    const visibleView = createStoryViewModel(payload, stream);
    const landed = controller.createChild(leaf.id, stream.instruction, stream.text);
    const landedView = createStoryViewModel(landed);

    for (const kind of ["chapter-divider", "chapter-summary"] as const) {
      const visibleFocus = visibleView.rows.findIndex((row) => row.kind === kind);
      const rowId = visibleView.rows[visibleFocus]?.id;
      const landedFocus = landedView.rows.findIndex((row) => row.id === rowId);
      expect(visibleFocus >= 0).toBeTrue();
      expect(landedFocus >= 0).toBeTrue();
      state.focusIndex = visibleFocus;

      const projected = projectNextRequest(state, visibleView);
      const landedState = {
        ...state,
        payload: landed,
        stream: null,
        focusIndex: landedFocus
      };
      const afterLanding = projectNextRequest(landedState, landedView);

      expect(projected.context.targetId).toBe(stream.targetId);
      expect(afterLanding.context.targetId).toBe(landed.path.at(-1)?.id);
      expect(nextRequestEstimate(projected.payload, projected.context))
        .toEqual(nextRequestEstimate(afterLanding.payload, afterLanding.context));
    }
  });

  test("whitespace-only streams do not project bytes that cannot land", () => {
    const payload = createDemoController().payload();
    const state = stateWith(payload);
    const leaf = payload.path.at(-1)!;
    for (const append of [false, true]) {
      state.stream = {
        targetId: append ? leaf.id : "whitespace-take",
        parentId: leaf.parentId,
        append,
        startedAt: STREAM_STARTED_AT,
        instruction: "",
        text: "  \n\t  "
      };
      const projected = projectNextRequest(state);
      expect(projected.payload).toBe(payload);
      expect(nextRequestEstimate(projected.payload, projected.context))
        .toEqual(landedEstimate(state, payload));
    }
  });
});
