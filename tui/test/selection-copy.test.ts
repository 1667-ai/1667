import { describe, expect, test } from "bun:test";
import { initialState } from "../src/app.js";
import {
  createComposer,
  insertComposerText,
  moveComposerHorizontal,
  selectedComposerText
} from "../src/composer-model.js";
import { demoAppSource } from "../src/demo.js";
import {
  EMPTY_NATIVE_SELECTION,
  captureNativeSelection,
  copyActiveSelection,
  handleMainCopyShortcut,
  nativeSelectionMatches,
  syncMouseComposerSelection
} from "../src/copy-actions.js";
import { createStoryViewModel, rowPart } from "../src/model.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { fitLine, plainLine } from "../src/screens/story/frame.js";
import {
  buildComposerSelectionProjection,
  buildStorySelectionProjection,
  storyTextFromProjection
} from "../src/selection-projection.js";
import { deriveStoryFrameLayout } from "../src/story-frame-layout.js";
import { initialSettingsOverlay } from "../src/settings-overlay-model.js";
import {
  FACT_BODY_COMPOSER_SOURCE,
  FACT_TAG_COMPOSER_SOURCE
} from "../src/fact-editor-policy.js";

describe("active selection copy", () => {
  test("inline Settings owns empty Ctrl+C and copies its selected draft", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    state.mode = "SETTINGS";
    state.settings = initialSettingsOverlay(source.settingsView, state.config);
    const composer = createComposer("draft-model");
    composer.anchor = 0;
    state.settings.edit = {
      kind: "inline", row: "model", mode: "text", composer, initial: ""
    };
    let quit = false;

    expect(handleMainCopyShortcut(
      EMPTY_NATIVE_SELECTION,
      state,
      () => undefined,
      () => { quit = true; }
    )).toBeTrue();
    expect(quit).toBeFalse();

    const copied = copyActiveSelection(
      EMPTY_NATIVE_SELECTION,
      state,
      async () => "command"
    );
    expect(copied?.text).toBe("draft-model");
    expect(await copied?.outcome).toBe("command");
  });

  test("inline API-key selection copies only the masked edit projection", () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    state.mode = "SETTINGS";
    state.settings = initialSettingsOverlay(source.settingsView, state.config);
    const composer = createComposer("sk-visible-nowhere");
    composer.anchor = 0;
    state.settings.edit = {
      kind: "inline",
      row: "api-key",
      mode: "secret",
      composer,
      initial: ""
    };

    const copied = copyActiveSelection(
      EMPTY_NATIVE_SELECTION,
      state,
      async () => "command"
    );
    expect(copied?.text).toBe("•".repeat("sk-visible-nowhere".length));
    expect(copied?.text).not.toContain("sk-visible-nowhere");
  });

  test("inline Settings maps a mouse range into its composer selection", () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    state.mode = "SETTINGS";
    state.settings = initialSettingsOverlay(source.settingsView, state.config);
    state.settings.cursor = 4;
    const composer = createComposer("draft-model");
    state.settings.edit = {
      kind: "inline", row: "model", mode: "text", composer, initial: ""
    };
    const frame = renderStoryScreen(state, { width: 80, height: 24 });
    state.composerSelectionProjection = frame.derived.composerSelectionProjection;
    const projection = state.composerSelectionProjection!;
    const displayStart = projection.findIndex((cell) => cell?.start === 2);
    const displayLast = projection.findIndex((cell) => cell?.start === 6);
    expect(displayStart).toBeGreaterThan(-1);
    expect(displayLast).toBeGreaterThan(displayStart);
    const renderer = {
      getSelection: () => ({
        getSelectedText: () => "painted draft slice",
        selectedRenderables: [{
          getSelection: () => ({ start: displayStart, end: displayLast + 1 })
        }]
      })
    } as never;

    expect(copyActiveSelection(renderer, state, async () => "command")?.text)
      .toBe("aft-m");
    expect(selectedComposerText(composer)).toBe("aft-m");
  });

  test("wide inline Settings selection uses the full modal-buffer stride", () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    state.mode = "SETTINGS";
    state.settings = initialSettingsOverlay(source.settingsView, state.config);
    state.settings.cursor = 4;
    const composer = createComposer("draft-model");
    state.settings.edit = {
      kind: "inline", row: "model", mode: "text", composer, initial: ""
    };
    const width = 160;
    const layout = deriveStoryFrameLayout(width, state.config);
    expect(layout.railStart).not.toBe(null);
    const frame = renderStoryScreen(state, { width, height: 30, layout });
    state.composerSelectionProjection = frame.derived.composerSelectionProjection;
    const projection = state.composerSelectionProjection!;
    const displayStart = projection.findIndex((cell) => cell?.start === 2);
    const displayLast = projection.findIndex((cell) => cell?.start === 6);
    const stride = width + 1;
    expect(displayStart % stride).toBeLessThan(width);
    expect(displayLast % stride).toBeLessThan(width);
    const renderer = {
      getSelection: () => ({
        getSelectedText: () => "painted draft slice",
        selectedRenderables: [{
          getSelection: () => ({ start: displayStart, end: displayLast + 1 })
        }]
      })
    } as never;

    expect(copyActiveSelection(renderer, state, async () => "command")?.text)
      .toBe("aft-m");
    expect(selectedComposerText(composer)).toBe("aft-m");
  });

  test("Ctrl+C copies a main-view mouse selection without closing or clearing it", async () => {
    const state = initialState(demoAppSource(), false);
    const copied: string[] = [];
    const result = copyActiveSelection(
      { getSelection: () => ({ getSelectedText: () => "main view words" }) as never },
      state,
      async (text) => { copied.push(text); return "command"; }
    );

    expect(result?.text).toBe("main view words");
    expect(await result?.outcome).toBe("command");
    expect(copied).toEqual(["main view words"]);
  });

  test("Ctrl+C consumes a native selection containing only unmapped story chrome", () => {
    const state = initialState(demoAppSource(), false);
    state.storySelectionProjection = [null, null, null];
    const result = copyActiveSelection(
      { getSelection: () => ({
        getSelectedText: () => "R reprompt",
        selectedRenderables: []
      }) as never },
      state,
      async () => "command"
    );

    expect(result?.text).toBe("R reprompt");
  });

  test("multiline story selection projects away gutter controls and row padding", () => {
    const state = initialState(demoAppSource(), false);
    state.stream = null;
    const view = createStoryViewModel(state.payload);
    const focused = rowPart(view, state.focusIndex)!;
    const frame = renderStoryScreen(state, { width: 120, height: 30 });
    Object.assign(state, frame.derived);
    const projection = state.storySelectionProjection!;
    const sourceCells = projection.flatMap((cell, display) =>
      cell?.key === `${focused.id}:text` ? [{ cell, display }] : []);
    const first = sourceCells.find(({ cell }) => cell.start >= 12)!;
    const last = sourceCells.findLast(({ cell }) => cell.end <= 240)!;
    expect(Math.floor(first.display / 121)).toBeLessThan(Math.floor(last.display / 121));
    const renderer = {
      getSelection: () => ({
        getSelectedText: () => "dirty painted text\nR reprompt                         ",
        selectedRenderables: [{
          getSelection: () => ({ start: first.display, end: last.display + 1 })
        }]
      })
    } as never;

    const result = copyActiveSelection(renderer, state, async () => "command");

    expect(result?.text).toBe(focused.node.text.slice(first.cell.start, last.cell.end));
    expect(result?.text).not.toContain("reprompt");
  });

  test("wide-layout story selection uses the split page buffer stride", () => {
    const state = initialState(demoAppSource(), false);
    state.stream = null;
    const width = 160;
    const layout = deriveStoryFrameLayout(width, state.config);
    expect(layout.railStart).not.toBe(null);
    const view = createStoryViewModel(state.payload);
    const focused = rowPart(view, state.focusIndex)!;
    const frame = renderStoryScreen(state, { width, height: 30, layout });
    Object.assign(state, frame.derived);
    const projection = state.storySelectionProjection!;
    const sourceCells = projection.flatMap((cell, display) =>
      cell?.key === `${focused.id}:text` ? [{ cell, display }] : []);
    const first = sourceCells.find(({ cell }) => cell.start >= 12)!;
    const last = sourceCells.findLast(({ cell }) => cell.end <= 240)!;
    const stride = layout.pageWidth + 1;
    expect(Math.floor(first.display / stride)).toBeLessThan(Math.floor(last.display / stride));
    expect(first.display % stride).toBeLessThan(layout.pageWidth);
    expect(last.display % stride).toBeLessThan(layout.pageWidth);
    const renderer = {
      getSelection: () => ({
        getSelectedText: () => "painted page text",
        selectedRenderables: [{
          getSelection: () => ({ start: first.display, end: last.display + 1 })
        }]
      })
    } as never;

    expect(copyActiveSelection(renderer, state, async () => "command")?.text)
      .toBe(focused.node.text.slice(first.cell.start, last.cell.end));
  });

  test("a queued copy keeps the native range captured when its key arrived", () => {
    const state = initialState(demoAppSource(), false);
    const source = "alpha beta";
    const projection = buildStorySelectionProjection([fitLine([{
      text: source,
      storySource: { key: "part:text", text: source, start: 0 }
    }], 20)], 20)!;
    let selected = nativeSelection("painted alpha", 0, 5);
    const renderer = { getSelection: () => selected } as never;
    const captured = captureNativeSelection(renderer)!;

    selected = nativeSelection("painted alpha", 0, 5);
    expect(nativeSelectionMatches(renderer, captured)).toBeFalse();
    selected = nativeSelection("painted beta", 6, 10);

    expect(nativeSelectionMatches(renderer, captured)).toBeFalse();
    expect(copyActiveSelection(captured, state, async () => "command", {
      composer: null,
      story: projection
    })?.text).toBe("alpha");
  });

  test("a queued editor key replaces its captured mouse range, not a later drag", () => {
    const state = initialState(demoAppSource(), false);
    state.mode = "COMPOSE";
    state.composer = createComposer("alpha beta");
    const projection = buildComposerSelectionProjection([fitLine([{
      text: state.composer.text,
      composerStart: 0
    }], 20)], 20)!;
    const captured = captureNativeSelection({
      getSelection: () => nativeSelection("alpha", 0, 5)
    } as never)!;

    expect(syncMouseComposerSelection(captured, state, projection)).toBe("applied");
    insertComposerText(state.composer, "X");

    expect(state.composer.text).toBe("X beta");
  });

  test("expanded prompt selection copies its raw instruction without prompt chrome", () => {
    const state = initialState(demoAppSource(), false);
    state.stream = null;
    state.showInstructions = true;
    const view = createStoryViewModel(state.payload);
    const focused = rowPart(view, state.focusIndex)!;
    state.expandedPromptIds = new Set([focused.id]);
    const frame = renderStoryScreen(state, { width: 120, height: 30 });
    Object.assign(state, frame.derived);
    const projection = state.storySelectionProjection!;
    const sourceCells = projection.flatMap((cell, display) =>
      cell?.key === `${focused.id}:instruction` ? [{ cell, display }] : []);
    const first = sourceCells[0]!;
    const last = sourceCells.at(-1)!;
    const renderer = {
      getSelection: () => ({
        getSelectedText: () => `» ${focused.instruction}`,
        selectedRenderables: [{
          getSelection: () => ({ start: first.display, end: last.display + 1 })
        }]
      })
    } as never;

    expect(copyActiveSelection(renderer, state, async () => "command")?.text).toBe(focused.instruction);
  });

  test("a truncation ellipsis never projects the next hidden source character", () => {
    const source = "ab💡z";
    const frame = [fitLine([{
      text: source,
      storySource: { key: "part:instruction", text: source, start: 0 }
    }], 4)];
    const projection = buildStorySelectionProjection(frame, 4)!;

    expect(plainLine(frame[0]!)).toBe("ab… ");
    expect(projection[2]).toBe(null);
    expect(storyTextFromProjection(projection, 0, projection.length)).toBe("ab");
  });

  test("Ctrl+C uses and preserves the shared editor's Shift+Arrow selection", () => {
    const state = initialState(demoAppSource(), false);
    state.mode = "COMPOSE";
    state.composer = createComposer("selected");
    for (let index = 0; index < 8; index += 1) {
      moveComposerHorizontal(state.composer, -1, true);
    }

    const result = copyActiveSelection(
      { getSelection: () => null },
      state,
      async () => "osc52"
    );

    expect(result?.text).toBe("selected");
    expect(selectedComposerText(state.composer)).toBe("selected");
  });

  test("a stale NAV highlight cannot override the active editor selection", () => {
    const state = initialState(demoAppSource(), false);
    state.mode = "COMPOSE";
    state.composer = createComposer("draft selection");
    for (let index = 0; index < 9; index += 1) {
      moveComposerHorizontal(state.composer, -1, true);
    }
    const renderer = {
      getSelection: () => ({
        getSelectedText: () => "stale story selection",
        anchor: { x: 0, y: 0 },
        focus: { x: 5, y: 0 },
        selectedRenderables: [{ getSelection: () => ({ start: 0, end: 5 }) }]
      })
    } as never;

    const result = copyActiveSelection(renderer, state, async () => "command");

    expect(result?.text).toBe("selection");
    expect(selectedComposerText(state.composer)).toBe("selection");
  });

  test("mouse editor selection maps decorated display cells back to raw multiline text", () => {
    const state = initialState(demoAppSource(), false);
    state.mode = "COMPOSE";
    state.composer = createComposer("alpha\nbeta");
    state.composer.fullscreen = true;
    const frame = renderStoryScreen(state, { width: 80, height: 24 });
    state.composerSelectionProjection = frame.derived.composerSelectionProjection;
    const projection = state.composerSelectionProjection!;
    const displayStart = projection.findIndex((cell) => cell?.start === 1);
    const displayLast = projection.findIndex((cell) => cell?.start === 7);
    expect(displayStart).toBeGreaterThan(-1);
    expect(displayLast).toBeGreaterThan(displayStart);
    const renderer = {
      getSelection: () => ({
        getSelectedText: () => "┃ lpha…decorated…be",
        anchor: { x: 0, y: 0 },
        focus: { x: 1, y: 1 },
        selectedRenderables: [{
          getSelection: () => ({ start: displayStart, end: displayLast + 1 })
        }]
      })
    } as never;

    const result = copyActiveSelection(renderer, state, async () => "command");

    expect(result?.text).toBe("lpha\nbe");
    expect(selectedComposerText(state.composer)).toBe("lpha\nbe");
    insertComposerText(state.composer, "X");
    expect(state.composer.text).toBe("aXta");
  });

  test("mouse selection maps through soft-wrapped inline editor rows", () => {
    const state = initialState(demoAppSource(), false);
    const composer = createComposer("abcdefghijklmnopqrstuvwxyz");
    state.mode = "EDITOR";
    state.editor = {
      kind: "fact",
      target: { kind: "fact", factId: null, base: null },
      composer,
      tag: createComposer(""),
      activation: "always",
      keys: createComposer(""),
      secondary: createComposer(""), secondaryMode: "and", scan: createComposer(""), recursion: "on",
      priority: "normal",
      budget: createComposer(""),
      focus: "tag",
      initialFact: {
        tag: null, activation: "always", keys: [], secondaryKeys: [], secondaryMode: "and", scanDepth: undefined, recursion: "on", priority: "normal", budgetTokens: undefined, text: composer.text
      },
      title: "edit fact",
      placeholder: "fact text…",
      returnMode: "FACTS",
      conflict: null
    };
    const frame = renderStoryScreen(state, { width: 20, height: 12 });
    state.composerSelectionProjection = frame.derived.composerSelectionProjection;
    const projection = state.composerSelectionProjection!;
    const displayStart = projection.findIndex((cell) => cell?.start === 4);
    const displayLast = projection.findIndex((cell) => cell?.start === 20);
    expect(displayStart).toBeGreaterThan(-1);
    expect(displayLast).toBeGreaterThan(displayStart);
    const renderer = {
      getSelection: () => ({
        getSelectedText: () => "efghijklmnopqrstu",
        anchor: { x: 0, y: 0 },
        focus: { x: 1, y: 1 },
        selectedRenderables: [{
          getSelection: () => ({ start: displayStart, end: displayLast + 1 })
        }]
      })
    } as never;

    const result = copyActiveSelection(renderer, state, async () => "command");

    expect(result?.text).toBe("efghijklmnopqrstu");
    expect(selectedComposerText(composer)).toBe("efghijklmnopqrstu");
    insertComposerText(composer, "X");
    expect(composer.text).toBe("abcdXvwxyz");
  });

  test("mouse selection copies the active typed Fact tag", () => {
    const state = initialState(demoAppSource(), false);
    const composer = createComposer("Body stays whole.");
    const tag = createComposer("people");
    state.mode = "EDITOR";
    state.editor = {
      kind: "fact",
      target: { kind: "fact", factId: null, base: null },
      composer,
      tag,
      activation: "always",
      keys: createComposer(""),
      secondary: createComposer(""), secondaryMode: "and", scan: createComposer(""), recursion: "on",
      priority: "normal",
      budget: createComposer(""),
      focus: "tag",
      initialFact: {
        tag: "people", activation: "always", keys: [], secondaryKeys: [], secondaryMode: "and", scanDepth: undefined, recursion: "on", priority: "normal", budgetTokens: undefined, text: composer.text
      },
      title: "edit fact",
      placeholder: "fact text…",
      returnMode: "FACTS",
      conflict: null
    };
    const frame = renderStoryScreen(state, { width: 40, height: 12 });
    const projection = frame.derived.composerSelectionProjection!;
    const displayStart = projection.findIndex((cell) => cell?.start === 0);
    const displayLast = projection.findIndex((cell) => cell?.start === 5);
    expect(displayStart).toBeGreaterThan(-1);
    expect(displayLast).toBeGreaterThan(displayStart);
    const renderer = {
      getSelection: () => ({
        getSelectedText: () => "people",
        selectedRenderables: [{
          getSelection: () => ({ start: displayStart, end: displayLast + 1 })
        }]
      })
    } as never;

    const result = copyActiveSelection(renderer, state, async () => "command", {
      composer: projection,
      story: null
    });

    expect(result?.text).toBe("people");
    expect(selectedComposerText(tag)).toBe("people");
  });

  test("mouse selection copies an inactive exact Fact tag", () => {
    const state = initialState(demoAppSource(), false);
    const composer = createComposer("Body stays whole.");
    const tag = createComposer("people");
    state.mode = "EDITOR";
    state.editor = {
      kind: "fact",
      target: { kind: "fact", factId: null, base: null },
      composer,
      tag,
      activation: "always",
      keys: createComposer(""),
      secondary: createComposer(""), secondaryMode: "and", scan: createComposer(""), recursion: "on",
      priority: "normal",
      budget: createComposer(""),
      focus: "body",
      initialFact: {
        tag: "people", activation: "always", keys: [], secondaryKeys: [], secondaryMode: "and", scanDepth: undefined, recursion: "on", priority: "normal", budgetTokens: undefined, text: composer.text
      },
      title: "edit fact",
      placeholder: "fact text…",
      returnMode: "FACTS",
      conflict: null
    };
    const frame = renderStoryScreen(state, { width: 40, height: 12 });
    const projection = frame.derived.composerSelectionProjection!;
    const displayStart = projection.findIndex((cell) =>
      cell?.sourceId === FACT_TAG_COMPOSER_SOURCE && cell.start === 0);
    const displayLast = projection.findIndex((cell) =>
      cell?.sourceId === FACT_TAG_COMPOSER_SOURCE && cell.start === 5);
    const renderer = {
      getSelection: () => ({
        getSelectedText: () => "people",
        selectedRenderables: [{
          getSelection: () => ({ start: displayStart, end: displayLast + 1 })
        }]
      })
    } as never;

    const result = copyActiveSelection(renderer, state, async () => "command", {
      composer: projection,
      story: null
    });

    expect(result?.text).toBe("people");
    expect(state.editor.focus).toBe("tag");
    expect(selectedComposerText(tag)).toBe("people");
  });

  test("mouse selection switches a typed Fact from its tag to its body", () => {
    const state = initialState(demoAppSource(), false);
    const composer = createComposer("Body stays whole.");
    const tag = createComposer("people");
    tag.anchor = 0;
    state.mode = "EDITOR";
    state.editor = {
      kind: "fact",
      target: { kind: "fact", factId: null, base: null },
      composer,
      tag,
      activation: "always",
      keys: createComposer(""),
      secondary: createComposer(""), secondaryMode: "and", scan: createComposer(""), recursion: "on",
      priority: "normal",
      budget: createComposer(""),
      focus: "tag",
      initialFact: {
        tag: "people", activation: "always", keys: [], secondaryKeys: [], secondaryMode: "and", scanDepth: undefined, recursion: "on", priority: "normal", budgetTokens: undefined, text: composer.text
      },
      title: "edit fact",
      placeholder: "fact text…",
      returnMode: "FACTS",
      conflict: null
    };
    const frame = renderStoryScreen(state, { width: 40, height: 12 });
    const projection = frame.derived.composerSelectionProjection!;
    const displayStart = projection.findIndex((cell) =>
      cell?.sourceId === FACT_BODY_COMPOSER_SOURCE && cell.start === 0);
    const displayLast = projection.findIndex((cell) =>
      cell?.sourceId === FACT_BODY_COMPOSER_SOURCE && cell.start === 3);
    const renderer = {
      getSelection: () => ({
        getSelectedText: () => "Body",
        selectedRenderables: [{
          getSelection: () => ({ start: displayStart, end: displayLast + 1 })
        }]
      })
    } as never;

    const result = copyActiveSelection(renderer, state, async () => "command", {
      composer: projection,
      story: null
    });

    expect(result?.text).toBe("Body");
    expect(state.editor.focus).toBe("body");
    expect(selectedComposerText(composer)).toBe("Body");
    insertComposerText(composer, "X");
    expect(composer.text).toBe("X stays whole.");
    expect(tag.text).toBe("people");
  });

  test("a mouse selection across both Fact fields refuses copy without retargeting", () => {
    const state = initialState(demoAppSource(), false);
    const composer = createComposer("Body stays whole.");
    composer.anchor = 0;
    composer.cursor = 4;
    const tag = createComposer("people");
    state.mode = "EDITOR";
    state.editor = {
      kind: "fact",
      target: { kind: "fact", factId: null, base: null },
      composer,
      tag,
      activation: "always",
      keys: createComposer(""),
      secondary: createComposer(""), secondaryMode: "and", scan: createComposer(""), recursion: "on",
      priority: "normal",
      budget: createComposer(""),
      focus: "body",
      initialFact: {
        tag: "people", activation: "always", keys: [], secondaryKeys: [], secondaryMode: "and", scanDepth: undefined, recursion: "on", priority: "normal", budgetTokens: undefined, text: composer.text
      },
      title: "edit fact",
      placeholder: "fact text…",
      returnMode: "FACTS",
      conflict: null
    };
    const frame = renderStoryScreen(state, { width: 40, height: 12 });
    const projection = frame.derived.composerSelectionProjection!;
    const displayStart = projection.findIndex((cell) =>
      cell?.sourceId === FACT_TAG_COMPOSER_SOURCE && cell.start === 0);
    const displayLast = projection.findIndex((cell) =>
      cell?.sourceId === FACT_BODY_COMPOSER_SOURCE && cell.start === 3);
    const renderer = {
      getSelection: () => ({
        getSelectedText: () => "people…Body",
        selectedRenderables: [{
          getSelection: () => ({ start: displayStart, end: displayLast + 1 })
        }]
      })
    } as never;

    const result = copyActiveSelection(renderer, state, async () => "command", {
      composer: projection,
      story: null
    });

    expect(result).toBe(null);
    expect(state.toast).toBe("select the Fact tag, keys, or text");
    expect(state.editor.focus).toBe("body");
    expect(selectedComposerText(composer)).toBe("Body");
    expect(selectedComposerText(tag)).toBe(null);
  });

  test("Ctrl+C copies a decoded display-only Fact tag", async () => {
    const state = initialState(demoAppSource(), false);
    const composer = createComposer("Body stays whole.");
    state.mode = "EDITOR";
    state.editor = {
      kind: "fact",
      target: { kind: "fact", factId: null, base: null },
      composer,
      tag: createComposer("weather\nurgent"),
      activation: "always",
      keys: createComposer(""),
      secondary: createComposer(""), secondaryMode: "and", scan: createComposer(""), recursion: "on",
      priority: "normal",
      budget: createComposer(""),
      focus: "body",
      initialFact: {
        tag: "weather\nurgent", activation: "always", keys: [], secondaryKeys: [], secondaryMode: "and", scanDepth: undefined, recursion: "on",
        priority: "normal", budgetTokens: undefined, text: composer.text
      },
      title: "edit fact",
      placeholder: "fact text…",
      returnMode: "FACTS",
      conflict: null
    };
    const width = 50;
    const frame = renderStoryScreen(state, { width, height: 12 });
    const row = frame.lines.findIndex((line) => plainLine(line).includes("weather↵urgent"));
    const column = plainLine(frame.lines[row]!).indexOf("weather↵urgent");
    const stride = width + 1;
    const cells = frame.derived.composerSelectionProjection!.slice(
      row * stride + column,
      row * stride + column + "weather↵urgent".length
    );

    expect(row).toBeGreaterThan(-1);
    expect(column).toBeGreaterThan(-1);
    expect(cells.every((cell) =>
      cell?.sourceId === FACT_TAG_COMPOSER_SOURCE
        && cell.editable === false)).toBeTrue();
    const renderer = {
      getSelection: () => ({
        getSelectedText: () => "weather↵urgent",
        selectedRenderables: [{
          getSelection: () => ({
            start: row * stride + column,
            end: row * stride + column + "weather↵urgent".length
          })
        }]
      })
    } as never;
    const copied: string[] = [];
    expect(handleMainCopyShortcut(
      renderer,
      state,
      () => undefined,
      () => { throw new Error("copy must not quit"); },
      {
        composer: frame.derived.composerSelectionProjection,
        story: null
      },
      async (text) => {
        copied.push(text);
        return "command";
      }
    )).toBeTrue();
    await Promise.resolve();
    expect(copied).toEqual(["weather↵urgent"]);
    expect(copyActiveSelection(renderer, state, async () => "command", {
      composer: frame.derived.composerSelectionProjection,
      story: null
    })?.text).toBe("weather↵urgent");
    expect(state.editor.focus).toBe("body");
  });

  test("the synthetic empty Fact tag label has a display-only field projection", () => {
    const state = initialState(demoAppSource(), false);
    const composer = createComposer("Body stays whole.");
    state.mode = "EDITOR";
    state.editor = {
      kind: "fact",
      target: { kind: "fact", factId: null, base: null },
      composer,
      tag: createComposer(""),
      activation: "always",
      keys: createComposer(""),
      secondary: createComposer(""), secondaryMode: "and", scan: createComposer(""), recursion: "on",
      priority: "normal",
      budget: createComposer(""),
      focus: "body",
      initialFact: {
        tag: null, activation: "always", keys: [], secondaryKeys: [], secondaryMode: "and", scanDepth: undefined, recursion: "on", priority: "normal", budgetTokens: undefined, text: composer.text
      },
      title: "edit fact",
      placeholder: "fact text…",
      returnMode: "FACTS",
      conflict: null
    };
    const width = 40;
    const frame = renderStoryScreen(state, { width, height: 12 });
    const row = frame.lines.findIndex((line) => plainLine(line).includes("‹ none ›"));
    const column = plainLine(frame.lines[row]!).indexOf("none");
    const stride = width + 1;
    const cells = frame.derived.composerSelectionProjection!.slice(
      row * stride + column,
      row * stride + column + "none".length
    );

    expect(row).toBeGreaterThan(-1);
    expect(column).toBeGreaterThan(-1);
    expect(cells.every((cell) =>
      cell?.sourceId === FACT_TAG_COMPOSER_SOURCE
        && cell.editable === false)).toBeTrue();
    expect(composer.text).toBe("Body stays whole.");
  });

  test("a backward mouse drag keeps its active edge for Shift+Arrow", () => {
    const state = initialState(demoAppSource(), false);
    state.mode = "COMPOSE";
    state.composer = createComposer("alpha\nbeta");
    state.composer.fullscreen = true;
    const frame = renderStoryScreen(state, { width: 80, height: 24 });
    state.composerSelectionProjection = frame.derived.composerSelectionProjection;
    const projection = state.composerSelectionProjection!;
    const displayStart = projection.findIndex((cell) => cell?.start === 1);
    const displayLast = projection.findIndex((cell) => cell?.start === 7);
    const renderer = {
      getSelection: () => ({
        getSelectedText: () => "lpha\nbe",
        anchor: { x: 1, y: 1 },
        focus: { x: 0, y: 0 },
        selectedRenderables: [{
          getSelection: () => ({ start: displayStart, end: displayLast + 1 })
        }]
      })
    } as never;

    copyActiveSelection(renderer, state, async () => "command");

    expect(state.composer.cursor).toBe(1);
    expect(state.composer.anchor).toBe(8);
    moveComposerHorizontal(state.composer, -1, true);
    expect(selectedComposerText(state.composer)).toBe("alpha\nbe");
  });
});

function nativeSelection(text: string, start: number, end: number) {
  return {
    getSelectedText: () => text,
    anchor: { x: start, y: 0 },
    focus: { x: end, y: 0 },
    selectedRenderables: [{ getSelection: () => ({ start, end }) }]
  } as never;
}
