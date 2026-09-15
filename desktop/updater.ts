/// <reference path="./electron-updater.d.ts" />

import type { DesktopUpdaterState } from "./shell-contract.js";
import type { DesktopUpdateChannel } from "./update-channel.js";

export const DESKTOP_UPDATE_FEED_URL = "https://1667.ai/electron-updater/";
export const DESKTOP_RELEASE_TAG_URL = "https://github.com/1667-ai/1667/releases/tag/";

export interface ElectronUpdaterLike {
  channel: string | null;
  allowDowngrade: boolean;
  allowPrerelease: boolean;
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  setFeedURL(options: { provider: "generic"; url: string }): void;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<readonly string[]>;
  quitAndInstall(): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
  removeListener(event: string, listener: (...args: unknown[]) => void): void;
}

export interface DesktopUpdaterPort {
  readonly state: DesktopUpdaterState;
  onState(listener: (state: DesktopUpdaterState) => void): () => void;
  setChannel(channel: "stable" | "beta"): Promise<DesktopUpdaterState>;
  check(): Promise<DesktopUpdaterState>;
  install(): Promise<DesktopUpdaterState>;
  dispose(): void;
}

export interface ElectronUpdaterOptions {
  /** Override the host platform in integration tests. */
  readonly platform?: NodeJS.Platform;
  readonly initialChannel?: DesktopUpdateChannel;
  readonly saveChannel?: (channel: DesktopUpdateChannel) => Promise<void>;
  /** Open the trusted release page for manual Mac updates. */
  readonly openExternal?: (url: string) => Promise<void>;
  /** Ask the host to approve all renderer windows before the installer runs. */
  readonly beforeInstall?: () => Promise<boolean>;
  /** Release a host-side install guard when approval or installation fails. */
  readonly onInstallAborted?: () => void;
}

const BUSY_UPDATE_STATES = new Set<DesktopUpdaterState["state"]>([
  "checking",
  "available",
  "downloading",
  "downloaded"
]);

/** Electron's generic feed owns metadata only. Assets stay on GitHub. */
export class ElectronUpdater implements DesktopUpdaterPort {
  private current: DesktopUpdaterState = {
    channel: "stable",
    manual: false,
    state: "idle",
    version: null,
    message: null
  };
  private readonly listeners = new Set<(state: DesktopUpdaterState) => void>();
  private readonly handlers: Array<readonly [string, (...args: unknown[]) => void]>;

  private readonly saveChannel: ((channel: DesktopUpdateChannel) => Promise<void>) | undefined;
  private readonly beforeInstall: (() => Promise<boolean>) | undefined;
  private readonly onInstallAborted: (() => void) | undefined;
  private readonly manualMac: boolean;
  private readonly openExternal: ((url: string) => Promise<void>) | undefined;
  private channelChange: Promise<void> = Promise.resolve();

  constructor(
    private readonly updater: ElectronUpdaterLike,
    options: ElectronUpdaterOptions = {}
  ) {
    this.manualMac = (options.platform ?? process.platform) === "darwin";
    this.openExternal = options.openExternal;
    this.saveChannel = options.saveChannel;
    this.beforeInstall = options.beforeInstall;
    this.onInstallAborted = options.onInstallAborted;
    this.configureChannel(options.initialChannel ?? "stable");
    this.handlers = [
      ["checking-for-update", () => this.publish({ state: "checking" })],
      ["update-available", (info) => this.publish({
        state: "available",
        version: versionFrom(info),
        message: null
      })],
      ["update-not-available", (info) => this.publish({
        state: "not-available",
        version: versionFrom(info),
        message: null
      })],
      ["download-progress", (info) => this.publish({
        state: "downloading",
        version: this.current.version,
        message: progressMessage(info)
      })],
      ["update-downloaded", (info) => this.publish({
        state: "downloaded",
        version: versionFrom(info),
        message: null
      })],
      ["error", (error) => this.publish({
        state: "error",
        message: error instanceof Error ? error.message : String(error)
      })]
    ];
    for (const [event, handler] of this.handlers) updater.on(event, handler);
  }

  get state(): DesktopUpdaterState {
    return this.current;
  }

  onState(listener: (state: DesktopUpdaterState) => void): () => void {
    this.listeners.add(listener);
    listener(this.current);
    return () => this.listeners.delete(listener);
  }

  async setChannel(channel: "stable" | "beta"): Promise<DesktopUpdaterState> {
    const change = this.channelChange.then(async () => {
      if (channel === this.current.channel) return this.current;
      if (this.isBusy()) {
        throw new Error(`Cannot change update channel while an update is ${this.current.state}.`);
      }
      await this.saveChannel?.(channel);
      this.configureChannel(channel);
      this.publish({ state: "idle", version: null, message: null });
      return this.current;
    });
    this.channelChange = change.then(() => undefined, () => undefined);
    return await change;
  }

  async check(): Promise<DesktopUpdaterState> {
    await this.channelChange;
    if (this.isBusy()) return this.current;
    this.publish({ state: "checking", version: null, message: null });
    try {
      const result = await this.updater.checkForUpdates();
      if (result === null && this.current.state === "checking") {
        this.publish({ state: "idle", message: "Updates are unavailable in a development build." });
      }
    } catch (error) {
      this.publish({
        state: "error",
        message: error instanceof Error ? error.message : String(error)
      });
    }
    return this.current;
  }

  async install(): Promise<DesktopUpdaterState> {
    await this.channelChange;
    try {
      if (this.manualMac) {
        const version = this.current.version;
        if (this.current.state !== "available" || version === null) {
          this.publish({ state: "error", message: "No update is ready to download." });
          return this.current;
        }
        if (this.openExternal === undefined) {
          throw new Error("Manual Mac updates are unavailable in this build.");
        }
        await this.openExternal(`${DESKTOP_RELEASE_TAG_URL}v${encodeURIComponent(version)}`);
        this.publish({
          state: "available",
          message: "Download the update from the release page, save your work, quit 1667, then replace the app manually."
        });
        return this.current;
      }
      if (this.current.state !== "downloaded") await this.updater.downloadUpdate();
      if (this.beforeInstall !== undefined && !await this.beforeInstall()) {
        this.onInstallAborted?.();
        this.publish({
          state: "downloaded",
          message: "Install cancelled. Save or discard unsaved changes, then try again."
        });
        return this.current;
      }
      this.updater.quitAndInstall();
    } catch (error) {
      this.onInstallAborted?.();
      this.publish({
        state: "error",
        message: error instanceof Error ? error.message : String(error)
      });
    }
    return this.current;
  }

  dispose(): void {
    for (const [event, handler] of this.handlers) {
      this.updater.removeListener(event, handler);
    }
    this.listeners.clear();
  }

  private configureChannel(channel: "stable" | "beta"): void {
    this.updater.setFeedURL({
      provider: "generic",
      url: DESKTOP_UPDATE_FEED_URL
    });
    // electron-updater's channel setter enables downgrades. Keep this after
    // every assignment, including the initial stable configuration.
    this.updater.channel = channel === "stable" ? "latest" : "beta";
    this.updater.allowDowngrade = false;
    this.updater.allowPrerelease = channel === "beta";
    if (this.manualMac) {
      this.updater.autoDownload = false;
      this.updater.autoInstallOnAppQuit = false;
    }
    this.current = { ...this.current, channel, manual: this.manualMac };
  }

  private isBusy(): boolean {
    return BUSY_UPDATE_STATES.has(this.current.state)
      && !(this.manualMac && this.current.state === "available");
  }

  private publish(update: Partial<DesktopUpdaterState>): void {
    this.current = { ...this.current, ...update };
    for (const listener of this.listeners) listener(this.current);
  }
}

export async function loadElectronUpdater(): Promise<ElectronUpdaterLike> {
  const module = await import("electron-updater") as unknown as {
    readonly autoUpdater?: unknown;
    readonly default?: { readonly autoUpdater?: unknown };
  };
  const autoUpdater = module.autoUpdater ?? module.default?.autoUpdater;
  if (autoUpdater === undefined) {
    throw new Error("electron-updater did not expose autoUpdater.");
  }
  return autoUpdater as ElectronUpdaterLike;
}

function versionFrom(value: unknown): string | null {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const version = (value as Record<string, unknown>).version;
    return typeof version === "string" ? version : null;
  }
  return null;
}

function progressMessage(value: unknown): string | null {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const percent = (value as Record<string, unknown>).percent;
    if (typeof percent === "number" && Number.isFinite(percent)) {
      return `${Math.round(percent)}%`;
    }
  }
  return null;
}
