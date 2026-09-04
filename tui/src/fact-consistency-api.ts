import type { StoryPayload } from "../../shared/types.js";
import {
  assertFactConsistencyRun,
  type FactConsistencyRun,
  type FactConsistencyScope
} from "../../shared/fact-consistency-types.js";
import { decodeStoryResponse } from "./api-response-decoders.js";

/** Input shared by the HTTP and embedded worker Fact consistency routes. */
export interface FactConsistencyInput {
  readonly storyId: string;
  readonly focusedPartId: string;
  readonly scope: FactConsistencyScope;
  /** Set by the plan response before a paid check starts. */
  readonly planToken?: string;
}

export interface FactConsistencyCheckInput extends FactConsistencyInput {
  readonly planToken: string;
}

export interface FactConsistencyPlan {
  readonly partCount: number;
  /** Exact provider request count after backend Fact batching. */
  readonly requestCount: number;
  /** Server-owned binding for the exact story/settings/batch plan. */
  readonly planToken: string;
}

export interface FactConsistencyCheckResult {
  readonly run: FactConsistencyRun;
  readonly payload: StoryPayload;
}

/** The optional methods keep older embedders source-compatible while the
 * worker protocol rolls out. Live and demo adapters provide all three. */
export interface FactConsistencyApi {
  planFactConsistency(input: FactConsistencyInput): Promise<FactConsistencyPlan>;
  checkFactConsistency(input: FactConsistencyCheckInput): Promise<FactConsistencyCheckResult>;
  getFactConsistencyRun(storyId: string): Promise<FactConsistencyRun | null>;
}

export function decodeFactConsistencyPlanResponse(value: unknown): FactConsistencyPlan {
  const record = responseRecord(value, "Fact consistency plan");
  if (!Number.isSafeInteger(record.partCount) || (record.partCount as number) < 0) {
    throw new Error("The server returned an invalid Fact consistency part count.");
  }
  if (!Number.isSafeInteger(record.requestCount) || (record.requestCount as number) < 0) {
    throw new Error("The server returned an invalid Fact consistency request count.");
  }
  if (typeof record.planToken !== "string" || !/^[a-f0-9]{64}$/u.test(record.planToken)) {
    throw new Error("The server returned an invalid Fact consistency plan token.");
  }
  return {
    partCount: record.partCount as number,
    requestCount: record.requestCount as number,
    planToken: record.planToken
  };
}

export function decodeFactConsistencyCheckResponse(value: unknown): FactConsistencyCheckResult {
  const record = responseRecord(value, "Fact consistency check");
  const run = decodeFactConsistencyRun(record.run);
  return {
    run,
    payload: decodeStoryResponse(record.payload)
  };
}

export function decodeFactConsistencyRunResponse(value: unknown): FactConsistencyRun | null {
  if (value === null) return null;
  return decodeFactConsistencyRun(value);
}

function decodeFactConsistencyRun(value: unknown): FactConsistencyRun {
  assertFactConsistencyRun(value);
  return value;
}

function responseRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`The server returned an invalid ${label} response.`);
  }
  return value as Record<string, unknown>;
}
