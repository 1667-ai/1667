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
  commitProviderEffect<Effect extends ProviderStoryEffect>(
    id: string,
    effect: Effect
  ): Promise<ProviderStoryEffectValue<Effect>>;
}

/** Typed provider view used outside a story claim. The outer receipt
 * transaction performs the one authoritative V6 publication. */
export class ScopedProviderStoryRuntime implements ProviderStoryRuntime {
  private preparedEffect: ProviderStoryEffect | null = null;

  /** Node text hydrates from the bundle the story itself carries, so this
   * runtime outlives the aggregate session that decoded it. That lets the
   * provider round-trip run without holding story I/O against readers. */
  constructor(private readonly story: Story) {}

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
    return applied.value;
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
