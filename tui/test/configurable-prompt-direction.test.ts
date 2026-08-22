import { describe, expect, test } from "bun:test";
import { DEFAULT_INSTRUCTION } from "../../shared/continuation-plan.js";
import { DEFAULT_WRITING_PROMPT_SETTINGS } from "../../shared/settings-v5-writing.js";
import { resolveContinueRequestDirection } from "../../shared/writing-prompt-runtime.js";
import { continuationIntent } from "../src/continuation-intent.js";
import { nextRequestEstimate } from "../src/request-projection.js";
import { createDemoController, demoAppSource } from "../src/demo.js";
import { initialState } from "../src/app.js";
import { createStoryViewModel, lastPartRowIndex } from "../src/model.js";
import { nextRequestContext } from "../src/request-context.js";
import { renderPromptPlan } from "../../shared/prompt-plan.js";
import { renderRequestViewer } from "../src/screens/request-viewer.js";
import { frameText } from "../src/screens/story/frame.js";

const CUSTOM = "Keep walking west.";

describe("configurable Continue direction in request and stream projection", () => {
  test("a genuine append keeps the historical empty-request fallback", () => {
    const payload = createDemoController().payload();
    const leaf = payload.path.at(-1)!;
    const intent = continuationIntent(payload, leaf.id, "", null, CUSTOM);
    expect(intent.appendLast).toBe(true);
    expect(intent.instruction).toBe(DEFAULT_INSTRUCTION);
  });

  test("a new empty Continue uses the active Default Continue direction", () => {
    const payload = createDemoController().payload();
    const retake = payload.path.at(-1)!;
    const intent = continuationIntent(payload, retake.id, "", retake, CUSTOM);
    expect(intent.appendLast).toBe(false);
    expect(intent.instruction).toBe(CUSTOM);
  });

  test("a supplied direction still overrides the default", () => {
    const payload = createDemoController().payload();
    const retake = payload.path.at(-1)!;
    const intent = continuationIntent(payload, retake.id, "Turn toward the river.", retake, CUSTOM);
    expect(intent.instruction).toBe("Turn toward the river.");
  });

  test("the next-request projection uses Settings activeWriting, not a pending draft", () => {
    const source = demoAppSource();
    const state = initialState(source, true);
    const payload = state.payload;
    state.focusIndex = lastPartRowIndex(createStoryViewModel(payload));
    state.activeWriting = {
      ...DEFAULT_WRITING_PROMPT_SETTINGS,
      defaultContinueDirection: CUSTOM
    };
    const context = nextRequestContext(state);
    expect(context.defaultContinueDirection).toBe(CUSTOM);
    const estimate = nextRequestEstimate(payload, {
      ...context,
      operation: "retake",
      targetId: payload.path.at(-1)!.id,
      instruction: ""
    });
    const last = renderPromptPlan(estimate.plan.prompt).at(-1);
    expect(last).toEqual({ role: "user", content: CUSTOM });
  });

  test("request viewer and runtime share default direction normalization", () => {
    const source = demoAppSource();
    const state = initialState(source, true);
    const payload = state.payload;
    const targetId = payload.path.at(-1)!.id;
    const cases = [
      ["Keep walking west.\n", "Keep walking west."],
      [" \t\n", DEFAULT_INSTRUCTION]
    ] as const;

    for (const [configured, expected] of cases) {
      state.activeWriting = {
        ...DEFAULT_WRITING_PROMPT_SETTINGS,
        defaultContinueDirection: configured
      };
      const context = {
        ...nextRequestContext(state),
        operation: "retake" as const,
        targetId,
        instruction: ""
      };
      const estimate = nextRequestEstimate(payload, context);
      const viewer = renderRequestViewer(
        { payload, model: state.model, contextWindow: state.contextWindow },
        context,
        estimate,
        { cursor: estimate.messages.length - 1, scrollTop: -1, returnMode: "NAV" },
        120,
        100
      );

      expect(resolveContinueRequestDirection("", state.activeWriting, false)).toBe(expected);
      expect(continuationIntent(payload, targetId, "", payload.path.at(-1)!, configured).instruction)
        .toBe(expected);
      expect(estimate.messages.at(-1)).toEqual({ role: "user", content: expected });
      expect(frameText(viewer.lines)).toContain(expected);
    }
  });
});
