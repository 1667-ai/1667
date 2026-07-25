import type { Story } from "../shared/types.js";
import { isNodeTextHydrated, refreshStoredNodeText } from "./story-node-text.js";
import {
  StoryFormatError,
  serializeManifest,
  sha256,
  type ObjectHash,
  type StoryManifestV5,
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
}

export function captureStorySnapshot(
  story: Story,
  manifest: StoryManifestV5,
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
  return { manifestFingerprint: manifestFingerprint(manifest), nodes, revisions: graph };
}

export function isCurrentSnapshot(snapshot: StoryRevisionSnapshot, manifest: StoryManifestV5): boolean {
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

function manifestFingerprint(manifest: StoryManifestV5): ObjectHash {
  return sha256(Buffer.from(serializeManifest(manifest), "utf8"));
}
