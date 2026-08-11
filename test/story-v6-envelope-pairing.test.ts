import assert from "node:assert/strict";
import test from "node:test";
import type { StoryManifestV7 } from "../server/story-format.js";
import type { LiveEnvelopeSpec } from "../server/story-v6-codec.js";

/**
 * The compile-level proof for review finding B: the shared live-envelope
 * parser in `server/story-v6-codec.ts` must not be able to pair a version 6
 * envelope with version 7 content.
 *
 * `LiveEnvelopeSpec<V>` keys its `requireContent` return type off
 * `LiveEnvelopeContentByVersion[V]`, so `LiveEnvelopeSpec<6>` demands content
 * typed `StoryManifestV5`. The assignment below supplies `StoryManifestV7`
 * content instead. `tsc --noEmit` must report an error on that line, which is
 * what the `@ts-expect-error` line asserts. If a future edit loosens the
 * pairing, this file stops compiling clean and `npm run typecheck` fails.
 */
declare const v7Content: StoryManifestV7;

const mismatchedV6Spec: LiveEnvelopeSpec<6> = {
  schemaVersion: 6,
  // @ts-expect-error a version 6 envelope spec must require V5 content; a
  // `requireContent` that returns `StoryManifestV7` cannot satisfy
  // `LiveEnvelopeSpec<6>`, so this mis-paired spec does not compile.
  requireContent: () => v7Content
};

test("story V6/V8 envelope pairing: the mismatch above is a type error, not a runtime one", () => {
  // Nothing to run. The proof is that this file type-checks only because
  // the assignment above is REJECTED, per the `@ts-expect-error` line. If
  // that assignment ever compiles, `tsc` reports an unused
  // `@ts-expect-error` directive and `npm run typecheck` fails.
  assert.equal(typeof mismatchedV6Spec, "object");
});
