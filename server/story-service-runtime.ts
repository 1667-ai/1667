import path from "node:path";
import { LifecycleRetry } from "../shared/lifecycle-retry.js";
import type { ArchivedMutationOutboxRecord } from "./mutation-outbox.js";
import {
  assertNoPendingMutationIntents,
  MutationOutbox,
  storyIdFromMutationIntent
} from "./mutation-outbox.js";
import { createMutationCoordinator } from "./mutation-coordinator.js";
import { MutationReceiptStore } from "./mutation-receipts.js";
import { PromptCacheRuntime } from "./provider-cache-policy.js";
import { readDataDirectoryFormat } from "./data-directory-format.js";
import type { HttpDataDirectoryIdentity } from "./data-directory-id.js";
import { resolveDataDirectory } from "./data-directory.js";
import { GenerationAdmissionRegistry } from "./generation-admission.js";
import { PartialRewriteStash } from "./rewrite-partial.js";
import type {
  LegacyDataDirectoryLease
} from "./legacy-data-directory.js";
import { RuntimeDataDirectoryLock } from "./runtime-data-directory.js";
import { ServiceLifecycle } from "./service-lifecycle.js";
import { SettingsStore } from "./settings.js";
import { StoryCatalog } from "./story-catalog.js";
import { StorySearch } from "./story-search.js";
import { StoryCreationMutationStore } from "./story-creation-mutation.js";
import { StoryMutationStore } from "./story-mutation-store.js";
import { assertNoProjectTierSecrets } from "./project-secret-fence.js";
import { buildStoryPayload } from "./story-payload.js";
import { StoryReaper } from "./story-reaper.js";
import { StoryServiceChapters } from "./story-service-chapters.js";
import { StoryServiceGeneration } from "./story-service-generation.js";
import { StoryServiceLocal } from "./story-service-local.js";
import { StoryStore } from "./stories.js";
import { InternalErrorReporter } from "./internal-error-reporter.js";
import {
  classifyProviderAbort,
  providerAbortForError
} from "./provider-abort.js";
import {
  isProviderMutationMethod
} from "./mutation-ledger-types.js";
import { MUTATION_ID_PATTERN } from "./mutation-ledger-scalars.js";
import { isStoryId } from "./story-v5-strict.js";

interface StoryServiceCommonOptions {
  /** The machine tier holding provider secrets. Absent keeps them in place. */
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

type StoryServiceDiagnostics =
  | {
      /** Shared transport reporter; mutation receipts persist references
       * before making them durable. */
      errorReporter: InternalErrorReporter;
      diagnostics?: "enabled";
    }
  | {
      /** Explicit opt-out for isolated maintenance and test runtimes. */
      diagnostics: "disabled";
      errorReporter?: never;
    };

export type StoryServiceUndiagnosedOptions = StoryServiceCommonOptions & (
  | {
      dataDir?: string;
      legacyDataLease?: never;
    }
  | {
      dataDir?: never;
      /** Retains validated format-1 machine-local directory authority. */
      legacyDataLease: LegacyDataDirectoryLease;
      dataLock: "external";
    }
);

export type StoryServiceOptions =
  StoryServiceUndiagnosedOptions & StoryServiceDiagnostics;

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
  protected storySearch!: StorySearch;
  protected storyReaper!: StoryReaper;
  protected storyLocal!: StoryServiceLocal;
  protected storyGeneration!: StoryServiceGeneration;
  protected storyChapters!: StoryServiceChapters;

  private readonly dataLock: RuntimeDataDirectoryLock | null;
  private readonly externalMutationRecovery: boolean;
  private readonly settingsActivation: "activation-capable" | "recover-only";
  private readonly legacyDataLease: LegacyDataDirectoryLease | undefined;
  private readonly starterVault: "seed-when-new" | undefined;
  private readonly externalFreshDataDirectory: boolean;
  private readonly machineDir: string | undefined;
  private readonly active = new Set<AbortController>();
  private readonly activeOperations = new Set<Promise<unknown>>();
  private readonly archivedMutationCleanup =
    new LifecycleRetry<string>();
  private readonly generationAdmission = new GenerationAdmissionRegistry(
    (storyId, revisionIds) => this.stories.pinRevisions(storyId, revisionIds)
  );
  private readonly rewritePartials = new PartialRewriteStash();
  private readonly promptCache = new PromptCacheRuntime();
  private readonly lifecycle = new ServiceLifecycle();
  private readonly mutationCoordinator = createMutationCoordinator();
  private readonly errorReporter: InternalErrorReporter;

  constructor(options: StoryServiceOptions) {
    const dataDir = resolveDataDirectory(
      options.legacyDataLease?.dataDir ?? options.dataDir
    );
    const legacyDataLease = options.legacyDataLease;
    if (legacyDataLease !== undefined
      && legacyDataLease.dataDir !== dataDir) {
      throw new Error("Legacy data lease does not match its data directory");
    }
    const storageRoot = legacyDataLease?.authorityPath ?? dataDir;
    this.dataDir = dataDir;
    this.storageRoot = storageRoot;
    this.externalMutationRecovery = options.mutationRecovery === "external";
    this.settingsActivation = options.settingsActivation ?? "activation-capable";
    this.legacyDataLease = legacyDataLease;
    this.starterVault = options.starterVault;
    // Only an external-lock owner can observe directory creation on the
    // service's behalf. Accepting the flag alongside a service-owned lock and
    // then ignoring it would hide a wiring mistake behind a missing vault.
    if (options.freshDataDirectory !== undefined && options.dataLock !== "external") {
      throw new Error("freshDataDirectory is only meaningful with an external data lock");
    }
    this.externalFreshDataDirectory = options.freshDataDirectory === true;
    this.machineDir = options.machineDir;
    this.errorReporter = options.diagnostics === "disabled"
      ? InternalErrorReporter.disabled()
      : options.errorReporter;
    this.configureStorage(storageRoot, dataDir);
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

  /** Return the directory authority that all active storage components use. */
  get dataDirectoryAuthorityPath(): string {
    this.ensureOpen();
    return this.storageRoot;
  }

  /** Return identity retained by an external legacy lease, when present. */
  get retainedHttpDataDirectoryIdentity(): HttpDataDirectoryIdentity | null {
    this.ensureOpen();
    return this.legacyDataLease?.identity ?? null;
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
          await assertNoProjectTierSecrets(this.storageRoot, this.machineDir);
        }
        if (!this.externalMutationRecovery) {
          this.archivedMutationWarnings = await assertNoPendingMutationIntents(
            this.storageRoot
          );
        }
        const dataFormat = this.dataLock === null
          ? this.legacyDataLease?.dataFormat
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
        await this.archivedMutationCleanup.stop();
        await Promise.allSettled([...this.activeOperations]);
        this.rewritePartials.clearAll();
        await this.stories.waitForMaintenance();
        await this.storyCatalog.dispose();
        this.generationAdmission.clear();
        this.promptCache.clear();
      } finally {
        try {
          await this.dataLock?.release();
        } finally {
          await this.legacyDataLease?.release();
        }
      }
    });
  }

  /** HTTP owns its caller outbox. Embedded mode leaves this work to the main
   * thread, which owns that outbox and its serialization. */
  protected async dismissArchivedMutationWarning(
    mutationId: string,
    storyId: string
  ): Promise<void> {
    if (this.externalMutationRecovery) return;
    const warning = this.archivedProviderWarning(mutationId, storyId);
    if (warning === undefined) return;
    const outbox = new MutationOutbox(
      path.join(this.storageRoot, "mutation-outbox")
    );
    await this.archivedMutationCleanup.start(
      mutationId,
      async () => {
        await outbox.init();
        await outbox.dismissArchived(mutationId);
        this.archivedMutationWarnings =
          this.archivedMutationWarnings.filter(
            ({ intent }) => intent.mutationId !== mutationId
          );
      },
      async () => await this.reportArchivedMutationCleanupFailure(
        mutationId
      )
    );
  }

  cancelActive(): void {
    for (const controller of this.active) controller.abort();
  }

  async announceProjectServer(
    server: { readonly port: number; readonly url: string },
    signal?: AbortSignal
  ): Promise<void> {
    this.ensureOpen();
    await this.dataLock?.announceProjectServer(server, signal);
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
      const value = await operation;
      const abort = classifyProviderAbort(controller.signal);
      if (abort.kind === "uncertain") throw abort.error;
      return value;
    } catch (error) {
      const abort = providerAbortForError(controller.signal, error);
      throw abort.kind === "uncertain" ? abort.error : error;
    } finally {
      signal.removeEventListener("abort", abort);
      this.active.delete(controller);
      this.activeOperations.delete(operation);
    }
  }

  protected ensureOpen(): void {
    this.lifecycle.assertReady();
  }

  protected archivedProviderWarning(
    mutationId: string,
    storyId: string
  ): ArchivedMutationOutboxRecord | undefined {
    return this.archivedMutationWarnings.find(
      ({ intent, resolution }) =>
        intent.mutationId === mutationId
        && resolution.code === "generation_outcome_unknown"
        && isProviderMutationMethod(intent.method)
        && storyIdFromMutationIntent(intent) === storyId
    );
  }

  protected async reportProviderRecoveryFailure(
    storyId: string,
    warningMutationId: string
  ): Promise<void> {
    const identifiers = [
      ...(isStoryId(storyId) ? [`storyId=${storyId}`] : []),
      ...(MUTATION_ID_PATTERN.test(warningMutationId)
        ? [`warningMutationId=${warningMutationId}`]
        : [])
    ];
    await this.errorReporter.report(
      new Error([
        "Provider fence retirement failed.",
        ...identifiers
      ].join(" ")),
      {
        service: "provider-recovery",
        operation: "story-fence-retire"
      }
    );
  }

  protected async reportProviderFenceRedirect(
    storyId: string,
    warningMutationId: string,
    pendingProviderMutationId: string
  ): Promise<void> {
    const identifiers = [
      ...(isStoryId(storyId) ? [`storyId=${storyId}`] : []),
      ...(MUTATION_ID_PATTERN.test(warningMutationId)
        ? [`warningMutationId=${warningMutationId}`]
        : []),
      ...(MUTATION_ID_PATTERN.test(pendingProviderMutationId)
        ? [`pendingProviderMutationId=${pendingProviderMutationId}`]
        : [])
    ];
    await this.errorReporter.report(
      new Error([
        "Provider dispatch did not start because the story retained an older fence.",
        ...identifiers
      ].join(" ")),
      {
        service: "provider-recovery",
        operation: "story-fence-redirect"
      }
    );
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
      rewritePartials: this.rewritePartials,
      storyMutations: this.storyMutations,
      dataFormat: () => this.settings.dataFormat,
      ensureOpen: () => this.ensureOpen()
    });
    this.storyGeneration = new StoryServiceGeneration({
      stories: this.stories,
      settings: this.settings,
      generationAdmission: this.generationAdmission,
      rewritePartials: this.rewritePartials,
      promptCache: this.promptCache,
      storyMutations: this.storyMutations,
      ensureOpen: () => this.ensureOpen(),
      cancellable: async (signal, work) =>
        await this.cancellable(signal, work)
    });
    this.storySearch = new StorySearch(this.stories);
    this.storyChapters = new StoryServiceChapters({
      stories: this.stories,
      storyMutations: this.storyMutations,
      ensureOpen: () => this.ensureOpen(),
      dataFormat: () => this.settings.dataFormat
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
      async (id) => buildStoryPayload(await this.stories.load(id)),
      async (error) => await this.errorReporter.report(
        error,
        { service: "mutation-receipt" }
      )
    );
  }

  private async reportArchivedMutationCleanupFailure(
    mutationId: string
  ): Promise<void> {
    await this.errorReporter.report(
      new Error([
        "Archived provider warning cleanup failed.",
        ...(MUTATION_ID_PATTERN.test(mutationId)
          ? [`mutationId=${mutationId}`]
          : [])
      ].join(" ")),
      {
        service: "provider-recovery",
        operation: "warning-retire"
      }
    );
  }
}
