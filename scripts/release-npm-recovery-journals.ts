import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import {
  readNpmOperationJournal,
  type NpmOperationReconciliationIdentity
} from "./release-npm-operation-journal-reader.js";
import {
  inspectNpmProcessQuiescence,
  requireNpmProcessJournalIdentity
} from "./release-npm-process-journal.js";

export type NpmRecoveryJournalState = "absent" | "process-only" | "present";

export function inspectNpmRecoveryJournalState(
  operationJournalPath: string,
  processJournalPath: string,
  identity: NpmOperationReconciliationIdentity
): NpmRecoveryJournalState {
  requireNpmProcessJournalIdentity(identity);
  const operationPath = recoveryPath(operationJournalPath, "operation");
  const processPath = recoveryPath(processJournalPath, "process");
  if (operationPath === processPath) {
    throw new Error("npm recovery journals must use separate paths");
  }
  const operationStat = lstatSync(operationPath, { throwIfNoEntry: false });
  const processStat = lstatSync(processPath, { throwIfNoEntry: false });
  if (operationStat === undefined && processStat === undefined) return "absent";
  if (operationStat !== undefined && processStat === undefined) {
    throw new Error("npm recovery operation journal has no process journal");
  }
  if (operationStat === undefined) {
    inspectNpmProcessQuiescence(processPath, identity);
    return "process-only";
  }
  readNpmOperationJournal(operationPath, identity);
  inspectNpmProcessQuiescence(processPath, identity);
  return "present";
}

function recoveryPath(value: string, label: string): string {
  if (!path.isAbsolute(value)) {
    throw new Error(`npm recovery ${label} journal path must be absolute`);
  }
  const canonical = path.join(realpathSync(path.dirname(value)), path.basename(value));
  if (canonical !== value) {
    throw new Error(`npm recovery ${label} journal path must be canonical`);
  }
  return canonical;
}
