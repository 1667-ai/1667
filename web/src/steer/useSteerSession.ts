import { useEffect, useState, useSyncExternalStore } from "react";
import type { PreviewSource } from "./preview-stream.js";
import { createSteerSession, type SteerSession, type SteerSnapshot } from "./steer-session.js";

/**
 * A steer session that lives as long as the component and asks the server
 * for text while it is mounted. Leaving the page aborts the running request.
 */
export function useSteerSession(source: PreviewSource): { readonly session: SteerSession; readonly snapshot: SteerSnapshot } {
  const [session] = useState(() => createSteerSession(source));
  useEffect(() => {
    session.start();
    return () => session.dispose();
  }, [session]);
  const snapshot = useSyncExternalStore(session.subscribe, session.snapshot);
  return { session, snapshot };
}
