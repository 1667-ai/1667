import { expect, test } from "bun:test";
import {
  parseInstallTransactionFileRecord,
  serializeInstallTransactionRecord
} from "../src/install-transaction-record.js";

test("managed Transaction Records serialize in the declared canonical order", () => {
  const parsed = parseInstallTransactionFileRecord(JSON.stringify({
    phase: "ownership-pending",
    artifactTarget: "darwin-arm64",
    executable: "/tmp/1667-prefix,with-comma/1667",
    installRoot: "/tmp/1667-prefix,with-comma",
    installationId: "0123456789abcdef0123456789abcdef",
    candidateVersion: "1.2.3-rc.1+build.7",
    activeVersion: "1.2.2",
    updateChannel: true,
    channel: "beta",
    operation: "upgrade",
    schemaVersion: 1,
    kind: "managed"
  }));

  if (parsed.kind !== "managed") throw new Error("expected a managed record");
  expect(serializeInstallTransactionRecord(parsed)).toBe(
    "{\"kind\":\"managed\",\"schemaVersion\":1,\"operation\":\"upgrade\",\"channel\":\"beta\",\"updateChannel\":true,\"activeVersion\":\"1.2.2\",\"candidateVersion\":\"1.2.3-rc.1+build.7\",\"installationId\":\"0123456789abcdef0123456789abcdef\",\"installRoot\":\"/tmp/1667-prefix,with-comma\",\"executable\":\"/tmp/1667-prefix,with-comma/1667\",\"artifactTarget\":\"darwin-arm64\",\"phase\":\"ownership-pending\"}\n"
  );
});
