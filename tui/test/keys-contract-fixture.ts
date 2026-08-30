import type { KeyEvent } from "@opentui/core";
import { ActionRuntime } from "../src/action-runtime.js";
import { initialState } from "../src/app.js";
import {
  createComposer,
  moveComposerTo,
  type ComposerState
} from "../src/composer-model.js";
import { demoAppSource } from "../src/demo.js";
import { inlineEditorAction } from "../src/editor-action.js";
import {
  resolveKey,
  type KeyAction,
  type ResolvedKey
} from "../src/keys.js";
import { initialSettingsOverlay } from "../src/settings-overlay-model.js";
import { settingsOverlayAction } from "../src/settings-overlay-actions.js";
import { composeAction } from "../src/story-actions.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";

export const COMPOSER_SURFACES = [
  "COMPOSE",
  "EDITOR",
  "SETTINGS"
] as const;

export type ComposerSurface = (typeof COMPOSER_SURFACES)[number];

const TEXT_SURFACE_KEY_NAMES = [
  "left",
  "right",
  "up",
  "down",
  "pageup",
  "pagedown",
  "home",
  "end",
  "backspace",
  "delete",
  "a",
  "b",
  "e",
  "f",
  "k",
  "u",
  "w",
  "x",
  "y",
  "z",
  "-",
  "."
] as const;

const MODIFIER_COMBINATIONS = Array.from({ length: 32 }, (_, bits) => ({
  shift: Boolean(bits & 1),
  ctrl: Boolean(bits & 2),
  meta: Boolean(bits & 4),
  option: Boolean(bits & 8),
  super: Boolean(bits & 16)
}));

export function textSurfaceKeyMatrix(): readonly KeyEvent[] {
  return TEXT_SURFACE_KEY_NAMES.flatMap((name) =>
    MODIFIER_COMBINATIONS.map((modifiers) => ({
      name,
      sequence: name,
      ...modifiers
    } as KeyEvent))
  );
}

export function resolveComposerSurface(
  surface: ComposerSurface,
  event: KeyEvent
): ResolvedKey {
  return surface === "SETTINGS"
    ? resolveKey(event, surface, { overlayTyping: true })
    : resolveKey(event, surface);
}

export function surfaceActions(event: KeyEvent): readonly KeyAction[] {
  return COMPOSER_SURFACES.map(
    (surface) => resolveComposerSurface(surface, event).action
  );
}

export async function composerChangedThroughSurface(
  surface: ComposerSurface,
  resolved: ResolvedKey
): Promise<boolean> {
  const source = demoAppSource();
  const state = initialState(source, false);
  const composer = createComposer("alpha beta\ngamma delta\nomega");
  moveComposerTo(composer, 16);
  const before = composerSnapshot(composer);
  const context = {
    cache: createWrapCache<ProseStyle>(),
    repaint: () => undefined,
    backend: new ActionRuntime(state, () => undefined),
    renderer: null,
    applyTheme: () => undefined,
    previewTheme: () => undefined
  };

  if (surface === "COMPOSE") {
    state.mode = "COMPOSE";
    state.composer = composer;
    await composeAction(resolved, state, source, context);
  } else if (surface === "EDITOR") {
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
        name: undefined, tag: null, activation: "always", keys: [], secondaryKeys: [], secondaryMode: "and", scanDepth: undefined, recursion: "on", priority: "normal", budgetTokens: undefined, text: composer.text
      },
      title: "Edit fact",
      placeholder: "Fact text",
      returnMode: "FACTS",
      conflict: null
    };
    await inlineEditorAction(resolved, state, source, context);
  } else {
    state.mode = "SETTINGS";
    state.settings = initialSettingsOverlay(source.settingsView, state.config);
    state.settings.edit = {
      kind: "inline",
      row: "model",
      mode: "text",
      composer,
      initial: composer.text
    };
    await settingsOverlayAction(resolved, state, source, context);
  }

  return composerSnapshot(composer) !== before;
}

function composerSnapshot(composer: ComposerState): string {
  return JSON.stringify({
    text: composer.text,
    cursor: composer.cursor,
    anchor: composer.anchor
  });
}
