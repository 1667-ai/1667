import { afterEach, expect, test } from "bun:test";
import {
  spawn,
  type ChildProcessWithoutNullStreams
} from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdtemp,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PrivateHttpMutationIntentStore
} from "../src/http-mutation-intents.js";

const roots: string[] = [];
const DATA_DIRECTORY_A = "aa".repeat(32);
const DATA_DIRECTORY_B = "bb".repeat(32);
const DATA_DIRECTORY_CLAIM_A = "ca".repeat(32);
const DATA_DIRECTORY_CLAIM_B = "cb".repeat(32);
const ORIGIN = "http://127.0.0.1:7373";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

test("HTTP create identity stays scoped to its data directory", async () => {
  const root = await privateRoot();
  const firstStore = await PrivateHttpMutationIntentStore.create({
    dataDirectoryId: DATA_DIRECTORY_A,
    dataDirectoryClaimId: DATA_DIRECTORY_CLAIM_A,
    origin: ORIGIN,
    privateStateRoot: root
  });
  const first = await firstStore.claim("createStory", "The same story");
  await first.retain();

  const restartedStore = await PrivateHttpMutationIntentStore.create({
    dataDirectoryId: DATA_DIRECTORY_A,
    dataDirectoryClaimId: DATA_DIRECTORY_CLAIM_A,
    origin: ORIGIN,
    privateStateRoot: root
  });
  const retry = await restartedStore.claim(
    "createStory",
    "The same story"
  );
  const other = await restartedStore.claim(
    "createStory",
    "A different story"
  );
  const independentStore = await PrivateHttpMutationIntentStore.create({
    dataDirectoryId: DATA_DIRECTORY_B,
    dataDirectoryClaimId: DATA_DIRECTORY_CLAIM_B,
    origin: ORIGIN,
    privateStateRoot: root
  });
  const independent = await independentStore.claim(
    "createStory",
    "The same story"
  );

  expect(first.reused).toBe(false);
  expect(retry.reused).toBe(true);
  expect(other.reused).toBe(false);
  expect(independent.reused).toBe(false);
  expect(retry.mutationId).toBe(first.mutationId);
  expect(other.mutationId).not.toBe(first.mutationId);
  expect(independent.mutationId).not.toBe(first.mutationId);
  const copiedStore = await PrivateHttpMutationIntentStore.create({
    dataDirectoryId: DATA_DIRECTORY_A,
    dataDirectoryClaimId: DATA_DIRECTORY_CLAIM_B,
    origin: ORIGIN,
    privateStateRoot: root
  });
  let copiedClaimError: unknown;
  try {
    await copiedStore.claim("createStory", "The same story");
  } catch (error) {
    copiedClaimError = error;
  }
  expect(
    copiedClaimError instanceof Error ? copiedClaimError.message : ""
  ).toContain("belongs to a different data-directory claim");

  await retry.complete();
  await other.retain();
  const afterCompletion = await restartedStore.claim(
    "createStory",
    "The same story"
  );
  expect(afterCompletion.mutationId).not.toBe(retry.mutationId);
  const independentRetry = await independentStore.claim(
    "createStory",
    "The same story"
  );
  expect(independentRetry.mutationId).toBe(independent.mutationId);
  await afterCompletion.retain();
  await independent.retain();
  await independentRetry.retain();
});

test("HTTP import identity fingerprints the exact retained input", async () => {
  const root = await privateRoot();
  const store = await PrivateHttpMutationIntentStore.create({
    dataDirectoryId: DATA_DIRECTORY_A,
    dataDirectoryClaimId: DATA_DIRECTORY_CLAIM_A,
    origin: ORIGIN,
    privateStateRoot: root
  });
  const first = await store.claim("importSillyTavern", "{\"name\":\"one\"}");
  const retry = await store.claim("importSillyTavern", "{\"name\":\"one\"}");
  const changed = await store.claim(
    "importSillyTavern",
    "{\"name\":\"two\"}"
  );

  expect(retry.mutationId).toBe(first.mutationId);
  expect(changed.mutationId).not.toBe(first.mutationId);
  await first.retain();
  await retry.retain();
  await changed.retain();
});

test("HTTP mutation intent survives a concurrent uncertain claimant", async () => {
  const root = await privateRoot();
  const store = await PrivateHttpMutationIntentStore.create({
    dataDirectoryId: DATA_DIRECTORY_A,
    dataDirectoryClaimId: DATA_DIRECTORY_CLAIM_A,
    origin: ORIGIN,
    privateStateRoot: root
  });
  const successful = await store.claim("createStory", "Concurrent result");
  const uncertain = await store.claim("createStory", "Concurrent result");

  expect(uncertain.mutationId).toBe(successful.mutationId);
  await successful.complete();
  const whileActive = await store.claim(
    "createStory",
    "Concurrent result"
  );
  expect(whileActive.mutationId).toBe(successful.mutationId);
  await uncertain.retain();
  await whileActive.retain();

  const retry = await store.claim("createStory", "Concurrent result");
  expect(retry.mutationId).toBe(successful.mutationId);
  await retry.complete();
  const next = await store.claim("createStory", "Concurrent result");
  expect(next.mutationId).not.toBe(successful.mutationId);
  await next.retain();
});

test("HTTP mutation intent bounds only concurrent claims", async () => {
  const root = await privateRoot();
  const store = await PrivateHttpMutationIntentStore.create({
    dataDirectoryId: DATA_DIRECTORY_A,
    dataDirectoryClaimId: DATA_DIRECTORY_CLAIM_A,
    origin: ORIGIN,
    privateStateRoot: root
  });
  const held = await store.claim("createStory", "Long-running claim");
  for (let index = 0; index < 70; index += 1) {
    const sequential = await store.claim(
      "createStory",
      "Long-running claim"
    );
    expect(sequential.mutationId).toBe(held.mutationId);
    await sequential.complete();
  }

  await held.complete();
  const next = await store.claim("createStory", "Long-running claim");
  expect(next.mutationId).not.toBe(held.mutationId);
  await next.retain();
}, 15_000);

test("HTTP mutation claims serialize across processes", async () => {
  const root = await privateRoot();
  const processCount = 12;
  const results = await runIntentProcesses(root, processCount, "claim");

  expect(results.map((result) => ({
    exitCode: result.exitCode,
    error: result.error
  }))).toEqual(Array.from(
    { length: processCount },
    () => ({ exitCode: 0, error: "" })
  ));
  expect(new Set(results.map((result) => result.output)).size).toBe(1);
  expect(results[0]?.output).toMatch(/^m1\.[0-9]{13}\.[a-f0-9]{32}$/);
  const store = await PrivateHttpMutationIntentStore.create({
    dataDirectoryId: DATA_DIRECTORY_A,
    dataDirectoryClaimId: DATA_DIRECTORY_CLAIM_A,
    origin: ORIGIN,
    privateStateRoot: root
  });
  const recovered = await store.claim("createStory", "Concurrent story");
  expect(recovered.mutationId).toBe(results[0]?.output);
  await recovered.complete();
  const next = await store.claim("createStory", "Concurrent story");
  expect(next.mutationId).not.toBe(recovered.mutationId);
  await next.retain();
});

test("HTTP mutation completion serializes across processes", async () => {
  const root = await privateRoot();
  const store = await PrivateHttpMutationIntentStore.create({
    dataDirectoryId: DATA_DIRECTORY_A,
    dataDirectoryClaimId: DATA_DIRECTORY_CLAIM_A,
    origin: ORIGIN,
    privateStateRoot: root
  });
  const initial = await store.claim("createStory", "Concurrent story");
  await initial.retain();

  const results = await runIntentProcesses(root, 12, "complete");

  expect(results.every((result) =>
    result.exitCode === 0
      && result.error === ""
      && result.output === initial.mutationId
  )).toBeTrue();
  const next = await store.claim("createStory", "Concurrent story");
  expect(next.mutationId).not.toBe(initial.mutationId);
  await next.retain();
});

test("HTTP mutation intent locking uses one fixed inode", async () => {
  const root = await privateRoot();
  const store = await PrivateHttpMutationIntentStore.create({
    dataDirectoryId: DATA_DIRECTORY_A,
    dataDirectoryClaimId: DATA_DIRECTORY_CLAIM_A,
    origin: ORIGIN,
    privateStateRoot: root
  });
  for (let index = 0; index < 20; index += 1) {
    const claim = await store.claim("createStory", `Story ${index}`);
    await claim.complete();
  }

  expect(await readdir(path.join(root, "http-mutation-intents"))).toEqual([
    "http-mutation-intents.lock"
  ]);
}, 15_000);

test("HTTP intent store retries a version-1 identity at its origin", async () => {
  const root = await privateRoot();
  const operation = "createStory";
  const input = "Retained story";
  const store = await PrivateHttpMutationIntentStore.create({
    dataDirectoryId: DATA_DIRECTORY_A,
    dataDirectoryClaimId: DATA_DIRECTORY_CLAIM_A,
    origin: ORIGIN,
    privateStateRoot: root
  });
  const legacyFile = await writeLegacyIntent(root, operation, input);

  const retry = await store.claim(operation, input);
  expect(retry.mutationId).toBe(
    "m1.1785226071759.d82f33db5536a7b50c2385dc737700cb"
  );
  await retry.complete();
  expect(await exists(legacyFile)).toBeFalse();

  const next = await store.claim(operation, input);
  expect(next.mutationId).not.toBe(retry.mutationId);
});

test("HTTP intent store rejects simultaneous version-1 and version-2 identities", async () => {
  const root = await privateRoot();
  const operation = "createStory";
  const input = "Retained story";
  const store = await PrivateHttpMutationIntentStore.create({
    dataDirectoryId: DATA_DIRECTORY_A,
    dataDirectoryClaimId: DATA_DIRECTORY_CLAIM_A,
    origin: ORIGIN,
    privateStateRoot: root
  });
  const versionTwo = await store.claim(operation, input);
  const legacyFile = await writeLegacyIntent(root, operation, input);

  let claimError: unknown;
  try {
    await store.claim(operation, input);
  } catch (error) {
    claimError = error;
  }
  expect(claimError instanceof Error ? claimError.message : "").toContain(
    "contain ambiguous versions"
  );
  expect(await exists(legacyFile)).toBeTrue();

  await versionTwo.complete();
  const legacy = await store.claim(operation, input);
  expect(legacy.mutationId).not.toBe(versionTwo.mutationId);
  await legacy.retain();
});

test("HTTP intent store blocks a version-1 identity from another origin", async () => {
  const root = await privateRoot();
  const operation = "createStory";
  const input = "Retained story";
  const store = await PrivateHttpMutationIntentStore.create({
    dataDirectoryId: DATA_DIRECTORY_A,
    dataDirectoryClaimId: DATA_DIRECTORY_CLAIM_A,
    origin: "http://127.0.0.1:8484",
    privateStateRoot: root
  });
  const legacyFile = await writeLegacyIntent(root, operation, input);

  let claimError: unknown;
  try {
    await store.claim(operation, input);
  } catch (error) {
    claimError = error;
  }
  expect(claimError instanceof Error ? claimError.message : "").toContain(
    "belongs to a different listener origin"
  );
  expect(await exists(legacyFile)).toBeTrue();
});

async function privateRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "1667-http-intents-"));
  roots.push(root);
  await chmod(root, 0o700);
  return root;
}

async function writeLegacyIntent(
  root: string,
  operation: "createStory" | "importSillyTavern",
  semanticInput: string
): Promise<string> {
  const fingerprint = legacyFingerprint(operation, semanticInput);
  const file = path.join(
    root,
    "http-mutation-intents",
    `${fingerprint}.json`
  );
  await writeFile(file, `${JSON.stringify({
    format: "1667-http-mutation-intent",
    schemaVersion: 1,
    origin: ORIGIN,
    operation,
    fingerprint,
    mutationId: "m1.1785226071759.d82f33db5536a7b50c2385dc737700cb",
    createdAt: "2026-07-28T08:07:51.768Z"
  })}\n`, { mode: 0o600 });
  return file;
}

async function exists(file: string): Promise<boolean> {
  return await access(file).then(
    () => true,
    () => false
  );
}

async function waitForReadyProcesses(
  root: string,
  processCount: number
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const ready = await Promise.all(Array.from(
      { length: processCount },
      (_, index) => exists(path.join(root, `ready-${index}`))
    ));
    if (ready.every(Boolean)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("HTTP mutation intent processes did not become ready");
}

async function runIntentProcesses(
  root: string,
  processCount: number,
  action: "claim" | "complete"
): Promise<Array<{
  exitCode: number | null;
  output: string;
  error: string;
}>> {
  const fixture = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "fixtures",
    "http-mutation-intent-process.ts"
  );
  const children = Array.from({ length: processCount }, (_, index) => {
    const child = spawn(
      process.execPath,
      [fixture, root, String(index), action]
    );
    child.stdin.end();
    return collectChild(child);
  });
  await waitForReadyProcesses(root, processCount);
  await writeFile(path.join(root, "claim-gate"), "");
  return await Promise.all(children);
}

async function collectChild(
  child: ChildProcessWithoutNullStreams
): Promise<{ exitCode: number | null; output: string; error: string }> {
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let output = "";
  let error = "";
  child.stdout.on("data", (chunk: string) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    error += chunk;
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return {
    exitCode,
    output: output.trim(),
    error: error.trim()
  };
}

function legacyFingerprint(
  operation: string,
  semanticInput: string
): string {
  return createHash("sha256")
    .update("1667-http-absent-mutation-v1", "utf8")
    .update("\0", "utf8")
    .update(operation, "utf8")
    .update("\0", "utf8")
    .update(semanticInput, "utf8")
    .digest("hex");
}
