import assert from "node:assert/strict";
import test from "node:test";
import { resolveMachineTierRoot } from "../server/machine-tier.js";
import {
  resolvePrivatePlatformStateRoot
} from "../server/platform-state-root.js";
import { attachHttpServer } from "../tui/src/http-attach.js";
import { runAuthShow, startLegacyServe } from "../tui/src/http-commands.js";

// ADR007 removed the project-tier Windows refusal: a project tier is ordinary
// user data and opens there like anywhere else. The machine tier still needs a
// DACL and reparse-safe adapter, and everything built on it still fails closed.
test("Windows machine-tier authority fails closed without native adapters", async () => {
  await assert.rejects(
    resolvePrivatePlatformStateRoot({ platform: "win32" }),
    /DACL\/reparse-safe/
  );
  // The embedded backend resolves this before it starts, so the refusal reaches
  // the CLI as one line instead of killing a worker mid-bootstrap.
  await assert.rejects(
    resolveMachineTierRoot({ platform: "win32", environment: {} }),
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
