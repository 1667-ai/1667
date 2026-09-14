import type { StoryApi } from "../client/api.js";
import type { RendererAuthLink, RendererState } from "./renderer-model.js";
import { desktopShell, messageOf } from "./renderer-runtime.js";
import type {
  DesktopAuthEvent,
  DesktopShellEvent,
  DesktopShellRequest,
  DesktopShellResponse
} from "./renderer-shell-contract.js";

export interface RendererShellHooks {
  readonly state: () => RendererState;
  readonly setState: (update: Partial<RendererState>) => void;
  readonly connectAndLoad: () => void;
  readonly clearProject: () => void;
  readonly api: () => StoryApi | null;
  readonly refresh: () => Promise<void>;
  readonly prepareProfileImport: () => Promise<boolean>;
  readonly reloadSettings: () => Promise<void>;
  readonly confirmDiscardDrafts: () => Promise<boolean>;
  readonly discardDrafts: () => Promise<void>;
}

/** Renderer-side coordinator for the Electron project launcher bridge. */
export class RendererShellController {
  private unsubscribe: (() => void) | null = null;

  public constructor(private readonly hooks: RendererShellHooks) {}

  public start(): void {
    const shell = desktopShell();
    if (shell === undefined) return;
    this.unsubscribe?.();
    this.unsubscribe = shell.onEvent((event) => this.handleEvent(event));
    void this.request({ type: "project.recent" });
    void this.request({ type: "auth.status" });
  }

  public async request(request: DesktopShellRequest, discardConfirmed = false): Promise<DesktopShellResponse> {
    const shell = desktopShell();
    if (shell === undefined) {
      const response: DesktopShellResponse = { ok: false, error: { code: "unavailable", message: "The desktop shell is unavailable." } };
      this.hooks.setState({ launcherError: response.error.message });
      return response;
    }
    if (leavesProject(request)) {
      if (!discardConfirmed && !await this.hooks.confirmDiscardDrafts()) {
        const state = this.hooks.state();
        this.hooks.setState({
          launcherError: state.error ?? "Project action cancelled."
        });
        return { ok: false, error: { code: "cancelled", message: "Project action cancelled." } };
      }
    }
    if (request.type === "profile.import" && !await this.hooks.prepareProfileImport()) {
      const message = "Profile import cancelled.";
      this.hooks.setState({ launcherError: message });
      return { ok: false, error: { code: "cancelled", message } };
    }
    this.hooks.setState({ launcherBusy: true, launcherError: null });
    try {
      const response = await shell.request(request);
      if (!response.ok) {
        this.hooks.setState({ launcherError: response.error.message, error: response.error.message, status: "Host action failed" });
        return response;
      }
      if (leavesProject(request)) await this.hooks.discardDrafts();
      if (request.type === "profile.import" && response.result.type === "profileImport") await this.hooks.reloadSettings();
      if (request.type === "auth.cancel") this.hooks.setState({ authPrompt: null, authPromptValue: "", authMessage: "Sign-in cancelled.", authLinks: [] });
      this.applyResult(response.result);
      return response;
    } catch (error) {
      const message = messageOf(error);
      this.hooks.setState({ launcherError: message, error: message, status: "Host action failed" });
      return { ok: false, error: { code: "host", message } };
    } finally {
      this.hooks.setState({ launcherBusy: false });
    }
  }

  private handleEvent(event: DesktopShellEvent): void {
    if (event.type === "projectChanged") {
      this.hooks.setState({ project: event.project, showProjects: event.project?.open === true ? false : this.hooks.state().showProjects, authPrompt: null, authPromptValue: "", authMessage: null, authLinks: [], launcherError: null });
      if (event.project?.open === true) this.hooks.connectAndLoad();
      else this.hooks.clearProject();
      return;
    }
    if (event.type === "recentProjects") {
      this.hooks.setState({ recentProjects: event.projects });
      return;
    }
    if (event.type === "vaultState") {
      this.hooks.setState({ project: event.project, ...(event.project.open ? { showProjects: false } : {}) });
      if (event.project.open) this.hooks.connectAndLoad();
      return;
    }
    if (event.type === "authPrompt") {
      const current = this.hooks.state().authPrompt;
      const currentValue = this.hooks.state().authPromptValue;
      this.hooks.setState({
        authPrompt: { interactionId: event.interactionId, prompt: event.prompt },
        authPromptValue: current?.interactionId === event.interactionId ? currentValue : "",
        launcherError: null
      });
      return;
    }
    if (event.type === "authEvent") {
      const notice = formatAuthEvent(event.event);
      this.hooks.setState({ authMessage: notice.message, authLinks: notice.links });
      return;
    }
    if (event.type === "authState") {
      this.hooks.setState({ authStatuses: event.statuses, authPrompt: null, authPromptValue: "", authMessage: null, authLinks: [] });
      return;
    }
    if (event.type === "updaterState") {
      this.hooks.setState({ updater: event.state });
      return;
    }
    this.hooks.setState({ launcherError: event.message, error: event.message, status: "Host action failed" });
  }

  private applyResult(result: Extract<DesktopShellResponse, { ok: true }>["result"]): void {
    if (result.type === "project") {
      this.hooks.setState({ project: result.project, ...(result.project.open ? { showProjects: false } : {}), launcherError: null, authPrompt: null });
      if (result.project.open) this.hooks.connectAndLoad();
    } else if (result.type === "recent") {
      this.hooks.setState({ recentProjects: result.projects });
    } else if (result.type === "vault") {
      this.hooks.setState({ project: result.project, ...(result.project.open ? { showProjects: false } : {}), launcherError: null });
      if (result.project.open) this.hooks.connectAndLoad();
    } else if (result.type === "authStatus") {
      this.hooks.setState({ authStatuses: result.statuses, authPrompt: null, authPromptValue: "", authMessage: null, authLinks: [] });
    } else if (result.type === "authLogin") {
      const login = result.result;
      const signedIn = login !== null && typeof login === "object" && "kind" in login && (login as { kind?: unknown }).kind === "signed-in";
      this.hooks.setState({ authPrompt: null, authPromptValue: "", authMessage: signedIn ? "Signed in." : "Sign-in cancelled.", authLinks: [] });
    } else if (result.type === "updater") {
      this.hooks.setState({ updater: result.state });
    } else if (result.type === "storyImport" || result.type === "profileImport" || result.type === "storyExport" || result.type === "profileExport") {
      this.hooks.setState({ status: "Project files updated", launcherError: null });
      if (this.hooks.api() !== null) void this.hooks.refresh();
    }
  }
}

function formatAuthEvent(event: DesktopAuthEvent): { readonly message: string; readonly links: readonly RendererAuthLink[] } {
  if (event.type === "auth_url") {
    return {
      message: event.instructions ?? "Open the provider sign-in page to continue.",
      links: safeAuthLinks([{ url: event.url, label: "Open sign-in page" }])
    };
  }
  if (event.type === "device_code") {
    return {
      message: `${event.userCode} · ${event.verificationUri}`,
      links: safeAuthLinks([{ url: event.verificationUri, label: "Open verification page" }])
    };
  }
  return {
    message: event.message,
    links: event.type === "info"
      ? safeAuthLinks((event.links ?? []).map((link) => ({ url: link.url, label: link.label ?? "Open link" })))
      : []
  };
}

function safeAuthLinks(links: readonly RendererAuthLink[]): readonly RendererAuthLink[] {
  return links.filter((link) => {
    try {
      return new URL(link.url).protocol === "https:";
    } catch {
      return false;
    }
  });
}

function leavesProject(request: DesktopShellRequest): boolean {
  return request.type === "project.create"
    || request.type === "project.open"
    || request.type === "project.adopt"
    || request.type === "vault.unlock"
    || request.type === "vault.seal"
    || request.type === "vault.unseal";
}
