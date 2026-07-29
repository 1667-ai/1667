import type { NpmWriteAccess } from "./release-npm-access.js";
import type { NpmTagOperationJournal } from
  "./release-npm-operation-journal.js";
import type {
  NpmTagOperationLease,
  OperationCliRequest
} from "./release-npm-tag-operation-contracts.js";
import {
  promoteNpmReleaseTags,
  quarantineNpmReleaseTags,
  type NpmTagOperationEvidence,
  type NpmTagRegistry
} from "./release-npm-operations.js";
import type { NpmSupersedingReleaseVerifier } from
  "./release-npm-superseding-release.js";

export interface NpmTagOperationBehavior {
  readonly authorizeWrite: () => Promise<void>;
  execute(
    registry: NpmTagRegistry,
    journal: NpmTagOperationJournal
  ): Promise<NpmTagOperationEvidence>;
}

export function createNpmTagOperationBehavior(
  request: OperationCliRequest,
  supersedingRelease: NpmSupersedingReleaseVerifier | undefined,
  createSupersedingRelease: () => NpmSupersedingReleaseVerifier,
  lease: NpmTagOperationLease,
  access: NpmWriteAccess,
  writerSecret: string,
  order: readonly string[]
): NpmTagOperationBehavior {
  const authorizeWriter = async (): Promise<void> => {
    await access.verify(order);
    await lease.verifyWriter(request.lease, writerSecret);
  };
  if (request.command === "promote") {
    return Object.freeze({
      authorizeWrite: authorizeWriter,
      execute: async (
        registry: NpmTagRegistry,
        journal: NpmTagOperationJournal
      ) => {
        return promoteNpmReleaseTags(
          registry,
          request.version,
          request.parameters.promotion,
          journal.record
        );
      }
    });
  }
  const verifier = supersedingRelease ?? createSupersedingRelease();
  const verifySupersedingRelease = async (): Promise<void> => {
    await verifier.verify(request.parameters.quarantine.supersedingVersion);
  };
  return Object.freeze({
    authorizeWrite: async () => {
      await verifySupersedingRelease();
      await authorizeWriter();
    },
    execute: async (
      registry: NpmTagRegistry,
      journal: NpmTagOperationJournal
    ) => {
      await verifySupersedingRelease();
      const evidence = await quarantineNpmReleaseTags(
        registry,
        request.version,
        request.parameters.quarantine,
        journal.record
      );
      await verifySupersedingRelease();
      return evidence;
    }
  });
}
