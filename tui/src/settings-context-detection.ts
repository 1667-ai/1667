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
import {
  replaceSettingsDraft,
  settingsContextWindowIsManual
} from "./settings-draft-transition.js";
import {
  settingsSubscriptionLoginHint,
  settingsSubscriptionPreset
} from "./settings-subscription.js";
import type { RuntimeState, SettingsOverlayState } from "./state.js";

/** Probe the selected draft without letting a late response overwrite newer
 * inline edits or a context limit entered while the request was in flight.
 *
 * `options.reportBusy` defaults to true, matching the manual `p` action: it
 * asked for this, so a slot already claimed by something else is worth a
 * toast. The automatic model-change trigger passes `false`
 * (`detectSettingsContextForModelChange` below) — the writer never asked
 * for that probe, so it must never announce itself as the reason something
 * else is "busy".
 *
 * Returns whether the probe actually ran: `false` only when the backend
 * slot was claimed by something else at the moment this called `run`
 * (`ActionRuntime.run` rejects rather than queuing), so a caller that must
 * not lose the probe — the deferred retry loop below — knows to wait and
 * try again instead of treating rejection as "handled". */
export async function detectSettingsContext(
  state: RuntimeState,
  source: AppSource,
  context: ActionContext,
  overlay: SettingsOverlayState,
  options: { reportBusy?: boolean } = {}
): Promise<boolean> {
  const subscriptionPreset = settingsSubscriptionPreset(overlay);
  if (subscriptionPreset !== null) {
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
  return context.backend.run("detecting context window", async (task) => {
    if (state.settings !== overlay) return;
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
      if (!task.owns() || state.settings !== overlay
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
      // an empty `catch {}` at the one call site that awaited this
      // (detectSettingsContextForModelChange). `context.backend.observe`
      // (action-runtime.ts) already turns an unhandled rejection into a
      // toast, but a toast just says something failed; it does not explain
      // where, and it can be missed entirely if another toast follows
      // before the writer reads it. The manual `p` action and the automatic
      // model-change trigger both reach this catch, so both report a probe
      // failure the same way: a warning parked on the row the writer is
      // looking at, exactly like the two failure modes above.
      if (task.owns() && state.settings === overlay) {
        overlay.result = {
          state: "warning",
          message: `context probe failed · ${error instanceof Error ? error.message : String(error)}`
        };
        overlay.resultRow = "context-window";
      }
    } finally {
      if (task.owns() && state.settings === overlay) {
        overlay.probing = false;
      }
    }
  }, options);
}

/** The preconditions that decide whether a model identity needs a
 *  context-window probe at all: the overlay is still current and editable
 *  with a document to write into, the model field is not blank, no context
 *  window is already known, and the writer has not entered one by hand.
 *  Extracted so this module stays the probe engine and nothing else has to
 *  re-derive "does this draft still need probing" — the seam in
 *  settings-overlay-actions.ts only has to notice that the model identity
 *  changed at all; this decides whether that change still needs a probe,
 *  both up front and again after a deferred wait (below). */
function settingsModelChangeNeedsProbe(
  state: RuntimeState,
  overlay: SettingsOverlayState
): boolean {
  if (state.settings !== overlay || !overlay.view.editable || overlay.draft.document === null) {
    return false;
  }
  if (overlay.draft.generation.model.trim().length === 0) return false;
  if (overlay.draft.generation.contextWindow !== null) return false;
  if (settingsContextWindowIsManual(overlay)) return false;
  return true;
}

/** Run after a model identity change commits, so the writer never has to
 *  press `p` themselves for the common case. A discovered model already
 *  carries its context window onto the draft the moment it is chosen
 *  (applySettingsModelChoice's `contextWindow` default in
 *  settings-model-selection.ts), so `settingsModelChangeNeedsProbe` only
 *  ever lets this reach a genuinely unknown model.
 *
 *  Void and self-observing, the same shape as `resolveSamplingBias`
 *  (sampling-bias-resolution.ts): the caller writes one line —
 *  `detectSettingsContextForModelChange(state, source, context, overlay)`
 *  — and cannot forget to route the result through `backend.observe`.
 *
 *  Unlike the manual `p` action, this must never contend with the writer
 *  for `ActionRuntime`'s single admission slot (action-runtime.ts): a save
 *  or check the writer asked for must not be rejected with a "busy" toast
 *  just because a background probe claimed the slot first, and the probe
 *  itself must not be silently dropped just because the slot was busy the
 *  instant the model committed. `deferUntilIdle` below waits instead of
 *  contending, and passes `reportBusy: false` so the probe itself never
 *  announces "busy" on the writer's behalf. */
export function detectSettingsContextForModelChange(
  state: RuntimeState,
  source: AppSource,
  context: ActionContext,
  overlay: SettingsOverlayState
): void {
  if (!settingsModelChangeNeedsProbe(state, overlay)) return;
  context.backend.observe(deferUntilIdle(state, source, context, overlay));
}

/** Wait for the exclusive backend slot rather than contend for it, retrying
 *  if another deferred probe wins the race the instant the slot frees —
 *  `whenIdle` can resolve several waiters in the same turn, and only one of
 *  them actually claims `run`. Every re-check re-validates the precondition,
 *  so a probe made unnecessary while it waited (the model moved again, a
 *  manual context size landed, the overlay closed) quietly stops instead of
 *  running stale — the same staleness discipline `detectSettingsContext`
 *  already applies to its own in-flight response. */
async function deferUntilIdle(
  state: RuntimeState,
  source: AppSource,
  context: ActionContext,
  overlay: SettingsOverlayState
): Promise<void> {
  for (;;) {
    const idle = await context.backend.whenIdle();
    if (!idle) return; // the runtime was disposed while this waited
    if (!settingsModelChangeNeedsProbe(state, overlay)) return;
    const ran = await detectSettingsContext(state, source, context, overlay, { reportBusy: false });
    if (ran) return;
  }
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
