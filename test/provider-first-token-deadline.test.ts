import assert from "node:assert/strict";
import test from "node:test";
import { prefillPhaseDeadlineMsFor } from "../server/provider-first-token-deadline.js";

/** shared/settings-provider-defaults.ts's NETWORK_CONNECTION_TIMEOUTS —
 *  firstTokenMs and totalMs, the values every connection ships with until a
 *  writer changes them. Named here, not imported, so this suite tests the
 *  derivation purely as arithmetic on plain numbers. */
const DEFAULT_CONFIGURED_MS = 120_000;
const DEFAULT_TOTAL_MS = 1_800_000;

test("an empty request body returns exactly the configured floor", () => {
  assert.equal(
    prefillPhaseDeadlineMsFor(DEFAULT_CONFIGURED_MS, 0, DEFAULT_TOTAL_MS),
    DEFAULT_CONFIGURED_MS
  );
});

test("a small prompt does not extend the configured floor", () => {
  // 500 bytes is a plausible minimal request body (a short instruction, no
  // story context). At 50 ms/byte that derives to 25,000 ms — far below the
  // 120 s default, so the configured floor still wins.
  assert.equal(
    prefillPhaseDeadlineMsFor(DEFAULT_CONFIGURED_MS, 500, DEFAULT_TOTAL_MS),
    DEFAULT_CONFIGURED_MS
  );
});

test("a large prompt extends the deadline past the configured floor", () => {
  // 20,000 bytes derives to 1,000,000 ms (50 ms/byte), comfortably past the
  // 120 s default and comfortably under the 30 minute default total deadline.
  const result = prefillPhaseDeadlineMsFor(DEFAULT_CONFIGURED_MS, 20_000, DEFAULT_TOTAL_MS);
  assert.equal(result, 1_000_000);
  assert.ok(result > DEFAULT_CONFIGURED_MS);
  assert.ok(result < DEFAULT_TOTAL_MS);
});

test("a request that would derive past the total deadline clamps to it", () => {
  // 200,000 bytes derives to 2,500,000 ms — far past even the 30 minute
  // default total deadline, let alone a connection configured with a
  // shorter one. The ceiling is the connection's own totalMs, not a fixed
  // constant: two different totalMs values clamp the same huge body at two
  // different points.
  assert.equal(
    prefillPhaseDeadlineMsFor(DEFAULT_CONFIGURED_MS, 200_000, DEFAULT_TOTAL_MS),
    DEFAULT_TOTAL_MS
  );
  const shorterTotalMs = 600_000;
  assert.equal(
    prefillPhaseDeadlineMsFor(DEFAULT_CONFIGURED_MS, 200_000, shorterTotalMs),
    shorterTotalMs
  );
});

test("a caller-configured value larger than the derived allowance still wins", () => {
  // A writer who has explicitly raised firstTokenMs past the default for
  // slow hardware must not be overridden by a moderate prompt's much smaller
  // derived allowance (1,000 bytes -> 50,000 ms).
  const configuredMs = 600_000;
  assert.equal(
    prefillPhaseDeadlineMsFor(configuredMs, 1_000, DEFAULT_TOTAL_MS),
    configuredMs
  );
});

test("a configured value above the total deadline is honoured, not clamped down to it", () => {
  // MAX_SETTINGS_TIMEOUT_MS (server/settings-v2-scalars.ts) is 24 hours, so a
  // hand-edited deadline longer than totalMs is a valid setting this program
  // has always honoured exactly (a configured firstTokenMs or
  // responseHeaderMs above totalMs simply means the total deadline fires
  // first and reports the real reason — see provider-sse.ts). The ceiling
  // bounds the derived allowance only, never the writer's own value:
  // clamping the result to totalMs would shorten that setting and abort
  // generations that previously succeeded.
  const totalMs = 900_000;
  const configuredMs = 20 * 60 * 1_000;
  assert.ok(configuredMs > totalMs);
  assert.equal(prefillPhaseDeadlineMsFor(configuredMs, 0, totalMs), configuredMs);
  assert.equal(prefillPhaseDeadlineMsFor(configuredMs, 1_000_000, totalMs), configuredMs);
});

test("the allowance covers the densest tokenization possible, not a typical one", () => {
  // The allowance is bytes * rate, but prefill costs tokens / throughput. So
  // the rate has to assume a real floor on bytes per token. Successive
  // versions of this used 4 (English prose), 3 (CJK) and 2 — each an
  // observation about typical text, each leaving denser input short. One
  // token per byte is the only figure that is actually a bound: a token comes
  // from at least one byte, so no tokenizer can put more than n tokens in n
  // bytes. This asserts that bound rather than any of the constants, so a
  // future rate change cannot quietly drop back under it.
  const PESSIMISTIC_TOKENS_PER_SECOND = 20;
  const DENSEST_BYTES_PER_TOKEN = 1;
  const bodyBytes = 20_000;
  const tokens = bodyBytes / DENSEST_BYTES_PER_TOKEN;
  const msPrefillCouldNeed = (tokens / PESSIMISTIC_TOKENS_PER_SECOND) * 1_000;

  // Given room under the total deadline, the grant covers the worst case.
  const generousTotalMs = 10 * msPrefillCouldNeed;
  assert.ok(
    prefillPhaseDeadlineMsFor(DEFAULT_CONFIGURED_MS, bodyBytes, generousTotalMs)
      >= msPrefillCouldNeed,
    "the derived allowance must cover one token per byte"
  );
});

test("the derivation is monotonic in request body size", () => {
  const small = prefillPhaseDeadlineMsFor(DEFAULT_CONFIGURED_MS, 1_000, DEFAULT_TOTAL_MS);
  const large = prefillPhaseDeadlineMsFor(DEFAULT_CONFIGURED_MS, 50_000, DEFAULT_TOTAL_MS);
  assert.ok(large > small);
});
