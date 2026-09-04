import { resolveFactState } from "../../shared/fact-state.js";
import type { FactConsistencyRun } from "../../shared/fact-consistency-types.js";
import type { NodeStub, StoryPayload } from "../../shared/types.js";
import type {
  FactConsistencyCheckResult,
  FactConsistencyInput,
  FactConsistencyPlan
} from "./fact-consistency-api.js";
import {
  factConsistencyLineForPart,
  factConsistencySelectionForPart
} from "./fact-consistency-check.js";

/** The in-memory Fact consistency backend used by the demo StoryApi. Keep
 * run storage and payload presence together so demo.ts only wires the API. */
export interface DemoFactConsistencyStore {
  forget(storyId: string): void;
  projectPresence(payload: StoryPayload): StoryPayload;
  planFactConsistency(
    payload: StoryPayload,
    input: FactConsistencyInput
  ): Promise<FactConsistencyPlan>;
  checkFactConsistency(
    payload: StoryPayload,
    input: FactConsistencyInput,
    model: string
  ): Promise<FactConsistencyCheckResult>;
  getFactConsistencyRun(storyId: string): Promise<FactConsistencyRun | null>;
}

export function createDemoFactConsistencyStore(): DemoFactConsistencyStore {
  const runs = new Map<string, FactConsistencyRun>();
  return {
    forget: (storyId) => { runs.delete(storyId); },
    projectPresence: (payload) => runs.has(payload.id)
      ? { ...payload, hasFactConsistencyRun: true }
      : payload,
    planFactConsistency: async (payload, input) => ({
      partCount: demoFactConsistencyPartCount(payload, input),
      requestCount: demoFactConsistencyRequestCount(payload, input),
      planToken: "0".repeat(64)
    }),
    checkFactConsistency: async (payload, input, model) => {
      const run = demoFactConsistencyRun(payload, input, model);
      runs.set(payload.id, run);
      return {
        run,
        payload: { ...payload, hasFactConsistencyRun: true }
      };
    },
    getFactConsistencyRun: async (storyId) => runs.get(storyId) ?? null
  };
}

export function demoFactConsistencyPartCount(
  payload: StoryPayload,
  input: FactConsistencyInput
): number {
  const line = factConsistencyLineForPart(payload, input.focusedPartId);
  return demoFactConsistencyParts(payload, input)
    .filter((part) => demoFactForPart(
      payload,
      line,
      line.findIndex(({ id }) => id === part.id)
    ) !== null)
    .length;
}

/** The demo checks one provider request per eligible part. Live adapters
 * return the backend's exact batched count through the same field. */
export function demoFactConsistencyRequestCount(
  payload: StoryPayload,
  input: FactConsistencyInput
): number {
  return demoFactConsistencyPartCount(payload, input);
}

export function demoFactConsistencyRun(
  payload: StoryPayload,
  input: FactConsistencyInput,
  model: string
): FactConsistencyRun {
  const line = factConsistencyLineForPart(payload, input.focusedPartId);
  const selectedTakeIds = new Set(payload.path.map(({ id }) => id));
  const parts = demoFactConsistencyParts(payload, input).flatMap((part) => {
    const pathIndex = line.findIndex(({ id }) => id === part.id);
    const fact = demoFactForPart(payload, line, pathIndex);
    const quote = demoFactConsistencyQuote(part.text ?? part.preview);
    if (fact === null || quote === null) return [];
    return [{
      partId: part.id,
      takeId: part.id,
      selectedAtRun: selectedTakeIds.has(part.id),
      findings: [{
        fact_id: fact.id,
        quote,
        statement: "dry-run placeholder contradiction"
      }],
      droppedFindings: 0
    }];
  });
  return {
    format: "1667-fact-consistency-run",
    schemaVersion: 1,
    runId: `demo-fact-consistency-${payload.updatedAt}`,
    scope: input.scope,
    anchor: { partId: input.focusedPartId, takeId: input.focusedPartId },
    checkedAt: payload.updatedAt,
    provider: { profile: "utility", preset: "dry-run", model },
    storyLineTakeIds: line.map(({ id }) => id),
    parts,
    droppedFindings: 0
  };
}

function demoFactConsistencyParts(
  payload: StoryPayload,
  input: FactConsistencyInput
): readonly NodeStub[] {
  return factConsistencySelectionForPart(
    payload,
    input.focusedPartId,
    input.scope === "story-line" ? "line" : "chapter"
  );
}

function demoFactForPart(
  payload: StoryPayload,
  path: readonly { id: string }[],
  pathIndex: number
) {
  const requestPath = path.slice(0, pathIndex + 1);
  return payload.facts.find((fact) => resolveFactState(fact, requestPath).kind === "active") ?? null;
}

function demoFactConsistencyQuote(text: string): string | null {
  if (text.length < 2) return null;
  const boundary = text.search(/[.!?](?:\s|$)/u);
  const length = boundary >= 0 ? boundary + 1 : text.length - 1;
  return text.slice(0, Math.max(1, Math.min(text.length - 1, length)));
}
