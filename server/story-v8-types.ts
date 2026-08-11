import type { StoryManifestV7 } from "./story-format.js";
import type {
  Hash256,
  PreparedUserTransactionPointer,
  ProviderPointer,
  Revision20,
  StoryId,
  StorySummaryV6,
  TimeMs,
  UserTransactionPointer
} from "./story-v6-types.js";

/**
 * The successor envelope. Every field means exactly what it means on
 * `LiveStoryManifestV6` / `DeletedStoryManifestV6`: same scalar shapes, same
 * summary shape, same pointer shapes, because a schema version identifies
 * one document shape, and only `content` (and, inside it, `nodes[]`) is
 * where the successor actually differs. See the field comments in
 * `server/story-v6-types.ts` for what each one is.
 */
export interface LiveStoryManifestV8 {
  format: "1667-story";
  schemaVersion: 8;
  kind: "live";
  id: StoryId;
  revision: Revision20;
  previousManifestHash: Hash256 | null;
  content: StoryManifestV7;
  summary: StorySummaryV6;
  unresolvedProvider: ProviderPointer | null;
  lastTransaction: UserTransactionPointer | null;
}

export interface DeletedStoryManifestV8 {
  format: "1667-story";
  schemaVersion: 8;
  kind: "deleted";
  id: StoryId;
  revision: Revision20;
  previousManifestHash: Hash256;
  deletedAt: TimeMs;
  unresolvedProvider: ProviderPointer | null;
  lastTransaction: PreparedUserTransactionPointer;
}

export type StoryManifestV8 = LiveStoryManifestV8 | DeletedStoryManifestV8;
