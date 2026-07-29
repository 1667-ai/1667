#!/usr/bin/env -S node --import tsx

import {
  verifyNpmOperationRepositoryControls
} from "./release-npm-operation-controls.js";

try {
  await verifyNpmOperationRepositoryControls({
    repository: process.env.GITHUB_REPOSITORY ?? "",
    token: process.env.GH_TOKEN ?? ""
  });
  process.stdout.write("npm operation repository controls: ready\n");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`release-npm-operation-controls: ${message}\n`);
  process.exitCode = 1;
}
