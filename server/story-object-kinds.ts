import type { ObjectHash } from "./story-format.js";

/** Object kinds that contain one bounded value and no nested graph. */
export const LEAF_OBJECT_KINDS = [
  "probabilities",
  "reasoning",
  "images",
  "aside",
  "fact-consistency"
] as const;
export type LeafObjectKind = typeof LEAF_OBJECT_KINDS[number];

export const LEAF_LIVE_ID_LABELS: Record<LeafObjectKind, string> = {
  probabilities: "live token probabilities id",
  reasoning: "live reasoning id",
  images: "live image id",
  aside: "live aside document id",
  "fact-consistency": "live fact consistency run id"
};

/** Every hash a save must protect from a concurrent sweep. */
export interface LiveStoryObjectIds {
  readonly revisions: readonly ObjectHash[];
  readonly leaves: Readonly<Record<LeafObjectKind, readonly ObjectHash[]>>;
  readonly generationRecords: readonly ObjectHash[];
}
