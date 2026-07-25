import assert from "node:assert/strict";
import test from "node:test";
import {
  assertHardenedDataDirectoryPlatform
} from "../server/data-directory-admission.js";
import {
  resolvePrivatePlatformStateRoot
} from "../server/platform-state-root.js";
import { attachHttpServer } from "../tui/src/http-attach.js";
import { runAuthShow, startLegacyServe } from "../tui/src/http-commands.js";

test("Windows storage and HTTP authority fail closed without native adapters", async () => {
  assert.throws(
    () => assertHardenedDataDirectoryPlatform("win32"),
    /DACL and reparse-safe/
  );
  await assert.rejects(
    resolvePrivatePlatformStateRoot({ platform: "win32" }),
    /DACL\/reparse-safe/
  );
  await assert.rejects(
    attachHttpServer("http://127.0.0.1:7373", null, "win32"),
    /unavailable on Windows/
  );
  await assert.rejects(
    runAuthShow(
      ["show", "--scope", "story"],
      { isTTY: true, write: () => true },
      "win32"
    ),
    /unavailable on Windows/
  );
  await assert.rejects(
    startLegacyServe("C:\\data", { platform: "win32" }),
    /unavailable on Windows/
  );
});
