import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createInstallOwnershipRecord,
  INSTALL_ACTIVE_EXECUTABLE,
  installActiveExecutablePath,
  parseInstallOwnershipRecord,
  parseInstallOwnershipRecordText,
  serializeInstallOwnershipRecord
} from "../shared/install-ownership-record.js";

const ROOT = "/Users/example/.local/bin";
const ACTIVE = installActiveExecutablePath(ROOT);

function validRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    product: "1667",
    installationId: "0123456789abcdef0123456789abcdef",
    method: "shell",
    channel: "beta",
    installRoot: ROOT,
    executable: ACTIVE,
    artifactTarget: "darwin-arm64",
    ...overrides
  };
}

test("Ownership Record accepts the canonical active executable layout", () => {
  const record = parseInstallOwnershipRecord(validRecord());
  assert.equal(record.executable, `${ROOT}/${INSTALL_ACTIVE_EXECUTABLE}`);
  assert.equal(record.executable, installActiveExecutablePath(record.installRoot));
  const roundTrip = parseInstallOwnershipRecordText(serializeInstallOwnershipRecord(record));
  assert.deepEqual(roundTrip, record);
});

test("Ownership Record parser rejects non-canonical executable layout", () => {
  assert.throws(
    () => parseInstallOwnershipRecord(validRecord({
      executable: `${ROOT}/other-name`
    })),
    /executable layout is invalid/i
  );
  assert.throws(
    () => parseInstallOwnershipRecord(validRecord({
      executable: `${ROOT}/nested/1667`
    })),
    /executable layout is invalid/i
  );
  assert.throws(
    () => parseInstallOwnershipRecord(validRecord({
      executable: `/tmp/elsewhere/${INSTALL_ACTIVE_EXECUTABLE}`
    })),
    /executable layout is invalid/i
  );
  // createInstallOwnershipRecord goes through the same layout gate.
  assert.throws(
    () => createInstallOwnershipRecord({
      installationId: "0123456789abcdef0123456789abcdef",
      channel: "beta",
      installRoot: ROOT,
      executable: `${ROOT}/not-1667`,
      artifactTarget: "darwin-arm64"
    }),
    /executable layout is invalid/i
  );
});
