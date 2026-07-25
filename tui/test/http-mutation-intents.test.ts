import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  PrivateHttpMutationIntentStore
} from "../src/http-mutation-intents.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

test("HTTP create identity survives a client restart until exact completion", async () => {
  const root = await privateRoot();
  const firstStore = await PrivateHttpMutationIntentStore.create(
    "http://127.0.0.1:7373",
    root
  );
  const first = await firstStore.claim("createStory", "The same story");

  const restartedStore = await PrivateHttpMutationIntentStore.create(
    "http://127.0.0.1:7373",
    root
  );
  const retry = await restartedStore.claim(
    "createStory",
    "The same story"
  );
  const other = await restartedStore.claim(
    "createStory",
    "A different story"
  );

  expect(retry.mutationId).toBe(first.mutationId);
  expect(other.mutationId).not.toBe(first.mutationId);

  await retry.complete();
  const afterCompletion = await restartedStore.claim(
    "createStory",
    "The same story"
  );
  expect(afterCompletion.mutationId).not.toBe(first.mutationId);
});

test("HTTP import identity fingerprints the exact retained input", async () => {
  const root = await privateRoot();
  const store = await PrivateHttpMutationIntentStore.create(
    "http://127.0.0.1:7373",
    root
  );
  const first = await store.claim("importSillyTavern", "{\"name\":\"one\"}");
  const retry = await store.claim("importSillyTavern", "{\"name\":\"one\"}");
  const changed = await store.claim(
    "importSillyTavern",
    "{\"name\":\"two\"}"
  );

  expect(retry.mutationId).toBe(first.mutationId);
  expect(changed.mutationId).not.toBe(first.mutationId);
});

async function privateRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "1667-http-intents-"));
  roots.push(root);
  await chmod(root, 0o700);
  return root;
}
