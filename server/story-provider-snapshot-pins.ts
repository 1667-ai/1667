import {
  LEAF_OBJECT_KINDS,
  type LeafObjectKind,
  type LiveStoryObjectIds,
  type ObjectKind
} from "./story-objects.js";
import type { ObjectHash } from "./story-format.js";

/** One story's provider-snapshot pins, kept apart by object kind — mixing
 * them would protect a revision hash from the probabilities sweep pass (or
 * vice versa), silently defeating the pin. Shaped like StoryObjectStore's own
 * per-kind collections (server/story-objects.ts) for the same reason: only
 * `revisions` and the `LEAF_OBJECT_KINDS` are ever populated
 * (`LiveStoryObjectIds` has no `chunks`), but sharing the kind-generic shape
 * lets `addLivePins` and `releaseLivePins` below run as one loop each instead
 * of one call per kind. */
export type ProviderSnapshotPins = Record<ObjectKind, Map<ObjectHash, number>>;

export function emptyProviderSnapshotPins(): ProviderSnapshotPins {
  return {
    chunks: new Map(),
    revisions: new Map(),
    probabilities: new Map(),
    reasoning: new Map(),
    images: new Map(),
    "generation-records": new Map(),
    aside: new Map(),
    "fact-consistency": new Map()
  };
}

/** Deduplicated per-kind copy of one `LiveStoryObjectIds`, taken once so a
 * pin's later release matches the exact ids it added (`pinProviderSnapshot`
 * in server/stories.ts), never a freshly recomputed live set. Generation
 * Records are never read mid-flight during provider preparation — a record's
 * own object is only created and stored at commit time — so, unlike
 * revisions and the leaf kinds, there is nothing for an in-flight pin to
 * protect for them; the normal current-manifest sweep already keeps a
 * committed record (and, per its own mark phase, any revision it references)
 * live for as long as any node still points at it. The deduped
 * `generationRecords` list is carried here only to satisfy
 * `LiveStoryObjectIds`' shape, not because `addLivePins` ever pins it. */
export function dedupeLiveObjectIds(live: LiveStoryObjectIds): LiveStoryObjectIds {
  const leaves = {} as Record<LeafObjectKind, readonly ObjectHash[]>;
  for (const kind of LEAF_OBJECT_KINDS) leaves[kind] = [...new Set(live.leaves[kind])];
  return {
    revisions: [...new Set(live.revisions)],
    leaves,
    generationRecords: [...new Set(live.generationRecords)]
  };
}

export function addLivePins(pins: ProviderSnapshotPins, live: LiveStoryObjectIds): void {
  addPins(pins.revisions, live.revisions);
  for (const kind of LEAF_OBJECT_KINDS) addPins(pins[kind], live.leaves[kind]);
}

export function releaseLivePins(pins: ProviderSnapshotPins, live: LiveStoryObjectIds): void {
  releasePins(pins.revisions, live.revisions);
  for (const kind of LEAF_OBJECT_KINDS) releasePins(pins[kind], live.leaves[kind]);
}

/** The union a sweep must protect: everything live, everything a provider
 * snapshot still has pinned (`runCleanup` in server/stories.ts), and every
 * Image Object a live Draft Lease references but no manifest node names yet
 * (`runCleanup` passes that story's lease-sourced ids as `liveImageIds`).
 * This is the one place "an object is live when the manifest names it or a
 * lease does" is decided; `StoryObjectStore.sweep` itself is kind-generic
 * and knows nothing about leases. Generation Records are never pinned (see
 * `dedupeLiveObjectIds`), so `live`'s own list passes through unchanged. */
export function unionLiveWithPins(
  live: LiveStoryObjectIds,
  pinned: ProviderSnapshotPins,
  liveImageIds: readonly ObjectHash[] = []
): LiveStoryObjectIds {
  const leaves = {} as Record<LeafObjectKind, readonly ObjectHash[]>;
  for (const kind of LEAF_OBJECT_KINDS) {
    const leaseIds = kind === "images" ? liveImageIds : [];
    leaves[kind] = [...new Set([...live.leaves[kind], ...pinned[kind].keys(), ...leaseIds])];
  }
  return {
    revisions: [...new Set([...live.revisions, ...pinned.revisions.keys()])],
    leaves,
    generationRecords: live.generationRecords
  };
}

export function addPins(pins: Map<ObjectHash, number>, ids: readonly ObjectHash[]): void {
  for (const id of ids) pins.set(id, (pins.get(id) ?? 0) + 1);
}

export function releasePins(pins: Map<ObjectHash, number>, ids: readonly ObjectHash[]): void {
  for (const id of ids) {
    const count = pins.get(id);
    if (count === undefined || count <= 1) pins.delete(id);
    else pins.set(id, count - 1);
  }
}
