import { useEffect, useState } from "react";
import {
  resolveSamplingKnob,
  samplingBiasEntryRejectionMessage,
  samplingBiasNativeBlockedMessage,
  samplingBiasResolutionFailureMessage,
  samplingKnobLabel,
  type SamplingBiasResolutionResult
} from "../../../shared/sampling-capabilities.js";
import {
  SAMPLING_LAYER_ROWS,
  SAMPLING_SCALAR_PRESENTATION
} from "../../../shared/sampling-row-presentation.js";
import { samplingContextForDraft } from "../../../shared/settings-profile-fields.js";
import type { SamplingPhraseBiasEntryV2 } from "../../../shared/settings-v2-types.js";
import { useAppContext } from "../app/context.js";
import { errorMessage } from "../app/toasts.js";
import { probeTargetFor, targetIdentity } from "./model.js";
import {
  SAMPLING_LISTS,
  samplingAvailability,
  samplingListCount,
  samplingListLimit,
  samplingListText,
  samplingScalarText
} from "./sampling-model.js";
import { LinesRow, Section, TextInputRow } from "./SettingsFields.js";
import type { LoadedSettings } from "./state.js";

const PREVIEW_DELAY_MS = 600;

/** The story's own overlay, for the preview of "This story". */
export interface StoryBiasOverlay {
  readonly phraseBias: readonly SamplingPhraseBiasEntryV2[];
  readonly bannedStrings: readonly string[];
}

type PreviewState =
  | { readonly key: string; readonly kind: "pending" }
  | { readonly key: string; readonly kind: "ready"; readonly result: SamplingBiasResolutionResult }
  | { readonly key: string; readonly kind: "failed"; readonly message: string };

/** What the phrase bias and the banned strings resolve to for the selected
 * route: how many entries reach the provider, and which entries are refused.
 * It reads the server's tokenizer, so it waits a moment after each edit. */
export function BiasPreview({ loaded, story }: { readonly loaded: LoadedSettings; readonly story?: StoryBiasOverlay }) {
  const { store } = useAppContext();
  const sampling = loaded.draft.sampling;
  const context = samplingContextForDraft(loaded.view, loaded.draft);
  const usable = loaded.view.editable && context !== null
    && (resolveSamplingKnob(context, sampling, "phraseBias").kind === "available"
      || resolveSamplingKnob(context, sampling, "bannedStrings").kind === "available");
  const hasEntries = sampling.phraseBias.length > 0 || sampling.bannedStrings.length > 0
    || (story?.phraseBias.length ?? 0) > 0 || (story?.bannedStrings.length ?? 0) > 0;
  const key = JSON.stringify([targetIdentity(loaded), sampling.logitBias, sampling.phraseBias, sampling.bannedStrings, story ?? null]);
  const [state, setState] = useState<PreviewState | null>(null);
  const active = usable && hasEntries;

  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    setState({ key, kind: "pending" });
    const timer = setTimeout(() => {
      const connection = store.get().connection;
      if (connection.kind !== "connected") return;
      connection.api.resolveSamplingBias({
        settings: probeTargetFor(loaded),
        logitBias: { ...sampling.logitBias },
        phraseBias: sampling.phraseBias.map((entry) => ({ ...entry })),
        bannedStrings: [...sampling.bannedStrings],
        ...(story === undefined ? {} : { storyPhraseBias: story.phraseBias, storyBannedStrings: story.bannedStrings })
      }).then(
        (result) => { if (!cancelled) setState({ key, kind: "ready", result }); },
        (error: unknown) => { if (!cancelled) setState({ key, kind: "failed", message: errorMessage(error) }); }
      );
    }, PREVIEW_DELAY_MS);
    return () => { cancelled = true; clearTimeout(timer); };
    // The key names everything the request is made from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, key]);

  if (!active || state === null || state.key !== key) return null;
  return (
    <div className="settings-preview" role="status" aria-label="Bias preview">
      {previewLines(state).map((line) => <p key={line}>{line}</p>)}
    </div>
  );
}

function previewLines(state: PreviewState): string[] {
  if (state.kind === "pending") return ["Checking the phrases against the tokenizer…"];
  if (state.kind === "failed") return [`Could not check the phrases: ${state.message}`];
  const result = state.result;
  if (result.kind === "tokenizer-unavailable") {
    return [`The phrases cannot be checked: ${samplingBiasResolutionFailureMessage(result)}.`];
  }
  const lines = [`The phrases and the bias resolve to ${result.resolvedEntryCount} token ${result.resolvedEntryCount === 1 ? "entry" : "entries"}.`];
  for (const entry of [...result.phraseBias, ...result.bannedStrings]) {
    if (entry.kind === "rejected" || entry.kind === "shadowed") lines.push(samplingBiasEntryRejectionMessage(entry));
  }
  for (const entry of result.nativeBannedStrings) {
    if (entry.kind === "blocked") lines.push(samplingBiasNativeBlockedMessage(entry));
  }
  return lines;
}

/** Every sampling number and list, with the reason when the provider does
 * not take one. A value that is stored stays editable, so it can be cleared. */
export function SamplingSection({ loaded }: { readonly loaded: LoadedSettings }) {
  const { actions } = useAppContext();
  const { draft, view } = loaded;
  const locked = !view.editable || loaded.busy !== null;
  return (
    <Section title="Sampling">
      {SAMPLING_LAYER_ROWS.map((row) => {
        const heading = row.section === undefined
          ? null
          : <h3 key={`h-${row.section}`} className="settings-subheading">{row.section}</h3>;
        if (row.kind === "scalar") {
          const knob = row.knob;
          const presentation = samplingAvailability(view, draft, knob);
          const text = samplingScalarText(draft, knob);
          const standing = knob === "mirostat" ? "Empty is off. 1 is v1. 2 is v2." : SAMPLING_SCALAR_PRESENTATION[knob].hint;
          return (
            <div key={knob}>
              {heading}
              <TextInputRow
                label={cap(samplingKnobLabel(knob))}
                value={text}
                refused={loaded.invalid[`sampling.${knob}`]}
                disabled={locked || !presentation.available && text === ""}
                placeholder="Default"
                hint={presentation.available ? standing ?? "Empty uses the provider default." : presentation.reason}
                onChange={(next) => actions.settings.setSamplingScalar(knob, next)}
              />
            </div>
          );
        }
        const list = SAMPLING_LISTS.find((candidate) => candidate.panel === row.panel)!;
        const presentation = samplingAvailability(view, draft, list.knob);
        const text = samplingListText(draft, list.panel);
        const count = samplingListCount(draft, list.panel);
        const limit = samplingListLimit(view, draft, list.panel);
        return (
          <div key={list.panel}>
            {heading}
            <LinesRow
              label={list.label}
              value={text}
              refused={loaded.invalid[`sampling.${list.panel}`]}
              disabled={locked || !presentation.available && count === 0}
              hint={presentation.available ? `${list.help} Up to ${limit}.` : presentation.reason}
              onChange={(next) => actions.settings.setSamplingList(list.panel, next)}
            />
          </div>
        );
      })}
      <BiasPreview loaded={loaded} />
    </Section>
  );
}

function cap(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
