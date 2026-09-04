import { pathTo } from "../shared/story-tree.js";
import type { Story } from "../shared/types.js";
import type { AsideAnchor } from "../shared/aside-session.js";
import type { StoryEnvelopeManifest } from "./story-v6-types.js";
import { hydrateStoryNodes } from "./story-codec.js";
import {
  applyProviderStoryEffect,
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
  /** Declare the v2 session identity before provider bytes are sent. */
  declareAsideSessionResolution?(
    sessionId: string,
    documentId: string | null,
    anchor: AsideAnchor | null
  ): void;
  /** The admitted manifest, available to v2 pre-provider size checks. */
  readonly asideManifest?: StoryEnvelopeManifest;
  /** Mutation id used by the terminal prepared pointer in that projection. */
  readonly asideMutationId?: string;
}

/** Typed provider view used outside a story claim. The outer receipt
 * transaction performs the one authoritative V6 publication. */
export class ScopedProviderStoryRuntime<
  Method extends ProviderMutationMethod = ProviderMutationMethod
> implements ProviderStoryRuntime<Method> {
  private preparedEffect: PreparedProviderStoryEffect<ProviderStoryEffectByMethod[Method]> | null = null;
  private declaredImageObjectIds: readonly string[] = [];
  private declaredDraftLeaseIds: readonly string[] = [];
  private declaredAsideSessionResolution: {
    readonly sessionId: string;
    readonly documentId: string | null;
    readonly anchor: AsideAnchor | null;
  } | null = null;

  /** Node text hydrates from the bundle the story itself carries, so this
   * runtime outlives the aggregate session that decoded it. That lets the
   * provider round-trip run without holding story I/O against readers. */
  constructor(
    private readonly story: Story,
    readonly asideManifest?: StoryEnvelopeManifest,
    readonly asideMutationId?: string
  ) {}

  get effect(): PreparedProviderStoryEffect<ProviderStoryEffectByMethod[Method]> | null {
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

  get asideSessionResolution(): {
    readonly sessionId: string;
    readonly documentId: string | null;
    readonly anchor: AsideAnchor | null;
  } | null {
    return this.declaredAsideSessionResolution;
  }

  declareImageResolution(objectIds: readonly string[], leaseIds: readonly string[]): void {
    this.declaredImageObjectIds = objectIds;
    this.declaredDraftLeaseIds = leaseIds;
  }

  declareAsideSessionResolution(
    sessionId: string,
    documentId: string | null,
    anchor: AsideAnchor | null
  ): void {
    if (this.declaredAsideSessionResolution !== null
      && this.declaredAsideSessionResolution.sessionId !== sessionId) {
      throw new Error("Provider runtime prepared more than one Aside session");
    }
    this.declaredAsideSessionResolution = {
      sessionId,
      documentId,
      anchor: anchor === null ? null : { ...anchor }
    };
  }

  async loadForMutation(id: string): Promise<Story> {
    this.requireStory(id);
    return this.story;
  }

  async hydratePath(story: Story, nodeId: string): Promise<void> {
    this.requireSameStory(story);
    await hydrateStoryNodes(story, pathTo(story, nodeId).map((node) => node.id));
  }

  async commitProviderEffect<Effect extends ProviderStoryEffectByMethod[Method]>(
    id: string,
    effect: Effect
  ): Promise<ProviderStoryEffectValue<Effect>> {
    const prepared = prepareProviderStoryEffect(effect);
    return await this.commitPreparedProviderEffect(id, prepared);
  }

  async commitPreparedProviderEffect<Effect extends ProviderStoryEffectByMethod[Method]>(
    id: string,
    effect: PreparedProviderStoryEffect<Effect>
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
