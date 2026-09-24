import assert from "node:assert/strict";
import test from "node:test";
import { parseAsideComposerInput } from "../tui/src/aside-parse.js";

test("/asideways is not an Aside command", () => {
  assert.deepEqual(parseAsideComposerInput("/asideways"), { kind: "none" });
});
