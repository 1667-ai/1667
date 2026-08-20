import type { AppSource } from "./app.js";
import type { ActionContext } from "./action-context.js";
import {
  sameGenerationSettings,
  sameSettingsDraft,
  settingsRowUsesServer
} from "./settings-overlay-model.js";
import { settingsTextDraftWithDetectedContext } from "./settings-text.js";
import { settingsProviderProbeTarget } from "./settings-provider-probe.js";
import { sameConnectionSecrets } from "./settings-secret-sidecar.js";
import { activeSettingsEdit } from "./settings-edit-state.js";
import { replaceSettingsDraft } from "./settings-draft-transition.js";
import {
  settingsSubscriptionLoginHint,
  settingsSubscriptionPreset
} from "./settings-subscription.js";
import type { RuntimeState, SettingsOverlayState } from "./state.js";

/** The pieces `runContextProbe` and the automatic trigger actually need —
 * narrow enough that `detectSettingsContextForModelChange` is callable from
 * settings-model-discovery.ts's `runModelDiscoveryRequest`, which only has
 * these, not the full `AppSource`/`ActionContext` the manual `p` action's
 * caller passes (a wider object satisfies a narrower parameter type, so
 * that caller is unaffected). */
type ProbeSource = Pick<AppSource, "api">;
type ProbeContext = Pick<ActionContext, "backend" | "repaint">;

/** The probe engine: build the target, call the API, and apply the result
 * against whatever the overlay looks like when the response lands —
 * discarding it if `isCurrent()` has gone false (a newer request took over,
 * for either admission path below), the overlay closed, or the draft moved
 * out from under it (a later inline edit, a manual context entry landing, a
 * profile switch, or a re-keyed secret). Shared by both callers: the manual
 * `p` action passes `ActionTask.owns()` from the exclusive slot it claims;
 * the automatic model-change trigger has no task to ask, since it never
 * claims that slot, so it passes the lane ownership `ActionRuntime.
 * runWhenIdle` (action-runtime.ts) already tracks for it. */
async function runContextProbe(
  state: RuntimeState,
  source: ProbeSource,
  context: ProbeContext,
  overlay: SettingsOverlayState,
  isCurrent: () => boolean
): Promise<void> {
  if (state.settings !== overlay || !isCurrent()) return;
  overlay.probing = true;
  overlay.result = null;
  context.repaint();
  const editable = overlay.view.editable;
  const probed = editable ? overlay.draft.generation : overlay.view.effective;
  const probedProfileId = overlay.draft.selectedProfileId;
  const probedDocument = overlay.draft.document;
  // The probe now authenticates with the sidecar key, so the key is part of
  // what was probed. Without it a limit discovered under one key could land
  // in a draft the writer has since re-keyed.
  const probedSecrets = overlay.connectionSecrets;
  try {
    // No model-first gate here. Whether one is needed is the probe's own
    // knowledge — KoboldCpp and llama.cpp answer from the loaded model
    // without being told its name — and a provider that does need one
    // returns nothing, which lands on the manual-entry warning below.
    const { contextWindow } = await source.api.probeContextWindow(
      settingsProviderProbeTarget(
        overlay.view,
        probed,
        overlay.connectionSecrets,
        probedDocument,
        probedProfileId
      )
    );
    const currentlyEditable = overlay.view.editable;
    const current = currentlyEditable
      ? overlay.draft.generation
      : overlay.view.effective;
    const edit = activeSettingsEdit(state, overlay);
    if (!isCurrent() || state.settings !== overlay
      || edit !== null
      || currentlyEditable !== editable
      || overlay.draft.selectedProfileId !== probedProfileId
      || !sameProbeIdentity(probed, current)
      || !sameConnectionSecrets(probedSecrets, overlay.connectionSecrets)
      || current.contextWindow !== probed.contextWindow) {
      return;
    }
    if (contextWindow === null) {
      overlay.result = {
        state: "warning",
        message: "context window unavailable · enter it here"
      };
      overlay.resultRow = "context-window";
      return;
    }
    if (editable) {
      replaceSettingsDraft(
        overlay,
        settingsTextDraftWithDetectedContext(overlay.draft, contextWindow)
      );
      if (sameSettingsDraft(overlay.draft, overlay.base)) overlay.conflict = null;
      else if (overlay.conflict !== null) overlay.conflict.armed = false;
    }
    const suffix = editable
      ? " · s saves"
      : " · legacy settings stay read-only";
    overlay.result = {
      state: "ready",
      message: `context window · ${contextWindow.toLocaleString("en-US")} tokens${suffix}`
    };
    overlay.resultRow = "context-window";
  } catch (error) {
    // A rejection here — ECONNREFUSED, a TLS failure, a timeout, the
    // "selected profile no longer exists" invariant — used to vanish into
    // an empty `catch {}`. The manual `p` action and the automatic
    // model-change trigger both reach this catch, so both report a probe
    // failure the same way: a warning parked on the row the writer is
    // looking at, exactly like the two failure modes above.
    if (isCurrent() && state.settings === overlay) {
      overlay.result = {
        state: "warning",
        message: `context probe failed · ${error instanceof Error ? error.message : String(error)}`
      };
      overlay.resultRow = "context-window";
    }
  } finally {
    if (isCurrent() && state.settings === overlay) {
      overlay.probing = false;
    }
  }
}

/** A fixed subscription connection's context window is a plan constant, not
 * something a server round trip could discover — report the same
 * manual-entry warning instead of probing, whichever admission path got
 * here, and never touch the runtime for it. Returns whether it applied. */
function reportSubscriptionInsteadOfProbing(
  context: ProbeContext,
  overlay: SettingsOverlayState
): boolean {
  const subscriptionPreset = settingsSubscriptionPreset(overlay);
  if (subscriptionPreset === null) return false;
  overlay.result = {
    state: "warning",
    message: `${settingsSubscriptionLoginHint(
      subscriptionPreset,
      overlay.view.subscriptionAuth
    )} Enter context size manually.`
  };
  overlay.resultRow = "context-window";
  context.repaint();
  return true;
}

/** The manual `p` action: a foreground action like any other, so it claims
 * `ActionRuntime`'s exclusive slot (action-runtime.ts) and reports "busy"
 * if something else already holds it. */
export async function detectSettingsContext(
  state: RuntimeState,
  source: AppSource,
  context: ActionContext,
  overlay: SettingsOverlayState
): Promise<void> {
  if (reportSubscriptionInsteadOfProbing(context, overlay)) return;
  await context.backend.run("detecting context window", (task) =>
    runContextProbe(state, source, context, overlay, () => task.owns()));
}

/** The one lane key every automatic probe attempt shares — see
 * `ActionRuntime.runWhenIdle`: a second request for this key replaces
 * whatever it is currently doing rather than piling another attempt on
 * top of it. */
const AUTOMATIC_PROBE_LANE = "settings-context-probe";

/** The preconditions that decide whether the overlay's current model
 * identity still needs a context-window probe at all: the overlay is still
 * current and editable with a document to write into, the model field is
 * not blank, and no context window is already known. Extracted so this
 * module stays the probe engine and nothing else has to re-derive "does
 * this draft still need probing" — the seam that arms the automatic
 * trigger (below) and the lane's `stillWanted` re-check both ask this same
 * question of whatever the overlay's live state is at the time, never a
 * snapshot taken earlier. */
function settingsModelChangeNeedsProbe(
  state: RuntimeState,
  overlay: SettingsOverlayState
): boolean {
  if (state.settings !== overlay || !overlay.view.editable || overlay.draft.document === null) {
    return false;
  }
  if (overlay.draft.generation.model.trim().length === 0) return false;
  return overlay.draft.generation.contextWindow === null;
}

/** Drain the intent a draft transition armed when it landed a model with no
 * known context window (`overlay.contextProbeArmed` — settings-model-
 * selection.ts's `applySettingsModelChoice` and settings-overlay-model.ts's
 * `cycleSettingsProvider`, the two functions that can change
 * `overlay.draft.generation.model`, both set it). Call this after every
 * point a model choice can land: the settings dispatch seam
 * (settings-overlay-actions.ts) after its synchronous dispatch, and
 * settings-model-discovery.ts's `runModelDiscoveryRequest` after
 * publishing a discovery response — discovery's own auto-select
 * (`publishModelDiscovery`) lands asynchronously, well after any
 * synchronous dispatch has returned, which is exactly the path a
 * before/after model-identity comparison at one call site cannot see.
 *
 * One flag, drained wherever a landing could have happened, rather than
 * each call site separately re-deriving "did the model just change" — the
 * gap that left discovery's auto-select with no trigger at all.
 *
 * Never claims `ActionRuntime`'s exclusive foreground slot
 * (`context.backend.runWhenIdle`, not `.run`): the writer never asked for
 * this probe, so it must never make an explicit save, check, generation,
 * or the manual `p` action fail as busy — even against a hanging provider.
 * `runWhenIdle`'s lane key means a later model change supersedes an
 * earlier pending or in-flight attempt instead of stacking a retry loop
 * behind it. */
export function detectSettingsContextForModelChange(
  state: RuntimeState,
  source: ProbeSource,
  context: ProbeContext,
  overlay: SettingsOverlayState
): void {
  if (!overlay.contextProbeArmed) return;
  overlay.contextProbeArmed = false;
  if (!settingsModelChangeNeedsProbe(state, overlay)) return;
  if (reportSubscriptionInsteadOfProbing(context, overlay)) return;
  context.backend.runWhenIdle(
    AUTOMATIC_PROBE_LANE,
    (isCurrent) => runContextProbe(state, source, context, overlay, isCurrent),
    () => settingsModelChangeNeedsProbe(state, overlay)
  );
}

export async function checkSettings(
  state: RuntimeState,
  source: AppSource,
  context: ActionContext,
  overlay: SettingsOverlayState
): Promise<void> {
  const subscriptionPreset = settingsSubscriptionPreset(overlay);
  if (subscriptionPreset !== null) {
    overlay.result = {
      state: "warning",
      message: `${settingsSubscriptionLoginHint(
        subscriptionPreset,
        overlay.view.subscriptionAuth
      )} Connection check is unavailable here.`
    };
    overlay.resultRow = "base-url";
    context.repaint();
    return;
  }
  await context.backend.run("checking model server", async (task) => {
    if (state.settings !== overlay) return;
    overlay.checking = true;
    overlay.result = null;
    context.repaint();
    try {
      const checked = overlay.view.editable
        ? overlay.draft.generation
        : overlay.view.effective;
      const checkedProfileId = overlay.draft.selectedProfileId;
      const checkedDocument = overlay.draft.document;
      const checkedSecrets = overlay.connectionSecrets;
      const result = await source.api.checkModelServer(
        settingsProviderProbeTarget(
          overlay.view,
          checked,
          overlay.connectionSecrets,
          checkedDocument,
          checkedProfileId
        )
      );
      const current = overlay.view.editable
        ? overlay.draft.generation
        : overlay.view.effective;
      const edit = activeSettingsEdit(state, overlay);
      if (task.owns() && state.settings === overlay
        && (edit === null
          || edit.kind === "row" && !settingsRowUsesServer(edit.row))
        && overlay.draft.selectedProfileId === checkedProfileId
        && sameConnectionSecrets(checkedSecrets, overlay.connectionSecrets)
        && sameGenerationSettings(checked, current)) {
        overlay.result = result;
        overlay.resultRow = "base-url";
      }
    } finally {
      if (task.owns() && state.settings === overlay) {
        overlay.checking = false;
      }
    }
  });
}

function sameProbeIdentity(
  left: SettingsOverlayState["draft"]["generation"],
  right: SettingsOverlayState["draft"]["generation"]
): boolean {
  return left.provider === right.provider
    && left.baseUrl === right.baseUrl
    && left.model === right.model
    && left.apiKeyEnv === right.apiKeyEnv
    && left.allowInsecureHttp === right.allowInsecureHttp;
}
