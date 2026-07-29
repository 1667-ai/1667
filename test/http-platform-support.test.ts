import assert from "node:assert/strict";
import test from "node:test";
import {
  assertHttpPlatformSupport,
  linuxKernelVersion
} from "../server/http-platform-support.js";

test("Linux HTTP mode requires kernel 6.8", () => {
  assert.doesNotThrow(() => assertHttpPlatformSupport("linux", "6.8"));
  assert.doesNotThrow(() =>
    assertHttpPlatformSupport("linux", "6.12.32_1"));
  assert.throws(
    () => assertHttpPlatformSupport("linux", "6.7.12"),
    /Linux HTTP mode requires Linux kernel 6.8 or later/
  );
  assert.throws(
    () => assertHttpPlatformSupport("linux", "not-a-release"),
    /Linux HTTP mode requires Linux kernel 6.8 or later/
  );
  assert.throws(
    () => assertHttpPlatformSupport("darwin", "1.0"),
    /HTTP server mode requires Linux retained-directory authority/
  );
});

test("Linux release parsing keeps its numeric prefix", () => {
  assert.deepEqual(linuxKernelVersion("6.8.12-arch1-1"), [6, 8, 12]);
  assert.deepEqual(linuxKernelVersion("6.8.0+azure"), [6, 8, 0]);
  assert.deepEqual(linuxKernelVersion("6.12.32_1"), [6, 12, 32]);
  assert.equal(linuxKernelVersion("release-6.8"), null);
});
