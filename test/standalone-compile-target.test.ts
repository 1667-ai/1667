import assert from "node:assert/strict";
import test from "node:test";
import { createPackagedBuildIdentity } from "../shared/build-identity.js";
import {
  createStandaloneCompiler,
  standaloneCompileTarget,
  type StandaloneBuildConfiguration,
  type StandaloneCompiler
} from "../shared/standalone-compile-target.js";
import {
  buildPromptTokenizerSmoke,
  buildStandaloneProduct
} from "../tui/scripts/standalone-build-requests.js";

test("Intel macOS standalone builds use the baseline Bun runtime", () => {
  assert.equal(
    standaloneCompileTarget("darwin-x64"),
    "bun-darwin-x64-baseline"
  );
});

test("Intel Linux standalone builds use the baseline Bun runtime", () => {
  assert.equal(
    standaloneCompileTarget("linux-x64"),
    "bun-linux-x64-baseline"
  );
});

test("arm64 standalone builds keep the native Bun runtime", () => {
  assert.equal(standaloneCompileTarget("darwin-arm64"), undefined);
  assert.equal(standaloneCompileTarget("linux-arm64"), undefined);
});

test("held Windows standalone builds keep the native Bun runtime", () => {
  assert.equal(standaloneCompileTarget("windows-x64"), undefined);
});

test("product build request receives the selected baseline target", async () => {
  const { calls, compiler, observed } = observedCompiler("darwin-x64");
  await buildStandaloneProduct(compiler, {
    entrypoints: ["standalone.ts", "worker.ts"],
    outputFile: "1667",
    buildIdentity: createPackagedBuildIdentity({
      productVersion: "1.2.3",
      sourceCommit: "a".repeat(40),
      sourceDirty: false,
      buildTimestamp: "2026-07-28T12:00:00.000Z",
      artifactTarget: "darwin-x64"
    }),
    tiktokenWasmBase64: "d2FzbQ==",
    embeddedWorkerSource: undefined
  });
  assert.deepEqual(calls, ["product"]);
  assert.equal(observed[0]?.compile.target, "bun-darwin-x64-baseline");
});

test("prompt-tokenizer build request receives the selected baseline target", async () => {
  const { calls, compiler, observed } = observedCompiler("linux-x64");
  await buildPromptTokenizerSmoke(compiler, {
    entrypoint: "prompt-tokenizer-smoke.ts",
    outputFile: "prompt-tokenizer-smoke",
    tiktokenWasmBase64: "d2FzbQ=="
  });
  assert.deepEqual(calls, ["promptTokenizerSmoke"]);
  assert.equal(observed[0]?.compile.target, "bun-linux-x64-baseline");
});

function observedCompiler(
  artifactTarget: "darwin-x64" | "linux-x64"
): {
  calls: string[];
  compiler: StandaloneCompiler<boolean>;
  observed: StandaloneBuildConfiguration[];
} {
  const calls: string[] = [];
  const observed: StandaloneBuildConfiguration[] = [];
  const inner = createStandaloneCompiler(
    artifactTarget,
    async (configuration) => {
      observed.push(configuration);
      return true;
    }
  );
  return {
    calls,
    compiler: {
      product: (configuration) => {
        calls.push("product");
        return inner.product(configuration);
      },
      promptTokenizerSmoke: (configuration) => {
        calls.push("promptTokenizerSmoke");
        return inner.promptTokenizerSmoke(configuration);
      }
    },
    observed
  };
}
