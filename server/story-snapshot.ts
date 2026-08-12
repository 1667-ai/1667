import type { Story } from "../shared/types.js";
import { isNodeTextHydrated, refreshStoredNodeText } from "./story-node-text.js";
import {
  manifestImageIds,
  manifestReasoningIds,
  manifestTokenProbabilityIds,
  StoryFormatError,
  serializeManifestContent,
  sha256,
  type ObjectHash,
  type StoryManifestV5,
  type StoryManifestV7,
  type TextRevisionV1
} from "./story-format.js";

interface SnapshotNode {
  text?: string;
  revisionId: ObjectHash;
}

/** Verified disk identity attached only to the exact hydrated Story object.
 * The manifest fingerprint prevents a stale load from reusing swept objects. */
export interface StoryRevisionSnapshot {
  manifestFingerprint: ObjectHash;
  nodes: Map<string, SnapshotNode>;
  revisions: Map<ObjectHash, TextRevisionV1>;
  /** Every take's stored token probabilities id in this manifest. The next
   *  save trusts these as durable without re-reading them when the manifest
   *  fingerprint still matches — mirrors `revisions` above, but a
   *  probabilities object has no nested chunk graph to carry, so an id set is
   *  all that is needed (`server/story-objects.ts`'s
   *  `adoptCommittedIds`). */
  probabilityIds: Set<ObjectHash>;
  /** Every take's stored reasoning id in this manifest, mirroring
   *  `probabilityIds` exactly. */
  reasoningIds: Set<ObjectHash>;
  /** Every Image Object id this manifest's nodes reference, mirroring
   *  `probabilityIds` and `reasoningIds`. A node can carry several (see
   *  `manifestImageIds`), so this is a flattened set, not a one-per-node
   *  collection. */
  imageIds: Set<ObjectHash>;
}

export function captureStorySnapshot(
  story: Story,
  manifest: StoryManifestV5 | StoryManifestV7,
  revisions: ReadonlyMap<ObjectHash, TextRevisionV1>
): StoryRevisionSnapshot {
  if (story.nodes.length !== manifest.nodes.length) throw new StoryFormatError("Snapshot node count mismatch");
  const nodes = new Map<string, SnapshotNode>();
  const graph = new Map<ObjectHash, TextRevisionV1>();
  for (const [index, node] of story.nodes.entries()) {
    const stored = manifest.nodes[index]!;
    if (node.id !== stored.id) throw new StoryFormatError(`Snapshot node mismatch: ${node.id}`);
    nodes.set(node.id, {
      ...(isNodeTextHydrated(node) && stored.syntheticEmpty !== true ? { text: node.text } : {}),
      revisionId: stored.revisionId
    });
    const revision = revisions.get(stored.revisionId);
    if (revision !== undefined) graph.set(stored.revisionId, revision);
    refreshStoredNodeText(node, stored);
  }
  return {
    manifestFingerprint: manifestFingerprint(manifest),
    nodes,
    revisions: graph,
    probabilityIds: new Set(manifestTokenProbabilityIds(manifest)),
    reasoningIds: new Set(manifestReasoningIds(manifest)),
    imageIds: new Set(manifestImageIds(manifest))
  };
}

export function isCurrentSnapshot(
  snapshot: StoryRevisionSnapshot,
  manifest: StoryManifestV5 | StoryManifestV7
): boolean {
  return snapshot.manifestFingerprint === manifestFingerprint(manifest);
}

export function reusableRevisionId(
  snapshot: StoryRevisionSnapshot | undefined,
  nodeId: string,
  text: string
): ObjectHash | undefined {
  const source = snapshot?.nodes.get(nodeId);
  return source?.text !== undefined && source.text === text ? source.revisionId : undefined;
}

function manifestFingerprint(manifest: StoryManifestV5 | StoryManifestV7): ObjectHash {
  return sha256(Buffer.from(serializeManifestContent(manifest), "utf8"));
}
