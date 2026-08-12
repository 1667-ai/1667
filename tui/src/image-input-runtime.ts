/**
 * Resolve whether the writer's active prose route may carry an image, using
 * the settings the running backend already resolved, never a guess from a
 * model-name prefix or a successful text request.
 *
 * A data-format-1 (legacy) settings document has no Generation Profile to
 * read a protocol or a remote model id from, so it resolves conservatively
 * to "unsupported" rather than inventing one.
 */
import { resolveImageInputCapability, type ImageInputCapabilityResolution } from "../../shared/image-input-capabilities.js";
import { selectSettingsRoute } from "../../shared/settings-route.js";
import type { SettingsView } from "../../shared/settings-v2-types.js";

/** Shown for `unknown` support. The design named an Advanced-settings
 *  override for this case; this release builds no such control, so the
 *  message stops promising one until that override exists. */
export const IMAGE_INPUT_UNKNOWN_MESSAGE = "image input is not configured for this model";

/** Shown when the attach-image entry point itself is closed
 *  (shared/image-input-release.ts) - the whole feature is inactive in this
 *  release, distinct from a per-model capability refusal. */
export const IMAGE_INPUT_ENTRY_POINTS_CLOSED_MESSAGE = "image input is not available in this release";

/**
 * This never passes a stored `override`/`overrideTokenCeiling`, unlike the
 * server's own `ImageInputContext` construction
 * (`server/generation-http.ts`'s `continueStory`, which reads one through
 * `SettingsStore.loadImageInputCapability`). `settingsView.document` is a
 * schema-2-shaped read model on purpose
 * (`server/settings-state-slot.ts`'s `settingsStateSlotReadOnlyView` doc
 * comment): it never carries `imageInput`/`imageTokenCeiling`, so there is
 * no wire field here to read one from. This is a client-side pre-check, not
 * the authorizing gate; the server refuses an unauthorized image again,
 * from the stored override, before it ever reaches a provider, so a stale
 * verdict here cannot let one through. It can only make this pre-check
 * wrong in the writer's favor: it may block an attach that a stored
 * `"supported"` override would have let the server accept. A later release
 * that adds a way to store an override should add a matching read channel
 * for the TUI and thread it through here.
 */
export function currentImageInputCapability(
  settingsView: SettingsView
): ImageInputCapabilityResolution {
  if (settingsView.document === null) {
    return { support: "unsupported", reason: "protocol-unsupported" };
  }
  const route = selectSettingsRoute(settingsView.document, "prose");
  return resolveImageInputCapability({
    protocol: route.connection.protocol,
    remoteModelId: route.model.remoteId
  });
}

/** The toast shown when an attachment action is refused. `supported` never
 *  reaches here, callers gate on it before calling this. */
export function imageInputRefusalMessage(
  resolution: Exclude<ImageInputCapabilityResolution, { support: "supported" }>
): string {
  if (resolution.support === "unknown") return IMAGE_INPUT_UNKNOWN_MESSAGE;
  return resolution.reason === "protocol-unsupported"
    ? "this protocol does not accept an image"
    : "image input is turned off for this model";
}
