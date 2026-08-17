import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveDiagnosticMachineTier
} from "../server/diagnostic-machine-tier.js";
import { PublicRuntimeError } from "../server/errors.js";

test("machine-tier failures stay actionable before reporter startup", async () => {
  let printed = "";
  const root = new Error("private machine-tier resolution failure");

  await assert.rejects(
    resolveDiagnosticMachineTier(
      undefined,
      {
        service: "embedded-worker-startup",
        operation: "machine-tier-resolution"
      },
      {
        resolve: async () => { throw root; },
        stderr: {
          write(value: string | Uint8Array) {
            printed += String(value);
            return true;
          }
        }
      }
    ),
    (error: unknown) => {
      assert.ok(error instanceof PublicRuntimeError);
      assert.equal(
        error.message,
        "Error: private machine-tier resolution failure"
      );
      assert.equal(error.cause, root);
      return true;
    }
  );

  assert.equal(printed, "");
});

test("--print-logs covers machine-tier failures before reporter startup", async () => {
  let printed = "";
  const root = new Error("private machine-tier resolution failure");

  await assert.rejects(
    resolveDiagnosticMachineTier(
      undefined,
      {
        service: "embedded-worker-startup",
        operation: "machine-tier-resolution"
      },
      {
        print: true,
        resolve: async () => { throw root; },
        stderr: {
          write(value: string | Uint8Array) {
            printed += String(value);
            return true;
          }
        }
      }
    ),
    (error: unknown) => {
      assert.ok(error instanceof PublicRuntimeError);
      assert.equal(
        error.message,
        "Error: private machine-tier resolution failure"
      );
      assert.equal(error.cause, root);
      return true;
    }
  );

  assert.match(printed, /private machine-tier resolution failure/);
  assert.match(printed, /embedded-worker-startup/);
  assert.match(printed, /machine-tier-resolution/);
});
