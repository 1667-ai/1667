import { useEffect, useRef } from "react";

/**
 * Runs `onRequest` each time `serial` rises above what this component last
 * saw. The first value a mount sees is not a request, and neither is `0`.
 * One way to turn a store counter ("open this part's menu") into an event
 * without keeping the event itself in state.
 */
export function useRequestSignal(serial: number, onRequest: () => void): void {
  const seen = useRef(serial);
  const handler = useRef(onRequest);
  handler.current = onRequest;
  useEffect(() => {
    if (serial === seen.current) return;
    seen.current = serial;
    if (serial > 0) handler.current();
  }, [serial]);
}
