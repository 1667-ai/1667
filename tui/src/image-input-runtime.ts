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

/** Shown for `unknown` support, verbatim, the design's exact wording. */
export const IMAGE_INPUT_UNKNOWN_MESSAGE =
  "image input is not configured for this model · set it in Advanced settings";

/** Shown when the attach-image entry point itself is closed
 *  (shared/image-input-release.ts) - the whole feature is inactive in this
 *  release, distinct from a per-model capability refusal. */
export const IMAGE_INPUT_ENTRY_POINTS_CLOSED_MESSAGE = "image input is not available in this release";

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
    : "image input is turned off for this model · set it in Advanced settings";
}
