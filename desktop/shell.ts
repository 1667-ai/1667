import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type {
  AuthEvent,
  AuthInteraction,
  AuthPrompt
} from "@earendil-works/pi-ai";
import type { DesktopProjectHost } from "../host/desktop-port-bridge.js";
import type { WorkerHostOptions } from "../host/worker-host.js";
import {
  createProductionAuthDependencies,
  loginSubscription,
  logoutSubscription,
  readSubscriptionStatus,
  type SubscriptionProvider
} from "../host/launcher-auth.js";
import {
  exportProfile,
  importProfile
} from "../host/launcher-profile.js";
import { exportStories } from "../host/launcher-export.js";
import { importStoryFile } from "../host/launcher-import.js";
import {
  adoptProject,
  initializeProject
} from "../host/launcher-project.js";
import {
  decryptProjectVault,
  encryptProjectVault
} from "../host/launcher-vault.js";
import {
  isSealedVault,
  openSealedVaultWithPassword,
  revalidateSealedVault,
  revalidateUnsealedVault,
  type OpenedVault
} from "../host/launcher-vault-open.js";
import {
  resolveProject,
  type ResolvedProject
} from "../server/project-discovery.js";
import { launcherApiFromHost, type DesktopLauncherApi } from "./launcher-api.js";
import { PROJECT_DIRECTORY_NAME } from "../server/project-layout.js";
import type { DesktopUpdaterPort } from "./updater.js";
import type {
  DesktopAuthPrompt,
  DesktopDialogKind,
  DesktopProjectSnapshot,
  DesktopRecentProject,
  DesktopShellEvent,
  DesktopShellRequest,
  DesktopShellResponse,
  DesktopShellSuccess
} from "./shell-contract.js";
import type { RecentProjectsStore } from "./recent-projects.js";

export interface DesktopDialogPort {
  open(kind: DesktopDialogKind, multiple: boolean): Promise<readonly string[]>;
  save(
    kind: Exclude<DesktopDialogKind, "project" | "directory">,
    defaultPath: string | undefined
  ): Promise<string | null>;
  directory(options?: {
    readonly title?: string;
    readonly message?: string;
  }): Promise<string | null>;
}

export interface DesktopShellOptions {
  readonly registry: DesktopHostRegistryPort;
  readonly machineDir: string;
  readonly recent: RecentProjectsStore;
  readonly dialogs?: DesktopDialogPort;
  readonly reveal?: (target: string) => void;
  readonly updater?: DesktopUpdaterPort;
  readonly emit: (event: DesktopShellEvent) => void;
}

/** The small registry surface a window controller needs. */
export interface DesktopHostRegistryPort {
  openProject(id: string, options?: WorkerHostOptions): Promise<DesktopProjectHost>;
  closeProject(id: string): Promise<void>;
}

interface ActiveProject {
  readonly id: string;
  readonly project: ResolvedProject;
  readonly sealed: boolean;
  readonly openedVault?: OpenedVault;
  readonly entry?: DesktopProjectHost;
  readonly api?: DesktopLauncherApi;
}

interface PendingAuth {
  readonly controller: AbortController;
  prompt?: {
    readonly resolve: (value: string) => void;
    readonly reject: (error: Error) => void;
    readonly signalCleanup?: () => void;
  };
}

/** Main-process controller for one graphical 1667 window and project. */
export class DesktopShell {
  private active: ActiveProject | null = null;
  private readonly opening = new Map<string, Promise<DesktopProjectSnapshot>>();
  private activationTail: Promise<void> = Promise.resolve();
  private readonly auth = new Map<string, PendingAuth>();
  private readonly updater: DesktopUpdaterPort | undefined;
  private unsubscribeUpdater: (() => void) | undefined;

  constructor(private readonly options: DesktopShellOptions) {
    this.updater = options.updater;
    this.unsubscribeUpdater = this.updater?.onState((state) => {
      options.emit({ type: "updaterState", state });
    });
  }

  get activeProjectId(): string | null {
    return this.active?.entry?.id ?? null;
  }

  get currentProject(): DesktopProjectSnapshot | null {
    return this.active === null ? null : this.projectSnapshot();
  }

  /** Replay current shell state after a Renderer connects its bridge. */
  async publishCurrentState(): Promise<void> {
    if (this.active === null) {
      this.options.emit({ type: "projectChanged", project: null });
    } else {
      const project = this.projectSnapshot();
      this.options.emit({ type: "projectChanged", project });
      this.options.emit({ type: "vaultState", state: project.vault, project });
    }
    await this.publishRecentProjects();
    if (this.updater !== undefined) {
      this.options.emit({ type: "updaterState", state: this.updater.state });
    }
  }

  /** Open the project selected by startup, if one exists. */
  async start(cwd: string, explicitDataDirectory?: string): Promise<DesktopProjectSnapshot | null> {
    await this.publishRecentProjects();
    if (explicitDataDirectory !== undefined) {
      const project = await projectFromDataDirectory(explicitDataDirectory);
      return project.exists ? await this.activate(project) : null;
    }
    const outcome = await resolveProject({
      cwd: path.resolve(cwd),
      machineRoot: this.options.machineDir
    });
    if (outcome.kind === "project" && outcome.project.exists) {
      return await this.activate(outcome.project);
    }
    return null;
  }

  async dispose(): Promise<void> {
    for (const pending of this.auth.values()) pending.controller.abort();
    this.auth.clear();
    this.unsubscribeUpdater?.();
    this.unsubscribeUpdater = undefined;
    await this.closeActive();
  }

  async handle(request: DesktopShellRequest): Promise<DesktopShellResponse> {
    try {
      return { ok: true, result: await this.run(request) };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: errorCode(error),
          message: error instanceof Error ? error.message : String(error)
        }
      };
    }
  }

  private async run(request: DesktopShellRequest): Promise<DesktopShellSuccess> {
    switch (request.type) {
      case "project.create":
        return { type: "project", project: await this.activate(await initializeProject(normalizeRoot(request.root))) };
      case "project.open":
        return { type: "project", project: await this.openProject(request.root, request.global === true) };
      case "project.adopt":
        return {
          type: "project",
          project: await this.activate((await adoptProject({
            source: path.resolve(request.source),
            projectRoot: normalizeRoot(request.projectRoot),
            machineDir: this.options.machineDir
          })).project)
        };
      case "project.recent":
        return { type: "recent", projects: await this.options.recent.list() };
      case "project.reveal":
        if (this.options.reveal === undefined) throw new Error("Project reveal is unavailable.");
        this.options.reveal(path.resolve(request.path));
        return { type: "path", path: path.resolve(request.path) };
      case "dialog.open":
        return { type: "dialog", paths: await this.requireDialogs().open(request.kind, request.multiple === true) };
      case "dialog.save": {
        const selected = await this.requireDialogs().save(request.kind, request.defaultPath);
        return { type: "dialog", paths: selected === null ? [] : [selected] };
      }
      case "dialog.directory": {
        const selected = await this.requireDialogs().directory({
          ...(request.title === undefined ? {} : { title: request.title }),
          ...(request.message === undefined ? {} : { message: request.message })
        });
        return { type: "dialog", paths: selected === null ? [] : [selected] };
      }
      case "vault.unlock":
        {
          const project = await this.unlockVault(request.password);
          return { type: "vault", state: project.vault, project };
        }
      case "vault.seal":
        return { type: "vault", state: "sealed", project: await this.sealVault(request.password) };
      case "vault.unseal":
        return { type: "vault", state: "unsealed", project: await this.unsealVault(request.password) };
      case "story.import":
        return {
          type: "storyImport",
          result: await importStoryFile(this.requireApi(), path.resolve(request.file))
        };
      case "story.export":
        return {
          type: "storyExport",
          results: await exportStories({
            api: this.requireApi(),
            directory: path.resolve(request.directory),
            errorDirectory: this.activeProject().project.directory,
            storyId: request.storyId,
            all: request.all,
            format: request.format,
            force: request.force
          })
        };
      case "profile.import":
        return {
          type: "profileImport",
          result: await importProfile({
            api: this.requireApi(),
            file: path.resolve(request.file),
            profile: request.profile
          })
        };
      case "profile.export":
        return {
          type: "profileExport",
          result: await exportProfile({
            api: this.requireApi(),
            directory: path.resolve(request.directory),
            profile: request.profile,
            force: request.force
          })
        };
      case "auth.status":
        return { type: "authStatus", statuses: await this.authStatus() };
      case "auth.login":
        return { type: "authLogin", result: await this.authLogin(request.provider) };
      case "auth.logout":
        await this.authLogout(request.provider);
        return { type: "empty" };
      case "auth.promptResponse":
        this.resolveAuthPrompt(request.interactionId, request.value);
        return { type: "empty" };
      case "auth.cancel":
        this.cancelAuth(request.interactionId);
        return { type: "empty" };
      case "updater.check":
        return { type: "updater", state: await this.requireUpdater().check() };
      case "updater.channel":
        return { type: "updater", state: await this.requireUpdater().setChannel(request.channel) };
      case "updater.install":
        return { type: "updater", state: await this.requireUpdater().install() };
    }
  }

  private async openProject(root: string, global: boolean): Promise<DesktopProjectSnapshot> {
    const outcome = global
      ? await resolveProject({
          cwd: path.resolve(root),
          global: true,
          machineRoot: this.options.machineDir
        })
      : await resolveProject({ cwd: normalizeRoot(root), machineRoot: this.options.machineDir });
    if (outcome.kind === "absent") {
      throw new Error(
        `No ${PROJECT_DIRECTORY_NAME} story project in ${outcome.cwd} or any parent. `
          + "Choose Create project to initialize one here."
      );
    }
    if (!outcome.project.exists) {
      throw new Error(
        `${outcome.project.directory} is not a ${PROJECT_DIRECTORY_NAME} story project yet. `
          + "Choose Create project to initialize it."
      );
    }
    return await this.activate(outcome.project);
  }

  private activate(
    project: ResolvedProject,
    openedVault?: OpenedVault
  ): Promise<DesktopProjectSnapshot> {
    const key = path.resolve(project.directory);
    const pending = this.opening.get(key);
    if (pending !== undefined) return pending;
    const task = this.activationTail.then(() => this.activateProject(project, openedVault));
    this.activationTail = task.then(() => undefined, () => undefined);
    this.opening.set(key, task);
    void task.then(
      () => { if (this.opening.get(key) === task) this.opening.delete(key); },
      () => { if (this.opening.get(key) === task) this.opening.delete(key); }
    );
    return task;
  }

  private async activateProject(
    project: ResolvedProject,
    openedVault?: OpenedVault
  ): Promise<DesktopProjectSnapshot> {
    const previous = this.active;
    if (previous !== null
      && previous.project.directory === project.directory
      && !previous.sealed
      && openedVault === undefined) {
      return this.publishProject();
    }
    const sealed = await isSealedVault(project.directory);
    let next: ActiveProject;
    if (sealed && openedVault === undefined) {
      next = { id: project.directory, project, sealed: true };
    } else {
      const entry = await this.options.registry.openProject(project.directory, {
        dataDir: project.directory,
        machineDir: this.options.machineDir,
        ...(openedVault === undefined
          ? { beforeVaultMigration: async (directory: string) => await revalidateUnsealedVault(directory) }
          : {
              vaultKey: openedVault.key,
              beforeVaultMigration: async (directory: string) =>
                await revalidateSealedVault(directory, openedVault.keyslotBytes)
            })
      });
      next = {
        id: project.directory,
        project,
        sealed: false,
        ...(openedVault === undefined ? {} : { openedVault }),
        entry,
        api: launcherApiFromHost(entry.host)
      };
      void entry.host.failure.then((error) => {
        if (this.active?.entry === entry) this.options.emit({
          type: "hostError",
          message: error.message
        });
      });
    }
    this.active = next;
    if (previous?.entry !== undefined && previous.entry.id !== next.entry?.id) {
      await this.options.registry.closeProject(previous.entry.id);
    }
    await this.remember(project);
    return this.publishProject();
  }

  private async closeActive(publish = true): Promise<void> {
    const active = this.active;
    if (active === null) return;
    this.active = null;
    // Vault actions publish their final state so a failed password attempt
    // does not clear the Renderer drafts while the Host restarts.
    if (publish) this.options.emit({ type: "projectChanged", project: null });
    if (active.entry !== undefined) await this.options.registry.closeProject(active.entry.id);
  }

  private publishProject(): DesktopProjectSnapshot {
    const project = this.projectSnapshot();
    this.options.emit({ type: "projectChanged", project });
    this.options.emit({ type: "vaultState", state: project.vault, project });
    return project;
  }

  private projectSnapshot(): DesktopProjectSnapshot {
    const active = this.active;
    if (active === null) throw new Error("No project is open.");
    return {
      root: active.project.root,
      directory: active.project.directory,
      source: active.project.source,
      exists: true,
      vault: active.sealed || active.openedVault !== undefined ? "sealed" : "unsealed",
      open: active.entry !== undefined
    };
  }

  private async unlockVault(password: string): Promise<DesktopProjectSnapshot> {
    const active = this.activeProject();
    if (!active.sealed) throw new Error("The active project is already unsealed.");
    const opened = await openSealedVaultWithPassword(active.project.directory, password);
    if (opened === null) throw new Error("The active project is not a sealed vault.");
    return await this.activate(active.project, opened);
  }

  private async sealVault(password: string): Promise<DesktopProjectSnapshot> {
    const active = this.activeProject();
    if (active.sealed || active.entry === undefined) {
      throw new Error("The active project is already sealed or locked.");
    }
    const project = active.project;
    await this.closeActive(false);
    try {
      await encryptProjectVault(project.directory, async () => password);
    } catch (error) {
      await this.activate(project);
      throw error;
    }
    return await this.activate(project);
  }

  private async unsealVault(password: string): Promise<DesktopProjectSnapshot> {
    const active = this.activeProject();
    if (!active.sealed && active.openedVault === undefined) throw new Error("The active project is already unsealed.");
    const project = active.project;
    const openedVault = active.openedVault;
    await this.closeActive(false);
    try {
      await decryptProjectVault(project.directory, async () => password);
    } catch (error) {
      try {
        if (openedVault === undefined) {
          // The renderer already shows this locked project. Restore shell state
          // without replaying projectChanged and clearing its password draft.
          this.active = { id: project.directory, project, sealed: true };
        } else {
          await this.activate(project, openedVault);
        }
      } catch {
        // Preserve the password error if recovery cannot reopen the project.
      }
      throw error;
    }
    return await this.activate(project);
  }

  private activeProject(): ActiveProject {
    if (this.active === null) throw new Error("No project is open.");
    return this.active;
  }

  private requireApi(): DesktopLauncherApi {
    const api = this.active?.api;
    if (api === undefined) {
      throw new Error("Unlock a project before using its stories.");
    }
    return api;
  }

  private requireDialogs(): DesktopDialogPort {
    if (this.options.dialogs === undefined) throw new Error("File dialogs are unavailable.");
    return this.options.dialogs;
  }

  private requireUpdater(): DesktopUpdaterPort {
    if (this.updater === undefined) throw new Error("Updates are unavailable in this build.");
    return this.updater;
  }

  private async publishRecentProjects(): Promise<void> {
    this.options.emit({
      type: "recentProjects",
      projects: await this.options.recent.list()
    });
  }

  private async remember(project: ResolvedProject): Promise<void> {
    const projects = await this.options.recent.remember({
      root: project.root,
      directory: project.directory,
      openedAt: Date.now()
    });
    this.options.emit({ type: "recentProjects", projects });
  }

  private async authStatus(): Promise<readonly import("../host/launcher-auth.js").AuthStatus[]> {
    const statuses = await readSubscriptionStatus(
      await createProductionAuthDependencies("status")
    );
    this.options.emit({ type: "authState", statuses });
    return statuses;
  }

  private async authLogin(provider: SubscriptionProvider): Promise<import("../host/launcher-auth.js").AuthLoginResult> {
    const interactionId = randomUUID();
    const controller = new AbortController();
    this.auth.set(interactionId, { controller });
    const interaction: AuthInteraction = {
      signal: controller.signal,
      prompt: (prompt) => this.promptAuth(interactionId, prompt),
      notify: (event) => this.options.emit({ type: "authEvent", interactionId, event })
    };
    try {
      const result = await loginSubscription({
        provider,
        dependencies: await createProductionAuthDependencies("login"),
        confirm: async () => await this.confirmAuth(interaction),
        interaction
      });
      await this.authStatus();
      return result;
    } finally {
      const pending = this.auth.get(interactionId);
      pending?.prompt?.reject(abortError("Sign-in prompt cancelled"));
      this.auth.delete(interactionId);
    }
  }

  private async authLogout(provider: SubscriptionProvider): Promise<void> {
    await logoutSubscription(
      provider,
      await createProductionAuthDependencies("logout")
    );
    await this.authStatus();
  }

  private promptAuth(interactionId: string, prompt: AuthPrompt): Promise<string> {
    const interaction = this.auth.get(interactionId);
    if (interaction === undefined) return Promise.reject(abortError("Sign-in prompt cancelled"));
    interaction.prompt?.reject(abortError("Sign-in prompt cancelled"));
    const sanitized = stripPromptSignal(prompt);
    return new Promise<string>((resolve, reject) => {
      const signal = prompt.signal;
      const abort = (): void => {
        cleanup();
        reject(abortError("Sign-in prompt cancelled"));
      };
      const cleanup = (): void => {
        signal?.removeEventListener("abort", abort);
        if (interaction.prompt?.resolve === resolve) interaction.prompt = undefined;
      };
      interaction.prompt = { resolve, reject, signalCleanup: cleanup };
      signal?.addEventListener("abort", abort, { once: true });
      this.options.emit({ type: "authPrompt", interactionId, prompt: sanitized });
    });
  }

  private async confirmAuth(interaction: AuthInteraction): Promise<boolean> {
    const answer = await interaction.prompt({
      type: "select",
      message: "Continue with subscription sign-in?",
      options: [
        { id: "yes", label: "Yes" },
        { id: "no", label: "No" }
      ]
    });
    return answer.trim().toLowerCase() === "yes"
      || answer.trim().toLowerCase() === "y";
  }

  private resolveAuthPrompt(interactionId: string, value: string): void {
    const interaction = this.auth.get(interactionId);
    const prompt = interaction?.prompt;
    if (prompt === undefined) throw new Error("No sign-in prompt is waiting for a response.");
    prompt.signalCleanup?.();
    interaction!.prompt = undefined;
    prompt.resolve(value);
  }

  private cancelAuth(interactionId: string): void {
    const interaction = this.auth.get(interactionId);
    if (interaction === undefined) return;
    interaction.prompt?.reject(abortError("Sign-in prompt cancelled"));
    interaction.controller.abort();
    this.auth.delete(interactionId);
  }
}

function normalizeRoot(value: string): string {
  const absolute = path.resolve(value);
  return path.basename(absolute) === PROJECT_DIRECTORY_NAME
    ? path.dirname(absolute)
    : absolute;
}

async function projectFromDataDirectory(dataDirectory: string): Promise<ResolvedProject> {
  const directory = path.resolve(dataDirectory);
  const exists = await stat(directory).then((info) => info.isDirectory()).catch(() => false);
  const canonical = exists ? await realpath(directory) : directory;
  const root = path.basename(directory) === PROJECT_DIRECTORY_NAME
    ? path.dirname(directory)
    : path.dirname(directory);
  return {
    root,
    directory: canonical,
    source: "explicit",
    exists
  };
}

function stripPromptSignal(prompt: AuthPrompt): DesktopAuthPrompt {
  const { signal: _signal, ...safe } = prompt;
  return safe;
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function errorCode(error: unknown): string {
  if (error !== null && typeof error === "object" && "code" in error
    && typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return "desktop_error";
}
