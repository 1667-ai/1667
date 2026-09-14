/** Renderer-safe mirror of the Shell contract.
 *
 * The Main process owns the source contract because it calls the launcher
 * modules. Keep this file limited to structured-clone data so the browser
 * bundle never imports Node or provider code.
 */
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
      readonly format: "markdown" | "scenario" | "story" | "lorebook";
      readonly force: boolean;
    }
  | { readonly type: "profile.import"; readonly file: string; readonly profile: string | null }
  | { readonly type: "profile.export"; readonly directory: string; readonly profile: string | null; readonly force: boolean }
  | { readonly type: "auth.status" }
  | { readonly type: "auth.login"; readonly provider: "chatgpt" | "claude" }
  | { readonly type: "auth.logout"; readonly provider: "chatgpt" | "claude" }
  | { readonly type: "auth.promptResponse"; readonly interactionId: string; readonly value: string }
  | { readonly type: "auth.cancel"; readonly interactionId: string }
  | { readonly type: "updater.check" }
  | { readonly type: "updater.channel"; readonly channel: "stable" | "beta" }
  | { readonly type: "updater.install" };

export interface DesktopUpdaterState {
  readonly channel: "stable" | "beta";
  readonly state: "idle" | "checking" | "available" | "not-available" | "downloading" | "downloaded" | "error";
  readonly version: string | null;
  readonly message: string | null;
}

export type DesktopAuthPrompt =
  | { readonly type: "text"; readonly message: string; readonly placeholder?: string }
  | { readonly type: "secret"; readonly message: string; readonly placeholder?: string }
  | {
      readonly type: "select";
      readonly message: string;
      readonly options: readonly { readonly id: string; readonly label: string; readonly description?: string }[];
    }
  | { readonly type: "manual_code"; readonly message: string; readonly placeholder?: string };

export type DesktopAuthStatus = {
  readonly provider: "chatgpt" | "claude";
  readonly label: string;
  readonly status: "signed out" | "signed in" | "signed in (refreshes on next use)";
};

export type DesktopAuthEvent =
  | { readonly type: "info"; readonly message: string; readonly links?: readonly { readonly url: string; readonly label?: string }[] }
  | { readonly type: "auth_url"; readonly url: string; readonly instructions?: string }
  | { readonly type: "device_code"; readonly userCode: string; readonly verificationUri: string; readonly intervalSeconds?: number; readonly expiresInSeconds?: number }
  | { readonly type: "progress"; readonly message: string };

export type DesktopShellEvent =
  | { readonly type: "projectChanged"; readonly project: DesktopProjectSnapshot | null }
  | { readonly type: "recentProjects"; readonly projects: readonly DesktopRecentProject[] }
  | { readonly type: "vaultState"; readonly state: "sealed" | "unsealed"; readonly project: DesktopProjectSnapshot }
  | { readonly type: "authPrompt"; readonly interactionId: string; readonly prompt: DesktopAuthPrompt }
  | { readonly type: "authEvent"; readonly interactionId: string; readonly event: DesktopAuthEvent }
  | { readonly type: "authState"; readonly statuses: readonly DesktopAuthStatus[] }
  | { readonly type: "updaterState"; readonly state: DesktopUpdaterState }
  | { readonly type: "hostError"; readonly message: string };

export type DesktopShellResult =
  | { readonly type: "project"; readonly project: DesktopProjectSnapshot }
  | { readonly type: "recent"; readonly projects: readonly DesktopRecentProject[] }
  | { readonly type: "path"; readonly path: string }
  | { readonly type: "dialog"; readonly paths: readonly string[] }
  | { readonly type: "vault"; readonly state: "sealed" | "unsealed"; readonly project: DesktopProjectSnapshot }
  | { readonly type: "storyImport"; readonly result: unknown }
  | { readonly type: "storyExport"; readonly results: readonly unknown[] }
  | { readonly type: "profileImport"; readonly result: unknown }
  | { readonly type: "profileExport"; readonly result: unknown }
  | { readonly type: "authStatus"; readonly statuses: readonly DesktopAuthStatus[] }
  | { readonly type: "authLogin"; readonly result: unknown }
  | { readonly type: "empty" }
  | { readonly type: "updater"; readonly state: DesktopUpdaterState };

export type DesktopShellResponse =
  | { readonly ok: true; readonly result: DesktopShellResult }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };
