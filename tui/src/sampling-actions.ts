import { applyComposerEdit } from "./composer-editing.js";
import { insertComposerText } from "./composer-model.js";
import { readFromClipboard } from "./clipboard.js";
import { sanitizePastedText, type ResolvedKey } from "./keys.js";
import { SAMPLING_SCALAR_DESCRIPTORS } from "../../shared/sampling-validation-policy.js";
import {
  beginNewSamplingEdit,
  beginSamplingEdit,
  boundedSamplingCursor,
  deleteSamplingItem,
  moveStopSequence,
  SAMPLING_LAYER_ROWS,
  samplingListRows,
  samplingScalarRows,
  setLogitBias,
  setSamplingScalar,
  setStopSequence,
  type SamplingScalarKnob
} from "./sampling-model.js";
import { disarmSettingsConflict } from "./settings-overlay-model.js";
import type { ActionContext } from "./action-context.js";
import type { AppSource } from "./app.js";
import type { RuntimeState } from "./state.js";

export async function samplingOverlayAction(
  resolved: ResolvedKey,
  state: RuntimeState,
  _source: AppSource,
  _context: ActionContext
): Promise<void> {
  const settings = state.settings;
  if (settings === null || settings.sampling === null) return;
  const nested = settings.sampling;

  if (resolved.action === "cancel") {
    if (nested.edit !== null) {
      nested.edit = null;
      nested.cursor = boundedSamplingCursor(settings, nested.panel, nested.cursor);
      nested.result = "edit cancelled · draft kept";
    } else if (nested.panel !== "sampling") {
      nested.panel = "sampling";
      nested.cursor = 0;
      nested.result = null;
    } else {
      settings.sampling = null;
      state.toast = "sampling closed · draft kept";
    }
    return;
  }
  if (resolved.action === "paste-clipboard") {
    await pasteSamplingEdit(state);
    return;
  }
  if (nested.edit !== null) {
    samplingEditAction(resolved, state);
    return;
  }
  if (resolved.action === "focus-next" || resolved.action === "focus-previous") {
    const step = resolved.action === "focus-next" ? 1 : -1;
    nested.cursor = boundedSamplingCursor(settings, nested.panel, nested.cursor + step);
    return;
  }
  if (resolved.action === "focus-index") {
    nested.cursor = boundedSamplingCursor(settings, nested.panel, resolved.index ?? nested.cursor);
    return;
  }
  if (resolved.action === "open-selected" || resolved.action === "edit") {
    openSamplingSelection(state);
    return;
  }
  if (resolved.action === "new-item") {
    const message = beginNewSamplingEdit(settings);
    if (message !== null) nested.result = message;
    return;
  }
  if (resolved.action === "delete-item") {
    if (nested.panel === "sampling") return;
    if (!deleteSamplingItem(settings, nested.panel, nested.cursor)) {
      nested.result = "no list item is selected";
    } else {
      nested.cursor = boundedSamplingCursor(settings, nested.panel, nested.cursor);
      nested.result = "draft updated · save in Settings";
    }
    return;
  }
  if (resolved.action === "take-next" || resolved.action === "take-previous") {
    const step = resolved.action === "take-next" ? 1 : -1;
    if (nested.panel === "sampling") {
      stepSamplingScalar(settings, step);
    } else if (nested.panel === "stop") {
      moveStopSequence(settings, step);
    }
  }
}

function openSamplingSelection(state: RuntimeState): void {
  const settings = state.settings;
  if (settings === null || settings.sampling === null) return;
  const nested = settings.sampling;
  if (nested.panel === "sampling") {
    const row = SAMPLING_LAYER_ROWS[boundedSamplingCursor(settings)]!;
    if (row.kind === "list") {
      const list = samplingListRows(settings).find((item) => item.panel === row.panel)!;
      if (!list.available) {
        nested.result = `${list.label} disabled · ${list.reasonCompact}`;
        return;
      }
      nested.panel = row.panel;
      nested.cursor = 0;
      nested.result = null;
      return;
    }
  }
  const message = beginSamplingEdit(settings);
  if (message !== null) nested.result = message;
}

function stepSamplingScalar(
  settings: NonNullable<RuntimeState["settings"]>,
  step: -1 | 1
): void {
  const nested = settings.sampling;
  if (nested === null || nested.panel !== "sampling") return;
  const row = SAMPLING_LAYER_ROWS[boundedSamplingCursor(settings)]!;
  if (row.kind !== "scalar") return;
  const knob = row.knob;
  const presentation = samplingScalarRows(settings).find((item) => item.knob === knob);
  if (presentation === undefined || !presentation.available) {
    nested.result = presentation === undefined
      ? "sampling row is unavailable"
      : `${presentation.label} disabled · ${presentation.reasonCompact}`;
    return;
  }
  const spec = SAMPLING_SCALAR_STEPS[knob];
  const descriptor = SAMPLING_SCALAR_DESCRIPTORS[knob];
  const current = settings.draft.sampling[knob];
  if (current === null) {
    if (step < 0) return;
    const error = setSamplingScalar(settings, knob, String(spec.neutral));
    if (error !== null) nested.result = `row kept · ${error}`;
    return;
  }
  const next = roundSamplingValue(current + step * spec.step, spec.precision);
  if (next < descriptor.minimum) {
    const error = setSamplingScalar(settings, knob, "");
    if (error !== null) nested.result = `row kept · ${error}`;
    return;
  }
  if (next > descriptor.maximum) {
    nested.result = `${presentation.label} at max`;
    return;
  }
  const error = setSamplingScalar(settings, knob, String(next));
  if (error !== null) nested.result = `row kept · ${error}`;
}

const SAMPLING_SCALAR_STEPS: Readonly<Record<SamplingScalarKnob, {
  readonly step: number;
  readonly neutral: number;
  readonly precision: number;
}>> = {
  topP: { step: 0.05, neutral: 1, precision: 2 },
  topK: { step: 1, neutral: 0, precision: 0 },
  minP: { step: 0.01, neutral: 0, precision: 2 },
  frequencyPenalty: { step: 0.1, neutral: 0, precision: 1 },
  presencePenalty: { step: 0.1, neutral: 0, precision: 1 },
  repeatPenalty: { step: 0.05, neutral: 1, precision: 2 }
};

function roundSamplingValue(value: number, precision: number): number {
  const factor = 10 ** precision;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function samplingEditAction(resolved: ResolvedKey, state: RuntimeState): void {
  const settings = state.settings;
  if (settings === null || settings.sampling === null) return;
  const nested = settings.sampling;
  const edit = nested.edit;
  if (edit === null) return;
  if (resolved.action === "commit-field") {
    const error = edit.kind === "scalar"
      ? setSamplingScalar(settings, edit.knob, edit.composer.text)
      : edit.kind === "stop"
        ? setStopSequence(settings, edit.index, edit.composer.text)
        : setLogitBias(settings, edit.index, edit.composer.text);
    if (error !== null) {
      nested.result = `row kept · ${error}`;
      return;
    }
    nested.edit = null;
    nested.result = "draft updated · save in Settings";
    return;
  }
  if (resolved.action === "input") {
    if (settings.conflict !== null) settings.conflict.armed = false;
    insertComposerText(edit.composer, resolved.text ?? "");
    return;
  }
  if (applyComposerEdit(edit.composer, resolved.action, resolved.extendSelection) !== null) {
    if (settings.conflict !== null) settings.conflict.armed = false;
  }
}

async function pasteSamplingEdit(state: RuntimeState): Promise<void> {
  const settings = state.settings;
  if (settings === null) return;
  const nested = settings.sampling;
  if (nested === null) return;
  const edit = nested.edit;
  if (edit === null) return;
  const inputClaim = {
    interactionVersion: state.interactionVersion,
    text: edit.composer.text,
    cursor: edit.composer.cursor,
    anchor: edit.composer.anchor
  };
  const text = await readFromClipboard();
  if (state.settings !== settings || settings.sampling !== nested || nested.edit !== edit) return;
  if (state.interactionVersion !== inputClaim.interactionVersion
    || edit.composer.text !== inputClaim.text
    || edit.composer.cursor !== inputClaim.cursor
    || edit.composer.anchor !== inputClaim.anchor) {
    return;
  }
  if (text === null) {
    state.toast = "clipboard unreadable · paste with ⌘V or ctrl+shift+v";
    return;
  }
  const clean = sanitizePastedText(text).replace(/\n+/g, " ");
  if (clean.length === 0) {
    state.toast = "clipboard has no insertable text";
    return;
  }
  disarmSettingsConflict(settings);
  insertComposerText(edit.composer, clean);
}
