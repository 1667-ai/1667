#!/usr/bin/env -S node --import tsx

import { canonicalJson } from "../server/canonical-json.js";
import {
  collectReleaseTagAuthorization,
  type ReleaseTagAuthorizationRequest
} from "./release-evidence.js";

const OPTIONS = new Map<string, keyof ReleaseTagAuthorizationRequest>([
  ["--repository", "repositoryRoot"],
  ["--tag", "tagName"],
  ["--protected-ref", "protectedRef"]
]);

try {
  const request = parseArguments(process.argv.slice(2));
  const document = await collectReleaseTagAuthorization(request);
  process.stdout.write(`${canonicalJson(document)}\n`);
  process.stderr.write(
    `release-tag ${document.tagName} ${document.tagObjectType} ${document.tagSignature}\n`
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`release-tag-authorization: ${message}\n`);
  process.exitCode = 1;
}

function parseArguments(argv: readonly string[]): ReleaseTagAuthorizationRequest {
  const parsed = new Map<keyof ReleaseTagAuthorizationRequest, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    const key = flag === undefined ? undefined : OPTIONS.get(flag);
    if (key === undefined || value === undefined) throw new Error(usage());
    if (parsed.has(key)) {
      throw new Error(`Release tag authorization option ${flag} was given twice`);
    }
    parsed.set(key, value);
  }
  const tagName = parsed.get("tagName");
  if (tagName === undefined) throw new Error(usage());
  return Object.freeze({
    repositoryRoot: parsed.get("repositoryRoot") ?? process.cwd(),
    tagName,
    protectedRef: parsed.get("protectedRef")
  });
}

function usage(): string {
  return "usage: release-tag-authorization.ts --tag <v1.2.3>"
    + " [--repository <dir>] [--protected-ref <ref>]";
}
