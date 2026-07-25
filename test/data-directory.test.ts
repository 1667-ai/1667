import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { REPOSITORY_ROOT, resolveDataDirectory } from "../server/data-directory.js";

test("relative data configuration is anchored to the repository across entrypoints", () => {
  assert.equal(resolveDataDirectory("./data"), path.join(REPOSITORY_ROOT, "data"));
  assert.equal(resolveDataDirectory("alternate"), path.join(REPOSITORY_ROOT, "alternate"));
});

test("absolute data configuration is preserved", () => {
  const absolute = path.join(path.parse(REPOSITORY_ROOT).root, "tmp", "1667-data");
  assert.equal(resolveDataDirectory(absolute), absolute);
});
