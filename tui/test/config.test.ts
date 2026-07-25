import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  loadConfig,
  normalizeUserConfig,
  saveConfig
} from "../src/config.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

test("config replacement failure preserves the last durable value", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-config-"));
  roots.push(root);
  await chmod(root, 0o700);
  const file = path.join(root, "config.json");
  const original = normalizeUserConfig({
    theme: "parchment",
    factsRail: "off"
  });
  const replacement = {
    ...original,
    theme: "bond" as const
  };
  saveConfig(original, { file });

  saveConfig(replacement, {
    file,
    afterTemporaryFileSync: () => {
      throw new Error("simulated interruption before rename");
    }
  });

  expect(loadConfig({ file })).toEqual(original);
  expect((await readdir(root)).sort()).toEqual(["config.json"]);
});

test("config replacement publishes one complete new document", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-config-"));
  roots.push(root);
  await chmod(root, 0o700);
  const file = path.join(root, "config.json");
  const config = normalizeUserConfig({
    theme: "hi-contrast dark",
    composeFocus: "on",
    quota: { date: "2026-07-25", words: 123 }
  });

  saveConfig(config, { file });

  expect(loadConfig({ file })).toEqual(config);
  expect((await readdir(root)).sort()).toEqual(["config.json"]);
});
