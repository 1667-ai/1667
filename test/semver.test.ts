import assert from "node:assert/strict";
import test from "node:test";
import {
  compareSemVer,
  isSemVer,
  isSemVerUpgradeAvailable,
  parseSemVer
} from "../shared/semver.js";

test("strict SemVer parsing accepts canonical versions without integer-size limits", () => {
  const parsed = parseSemVer("999999999999999999999.2.3-alpha.1+build.7");
  assert.equal(parsed?.major, "999999999999999999999");
  assert.deepEqual(parsed?.prerelease.map(({ value, numeric }) => ({ value, numeric })), [
    { value: "alpha", numeric: false },
    { value: "1", numeric: true }
  ]);
  assert.equal(isSemVer("1.2.3"), true);
});

test("strict SemVer parsing rejects leading zeroes and incomplete versions", () => {
  for (const value of ["1", "1.2", "01.2.3", "1.02.3", "1.2.03", "1.2.3-01", "v1.2.3", "1.2.3\n"]) {
    assert.equal(isSemVer(value), false, value);
  }
});

test("SemVer precedence follows the normative prerelease ordering", () => {
  const versions = [
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-alpha.beta",
    "1.0.0-beta",
    "1.0.0-beta.2",
    "1.0.0-beta.11",
    "1.0.0-rc.1",
    "1.0.0"
  ];
  for (let index = 1; index < versions.length; index += 1) {
    assert.equal(compareSemVer(versions[index - 1]!, versions[index]!), -1);
  }
  assert.equal(compareSemVer("1.2.3+first", "1.2.3+second"), 0);
  assert.throws(() => compareSemVer("latest", "1.2.3"), TypeError);
});

test("upgrade availability follows precedence and exact version identity", () => {
  assert.equal(isSemVerUpgradeAvailable("0.5.6-rc.1", "0.5.5"), true);
  assert.equal(isSemVerUpgradeAvailable("0.5.5", "0.5.5"), false);
  assert.equal(isSemVerUpgradeAvailable("0.5.5+build.2", "0.5.5+build.1"), true);
  assert.equal(isSemVerUpgradeAvailable("0.5.5-rc.1", "0.5.5"), false);
});
