import assert from "node:assert/strict";
import test from "node:test";
import { parseAsideComposerInput } from "../tui/src/aside-parse.js";

test("Direct composer /aside opens Aside", () => {
  assert.deepEqual(parseAsideComposerInput("/aside"), { kind: "open" });
  assert.deepEqual(parseAsideComposerInput("/aside How could this conflict become personal?"), {
    kind: "open-and-ask",
    question: "How could this conflict become personal?"
  });
});

test("//aside stays normal Direct input", () => {
  assert.deepEqual(parseAsideComposerInput("//aside How?"), { kind: "none" });
});

test("/asideways is not an Aside command", () => {
  assert.deepEqual(parseAsideComposerInput("/asideways"), { kind: "none" });
});
