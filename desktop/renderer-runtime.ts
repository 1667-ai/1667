import { storyApiFromWorkerTransport } from "../client/worker-story-api.js";
import { type StoryApi } from "../client/api.js";
import { DesktopTransport, type DesktopTransportOptions } from "../client/desktop-transport.js";
import { DESKTOP_PORT_WINDOW_MESSAGE } from "../shared/desktop-shell.js";
import type {
  DesktopShellEvent,
  DesktopShellRequest,
  DesktopShellResponse
} from "./renderer-shell-contract.js";

interface DesktopWindowApi {
  connect(): void;
  shell?: {
    request(request: DesktopShellRequest): Promise<DesktopShellResponse>;
    onEvent(listener: (event: DesktopShellEvent) => void): () => void;
  };
}

declare global {
  interface Window {
    desktop?: DesktopWindowApi;
  }
}

export async function createRendererApi(onRecoveryWarnings?: DesktopTransportOptions["onRecoveryWarnings"]): Promise<StoryApi> {
  const port = await receivePort();
  return storyApiFromWorkerTransport(new DesktopTransport(port, { onRecoveryWarnings }));
}

export function desktopShell(): DesktopWindowApi["shell"] {
  return window.desktop?.shell;
}

async function receivePort(): Promise<MessagePort> {
  if (window.desktop === undefined) throw new Error("The desktop preload API is missing.");
  return await new Promise<MessagePort>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      window.removeEventListener("message", receive);
      reject(new Error("Timed out waiting for the desktop Host."));
    }, 10_000);
    const receive = (event: MessageEvent<unknown>): void => {
      const message = event.data;
      if (message === null || typeof message !== "object" || (message as { type?: unknown }).type !== DESKTOP_PORT_WINDOW_MESSAGE) return;
      const port = event.ports[0];
      if (port === undefined) return;
      window.clearTimeout(timeout);
      window.removeEventListener("message", receive);
      resolve(port);
    };
    window.addEventListener("message", receive);
    window.desktop?.connect();
  });
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
