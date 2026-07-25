import { randomUUID } from "node:crypto";
import type {
  ChapterSummaryEffect,
  ContinueStoryEffect,
  ProviderStoryEffect,
  SummaryTakeEffect
} from "./story-provider-effect.js";

export type PreparedProviderStoryEffect<
  Effect extends ProviderStoryEffect = ProviderStoryEffect
> = Effect extends ContinueStoryEffect
  ? Omit<Effect, "cancelled" | "nodeId" | "committedAt"> & {
      readonly nodeId: string;
      readonly committedAt: string;
    }
  : Effect extends SummaryTakeEffect
    ? Omit<Effect, "cancelled" | "commitIds" | "committedAt"> & {
        readonly commitIds: Required<SummaryTakeEffect["commitIds"]>;
        readonly committedAt: string;
      }
    : Effect extends ChapterSummaryEffect
      ? Omit<Effect, "cancelled" | "summaryNodeId" | "committedAt"> & {
          readonly summaryNodeId: string;
          readonly committedAt: string;
        }
      : Omit<Effect, "cancelled">;

/** Freeze all IDs, timestamps, and cancellation checks before an effect can
 * cross the provider/terminal phase boundary. The returned effect is safe to
 * apply again to the current story without allocating a different result. */
export function prepareProviderStoryEffect<Effect extends ProviderStoryEffect>(
  effect: Effect
): PreparedProviderStoryEffect<Effect>;
export function prepareProviderStoryEffect(
  effect: ProviderStoryEffect
): PreparedProviderStoryEffect {
  const committedAt = new Date().toISOString();
  switch (effect.kind) {
    case "continue": {
      const {
        cancelled: _cancelled,
        nodeId = randomUUID(),
        committedAt: suppliedAt = committedAt,
        ...rest
      } = effect;
      return { ...rest, nodeId, committedAt: suppliedAt };
    }
    case "summary-take": {
      const {
        cancelled: _cancelled,
        committedAt: suppliedAt = committedAt,
        commitIds,
        ...rest
      } = effect;
      return {
        ...rest,
        committedAt: suppliedAt,
        commitIds: {
          summaryNodeId: commitIds.summaryNodeId ?? randomUUID(),
          cutNodeId: commitIds.cutNodeId ?? randomUUID()
        }
      };
    }
    case "chapter-summary": {
      const {
        cancelled: _cancelled,
        summaryNodeId = randomUUID(),
        committedAt: suppliedAt = committedAt,
        ...rest
      } = effect;
      return { ...rest, summaryNodeId, committedAt: suppliedAt };
    }
    case "rewrite": {
      const { cancelled: _cancelled, ...prepared } = effect;
      return prepared;
    }
    case "autoname":
      return { ...effect };
    default: {
      const exhaustive: never = effect;
      return exhaustive;
    }
  }
}
