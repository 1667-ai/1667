import { writeSync } from "node:fs";
import { ApiError } from "./api.js";

export const BACKEND_RESTART_REQUIRED_EXIT_CODE = 75;

export class BackendRestartRequiredError extends Error {
  readonly code = "backend_restart_required";

  constructor(message: string, options: { cause?: unknown } = {}) {
    super(`backend_restart_required: ${message}`, options);
    this.name = "BackendRestartRequiredError";
  }
}

export function exitForBackendRestart(): never {
  try {
    writeSync(
      process.stderr.fd,
      "1667: backend_restart_required: backend stopped; restart 1667. "
        + "Interrupted changes will be checked on next launch.\n"
    );
  } finally {
    process.exit(BACKEND_RESTART_REQUIRED_EXIT_CODE);
  }
}

export class WorkerApiError extends ApiError {
  constructor(message: string, readonly code: string, readonly status: number | null) {
    super(message);
    this.name = "WorkerApiError";
  }
}
