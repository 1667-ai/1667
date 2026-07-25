import { pathTo } from "../shared/story-tree.js";
import type { Story } from "../shared/types.js";
import { hydrateStoryNodes } from "./story-codec.js";
import {
  applyProviderStoryEffect,
  type ProviderStoryEffect,
  type ProviderStoryEffectValue
} from "./story-provider-effect.js";

export interface ProviderStoryRuntime {
  loadForMutation(id: string): Promise<Story>;
  hydratePath(story: Story, nodeId: string): Promise<void>;
  withLock<T>(id: string, work: () => Promise<T>): Promise<T>;
  save(story: Story): Promise<void>;
  commitProviderEffect<Effect extends ProviderStoryEffect>(
    id: string,
    effect: Effect
  ): Promise<ProviderStoryEffectValue<Effect>>;
}

/** StoryStore-compatible view used while the Q coordinator already owns the
 * story scope and filesystem queues. Saves mark the in-memory draft; the outer
 * receipt transaction performs the one authoritative V6 publication. */
export class ScopedProviderStoryRuntime implements ProviderStoryRuntime {
  private saved = false;
  private preparedEffect: ProviderStoryEffect | null = null;

  /** Node text hydrates from the bundle the story itself carries, so this
   * runtime outlives the aggregate session that decoded it. That lets the
   * provider round-trip run without holding story I/O against readers. */
  constructor(private readonly story: Story) {}

  get didSave(): boolean {
    return this.saved;
  }

  get effect(): ProviderStoryEffect | null {
    return this.preparedEffect;
  }

  async loadForMutation(id: string): Promise<Story> {
    this.requireStory(id);
    return this.story;
  }

  async hydratePath(story: Story, nodeId: string): Promise<void> {
    this.requireSameStory(story);
    await hydrateStoryNodes(story, pathTo(story, nodeId).map((node) => node.id));
  }

  async withLock<T>(id: string, work: () => Promise<T>): Promise<T> {
    this.requireStory(id);
    return await work();
  }

  async save(story: Story): Promise<void> {
    this.requireSameStory(story);
    this.saved = true;
  }

  async commitProviderEffect<Effect extends ProviderStoryEffect>(
    id: string,
    effect: Effect
  ): Promise<ProviderStoryEffectValue<Effect>> {
    this.requireStory(id);
    if (this.preparedEffect !== null) {
      throw new Error("Provider runtime prepared more than one story effect");
    }
    const applied = await applyProviderStoryEffect(
      this.story,
      effect,
      async (story, nodeId) => await this.hydratePath(story, nodeId)
    );
    this.preparedEffect = effect;
    this.saved = applied.changed;
    return applied.value as ProviderStoryEffectValue<Effect>;
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
