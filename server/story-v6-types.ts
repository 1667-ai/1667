import type { StoryManifestV5, StoryManifestV7, StoryManifestV9 } from "./story-format.js";
import type {
  DeletedStoryManifestV8,
  LiveStoryManifestV8,
  StoryManifestV8
} from "./story-v8-types.js";
import type {
  DeletedStoryManifestV10,
  LiveStoryManifestV10,
  StoryManifestV10
} from "./story-v10-types.js";

export type StoryId = string;
export type Hash256 = string;
export type TimeMs = string;
export type Revision20 = string;
export type UInt64String = string;
export type MutationId = string;

export interface ProviderPointer {
  mutationId: MutationId;
  fingerprintHash: Hash256;
}

export type UserTransactionPointer =
  | { receiptKind: "user"; mutationId: MutationId; phase: "started" }
  | PreparedUserTransactionPointer;

export interface PreparedUserTransactionPointer {
  receiptKind: "user";
  mutationId: MutationId;
  phase: "prepared";
}

export interface StorySummaryV6 {
  id: StoryId;
  title: string;
  updatedAt: TimeMs;
  partCount: number;
  words: UInt64String;
  forked: boolean;
  lineCount: UInt64String;
}

/**
 * The live envelope, generalized over its schema version `V` and its content
 * payload type `C`. Every field except `content` and `schemaVersion` means
 * the same thing at version 6 and version 8: a schema version identifies one
 * document shape, and only the content version actually differs between
 * them. `server/story-v6-codec.ts` has one parser for this shape,
 * `parseLiveEnvelope`, instead of one copy per version.
 */
export interface LiveStoryEnvelope<V extends 6 | 8 | 10, C> {
  format: "1667-story";
  schemaVersion: V;
  kind: "live";
  id: StoryId;
  revision: Revision20;
  previousManifestHash: Hash256 | null;
  content: C;
  summary: StorySummaryV6;
  unresolvedProvider: ProviderPointer | null;
  lastTransaction: UserTransactionPointer | null;
}

/** The deleted envelope, generalized the same way as `LiveStoryEnvelope`. It
 *  carries no content, so only `schemaVersion` varies between versions. */
export interface DeletedStoryEnvelope<V extends 6 | 8 | 10> {
  format: "1667-story";
  schemaVersion: V;
  kind: "deleted";
  id: StoryId;
  revision: Revision20;
  previousManifestHash: Hash256;
  deletedAt: TimeMs;
  unresolvedProvider: ProviderPointer | null;
  lastTransaction: PreparedUserTransactionPointer;
}

export type LiveStoryManifestV6 = LiveStoryEnvelope<6, StoryManifestV5>;

export type DeletedStoryManifestV6 = DeletedStoryEnvelope<6>;

export type StoryManifestV6 = LiveStoryManifestV6 | DeletedStoryManifestV6;

/**
 * One committed take is a session write away from needing the V8 envelope
 * (`server/story-v6-reducer.ts`, `server/story-aggregate-session.ts`), so the
 * write path must hold either envelope in the same variable. This union is
 * that shared shape: whichever version, never a copy of the reducer or the
 * session logic for the other one. Read-only code that only ever sees an
 * already-persisted document keeps using the plain `StoryManifestV6` or
 * `StoryManifestV8` type instead.
 */
export type StoryEnvelopeManifest = StoryManifestV6 | StoryManifestV8 | StoryManifestV10;

/** The `kind: "live"` half of `StoryEnvelopeManifest`, for the write-path code
 *  that only ever replaces a live story (never a deleted one) with fresh
 *  content. */
export type LiveStoryEnvelopeManifest =
  | LiveStoryManifestV6
  | LiveStoryManifestV8
  | LiveStoryManifestV10;

/** The `kind: "deleted"` half of `StoryEnvelopeManifest`. The reaper and every
 *  other deletion path accept either envelope version: a story that reached
 *  version 8 or 10 before the writer deleted it must still be reclaimable. */
export type DeletedStoryEnvelopeManifest =
  | DeletedStoryManifestV6
  | DeletedStoryManifestV8
  | DeletedStoryManifestV10;

/** The content payload half of `StoryEnvelopeManifest`: whichever content
 *  version one write produced, before it picks the matching envelope. */
export type StoryEnvelopeContent = StoryManifestV5 | StoryManifestV7 | StoryManifestV9;

export type ParsedStoryManifest =
  | {
      kind: "v5";
      manifest: StoryManifestV5;
      sourceSchemaVersion: 2 | 3 | 4 | 5;
    }
  | { kind: "v6-live"; manifest: LiveStoryManifestV6 }
  | { kind: "v6-deleted"; manifest: DeletedStoryManifestV6 }
  | { kind: "v8-live"; manifest: LiveStoryManifestV8 }
  | { kind: "v8-deleted"; manifest: DeletedStoryManifestV8 }
  | { kind: "v10-live"; manifest: LiveStoryManifestV10 }
  | { kind: "v10-deleted"; manifest: DeletedStoryManifestV10 };
