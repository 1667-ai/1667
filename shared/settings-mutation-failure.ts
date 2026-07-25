export type SettingsMutationFailureAction = "retain" | "refresh" | "retire";

/** Durable settings commands survive uncertain outcomes. Proven-stale state
 * needs refresh; an invalid, expired, or colliding command must be rebuilt
 * before it can be submitted again. */
export function settingsMutationFailureAction(
  code: string | null
): SettingsMutationFailureAction {
  if (
    code === "revision_conflict"
    || code === "conflict"
    || code === "settings_edit_requires_data_format_2"
  ) {
    return "refresh";
  }
  if (
    code === "invalid_request"
    || code === "content_too_large"
    || code === "unprocessable"
    || code === "forbidden"
    || code === "not_found"
    || code === "idempotency_conflict"
    || code === "mutation_expired"
  ) {
    return "retire";
  }
  return "retain";
}
