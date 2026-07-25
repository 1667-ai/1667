import type { StoryManifestV5 } from "./story-format.js";

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

export interface LiveStoryManifestV6 {
  format: "1667-story";
  schemaVersion: 6;
  kind: "live";
  id: StoryId;
  revision: Revision20;
  previousManifestHash: Hash256 | null;
  content: StoryManifestV5;
  summary: StorySummaryV6;
  unresolvedProvider: ProviderPointer | null;
  lastTransaction: UserTransactionPointer | null;
}

export interface DeletedStoryManifestV6 {
  format: "1667-story";
  schemaVersion: 6;
  kind: "deleted";
  id: StoryId;
  revision: Revision20;
  previousManifestHash: Hash256;
  deletedAt: TimeMs;
  unresolvedProvider: ProviderPointer | null;
  lastTransaction: PreparedUserTransactionPointer;
}

export type StoryManifestV6 = LiveStoryManifestV6 | DeletedStoryManifestV6;

export type ParsedStoryManifest =
  | {
      kind: "v5";
      manifest: StoryManifestV5;
      sourceSchemaVersion: 2 | 3 | 4 | 5;
    }
  | { kind: "v6-live"; manifest: LiveStoryManifestV6 }
  | { kind: "v6-deleted"; manifest: DeletedStoryManifestV6 };
