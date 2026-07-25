import { hasUnpairedSurrogate } from "../shared/unicode.js";
import { ServiceError } from "./errors.js";
import {
  requireHash256,
  requireLedgerStoryId,
  requireMutationId,
  requireRevision20,
  requireUInt53
} from "./mutation-ledger-scalars.js";
import type {
  Hash256,
  MutationId
} from "./mutation-ledger-types.js";
import type {
  AbsentStoryAggregateVersion,
  StoryAggregateVersion,
  V5StoryAggregateVersion,
  V6StoryAggregateVersion
} from "../shared/story-aggregate-version.js";
export type {
  AbsentStoryAggregateVersion,
  StoryAggregateVersion,
  V5StoryAggregateVersion,
  V6StoryAggregateVersion
} from "../shared/story-aggregate-version.js";

export const MUTATION_COORDINATOR_GLOBAL_LIMIT = 4;
export const MAX_TRANSPORT_OPERATION_ID_BYTES = 1_024;

const REQUEST_KEYS = new Set([
  "transportOperationId",
  "mutationId",
  "fingerprint",
  "scope",
  "expectedAggregateVersion"
]);
const ADMISSION_REQUEST_KEYS = new Set([
  "transportOperationId",
  "mutationId",
  "scope",
  "expectedAggregateVersion"
]);
const SETTINGS_VERSION_KEYS = new Set(["kind", "stateGeneration"]);
const ABSENT_VERSION_KEYS = new Set(["kind"]);
const V5_VERSION_KEYS = new Set(["kind", "manifestHash"]);
const V6_VERSION_KEYS = new Set(["kind", "revision"]);

export interface MutationAggregateVersion {
  readonly kind: string;
}

export interface MutationTarget<
  Scope extends string = string,
  Version extends MutationAggregateVersion = MutationAggregateVersion
> {
  readonly scope: Scope;
  readonly expectedAggregateVersion: Version;
}

export interface SettingsAggregateVersion extends MutationAggregateVersion {
  readonly kind: "settings";
  readonly stateGeneration: number;
}

export type SettingsMutationTarget = MutationTarget<"settings", SettingsAggregateVersion>;

export type StoryMutationTarget = MutationTarget<`story:${string}`, StoryAggregateVersion>;

export type MutationCoordinatorRequest<Target extends MutationTarget> = Readonly<{
  transportOperationId: string;
  mutationId: MutationId;
  fingerprint: Hash256;
} & Target>;

export type MutationCoordinatorAdmissionRequest<Target extends MutationTarget> = Readonly<{
  transportOperationId: string;
  mutationId: MutationId;
} & Target>;

type MutationTargetParser<Target extends MutationTarget> = (
  scope: unknown,
  expectedAggregateVersion: unknown
) => Target;

/**
 * Process-local admission for one data directory. The handler owns durable
 * receipt lookup, aggregate-version comparison, mutation, and reconciliation.
 */
export class MutationCoordinator {
  private readonly activeScopes = new Set<string>();

  async runSettings<Result>(
    input: unknown,
    handler: (
      request: MutationCoordinatorRequest<SettingsMutationTarget>
    ) => Result | PromiseLike<Result>
  ): Promise<Result> {
    return await this.run(input, parseSettingsTarget, handler);
  }

  async runStory<Result>(
    input: unknown,
    handler: (
      request: MutationCoordinatorRequest<StoryMutationTarget>
    ) => Result | PromiseLike<Result>
  ): Promise<Result> {
    return await this.run(input, parseStoryTarget, handler);
  }

  /** Internal single-story maintenance uses the same scope/global admission
   * without inventing a user mutation receipt or catalog-wide lock. */
  async runStoryMaintenance<Result>(
    storyIdInput: unknown,
    handler: (scope: `story:${string}`) => Result | PromiseLike<Result>
  ): Promise<Result> {
    const scope = maintenanceScope(storyIdInput);
    return await this.runClaimed(scope, async () => await handler(scope));
  }

  /** Opportunistic maintenance for read paths. A claim that cannot be taken
   * means a live in-process mutation holds admission, so the residue this
   * would recover cannot be there: residue is what a crashed mutation leaves
   * behind, and its owner recovers it under its own claim. Readers skip
   * rather than fail an unrelated read. */
  async runStoryMaintenanceWhenIdle<Result>(
    storyIdInput: unknown,
    handler: (scope: `story:${string}`) => Result | PromiseLike<Result>
  ): Promise<Result | null> {
    const scope = maintenanceScope(storyIdInput);
    if (!this.admits(scope)) return null;
    return await this.runClaimed(scope, async () => await handler(scope));
  }

  private async run<Target extends MutationTarget, Result>(
    input: unknown,
    parseTarget: MutationTargetParser<Target>,
    handler: (
      request: MutationCoordinatorRequest<Target>
    ) => Result | PromiseLike<Result>
  ): Promise<Result> {
    const request = parseRequest(input, parseTarget);
    return await this.runClaimed(request.scope, async () => await handler(request));
  }

  /**
   * Claims a bounded target envelope before preparing target-specific input.
   * The admitted preparation must return the real fingerprint and its parsed
   * payload; the handler still receives the canonical five-field request.
   */
  async runAfterSettingsAdmission<Payload, Result>(
    input: unknown,
    prepare: (
      admission: MutationCoordinatorAdmissionRequest<SettingsMutationTarget>
    ) => Readonly<{ fingerprint: unknown; payload: Payload }>
      | PromiseLike<Readonly<{ fingerprint: unknown; payload: Payload }>>,
    handler: (
      request: MutationCoordinatorRequest<SettingsMutationTarget>,
      payload: Payload
    ) => Result | PromiseLike<Result>
  ): Promise<Result> {
    return await this.runAfterAdmission(input, parseSettingsTarget, prepare, handler);
  }

  async runAfterStoryAdmission<Payload, Result>(
    input: unknown,
    prepare: (
      admission: MutationCoordinatorAdmissionRequest<StoryMutationTarget>
    ) => Readonly<{ fingerprint: unknown; payload: Payload }>
      | PromiseLike<Readonly<{ fingerprint: unknown; payload: Payload }>>,
    handler: (
      request: MutationCoordinatorRequest<StoryMutationTarget>,
      payload: Payload
    ) => Result | PromiseLike<Result>
  ): Promise<Result> {
    return await this.runAfterAdmission(input, parseStoryTarget, prepare, handler);
  }

  private async runAfterAdmission<Target extends MutationTarget, Payload, Result>(
    input: unknown,
    parseTarget: MutationTargetParser<Target>,
    prepare: (
      admission: MutationCoordinatorAdmissionRequest<Target>
    ) => Readonly<{ fingerprint: unknown; payload: Payload }>
      | PromiseLike<Readonly<{ fingerprint: unknown; payload: Payload }>>,
    handler: (
      request: MutationCoordinatorRequest<Target>,
      payload: Payload
    ) => Result | PromiseLike<Result>
  ): Promise<Result> {
    const admission = parseAdmissionRequest(input, parseTarget);
    return await this.runClaimed(admission.scope, async () => {
      const prepared = await prepare(admission);
      const request = requestWithFingerprint(admission, prepared.fingerprint);
      return await handler(request, prepared.payload);
    });
  }

  private admits(scope: string): boolean {
    return !this.activeScopes.has(scope)
      && this.activeScopes.size < MUTATION_COORDINATOR_GLOBAL_LIMIT;
  }

  private async runClaimed<Result>(
    scope: string,
    handler: () => Result | PromiseLike<Result>
  ): Promise<Result> {
    // No await between checking and claiming: scope and global admission are
    // one atomic event-loop operation, never a queue.
    if (!this.admits(scope)) {
      throw new ServiceError(409, "Mutation capacity is busy; retry later", "resource_busy");
    }
    this.activeScopes.add(scope);
    try {
      return await handler();
    } finally {
      this.activeScopes.delete(scope);
    }
  }
}

export function createMutationCoordinator(): MutationCoordinator {
  return new MutationCoordinator();
}

function maintenanceScope(storyIdInput: unknown): `story:${string}` {
  let storyId: string;
  try {
    storyId = requireLedgerStoryId(storyIdInput, "Story maintenance scope");
  } catch {
    throw invalidRequest("Story maintenance scope must contain a canonical story ID");
  }
  return `story:${storyId}` as const;
}

function parseRequest<Target extends MutationTarget>(
  input: unknown,
  parseTarget: MutationTargetParser<Target>
): MutationCoordinatorRequest<Target> {
  const record = exactRecord(input, "Mutation request", REQUEST_KEYS);
  const admission = parseAdmissionRecord(record, parseTarget);
  return requestWithFingerprint(admission, record.fingerprint);
}

function parseAdmissionRequest<Target extends MutationTarget>(
  input: unknown,
  parseTarget: MutationTargetParser<Target>
): MutationCoordinatorAdmissionRequest<Target> {
  return parseAdmissionRecord(
    exactRecord(input, "Mutation admission request", ADMISSION_REQUEST_KEYS),
    parseTarget
  );
}

function parseAdmissionRecord<Target extends MutationTarget>(
  record: Record<string, unknown>,
  parseTarget: MutationTargetParser<Target>
): MutationCoordinatorAdmissionRequest<Target> {
  const transportOperationId = boundedTransportOperationId(record.transportOperationId);
  const mutationId = mutationIdValue(record.mutationId);
  const target = parseTarget(record.scope, record.expectedAggregateVersion);
  const expectedAggregateVersion = Object.freeze({ ...target.expectedAggregateVersion });

  return Object.freeze({
    transportOperationId,
    mutationId,
    scope: target.scope,
    expectedAggregateVersion
  }) as MutationCoordinatorAdmissionRequest<Target>;
}

function requestWithFingerprint<Target extends MutationTarget>(
  admission: MutationCoordinatorAdmissionRequest<Target>,
  fingerprintInput: unknown
): MutationCoordinatorRequest<Target> {
  return Object.freeze({
    transportOperationId: admission.transportOperationId,
    mutationId: admission.mutationId,
    fingerprint: fingerprintValue(fingerprintInput),
    scope: admission.scope,
    expectedAggregateVersion: admission.expectedAggregateVersion
  }) as MutationCoordinatorRequest<Target>;
}

function parseSettingsTarget(
  scope: unknown,
  expectedAggregateVersion: unknown
): SettingsMutationTarget {
  if (scope !== "settings") {
    throw invalidRequest("Mutation scope must be settings");
  }
  const version = exactRecord(
    expectedAggregateVersion,
    "Expected settings aggregate version",
    SETTINGS_VERSION_KEYS
  );
  if (version.kind !== "settings") {
    throw invalidRequest("Expected settings aggregate version kind must be settings");
  }
  const stateGeneration = uint53(version.stateGeneration, "Settings state generation");
  if (stateGeneration < 1) {
    throw invalidRequest("Settings state generation must be at least 1");
  }
  return {
    scope: "settings",
    expectedAggregateVersion: { kind: "settings", stateGeneration }
  };
}

function parseStoryTarget(
  scope: unknown,
  expectedAggregateVersion: unknown
): StoryMutationTarget {
  if (typeof scope !== "string" || !scope.startsWith("story:")) {
    throw invalidRequest("Mutation scope must be story:<id>");
  }
  let storyId: string;
  try {
    storyId = requireLedgerStoryId(scope.slice("story:".length), "Story mutation scope");
  } catch {
    throw invalidRequest("Mutation scope must contain a canonical story ID");
  }
  const candidate = expectedAggregateVersion as Record<string, unknown> | null;
  let version: StoryAggregateVersion;
  if (candidate?.kind === "absent") {
    exactRecord(expectedAggregateVersion, "Expected absent story aggregate version", ABSENT_VERSION_KEYS);
    version = { kind: "absent" };
  } else if (candidate?.kind === "v5") {
    const record = exactRecord(
      expectedAggregateVersion,
      "Expected V5 story aggregate version",
      V5_VERSION_KEYS
    );
    try {
      version = {
        kind: "v5",
        manifestHash: requireHash256(record.manifestHash, "manifestHash")
      };
    } catch {
      throw invalidRequest("Expected V5 manifest hash is invalid");
    }
  } else if (candidate?.kind === "v6") {
    const record = exactRecord(
      expectedAggregateVersion,
      "Expected V6 story aggregate version",
      V6_VERSION_KEYS
    );
    try {
      version = {
        kind: "v6",
        revision: requireRevision20(record.revision, "revision")
      };
    } catch {
      throw invalidRequest("Expected V6 revision is invalid");
    }
  } else {
    throw invalidRequest("Expected story aggregate version kind must be absent, v5, or v6");
  }
  return {
    scope: `story:${storyId}`,
    expectedAggregateVersion: version
  };
}

function exactRecord(
  value: unknown,
  label: string,
  keys: ReadonlySet<string>
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidRequest(`${label} must be an object`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string" || !keys.has(key))
    || keys.size !== ownKeys.length) {
    throw invalidRequest(`${label} must contain exactly: ${[...keys].join(", ")}`);
  }
  return value as Record<string, unknown>;
}

function boundedTransportOperationId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || hasUnpairedSurrogate(value)
    || Buffer.byteLength(value, "utf8") > MAX_TRANSPORT_OPERATION_ID_BYTES) {
    throw invalidRequest(
      `Transport operation ID must be 1..${MAX_TRANSPORT_OPERATION_ID_BYTES} UTF-8 bytes`
    );
  }
  return value;
}

function mutationIdValue(value: unknown): MutationId {
  try {
    return requireMutationId(value);
  } catch {
    throw invalidRequest("Mutation ID is invalid");
  }
}

function fingerprintValue(value: unknown): Hash256 {
  try {
    return requireHash256(value, "fingerprint");
  } catch {
    throw invalidRequest("Mutation fingerprint is invalid");
  }
}

function uint53(value: unknown, label: string): number {
  try {
    return requireUInt53(value, label);
  } catch {
    throw invalidRequest(`${label} must be a safe non-negative integer`);
  }
}

function invalidRequest(message: string): ServiceError {
  return new ServiceError(400, message, "invalid_request");
}
