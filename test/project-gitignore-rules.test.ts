import assert from "node:assert/strict";
import test from "node:test";
import {
  managedProjectIgnoreStatesAreEffective
} from "../server/project-gitignore-rules.js";

test("managed Git rules honor later matching patterns", () => {
  assert.equal(
    managedProjectIgnoreStatesAreEffective(Buffer.from("user-entry\n")),
    true
  );
  assert.equal(
    managedProjectIgnoreStatesAreEffective(Buffer.from("data-id\n")),
    false
  );
  assert.equal(
    managedProjectIgnoreStatesAreEffective(
      Buffer.from("*\n!data-id\n")
    ),
    true
  );
  assert.equal(
    managedProjectIgnoreStatesAreEffective(
      Buffer.from("!http-data-directory-claim-key\n")
    ),
    false
  );
  assert.equal(
    managedProjectIgnoreStatesAreEffective(
      Buffer.from("[[:lower:]]ata-id\n")
    ),
    false
  );
  assert.equal(
    managedProjectIgnoreStatesAreEffective(
      Buffer.from("![[:lower:]]ttp-data-directory-claim-key*\n")
    ),
    false
  );
  assert.equal(
    managedProjectIgnoreStatesAreEffective(Buffer.from("DATA-ID\n")),
    false
  );
  assert.equal(
    managedProjectIgnoreStatesAreEffective(
      Buffer.from("!HTTP-DATA-DIRECTORY-CLAIM-KEY*\n")
    ),
    false
  );
});

test("managed Git rules match adversarial wildcards in bounded time", () => {
  const pattern = `${"*?".repeat(16)}z\n`;
  const started = process.hrtime.bigint();

  assert.equal(
    managedProjectIgnoreStatesAreEffective(Buffer.from(pattern)),
    true
  );
  assert.ok(process.hrtime.bigint() - started < 250_000_000n);
});
