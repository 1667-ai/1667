#!/usr/bin/env -S node --import tsx

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  runNpmOperationOrchestrationCommand
} from "./release-npm-operation-orchestration-composition.js";

function isMainModule(): boolean {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1])
      === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  try {
    process.stdout.write(
      await runNpmOperationOrchestrationCommand(process.argv.slice(2))
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`release-npm-operation-orchestration: ${message}\n`);
    process.exitCode = 1;
  }
}
