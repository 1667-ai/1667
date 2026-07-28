import type { HttpCapabilityScope } from "../shared/http-auth.js";
import type { HttpRecoveryWarning } from "../shared/http-protocol.js";
import { failureWireFields } from "../shared/failure-envelope.js";
import {
  providerRecoveryFromArchive,
  storyIdFromMutationIntent,
  type ArchivedMutationOutboxRecord
} from "./mutation-outbox.js";

interface RecoveryWarningSource {
  readonly archivedMutationWarnings: readonly ArchivedMutationOutboxRecord[];
}

/** Story recovery metadata is visible only through story authority. */
export function httpRecoveryWarnings(
  service: RecoveryWarningSource | null,
  scope: HttpCapabilityScope | null
): HttpRecoveryWarning[] {
  if (service === null || scope !== "story") return [];
  return service.archivedMutationWarnings.map((archived) => {
    const { intent, resolution } = archived;
    const providerRecovery = providerRecoveryFromArchive(archived);
    return {
      mutationId: intent.mutationId,
      method: intent.method,
      storyId: storyIdFromMutationIntent(intent),
      ...(providerRecovery === undefined
        ? {}
        : { providerRecovery }),
      ...failureWireFields(resolution)
    };
  });
}
