import { describe, expect, test } from "bun:test";
import { applyBasicSettingsDraft } from "../../shared/settings-basic-draft.js";
import { moveComposerHorizontal, setComposerText } from "../src/composer-model.js";
import { copyActiveSelection } from "../src/copy-actions.js";
import { openSettingsPasteTarget } from "../src/editor-open.js";
import { pasteInto } from "../src/keys.js";
import { publishSettingsView } from "../src/overlay-publication.js";
import { settingsDraftChanged } from "../src/settings-overlay-model.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { frameText, lineWidth } from "../src/screens/story/frame.js";
import type {
  InlineEditorSession,
  RuntimeState,
} from "../src/state.js";
import { createWrapCache } from "../src/wrap.js";
import {
  deferred,
  draftRow,
  key,
  openSettings,
  selectRow,
  settingsHarness
} from "./settings-test-harness.js";

function promptEdit(state: RuntimeState): InlineEditorSession {
  const edit = state.editor;
  if (state.mode !== "EDITOR"
    || edit?.kind !== "document"
    || edit.target.kind !== "settings-prompt") {
    throw new Error("Settings editor did not open");
  }
  return edit;
}

describe("full-screen Settings prompt editor", () => {
  test("preserves unrelated stored whitespace", async () => {
    const { source, state, press } = settingsHarness();
    const prompt = "Keep  this\tspacing\nand indentation.";
    if (!source.settingsView.editable) throw new Error("demo settings must be editable");
    source.settingsView = {
      ...source.settingsView,
      document: applyBasicSettingsDraft(source.settingsView.document, {
        ...source.settings,
        systemPrompt: prompt
      }),
      effective: { ...source.settings, systemPrompt: prompt }
    };
    source.api.getSettings = async () => source.settingsView;
    await openSettings(press);

    await selectRow(press, state, "system-prompt");
    await press(key("return"));
    expect(state.mode).toBe("EDITOR");
    expect(state.editor?.kind).toBe("document");
    expect(state.settings !== null).toBe(true);
    expect(state.settings?.edit).toBe(null);
    const edit = promptEdit(state);
    expect(edit.composer.text).toBe(prompt);
    expect(frameText(renderStoryScreen(
      state,
      { width: 80, height: 24, wrapCache: createWrapCache() }
    ).lines)).toContain("┏━ system prompt");
    setComposerText(
      edit.composer,
      edit.composer.text.replace("indentation", "structure")
    );
    await press(key("s", { ctrl: true }));

    expect(state.mode).toBe("SETTINGS");
    expect(state.editor).toBe(null);
    expect(state.settings?.draft.generation.systemPrompt)
      .toBe("Keep  this\tspacing\nand structure.");
    expect(settingsDraftChanged(state.settings!)).toBeTrue();
  });

  test("native paste opens the editor and keeps newlines", async () => {
    const { state, press } = settingsHarness();
    await openSettings(press);
    await selectRow(press, state, "system-prompt");

    expect(openSettingsPasteTarget(state)).toBe("editor");
    expect(pasteInto(state, "First line\nSecond line")).toBeTrue();
    expect(state.mode).toBe("EDITOR");
    expect(state.editor?.kind).toBe("document");
    expect(state.settings !== null).toBe(true);
    expect(promptEdit(state).composer.text).toBe("First line\nSecond line");
  });

  test("text insertion disarms Settings overwrite consent", async () => {
    const { state, press } = settingsHarness();
    await openSettings(press);
    await selectRow(press, state, "system-prompt");
    await press(key("return"));
    if (state.settings === null) throw new Error("Settings did not open");
    state.settings.conflict = { message: "Settings changed", armed: true };

    await press(key("N"));

    expect(state.settings.conflict.armed).toBeFalse();
    state.settings.conflict.armed = true;

    expect(pasteInto(state, "Pasted")).toBeTrue();
    expect(state.settings.conflict.armed).toBeFalse();
  });

  test("commits a local draft while a generation streams", async () => {
    const { state, press } = settingsHarness();
    await openSettings(press);
    await selectRow(press, state, "system-prompt");
    await press(key("return"));
    setComposerText(promptEdit(state).composer, "New local prompt");
    state.stream = {
      targetId: "streaming-settings-save",
      parentId: "p7",
      append: false,
      startedAt: "2026-07-29T00:00:00.000Z",
      instruction: "Continue.",
      text: "",
      partNumber: 8
    };

    await press(key("s", { ctrl: true }));

    expect(state.mode).toBe("SETTINGS");
    expect(state.settings?.draft.generation.systemPrompt).toBe("New local prompt");
    expect(state.stream?.targetId).toBe("streaming-settings-save");
    expect(state.toast).toBe("system prompt updated · s saves settings");
  });

  test("keeps a wide-character caret visible in a short terminal", async () => {
    const { state, cache, press } = settingsHarness();
    await openSettings(press);
    await selectRow(press, state, "system-prompt");
    await press(key("return"));
    setComposerText(promptEdit(state).composer, `${"界".repeat(40)}END`);

    let rendered = frameText(renderStoryScreen(
      state,
      { width: 60, height: 20, wrapCache: cache }
    ).lines);

    expect(rendered).toContain("┏━ system prompt");
    expect(rendered).toContain("END");
    expect(rendered).not.toContain("▸ system prompt");

    for (let height = 10; height <= 14; height += 1) {
      rendered = frameText(renderStoryScreen(
        state,
        { width: 60, height, wrapCache: cache }
      ).lines);
      expect(rendered).toContain("┏━ system prompt");
      expect(rendered).toContain("END");
    }
  });

  test("aligns a caret and native selection after a preserved tab", async () => {
    const { state, press } = settingsHarness();
    await openSettings(press);
    await selectRow(press, state, "system-prompt");
    await press(key("return"));
    const edit = promptEdit(state);
    setComposerText(edit.composer, "a\tb");
    moveComposerHorizontal(edit.composer, -1);

    const frame = renderStoryScreen(
      state,
      { width: 60, height: 20, wrapCache: createWrapCache() }
    );
    state.composerSelectionProjection = frame.derived.composerSelectionProjection;
    const input = frame.lines[1]!;
    const caret = input.findIndex((part) =>
      part.background === "compose accent" && part.composerStart === 2);
    expect(caret).toBeGreaterThan(-1);
    expect(lineWidth(input.slice(0, caret))).toBe(7);

    const projection = state.composerSelectionProjection!;
    const tabCells = projection.flatMap((cell, display) =>
      cell?.start === 1 && cell.end === 2 ? [display] : []);
    expect(tabCells).toHaveLength(2);
    const renderer = {
      getSelection: () => ({
        getSelectedText: () => "\t",
        selectedRenderables: [{
          getSelection: () => ({
            start: tabCells[0]!,
            end: tabCells[1]! + 1
          })
        }]
      })
    } as never;

    expect(copyActiveSelection(renderer, state, async () => "command")?.text)
      .toBe("\t");
  });

  test("uses the full terminal for a short prompt", async () => {
    const { state, press } = settingsHarness();
    await openSettings(press);
    await selectRow(press, state, "system-prompt");
    await press(key("return"));

    const frame = renderStoryScreen(
      state,
      { width: 60, height: 20, wrapCache: createWrapCache() }
    );

    expect(frame.lines).toHaveLength(20);
    expect(frameText(frame.lines)).toContain("┏━ system prompt");
    expect(frameText(frame.lines)).toContain("ctrl+s keep draft");
  });

  test("clears obsolete overwrite consent when a refreshed prompt is discarded", async () => {
    const { source, state, press } = settingsHarness();
    let saves = 0;
    const saveSettings = source.api.saveSettings;
    source.api.saveSettings = async (command) => {
      saves += 1;
      return saveSettings(command);
    };
    await openSettings(press);
    await selectRow(press, state, "system-prompt");
    await press(key("return"));
    await press(key("N"));

    const current = source.settingsView;
    if (!current.editable) throw new Error("demo settings must be editable");
    const settings = { ...current.effective, maxTokens: 4_096 };
    publishSettingsView(state, source, {
      ...current,
      stateGeneration: current.stateGeneration + 1,
      activeRevision: current.activeRevision + 1,
      document: applyBasicSettingsDraft(current.document, settings),
      effective: settings
    });
    expect(state.settings?.conflict?.armed).toBeFalse();

    await press(key("escape"));

    expect(state.mode).toBe("SETTINGS");
    expect(state.settings?.edit).toBe(null);
    expect(settingsDraftChanged(state.settings!)).toBeFalse();
    expect(state.settings?.conflict).toBe(null);

    await draftRow(press, state, "max-tokens", "1024");
    await press(key("s"));
    expect(saves).toBe(1);
  });

  test("adopts successive clean prompt refreshes without a false conflict", async () => {
    const { source, state, press } = settingsHarness();
    await openSettings(press);
    await selectRow(press, state, "system-prompt");
    await press(key("return"));

    for (const systemPrompt of ["Remote prompt B", "Remote prompt C"]) {
      const current = source.settingsView;
      if (!current.editable) throw new Error("demo settings must be editable");
      const settings = { ...current.effective, systemPrompt };
      publishSettingsView(state, source, {
        ...current,
        stateGeneration: current.stateGeneration + 1,
        activeRevision: current.activeRevision + 1,
        document: applyBasicSettingsDraft(current.document, settings),
        effective: settings
      });

      expect(promptEdit(state).composer.text).toBe(systemPrompt);
      expect(promptEdit(state).initial).toBe(systemPrompt);
      expect(state.settings?.conflict).toBe(null);
    }
  });

  test("converges a prompt while the same refresh changes a sibling setting", async () => {
    const { source, state, press } = settingsHarness();
    await openSettings(press);
    await selectRow(press, state, "system-prompt");
    await press(key("return"));
    setComposerText(promptEdit(state).composer, "Remote prompt B");

    const current = source.settingsView;
    if (!current.editable) throw new Error("demo settings must be editable");
    const converged = {
      ...current.effective,
      systemPrompt: "Remote prompt B",
      maxTokens: current.effective.maxTokens + 1
    };
    publishSettingsView(state, source, {
      ...current,
      stateGeneration: current.stateGeneration + 1,
      activeRevision: current.activeRevision + 1,
      document: applyBasicSettingsDraft(current.document, converged),
      effective: converged
    });

    expect(promptEdit(state).composer.text).toBe("Remote prompt B");
    expect(promptEdit(state).initial).toBe("Remote prompt B");
    expect(state.settings?.draft.generation.maxTokens).toBe(converged.maxTokens);
    expect(state.settings?.conflict).toBe(null);
    expect(settingsDraftChanged(state.settings!)).toBeFalse();

    const afterConvergence = source.settingsView;
    if (!afterConvergence.editable) {
      throw new Error("demo settings must stay editable");
    }
    const refreshed = { ...converged, systemPrompt: "Remote prompt C" };
    publishSettingsView(state, source, {
      ...afterConvergence,
      stateGeneration: afterConvergence.stateGeneration + 1,
      activeRevision: afterConvergence.activeRevision + 1,
      document: applyBasicSettingsDraft(afterConvergence.document, refreshed),
      effective: refreshed
    });
    expect(promptEdit(state).composer.text).toBe("Remote prompt C");
    expect(promptEdit(state).initial).toBe("Remote prompt C");
    expect(state.settings?.conflict).toBe(null);
  });

  test("treats restoring the original prompt after refresh as an overwrite", async () => {
    const { source, state, press } = settingsHarness();
    await openSettings(press);
    await selectRow(press, state, "system-prompt");
    await press(key("return"));
    const original = promptEdit(state).initial;
    await press(key("N"));

    const current = source.settingsView;
    if (!current.editable) throw new Error("demo settings must be editable");
    const remote = { ...current.effective, systemPrompt: "Remote prompt" };
    publishSettingsView(state, source, {
      ...current,
      stateGeneration: current.stateGeneration + 1,
      activeRevision: current.activeRevision + 1,
      document: applyBasicSettingsDraft(current.document, remote),
      effective: remote
    });
    expect(state.settings?.conflict?.armed).toBeFalse();
    setComposerText(promptEdit(state).composer, original);

    await press(key("s", { ctrl: true }));

    expect(state.mode).toBe("SETTINGS");
    expect(state.settings?.draft.generation.systemPrompt).toBe(original);
    expect(settingsDraftChanged(state.settings!)).toBeTrue();
    expect(state.settings?.conflict?.armed).toBeFalse();
  });

  test("keeps a prompt opened during a Settings save as a newer edit", async () => {
    const { source, state, press } = settingsHarness();
    const entered = deferred<void>();
    const gate = deferred<void>();
    const saveSettings = source.api.saveSettings;
    source.api.saveSettings = async (command) => {
      entered.resolve();
      await gate.promise;
      return saveSettings(command);
    };
    await openSettings(press);
    await draftRow(press, state, "max-tokens", "1024");

    const saving = press(key("s"));
    await entered.promise;
    await selectRow(press, state, "system-prompt");
    await press(key("return"));
    await press(key("N"));
    gate.resolve();
    await saving;

    expect(state.mode).toBe("EDITOR");
    expect(state.editor?.kind).toBe("document");
    expect(state.settings !== null).toBe(true);
    expect(promptEdit(state).composer.text).toBe("N");
    expect(state.toast).toBe("settings saved · newer edits kept");

    await press(key("s", { ctrl: true }));
    expect(state.settings?.draft.generation.systemPrompt).toBe("N");
    expect(settingsDraftChanged(state.settings!)).toBeTrue();
  });
});
