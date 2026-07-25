import path from "node:path";
import type { ArchivedMutationOutboxRecord } from "./mutation-outbox.js";
import { assertNoPendingMutationIntents } from "./mutation-outbox.js";
import { createMutationCoordinator } from "./mutation-coordinator.js";
import { MutationReceiptStore } from "./mutation-receipts.js";
import { PromptCacheRuntime } from "./provider-cache-policy.js";
import { readDataDirectoryFormat } from "./data-directory-format.js";
import { resolveDataDirectory } from "./data-directory.js";
import { GenerationAdmissionRegistry } from "./generation-admission.js";
import type { ValidatedLegacyV1DataDirectory } from "./legacy-data-directory.js";
import { RuntimeDataDirectoryLock } from "./runtime-data-directory.js";
import { ServiceLifecycle } from "./service-lifecycle.js";
import { SettingsStore } from "./settings.js";
import { StoryCatalog } from "./story-catalog.js";
import { StoryCreationMutationStore } from "./story-creation-mutation.js";
import { StoryMutationStore } from "./story-mutation-store.js";
import { assertNoProjectTierSecrets } from "./project-secret-fence.js";
import { buildStoryPayload } from "./story-payload.js";
import { StoryReaper } from "./story-reaper.js";
import { StoryServiceChapters } from "./story-service-chapters.js";
import { StoryServiceGeneration } from "./story-service-generation.js";
import { StoryServiceLocal } from "./story-service-local.js";
import { StoryStore } from "./stories.js";

interface StoryServiceCommonOptions {
  /** ADR007 machine tier holding provider secrets. Absent keeps them in place. */
  machineDir?: string;
  /** Embedded workers use a lock retained by their main-thread bootstrap. */
  dataLock?: "service" | "external";
  /** Embedded main owns outbox replay before it admits new worker mutations. */
  mutationRecovery?: "refuse" | "external";
  /** Maintenance recovers interrupted activation but never begins staged work. */
  settingsActivation?: "activation-capable" | "recover-only";
  /** Interactive entry points fill a directory this run created with the
   * starter stories. Maintenance CLIs leave a fresh directory empty. */
  starterVault?: "seed-when-new";
  /** External-lock owners report the freshness their own lock observed; a
   * service-owned lock answers for itself. */
  freshDataDirectory?: boolean;
}

export type StoryServiceOptions = StoryServiceCommonOptions & (
  | {
      dataDir?: string;
      legacyData?: never;
    }
  | {
      dataDir?: never;
      /** Only the legacy validator can produce this format-1 admission. */
      legacyData: ValidatedLegacyV1DataDirectory;
      dataLock: "external";
    }
);

/** Lifecycle and storage wiring shared by the transport-neutral service facade. */
export abstract class StoryServiceRuntime {
  dataDir: string;
  private storageRoot: string;
  archivedMutationWarnings: readonly ArchivedMutationOutboxRecord[] = [];
  stories!: StoryStore;
  settings!: SettingsStore;
  protected mutationReceipts!: MutationReceiptStore;
  protected storyMutations!: StoryMutationStore;
  protected storyCreations!: StoryCreationMutationStore;
  protected storyCatalog!: StoryCatalog;
  protected storyReaper!: StoryReaper;
  protected storyLocal!: StoryServiceLocal;
  protected storyGeneration!: StoryServiceGeneration;
  protected storyChapters!: StoryServiceChapters;

  private readonly dataLock: RuntimeDataDirectoryLock | null;
  private readonly externalMutationRecovery: boolean;
  private readonly settingsActivation: "activation-capable" | "recover-only";
  private readonly legacyData: ValidatedLegacyV1DataDirectory | undefined;
  private readonly starterVault: "seed-when-new" | undefined;
  private readonly externalFreshDataDirectory: boolean;
  private readonly machineDir: string | undefined;
  private readonly active = new Set<AbortController>();
  private readonly activeOperations = new Set<Promise<unknown>>();
  private readonly generationAdmission = new GenerationAdmissionRegistry();
  private readonly promptCache = new PromptCacheRuntime();
  private readonly lifecycle = new ServiceLifecycle();
  private readonly mutationCoordinator = createMutationCoordinator();

  constructor(options: StoryServiceOptions = {}) {
    const dataDir = resolveDataDirectory(
      options.legacyData?.dataDir ?? options.dataDir
    );
    this.dataDir = dataDir;
    this.storageRoot = dataDir;
    this.externalMutationRecovery = options.mutationRecovery === "external";
    this.settingsActivation = options.settingsActivation ?? "activation-capable";
    this.legacyData = options.legacyData;
    this.starterVault = options.starterVault;
    // Only an external-lock owner can observe directory creation on the
    // service's behalf. Accepting the flag alongside a service-owned lock and
    // then ignoring it would hide a wiring mistake behind a missing vault.
    if (options.freshDataDirectory !== undefined && options.dataLock !== "external") {
      throw new Error("freshDataDirectory is only meaningful with an external data lock");
    }
    this.externalFreshDataDirectory = options.freshDataDirectory === true;
    this.machineDir = options.machineDir;
    this.configureStorage(dataDir, dataDir);
    this.dataLock = options.dataLock === "external"
      ? null
      : new RuntimeDataDirectoryLock(dataDir);
  }

  /** Whether this run should write the starter stories. Only ever true for an
   * opted-in entry point opening a directory that did not exist a moment ago,
   * so deleting the starter stories keeps them deleted. */
  protected get shouldSeedStarterVault(): boolean {
    if (this.starterVault !== "seed-when-new") return false;
    return this.dataLock === null
      ? this.externalFreshDataDirectory
      : this.dataLock.initializedNewDirectory;
  }

  async init(): Promise<void> {
    await this.lifecycle.init(async () => {
      try {
        const canonicalDir = this.dataLock === null
          ? undefined
          : await this.dataLock.acquire();
        if (canonicalDir !== undefined) {
          this.configureStorage(this.dataLock!.authorityPath, canonicalDir);
        }
        if (this.machineDir !== undefined) {
          await assertNoProjectTierSecrets(this.dataDir, this.machineDir);
        }
        if (!this.externalMutationRecovery) {
          this.archivedMutationWarnings = await assertNoPendingMutationIntents(
            this.storageRoot
          );
        }
        const dataFormat = this.dataLock === null
          ? this.legacyData?.dataFormat
            ?? await readDataDirectoryFormat(this.storageRoot)
          : this.dataLock.dataFormat;
        await this.settings.init(dataFormat);
        await this.stories.init();
        if (dataFormat === 2) {
          await this.storyMutations.init();
          await this.storyCreations.init();
        }
        await this.mutationReceipts.init();
      } catch (error) {
        await this.stories.waitForMaintenance();
        await this.dataLock?.release();
        throw error;
      }
    });
  }

  async dispose(): Promise<void> {
    await this.lifecycle.dispose(async () => {
      this.cancelActive();
      try {
        await Promise.allSettled([...this.activeOperations]);
        await this.stories.waitForMaintenance();
        await this.storyCatalog.dispose();
        this.generationAdmission.clear();
        this.promptCache.clear();
      } finally {
        await this.dataLock?.release();
      }
    });
  }

  cancelActive(): void {
    for (const controller of this.active) controller.abort();
  }

  protected async cancellable<T>(
    signal: AbortSignal,
    work: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    this.ensureOpen();
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", abort, { once: true });
    this.active.add(controller);
    const operation = Promise.resolve().then(() => work(controller.signal));
    this.activeOperations.add(operation);
    try {
      return await operation;
    } finally {
      signal.removeEventListener("abort", abort);
      this.active.delete(controller);
      this.activeOperations.delete(operation);
    }
  }

  protected ensureOpen(): void {
    this.lifecycle.assertReady();
  }

  private configureStorage(storageRoot: string, displayPath: string): void {
    this.dataDir = displayPath;
    this.storageRoot = storageRoot;
    this.stories = new StoryStore(path.join(storageRoot, "stories"));
    this.settings = new SettingsStore(storageRoot, {
      activationMode: this.settingsActivation,
      coordinator: this.mutationCoordinator,
      ...(this.machineDir === undefined ? {} : { secretsDir: this.machineDir })
    });
    this.storyMutations = new StoryMutationStore(
      this.stories,
      this.mutationCoordinator,
      storageRoot
    );
    this.storyCreations = new StoryCreationMutationStore(
      this.stories,
      this.mutationCoordinator,
      storageRoot
    );
    this.storyLocal = new StoryServiceLocal({
      stories: this.stories,
      settings: this.settings,
      generationAdmission: this.generationAdmission,
      storyMutations: this.storyMutations,
      ensureOpen: () => this.ensureOpen()
    });
    this.storyGeneration = new StoryServiceGeneration({
      stories: this.stories,
      settings: this.settings,
      generationAdmission: this.generationAdmission,
      promptCache: this.promptCache,
      storyMutations: this.storyMutations,
      ensureOpen: () => this.ensureOpen(),
      cancellable: async (signal, work) =>
        await this.cancellable(signal, work)
    });
    this.storyChapters = new StoryServiceChapters({
      stories: this.stories,
      storyMutations: this.storyMutations,
      ensureOpen: () => this.ensureOpen()
    });
    this.storyReaper = new StoryReaper(storageRoot, this.mutationCoordinator);
    this.storyCatalog = new StoryCatalog(storageRoot, {
      recoverResidue: async (kind, storyId) => {
        if (kind === "create") {
          await this.storyCreations.recoverResidue(storyId);
        } else {
          await this.storyReaper.reapIfEligible(storyId);
        }
      },
      reapDeleted: async (storyId) =>
        await this.storyReaper.reapIfEligible(storyId),
      maintainStory: async (storyId) =>
        await this.stories.schedulePendingCleanup(storyId)
    });
    this.mutationReceipts = new MutationReceiptStore(
      path.join(storageRoot, "mutation-receipts"),
      async (id) => buildStoryPayload(await this.stories.load(id))
    );
  }
}
