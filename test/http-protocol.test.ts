import assert from "node:assert/strict";
import test from "node:test";
import { attachmentFilename } from "../shared/http-protocol.js";

test("HTTP export filename keeps the server-provided sanitized story title", () => {
  assert.equal(attachmentFilename('attachment; filename="The_Lantern.md"', "story-id.md"), "The_Lantern.md");
  assert.equal(attachmentFilename('attachment; filename="../escape.md"', "story-id.md"), "story-id.md");
  assert.equal(attachmentFilename(null, "story-id.md"), "story-id.md");
});
