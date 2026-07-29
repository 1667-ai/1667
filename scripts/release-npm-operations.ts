import { isSemVer } from "../shared/semver.js";
import {
  PUBLISHED_PLATFORM_PACKAGES,
  RELEASE_LAUNCHER_PACKAGE
} from "../shared/release-targets.js";
import {
  NPM_PUBLIC_REGISTRY
} from "./release-npm-public-client.js";

export { NPM_PUBLIC_REGISTRY } from "./release-npm-public-client.js";

const NPM_CREDENTIAL_VARIABLE =
  /^(?:NODE_AUTH_TOKEN|NPM_TOKEN|NPM_AUTH_TOKEN|NPM_OTP|OTP)$/iu;
const INCIDENT_REFERENCE =
  /^https:\/\/github\.com\/1667-ai\/1667\/(?:issues\/[1-9][0-9]*|security\/advisories\/GHSA-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4})$/u;

export type NpmReleaseOperation = "promotion" | "quarantine";
export type NpmPromotionTag = "latest" | "stable" | "beta";

export interface NpmPromotionRequest {
  readonly destination: NpmPromotionTag;
  readonly stableAcknowledged: boolean;
}

export interface NpmQuarantineRequest {
  readonly incidentReference: string;
  readonly supersedingVersion: string;
}

export type NpmReleaseOperationParameters =
  | { readonly operation: "promotion"; readonly promotion: NpmPromotionRequest }
  | { readonly operation: "quarantine"; readonly quarantine: NpmQuarantineRequest };

export interface NpmPackageTagState {
  readonly name: string;
  readonly version: string;
  readonly present: boolean;
  readonly deprecated: string | null;
  readonly tags: Readonly<Record<string, string>>;
}

export interface NpmTagRegistry {
  inspect(name: string, version: string): Promise<NpmPackageTagState>;
  settleAbsence(): Promise<void>;
  addTag(name: string, version: string, tag: string): Promise<void>;
  removeTag(name: string, version: string, tag: string): Promise<void>;
  deprecate(name: string, version: string, message: string): Promise<void>;
}

export interface NpmTagOperationEvidence {
  readonly schemaVersion: 1;
  readonly operation: NpmReleaseOperation;
  readonly registry: typeof NPM_PUBLIC_REGISTRY;
  readonly version: string;
  readonly parameters: NpmReleaseOperationParameters;
  readonly packageOrder: readonly string[];
  readonly before: readonly NpmPackageTagState[];
  readonly after: readonly NpmPackageTagState[];
}

export type NpmTagWrite =
  | { readonly kind: "add"; readonly name: string; readonly version: string;
    readonly tag: string }
  | { readonly kind: "remove"; readonly name: string; readonly version: string;
    readonly tag: string }
  | { readonly kind: "deprecate"; readonly name: string; readonly version: string;
    readonly message: string };

export type NpmTagOperationEvent =
  | { readonly kind: "before"; readonly states: readonly NpmPackageTagState[] }
  | { readonly kind: "write-attempt"; readonly write: NpmTagWrite }
  | { readonly kind: "write-verified"; readonly write: NpmTagWrite;
    readonly state: NpmPackageTagState }
  | { readonly kind: "after"; readonly states: readonly NpmPackageTagState[] };

export type NpmTagOperationRecorder = (event: NpmTagOperationEvent) => void;

const NO_RECORD: NpmTagOperationRecorder = () => undefined;

export function npmReleaseOperationPackageOrder(
  operation: NpmReleaseOperation
): readonly string[] {
  return Object.freeze(operation === "promotion"
    ? [...PUBLISHED_PLATFORM_PACKAGES, RELEASE_LAUNCHER_PACKAGE]
    : [RELEASE_LAUNCHER_PACKAGE, ...PUBLISHED_PLATFORM_PACKAGES]);
}

export async function promoteNpmReleaseTags(
  registry: NpmTagRegistry,
  version: string,
  request: NpmPromotionRequest,
  recordEvent: NpmTagOperationRecorder = NO_RECORD
): Promise<NpmTagOperationEvidence> {
  requireVersion(version);
  const promotion = validateNpmPromotionRequest(request);
  const order = npmReleaseOperationPackageOrder("promotion");
  const before = await inspectAll(registry, order, version);
  recordEvent(Object.freeze({ kind: "before", states: before }));
  for (const state of before) requirePromotionState(state, version);

  for (const name of order) {
    const state = await registry.inspect(name, version);
    requirePackageState(state, name, version);
    requirePromotionState(state, version);
    if (state.tags[promotion.destination] !== version) {
      const write = Object.freeze({
        kind: "add" as const,
        name,
        version,
        tag: promotion.destination
      });
      recordEvent(Object.freeze({ kind: "write-attempt", write }));
      await registry.addTag(name, version, promotion.destination);
      const written = await registry.inspect(name, version);
      requirePackageState(written, name, version);
      requirePromotionState(written, version);
      if (written.tags[promotion.destination] !== version) {
        throw new Error(
          `${name} ${promotion.destination} tag did not change to ${version}`
        );
      }
      recordEvent(Object.freeze({
        kind: "write-verified",
        write,
        state: written
      }));
    }
  }

  const after = await inspectAll(registry, order, version);
  for (const state of after) {
    requirePromotionState(state, version);
    if (state.tags[promotion.destination] !== version) {
      throw new Error(
        `${state.name} ${promotion.destination} tag does not name ${version}`
      );
    }
  }
  recordEvent(Object.freeze({ kind: "after", states: after }));
  return operationEvidence(
    { operation: "promotion", promotion },
    version,
    order,
    before,
    after
  );
}

export async function quarantineNpmReleaseTags(
  registry: NpmTagRegistry,
  version: string,
  request: NpmQuarantineRequest,
  recordEvent: NpmTagOperationRecorder = NO_RECORD
): Promise<NpmTagOperationEvidence> {
  requireVersion(version);
  const quarantine = validateNpmQuarantineRequest(version, request);
  const deprecationMessage = npmQuarantineMessage(quarantine);
  const order = npmReleaseOperationPackageOrder("quarantine");
  const initial = await inspectAll(registry, order, version);
  const initialAbsence = new Set(
    initial.filter((state) => !state.present).map((state) => state.name)
  );
  const before = initialAbsence.size === 0
    ? initial
    : await settledAbsenceStates(registry, order, version, initialAbsence);
  const settledAbsence = new Set(
    before.filter((state) => !state.present).map((state) => state.name)
  );
  recordEvent(Object.freeze({ kind: "before", states: before }));
  for (const state of before) {
    requireSettledQuarantineState(state, settledAbsence);
    if (state.present && state.deprecated !== null
      && state.deprecated !== deprecationMessage) {
      throw new Error(`${state.name}@${version} has a different deprecation message`);
    }
  }

  for (const name of order) {
    let state = await registry.inspect(name, version);
    requirePackageState(state, name, version);
    requireSettledQuarantineState(state, settledAbsence);
    const matchingTags = Object.entries(state.tags)
      .filter(([, taggedVersion]) => taggedVersion === version)
      .map(([tag]) => tag)
      .sort(compareQuarantineTags);
    for (const tag of matchingTags) {
      if (state.tags[tag] !== version) {
        throw new Error(`${name} ${tag} tag changed before removal`);
      }
      const write = Object.freeze({
        kind: "remove" as const,
        name,
        version,
        tag
      });
      recordEvent(Object.freeze({ kind: "write-attempt", write }));
      await registry.removeTag(name, version, tag);
      state = await registry.inspect(name, version);
      requirePackageState(state, name, version);
      requireSettledQuarantineState(state, settledAbsence);
      if (state.tags[tag] === version) {
        throw new Error(`${name} ${tag} tag still names ${version}`);
      }
      recordEvent(Object.freeze({
        kind: "write-verified",
        write,
        state
      }));
    }
    if (Object.values(state.tags).includes(version)) {
      throw new Error(`${name} still has a tag that names ${version}`);
    }
  }

  for (const name of order) {
    let state = await registry.inspect(name, version);
    requirePackageState(state, name, version);
    requireSettledQuarantineState(state, settledAbsence);
    if (!state.present) continue;
    if (state.deprecated === null) {
      const write = Object.freeze({
        kind: "deprecate" as const,
        name,
        version,
        message: deprecationMessage
      });
      recordEvent(Object.freeze({ kind: "write-attempt", write }));
      await registry.deprecate(name, version, deprecationMessage);
      state = await registry.inspect(name, version);
      requirePackageState(state, name, version);
      requireSettledQuarantineState(state, settledAbsence);
      if (state.deprecated === deprecationMessage) {
        recordEvent(Object.freeze({
          kind: "write-verified",
          write,
          state
        }));
      }
    }
    if (state.present && state.deprecated !== deprecationMessage) {
      throw new Error(`${name}@${version} did not receive the quarantine message`);
    }
  }

  const after = await inspectAll(registry, order, version);
  for (const state of after) {
    requireSettledQuarantineState(state, settledAbsence);
    if (Object.values(state.tags).includes(version)) {
      throw new Error(`${state.name} still has a tag that names ${version}`);
    }
    if (state.present && state.deprecated !== deprecationMessage) {
      throw new Error(`${state.name}@${version} is not quarantined`);
    }
  }
  recordEvent(Object.freeze({ kind: "after", states: after }));
  return operationEvidence(
    { operation: "quarantine", quarantine },
    version,
    order,
    before,
    after
  );
}

export function npmQuarantineMessage(request: NpmQuarantineRequest): string {
  return `Quarantined release. Use ${request.supersedingVersion}. Incident: ${
    request.incidentReference}`;
}

export function npmTagWriteArguments(
  operation: NpmTagWrite
): readonly string[] {
  const registry = `--registry=${NPM_PUBLIC_REGISTRY}`;
  const scopeRegistry = `--@1667-ai:registry=${NPM_PUBLIC_REGISTRY}`;
  if (operation.kind === "add") {
    return Object.freeze([
      registry, scopeRegistry, "dist-tag", "add", "--",
      `${operation.name}@${operation.version}`, operation.tag
    ]);
  }
  if (operation.kind === "remove") {
    return Object.freeze([
      registry, scopeRegistry, "dist-tag", "rm", "--",
      operation.name, operation.tag
    ]);
  }
  return Object.freeze([
    registry, scopeRegistry, "deprecate", "--",
    `${operation.name}@${operation.version}`, operation.message
  ]);
}

export function assertNoNpmOperationCredentialEnvironment(
  environment: NodeJS.ProcessEnv
): void {
  const variable = Object.keys(environment).find((key) => {
    return isNpmCredentialVariable(key) && environment[key] !== "";
  });
  if (variable !== undefined) {
    throw new Error(`npm tag operations refuse credential variable ${variable}`);
  }
}

function isNpmCredentialVariable(key: string): boolean {
  if (NPM_CREDENTIAL_VARIABLE.test(key)) return true;
  const lower = key.toLowerCase();
  if (!lower.startsWith("npm_config_")) return false;
  return /(?:^|[:/])_?(?:auth|authtoken|password|otp|token)$/u.test(
    lower.slice("npm_config_".length)
  );
}

async function inspectAll(
  registry: NpmTagRegistry,
  order: readonly string[],
  version: string
): Promise<readonly NpmPackageTagState[]> {
  const states = await Promise.all(order.map(async (name) => {
    const state = await registry.inspect(name, version);
    requirePackageState(state, name, version);
    return state;
  }));
  return Object.freeze(states);
}

async function settledAbsenceStates(
  registry: NpmTagRegistry,
  order: readonly string[],
  version: string,
  initialAbsence: ReadonlySet<string>
): Promise<readonly NpmPackageTagState[]> {
  await registry.settleAbsence();
  const states = await inspectAll(registry, order, version);
  const unsettled = states.find((state) => {
    return !state.present && !initialAbsence.has(state.name);
  });
  if (unsettled !== undefined) {
    throw new Error(`${unsettled.name}@${version} absence is not settled`);
  }
  return states;
}

function requireSettledQuarantineState(
  state: NpmPackageTagState,
  settledAbsence: Set<string>
): void {
  if (state.present) {
    settledAbsence.delete(state.name);
  } else if (!settledAbsence.has(state.name)) {
    throw new Error(`${state.name}@${state.version} absence is not settled`);
  }
}

function requirePromotionState(state: NpmPackageTagState, version: string): void {
  if (!state.present) {
    throw new Error(`npm registry does not contain ${state.name}@${version}`);
  }
  if (state.deprecated !== null) {
    throw new Error(`${state.name}@${version} is deprecated`);
  }
  if (state.tags.next !== version) {
    throw new Error(`${state.name} next tag does not name ${version}`);
  }
}

function compareQuarantineTags(left: string, right: string): number {
  const priority = (tag: string): number => {
    if (tag === "latest") return 0;
    if (tag === "next") return 1;
    return 2;
  };
  return priority(left) - priority(right) || left.localeCompare(right, "en");
}

function requirePackageState(
  state: NpmPackageTagState,
  name: string,
  version: string
): void {
  if (state.name !== name || state.version !== version) {
    throw new Error(`npm returned the wrong package state for ${name}`);
  }
}

function operationEvidence(
  parameters: NpmReleaseOperationParameters,
  version: string,
  packageOrder: readonly string[],
  before: readonly NpmPackageTagState[],
  after: readonly NpmPackageTagState[]
): NpmTagOperationEvidence {
  return Object.freeze({
    schemaVersion: 1,
    operation: parameters.operation,
    registry: NPM_PUBLIC_REGISTRY,
    version,
    parameters,
    packageOrder,
    before,
    after
  });
}

export function validateNpmPromotionRequest(
  value: NpmPromotionRequest
): NpmPromotionRequest {
  if (value.destination !== "latest" && value.destination !== "stable"
    && value.destination !== "beta") {
    throw new Error("npm promotion destination is invalid");
  }
  if (typeof value.stableAcknowledged !== "boolean"
    || (value.destination === "stable" && !value.stableAcknowledged)) {
    throw new Error("npm stable promotion requires explicit acknowledgment");
  }
  return Object.freeze({ ...value });
}

export function validateNpmQuarantineRequest(
  version: string,
  value: NpmQuarantineRequest
): NpmQuarantineRequest {
  if (!INCIDENT_REFERENCE.test(value.incidentReference)) {
    throw new Error("npm quarantine incident reference is invalid");
  }
  if (!isSemVer(value.supersedingVersion) || value.supersedingVersion === version) {
    throw new Error("npm quarantine superseding version is invalid");
  }
  return Object.freeze({ ...value });
}

function requireVersion(version: string): void {
  if (!isSemVer(version)) throw new Error("npm tag operation version is not SemVer");
}
