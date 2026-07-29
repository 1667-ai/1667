import {
  readNpmOperationJournal,
  validateNpmPackageTagState,
  type NpmOperationJournalRead,
  type NpmOperationReconciliationIdentity
} from "./release-npm-operation-journal-reader.js";
import { NPM_PUBLIC_REGISTRY } from "./release-npm-public-client.js";
import {
  npmQuarantineMessage,
  type NpmPackageTagState,
  type NpmReleaseOperationParameters,
  type NpmTagRegistry
} from "./release-npm-operations.js";

export type {
  NpmOperationReconciliationIdentity
} from "./release-npm-operation-journal-reader.js";

export interface NpmOperationReconciliation {
  readonly schemaVersion: 1;
  readonly registry: typeof NPM_PUBLIC_REGISTRY;
  readonly identity: NpmOperationReconciliationIdentity;
  readonly parameters: NpmReleaseOperationParameters;
  readonly packageOrder: readonly string[];
  readonly observed: readonly NpmPackageTagState[];
  readonly journal: {
    readonly records: number;
    readonly terminal: "complete" | "failed" | null;
    readonly writeAttempts: number;
  };
  readonly verdict: "complete" | "retry-required" | "safe-to-abandon";
}

export async function reconcileNpmTagOperation(
  journalPath: string,
  expected: NpmOperationReconciliationIdentity,
  registry: NpmTagRegistry
): Promise<NpmOperationReconciliation> {
  const journal = readNpmOperationJournal(journalPath, expected);
  let observed = await inspectPackages(registry, expected, journal.packageOrder);
  const confirmedAbsent = new Set<string>();
  if (journal.parameters.operation === "quarantine"
    && observed.some((state) => !state.present)) {
    const initiallyAbsent = new Set(
      observed.filter((state) => !state.present).map((state) => state.name)
    );
    await registry.settleAbsence();
    observed = await inspectPackages(registry, expected, journal.packageOrder);
    for (const state of observed) {
      if (!state.present && initiallyAbsent.has(state.name)) {
        confirmedAbsent.add(state.name);
      }
    }
  }
  const verdict = operationComplete(
    expected.version,
    journal.parameters,
    observed,
    confirmedAbsent
  )
    ? "complete"
    : retryVerdict(journal, expected.version, observed);
  return Object.freeze({
    schemaVersion: 1 as const,
    registry: NPM_PUBLIC_REGISTRY,
    identity: Object.freeze({ ...expected }),
    parameters: journal.parameters,
    packageOrder: journal.packageOrder,
    journal: Object.freeze({
      records: journal.records,
      terminal: journal.terminal,
      writeAttempts: journal.writeAttempts
    }),
    observed: Object.freeze(observed),
    verdict
  });
}

async function inspectPackages(
  registry: NpmTagRegistry,
  expected: NpmOperationReconciliationIdentity,
  packageOrder: readonly string[]
): Promise<NpmPackageTagState[]> {
  const observed: NpmPackageTagState[] = [];
  for (const name of packageOrder) {
    observed.push(validateNpmPackageTagState(
      await registry.inspect(name, expected.version),
      expected.version,
      packageOrder
    ));
  }
  return observed;
}

function operationComplete(
  version: string,
  parameters: NpmReleaseOperationParameters,
  states: readonly NpmPackageTagState[],
  confirmedAbsent: ReadonlySet<string>
): boolean {
  if (parameters.operation === "promotion") {
    return states.every((state) => state.present && state.deprecated === null
      && state.tags.next === version
      && state.tags[parameters.promotion.destination] === version);
  }
  const message = npmQuarantineMessage(parameters.quarantine);
  return states.every((state) => !Object.values(state.tags).includes(version)
    && (state.present
      ? state.deprecated === message
      : confirmedAbsent.has(state.name)));
}

function retryVerdict(
  journal: NpmOperationJournalRead,
  version: string,
  states: readonly NpmPackageTagState[]
): "retry-required" | "safe-to-abandon" {
  if (journal.parameters.operation === "quarantine") return "retry-required";
  const destination = journal.parameters.promotion.destination;
  return journal.writeAttempts > 0
      || states.some((state) => state.tags[destination] === version)
    ? "retry-required"
    : "safe-to-abandon";
}
