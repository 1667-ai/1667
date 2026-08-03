import assert from "node:assert/strict";
import test from "node:test";
import packageJson from "../package.json" with { type: "json" };
import {
  parseCliArgs,
  USAGE,
  validateInstallerUrl
} from "../scripts/release-install-upgrade-e2e.js";
import { stableOnlyRefusal } from "../scripts/release-install-upgrade-e2e-lib.js";

const CURRENT_VERSION = packageJson.version;

function parseArgs(argv: readonly string[]) {
  const result = parseCliArgs(argv);
  assert.equal(result.kind, "args");
  if (result.kind !== "args") throw new Error("unreachable");
  return result.args;
}

test("the gate derives both installer URLs from the release versions", () => {
  const args = parseArgs(["--from-version", "0.1.2-beta.3"]);
  assert.deepEqual(args, {
    fromVersion: "0.1.2-beta.3",
    fromChannel: "beta",
    homepageUrl: "https://1667.ai/install.sh",
    currentUrl:
      `https://github.com/1667-ai/1667/releases/download/v${CURRENT_VERSION}/install-stable.sh`,
    previousUrl:
      "https://github.com/1667-ai/1667/releases/download/v0.1.2-beta.3/install-beta.sh"
  });
});

test("the previous installer follows the named channel", () => {
  const args = parseArgs(["--from-version=0.1.1", "--from-channel=stable"]);
  assert.equal(
    args.previousUrl,
    "https://github.com/1667-ai/1667/releases/download/v0.1.1/install-stable.sh"
  );
});

test("--help prints usage instead of arguments", () => {
  for (const flag of ["-h", "--help"]) {
    const result = parseCliArgs([flag]);
    assert.equal(result.kind, "help");
    if (result.kind !== "help") throw new Error("unreachable");
    assert.equal(result.text, USAGE);
  }
});

test("the gate refuses arguments it cannot act on", () => {
  const cases: readonly (readonly [readonly string[], RegExp])[] = [
    [[], /Missing required option --from-version/u],
    [["--from-version"], /--from-version requires a valid semver string/u],
    [["--from-version", "not-a-version"], /--from-version requires a valid semver string/u],
    [["--from-version", "0.1.2", "--from-channel", "nightly"], /--from-channel must be/u],
    [["--from-version", "0.1.2", "--homepage-url"], /--homepage-url requires a non-empty URL/u],
    [["--from-version", "0.1.2", "--unknown"], /Unknown argument '--unknown'/u]
  ];
  for (const [argv, expected] of cases) {
    assert.throws(() => parseCliArgs(argv), expected, argv.join(" "));
  }
});

test("an inline value keeps every character after the first equals sign", () => {
  // The gate downloads, attests, and then executes these bytes, so a truncated
  // URL would verify one artifact and run a different one.
  const args = parseArgs([
    "--from-version=0.1.2",
    "--homepage-url=https://example.test/a=b/install.sh"
  ]);
  assert.equal(args.homepageUrl, "https://example.test/a=b/install.sh");
});

test("installer URLs accept HTTPS and loopback HTTP only", () => {
  assert.equal(
    validateInstallerUrl("https://1667.ai/install.sh", "--homepage-url"),
    "https://1667.ai/install.sh"
  );
  for (const loopback of ["http://127.0.0.1:8080/install.sh", "http://localhost:8080/install.sh"]) {
    assert.equal(validateInstallerUrl(loopback, "--homepage-url"), loopback);
  }
});

test("installer URLs refuse every shape that could redirect execution", () => {
  const rejected: readonly (readonly [string, RegExp])[] = [
    ["", /requires a non-empty URL/u],
    ["http://example.test/install.sh", /must use HTTPS or loopback HTTP/u],
    ["ftp://example.test/install.sh", /must use HTTPS or loopback HTTP/u],
    ["file:///etc/passwd", /must use HTTPS or loopback HTTP/u],
    ["not a url", /contains disallowed control or quote characters/u],
    ["https://user:secret@example.test/install.sh", /must not contain credentials/u],
    ["https://example.test/install.sh#fragment", /must not contain a URL fragment/u],
    ["https://example.test/install.sh?token=1", /must not contain query parameters/u],
    ["https://example.test/install.sh\n", /contains disallowed control or quote characters/u],
    ["https://example.test/'; rm -rf /", /contains disallowed control or quote characters/u]
  ];
  for (const [url, expected] of rejected) {
    assert.throws(() => validateInstallerUrl(url, "--homepage-url"), expected, url);
  }
});

// The refusal takes literal versions, not the checkout version. A release
// branch moves between prerelease and stable forms, and this behavior must not
// move with it.
test("the gate refuses a prerelease checkout and names the reason", () => {
  const refusal = stableOnlyRefusal("0.3.0-rc.1");
  assert.match(refusal ?? "", /verifies a stable release/u);
  assert.match(refusal ?? "", /0\.3\.0-rc\.1/u);
});

test("the gate accepts a stable checkout", () => {
  assert.equal(stableOnlyRefusal("0.3.0"), null);
});
