import { pathTo } from "../shared/story-tree.js";
import type { Story } from "../shared/types.js";
import { hydrateStoryNodes } from "./story-codec.js";
import {
  applyProviderStoryEffect,
  type ProviderStoryEffect,
  type ProviderStoryEffectByMethod,
  type ProviderStoryEffectValue
} from "./story-provider-effect.js";
import type { ProviderMutationMethod } from "./mutation-ledger-types.js";
import {
  prepareProviderStoryEffect,
  type PreparedProviderStoryEffect
} from "./story-provider-preparation.js";

export interface ProviderStoryRuntime<
  Method extends ProviderMutationMethod = ProviderMutationMethod
> {
  loadForMutation(id: string): Promise<Story>;
  hydratePath(story: Story, nodeId: string): Promise<void>;
  commitProviderEffect<Effect extends ProviderStoryEffectByMethod[Method]>(
    id: string,
    effect: Effect
  ): Promise<ProviderStoryEffectValue<Effect>>;
  /** Record the ordered Image Object ids the request being prepared is
   *  about to send, and the Draft Lease ids that resolved them, before the
   *  provider sees any bytes. `continueStory` (server/generation-http.ts)
   *  calls this once it has resolved the active prompt's Image Attachments,
   *  ahead of `providerStarted`, so `server/story-provider-mutation.ts` can
   *  read them back: the object ids go on the durable provider-started
   *  receipt (settled decision D7) and pin the objects for the round trip;
   *  the lease ids are what the SAME commit removes once the manifest and
   *  receipt are durable, never before (rollout plan). `leaseIds` is empty
   *  whenever every attachment was inherited from an existing take rather
   *  than newly drafted: an inherited attachment consumes no lease.
   *  Optional: only `continueStory` ever has images to declare, and a
   *  caller with none simply never calls this. */
  declareImageResolution?(objectIds: readonly string[], leaseIds: readonly string[]): void;
}

/** Typed provider view used outside a story claim. The outer receipt
 * transaction performs the one authoritative V6 publication. */
export class ScopedProviderStoryRuntime implements ProviderStoryRuntime {
  private preparedEffect: PreparedProviderStoryEffect | null = null;
  private declaredImageObjectIds: readonly string[] = [];
  private declaredDraftLeaseIds: readonly string[] = [];

  /** Node text hydrates from the bundle the story itself carries, so this
   * runtime outlives the aggregate session that decoded it. That lets the
   * provider round-trip run without holding story I/O against readers. */
  constructor(private readonly story: Story) {}

  get effect(): PreparedProviderStoryEffect | null {
    return this.preparedEffect;
  }

  /** See `ProviderStoryRuntime.declareImageResolution`. */
  get imageObjectIds(): readonly string[] {
    return this.declaredImageObjectIds;
  }

  /** See `ProviderStoryRuntime.declareImageResolution`. */
  get draftLeaseIds(): readonly string[] {
    return this.declaredDraftLeaseIds;
  }

  declareImageResolution(objectIds: readonly string[], leaseIds: readonly string[]): void {
    this.declaredImageObjectIds = objectIds;
    this.declaredDraftLeaseIds = leaseIds;
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
    const prepared = prepareProviderStoryEffect(effect);
    const applied = await applyProviderStoryEffect(
      this.story,
      prepared,
      async (story, nodeId) => await this.hydratePath(story, nodeId)
    );
    this.preparedEffect = prepared;
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
