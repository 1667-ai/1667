import {
  parseStoryAggregateVersion,
  type StoryAggregateVersion
} from "./story-aggregate-version.js";
import { isDurableMutationId } from "./durable-mutation-id.js";

export type ProviderRecoveryContext =
  | {
      readonly kind: "target";
      readonly providerMutationId: string;
    }
  | {
      readonly kind: "legacy";
      readonly warningAggregateVersion: StoryAggregateVersion;
    };

export function isProviderRecoveryContext(
  value: unknown
): value is ProviderRecoveryContext {
  if (value === null || typeof value !== "object"
    || Array.isArray(value)) {
    return false;
  }
  const context = value as Record<string, unknown>;
  const keys = Object.keys(context);
  if (context.kind === "target") {
    if (keys.length !== 2
      || !keys.includes("providerMutationId")) {
      return false;
    }
    if (!isDurableMutationId(context.providerMutationId)) {
      return false;
    }
    return true;
  }
  return context.kind === "legacy"
    && keys.length === 2
    && keys.includes("warningAggregateVersion")
    && validAggregateVersion(context.warningAggregateVersion);
}

export function isProviderMutationId(
  value: unknown
): value is string {
  return isDurableMutationId(value);
}

function validAggregateVersion(value: unknown): boolean {
  try {
    parseStoryAggregateVersion(
      value,
      "provider recovery warningAggregateVersion"
    );
    return true;
  } catch {
    return false;
  }
}
