import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  shell as electronShell
} from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DESKTOP_PORT_CONNECT_CHANNEL
} from "../shared/desktop-shell.js";
import {
  decodeDesktopShellRequest,
  DESKTOP_SHELL_EVENT_CHANNEL,
  DESKTOP_SHELL_REQUEST_CHANNEL,
  DESKTOP_SHELL_STATE_CHANNEL,
  type DesktopDialogKind,
  type DesktopShellEvent,
  type DesktopShellResponse
} from "./shell-contract.js";
import {
  DesktopHostRegistry,
  type DesktopPortBridge,
  type DesktopMainPort,
  type DesktopProjectHost
} from "../host/desktop-port-bridge.js";
import type { WorkerHostOptions } from "../host/worker-host.js";
import { resolveMachineTierRoot } from "../server/machine-tier.js";
import { FileRecentProjectsStore } from "./recent-projects.js";
import {
  DesktopShell,
  type DesktopDialogPort,
  type DesktopHostRegistryPort
} from "./shell.js";
import { FileUpdateChannelStore } from "./update-channel.js";
import { ElectronUpdater, loadElectronUpdater } from "./updater.js";

/** Hold one shared Host until the last Renderer window releases its project. */
class DesktopHostLeaseRegistry implements DesktopHostRegistryPort {
  private readonly references = new Map<string, number>();
  private readonly tails = new Map<string, Promise<void>>();

  constructor(private readonly registry: DesktopHostRegistry) {}

  openProject(id: string, options?: WorkerHostOptions): Promise<DesktopProjectHost> {
    return this.enqueue(id, async () => {
      const entry = await this.registry.openProject(id, options);
      this.references.set(id, (this.references.get(id) ?? 0) + 1);
      return entry;
    });
  }

  async closeProject(id: string): Promise<void> {
    await this.enqueue(id, async () => {
      const references = this.references.get(id);
      if (references === undefined) return;
      if (references > 1) {
        this.references.set(id, references - 1);
        return;
      }
      this.references.delete(id);
      await this.registry.closeProject(id);
    });
  }

  private enqueue<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(id) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(() => undefined, () => undefined);
    this.tails.set(id, tail);
    void tail.then(() => {
      if (this.tails.get(id) === tail) this.tails.delete(id);
    });
    return result;
  }
}

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const registry = new DesktopHostRegistry();
const leaseRegistry = new DesktopHostLeaseRegistry(registry);
const desktopWindowIds = new Set<number>();
const sessions = new Map<number, DesktopWindowSession>();
const sessionDisposals = new Set<Promise<void>>();
let machineDir: string | null = null;
let recent: FileRecentProjectsStore | null = null;
let updater: ElectronUpdater | null = null;
let quitting = false;
let updateInstalling = false;

interface DesktopWindowSession {
  readonly window: BrowserWindow;
  readonly shell: DesktopShell;
  readonly ready: Promise<unknown>;
  portBridge: DesktopPortBridge | null;
  attachedProjectId: string | null;
  closeDecision: ((allow: boolean) => void) | null;
  readonly authUrls: Set<string>;
}

/** Create one sandboxed Renderer window with its own project controller. */
export function createDesktopWindow(initialDataDirectory?: string): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    webPreferences: {
      preload: path.join(moduleDirectory, "..", "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });
  desktopWindowIds.add(window.id);
  const shell = new DesktopShell({
    registry: leaseRegistry,
    machineDir: requireMachineDir(),
    recent: requireRecentProjects(),
    dialogs: createDialogs(),
    reveal: (target) => electronShell.showItemInFolder(target),
    ...(updater === null ? {} : { updater }),
    emit: (event) => emitShellEvent(window.id, event)
  });
  const ready = shell.start(
    process.cwd(),
    initialDataDirectory
  ).catch((error: unknown) => {
    emitShellEvent(window.id, {
      type: "hostError",
      message: error instanceof Error ? error.message : String(error)
    });
    return null;
  });
  const session: DesktopWindowSession = {
    window,
    shell,
    ready,
    portBridge: null,
    attachedProjectId: null,
    closeDecision: null,
    authUrls: new Set()
  };
  sessions.set(window.id, session);
  window.on("closed", () => {
    session.portBridge?.close();
    session.portBridge = null;
    session.attachedProjectId = null;
    session.authUrls.clear();
    desktopWindowIds.delete(window.id);
    sessions.delete(window.id);
    const disposal = ready.then(() => shell.dispose());
    sessionDisposals.add(disposal);
    void disposal.then(
      () => sessionDisposals.delete(disposal),
      () => sessionDisposals.delete(disposal)
    );
  });
  window.webContents.on("did-navigate", () => {
    session.portBridge?.close();
    session.portBridge = null;
    session.attachedProjectId = null;
  });
  window.webContents.on("will-prevent-unload", (event) => {
    const choice = dialog.showMessageBoxSync(window, {
      type: "warning",
      buttons: ["Discard", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      title: "Unsaved changes",
      message: "Discard unsaved changes?",
      detail: "Your unsaved story edits or interrupted generation will be lost."
    });
    const allow = choice === 0;
    if (allow) event.preventDefault();
    session.closeDecision?.(allow);
  });
  const configuredRendererUrl = process.env.AI_1667_DESKTOP_RENDERER_URL;
  const rendererUrl = rendererEntryUrl(configuredRendererUrl);
  const rejectNavigation = (event: Electron.Event, target: string): void => {
    if (!sameRendererEntry(target, rendererUrl)) event.preventDefault();
  };
  window.webContents.on("will-navigate", rejectNavigation);
  window.webContents.on("will-redirect", rejectNavigation);
  window.webContents.setWindowOpenHandler(({ url }) => {
    const normalized = normalizeExternalAuthUrl(url);
    if (normalized !== null && session.authUrls.has(normalized)) {
      void electronShell.openExternal(normalized).catch(() => undefined);
    }
    return { action: "deny" };
  });
  if (configuredRendererUrl === undefined || configuredRendererUrl.length === 0) {
    void window.loadFile(path.join(moduleDirectory, "..", "renderer", "index.html"));
  } else {
    void window.loadURL(configuredRendererUrl);
  }
  return window;
}

ipcMain.handle(
  DESKTOP_SHELL_REQUEST_CHANNEL,
  async (event, value: unknown): Promise<DesktopShellResponse> => {
    if (!isTrustedRenderer(event)) {
      return {
        ok: false,
        error: { code: "forbidden", message: "The desktop bridge is unavailable to this frame." }
      };
    }
    const request = decodeDesktopShellRequest(value);
    if (request === null) {
      return {
        ok: false,
        error: { code: "invalid_request", message: "Malformed desktop shell request." }
      };
    }
    const session = trustedSession(event);
    if (session === null) {
      return {
        ok: false,
        error: { code: "not_ready", message: "Desktop shell is still starting." }
      };
    }
    await session.ready;
    return await session.shell.handle(request);
  }
);

ipcMain.on(DESKTOP_SHELL_STATE_CHANNEL, (event) => {
  const session = trustedSession(event);
  if (session === null) return;
  void session.ready.then(() => {
    if (sessions.get(session.window.id) !== session) return;
    return session.shell.publishCurrentState();
  });
});

ipcMain.on(DESKTOP_PORT_CONNECT_CHANNEL, (event) => {
  const port = event.ports[0] as unknown as DesktopMainPort | undefined;
  const session = trustedSession(event);
  if (session === null) {
    port?.close();
    return;
  }
  if (port === undefined) {
    return;
  }
  void session.ready.then(() => {
    if (sessions.get(session.window.id) !== session || session.window.isDestroyed()) {
      port.close();
      return;
    }
    const projectId = session.shell.activeProjectId;
    if (projectId === null) {
      port.close();
      return;
    }
    try {
      session.portBridge?.close();
      session.portBridge = null;
      session.attachedProjectId = null;
      session.portBridge = registry.attachPort(projectId, port);
      session.attachedProjectId = projectId;
    } catch {
      port.close();
    }
  }, () => {
    port?.close();
  });
});

async function start(): Promise<void> {
  await app.whenReady();
  machineDir = await resolveMachineTierRoot();
  const updateChannels = new FileUpdateChannelStore(
    path.join(machineDir, "desktop-update-channel.json")
  );
  try {
    updater = new ElectronUpdater(await loadElectronUpdater(), {
      initialChannel: await updateChannels.read(),
      saveChannel: async (channel) => await updateChannels.write(channel),
      openExternal: async (url) => await electronShell.openExternal(url),
      beforeInstall: () => prepareForUpdateInstall(),
      onInstallAborted: () => { updateInstalling = false; }
    });
  } catch {
    // Development builds can omit electron-updater. The project Host remains
    // usable, and the Shell reports updater commands as unavailable.
    updater = null;
  }
  recent = new FileRecentProjectsStore(path.join(machineDir, "desktop-recent.json"));
  installApplicationMenu();
  createDesktopWindow(process.env.AI_1667_DESKTOP_DATA_DIR);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createDesktopWindow();
  });
}

function installApplicationMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: "File",
      submenu: [
        {
          label: "New Window",
          accelerator: "CmdOrCtrl+N",
          click: () => { void openNewWindow(); }
        },
        { role: "close" },
        { role: "quit" }
      ]
    },
    { role: "editMenu" },
    { role: "windowMenu" }
  ]));
}

async function openNewWindow(): Promise<void> {
  const focusedWindowId = BrowserWindow.getFocusedWindow()?.id;
  await Promise.all([...sessions.values()].map((session) => session.ready));
  createDesktopWindow(activeProjectDirectory(focusedWindowId));
}

function rendererEntryUrl(configured: string | undefined): string {
  if (configured !== undefined && configured.length > 0) return configured;
  return new URL(
    "../renderer/index.html",
    import.meta.url
  ).toString();
}

function sameRendererEntry(target: string, expected: string): boolean {
  try {
    const actualUrl = new URL(target);
    const expectedUrl = new URL(expected);
    return actualUrl.protocol === expectedUrl.protocol
      && actualUrl.host === expectedUrl.host
      && actualUrl.pathname === expectedUrl.pathname
      && actualUrl.search === expectedUrl.search;
  } catch {
    return false;
  }
}

function isTrustedRenderer(
  event: { readonly sender: Electron.WebContents; readonly senderFrame: Electron.WebFrameMain | null }
): boolean {
  const window = BrowserWindow.fromWebContents(event.sender);
  return window !== null
    && desktopWindowIds.has(window.id)
    && event.senderFrame === event.sender.mainFrame;
}

function trustedSession(
  event: { readonly sender: Electron.WebContents; readonly senderFrame: Electron.WebFrameMain | null }
): DesktopWindowSession | null {
  if (!isTrustedRenderer(event)) return null;
  const window = BrowserWindow.fromWebContents(event.sender);
  return window === null ? null : (sessions.get(window.id) ?? null);
}

function emitShellEvent(
  ownerWindowId: number,
  event: DesktopShellEvent
): void {
  if (event.type === "projectChanged") {
    const owner = sessions.get(ownerWindowId);
    const nextProjectId = event.project?.open === true ? event.project.directory : null;
    if (owner !== undefined
      && owner.attachedProjectId !== null
      && owner.attachedProjectId !== nextProjectId) {
      owner.portBridge?.close();
      owner.portBridge = null;
      owner.attachedProjectId = null;
    }
  }
  if (event.type === "authEvent") {
    const urls = authExternalUrls(event);
    const allowed = sessions.get(ownerWindowId)?.authUrls;
    if (allowed !== undefined) {
      for (const url of urls) allowed.add(url);
    }
  }
  const shared = event.type === "recentProjects"
    || event.type === "authState"
    || event.type === "updaterState";
  const recipients = shared
    ? sessions.values()
    : [sessions.get(ownerWindowId)].filter(
        (session): session is DesktopWindowSession => session !== undefined
      );
  for (const session of recipients) {
    if (!session.window.isDestroyed()) {
      session.window.webContents.send(DESKTOP_SHELL_EVENT_CHANNEL, event);
    }
  }
}

function authExternalUrls(
  event: Extract<DesktopShellEvent, { type: "authEvent" }>
): readonly string[] {
  if (event.event.type === "auth_url") {
    const url = normalizeExternalAuthUrl(event.event.url);
    return url === null ? [] : [url];
  }
  if (event.event.type === "device_code") {
    const url = normalizeExternalAuthUrl(event.event.verificationUri);
    return url === null ? [] : [url];
  }
  if (event.event.type === "info") {
    return (event.event.links ?? [])
      .map((link) => normalizeExternalAuthUrl(link.url))
      .filter((url): url is string => url !== null);
  }
  return [];
}

function normalizeExternalAuthUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function activeProjectDirectory(preferredWindowId?: number): string | undefined {
  const preferred = preferredWindowId === undefined ? undefined : sessions.get(preferredWindowId);
  const preferredDirectory = preferred?.shell.currentProject?.directory;
  if (preferredDirectory !== undefined) return preferredDirectory;
  for (const session of sessions.values()) {
    const directory = session.shell.currentProject?.directory;
    if (directory !== undefined) return directory;
  }
  return undefined;
}

function requireMachineDir(): string {
  if (machineDir === null) throw new Error("Desktop shell is still starting.");
  return machineDir;
}

function requireRecentProjects(): FileRecentProjectsStore {
  if (recent === null) throw new Error("Desktop shell is still starting.");
  return recent;
}

function createDialogs(): DesktopDialogPort {
  return {
    async open(kind, multiple) {
      const result = await dialog.showOpenDialog({
        properties: [
          ...(kind === "project" || kind === "directory" ? ["openDirectory" as const] : ["openFile" as const]),
          ...(multiple ? ["multiSelections" as const] : [])
        ],
        filters: filtersFor(kind)
      });
      return result.canceled ? [] : result.filePaths;
    },
    async save(kind, defaultPath) {
      const result = await dialog.showSaveDialog({
        ...(defaultPath === undefined ? {} : { defaultPath }),
        filters: filtersFor(kind)
      });
      return result.canceled ? null : (result.filePath ?? null);
    },
    async directory(options = {}) {
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory"],
        buttonLabel: "Choose folder",
        ...(options.title === undefined ? {} : { title: options.title }),
        ...(options.message === undefined ? {} : { message: options.message })
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    }
  };
}

function filtersFor(kind: DesktopDialogKind): { name: string; extensions: string[] }[] {
  switch (kind) {
    case "story-import":
      return [{ name: "Story files", extensions: ["md", "jsonl", "story", "scenario"] }];
    case "profile-import":
      return [{ name: "Profile files", extensions: ["json", "profile"] }];
    case "story-export":
      return [{ name: "Story files", extensions: ["md", "story", "scenario", "json"] }];
    case "profile-export":
      return [{ name: "Profile files", extensions: ["json"] }];
    default:
      return [];
  }
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && !quitting && !updateInstalling) app.quit();
});

app.on("before-quit", (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  void (async () => {
    try {
      const closed = await Promise.all([...sessions.values()].map((session) => closeWindowForQuit(session)));
      if (closed.some((didClose) => !didClose) || sessions.size > 0) {
        quitting = false;
        return;
      }
      await Promise.allSettled([...sessionDisposals]);
      await registry.dispose();
    } finally {
      if (quitting) {
        updater?.dispose();
        app.exit();
      }
    }
  })();
});

function closeWindowForQuit(session: DesktopWindowSession): Promise<boolean> {
  if (session.window.isDestroyed()) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (didClose: boolean): void => {
      if (settled) return;
      settled = true;
      session.closeDecision = null;
      session.window.off("closed", onClosed);
      resolve(didClose);
    };
    const onClosed = (): void => finish(true);
    session.closeDecision = (allow): void => {
      if (!allow) finish(false);
    };
    session.window.once("closed", onClosed);
    try {
      session.window.close();
    } catch {
      finish(false);
    }
  });
}

/** Electron-updater can install before it emits `before-quit`. Reuse the
 * native close decision for every renderer before handing control to it. */
async function prepareForUpdateInstall(): Promise<boolean> {
  if (updateInstalling) return false;
  updateInstalling = true;
  const closed = await Promise.all([...sessions.values()].map((session) => closeWindowForQuit(session)));
  if (closed.some((didClose) => !didClose)) {
    updateInstalling = false;
    return false;
  }
  await Promise.allSettled([...sessionDisposals]);
  return true;
}

void start().catch((error: unknown) => {
  console.error(error);
  app.exit(1);
});
