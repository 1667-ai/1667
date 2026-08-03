import type { SearchRequest } from "../shared/story-search.js";
import {
  REWRITE_DESTINATIONS,
  type CreateNodeRequest,
  type EditNodeRequest,
  type PruneUnusedTakesRequest,
  type RewriteDestination,
  type RewriteRequest,
  type SwitchRequest,
  type TakeFromCutRequest
} from "../shared/types.js";
import { ServiceError } from "./errors.js";
import { hasDefinedProperty, requireRecord, requireString, requireStringValue } from "./validation.js";

export function parseSwitchOptions(value: unknown): Omit<SwitchRequest, "nodeId"> {
  const body = requireRecord(value, "switch options");
  return {
    ...(body.expectedLineFingerprint === undefined ? {} : {
      expectedLineFingerprint: requireString(body.expectedLineFingerprint, "expectedLineFingerprint")
    }),
    ...(body.stopAtNode === undefined ? {} : { stopAtNode: requireBoolean(body.stopAtNode, "stopAtNode") })
  };
}

export function parseCreateNode(value: unknown): CreateNodeRequest {
  const body = requireRecord(value, "node body");
  const text = requireStringValue(body.text, "text");
  const instruction = body.instruction === undefined
    ? undefined
    : requireStringValue(body.instruction, "instruction");
  const hasParentId = hasDefinedProperty(body, "parentId");
  const appendTo = body.appendTo === undefined ? null : requireString(body.appendTo, "appendTo");
  const sourceNodeId = body.sourceNodeId === undefined
    ? null
    : requireString(body.sourceNodeId, "sourceNodeId");
  const targetCount = Number(hasParentId) + Number(appendTo !== null) + Number(sourceNodeId !== null);
  if (targetCount !== 1) {
    throw new ServiceError(400, "Provide exactly one of parentId, appendTo, or sourceNodeId");
  }
  const common = { text, ...(instruction === undefined ? {} : { instruction }) };
  const genId = body.genId === undefined ? null : requireString(body.genId, "genId");
  if (hasParentId) {
    if (body.parentId !== null && typeof body.parentId !== "string") {
      throw new ServiceError(400, "parentId must be a string or null");
    }
    return { ...common, parentId: body.parentId, ...(genId === null ? {} : { genId }) };
  }
  const expectedTextHash = requireString(body.expectedTextHash, "expectedTextHash");
  if (appendTo !== null) {
    if (genId === null) throw new ServiceError(400, "appendTo requires genId");
    return { ...common, appendTo, expectedTextHash, genId };
  }
  if (genId !== null) throw new ServiceError(400, "sourceNodeId cannot carry genId");
  if (sourceNodeId === null) throw new ServiceError(400, "Missing sourceNodeId");
  return { ...common, sourceNodeId, expectedTextHash };
}

export function parseEditNode(value: unknown): EditNodeRequest {
  const body = requireRecord(value, "node edit");
  const result: EditNodeRequest = {
    expectedTextHash: requireString(body.expectedTextHash, "expectedTextHash")
  };
  if (body.text !== undefined) result.text = requireStringValue(body.text, "text");
  if (body.instruction !== undefined) result.instruction = requireStringValue(body.instruction, "instruction");
  if (result.text === undefined && result.instruction === undefined) {
    throw new ServiceError(400, "Provide text or instruction");
  }
  return result;
}

export function parseTakeFromCut(value: unknown): TakeFromCutRequest {
  const body = requireRecord(value, "take-from-cut body");
  return {
    offset: requireNumber(body.offset, "offset"),
    ...(body.expected === undefined ? {} : { expected: requireStringValue(body.expected, "expected") })
  };
}

export function parsePruneUnusedTakes(value: unknown): PruneUnusedTakesRequest {
  const body = requireRecord(value, "prune body");
  const expectedTakeCount = requireNumber(body.expectedTakeCount, "expectedTakeCount");
  const expectedPartCount = requireNumber(body.expectedPartCount, "expectedPartCount");
  if (!Number.isSafeInteger(expectedTakeCount) || expectedTakeCount < 1
    || !Number.isSafeInteger(expectedPartCount) || expectedPartCount < expectedTakeCount) {
    throw new ServiceError(400, "Prune preview counts are invalid");
  }
  return {
    expectedStoryRevision: requireString(body.expectedStoryRevision, "expectedStoryRevision"),
    expectedTakeCount,
    expectedPartCount
  };
}

export function parseRewrite(value: unknown): RewriteRequest {
  const body = requireRecord(value, "rewrite body");
  return {
    start: requireNumber(body.start, "start"),
    end: requireNumber(body.end, "end"),
    expected: requireString(body.expected, "expected"),
    instruction: body.instruction === undefined ? "" : requireStringValue(body.instruction, "instruction"),
    ...(body.destination === undefined ? {} : { destination: requireRewriteDestination(body.destination) })
  };
}

function requireRewriteDestination(value: unknown): RewriteDestination {
  if (!(REWRITE_DESTINATIONS as readonly unknown[]).includes(value)) {
    throw new ServiceError(400, `destination must be one of: ${REWRITE_DESTINATIONS.join(", ")}`);
  }
  return value as RewriteDestination;
}

export function parseSummaryTake(value: unknown): Record<string, unknown> {
  const body = requireRecord(value, "summary body");
  return {
    nodeId: requireString(body.nodeId, "nodeId"),
    ...(body.offset === undefined ? {} : { offset: requireNumber(body.offset, "offset") }),
    ...(body.expected === undefined ? {} : { expected: requireStringValue(body.expected, "expected") })
  };
}

export function parseSearchRequest(value: unknown): SearchRequest {
  const body = requireRecord(value, "search request");
  const scope = requireString(body.scope, "scope");
  if (scope !== "tree" && scope !== "vault") {
    throw new ServiceError(400, "scope must be tree or vault");
  }
  return {
    query: requireStringValue(body.query, "query"),
    scope,
    storyId: requireString(body.storyId, "storyId"),
    caseSensitive: body.caseSensitive === undefined
      ? false
      : requireBoolean(body.caseSensitive, "caseSensitive")
  };
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ServiceError(400, `${label} must be a number`);
  }
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new ServiceError(400, `${label} must be a boolean when provided`);
  return value;
}
