import type {
  ConnectionTimeoutsV2,
  SettingsDocumentV2
} from "../../shared/settings-v2-types.js";
import { defaultConnectionTimeouts } from "../../shared/settings-provider-defaults.js";
import { MAX_SETTINGS_TIMEOUT_MS } from "../../server/settings-v2-scalars.js";
import { resolveSettingsProfile } from "../../shared/settings-route.js";
import { markControlMutation } from "./settings-profile-cycle.js";
import { replaceSettingsDraft } from "./settings-draft-transition.js";
import { settingsTextDraftForDocument, type SettingsTextDraft } from "./settings-text.js";
import {
  scalarChipText,
  scalarInvalidReason,
  steppedScalarValue,
  typedScalarValue,
  type ScalarMagnitude,
  type SettingsScalar
} from "./settings-scalar.js";
import type { SettingsOverlayState, SettingsRowId } from "./state.js";
import type { SettingsRowPresentation } from "./settings-profile-controls.js";

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
export type ConnectionTimeoutRow =
  | "timeout-headers"
  | "timeout-first-token"
  | "timeout-idle"
  | "timeout-total";

export const CONNECTION_TIMEOUT_ROWS = [
  "timeout-headers",
  "timeout-first-token",
  "timeout-idle",
  "timeout-total"
] as const satisfies readonly ConnectionTimeoutRow[];

const CONNECTION_TIMEOUT_ROW_SET: ReadonlySet<SettingsRowId> =
  new Set<SettingsRowId>(CONNECTION_TIMEOUT_ROWS);

export function isConnectionTimeoutRow(row: SettingsRowId): row is ConnectionTimeoutRow {
  return CONNECTION_TIMEOUT_ROW_SET.has(row);
}

type TimeoutUnit = "seconds" | "minutes";

const MS_PER_SECOND = 1_000;
const MS_PER_MINUTE = 60_000;

interface ConnectionTimeoutRowSpec {
  readonly field: keyof ConnectionTimeoutsV2;
  readonly label: string;
  readonly unit: TimeoutUnit;
  readonly unitSuffix: string;
  /** Stepper/track bounds only, in display units — the same relationship
   *  CONTEXT_WINDOW_CEILING has to context-window in settings-scalar.ts: a
   *  typed value past this is still accepted and flagged invalid, never
   *  refused outright. */
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly hint: string;
}

const CONNECTION_TIMEOUT_ROW_SPECS: Record<ConnectionTimeoutRow, ConnectionTimeoutRowSpec> = {
  "timeout-headers": {
    field: "responseHeaderMs",
    label: "headers",
    unit: "seconds",
    unitSuffix: "s",
    min: 1,
    max: 600,
    step: 5,
    hint: "wait for response headers to start arriving"
  },
  "timeout-first-token": {
    field: "firstTokenMs",
    label: "first token",
    unit: "seconds",
    unitSuffix: "s",
    min: 1,
    // The schema's own ceiling (server/settings-v2-scalars.ts), not
    // provider-first-token-deadline.ts's derivation ceiling: that one bounds
    // only the automatic per-byte allowance a large prompt earns, never the
    // value a writer configures here (the runtime honours a configured
    // value above it exactly). Presenting the derivation ceiling as this
    // row's own limit would mark a backend-valid configured value invalid
    // and put it out of arrow-step reach.
    max: MAX_SETTINGS_TIMEOUT_MS / MS_PER_SECOND,
    step: 5,
    hint: "wait for the first token · a large prompt extends this automatically"
  },
  "timeout-idle": {
    field: "idleMs",
    label: "idle",
    unit: "seconds",
    unitSuffix: "s",
    min: 1,
    max: 600,
    step: 5,
    hint: "wait between stream events once output has started"
  },
  "timeout-total": {
    field: "totalMs",
    label: "total",
    unit: "minutes",
    unitSuffix: "m",
    min: 1,
    max: 180,
    step: 5,
    hint: "wall-clock limit for the whole generation"
  }
};

export function connectionTimeoutLabel(row: ConnectionTimeoutRow): string {
  return CONNECTION_TIMEOUT_ROW_SPECS[row].label;
}

export function connectionTimeoutHint(row: ConnectionTimeoutRow): string {
  return CONNECTION_TIMEOUT_ROW_SPECS[row].hint;
}

function unitDivisor(unit: TimeoutUnit): number {
  return unit === "seconds" ? MS_PER_SECOND : MS_PER_MINUTE;
}

/** The row's live value read straight off the draft document, in display
 *  units. Null when there is no document to read one from (format 1, the
 *  read-only legacy view) — every caller treats null as "show a dash, this
 *  row is inert here", the same fallback text-prompt-format and the other
 *  connection rows use. */
function connectionTimeoutScalarForDraft(
  row: ConnectionTimeoutRow,
  draft: SettingsTextDraft
): SettingsScalar | null {
  const document = draft.document;
  const profileId = draft.selectedProfileId;
  if (document === null || profileId === null) return null;
  const spec = CONNECTION_TIMEOUT_ROW_SPECS[row];
  const route = resolveSettingsProfile(document, profileId);
  const divisor = unitDivisor(spec.unit);
  const defaults = defaultConnectionTimeouts(draft.generation.provider);
  return {
    row,
    value: route.connection.timeouts[spec.field] / divisor,
    min: spec.min,
    max: spec.max,
    step: spec.step,
    defaultValue: defaults[spec.field] / divisor,
    decimals: 0,
    // Every ConnectionTimeoutsV2 field is a required number — there is no
    // sentinel value this row can fall back to.
    sentinel: null,
    sentinelEntry: spec.min
  };
}

export function connectionTimeoutScalar(
  row: ConnectionTimeoutRow,
  overlay: SettingsOverlayState
): SettingsScalar | null {
  return connectionTimeoutScalarForDraft(row, overlay.draft);
}

/** The chip text: the number in its display unit, with a one-letter suffix
 *  so "120" reads as "120s" rather than an ambiguous bare integer. */
export function connectionTimeoutValueText(
  row: ConnectionTimeoutRow,
  scalar: SettingsScalar
): string {
  return `${scalarChipText(scalar)}${CONNECTION_TIMEOUT_ROW_SPECS[row].unitSuffix}`;
}

function documentWithConnectionTimeout(
  document: SettingsDocumentV2,
  profileId: string,
  row: ConnectionTimeoutRow,
  displayValue: number
): SettingsDocumentV2 {
  const spec = CONNECTION_TIMEOUT_ROW_SPECS[row];
  const route = resolveSettingsProfile(document, profileId);
  const milliseconds = Math.round(displayValue * unitDivisor(spec.unit));
  return {
    ...document,
    connections: {
      ...document.connections,
      [route.model.connectionId]: {
        ...route.connection,
        timeouts: { ...route.connection.timeouts, [spec.field]: milliseconds }
      }
    }
  };
}

function draftWithConnectionTimeoutValue(
  draft: SettingsTextDraft,
  row: ConnectionTimeoutRow,
  displayValue: number
): SettingsTextDraft {
  const document = draft.document;
  const profileId = draft.selectedProfileId;
  if (document === null || profileId === null) return draft;
  return settingsTextDraftForDocument(
    documentWithConnectionTimeout(document, profileId, row, displayValue),
    profileId
  );
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
  if (scalar === null) return { kind: "error", message: "legacy settings are read-only" };
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
      hint: "legacy settings are read-only"
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
