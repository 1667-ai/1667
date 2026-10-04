import {
  CONNECTION_TIMEOUT_ROWS,
  connectionTimeoutHint,
  connectionTimeoutLabel,
  connectionTimeoutScalarForDraft,
  connectionTimeoutValueText,
  draftWithConnectionTimeoutValue,
  type ConnectionTimeoutRow
} from "../../shared/settings-profile-fields.js";
import { markControlMutation } from "./settings-profile-cycle.js";
import { replaceSettingsDraft } from "./settings-draft-transition.js";
import type { SettingsTextDraft } from "./settings-text.js";
import {
  scalarInvalidReason,
  steppedScalarValue,
  typedScalarValue,
  type ScalarMagnitude,
  type SettingsScalar
} from "./settings-scalar.js";
import type { SettingsOverlayState, SettingsRowId } from "./state.js";
import type { SettingsRowPresentation } from "./settings-row-presentations.js";
import { settingsReadOnlyMessage } from "./settings-read-only.js";

/** The four `ConnectionTimeoutsV2` fields (issue #127), editable with the
 *  same C-08 chip/track/typed-edit widget as temperature, max tokens and
 *  context (settings-scalar.ts, settings-profile-controls.ts). Unlike those
 *  three, a timeout lives on the connection the selected profile's model
 *  points at, not on the profile itself, so this module reads and writes
 *  `document.connections[...].timeouts` directly instead of
 *  `GenerationSettings` — every function here takes a `SettingsTextDraft` or
 *  `SettingsOverlayState` and resolves the live connection through
 *  `resolveSettingsProfile`, the same way settings-allow-insecure.ts and
 *  the text-prompt-format cycler in settings-profile-controls.ts already do.
 *
 *  All four rows add no new stored field — every value already exists in
 *  `ConnectionTimeoutsV2` — so this module is presentation and document
 *  editing only, never a schema change. */

const CONNECTION_TIMEOUT_ROW_SET: ReadonlySet<SettingsRowId> =
  new Set<SettingsRowId>(CONNECTION_TIMEOUT_ROWS);

export function isConnectionTimeoutRow(row: SettingsRowId): row is ConnectionTimeoutRow {
  return CONNECTION_TIMEOUT_ROW_SET.has(row);
}

export {
  CONNECTION_TIMEOUT_ROWS,
  connectionTimeoutHint,
  connectionTimeoutLabel,
  connectionTimeoutValueText,
  type ConnectionTimeoutRow
};

export function connectionTimeoutScalar(
  row: ConnectionTimeoutRow,
  overlay: SettingsOverlayState
): SettingsScalar | null {
  return connectionTimeoutScalarForDraft(row, overlay.draft);
}

/** C-08 stepping, mirroring stepSettingsScalar (settings-profile-controls.ts)
 *  for a connection field instead of a profile one. */
export function stepConnectionTimeout(
  overlay: SettingsOverlayState,
  row: ConnectionTimeoutRow,
  step: -1 | 1,
  magnitude: ScalarMagnitude
): void {
  const scalar = connectionTimeoutScalar(row, overlay);
  if (scalar === null) return;
  const next = steppedScalarValue(scalar, step, magnitude);
  if (next === null || next === scalar.value) return;
  replaceSettingsDraft(overlay, draftWithConnectionTimeoutValue(overlay.draft, row, next));
  markControlMutation(overlay);
}

/** What the row's inline text editor opens on. */
export function connectionTimeoutEditValueForDraft(
  row: ConnectionTimeoutRow,
  draft: SettingsTextDraft
): string {
  const scalar = connectionTimeoutScalarForDraft(row, draft);
  return scalar?.value?.toString() ?? "";
}

export function connectionTimeoutEditValue(
  row: ConnectionTimeoutRow,
  overlay: SettingsOverlayState
): string {
  return connectionTimeoutEditValueForDraft(row, overlay.draft);
}

/** Commits a typed row edit — the connection-timeout counterpart of the
 *  generic `fieldKey`/`parseSettings` path applySettingsRowEdit uses for a
 *  GenerationSettings field, which cannot reach a document-connection field. */
export function applyConnectionTimeoutEdit(
  overlay: SettingsOverlayState,
  row: ConnectionTimeoutRow,
  text: string
): { kind: "draft" } | { kind: "error"; message: string } {
  const scalar = connectionTimeoutScalar(row, overlay);
  if (scalar === null) {
    return { kind: "error", message: settingsReadOnlyMessage(overlay.view.readOnlyReason) };
  }
  const typed = typedScalarValue(scalar, text);
  if ("refused" in typed) return { kind: "error", message: typed.refused };
  if (typed.scalar.value === null) return { kind: "error", message: "this row needs a number" };
  replaceSettingsDraft(
    overlay,
    draftWithConnectionTimeoutValue(overlay.draft, row, typed.scalar.value)
  );
  markControlMutation(overlay);
  return { kind: "draft" };
}

/** Reconciliation's merge of a mid-typed row edit against a fresher
 *  authoritative draft (settings-overlay-reconciliation.ts's
 *  draftWithActiveEdit) — the connection-timeout counterpart of that
 *  function's generic `parseSettings` branch. Null means the typed text does
 *  not resolve to a number this row accepts, which the caller treats as a
 *  merge conflict, same as an unparsable generic field edit would. */
export function draftWithConnectionTimeoutEditText(
  draft: SettingsTextDraft,
  row: ConnectionTimeoutRow,
  text: string
): SettingsTextDraft | null {
  const scalar = connectionTimeoutScalarForDraft(row, draft);
  if (scalar === null) return draft;
  const typed = typedScalarValue(scalar, text);
  if ("refused" in typed || typed.scalar.value === null) return null;
  return draftWithConnectionTimeoutValue(draft, row, typed.scalar.value);
}

function connectionTimeoutRowPresentation(
  row: ConnectionTimeoutRow,
  overlay: SettingsOverlayState
): SettingsRowPresentation {
  const label = connectionTimeoutLabel(row);
  const scalar = connectionTimeoutScalar(row, overlay);
  if (scalar === null) {
    return {
      id: row,
      section: "connection",
      label,
      value: "—",
      hint: settingsReadOnlyMessage(overlay.view.readOnlyReason)
    };
  }
  const invalid = scalarInvalidReason(scalar);
  return {
    id: row,
    section: "connection",
    label,
    value: `‹ ${connectionTimeoutValueText(row, scalar)} ›`,
    scalar,
    hint: connectionTimeoutHint(row),
    ...(invalid === null ? {} : { invalid })
  };
}

/** All four rows, in display order, for settingsRows() to splice into the
 *  connection section. */
export function connectionTimeoutRows(
  overlay: SettingsOverlayState
): readonly SettingsRowPresentation[] {
  return CONNECTION_TIMEOUT_ROWS.map((row) => connectionTimeoutRowPresentation(row, overlay));
}
