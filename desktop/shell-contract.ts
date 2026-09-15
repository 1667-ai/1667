import type {
  AuthEvent,
  AuthPrompt
} from "@earendil-works/pi-ai";
import type { ExportFormat, StoryExportResult } from "../host/launcher-export.js";
import type {
  ProfileExportResult,
  ProfileImportResult
} from "../host/launcher-profile.js";
import type {
  StoryImportResult
} from "../host/launcher-import.js";
import type { SubscriptionProvider, AuthLoginResult, AuthStatus } from "../host/launcher-auth.js";

export const DESKTOP_SHELL_REQUEST_CHANNEL = "1667:desktop-shell-request";
export const DESKTOP_SHELL_EVENT_CHANNEL = "1667:desktop-shell-event";
export const DESKTOP_SHELL_STATE_CHANNEL = "1667:desktop-shell-state";

export type DesktopAuthPrompt = Omit<AuthPrompt, "signal">;

export interface DesktopProjectSnapshot {
  readonly root: string;
  readonly directory: string;
  readonly source: "discovered" | "explicit" | "global";
  readonly exists: true;
  readonly vault: "sealed" | "unsealed";
  readonly open: boolean;
}

export interface DesktopRecentProject {
  readonly root: string;
  readonly directory: string;
  readonly openedAt: number;
}

export type DesktopDialogKind =
  | "project"
  | "story-import"
  | "profile-import"
  | "story-export"
  | "profile-export"
  | "directory";

export type DesktopShellRequest =
  | { readonly type: "project.create"; readonly root: string }
  | { readonly type: "project.open"; readonly root: string; readonly global?: boolean }
  | { readonly type: "project.adopt"; readonly source: string; readonly projectRoot: string }
  | { readonly type: "project.recent" }
  | { readonly type: "project.reveal"; readonly path: string }
  | { readonly type: "dialog.open"; readonly kind: DesktopDialogKind; readonly multiple?: boolean }
  | { readonly type: "dialog.save"; readonly kind: Exclude<DesktopDialogKind, "project" | "directory">; readonly defaultPath?: string }
  | {
      readonly type: "dialog.directory";
      readonly title?: string;
      readonly message?: string;
    }
  | { readonly type: "vault.unlock"; readonly password: string }
  | { readonly type: "vault.seal"; readonly password: string }
  | { readonly type: "vault.unseal"; readonly password: string }
  | { readonly type: "story.import"; readonly file: string }
  | {
      readonly type: "story.export";
      readonly directory: string;
      readonly storyId: string | null;
      readonly all: boolean;
      readonly format: ExportFormat;
      readonly force: boolean;
    }
  | { readonly type: "profile.import"; readonly file: string; readonly profile: string | null }
  | {
      readonly type: "profile.export";
      readonly directory: string;
      readonly profile: string | null;
      readonly force: boolean;
    }
  | { readonly type: "auth.status" }
  | { readonly type: "auth.login"; readonly provider: SubscriptionProvider }
  | { readonly type: "auth.logout"; readonly provider: SubscriptionProvider }
  | { readonly type: "auth.promptResponse"; readonly interactionId: string; readonly value: string }
  | { readonly type: "auth.cancel"; readonly interactionId: string }
  | { readonly type: "updater.check" }
  | { readonly type: "updater.channel"; readonly channel: "stable" | "beta" }
  | { readonly type: "updater.install" };

export type DesktopShellSuccess =
  | { readonly type: "project"; readonly project: DesktopProjectSnapshot }
  | { readonly type: "recent"; readonly projects: readonly DesktopRecentProject[] }
  | { readonly type: "path"; readonly path: string }
  | { readonly type: "dialog"; readonly paths: readonly string[] }
  | { readonly type: "vault"; readonly state: "sealed" | "unsealed"; readonly project: DesktopProjectSnapshot }
  | { readonly type: "storyImport"; readonly result: StoryImportResult }
  | { readonly type: "storyExport"; readonly results: readonly StoryExportResult[] }
  | { readonly type: "profileImport"; readonly result: ProfileImportResult }
  | { readonly type: "profileExport"; readonly result: ProfileExportResult }
  | { readonly type: "authStatus"; readonly statuses: readonly AuthStatus[] }
  | { readonly type: "authLogin"; readonly result: AuthLoginResult }
  | { readonly type: "empty" }
  | { readonly type: "updater"; readonly state: DesktopUpdaterState };

export interface DesktopShellError {
  readonly code: string;
  readonly message: string;
}

export type DesktopShellResponse =
  | { readonly ok: true; readonly result: DesktopShellSuccess }
  | { readonly ok: false; readonly error: DesktopShellError };

/** Typed bridge exposed as `window.desktop` by the isolated preload. */
export interface DesktopShellBridge {
  request(request: DesktopShellRequest): Promise<DesktopShellResponse>;
  onEvent(listener: (event: DesktopShellEvent) => void): () => void;
}

/** Stable Renderer contract for the Electron preload surface. */
export interface DesktopWindowApi {
  connect(): void;
  readonly shell: DesktopShellBridge;
}

export type DesktopUpdaterState = {
  readonly channel: "stable" | "beta";
  readonly manual: boolean;
  readonly state:
    | "idle"
    | "checking"
    | "available"
    | "not-available"
    | "downloading"
    | "downloaded"
    | "error";
  readonly version: string | null;
  readonly message: string | null;
};

export type DesktopShellEvent =
  | {
      readonly type: "projectChanged";
      readonly project: DesktopProjectSnapshot | null;
    }
  | {
      readonly type: "recentProjects";
      readonly projects: readonly DesktopRecentProject[];
    }
  | {
      readonly type: "vaultState";
      readonly state: "sealed" | "unsealed";
      readonly project: DesktopProjectSnapshot;
    }
  | {
      readonly type: "authPrompt";
      readonly interactionId: string;
      readonly prompt: DesktopAuthPrompt;
    }
  | { readonly type: "authEvent"; readonly interactionId: string; readonly event: AuthEvent }
  | { readonly type: "authState"; readonly statuses: readonly AuthStatus[] }
  | { readonly type: "updaterState"; readonly state: DesktopUpdaterState }
  | { readonly type: "hostError"; readonly message: string };

const PATH_REQUEST_TYPES = new Set([
  "project.create",
  "project.open",
  "project.adopt",
  "project.reveal",
  "story.import",
  "story.export",
  "profile.import",
  "profile.export"
]);

/** Decode the structured-clone request before it reaches the main process. */
export function decodeDesktopShellRequest(value: unknown): DesktopShellRequest | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.type !== "string") return null;
  if (PATH_REQUEST_TYPES.has(record.type)
    && Object.entries(record).some(([key, entry]) =>
      (key === "root" || key === "source" || key === "projectRoot"
        || key === "path" || key === "file" || key === "directory"
        || key === "defaultPath")
      && entry !== undefined
      && typeof entry !== "string")) {
    return null;
  }
  switch (record.type) {
    case "project.create":
    case "project.open":
      return isString(record.root)
        && (record.global === undefined || typeof record.global === "boolean")
        ? record as DesktopShellRequest
        : null;
    case "project.adopt":
      return isString(record.source) && isString(record.projectRoot)
        ? record as DesktopShellRequest
        : null;
    case "project.recent":
      return record as DesktopShellRequest;
    case "project.reveal":
      return isString(record.path) ? record as DesktopShellRequest : null;
    case "dialog.open":
      return isString(record.kind)
        && isDialogKind(record.kind)
        && (record.multiple === undefined || typeof record.multiple === "boolean")
        ? record as DesktopShellRequest
        : null;
    case "dialog.save":
      return isString(record.kind)
        && isDialogSaveKind(record.kind)
        && (record.defaultPath === undefined || isString(record.defaultPath))
        ? record as DesktopShellRequest
        : null;
    case "dialog.directory":
      return (record.title === undefined || isString(record.title))
        && (record.message === undefined || isString(record.message))
        ? record as DesktopShellRequest
        : null;
    case "vault.unlock":
    case "vault.seal":
    case "vault.unseal":
      return isString(record.password) ? record as DesktopShellRequest : null;
    case "story.import":
      return isString(record.file) ? record as DesktopShellRequest : null;
    case "story.export":
      return isString(record.directory)
        && (record.storyId === null || isString(record.storyId))
        && typeof record.all === "boolean"
        && (record.format === "markdown"
          || record.format === "scenario"
          || record.format === "story"
          || record.format === "lorebook")
        && typeof record.force === "boolean"
        ? record as DesktopShellRequest
        : null;
    case "profile.import":
      return isString(record.file)
        && (record.profile === null || isString(record.profile))
        ? record as DesktopShellRequest
        : null;
    case "profile.export":
      return isString(record.directory)
        && (record.profile === null || isString(record.profile))
        && typeof record.force === "boolean"
        ? record as DesktopShellRequest
        : null;
    case "auth.status":
    case "updater.check":
    case "updater.install":
      return record as DesktopShellRequest;
    case "auth.login":
    case "auth.logout":
      return (record.provider === "chatgpt" || record.provider === "claude")
        ? record as DesktopShellRequest
        : null;
    case "auth.promptResponse":
      return isString(record.interactionId) && isString(record.value)
        ? record as DesktopShellRequest
        : null;
    case "auth.cancel":
      return isString(record.interactionId) ? record as DesktopShellRequest : null;
    case "updater.channel":
      return record.channel === "stable" || record.channel === "beta"
        ? record as DesktopShellRequest
        : null;
    default:
      return null;
  }
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isDialogKind(value: string): value is DesktopDialogKind {
  return value === "project"
    || value === "story-import"
    || value === "profile-import"
    || value === "story-export"
    || value === "profile-export"
    || value === "directory";
}

function isDialogSaveKind(
  value: string
): value is Exclude<DesktopDialogKind, "project" | "directory"> {
  return value === "story-import"
    || value === "profile-import"
    || value === "story-export"
    || value === "profile-export";
}
