import {
  openWebBridgeTransport,
  webBridgeProtocols,
  webBridgeUrl,
  type WebBridgeSocket,
  type WebBridgeTransport
} from "./web-bridge-transport.js";
import type { BridgeRecoveryWarning } from "../shared/web-bridge-protocol.js";

const TOKEN_STORAGE_KEY = "1667.web.token";

/** The subset of DOM `Location` this helper reads. */
export interface WebBridgeLocation {
  readonly hash: string;
  readonly host: string;
  readonly pathname: string;
  readonly search: string;
}

/** The subset of DOM `Storage` this helper needs, matching `sessionStorage`'s
 * shape — a real browser can refuse it in private browsing, so every call
 * site here wraps its use in a `try`. */
export interface WebBridgeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface WebBridgeStatus {
  readonly project: string;
  readonly version: string;
}

export type ConnectWebBridgeOutcome =
  | {
      readonly kind: "connected";
      readonly status: WebBridgeStatus;
      readonly transport: WebBridgeTransport;
      readonly recoveryWarnings: readonly BridgeRecoveryWarning[];
    }
  /** No usable token: the fragment carried none, and nothing was in
   * `storage` from an earlier visit, or `/api/status` rejected the one that
   * was. The page's only move is to tell the owner to open the URL the CLI
   * printed. */
  | { readonly kind: "locked" }
  | { readonly kind: "failed"; readonly error: Error };

export interface ConnectWebBridgeOptions {
  readonly location: WebBridgeLocation;
  readonly storage: WebBridgeStorage;
  /** Clears a token read from the URL fragment once it is safely in
   * `storage`, so a reload never resends it as part of the URL — the same
   * thing `history.replaceState(null, "", location.pathname + location.search)`
   * did before this sequence moved here. Its own dependency because
   * `location` alone has no side-effect-free way to do this (setting
   * `location.hash = ""` can leave a trailing "#" in some browsers). */
  readonly clearTokenFragment: () => void;
  readonly fetch: typeof fetch;
  /** `string[]`, matching DOM `WebSocket`'s own constructor exactly (not
   * `readonly string[]`): the real global is assigned here as-is. */
  readonly WebSocket: new (url: string, protocols: string[]) => WebBridgeSocket;
  /** Forwarded to `openWebBridgeTransport` — fires only for a `recoveryWarnings`
   * frame after `hello`; the `hello` snapshot itself comes back on
   * `recoveryWarnings` in a `"connected"` outcome. */
  readonly onRecoveryWarnings?: (warnings: readonly BridgeRecoveryWarning[]) => void;
  readonly onClose?: (error: Error) => void;
}

/** Read the per-run token: the URL fragment first (and only once —
 * `clearTokenFragment` runs immediately after), then `storage` for a
 * reload. */
function readToken(options: ConnectWebBridgeOptions): string | null {
  const fromHash = new URLSearchParams(options.location.hash.replace(/^#/, "")).get("token");
  if (fromHash !== null) {
    try {
      options.storage.setItem(TOKEN_STORAGE_KEY, fromHash);
    } catch {
      // Private browsing can refuse storage; the fragment already carried it.
    }
    options.clearTokenFragment();
    return fromHash;
  }
  try {
    return options.storage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * The whole "can this tab reach the backend" sequence a page needs before it
 * can render anything real: find the per-run token, confirm it against
 * `/api/status`, then open the WebSocket bridge. `web/src/main.ts` (step 2)
 * ran these three steps inline; they move here so step 3's React shell
 * reuses them instead of reimplementing this page's bootstrap. Every DOM
 * capability this needs is a parameter, never a direct global reference, so
 * it stays callable from a sandbox that supplies no `fetch`, `WebSocket`, or
 * storage of its own (`test/client-browser.integration.test.ts`).
 */
export async function connectWebBridge(
  options: ConnectWebBridgeOptions
): Promise<ConnectWebBridgeOutcome> {
  const token = readToken(options);
  if (token === null) return { kind: "locked" };

  let statusResponse: Response;
  try {
    // Call `fetch` detached: invoked as `options.fetch(...)` its receiver is
    // `options`, and a browser's fetch throws "Illegal invocation" unless
    // its receiver is the window (or undefined).
    const fetchStatus = options.fetch;
    statusResponse = await fetchStatus("/api/status", {
      headers: { authorization: `Bearer ${token}` }
    });
  } catch (error) {
    return { kind: "failed", error: asError(error) };
  }
  if (statusResponse.status === 401) return { kind: "locked" };
  if (!statusResponse.ok) {
    return {
      kind: "failed",
      error: new Error(`1667 web: /api/status returned ${statusResponse.status}`)
    };
  }
  const status = await statusResponse.json() as WebBridgeStatus;

  try {
    const socket = new options.WebSocket(webBridgeUrl(options.location), webBridgeProtocols(token));
    const { transport, recoveryWarnings } = await openWebBridgeTransport(socket, {
      ...(options.onRecoveryWarnings === undefined ? {} : { onRecoveryWarnings: options.onRecoveryWarnings }),
      ...(options.onClose === undefined ? {} : { onClose: options.onClose })
    });
    return { kind: "connected", status, transport, recoveryWarnings };
  } catch (error) {
    return { kind: "failed", error: asError(error) };
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
