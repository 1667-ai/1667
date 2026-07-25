import { activePath } from "../shared/story-tree.js";
import type { Story, StoryNode } from "../shared/types.js";
import { ServiceError } from "./errors.js";
import type { StoryAggregateSession } from "./story-aggregate-session.js";
import {
  createInactiveTakeFromCut,
  createTake,
  newNode
} from "./story-nodes.js";
import {
  requireSummaryActive,
  summarizedPath,
  summarySourceFingerprint,
  type SummaryCommitIds,
  type SummaryPoint
} from "./summary-take.js";

export interface ProviderStoryRuntime {
  loadForMutation(id: string): Promise<Story>;
  hydratePath(story: Story, nodeId: string): Promise<void>;
  withLock<T>(id: string, work: () => Promise<T>): Promise<T>;
  save(story: Story): Promise<void>;
  commitSummary(
    id: string,
    point: SummaryPoint,
    expected: string | null,
    sourceFingerprint: string,
    summary: string,
    model: string,
    instruction: string,
    cancelled?: AbortSignal,
    commitIds?: SummaryCommitIds
  ): Promise<StoryNode>;
}

/** StoryStore-compatible view used while the Q coordinator already owns the
 * story scope and filesystem queues. Saves mark the in-memory draft; the outer
 * receipt transaction performs the one authoritative V6 publication. */
export class ScopedProviderStoryRuntime implements ProviderStoryRuntime {
  private saved = false;

  constructor(
    private readonly story: Story,
    private readonly session: StoryAggregateSession
  ) {}

  get didSave(): boolean {
    return this.saved;
  }

  async loadForMutation(id: string): Promise<Story> {
    this.requireStory(id);
    return this.story;
  }

  async hydratePath(story: Story, nodeId: string): Promise<void> {
    this.requireSameStory(story);
    await this.session.hydratePath(story, nodeId);
  }

  async withLock<T>(id: string, work: () => Promise<T>): Promise<T> {
    this.requireStory(id);
    return await work();
  }

  async save(story: Story): Promise<void> {
    this.requireSameStory(story);
    this.saved = true;
  }

  async commitSummary(
    id: string,
    point: SummaryPoint,
    expected: string | null,
    sourceFingerprint: string,
    summary: string,
    model: string,
    instruction: string,
    cancelled?: AbortSignal,
    commitIds: SummaryCommitIds = {}
  ): Promise<StoryNode> {
    this.requireStory(id);
    const existing = commitIds.summaryNodeId === undefined
      ? undefined
      : this.story.nodes.find((node) => node.id === commitIds.summaryNodeId);
    if (existing !== undefined) return existing;
    requireSummaryActive(cancelled);
    await this.session.hydratePath(this.story, point.nodeId);
    requireSummaryActive(cancelled);
    const prefix = summarizedPath(this.story, point, expected);
    if (summarySourceFingerprint(this.story.title, prefix, point) !== sourceFingerprint) {
      throw new ServiceError(
        409,
        "The story changed while its summary was being written. Try again."
      );
    }
    const parentId = point.offset === null
      ? point.nodeId
      : createInactiveTakeFromCut(
        this.story,
        point.nodeId,
        point.offset,
        expected,
        commitIds.cutNodeId
      ).id;
    const node = newNode(parentId, instruction, summary, model, {
      role: "summary",
      ...(commitIds.summaryNodeId === undefined
        ? {}
        : { id: commitIds.summaryNodeId })
    });
    createTake(this.story, node, { activate: false });
    this.saved = true;
    return node;
  }

  private requireStory(id: string): void {
    if (id !== this.story.id) {
      throw new Error("Provider runtime crossed story aggregates");
    }
  }

  private requireSameStory(story: Story): void {
    if (story !== this.story) {
      throw new Error("Provider runtime received a foreign story draft");
    }
  }
}
