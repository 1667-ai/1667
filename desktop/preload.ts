import { contextBridge, ipcRenderer } from "electron";
import {
  DESKTOP_PORT_CONNECT_CHANNEL,
  DESKTOP_PORT_WINDOW_MESSAGE
} from "../shared/desktop-shell.js";
import {
  DESKTOP_SHELL_EVENT_CHANNEL,
  DESKTOP_SHELL_REQUEST_CHANNEL,
  DESKTOP_SHELL_STATE_CHANNEL,
  type DesktopWindowApi,
  type DesktopShellEvent,
  type DesktopShellRequest,
  type DesktopShellResponse
} from "./shell-contract.js";

/** The isolated Renderer surface. Filesystem and credentials stay in Main. */
export type DesktopPreloadApi = DesktopWindowApi;

const api: DesktopPreloadApi = Object.freeze({
  connect(): void {
    const channel = new MessageChannel();
    ipcRenderer.postMessage(DESKTOP_PORT_CONNECT_CHANNEL, undefined, [channel.port2]);
    const targetOrigin = window.location.origin === "null"
      ? "*"
      : window.location.origin;
    window.postMessage({ type: DESKTOP_PORT_WINDOW_MESSAGE }, targetOrigin, [channel.port1]);
  },
  shell: Object.freeze({
    request(request: DesktopShellRequest): Promise<DesktopShellResponse> {
      return ipcRenderer.invoke(DESKTOP_SHELL_REQUEST_CHANNEL, request) as Promise<DesktopShellResponse>;
    },
    onEvent(listener: (event: DesktopShellEvent) => void): () => void {
      const handler = (_event: Electron.IpcRendererEvent, value: DesktopShellEvent): void => {
        listener(value);
      };
      ipcRenderer.on(DESKTOP_SHELL_EVENT_CHANNEL, handler);
      ipcRenderer.send(DESKTOP_SHELL_STATE_CHANNEL);
      return () => ipcRenderer.removeListener(DESKTOP_SHELL_EVENT_CHANNEL, handler);
    }
  })
});

contextBridge.exposeInMainWorld("desktop", api);
