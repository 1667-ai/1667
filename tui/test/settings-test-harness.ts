import { expect } from "bun:test";
import { basicSettingsFromDocument } from "../../shared/settings-basic-draft.js";
import type { KeyEvent } from "@opentui/core";

import type { SaveSettingsCommand } from "../../shared/settings-v2-types.js";
import {
  generationSettingsFromProbeTarget,
  type ProviderProbeTarget
} from "../../shared/provider-probe-route-v1.js";
import { ActionRuntime } from "../src/action-runtime.js";
import { handleKey, initialState } from "../src/app.js";
import { setComposerText } from "../src/composer-model.js";
import type { UserConfig } from "../src/config.js";
import { demoAppSource } from "../src/demo.js";
import { settingsRowIndex } from "../src/settings-overlay-model.js";
import type { RuntimeState, SettingsRowId } from "../src/state.js";
import {
  createUpdateCheckSession,
  type ConfiguredUpdateStarter
} from "../src/update-runtime.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";

export function key(
  name: string,
  options: {
    sequence?: string;
    ctrl?: boolean;
    shift?: boolean;
    meta?: boolean;
    super?: boolean;
  } = {}
): KeyEvent {
  return {
    name,
    sequence: options.sequence ?? name,
    shift: options.shift ?? false,
    ctrl: options.ctrl ?? false,
    meta: options.meta ?? false,
    super: options.super ?? false
  } as KeyEvent;
}

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

export function generationFromProbeTarget(target: ProviderProbeTarget) {
  return generationSettingsFromProbeTarget(target);
}

/** Most fixtures predate the simple/advanced split and expect every row
 *  reachable by default, so the harness opens in advanced mode — set once
 *  here rather than every fixture poking `state.settings.viewMode` (or
 *  `selectRow` transparently pressing `m` the first time a hidden row was
 *  asked for) after the fact. `settings-view-mode.test.ts`, which tests the
 *  simple/advanced split itself, overrides back to `"simple"`. */
export function settingsHarness(
  requestQuit: () => void = () => undefined,
  configOverrides: Partial<UserConfig> = {},
  startUpdateCheck: ConfiguredUpdateStarter = () => () => undefined
) {
  const source = demoAppSource();
  const state = initialState(source, false);
  state.config = { ...state.config, settingsViewMode: "advanced", ...configOverrides };
  source.config = state.config;
  const cache = createWrapCache<ProseStyle>();
  // Counts every repaint this harness's actions request — the same repaint
  // reference `handleKey` (tui/src/app.ts) threads into the ActionContext
  // every action function receives, so a test can assert a screen was
  // repainted at a specific point in an async flow, not only that it was
  // eventually repainted at all (issue #282 review round 3, finding 5).
  let repaintCount = 0;
  const updateChecks = createUpdateCheckSession(startUpdateCheck, () => undefined);
  const repaint = () => {
    updateChecks.synchronize(source.config);
    repaintCount += 1;
  };
  const backend = new ActionRuntime(state, repaint);
  const press = (event: KeyEvent) => handleKey(
    event,
    state,
    source,
    cache,
    repaint,
    async () => undefined,
    requestQuit,
    null,
    (theme) => {
      state.config = { ...state.config, theme };
      source.config = state.config;
    },
    () => undefined,
    backend
  );
  return { source, state, cache, backend, press, repaints: () => repaintCount };
}

export function installSave(
  source: ReturnType<typeof demoAppSource>,
  saved: SaveSettingsCommand[]
): void {
  // Keep the test source and the in-memory API projection aligned. The demo
  // API owns its own settings closure, so a test save must also make later
  // refreshes read the authoritative source projection.
  source.api.getSettings = async () => source.settingsView;
  source.api.saveSettings = async (command) => {
    saved.push(command);
    const current = source.settingsView;
    if (!current.editable) throw new Error("demo settings must be editable");
    const effective = basicSettingsFromDocument(command.document);
    source.settingsView = {
      ...current,
      stateGeneration: current.stateGeneration + 1,
      activeRevision: current.activeRevision + 1,
      document: command.document,
      effective,
      activeWriting: command.document.writing
    };
    return {
      kind: "settings" as const,
      settingsStateGeneration: source.settingsView.stateGeneration,
      activeSettingsRevision: source.settingsView.activeRevision,
      pendingSettingsRevision: null,
      activationOutcome: null
    };
  };
}

export async function openSettings(
  press: (event: KeyEvent) => Promise<void>
): Promise<void> {
  await press(key(",", { sequence: "," }));
}

export async function selectRow(
  press: (event: KeyEvent) => Promise<void>,
  state: ReturnType<typeof settingsHarness>["state"],
  row: SettingsRowId
): Promise<void> {
  const target = settingsRowIndex(row, state.settings!);
  if (target < 0) throw new Error(`settings has no row for ${row}`);
  while (state.settings!.cursor < target) await press(key("down"));
  while (state.settings!.cursor > target) await press(key("up"));
}

/** Drain both the exclusive slot and every `ActionRuntime.runWhenIdle`
 *  driver (settings-context-detection.ts's automatic probe uses it) —
 *  `ActionRuntime.settle()` (test-only) does this properly; a bare
 *  `while (state.backendTask !== null) await backend.whenIdle()` loop is
 *  not enough, since `runWhenIdle` work never claims that slot at all, so
 *  the loop would exit while a background driver is still running. */
export async function settleBackend(backend: ActionRuntime): Promise<void> {
  await backend.settle();
}

export async function draftRow(
  press: (event: KeyEvent) => Promise<void>,
  state: ReturnType<typeof settingsHarness>["state"],
  row: SettingsRowId,
  value: string
): Promise<void> {
  await selectRow(press, state, row);
  await press(key("return"));
  expect(state.mode).toBe("SETTINGS");
  expect(state.settings?.edit?.kind).toBe("inline");
  const edit = state.settings?.edit;
  if (edit?.kind !== "inline") throw new Error("settings row did not open");
  expect(edit.row).toBe(row);
  setComposerText(edit.composer, value);
  await press(key("return"));
  expect(state.settings?.edit).toBe(null);
}
