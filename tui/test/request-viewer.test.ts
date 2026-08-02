import { describe, expect, test } from "bun:test";
import type { KeyEvent, MouseEvent } from "@opentui/core";
import { dispatch, handleKey, initialState } from "../src/app.js";
import { setComposerText } from "../src/composer-model.js";
import { commandPaletteModel } from "../src/command-model.js";
import { openRetakeComposer } from "../src/composer-ownership.js";
import { demoAppSource } from "../src/demo.js";
import { captureMouseActionState, mouseToAction } from "../src/mouse-actions.js";
import {
  reconcilePresentedMouseAction,
  type FrozenMouseEvent,
  type PresentedInteraction
} from "../src/presented-mouse-action.js";
import { resolveKey } from "../src/keys.js";
import { hitAt } from "../src/hit.js";
import { projectNextRequest } from "../src/request-context.js";
import { nextRequestEstimate } from "../src/request-projection.js";
import { formatTokensScaled } from "../src/rail.js";
import { renderRequestViewer } from "../src/screens/request-viewer.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { frameText, plainLine, visibleWidth } from "../src/screens/story/frame.js";
import { adoptReconciliationSnapshot } from "../src/story-adoption.js";
import { createWrapCache } from "../src/wrap.js";
import type { PromptTokenCount } from "../../shared/tokenize-source.js";

const ctrlR: KeyEvent = {
  name: "r", sequence: "\u0012", ctrl: true, shift: false, meta: false,
  option: false, super: false
} as KeyEvent;

function harness() {
  const source = demoAppSource();
  const state = initialState(source, false);
  const pressRequest = () => handleKey(
    ctrlR, state, source, createWrapCache(), () => undefined,
    async () => undefined, () => undefined
  );
  return { source, state, pressRequest };
}

describe("next request viewer", () => {
  test("renders the canonical prompt plan as one bounded full-screen document", () => {
    for (const [width, height] of [[120, 36], [80, 24]] as const) {
      const { state } = harness();
      state.mode = "REQUEST";
      state.request = { cursor: 0, scrollTop: -1, returnMode: "NAV" };
      const projected = projectNextRequest(state);
      const estimate = nextRequestEstimate(projected.payload, projected.context);
      const frame = renderStoryScreen(state, { width, height });
      const text = frameText(frame.lines);

      expect(frame.lines).toHaveLength(height);
      expect(frame.lines.every((line) => visibleWidth(plainLine(line)) === width)).toBeTrue();
      expect(text).toContain(`next request ━ ${estimate.messages.length} messages`);
      expect(text).toContain(`model ${state.model}`);
      expect(text).toContain("context window 32.8k");
      expect(text).toContain("Chapter 1 uses summary chapter-summary-1");
      expect(text).toContain("01 SYSTEM · voice · author brief");
      expect(text).toContain(estimate.messages[0]!.content);
      expect(text.toLowerCase()).not.toContain("api key");
      expect(text.toLowerCase()).not.toContain("base url");
    }
  });

  test("makes every wire-order message and its token estimate reachable", () => {
    const { state } = harness();
    state.mode = "REQUEST";
    state.request = { cursor: 0, scrollTop: 0, returnMode: "NAV" };
    const estimate = nextRequestEstimate(state.payload, projectNextRequest(state).context);
    const text = frameText(renderStoryScreen(state, { width: 120, height: 1_000 }).lines);
    const headers = text.split("\n").filter((line) => /^ \d{2} (SYSTEM|USER|ASSISTANT) ·/.test(line));

    expect(headers).toHaveLength(estimate.messages.length);
    for (const [index, message] of estimate.messages.entries()) {
      expect(headers[index]).toContain(`${String(index + 1).padStart(2, "0")} ${message.role.toUpperCase()}`);
      expect(headers[index]).toMatch(/ · ~[\d.]+[kmbt]?\s*$/);
    }
  });

  test("shows the Author's Note in its canonical wire position and total", () => {
    const { state } = harness();
    state.payload.authorsNote = "Keep the storm quiet until Maren opens the door.";
    state.mode = "REQUEST";
    state.request = { cursor: 0, scrollTop: 0, returnMode: "NAV" };
    const projected = projectNextRequest(state);
    const estimate = nextRequestEstimate(projected.payload, projected.context);
    const text = frameText(renderStoryScreen(state, { width: 120, height: 1_000 }).lines);
    const noteIndex = estimate.plan.entries.findIndex((entry) => entry.category === "note");

    expect(noteIndex).toBeGreaterThan(-1);
    expect(estimate.breakdown.note).toBeGreaterThan(0);
    expect(text).toContain(
      `${String(noteIndex + 1).padStart(2, "0")} SYSTEM · note · authors note`
    );
    expect(text).toContain(state.payload.authorsNote);
  });

  test("the request viewer shows the effective Author's Note depth, including when it clamps", () => {
    const { state } = harness();
    state.payload.authorsNote = "Keep the storm quiet until Maren opens the door.";
    state.payload.authorsNoteDepth = 3;
    state.mode = "REQUEST";
    state.request = { cursor: 0, scrollTop: 0, returnMode: "NAV" };
    const projected = projectNextRequest(state);
    const estimate = nextRequestEstimate(projected.payload, projected.context);
    const text = frameText(renderStoryScreen(state, { width: 120, height: 1_000 }).lines);
    const noteEntry = estimate.plan.entries.find((entry) => entry.category === "note");

    expect(noteEntry).toBeDefined();
    expect((noteEntry as { partsAfterNote: number }).partsAfterNote).toBe(3);
    expect(text).toContain("authors note · depth 3");

    // A depth past the available parts clamps to the start; the viewer shows
    // the depth the request actually used, not the one that was requested.
    const hugeDepth = 9_999;
    state.payload.authorsNoteDepth = hugeDepth;
    const clampedProjected = projectNextRequest(state);
    const clampedEstimate = nextRequestEstimate(clampedProjected.payload, clampedProjected.context);
    const clampedText = frameText(renderStoryScreen(state, { width: 120, height: 1_000 }).lines);
    const clampedNoteEntry = clampedEstimate.plan.entries.find((entry) => entry.category === "note")!;
    const clampedDepth = (clampedNoteEntry as { partsAfterNote: number }).partsAfterNote;
    const clampedIndex = clampedEstimate.plan.entries.indexOf(clampedNoteEntry);

    expect(clampedDepth).toBeGreaterThan(0);
    expect(clampedDepth).toBeLessThan(hugeDepth);
    expect(clampedText).toContain(`authors note · depth ${clampedDepth}`);

    // The clamp is stable: an even larger depth lands in the same place.
    state.payload.authorsNoteDepth = hugeDepth + 1;
    const againProjected = projectNextRequest(state);
    const againEstimate = nextRequestEstimate(againProjected.payload, againProjected.context);
    const againNoteEntry = againEstimate.plan.entries.find((entry) => entry.category === "note")!;
    expect((againNoteEntry as { partsAfterNote: number }).partsAfterNote).toBe(clampedDepth);
    expect(againEstimate.plan.entries.indexOf(againNoteEntry)).toBe(clampedIndex);
  });

  test("the request viewer names the placement when no story part follows the note", () => {
    const { state } = harness();
    state.payload = { ...state.payload, path: [], nodes: [], chapterBreaks: [] };
    state.payload.authorsNote = "Keep the storm quiet until Maren opens the door.";
    state.payload.authorsNoteDepth = 4;
    state.mode = "REQUEST";
    state.request = { cursor: 0, scrollTop: 0, returnMode: "NAV" };
    const text = frameText(renderStoryScreen(state, { width: 120, height: 1_000 }).lines);

    // No part follows the note, so no depth names this placement.
    expect(text).toContain("authors note · before the request");
    expect(text).not.toContain("depth 0");
  });

  test("a story Author Brief overrides the machine-wide brief in the voice block", () => {
    const { state } = harness();
    state.payload.authorBrief = "Write in short, clipped sentences.";
    state.mode = "REQUEST";
    state.request = { cursor: 0, scrollTop: 0, returnMode: "NAV" };
    const projected = projectNextRequest(state);
    const estimate = nextRequestEstimate(projected.payload, projected.context);
    const text = frameText(renderStoryScreen(state, { width: 120, height: 1_000 }).lines);

    expect(estimate.messages[0]!.content).toBe(state.payload.authorBrief);
    expect(text).toContain("01 SYSTEM · voice · author brief");
    expect(text).toContain(state.payload.authorBrief);
    expect(text).not.toContain(state.systemPrompt);
  });

  test("keeps required route and message metadata visible at 80 columns", () => {
    const { state } = harness();
    const projected = projectNextRequest(state);
    const estimate = nextRequestEstimate(projected.payload, projected.context);
    const sourceIndex = estimate.plan.entries.findIndex((entry) => entry.partId !== undefined);
    const sourceEntry = estimate.plan.entries[sourceIndex]!;
    if (sourceEntry.partId === undefined) throw new Error("The fixture must include a source part.");
    sourceEntry.partId = `part-${"long-identifier-".repeat(20)}`;
    const boundary = estimate.plan.requiresEcho
      ? "boundary echo"
      : estimate.messages.at(-1)?.role === "assistant" ? "assistant prefill" : "new passage";

    const frame = renderRequestViewer(
      {
        payload: projected.payload,
        model: `model-${"long-identifier-".repeat(20)}`,
        contextWindow: 32_768
      },
      projected.context,
      estimate,
      { cursor: 0, scrollTop: 0, returnMode: "NAV" },
      80,
      1_000
    );
    const route = plainLine(frame.lines[1]!);
    const messageNumber = String(sourceIndex + 1).padStart(2, "0");
    const messageHeader = frame.lines.map(plainLine)
      .find((line) => line.startsWith(` ${messageNumber} `));

    expect(route).toContain("operation continue");
    expect(route).toContain("context window 32.8k");
    expect(route).toContain(boundary);
    expect(route).toContain("…");
    expect(messageHeader).toContain("…");
    expect(messageHeader).toMatch(/ · ~[\d.]+[kmbt]?\s*$/);
  });

  test("an exact count drops the mark on the header total and names its source on the route line", () => {
    const { state } = harness();
    const projected = projectNextRequest(state);
    const estimate = nextRequestEstimate(projected.payload, projected.context);
    const count: PromptTokenCount = {
      kind: "counted", source: "anthropic-count-tokens", grade: "exact",
      total: estimate.tokens + 9, perMessage: null
    };
    const frame = renderRequestViewer(
      { payload: projected.payload, model: state.model, contextWindow: state.contextWindow },
      projected.context, estimate, { cursor: 0, scrollTop: 0, returnMode: "NAV" }, 160, 1_000, count
    );
    const text = frameText(frame.lines);
    const route = plainLine(frame.lines[1]!);
    const messageHeader = frame.lines.map(plainLine)
      .find((line) => /^ 01 (SYSTEM|USER|ASSISTANT) ·/.test(line));

    expect(text).toContain(`━ ${formatTokensScaled(count.total)}`);
    expect(text).not.toContain(`━ ~${formatTokensScaled(count.total)}`);
    expect(route).toContain("tokens exact");
    // No per-message split came back, so message rows stay on the client's
    // own estimate and keep its `~`.
    expect(messageHeader).toMatch(/ · ~[\d.]+[kmbt]?\s*$/);
  });

  test("a per-message split marks every message row, and the total can run ahead of their sum", () => {
    const { state } = harness();
    const projected = projectNextRequest(state);
    const estimate = nextRequestEstimate(projected.payload, projected.context);
    const perMessage = estimate.messageTokenCounts.map((tokens) => tokens + 1);
    // The bundled OpenAI tokenizer adds reply-priming tokens that belong to no
    // message: the total legitimately runs ahead of the per-message sum.
    const total = perMessage.reduce((sum, tokens) => sum + tokens, 0) + 3;
    const count: PromptTokenCount = {
      kind: "counted", source: "bundled-o200k", grade: "exact", total, perMessage
    };
    const frame = renderRequestViewer(
      { payload: projected.payload, model: state.model, contextWindow: state.contextWindow },
      projected.context, estimate, { cursor: 0, scrollTop: 0, returnMode: "NAV" }, 160, 1_000, count
    );
    const text = frameText(frame.lines);
    const headers = text.split("\n").filter((line) => /^ \d{2} (SYSTEM|USER|ASSISTANT) ·/.test(line));

    expect(headers).toHaveLength(estimate.messages.length);
    for (const [index, header] of headers.entries()) {
      const marked = formatTokensScaled(perMessage[index]!);
      expect(header.trimEnd().endsWith(` · ${marked}`)).toBeTrue();
      expect(header.trimEnd().endsWith(` · ~${marked}`)).toBeFalse();
    }
    expect(total).toBeGreaterThan(perMessage.reduce((sum, tokens) => sum + tokens, 0));
    expect(text).toContain(`━ ${formatTokensScaled(total)}`);
  });

  test("the route's token-source statement yields before it costs the model name a cell", () => {
    const { state } = harness();
    const projected = projectNextRequest(state);
    const estimate = nextRequestEstimate(projected.payload, projected.context);
    const count: PromptTokenCount = {
      kind: "counted", source: "anthropic-count-tokens", grade: "exact",
      total: estimate.tokens, perMessage: null
    };
    const wide = renderRequestViewer(
      { payload: projected.payload, model: "short-model", contextWindow: 32_768 },
      projected.context, estimate, { cursor: 0, scrollTop: 0, returnMode: "NAV" }, 120, 1_000, count
    );
    const narrow = renderRequestViewer(
      { payload: projected.payload, model: `model-${"long-identifier-".repeat(20)}`, contextWindow: 32_768 },
      projected.context, estimate, { cursor: 0, scrollTop: 0, returnMode: "NAV" }, 80, 1_000, count
    );
    const wideRoute = plainLine(wide.lines[1]!);
    const narrowRoute = plainLine(narrow.lines[1]!);

    expect(wideRoute).toContain("tokens exact");
    expect(wideRoute).toContain("short-model");
    // At 80 columns the huge model name already needs every cell the route
    // line can spare; the provenance statement yields rather than truncating
    // the model further than the plain route already would.
    expect(narrowRoute).not.toContain("tokens exact");
    expect(narrowRoute).toContain("…");
  });

  test("rejects a queued click when a request row changes identity", () => {
    const { state } = harness();
    const event: FrozenMouseEvent = {
      type: "down",
      button: 0,
      x: 4,
      y: 0,
      modifiers: { shift: false, alt: false, ctrl: false }
    };
    const setRow = (rowId: string) => {
      state.hitRows = [{
        target: { kind: "list", index: 1, rowId, selected: false },
        left: 0,
        right: 80
      }];
    };
    const interaction = (version: number): PresentedInteraction => ({
      version,
      frameToken: version,
      interactive: true,
      storyId: state.payload.id,
      state: captureMouseActionState(state)
    });
    state.mode = "REQUEST";
    state.request = { cursor: 0, scrollTop: 0, returnMode: "NAV" };
    setRow("request:message-a");
    const captured = interaction(1);
    const action = mouseToAction(event as MouseEvent, captured.state)!;
    expect(action).toEqual({
      action: "focus-index",
      index: 1,
      rowId: "request:message-a"
    });

    const reconcile = (presented: PresentedInteraction) => reconcilePresentedMouseAction({
      action,
      event,
      captured,
      presented,
      state
    });
    expect(reconcile(interaction(2))).toEqual(action);

    setRow("request:message-b");
    expect(reconcile(interaction(3))).toBe(null);
  });

  test("names the latest legacy summary take as the raw-context reset", () => {
    const { state } = harness();
    const resetIndex = 5;
    state.payload.path[resetIndex]!.role = "summary";
    state.mode = "REQUEST";
    state.request = { cursor: 0, scrollTop: -1, returnMode: "NAV" };

    const text = frameText(renderStoryScreen(state, { width: 120, height: 36 }).lines);
    expect(text).toContain(`Summary take ${state.payload.path[resetIndex]!.id} starts the raw context.`);
    expect(text).toContain(`${resetIndex} earlier parts are omitted.`);
  });

  test("names a legacy summary at path zero without omitting earlier parts", () => {
    const { state } = harness();
    const summary = state.payload.path[0]!;
    summary.role = "summary";
    state.payload.chapterBreaks = [];
    state.mode = "REQUEST";
    state.request = { cursor: 0, scrollTop: -1, returnMode: "NAV" };

    const text = frameText(renderStoryScreen(state, { width: 120, height: 36 }).lines);
    expect(text).toContain(`Summary take ${summary.id} starts the raw context.`);
    expect(text).toContain("0 earlier parts are omitted.");
  });

  test("Ctrl+R preserves Direct and retake owners across open and close", async () => {
    const { state, pressRequest } = harness();
    state.mode = "COMPOSE";
    setComposerText(state.composer, "Keep this exact Direct draft.");
    const direct = state.composer;

    await pressRequest();
    expect(state).toMatchObject({ mode: "REQUEST", request: { returnMode: "COMPOSE" } });
    expect(state.composer).toBe(direct);
    await pressRequest();
    expect(state.mode).toBe("COMPOSE");
    expect(state.composer).toBe(direct);

    const target = state.payload.path.at(-1)!;
    const retake = openRetakeComposer(state, target.id, "Keep this retake prompt.");
    await pressRequest();
    expect(state.retakePrompt).toBe(retake);
    expect(state.composer).toBe(retake.composer);
    await pressRequest();
    expect(state.mode).toBe("COMPOSE");
    expect(state.retakePrompt).toBe(retake);
    expect(state.composer).toBe(retake.composer);
  });

  test("routes request navigation without admitting text", () => {
    const key = (name: string, shift = false): KeyEvent => ({
      name, sequence: shift ? name.toUpperCase() : name,
      shift, ctrl: false, meta: false, option: false, super: false
    } as KeyEvent);
    expect(resolveKey(key("escape"), "REQUEST").action).toBe("cancel");
    expect(resolveKey(key("down"), "REQUEST").action).toBe("focus-next");
    expect(resolveKey(key("up"), "REQUEST").action).toBe("focus-previous");
    expect(resolveKey(key("down", true), "REQUEST").action).toBe("scroll-line-down");
    expect(resolveKey(key("up", true), "REQUEST").action).toBe("scroll-line-up");
    expect(resolveKey(key("pagedown"), "REQUEST").action).toBe("scroll-down");
    expect(resolveKey(key("pageup"), "REQUEST").action).toBe("scroll-up");
    expect(resolveKey(key("g"), "REQUEST").action).toBe("top");
    expect(resolveKey(key("g", true), "REQUEST").action).toBe("leaf");
    expect(resolveKey(key("x"), "REQUEST").action).toBe("none");
  });

  test("the palette command opens the viewer and both meter forms expose it", async () => {
    const { source, state } = harness();
    const match = commandPaletteModel("next request", false).selectable[0];
    expect(match?.command).toMatchObject({
      id: "next-request", name: "next request", section: "view", shortcut: "⌃r"
    });
    state.mode = "COMMANDS";
    state.commands = {
      query: "next request", cursor: 0, selectedId: "next-request", view: "commands",
      returnMode: "NAV"
    };
    await dispatch(
      { action: "open-selected" }, state, source, createWrapCache(),
      () => undefined, async () => undefined, () => undefined
    );
    expect(state).toMatchObject({ mode: "REQUEST", request: { returnMode: "NAV" } });

    state.mode = "NAV";
    state.request = null;
    state.contextMeterExpanded = true;
    for (const width of [80, 140]) {
      const frame = renderStoryScreen(state, { width, height: 36 });
      expect(frame.derived.hitRows.some((row) =>
        row?.target.kind === "inline-action" && row.target.action === "open-request"
        || row?.overrides?.some((hit) =>
          hit.target.kind === "inline-action" && hit.target.action === "open-request"
        ) === true
      )).toBeTrue();
    }
  });

  test("the palette preserves Direct and retake composer ownership", async () => {
    for (const retake of [false, true]) {
      const { source, state } = harness();
      const draft = retake ? "Keep this palette retake." : "Keep this palette Direct draft.";
      if (retake) openRetakeComposer(state, state.payload.path.at(-1)!.id, draft);
      else {
        state.mode = "COMPOSE";
        setComposerText(state.composer, draft);
      }
      const composer = state.composer;
      const retakeOwner = state.retakePrompt;
      const run = (action: Parameters<typeof dispatch>[0]) => dispatch(
        action, state, source, createWrapCache(),
        () => undefined, async () => undefined, () => undefined
      );

      await run({ action: "open-commands" });
      expect(state.commands?.returnMode).toBe("COMPOSE");
      state.commands = {
        query: "next request",
        cursor: 0,
        selectedId: "next-request",
        view: "commands",
        returnMode: "COMPOSE"
      };
      await run({ action: "open-selected" });

      expect(state).toMatchObject({
        mode: "REQUEST",
        request: { returnMode: "COMPOSE" }
      });
      expect(state.composer).toBe(composer);
      expect(state.retakePrompt).toBe(retakeOwner);
      expect(projectNextRequest(state).context).toMatchObject({
        operation: retake ? "retake" : "continue",
        instruction: draft
      });

      await run({ action: "cancel" });
      expect(state.mode).toBe("COMPOSE");
      expect(state.composer).toBe(composer);
      expect(state.retakePrompt).toBe(retakeOwner);
    }
  });

  test("the wheel scrolls the request document instead of moving focus", () => {
    const { state } = harness();
    state.mode = "REQUEST";
    state.request = { cursor: 3, scrollTop: 8, returnMode: "NAV" };
    const event = {
      type: "scroll", button: 0, x: 5, y: 5,
      modifiers: { shift: false, ctrl: false, meta: false },
      scroll: { direction: "down" }
    } as unknown as MouseEvent;

    expect(mouseToAction(event, state)).toEqual({ action: "scroll-line-down" });
  });

  test("a different story closes a request document bound to the old story", () => {
    const { state } = harness();
    state.mode = "REQUEST";
    state.request = { cursor: 4, scrollTop: 12, returnMode: "NAV" };
    const replacement = structuredClone(state.payload);
    replacement.id = "story-request-viewer-replacement";

    adoptReconciliationSnapshot(state, replacement);

    expect(state.request).toBe(null);
    expect(state.mode).toBe("NAV");
  });

  test("the breadcrumb keeps a mode cell, a tether, and clickable keys", () => {
    const { state } = harness();
    const projected = projectNextRequest(state);
    const estimate = nextRequestEstimate(projected.payload, projected.context);
    const frame = renderRequestViewer(
      { payload: projected.payload, model: "test-model", contextWindow: 32_768 },
      projected.context,
      estimate,
      { cursor: 0, scrollTop: 0, returnMode: "NAV" },
      120,
      30
    );
    const row = frame.lines.length - 1;
    const breadcrumb = plainLine(frame.lines[row]!);

    // C-02: the surface names its mode and stays tethered to the story.
    expect(breadcrumb).toContain(" REQUEST ");
    expect(breadcrumb).toContain(projected.payload.title);
    expect(breadcrumb).toContain("message 1/");
    // Its keys answer a click, the way the map's and search's do.
    const column = visibleWidth(breadcrumb.slice(0, breadcrumb.indexOf("esc close")));
    expect(hitAt(frame.hitRows, column, row))
      .toEqual({ kind: "action", action: "cancel" });
  });
});
