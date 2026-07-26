import { describe, expect, test } from "bun:test";
import {
  ApiFailureError,
  apiHttpErrorFromPayload,
  ApiHttpError
} from "../src/api-error.js";
import { workerApiErrorFromFailure } from "../src/worker-error.js";
import { createFailureEnvelope } from "../../shared/failure-envelope.js";

describe("canonical HTTP failure decoding", () => {
  test("ordinary HTTP and SSE payloads share one bounded decoder", () => {
    const reference = "err_deadbeefdeadbeefdeadbeef";
    const http = apiHttpErrorFromPayload({
      error: "Conflict",
      code: "revision_conflict",
      diagnosticRef: reference
    }, "fallback", 409);
    const sse = apiHttpErrorFromPayload({
      type: "error",
      message: "Conflict",
      code: "revision_conflict",
      status: 409,
      diagnosticRef: reference
    }, "fallback", 409);

    for (const error of [http, sse]) {
      expect(error instanceof ApiHttpError).toBe(true);
      expect(error.message).toBe(`Conflict (${reference})`);
      expect(error.status).toBe(409);
      expect(error.code).toBe("revision_conflict");
      expect(error.diagnosticRef).toBe(reference);
    }
  });

  test("HTTP and worker errors retain one canonical failure model", () => {
    const failure = createFailureEnvelope({
      code: "conflict",
      message: "Conflict",
      status: 409
    });
    const http = new ApiHttpError(failure);
    const worker = workerApiErrorFromFailure(failure);

    for (const error of [http, worker]) {
      expect(error instanceof ApiFailureError).toBe(true);
      expect(error.failure).toBe(failure);
      expect(error.code).toBe("conflict");
      expect(error.status).toBe(409);
    }
  });

  test("invalid flat fields normalize before constructing ApiHttpError", () => {
    const error = apiHttpErrorFromPayload({
      message: "x".repeat(5_000),
      code: "conflict",
      diagnosticRef: "invalid"
    }, "fallback", 700);

    expect(error.status).toBe(500);
    expect(error.code).toBe("conflict");
    expect(error.message.length).toBe(4_096);
    expect(error.diagnosticRef).toBe(null);
  });

  test("code-less responses preserve only the trusted local fallback", () => {
    const error = apiHttpErrorFromPayload({
      error: "untrusted intermediary detail"
    }, "1667 operation request failed (404)", 404);

    expect(error.code).toBe("invalid_response");
    expect(error.status).toBe(404);
    expect(error.message).toBe("1667 operation request failed (404)");
    expect(error.message).not.toContain("intermediary");
  });

  test("compatible HTTP responses preserve bounded future codes", () => {
    const error = apiHttpErrorFromPayload({
      error: "Future public conflict",
      code: "future_conflict"
    }, "fallback", 409);

    expect(error.code).toBe("future_conflict");
    expect(error.status).toBe(409);
    expect(error.message).toBe("Future public conflict");
  });
});
