import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

export const RELEASE_NOTICE_TEXT = readFileSync(
  path.join(repositoryRoot, "NOTICE"),
  "utf8"
);

const noticeBytes = Buffer.from(RELEASE_NOTICE_TEXT, "utf8");

export const RELEASE_NOTICE_ATTRIBUTION = Object.freeze({
  sha256: createHash("sha256").update(noticeBytes).digest("hex"),
  bytes: noticeBytes.byteLength
});

export const RELEASE_SBOM_FIXTURE = Buffer.from(JSON.stringify({
  spdxVersion: "SPDX-2.3",
  documentDescribes: ["SPDXRef-Package-1667"],
  packages: [{
    SPDXID: "SPDXRef-Package-1667",
    name: "1667",
    attributionTexts: [RELEASE_NOTICE_TEXT]
  }]
}));
