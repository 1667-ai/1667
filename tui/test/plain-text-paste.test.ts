import { describe, expect, test } from "bun:test";

type ClipboardReader = () => Promise<string | null>;

const bunTest = await import("bun:test") as unknown as {
  mock: { module(path: string, factory: () => Record<string, unknown>): void };
};
let clipboardReader: ClipboardReader = async () => null;
bunTest.mock.module("../src/clipboard.js", () => ({
  readFromClipboard: () => clipboardReader(),
  readClipboardContent: async () => {
    const text = await clipboardReader();
    return text === null ? null : { type: "text", text };
  },
  copyToClipboard: async () => "internal"
}));

const {
  deferred,
  key,
  openSettings,
  settingsHarness
} = await import("./settings-test-harness.js");
const { dispatch } = await import("../src/app.js");
const { openSearch } = await import("../src/search-actions.js");
const { openTag } = await import("../src/story-actions.js");
const { openLibrary } = await import("../src/library-actions.js");
const { openCardImport } = await import("../src/card-import-actions.js");
const { openArchiveImport } = await import("../src/archive-import-actions.js");
const {
  createAsideSurface,
  isAsideV2
} = await import("../src/aside-surface.js");
const { setComposerText } = await import("../src/composer-model.js");
const { openSettingsPasteTarget } = await import("../src/settings-prompt-editor.js");
const { handleOverlayAction } = await import("../src/overlay-actions.js");
const { applyTerminalPaste } = await import("../src/terminal-paste.js");
const { openAsideUseMenu } = await import("../src/aside-use.js");

describe("plain-text paste", () => {
  test("Ctrl/Cmd+V inserts into every plain-string prompt", async () => {
    const paste = async (
      setup: (harness: ReturnType<typeof settingsHarness>) => Promise<void> | void,
      event: ReturnType<typeof key>,
      expected: (harness: ReturnType<typeof settingsHarness>) => string | undefined
    ): Promise<void> => {
      const harness = settingsHarness();
      await setup(harness);
      clipboardReader = async () => "from\nclipboard";
      await harness.press(event);
      expect(expected(harness)).toBe("from clipboard");
    };

    await paste(
      (harness) => {
        harness.source.searchDebounceMs = 0;
        openSearch(harness.state, harness.source);
      },
      key("v", { ctrl: true }),
      (harness) => harness.state.search?.query
    );
    await paste(
      async (harness) => {
        await dispatch({ action: "open-facts" }, harness.state, harness.source, harness.cache,
          () => undefined, async () => undefined, () => undefined);
        await harness.press(key("/"));
      },
      key("v", { super: true }),
      (harness) => harness.state.facts?.query
    );
    await paste(
      async (harness) => {
        await openLibrary(harness.state, harness.source, {
          cache: harness.cache,
          backend: harness.backend,
          repaint: () => undefined,
          renderer: null,
          applyTheme: () => undefined,
          previewTheme: () => undefined
        });
        await harness.press(key("/"));
      },
      key("v", { ctrl: true }),
      (harness) => harness.state.library?.query
    );
    await paste(
      async (harness) => {
        await dispatch({ action: "open-commands" }, harness.state, harness.source, harness.cache,
          () => undefined, async () => undefined, () => undefined);
      },
      key("v", { super: true }),
      (harness) => harness.state.commands?.query
    );
    await paste(
      (harness) => {
        openTag(harness.state);
        if (harness.state.tag !== null) {
          harness.state.tag.name = "";
          harness.state.tag.deleteArmed = true;
        }
      },
      key("v", { ctrl: true }),
      (harness) => {
        expect(harness.state.tag?.deleteArmed).toBeFalse();
        return harness.state.tag?.name;
      }
    );
    await paste(
      (harness) => openCardImport(harness.state),
      key("v", { super: true }),
      (harness) => harness.state.card?.path
    );
    await paste(
      (harness) => openArchiveImport(harness.state),
      key("v", { ctrl: true }),
      (harness) => harness.state.archive?.path
    );
    await paste(
      (harness) => {
        harness.state.image = {
          path: "",
          storyId: harness.state.payload.id,
          candidates: [],
          error: null,
          returnMode: "NAV"
        };
        harness.state.mode = "IMAGE";
      },
      key("v", { super: true }),
      (harness) => harness.state.image?.path
    );
    await paste(
      async (harness) => {
        await openSettings(harness.press);
        const overlay = harness.state.settings!;
        overlay.modelPicker = { query: "", cursor: 3 };
      },
      key("v", { ctrl: true }),
      (harness) => {
        expect(harness.state.settings?.modelPicker?.cursor).toBe(0);
        expect(harness.state.settings?.edit).toBeNull();
        return harness.state.settings?.modelPicker?.query;
      }
    );
    await paste(
      async (harness) => {
        await openSettings(harness.press);
        harness.state.settings!.profileTransfer = {
          phase: "file",
          path: "",
          error: "stale error",
          candidates: ["/tmp/stale.preset"]
        };
      },
      key("v", { super: true }),
      (harness) => {
        const transfer = harness.state.settings?.profileTransfer;
        if (transfer?.phase !== "file") return undefined;
        expect(transfer.error).toBeNull();
        expect(transfer.candidates).toEqual([]);
        return transfer.path;
      }
    );
  });

  test("bracketed paste targets the visible Settings model picker", async () => {
    const harness = settingsHarness();
    await openSettings(harness.press);
    const overlay = harness.state.settings!;
    overlay.modelPicker = { query: "existing ", cursor: 2 };

    expect(openSettingsPasteTarget(harness.state)).toBeNull();
    expect(await applyTerminalPaste(
      "  chosen\n  model  ",
      harness.state,
      harness.source,
      {
      cache: harness.cache,
      backend: harness.backend,
      repaint: () => undefined,
      renderer: null,
      applyTheme: () => undefined,
      previewTheme: () => undefined
      }
    )).toBeTrue();
    expect(overlay.modelPicker.query).toBe("existing chosen model");
    expect(overlay.modelPicker.cursor).toBe(0);
    expect(overlay.edit).toBeNull();
  });

  test("Commands paste keeps selection and live theme preview in sync", async () => {
    const harness = settingsHarness();
    await dispatch({ action: "open-commands" }, harness.state, harness.source, harness.cache,
      () => undefined, async () => undefined, () => undefined);
    clipboardReader = async () => "theme: parchment";
    const previews: Array<string | null> = [];

    await dispatch(
      { action: "paste-clipboard" },
      harness.state,
      harness.source,
      harness.cache,
      () => undefined,
      async () => undefined,
      () => undefined,
      null,
      () => undefined,
      (theme) => previews.push(theme),
      harness.backend
    );

    expect(harness.state.commands?.query).toBe("theme: parchment");
    expect(harness.state.commands?.selectedId).toBe("theme:parchment");
    expect(harness.state.commands?.cursor).toBeGreaterThan(-1);
    expect(previews.at(-1)).toBe("parchment");
  });

  test("a deferred palette clipboard read preserves an Aside question during settlement", async () => {
    for (const outcome of ["null", "failure"] as const) {
      const harness = settingsHarness();
      const surface = createAsideSurface(
        harness.state.payload.id,
        harness.state.payload.title
      );
      harness.state.aside = surface;
      harness.state.mode = "ASIDE";
      const question = "restore this question";
      setComposerText(surface.composer, question);

      const settle = deferred<void>();
      harness.source.api.askAside = async () => {
        await settle.promise;
        if (outcome === "null") return null;
        throw new Error("Aside failed");
      };
      await harness.press(key("return", { sequence: "\r" }));
      expect(surface.busy).toBeTrue();

      await harness.press(key("p", { sequence: "\u0010", ctrl: true }));
      expect(harness.state.commands?.returnMode).toBe("ASIDE");

      const readStarted = deferred<void>();
      const read = deferred<string | null>();
      clipboardReader = async () => {
        readStarted.resolve();
        return await read.promise;
      };
      const pasting = harness.press(key("v", { ctrl: true }));
      await readStarted.promise;

      // The Ask can settle while Ctrl+V still waits on the host clipboard.
      settle.resolve();
      await harness.backend.whenIdle();
      expect(surface.composer.text).toBe(question);
      expect(surface.busy).toBeFalse();

      read.resolve(null);
      await pasting;
      expect(surface.composer.text).toBe(question);
    }
  });

  test("a late clipboard read cannot modify a closed plain prompt", async () => {
    const harness = settingsHarness();
    openCardImport(harness.state);
    const read = deferred<string | null>();
    const started = deferred<void>();
    clipboardReader = async () => {
      started.resolve();
      return read.promise;
    };

    const paste = harness.press(key("v", { ctrl: true }));
    await started.promise;
    await harness.press(key("escape"));
    read.resolve("stale path");
    await paste;

    expect(harness.state.mode).toBe("NAV");
    expect(harness.state.card).toBeNull();
  });

  test("bracketed Aside paste disarms v2 destructive confirmations", async () => {
    for (const confirmation of ["reset", "delete"] as const) {
      const harness = settingsHarness();
      const surface = createAsideSurface(
        harness.state.payload.id,
        harness.state.payload.title,
        [{
          id: "session-1",
          title: "current",
          anchor: null,
          turns: [{ q: "Why?", a: "Because." }]
        }],
        null,
        null,
        { v2: true }
      );
      if (!isAsideV2(surface)) throw new Error("expected an Aside session surface");
      surface.focus = "turns";
      if (confirmation === "reset") surface.confirmReset = { turnIndex: 0 };
      else surface.confirmDelete = { rowId: "answer-0" };
      harness.state.aside = surface;
      harness.state.mode = "ASIDE";

      expect(await applyTerminalPaste(
        "pasted question",
        harness.state,
        harness.source,
        {
          cache: harness.cache,
          backend: harness.backend,
          repaint: () => undefined,
          renderer: null,
          applyTheme: () => undefined,
          previewTheme: () => undefined
        }
      )).toBeTrue();
      expect(surface.focus).toBe("composer");
      expect(surface.confirmReset).toBeNull();
      expect(surface.confirmDelete).toBeNull();
      expect(surface.composer.text).toBe("pasted question");
    }
  });

  test("bracketed Aside paste commits an optimistic v2 deletion", async () => {
    const harness = settingsHarness();
    let deletes = 0;
    harness.source.api.deleteAsideTurn = async () => {
      deletes += 1;
      return {
        schemaVersion: 2,
        id: "session-1",
        anchor: null,
        title: "current",
        turns: [{ q: "First?", a: "One." }]
      };
    };
    const surface = createAsideSurface(
      harness.state.payload.id,
      harness.state.payload.title,
      [{
        id: "session-1",
        title: "current",
        anchor: null,
        turns: [{ q: "First?", a: "One." }, { q: "Second?", a: "Two." }]
      }],
      null,
      null,
      { v2: true }
    );
    if (!isAsideV2(surface)) throw new Error("expected an Aside session surface");
    surface.focus = "turns";
    surface.turnCursor = 1;
    harness.state.aside = surface;
    harness.state.mode = "ASIDE";
    const context = {
      cache: harness.cache,
      backend: harness.backend,
      repaint: () => undefined,
      renderer: null,
      applyTheme: () => undefined,
      previewTheme: () => undefined
    };

    await handleOverlayAction({ action: "aside-delete" }, harness.state, harness.source, context);
    await handleOverlayAction({ action: "aside-delete" }, harness.state, harness.source, context);
    expect(surface.deleteUndo).not.toBeNull();

    expect(await applyTerminalPaste(
      "follow up", harness.state, harness.source, context
    )).toBeTrue();
    await harness.backend.settle();

    expect(deletes).toBe(1);
    expect(surface.deleteUndo).toBeNull();
    expect(surface.composer.text).toBe("follow up");
  });

  test("terminal paste cannot pass an open Aside use menu", async () => {
    const harness = settingsHarness();
    const surface = createAsideSurface(
      harness.state.payload.id,
      harness.state.payload.title,
      [{ question: "Why?", answer: "Because." }]
    );
    surface.focus = "notes";
    expect(openAsideUseMenu(surface, 0)).toBeTrue();
    harness.state.aside = surface;
    harness.state.mode = "ASIDE";
    const version = harness.state.interactionVersion;

    expect(await applyTerminalPaste(
      "must not paste",
      harness.state,
      harness.source,
      {
        cache: harness.cache,
        backend: harness.backend,
        repaint: () => undefined,
        renderer: null,
        applyTheme: () => undefined,
        previewTheme: () => undefined
      }
    )).toBeFalse();

    expect(surface.useMenu).not.toBeNull();
    expect(surface.composer.text).toBe("");
    expect(harness.state.interactionVersion).toBe(version);
  });
});
