import { describe, expect, test } from "bun:test";
import { INERT_UPDATE_CHECK_LIFECYCLE } from "../src/action-context.js";
import {
  applyBasicSettingsDraft,
  basicSettingsFromDocument
} from "../../shared/settings-basic-draft.js";
import type { SettingsView } from "../../shared/settings-v2-types.js";
import {
  composerSelection,
  setComposerText,
  type ComposerState
} from "../src/composer-model.js";

type ClipboardReader = () => Promise<string | null>;
type ClipboardWriter = (text: string) => Promise<"command" | "internal">;

const bunTest = await import("bun:test") as unknown as {
  mock: {
    module(path: string, factory: () => Record<string, unknown>): void;
  };
};
let clipboardReader: ClipboardReader = async () => null;
let clipboardWriter: ClipboardWriter = async () => "internal";
bunTest.mock.module("../src/clipboard.js", () => ({
  readFromClipboard: () => clipboardReader(),
  // Every composer-backed field this suite exercises (settings values,
  // Sampling fields, Fact fields) reads the typed union through
  // composer-surface-action.ts now; this mock answers it with the same
  // plain text every clipboardReader fixture in this file already sets up.
  readClipboardContent: async () => {
    const text = await clipboardReader();
    return text === null ? null : { type: "text", text };
  },
  copyToClipboard: (text: string) => clipboardWriter(text)
}));

const {
  deferred,
  key,
  openSettings,
  selectRow,
  settingsHarness
} = await import("./settings-test-harness.js");
const { EMPTY_NATIVE_SELECTION, handleMainCopyShortcut } = await import("../src/copy-actions.js");
const { openTextActions } = await import("../src/text-actions.js");
const { dispatch } = await import("../src/app.js");
const { openFactEditor } = await import("../src/editor-action.js");
const {
  FACT_ACTIVATION_COMPOSER_SOURCE,
  FACT_BODY_COMPOSER_SOURCE,
  FACT_TAG_COMPOSER_SOURCE
} = await import("../src/fact-editor-policy.js");
const { buildComposerSelectionProjection } = await import("../src/selection-projection.js");
const { fitLine } = await import("../src/screens/story/frame.js");

describe("Direct clipboard ownership", () => {
  test("an unconfirmed cut needs two consecutive presses", async () => {
    const { state, press } = settingsHarness();
    state.mode = "COMPOSE";
    setComposerText(state.composer, "alpha beta");
    state.composer.anchor = 6;
    clipboardWriter = async () => "internal";

    await press(key("x", { ctrl: true }));
    expect(state.composer.text).toBe("alpha beta");
    expect(state.toast).toBe("clipboard write unconfirmed · cut again to confirm");

    await press(key("escape"));
    await press(key("return"));
    await press(key("x", { ctrl: true }));
    expect(state.composer.text).toBe("alpha beta");
    expect(state.toast).toBe("clipboard write unconfirmed · cut again to confirm");

    await press(key("x", { ctrl: true }));
    expect(state.composer.text).toBe("alpha ");
    expect(state.toast).toBe("selection cut");
  });

  test("cut, undo, and redo operate every composer-backed editor", async () => {
    clipboardWriter = async () => "command";
    const cases: {
      name: string;
      open: () => Promise<{
        composer: ComposerState;
        press: ReturnType<typeof settingsHarness>["press"];
      }>;
      cut: ReturnType<typeof key>;
    }[] = [
      {
        name: "Direct",
        open: async () => {
          const harness = settingsHarness();
          harness.state.mode = "COMPOSE";
          return { composer: harness.state.composer, press: harness.press };
        },
        cut: key("x", { ctrl: true })
      },
      {
        name: "full editor",
        open: async () => {
          const harness = settingsHarness();
          await harness.press(key("f"));
          await harness.press(key("return"));
          if (harness.state.editor === null) throw new Error("editor did not open");
          return { composer: harness.state.editor.composer, press: harness.press };
        },
        cut: key("x", { super: true })
      },
      {
        name: "Settings field",
        open: async () => {
          const harness = settingsHarness();
          await openSettings(harness.press);
          await selectRow(harness.press, harness.state, "base-url");
          await harness.press(key("return"));
          const edit = harness.state.settings?.edit;
          if (edit?.kind !== "inline") throw new Error("Settings field did not open");
          return { composer: edit.composer, press: harness.press };
        },
        cut: key("x", { ctrl: true })
      },
      {
        name: "Sampling field",
        open: async () => {
          const harness = await openSamplingEdit();
          const edit = harness.state.settings?.sampling?.edit;
          if (edit === null || edit === undefined) throw new Error("Sampling field did not open");
          return { composer: edit.composer, press: harness.press };
        },
        cut: key("x", { super: true })
      }
    ];

    for (const editorCase of cases) {
      const { composer, press } = await editorCase.open();
      setComposerText(composer, "alpha beta");
      composer.anchor = 6;

      await press(editorCase.cut);
      expect({ name: editorCase.name, text: composer.text })
        .toEqual({ name: editorCase.name, text: "alpha " });

      await press(key("z", { ctrl: true }));
      expect({ name: editorCase.name, text: composer.text })
        .toEqual({ name: editorCase.name, text: "alpha beta" });

      await press(key("z", { super: true, shift: true }));
      expect({ name: editorCase.name, text: composer.text })
        .toEqual({ name: editorCase.name, text: "alpha " });
    }
  });

  test("Command+C without a selection does not quit", async () => {
    let quits = 0;
    const { state, press } = settingsHarness(() => { quits += 1; });

    await press(key("c", { super: true }));

    expect(state.mode).toBe("NAV");
    expect(quits).toBe(0);
  });

  test("pastes into inline and fullscreen drafts with Control or Command", async () => {
    const cases = [
      { fullscreen: false, key: key("v", { ctrl: true }) },
      { fullscreen: true, key: key("v", { super: true }) }
    ];
    for (const clipboardCase of cases) {
      const { state, press } = settingsHarness();
      state.mode = "COMPOSE";
      setComposerText(state.composer, "before after");
      state.composer.cursor = 7;
      state.composer.fullscreen = clipboardCase.fullscreen;
      clipboardReader = async () => "pasted\ntext";

      await press(clipboardCase.key);

      expect(state.composer.text).toBe("before pasted\ntextafter");
      expect(state.composer.fullscreen).toBe(clipboardCase.fullscreen);
    }
  });

  test("Control+A selects the complete inline and fullscreen draft", async () => {
    for (const fullscreen of [false, true]) {
      const { state, press } = settingsHarness();
      state.mode = "COMPOSE";
      setComposerText(state.composer, "select the complete draft");
      state.composer.cursor = 7;
      state.composer.fullscreen = fullscreen;

      await press(key("a", { ctrl: true }));

      expect(composerSelection(state.composer)).toEqual({
        start: 0,
        end: state.composer.text.length
      });
    }
  });

  test("the context menu pastes and selects all without leaving Direct", async () => {
    const { state, press } = settingsHarness();
    state.mode = "COMPOSE";
    setComposerText(state.composer, "draft ");
    clipboardReader = async () => "from clipboard";
    state.abort = { kind: "generation" } as never;

    openTextActions(state);
    expect(state.textActions?.cursor).toBe(1);
    await press(key("return"));

    expect(state.mode).toBe("COMPOSE");
    expect(state.composer.text).toBe("draft from clipboard");
    expect(state.toast).toBe(null);
    state.abort = null;

    openTextActions(state);
    await press(key("down"));
    await press(key("return"));
    expect(composerSelection(state.composer)).toEqual({
      start: 0,
      end: state.composer.text.length
    });

    const copied: string[] = [];
    clipboardWriter = async (text) => {
      copied.push(text);
      return "internal";
    };
    openTextActions(state);
    expect(state.textActions?.cursor).toBe(0);
    await press(key("return"));
    await Promise.resolve();
    expect(copied).toEqual(["draft from clipboard"]);
  });

  test("the context menu refuses a composer changed after it opened", async () => {
    const { state, press } = settingsHarness();
    state.mode = "COMPOSE";
    setComposerText(state.composer, "original draft");
    openTextActions(state);
    setComposerText(state.composer, "refreshed draft");
    clipboardReader = async () => "must not paste";

    await press(key("return"));

    expect(state.textActions).toBe(null);
    expect(state.composer.text).toBe("refreshed draft");
    expect(state.toast).toBe("editor changed · open the menu again");
  });

  test("copies selected text from inline and fullscreen drafts", async () => {
    for (const fullscreen of [false, true]) {
      const { state } = settingsHarness();
      state.mode = "COMPOSE";
      setComposerText(state.composer, "copy this draft");
      state.composer.anchor = 5;
      state.composer.fullscreen = fullscreen;
      const copied: string[] = [];
      clipboardWriter = async (text) => {
        copied.push(text);
        return "internal";
      };

      expect(handleMainCopyShortcut(
        EMPTY_NATIVE_SELECTION,
        state,
        () => undefined,
        () => { throw new Error("copy must not quit"); }
      )).toBeTrue();
      await Promise.resolve();

      expect(copied).toEqual(["this draft"]);
      expect(state.composer.fullscreen).toBe(fullscreen);
    }
  });

  test("ignores a clipboard read after the draft changes", async () => {
    const { state, press } = settingsHarness();
    state.mode = "COMPOSE";
    setComposerText(state.composer, "seed");
    const read = deferred<string | null>();
    const started = deferred<void>();
    clipboardReader = async () => {
      started.resolve();
      return read.promise;
    };

    const paste = press(key("v", { ctrl: true }));
    await started.promise;
    await press(key("x"));
    read.resolve("late clipboard text");
    await paste;

    expect(state.composer.text).toBe("seedx");
    expect(state.toast).toBe(null);
  });
});

describe("nested Sampling clipboard ownership", () => {
  test("Control+C cannot quit with an active Sampling editor", async () => {
    let quits = 0;
    const { state, press } = await openSamplingEdit(() => { quits += 1; });

    await press(key("c", { ctrl: true }));
    openTextActions(state);
    await press(key("c", { ctrl: true }));

    expect(quits).toBe(0);
    expect(state.textActions).not.toBe(null);
  });

  test("the context menu copies from the active Sampling editor", async () => {
    const { state, press } = await openSamplingEdit();
    const composer = state.settings!.sampling!.edit!.composer;
    setComposerText(composer, "0.7");
    composer.anchor = 0;
    const copied: string[] = [];
    clipboardWriter = async (text) => {
      copied.push(text);
      return "internal";
    };

    openTextActions(state);
    expect(state.textActions?.cursor).toBe(0);
    await press(key("return"));
    await Promise.resolve();

    expect(copied).toEqual(["0.7"]);
  });

  test("ignores a late read after every owner-changing action and applies a current paste", async () => {
    const staleCases: readonly {
      name: string;
      change: (
        state: ReturnType<typeof settingsHarness>["state"],
        press: ReturnType<typeof settingsHarness>["press"]
      ) => Promise<void>;
      assertStale: (state: ReturnType<typeof settingsHarness>["state"]) => void;
    }[] = [
      {
        name: "typing",
        change: async (_state, press) => { await press(key("x")); },
        assertStale: (state) => {
          expect(state.settings?.sampling?.edit?.composer.text).toBe("x");
        }
      },
      {
        name: "cursor movement",
        change: async (_state, press) => { await press(key("left")); },
        assertStale: (state) => {
          expect(state.settings?.sampling?.edit?.composer.text).toBe("seed");
          expect(state.settings?.sampling?.edit?.composer.cursor).toBe(3);
        }
      },
      {
        name: "edit replacement",
        change: async (_state, press) => {
          await press(key("escape"));
          await press(key("return"));
        },
        assertStale: (state) => {
          expect(state.settings?.sampling?.edit?.composer.text).toBe("");
        }
      },
      {
        name: "nested close",
        change: async (_state, press) => {
          await press(key("escape"));
          await press(key("escape"));
        },
        assertStale: (state) => {
          expect(state.settings?.sampling).toBe(null);
          expect(state.toast).toBe("sampling closed · draft kept");
        }
      },
      {
        name: "Settings replacement",
        change: async (_state, press) => {
          await press(key("escape"));
          await press(key("escape"));
          await press(key("escape"));
        },
        assertStale: (state) => {
          expect(state.settings).toBe(null);
          expect(state.mode).toBe("NAV");
          expect(state.toast).toBe(null);
        }
      }
    ];

    for (const staleCase of staleCases) {
      const { state, press } = await openSamplingEdit();
      if (staleCase.name === "cursor movement") {
        const edit = state.settings?.sampling?.edit;
        if (edit === null || edit === undefined) throw new Error("Sampling edit did not open");
        setComposerText(edit.composer, "seed");
      }
      const read = deferred<string | null>();
      const started = deferred<void>();
      clipboardReader = async () => {
        started.resolve();
        return read.promise;
      };
      const paste = press(key("v", { ctrl: true }));
      await started.promise;
      await staleCase.change(state, press);
      read.resolve("late clipboard text");
      await paste;
      staleCase.assertStale(state);
      expect(state.toast === null || !state.toast.includes("clipboard")).toBeTrue();
    }

    const { state, press } = await openSamplingEdit();
    if (state.settings === null) throw new Error("Settings did not open");
    state.settings.conflict = { message: "Settings changed", armed: true };
    clipboardReader = async () => "0.7";
    await press(key("v", { ctrl: true }));

    expect(state.settings.sampling?.edit?.composer.text).toBe("0.7");
    expect(state.settings.conflict.armed).toBeFalse();
    expect(state.toast).toBe(null);
  });
});

test("the context menu copies a display-only Fact choice", async () => {
  const { state, source, cache, backend, press } = settingsHarness();
  openFactEditor(state, null);
  const text = "always";
  const projection = buildComposerSelectionProjection([fitLine([{
    text,
    composerSource: { id: FACT_ACTIVATION_COMPOSER_SOURCE, editable: false }
  }], 20)], 20)!;
  const identity = {};
  const copied: string[] = [];
  clipboardWriter = async (value) => {
    copied.push(value);
    return "internal";
  };

  await dispatch(
    {
      action: "open-text-actions",
      nativeSelection: {
        identity,
        text,
        range: { start: 0, end: text.length },
        backward: false
      },
      composerSelectionProjection: projection
    },
    state,
    source,
    cache,
    () => undefined,
    async () => undefined,
    () => undefined,
    {
      updateChecks: INERT_UPDATE_CHECK_LIFECYCLE,
      renderer: null,
      applyTheme: () => undefined,
      previewTheme: () => undefined,
      backend
    }
  );
  expect(state.textActions?.cursor).toBe(0);
  expect(state.textActions?.copyOnly).toBeTrue();

  await press(key("return"));
  await Promise.resolve();

  expect(copied).toEqual([text]);
});

test("a Fact context menu keeps the clicked field over an old field selection", async () => {
  const { state, source, cache, backend, press } = settingsHarness();
  openFactEditor(state, null);
  const editor = state.editor;
  if (editor?.kind !== "fact") throw new Error("Fact editor did not open");
  setComposerText(editor.tag, "weather");
  setComposerText(editor.composer, "body");
  const projection = buildComposerSelectionProjection([fitLine([{
    text: "weather",
    composerStart: 0,
    composerSource: { id: FACT_TAG_COMPOSER_SOURCE, editable: true }
  }], 20)], 20)!;

  await dispatch(
    {
      action: "open-text-actions",
      composerSourceId: FACT_BODY_COMPOSER_SOURCE,
      nativeSelection: {
        identity: {},
        text: "weather",
        range: { start: 0, end: 7 },
        backward: false
      },
      composerSelectionProjection: projection
    },
    state,
    source,
    cache,
    () => undefined,
    async () => undefined,
    () => undefined,
    {
      updateChecks: INERT_UPDATE_CHECK_LIFECYCLE,
      renderer: null,
      applyTheme: () => undefined,
      previewTheme: () => undefined,
      backend
    }
  );
  expect(state.textActions?.owner === editor.composer).toBeTrue();
  clipboardReader = async () => " pasted";
  await press(key("return"));

  expect(editor.tag.text).toBe("weather");
  expect(editor.composer.text).toBe("body pasted");
});

test("a mixed Fact selection does not open an editor menu", async () => {
  const { state, source, cache, backend } = settingsHarness();
  openFactEditor(state, null);
  const projection = buildComposerSelectionProjection([fitLine([
    {
      text: "tag",
      composerStart: 0,
      composerSource: { id: "fact-tag", editable: true }
    },
    {
      text: "body",
      composerStart: 0,
      composerSource: { id: "fact-body", editable: true }
    }
  ], 20)], 20)!;

  await dispatch(
    {
      action: "open-text-actions",
      nativeSelection: {
        identity: {},
        text: "tagbody",
        range: { start: 0, end: 7 },
        backward: false
      },
      composerSelectionProjection: projection
    },
    state,
    source,
    cache,
    () => undefined,
    async () => undefined,
    () => undefined,
    {
      updateChecks: INERT_UPDATE_CHECK_LIFECYCLE,
      renderer: null,
      applyTheme: () => undefined,
      previewTheme: () => undefined,
      backend
    }
  );

  expect(state.textActions).toBe(null);
  expect(state.toast).toBe("select the Fact tag, keys, or text");
});

async function openSamplingEdit(requestQuit: () => void = () => undefined) {
  const harness = settingsHarness(requestQuit);
  useSupportedSettings(harness.source);
  await openSettings(harness.press);
  await selectRow(harness.press, harness.state, "sampling");
  await harness.press(key("return"));
  await harness.press(key("return"));
  if (harness.state.settings?.sampling?.edit === null
    || harness.state.settings?.sampling?.edit === undefined) {
    throw new Error("Sampling edit did not open");
  }
  return harness;
}

function useSupportedSettings(source: ReturnType<typeof settingsHarness>["source"]): void {
  const active = source.settingsView;
  if (!active.editable) throw new Error("demo settings must be editable");
  const generation = {
    ...source.settings,
    provider: "openai-compatible" as const,
    baseUrl: "http://127.0.0.1:8080/v1",
    model: "gpt-5.2",
    apiKeyEnv: null
  };
  const document = applyBasicSettingsDraft(active.document, generation);
  source.settingsView = {
    ...active,
    document,
    effective: basicSettingsFromDocument(document)
  } satisfies SettingsView;
  source.api.getSettings = async () => source.settingsView;
}
