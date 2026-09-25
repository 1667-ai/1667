import {
  connectWebBridge,
  type WebBridgeStatus,
  type WebBridgeStorage
} from "../../../client/web-bridge-connect.js";
import { storyApiFromWorkerTransport } from "../../../client/worker-story-api.js";
import type { StoryApi } from "../../../client/api.js";
import type { WebBridgeTransport } from "../../../client/web-bridge-transport.js";
import type { AppState } from "./state.js";
import type { Store } from "./store.js";

/**
 * Moved here from step 2's `web/src/main.ts`: the guarded `sessionStorage`
 * adapter, `clearTokenFragment`, and `onClose`. Screens for each state live
 * in `ui/ConnectionScreens.tsx`. There is no auto-reconnect loop — only the
 * Closed overlay's Reconnect button calls `reconnect`, which re-runs
 * `connectWebBridge` from scratch (a restarted server has a new port and
 * token, so a stale connection attempt can only ever land on `locked`, never
 * silently resume).
 */
export type ConnectionState =
  | { readonly kind: "connecting" }
  | { readonly kind: "locked" }
  | { readonly kind: "failed"; readonly message: string }
  | {
      readonly kind: "connected";
      readonly status: WebBridgeStatus;
      readonly api: StoryApi;
      readonly transport: WebBridgeTransport;
    }
  | { readonly kind: "closed"; readonly message: string };

export function startConnection(store: Store<AppState>): void {
  void connect(store);
}

export function reconnect(store: Store<AppState>): void {
  store.set((state) => ({ ...state, connection: { kind: "connecting" } }));
  void connect(store);
}

async function connect(store: Store<AppState>): Promise<void> {
  const outcome = await connectWebBridge({
    location,
    storage: guardedSessionStorage(),
    clearTokenFragment: () => {
      history.replaceState(null, "", location.pathname + location.search);
    },
    fetch,
    WebSocket,
    onRecoveryWarnings: (warnings) => {
      store.set((state) => ({ ...state, recoveryWarnings: warnings }));
    },
    onClose: (error) => {
      store.set((state) => ({ ...state, connection: { kind: "closed", message: error.message } }));
    }
  });
  if (outcome.kind === "locked") {
    store.set((state) => ({ ...state, connection: { kind: "locked" } }));
    return;
  }
  if (outcome.kind === "failed") {
    store.set((state) => ({
      ...state,
      connection: { kind: "failed", message: outcome.error.message }
    }));
    return;
  }
  const api = storyApiFromWorkerTransport(outcome.transport);
  store.set((state) => ({
    ...state,
    connection: {
      kind: "connected",
      status: outcome.status,
      api,
      transport: outcome.transport
    },
    recoveryWarnings: outcome.recoveryWarnings
  }));
}

function guardedSessionStorage(): WebBridgeStorage {
  return {
    getItem: (key) => {
      try {
        return sessionStorage.getItem(key);
      } catch {
        return null;
      }
    },
    setItem: (key, value) => {
      try {
        sessionStorage.setItem(key, value);
      } catch {
        // Private browsing can refuse storage; the fragment already carried it.
      }
    }
  };
}
