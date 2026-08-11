import assert from "node:assert/strict";
import test from "node:test";
import {
  FIRST_TOKEN_DEADLINE_CEILING_MS,
  firstTokenDeadlineMsFor
} from "../server/provider-first-token-deadline.js";

/** shared/settings-provider-defaults.ts's NETWORK_CONNECTION_TIMEOUTS.
 *  firstTokenMs — the value every connection ships with until a writer
 *  changes it. Named here, not imported, so this suite tests the derivation
 *  purely as arithmetic on plain numbers. */
const DEFAULT_CONFIGURED_MS = 120_000;

test("an empty request body returns exactly the configured floor", () => {
  assert.equal(
    firstTokenDeadlineMsFor(DEFAULT_CONFIGURED_MS, 0),
    DEFAULT_CONFIGURED_MS
  );
});

test("a small prompt does not extend the configured floor", () => {
  // 500 bytes is a plausible minimal request body (a short instruction, no
  // story context). At 12.5 ms/byte that derives to 6,250 ms — far below the
  // 120 s default, so the configured floor still wins.
  assert.equal(
    firstTokenDeadlineMsFor(DEFAULT_CONFIGURED_MS, 500),
    DEFAULT_CONFIGURED_MS
  );
});

test("a large prompt extends the deadline past the configured floor", () => {
  // 20,000 bytes derives to 250,000 ms (12.5 ms/byte), comfortably past the
  // 120 s default and comfortably under the 15 minute ceiling.
  const result = firstTokenDeadlineMsFor(DEFAULT_CONFIGURED_MS, 20_000);
  assert.equal(result, 250_000);
  assert.ok(result > DEFAULT_CONFIGURED_MS);
  assert.ok(result < FIRST_TOKEN_DEADLINE_CEILING_MS);
});

test("an enormous prompt clamps at the ceiling instead of growing without bound", () => {
  // 200,000 bytes derives to 2,500,000 ms — nearly three times the ceiling.
  assert.equal(
    firstTokenDeadlineMsFor(DEFAULT_CONFIGURED_MS, 200_000),
    FIRST_TOKEN_DEADLINE_CEILING_MS
  );
  // The ceiling itself must stay below totalMs's own 30 minute default, or
  // the total deadline would fire first and report the wrong reason.
  assert.ok(FIRST_TOKEN_DEADLINE_CEILING_MS < 30 * 60 * 1_000);
});

test("a caller-configured value larger than the derived allowance still wins", () => {
  // A writer who has explicitly raised firstTokenMs past the default for
  // slow hardware must not be overridden by a moderate prompt's much smaller
  // derived allowance (1,000 bytes -> 12,500 ms).
  const configuredMs = 600_000;
  assert.equal(
    firstTokenDeadlineMsFor(configuredMs, 1_000),
    configuredMs
  );
});

test("a configured value above the ceiling is honoured, not clamped down to it", () => {
  // MAX_SETTINGS_TIMEOUT_MS (server/settings-v2-scalars.ts) is 24 hours, so a
  // hand-edited 20 minute deadline is a valid setting that this program used
  // to honour exactly. The ceiling bounds the derived allowance, never the
  // writer's own value: clamping the result would shorten that setting to 15
  // minutes and abort generations that previously succeeded.
  const configuredMs = 20 * 60 * 1_000;
  assert.ok(configuredMs > FIRST_TOKEN_DEADLINE_CEILING_MS);
  assert.equal(firstTokenDeadlineMsFor(configuredMs, 0), configuredMs);
  assert.equal(firstTokenDeadlineMsFor(configuredMs, 1_000_000), configuredMs);
});

test("the derivation is monotonic in request body size", () => {
  const small = firstTokenDeadlineMsFor(DEFAULT_CONFIGURED_MS, 1_000);
  const large = firstTokenDeadlineMsFor(DEFAULT_CONFIGURED_MS, 50_000);
  assert.ok(large > small);
});
