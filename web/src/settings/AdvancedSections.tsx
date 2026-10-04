import { useState } from "react";
import {
  PROMPT_CACHE_POLICY_V2_VALUES,
  type GenerationEffortV2,
  type SettingsRoutePurpose,
  type TextPromptFormatV2
} from "../../../shared/settings-v2-types.js";
import { promptCacheSummaryParts } from "../../../shared/settings-cache-summary.js";
import { settingsReadOnlyMessage } from "../../../shared/settings-read-only.js";
import { settingsScalar } from "../../../shared/settings-scalar.js";
import {
  CONNECTION_TIMEOUT_ROWS,
  type ConnectionTimeoutRow,
  connectionTimeoutHint,
  connectionTimeoutScalarForDraft,
  continuationPromptHint,
  continuationPromptOptimization,
  effortChoicesForDraft,
  effortHint,
  effortOfDraft,
  imageInputStatus,
  keepThoughts,
  profileHint,
  reasoningRowChoices,
  reasoningRowHasArrows,
  reasoningRowHint,
  reasoningRowState,
  routeHint,
  routeProfileId,
  splitThinkTags,
  textPromptFormat,
  textPromptFormatChoices,
  tokenProbabilitiesChoices,
  tokenProbabilitiesRowHint,
  tokenProbabilitiesRowState
} from "../../../shared/settings-profile-fields.js";
import { useAppContext } from "../app/context.js";
import { pushToast } from "../app/toasts.js";
import { profileNames } from "./advanced-model.js";
import { isSubscriptionDraft } from "./model.js";
import { Row, Section, SelectRow, TextInputRow, ToggleRow } from "./SettingsFields.js";
import type { LoadedSettings } from "./state.js";

const NOT_TEXT_COMPLETION = "Available with text-completion providers.";
const NO_EFFORT = "This model does not support reasoning effort.";
const READ_ONLY_VALUE = "—";

/** Everything a row needs from the page: the draft, and whether it may be
 * edited at all. A read-only view still shows its rows, with a dash. */
function useRowContext(loaded: LoadedSettings) {
  const draft = loaded.draft;
  const readOnly = !loaded.view.editable;
  return {
    draft,
    view: loaded.view,
    readOnly,
    locked: readOnly || loaded.busy !== null,
    readOnlyHint: settingsReadOnlyMessage(loaded.view.readOnlyReason)
  };
}

/** The profile row, its name, and the actions on it. */
export function ProfileRows({ loaded }: { readonly loaded: LoadedSettings }) {
  const { actions } = useAppContext();
  const { draft, view, readOnly, locked, readOnlyHint } = useRowContext(loaded);
  const profiles = profileNames(draft);
  const selectedId = draft.selectedProfileId;
  const selected = profiles.find((profile) => profile.id === selectedId);
  const refusedName = loaded.invalid["profile-name"];
  // The second click deletes. Choosing another profile, or anything else on
  // the page, disarms it.
  const [armed, setArmed] = useState<string | null>(null);
  const armedHere = selectedId !== null && armed === selectedId;
  return (
    <>
      <SelectRow
        label="Profile"
        hint={readOnly ? readOnlyHint : profileHint(view, draft)}
        value={selected?.name ?? READ_ONLY_VALUE}
        options={profiles.map((profile) => ({ id: profile.id, label: profile.name, current: profile.id === selectedId }))}
        disabled={locked}
        onSelect={(id) => { setArmed(null); actions.settings.selectProfile(id); }}
      />
      <Row label="Profile actions" labelId="settings-profile-actions-label">
        <div className="settings-input-line" role="group" aria-label="Profile actions">
          <button
            type="button"
            className="btn btn-small"
            title="Add a profile with these settings"
            disabled={locked}
            onClick={() => { setArmed(null); actions.settings.createProfile(false); }}
          >
            New profile
          </button>
          <button
            type="button"
            className="btn btn-small"
            title="Copy this profile, with its name"
            disabled={locked}
            onClick={() => { setArmed(null); actions.settings.createProfile(true); }}
          >
            Duplicate
          </button>
          <button
            type="button"
            className={`btn btn-small${armedHere ? " btn-danger" : ""}`}
            title={armedHere ? "Click again to delete this profile" : "Delete this profile (click twice)"}
            disabled={locked}
            onClick={() => {
              if (!armedHere) { setArmed(selectedId); return; }
              setArmed(null);
              actions.settings.deleteProfile();
            }}
          >
            {armedHere ? "Delete? Click again" : "Delete"}
          </button>
        </div>
      </Row>
      <TextInputRow
        label="Profile name"
        value={selected?.name ?? ""}
        refused={refusedName}
        disabled={locked}
        hint="Routes show profiles by this name."
        onChange={actions.settings.renameProfile}
      />
    </>
  );
}

/** Rows that belong to the connection and only apply to some of them. */
export function ConnectionAdvancedRows({ loaded }: { readonly loaded: LoadedSettings }) {
  const { actions } = useAppContext();
  const { draft, readOnly, locked, readOnlyHint } = useRowContext(loaded);
  const textCompletion = draft.generation.provider === "text-completion";
  const unavailable = !textCompletion || isSubscriptionDraft(draft);
  const format = textPromptFormat(draft);
  const formats = textPromptFormatChoices(draft);
  return (
    <>
      <SelectRow<TextPromptFormatV2>
        label="Prompt format"
        hint={readOnly ? readOnlyHint : unavailable ? NOT_TEXT_COMPLETION : "How prompts are formatted for text-completion models."}
        value={unavailable || readOnly ? READ_ONLY_VALUE : format}
        options={formats.map((candidate) => ({ id: candidate, label: candidate, current: candidate === format }))}
        disabled={locked || unavailable}
        onSelect={actions.settings.setTextPromptFormat}
      />
      <ToggleRow
        label="Split thoughts"
        hint={readOnly ? readOnlyHint : unavailable ? NOT_TEXT_COMPLETION : "Keeps <think> text separate from story prose."}
        on={!unavailable && !readOnly && splitThinkTags(draft)}
        disabled={locked || unavailable}
        onChange={actions.settings.setSplitThinkTags}
      />
    </>
  );
}

const TIMEOUT_LABELS: Record<ConnectionTimeoutRow, string> = {
  "timeout-headers": "Header timeout",
  "timeout-idle": "Idle timeout",
  "timeout-total": "Total timeout"
};

export function TimeoutRows({ loaded }: { readonly loaded: LoadedSettings }) {
  const { actions } = useAppContext();
  const { draft, readOnly, locked, readOnlyHint } = useRowContext(loaded);
  return (
    <>
      {CONNECTION_TIMEOUT_ROWS.map((row) => {
        const scalar = connectionTimeoutScalarForDraft(row, draft);
        return (
          <TextInputRow
            key={row}
            label={TIMEOUT_LABELS[row]}
            value={scalar?.value === null || scalar === null ? "" : String(scalar.value)}
            refused={loaded.invalid[row]}
            disabled={locked || scalar === null}
            placeholder={readOnly ? READ_ONLY_VALUE : undefined}
            hint={readOnly ? readOnlyHint : `${connectionTimeoutHint(row)} In seconds.`}
            onChange={(text) => actions.settings.setTimeout(row, text)}
          />
        );
      })}
    </>
  );
}

/** What the selected model accepts. It cannot be edited. */
export function ImageInputRow({ loaded }: { readonly loaded: LoadedSettings }) {
  const { readOnly, readOnlyHint, draft } = useRowContext(loaded);
  const status = imageInputStatus(draft);
  return (
    <Row label="Image input" labelId="settings-image-input-label" hint={readOnly ? readOnlyHint : status.hint}>
      <p className="settings-static">
        {readOnly ? READ_ONLY_VALUE : status.supported ? "Available" : "Not available"}
      </p>
    </Row>
  );
}

export function GenerationSection({ loaded }: { readonly loaded: LoadedSettings }) {
  const { actions } = useAppContext();
  const { draft, view, readOnly, locked, readOnlyHint } = useRowContext(loaded);
  const temperature = settingsScalar("temperature", draft.generation);
  const maxTokens = settingsScalar("max-tokens", draft.generation);
  const efforts = effortChoicesForDraft(draft);
  const effort = effortOfDraft(draft);
  const cache = promptCacheSummaryParts(view, draft);
  const cachePolicies = cache.kind === "available" || cache.policy !== "off"
    ? PROMPT_CACHE_POLICY_V2_VALUES
    : (["off"] as const);
  const alternatives = tokenProbabilitiesRowState(view, draft);
  const alternativeChoices = tokenProbabilitiesChoices(view, draft);
  const alternativesEditable = alternatives.resolution?.kind === "available"
    || alternatives.resolution?.kind === "unavailable" && alternatives.count !== null;
  const hint = (editable: string): string => (readOnly ? readOnlyHint : editable);
  return (
    <Section title="Generation">
      <TextInputRow
        label="Temperature"
        value={temperature.value === null ? "" : String(temperature.value)}
        refused={loaded.invalid.temperature}
        disabled={locked}
        placeholder={readOnly ? READ_ONLY_VALUE : "Default"}
        hint={hint("Higher values make the writing less predictable. Empty uses the provider default.")}
        onChange={(text) => actions.settings.setGenerationScalar("temperature", text)}
      />
      <TextInputRow
        label="Max tokens"
        value={String(maxTokens.value ?? "")}
        refused={loaded.invalid["max-tokens"]}
        disabled={locked}
        hint={hint("Limits the length of each response.")}
        onChange={(text) => actions.settings.setGenerationScalar("max-tokens", text)}
      />
      <SelectRow<GenerationEffortV2>
        label="Effort"
        hint={readOnly ? readOnlyHint : efforts.length <= 1 ? NO_EFFORT : effortHint(view, draft)}
        tone={!readOnly && !(efforts as readonly string[]).includes(effort) ? "warning" : undefined}
        value={readOnly ? READ_ONLY_VALUE : effort}
        options={efforts.map((candidate) => ({ id: candidate, label: candidate, current: candidate === effort }))}
        disabled={locked || efforts.length <= 1 && (efforts as readonly string[]).includes(effort)}
        onSelect={actions.settings.setEffort}
      />
      <SelectRow<string>
        label="Alternatives"
        hint={readOnly ? readOnlyHint : tokenProbabilitiesRowHint(alternatives)}
        value={readOnly || alternatives.resolution === null
          ? READ_ONLY_VALUE
          : alternatives.count === null ? "off" : String(alternatives.count)}
        options={alternativeChoices.map((count) => ({
          id: count === null ? "off" : String(count),
          label: count === null ? "off" : String(count),
          current: count === alternatives.count
        }))}
        disabled={locked || !alternativesEditable}
        onSelect={(id) => actions.settings.setTokenProbabilities(id === "off" ? null : Number(id))}
      />
      <SelectRow<string>
        label="Prompt cache"
        hint={readOnly ? readOnlyHint : cache.kind === "available" ? cache.description : cache.reason}
        value={readOnly ? READ_ONLY_VALUE : cache.policy}
        options={cachePolicies.map((policy) => ({ id: policy, label: policy, current: policy === cache.policy }))}
        disabled={locked || cache.kind === "unavailable" && cache.policy === "off"}
        onSelect={(policy) => actions.settings.setCachePolicy(policy as (typeof PROMPT_CACHE_POLICY_V2_VALUES)[number])}
      />
      <ToggleRow
        label="Prompt layout"
        hint={readOnly ? readOnlyHint : continuationPromptHint(view, draft)}
        on={continuationPromptOptimization(draft) !== null}
        disabled={locked}
        onChange={actions.settings.setPromptLayout}
      />
    </Section>
  );
}

export function ThoughtsSection({ loaded }: { readonly loaded: LoadedSettings }) {
  const { actions } = useAppContext();
  const { draft, readOnly, locked, readOnlyHint } = useRowContext(loaded);
  const state = reasoningRowState(draft);
  const choices = reasoningRowChoices(draft);
  const editable = reasoningRowHasArrows(draft);
  return (
    <Section title="Thoughts">
      <SelectRow
        label="Reasoning display"
        hint={readOnly ? readOnlyHint : reasoningRowHint(state)}
        value={readOnly || state.route === null ? READ_ONLY_VALUE : editable ? state.display : "—"}
        options={choices.map((candidate) => ({ id: candidate, label: candidate, current: candidate === state.display }))}
        disabled={locked || !editable}
        onSelect={actions.settings.setReasoningDisplay}
      />
      <ToggleRow
        label="Save thoughts"
        hint={readOnly ? readOnlyHint : "Saves model reasoning with each take."}
        on={keepThoughts(draft)}
        disabled={locked}
        onChange={actions.settings.setKeepThoughts}
      />
    </Section>
  );
}

const ROUTES: readonly { readonly purpose: SettingsRoutePurpose; readonly label: string }[] = [
  { purpose: "default", label: "Default profile" },
  { purpose: "prose", label: "Prose profile" },
  { purpose: "utility", label: "Utility profile" }
];

export function RoutingSection({ loaded }: { readonly loaded: LoadedSettings }) {
  const { actions } = useAppContext();
  const { draft, readOnly, locked, readOnlyHint } = useRowContext(loaded);
  const profiles = profileNames(draft);
  const document = draft.document;
  return (
    <Section title="Routing">
      {ROUTES.map(({ purpose, label }) => {
        const chosen = document === null ? null : routeProfileId(document, purpose);
        const name = profiles.find((profile) => profile.id === chosen)?.name;
        const options = [
          ...(purpose === "default" ? [] : [{ id: "", label: "Same as default", current: chosen === null }]),
          ...profiles.map((profile) => ({ id: profile.id, label: profile.name, current: profile.id === chosen }))
        ];
        return (
          <SelectRow<string>
            key={purpose}
            label={label}
            hint={readOnly ? readOnlyHint : routeHint(purpose)}
            value={readOnly ? READ_ONLY_VALUE : chosen === null ? "Same as default" : name ?? READ_ONLY_VALUE}
            options={options}
            disabled={locked}
            onSelect={(id) => actions.settings.setRoute(purpose, id === "" ? null : id)}
          />
        );
      })}
    </Section>
  );
}
