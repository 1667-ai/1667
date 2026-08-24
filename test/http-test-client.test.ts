import assert from "node:assert/strict";
import test from "node:test";
import { announcedTestServerOrigin } from "./http-test-client.js";

test("HTTP test readiness origin waits for a complete stdout line", () => {
  const prefix = "startup warning\n1667 listening on http://127.0.0.1";
  let output = prefix;
  assert.equal(announcedTestServerOrigin(output), null);

  output += ":";
  assert.equal(announcedTestServerOrigin(output), null);

  output += "43165";
  assert.equal(announcedTestServerOrigin(output), null);

  output += " (data: /tmp/1667-test-data)";
  assert.equal(
    announcedTestServerOrigin(output),
    "http://127.0.0.1:43165"
  );
});

test("HTTP test readiness origin does not accept a mid-port stdout chunk", () => {
  let output = "1667 listening on http://127.0.0.1:43";
  assert.equal(announcedTestServerOrigin(output), null);

  output += "165 (data: /tmp/1667-test-data)";
  assert.equal(
    announcedTestServerOrigin(output),
    "http://127.0.0.1:43165"
  );
});

test("HTTP test readiness origin requires an explicit numeric port", () => {
  assert.equal(
    announcedTestServerOrigin(
      "1667 listening on http://127.0.0.1 (data: /tmp/1667-test-data)"
    ),
    null
  );
});
