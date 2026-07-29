import type {
  NpmOperationLeaseRequest,
  NpmOperationWriterOutcome
} from "./release-npm-operation-lease.js";
import type {
  NpmPromotionRequest,
  NpmQuarantineRequest
} from "./release-npm-operations.js";

interface OperationCliRequestBase {
  readonly version: string;
  readonly evidencePath: string;
  readonly processJournalPath: string;
}

export type OperationCliRequest =
  | OperationCliRequestBase & {
      readonly command: "promote";
      readonly lease: NpmOperationLeaseRequest & {
        readonly operation: "promotion";
      };
      readonly parameters: {
        readonly operation: "promotion";
        readonly promotion: NpmPromotionRequest;
      };
    }
  | OperationCliRequestBase & {
      readonly command: "quarantine";
      readonly lease: NpmOperationLeaseRequest & {
        readonly operation: "quarantine";
      };
      readonly parameters: {
        readonly operation: "quarantine";
        readonly quarantine: NpmQuarantineRequest;
      };
    };

export interface NpmTagOperationLease {
  acquireWriter(
    request: NpmOperationLeaseRequest,
    claimSecret: string,
    writerSecret: string
  ): Promise<void>;
  verifyWriter(
    request: NpmOperationLeaseRequest,
    writerSecret: string
  ): Promise<void>;
  acknowledgeWriter(
    request: NpmOperationLeaseRequest,
    writerSecret: string,
    outcome: NpmOperationWriterOutcome
  ): Promise<void>;
  complete(request: NpmOperationLeaseRequest, claimSecret: string): Promise<void>;
  fail(request: NpmOperationLeaseRequest, claimSecret: string): Promise<void>;
}
