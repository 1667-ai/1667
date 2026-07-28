import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readFile,
  realpath,
  rm
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ServiceError } from "../server/errors.js";
import { internalErrorLogPath } from "../server/internal-error-log.js";
import { InternalErrorReporter } from "../server/internal-error-reporter.js";
import {
  isMutationReceiptPersistenceError,
  MutationReceiptStore as ProductionMutationReceiptStore
} from "../server/mutation-receipts.js";
import type {
  MutationPlan,
  MutationPreflightPlan
} from "../server/mutation-plan.js";
import { internalErrorReference } from "../server/service-error-policy.js";
import { StoryDurabilityError } from "../server/story-lifecycle.js";
import type { MutatingWorkerMethod } from "../shared/worker-protocol.js";

/** Diagnostic tests exercise receipt mechanics without aggregate admission. */
class MutationReceiptStore extends ProductionMutationReceiptStore {
  override async run<M extends MutatingWorkerMethod, T>(
    mutationId: string,
    method: M,
    input: unknown,
    work: (plan: MutationPlan<M>) => Promise<T>,
    inputProtocolVersion?: number,
    preflight: (
      plan: MutationPreflightPlan<M>
    ) => void | Promise<void> = () => undefined
  ): Promise<T> {
    return await super.run(
      mutationId,
      method,
      input,
      work,
      inputProtocolVersion,
      preflight
    );
  }
}

test("private terminal failures persist diagnostics before receipt references", async (t) => {
  const rootDir = await realpath(
    await mkdtemp(path.join(tmpdir(), "1667-mutation-private-failure-"))
  );
  const dir = path.join(rootDir, "receipts");
  const reporter = await InternalErrorReporter.open(rootDir);
  t.after(async () => {
    await reporter.close();
    await rm(rootDir, { recursive: true, force: true });
  });
  const store = new MutationReceiptStore(
    dir,
    async () => { throw new Error("unused"); },
    async (error) => await reporter.report(
      error,
      { service: "mutation-receipt" }
    )
  );
  await store.init();
  const mutationId = currentMutationId("d");
  const input = { storyId: "story", factId: "missing" };

  const original = await rejectionOf(store.run(
    mutationId,
    "patchFact",
    input,
    async () => {
      throw new Error("private mutation detail");
    }
  ));
  const reference = internalErrorReference(original);
  assert.match(reference ?? "", /^err_[0-9a-f]{24}$/);

  const receiptText = await readFile(
    path.join(dir, `${mutationId}.json`),
    "utf8"
  );
  assert.doesNotMatch(receiptText, /private mutation detail/);
  const receipt = JSON.parse(receiptText) as {
    failure: Record<string, unknown>;
  };
  assert.deepEqual(receipt.failure, {
    kind: "diagnostic",
    code: "internal",
    message: "Internal server error",
    status: 500,
    diagnosticRef: reference
  });
  const diagnostic = await readFile(
    internalErrorLogPath(rootDir),
    "utf8"
  );
  assert.match(diagnostic, /private mutation detail/);
  assert.match(diagnostic, new RegExp(reference ?? ""));

  const replayed = await rejectionOf(store.run(
    mutationId,
    "patchFact",
    input,
    async () => assert.fail("terminal receipt must replay")
  ));
  assert.equal(internalErrorReference(replayed), reference);
});

test("durable plain failures cannot gain a transient later reference", async (t) => {
  const rootDir = await realpath(
    await mkdtemp(path.join(tmpdir(), "1667-mutation-plain-failure-"))
  );
  const dir = path.join(rootDir, "receipts");
  t.after(async () => await rm(rootDir, { recursive: true, force: true }));
  const unavailableReporter = InternalErrorReporter.disabled();
  const store = new MutationReceiptStore(
    dir,
    async () => { throw new Error("unused"); },
    async (error) => await unavailableReporter.report(error, {
      service: "mutation-receipt"
    })
  );
  await store.init();
  const mutationId = currentMutationId("9");
  const input = { storyId: "story", factId: "missing" };

  const original = await rejectionOf(store.run(
    mutationId,
    "patchFact",
    input,
    async () => {
      throw new Error("private transient log failure");
    }
  ));
  assert.equal(internalErrorReference(original), null);

  const persistentReporter = await InternalErrorReporter.open(rootDir);
  t.after(async () => await persistentReporter.close());
  const exposed = await persistentReporter.report(original, {
    service: "embedded-worker"
  });

  assert.equal(exposed.failure.kind, "plain");
  assert.equal(
    await readFile(internalErrorLogPath(rootDir), "utf8"),
    ""
  );
});

test("outcome substitutions keep safe diagnostic causes", async (t) => {
  const dir = await mkdtemp(
    path.join(tmpdir(), "1667-mutation-outcome-diagnostic-")
  );
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new MutationReceiptStore(
    dir,
    async () => { throw new Error("unused"); }
  );
  await store.init();

  const durabilityFailure = new StoryDurabilityError(
    "private durability failure",
    { cause: new Error("private fsync cause") }
  );
  const uncertainMutation = await rejectionOf(store.run(
    currentMutationId("2"),
    "renameStory",
    { id: "story", title: "Other" },
    async () => {
      throw durabilityFailure;
    }
  ));
  assert.equal((uncertainMutation as Error).cause, durabilityFailure);

  const providerFailure = new Error("private post-admission failure");
  const providerMutationId = currentMutationId("3");
  const uncertainGeneration = await rejectionOf(store.run(
    providerMutationId,
    "autonameStory",
    { id: "story" },
    async (execution) => {
      await execution.providerStarted();
      throw providerFailure;
    }
  ));
  const diagnostic = (uncertainGeneration as Error).cause;
  assert(diagnostic instanceof Error);
  assert.equal(diagnostic.name, "ProviderRecoveryDiagnostic");
  assert.equal(
    diagnostic.message,
    `Provider request outcome is unknown. providerMutationId=${providerMutationId}`
  );
  assert.doesNotMatch(diagnostic.message, /private post-admission failure/);
});

test("every receipt save boundary retains its private persistence cause", async () => {
  if (process.platform === "win32") return;
  for (const phase of ["initial", "failed", "completed"] as const) {
    const dir = await mkdtemp(
      path.join(tmpdir(), `1667-mutation-persistence-${phase}-`)
    );
    try {
      const store = new MutationReceiptStore(
        dir,
        async () => { throw new Error("unused"); }
      );
      await store.init();
      if (phase === "initial") await chmod(dir, 0o500);
      const failure = await rejectionOf(store.run(
        currentMutationId({
          initial: "a",
          failed: "b",
          completed: "c"
        }[phase]),
        "deleteStory",
        { id: "story" },
        async () => {
          await chmod(dir, 0o500);
          if (phase === "failed") {
            throw new ServiceError(409, "Domain failure");
          }
          return { ok: true };
        }
      ));
      assert.ok(isMutationReceiptPersistenceError(failure));
      assert.equal(failure.code, "mutation_outcome_unknown");
      assert.ok(failure.cause instanceof Error);
    } finally {
      await chmod(dir, 0o700);
      await rm(dir, { recursive: true, force: true });
    }
  }
});

function currentMutationId(suffix: string): string {
  return `m1.${Date.now().toString().padStart(13, "0")}.${suffix.padStart(32, "0")}`;
}

async function rejectionOf(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  assert.fail("Expected operation to reject");
}
