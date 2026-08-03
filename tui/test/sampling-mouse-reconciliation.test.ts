import { describe, expect, test } from "bun:test";
import { initialState } from "../src/app.js";
import { captureMouseActionState, mouseToAction } from "../src/mouse-actions.js";
import { demoAppSource } from "../src/demo.js";
import {
  initialSettingsOverlay
} from "../src/settings-overlay-model.js";
import { renderStoryScreen } from "../src/screens/story.js";
import {
  createSamplingComposer,
  samplingSelectedRowIdentity
} from "../src/sampling-model.js";
import {
  reconcilePresentedMouseAction,
  type FrozenMouseEvent,
  type PresentedInteraction
} from "../src/presented-mouse-action.js";
import type {
  SamplingInlineEditState,
  SamplingPanelId
} from "../src/state.js";
import { EMPTY_SAMPLING_V2, type SamplingSettingsV2 } from "../../shared/settings-v2-types.js";
import { createWrapCache } from "../src/wrap.js";

type State = ReturnType<typeof initialState>;
type ListPanel = Exclude<SamplingPanelId, "sampling">;

const CASES: ReadonlyArray<{
  name: string;
  panel: ListPanel;
  sampling: SamplingSettingsV2;
  cursor: number;
  nextCursor: number;
  edit?: SamplingInlineEditState;
  target: "open-selected" | "delete-item" | "take-next";
}> = [
  {
    name: "persisted stop row",
    panel: "stop",
    sampling: sampling({ stop: ["END", "DONE"] }),
    cursor: 0,
    nextCursor: 1,
    target: "open-selected"
  },
  {
    name: "pending stop row",
    panel: "stop",
    sampling: sampling({ stop: ["END"] }),
    cursor: 1,
    nextCursor: 0,
    edit: pendingEdit("stop", 1),
    target: "open-selected"
  },
  {
    name: "persisted logit-bias row",
    panel: "logit-bias",
    sampling: sampling({ logitBias: { "42": 7, "9": -3 } }),
    cursor: 0,
    nextCursor: 1,
    target: "delete-item"
  },
  {
    name: "pending logit-bias row",
    panel: "logit-bias",
    sampling: sampling({ logitBias: { "42": 7 } }),
    cursor: 1,
    nextCursor: 0,
    edit: pendingEdit("logit-bias", 1),
    target: "open-selected"
  }
];

const MUTATION_CASES: ReadonlyArray<{
  name: string;
  panel: ListPanel;
  sampling: SamplingSettingsV2;
  cursor: number;
  edit?: SamplingInlineEditState;
  mutate(state: State): void;
}> = [
  {
    name: "persisted stop removal",
    panel: "stop",
    sampling: sampling({ stop: ["END", "DONE"] }),
    cursor: 0,
    mutate(state) {
      mutableStop(state).splice(0, 1);
    }
  },
  {
    name: "persisted stop reorder",
    panel: "stop",
    sampling: sampling({ stop: ["END", "DONE"] }),
    cursor: 0,
    mutate(state) {
      const stop = mutableStop(state);
      [stop[0], stop[1]] = [stop[1]!, stop[0]!];
    }
  },
  {
    name: "pending stop insertion",
    panel: "stop",
    sampling: sampling({ stop: ["END"] }),
    cursor: 1,
    edit: pendingEdit("stop", 1),
    mutate(state) {
      mutableStop(state).splice(1, 0, "INSERTED");
    }
  },
  {
    name: "persisted logit-bias value replacement",
    panel: "logit-bias",
    sampling: sampling({ logitBias: { "42": 7, "9": -3 } }),
    cursor: 1,
    mutate(state) {
      const logitBias = mutableLogitBias(state);
      delete logitBias["9"];
      logitBias["100"] = 5;
    }
  },
  {
    name: "pending logit-bias insertion",
    panel: "logit-bias",
    sampling: sampling({ logitBias: { "42": 7 } }),
    cursor: 1,
    edit: pendingEdit("logit-bias", 1),
    mutate(state) {
      mutableLogitBias(state)["9"] = -3;
    }
  }
];

describe("queued Sampling mouse targets", () => {
  for (const item of CASES) {
    test(`refuses a stale ${item.name} action`, () => {
      const state = samplingState(item.panel, item.sampling, item.cursor, item.edit);
      render(state);
      const captured = interaction(state, 1);
      const point = item.target === "open-selected"
        ? selectedPoint(state)
        : actionPoint(state, item.target);
      const action = mouseToAction(point.event, captured.state);
      expect(action).not.toBe(null);
      expect(action?.action).toBe(item.target);
      if (item.target === "open-selected") {
        expect(action?.rowId ?? null).toMatch(/^sampling:/u);
      }

      state.settings!.sampling!.cursor = item.nextCursor;
      render(state);
      const presented = interaction(state, 2);
      expect(reconcilePresentedMouseAction({
        action: action!,
        event: point.event,
        captured,
        presented,
        state
      })).toBe(null);
    });
  }
});

describe("queued Sampling mouse targets after list mutations", () => {
  for (const item of MUTATION_CASES) {
    test(`freezes the presented identity across ${item.name}`, () => {
      const state = samplingState(item.panel, item.sampling, item.cursor, item.edit);
      render(state);
      const captured = interaction(state, 1);
      const point = selectedPoint(state);
      const action = mouseToAction(point.event, captured.state);
      const capturedIdentity = samplingSelectedRowIdentity(captured.state.settings!);

      expect(action?.action).toBe("open-selected");
      expect(action?.rowId).toBe(capturedIdentity);
      expect(capturedIdentity).not.toBe(null);

      item.mutate(state);
      render(state);
      const presented = interaction(state, 2);
      const presentedIdentity = samplingSelectedRowIdentity(presented.state.settings!);

      expect(samplingSelectedRowIdentity(captured.state.settings!)).toBe(capturedIdentity);
      expect(presentedIdentity).not.toBe(capturedIdentity);
      expect(reconcilePresentedMouseAction({
        action: action!,
        event: point.event,
        captured,
        presented,
        state
      })).toBe(null);
    });
  }
});

function samplingState(
  panel: ListPanel,
  values: SamplingSettingsV2,
  cursor: number,
  edit: SamplingInlineEditState | undefined
): State {
  const source = demoAppSource();
  const state = initialState(source, false);
  state.mode = "SETTINGS";
  const settings = initialSettingsOverlay(source.settingsView, state.config);
  settings.draft = { ...settings.draft, sampling: values };
  settings.base = settings.draft;
  settings.sampling = {
    panel,
    cursor,
    logitBiasOrder: Object.keys(values.logitBias),
    edit: edit ?? null,
    result: null,
    biasResolution: { kind: "idle" },
    resolutionGeneration: 0
  };
  state.settings = settings;
  return state;
}

function render(state: State): void {
  const rendered = renderStoryScreen(state, {
    width: 80,
    height: 24,
    wrapCache: createWrapCache()
  });
  Object.assign(state, rendered.derived);
}

function interaction(state: State, version: number): PresentedInteraction {
  return {
    version,
    frameToken: version,
    interactive: true,
    storyId: state.payload.id,
    state: captureMouseActionState(state)
  };
}

function selectedPoint(state: State): { event: FrozenMouseEvent } {
  for (const [y, row] of state.hitRows.entries()) {
    for (const region of [row, ...(row?.overrides ?? [])]) {
      if (region?.target.kind === "list" && region.target.selected === true) {
        return { event: click(region.left, y) };
      }
    }
  }
  throw new Error("selected Sampling row has no hit target");
}

function actionPoint(
  state: State,
  action: "delete-item" | "take-next"
): { event: FrozenMouseEvent } {
  for (const [y, row] of state.hitRows.entries()) {
    for (const region of row?.overrides ?? []) {
      if (region.target.kind === "action" && region.target.action === action) {
        return { event: click(region.left, y) };
      }
    }
  }
  throw new Error(`${action} has no hit target`);
}

function click(x: number, y: number): FrozenMouseEvent {
  return {
    type: "down",
    button: 0,
    x,
    y,
    modifiers: { shift: false, alt: false, ctrl: false }
  };
}

function mutableStop(state: State): string[] {
  return state.settings!.draft.sampling.stop as string[];
}

function mutableLogitBias(state: State): Record<string, number> {
  return state.settings!.draft.sampling.logitBias as Record<string, number>;
}

function pendingEdit(
  panel: "stop" | "logit-bias",
  index: number
): SamplingInlineEditState {
  return {
    kind: "list",
    panel,
    index,
    composer: createSamplingComposer(""),
    initial: ""
  };
}

function sampling(overrides: Partial<SamplingSettingsV2> = {}): SamplingSettingsV2 {
  return { ...EMPTY_SAMPLING_V2, ...overrides };
}
