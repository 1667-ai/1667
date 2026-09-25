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

/**
 * Starts one connection attempt and returns a disposer (review fix A1).
 * Disposing drops this attempt's outcome and its `onClose`/`onRecoveryWarnings`
 * callbacks on the floor from then on, and closes the transport — whether
 * the attempt already connected, or connects anyway after being disposed
 * ("late"). `<StrictMode>`'s double-invoked effect (and Fast Refresh
 * re-running `app/bootstrap.ts`'s `start()`) must never leave a second
 * bridge socket open under the first one's back — the server caps live
 * sockets at 8.
 *
 * `onConnected` runs on every successful connect this attempt makes — not
 * just the first ever (review fix A2) — so `app/bootstrap.ts` can pass
 * `() => actions.library.refresh()` once and have it also fire after a
 * Reconnect.
 */
export function connect(store: Store<AppState>, onConnected: () => void): () => void {
  let disposed = false;
  let transport: WebBridgeTransport | null = null;

  void run();

  return () => {
    disposed = true;
    transport?.close();
  };

  async function run(): Promise<void> {
    const outcome = await connectWebBridge({
      location,
      storage: guardedSessionStorage(),
      clearTokenFragment: () => {
        history.replaceState(null, "", location.pathname + location.search);
      },
      fetch,
      WebSocket,
      onRecoveryWarnings: (warnings) => {
        if (disposed) return;
        store.set((state) => ({ ...state, recoveryWarnings: warnings }));
      },
      onClose: (error) => {
        if (disposed) return;
        store.set((state) => ({ ...state, connection: { kind: "closed", message: error.message } }));
      }
    });
    if (outcome.kind === "connected") transport = outcome.transport;
    if (disposed) {
      // A late connect: nothing observed this attempt's state changes (the
      // callbacks above already no-op), so the only thing left to undo is
      // the socket itself.
      transport?.close();
      return;
    }
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
    onConnected();
  }
}

/** Re-runs `connect` after resetting to `connecting` — the Closed overlay's
 * Reconnect button, and nothing else (no auto-reconnect loop). Returns a
 * fresh disposer for the new attempt; `app/bootstrap.ts` tracks whichever
 * one is current. */
export function reconnect(store: Store<AppState>, onConnected: () => void): () => void {
  store.set((state) => ({ ...state, connection: { kind: "connecting" } }));
  return connect(store, onConnected);
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
