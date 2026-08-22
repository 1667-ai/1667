import { describe, expect, test } from "bun:test";
import { applyBasicSettingsDraft } from "../../shared/settings-basic-draft.js";
import { updateSettingsDocumentV5 } from "../../shared/settings-document-update.js";
import {
  MAX_DEFAULT_CONTINUE_DIRECTION_SCALARS,
  MAX_WRITING_OBJECT_BYTES,
  MAX_WRITING_PROMPT_SCALARS
} from "../../shared/settings-v5-limits.js";
import {
  DEFAULT_WRITING_PROMPT_SETTINGS,
  WRITING_PROMPT_FIELD_DEFINITIONS,
  type WritingPromptRowId,
  type WritingPromptSettings
} from "../../shared/settings-v5-writing.js";
import { setComposerText } from "../src/composer-model.js";
import { nextRequestContext } from "../src/request-context.js";
import { publishSettingsView } from "../src/overlay-publication.js";
import { settingsFooterVariants } from "../src/screens/settings-panel-footers.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { frameText } from "../src/screens/story/frame.js";
import {
  settingsDraftChanged,
  settingsRowIds
} from "../src/settings-overlay-model.js";
import { settingsTextDraftWithSubscriptionPlan } from "../src/settings-text.js";
import { draftWriting } from "../src/settings-writing-draft.js";
import type { InlineEditorSession, RuntimeState } from "../src/state.js";
import { createWrapCache } from "../src/wrap.js";
import {
  draftRow,
  installSave,
  key,
  openSettings,
  selectRow,
  settingsHarness
} from "./settings-test-harness.js";

const CUSTOM_WRITING: WritingPromptSettings = {
  defaultAuthorBrief: "Keep the voice dry.",
  defaultContinueDirection: "Keep walking west.",
  rewriteGuidance: "Tighten the selected sentence.",
  titleGuidance: "Prefer place names.",
  summaryGuidance: "Keep chronology.",
  asideGuidance: "Stay in canon."
};

function promptEdit(state: RuntimeState): InlineEditorSession {
  const edit = state.editor;
  if (state.mode !== "EDITOR"
    || edit?.kind !== "document"
    || edit.target.kind !== "settings-prompt") {
    throw new Error("Settings editor did not open");
  }
  return edit;
}

function screen(state: RuntimeState, width = 120, height = 40): string {
  return frameText(renderStoryScreen(state, {
    width,
    height,
    wrapCache: createWrapCache()
  }).lines);
}

async function draftWritingRow(
  press: ReturnType<typeof settingsHarness>["press"],
  state: RuntimeState,
  row: WritingPromptRowId,
  value: string
): Promise<void> {
  await selectRow(press, state, row);
  await press(key("return"));
  expect(state.mode).toBe("EDITOR");
  expect(promptEdit(state).target.kind).toBe("settings-prompt");
  setComposerText(promptEdit(state).composer, value);
  await press(key("s", { ctrl: true }));
  expect(state.mode).toBe("SETTINGS");
}

async function draftAllWriting(
  press: ReturnType<typeof settingsHarness>["press"],
  state: RuntimeState,
  writing: WritingPromptSettings
): Promise<void> {
  for (const definition of WRITING_PROMPT_FIELD_DEFINITIONS) {
    await draftWritingRow(press, state, definition.row, writing[definition.field]);
  }
}

function withDocumentWriting(
  source: ReturnType<typeof settingsHarness>["source"],
  writing: WritingPromptSettings,
  activeWriting = writing
): void {
  const view = source.settingsView;
  if (!view.editable) throw new Error("demo settings must be editable");
  source.settingsView = {
    ...view,
    document: updateSettingsDocumentV5(view.document, { writing }),
    effective: { ...view.effective, systemPrompt: writing.defaultAuthorBrief },
    effectiveProse: { ...view.effectiveProse, systemPrompt: writing.defaultAuthorBrief },
    activeWriting
  };
  source.api.getSettings = async () => source.settingsView;
}

describe("table-driven Settings writing prompts", () => {
  test("simple view shows only simple writing rows and advanced view shows every row", async () => {
    const { state, press } = settingsHarness(undefined, { settingsViewMode: "simple" });
    await openSettings(press);
    const simple = settingsRowIds(state.settings!);
    expect(simple).toContain("default-author-brief");
    expect(simple).toContain("default-continue-direction");
    for (const definition of WRITING_PROMPT_FIELD_DEFINITIONS) {
      if (definition.view === "simple") expect(simple).toContain(definition.row);
      else expect(simple.includes(definition.row)).toBeFalse();
    }

    await press(key("m"));
    const advanced = settingsRowIds(state.settings!);
    for (const definition of WRITING_PROMPT_FIELD_DEFINITIONS) {
      expect(advanced).toContain(definition.row);
    }
    expect(advanced.indexOf("default-author-brief"))
      .toBeLessThan(advanced.indexOf("default-continue-direction"));
    expect(advanced.indexOf("aside-guidance"))
      .toBeLessThan(advanced.indexOf("provider"));
  });

  test("each writing row opens the full-screen editor and cancel keeps the draft", async () => {
    const { state, press } = settingsHarness();
    await openSettings(press);
    for (const definition of WRITING_PROMPT_FIELD_DEFINITIONS) {
      await selectRow(press, state, definition.row);
      const rendered = screen(state);
      expect(rendered).toContain(definition.label);
      expect(rendered).toContain(definition.help.split(". ")[0]!);
      await press(key("return"));
      expect(state.mode).toBe("EDITOR");
      expect(promptEdit(state).title).toBe(definition.title);
      expect(promptEdit(state).placeholder).toBe(definition.placeholder);
      expect(screen(state)).toContain(`┏━ ${definition.title}`);
      expect(screen(state)).toContain("ctrl+s keep draft");
      expect(screen(state)).toContain("esc cancel");
      setComposerText(promptEdit(state).composer, "unsaved local text");
      await press(key("escape"));
      expect(state.mode).toBe("SETTINGS");
      expect(draftWriting(state.settings!.draft)[definition.field])
        .toBe(DEFAULT_WRITING_PROMPT_SETTINGS[definition.field]);
      expect(settingsDraftChanged(state.settings!)).toBeFalse();
    }
  });

  test("Ctrl+S keeps a writing draft and s publishes the complete writing object", async () => {
    const { source, state, press } = settingsHarness();
    const saved: Parameters<typeof installSave>[1] = [];
    installSave(source, saved);
    await openSettings(press);
    await draftAllWriting(press, state, CUSTOM_WRITING);
    expect(settingsDraftChanged(state.settings!)).toBeTrue();
    expect(draftWriting(state.settings!.draft)).toEqual(CUSTOM_WRITING);
    expect(source.settingsView.activeWriting).toEqual(DEFAULT_WRITING_PROMPT_SETTINGS);

    await press(key("s"));
    expect(saved).toHaveLength(1);
    expect(saved[0]!.document.writing).toEqual(CUSTOM_WRITING);
    expect(source.settingsView.activeWriting).toEqual(CUSTOM_WRITING);
    expect(state.activeWriting).toEqual(CUSTOM_WRITING);
  });

  test("unrelated Settings edits keep every writing field", async () => {
    const { source, state, press } = settingsHarness();
    withDocumentWriting(source, CUSTOM_WRITING);
    const saved: Parameters<typeof installSave>[1] = [];
    installSave(source, saved);
    await openSettings(press);
    expect(draftWriting(state.settings!.draft)).toEqual(CUSTOM_WRITING);

    await draftRow(press, state, "max-tokens", "1024");
    await selectRow(press, state, "utility-route");
    await press(key("right"));
    await selectRow(press, state, "provider");
    await press(key("right"));
    expect(draftWriting(state.settings!.draft)).toEqual(CUSTOM_WRITING);
    await press(key("s"));
    expect(saved.at(-1)?.document.writing).toEqual(CUSTOM_WRITING);

    state.settings!.draft = settingsTextDraftWithSubscriptionPlan(
      state.settings!.draft,
      "chatgpt-plan",
      {
        ...state.settings!.draft.generation,
        provider: "openai-compatible",
        baseUrl: "",
        model: "gpt-5.4",
        apiKeyEnv: null
      }
    );
    expect(draftWriting(state.settings!.draft)).toEqual(CUSTOM_WRITING);
  });

  test("empty optional guidance stays explicit and continue empty resets in help", async () => {
    const { state, press } = settingsHarness();
    await openSettings(press);
    for (const definition of WRITING_PROMPT_FIELD_DEFINITIONS) {
      if (definition.emptyBehavior !== "omit-block") continue;
      await selectRow(press, state, definition.row);
      expect(screen(state)).toContain("—");
      expect(screen(state)).toContain("Empty adds no request");
      expect(screen(state)).toContain("block.");
    }
    await selectRow(press, state, "default-continue-direction");
    expect(screen(state)).toContain("Empty uses");
    expect(screen(state)).toContain("Continue the story.");
    await selectRow(press, state, "default-author-brief");
    expect(screen(state)).toContain("Empty omits the global brief.");
  });

  test("conflict refresh adopts unedited prompts and keeps local prompt edits", async () => {
    const { source, state, press } = settingsHarness();
    withDocumentWriting(source, CUSTOM_WRITING);
    await openSettings(press);
    await draftWritingRow(press, state, "rewrite-guidance", "Local rewrite only.");
    const localSampling = { ...state.settings!.draft.sampling, topP: 0.42 };
    state.settings!.draft = {
      ...state.settings!.draft,
      cachePolicy: "auto",
      sampling: localSampling
    };

    const current = source.settingsView;
    if (!current.editable) throw new Error("demo settings must be editable");
    const remoteWriting: WritingPromptSettings = {
      ...CUSTOM_WRITING,
      defaultAuthorBrief: "Remote author brief.",
      rewriteGuidance: "Remote rewrite.",
      titleGuidance: "Remote title."
    };
    const remote = applyBasicSettingsDraft(current.document, {
      ...current.effective,
      maxTokens: current.effective.maxTokens + 1
    });
    publishSettingsView(state, source, {
      ...current,
      stateGeneration: current.stateGeneration + 1,
      activeRevision: current.activeRevision + 1,
      document: updateSettingsDocumentV5(remote, { writing: remoteWriting }),
      effective: { ...current.effective, maxTokens: current.effective.maxTokens + 1 },
      effectiveProse: { ...current.effectiveProse, maxTokens: current.effective.maxTokens + 1 },
      activeWriting: remoteWriting
    });

    expect(draftWriting(state.settings!.draft)).toEqual({
      ...CUSTOM_WRITING,
      defaultAuthorBrief: "Remote author brief.",
      rewriteGuidance: "Local rewrite only.",
      titleGuidance: "Remote title."
    });
    expect(state.settings!.draft.cachePolicy).toBe("auto");
    expect(state.settings!.draft.sampling).toEqual(localSampling);
    expect(state.settings?.conflict?.message).toBe("settings changed during refresh · draft kept");
    expect(state.activeWriting).toEqual(remoteWriting);
  });

  test("editor refuses an oversize field without truncating", async () => {
    const { state, press } = settingsHarness();
    await openSettings(press);
    await selectRow(press, state, "default-author-brief");
    await press(key("return"));
    const oversize = "a".repeat(MAX_WRITING_PROMPT_SCALARS + 1);
    setComposerText(promptEdit(state).composer, oversize);
    await press(key("s", { ctrl: true }));
    expect(state.mode).toBe("EDITOR");
    expect(promptEdit(state).composer.text).toBe(oversize);
    expect(state.toast).toContain("65,536 Unicode scalar values");
    expect(settingsDraftChanged(state.settings!)).toBeFalse();

    await press(key("escape"));
    await selectRow(press, state, "default-continue-direction");
    await press(key("return"));
    const overContinue = "b".repeat(MAX_DEFAULT_CONTINUE_DIRECTION_SCALARS + 1);
    setComposerText(promptEdit(state).composer, overContinue);
    await press(key("s", { ctrl: true }));
    expect(state.mode).toBe("EDITOR");
    expect(promptEdit(state).composer.text).toBe(overContinue);
    expect(state.toast).toContain("61,534 Unicode scalar values");
  });

  test("editor refuses an oversize writing object without truncating", async () => {
    const { source, state, press } = settingsHarness();
    const bulky = "\n".repeat(50_000);
    const bulkyWriting: WritingPromptSettings = {
      defaultAuthorBrief: bulky,
      defaultContinueDirection: bulky.slice(0, 40_000),
      rewriteGuidance: bulky,
      titleGuidance: bulky,
      summaryGuidance: bulky,
      asideGuidance: bulky
    };
    withDocumentWriting(source, bulkyWriting);
    await openSettings(press);
    await selectRow(press, state, "aside-guidance");
    await press(key("return"));
    const extra = `${bulky}x`;
    setComposerText(promptEdit(state).composer, extra);
    await press(key("s", { ctrl: true }));
    expect(state.mode).toBe("EDITOR");
    expect(promptEdit(state).composer.text).toBe(extra);
    expect(state.toast).toContain(
      `${MAX_WRITING_OBJECT_BYTES.toLocaleString("en-US")}-byte canonical JSON limit`
    );
    expect(draftWriting(state.settings!.draft).asideGuidance).toBe(bulky);
  });

  test("a pending document does not change activeWriting used by request projection", async () => {
    const { source, state, press } = settingsHarness();
    const view = source.settingsView;
    if (!view.editable) throw new Error("demo settings must be editable");
    source.settingsView = {
      ...view,
      pendingRevision: 2,
      document: updateSettingsDocumentV5(view.document, { writing: CUSTOM_WRITING }),
      activeWriting: DEFAULT_WRITING_PROMPT_SETTINGS
    };
    source.api.getSettings = async () => source.settingsView;
    await openSettings(press);
    expect(draftWriting(state.settings!.draft)).toEqual(CUSTOM_WRITING);
    expect(state.activeWriting).toEqual(DEFAULT_WRITING_PROMPT_SETTINGS);
    expect(nextRequestContext(state).defaultContinueDirection)
      .toBe(DEFAULT_WRITING_PROMPT_SETTINGS.defaultContinueDirection);
    expect(screen(state, 80, 24)).toContain("x discard");
  });

  test("writing rows use the text footer and the editor keep-draft footer", async () => {
    const { state, press } = settingsHarness();
    await openSettings(press);
    for (const definition of WRITING_PROMPT_FIELD_DEFINITIONS) {
      await selectRow(press, state, definition.row);
      const footer = settingsFooterVariants(state.settings!, false)[0]!;
      expect(footer.text).toContain("↵ edit");
      expect(footer.text).not.toContain("←→ choose");
      await press(key("return"));
      expect(screen(state, 80, 20)).toContain("ctrl+s keep draft");
      await press(key("escape"));
    }
  });
});
