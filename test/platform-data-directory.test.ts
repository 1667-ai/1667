import assert from "node:assert/strict";
import test from "node:test";
import { resolvePlatformDataDirectory } from "../server/platform-data-directory.js";

test("platform data defaults are account-owned and distinct from package bytes", () => {
  assert.equal(resolvePlatformDataDirectory({
    packaged: true,
    platform: "darwin",
    home: "/Users/reader",
    env: {}
  }), "/Users/reader/Library/Application Support/1667/Data/default");
  assert.equal(resolvePlatformDataDirectory({
    packaged: true,
    platform: "linux",
    home: "/home/reader",
    env: {}
  }), "/home/reader/.local/share/1667/default");
  assert.equal(resolvePlatformDataDirectory({
    packaged: true,
    platform: "linux",
    home: "/home/reader",
    env: { XDG_DATA_HOME: "/srv/reader-data" }
  }), "/srv/reader-data/1667/default");
  assert.equal(resolvePlatformDataDirectory({
    packaged: true,
    platform: "win32",
    home: "C:\\Users\\reader",
    env: { LOCALAPPDATA: "C:\\Users\\reader\\AppData\\Local" }
  }), "C:\\Users\\reader\\AppData\\Local\\1667\\Data\\default");
});

test("source data defaults remain explicit checkout or launch fixtures", () => {
  assert.equal(resolvePlatformDataDirectory({
    packaged: false,
    platform: "linux",
    cwd: "/checkout"
  }), "/checkout/data");
});

test("packaged data overrides must be absolute", () => {
  assert.throws(() => resolvePlatformDataDirectory({
    configured: "relative-data",
    packaged: true,
    platform: "linux",
    home: "/home/reader",
    cwd: "/app"
  }), /must be absolute/);
  assert.equal(resolvePlatformDataDirectory({
    configured: "relative-data",
    packaged: false,
    platform: "linux",
    home: "/home/reader",
    cwd: "/app"
  }), "/app/relative-data");
});

test("an empty data override never resolves to the launch directory", () => {
  for (const packaged of [false, true]) {
    assert.throws(() => resolvePlatformDataDirectory({
      configured: "",
      packaged,
      platform: "linux",
      home: "/home/reader",
      cwd: "/app"
    }), /must not be empty/);
  }
});
