import { describe, expect, test } from "bun:test";
import { AI_1667_BUILD_IDENTITY } from "../../shared/build-identity.js";
import { createFailureEnvelope } from "../../shared/failure-envelope.js";
import {
  WORKER_PROTOCOL_VERSION,
  type WorkerOperationId
} from "../../shared/worker-protocol.js";
import { decodeWorkerMessage } from "../src/worker-message.js";

const WORKER_INSTANCE_ID = "1".repeat(32);
const OPERATION_ID: WorkerOperationId = Object.freeze({
  workerInstanceId: WORKER_INSTANCE_ID,
  sequence: 1n
});

describe("worker message decoding", () => {
  test("constructs exact frozen union members", () => {
    const inputs = [
      {
        type: "starting",
        protocolVersion: WORKER_PROTOCOL_VERSION,
        buildIdentity: AI_1667_BUILD_IDENTITY,
        workerInstanceId: WORKER_INSTANCE_ID
      },
      {
        type: "ready",
        protocolVersion: WORKER_PROTOCOL_VERSION,
        buildIdentity: AI_1667_BUILD_IDENTITY,
        workerInstanceId: WORKER_INSTANCE_ID
      },
      { type: "result", id: OPERATION_ID, value: { ok: true } },
      {
        type: "error",
        id: OPERATION_ID,
        failure: createFailureEnvelope({
          code: "internal",
          message: "Internal server error",
          status: 500
        }),
        mutationOutcome: "terminal",
        providerMutationId:
          "m1.1767225600001.7123456789abcdef0123456789abcdef"
      },
      { type: "delta", id: OPERATION_ID, sequence: 0, text: "text" },
      {
        type: "complete",
        id: OPERATION_ID,
        value: undefined,
        stoppedText: "buffered"
      },
      {
        type: "operation",
        id: OPERATION_ID,
        state: "completed",
        terminal: true
      },
      {
        type: "protocolError",
        failure: createFailureEnvelope({
          code: "invalid_request",
          message: "Invalid request",
          status: 400
        })
      },
      { type: "stopped" }
    ];

    for (const input of inputs) {
      const decoded = decodeWorkerMessage(input);
      expect(decoded).not.toBe(null);
      expect(decoded).not.toBe(input);
      expect(Object.isFrozen(decoded)).toBeTrue();
    }
  });

  test("rejects extra fields for every union member", () => {
    const inputs = [
      {
        type: "starting",
        protocolVersion: WORKER_PROTOCOL_VERSION,
        buildIdentity: AI_1667_BUILD_IDENTITY,
        workerInstanceId: WORKER_INSTANCE_ID
      },
      { type: "result", id: OPERATION_ID, value: null },
      {
        type: "error",
        id: OPERATION_ID,
        failure: createFailureEnvelope({
          code: "internal",
          message: "Internal server error",
          status: 500
        })
      },
      { type: "delta", id: OPERATION_ID, sequence: 0, text: "" },
      { type: "complete", id: OPERATION_ID, value: null },
      {
        type: "operation",
        id: OPERATION_ID,
        state: "running",
        terminal: false
      },
      {
        type: "protocolError",
        failure: createFailureEnvelope({
          code: "invalid_request",
          message: "Invalid request",
          status: 400
        })
      },
      { type: "stopped" }
    ];

    for (const input of inputs) {
      expect(decodeWorkerMessage({ ...input, privateStack: "hidden" }))
        .toBe(null);
    }
  });
});
