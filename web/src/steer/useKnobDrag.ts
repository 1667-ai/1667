import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { wordCountAt } from "./word-index.js";

/**
 * Pointer handlers that drag a knob along the words in `textRef`: the pointer
 * is captured, so the drag follows it outside the knob.
 */
export function useKnobDrag(textRef: RefObject<HTMLElement | null>, moveTo: (count: number) => void) {
  const [dragging, setDragging] = useState(false);
  const active = useRef(false);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    active.current = true;
    setDragging(true);
  }, []);

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const text = textRef.current;
    if (!active.current || text === null) return;
    moveTo(wordCountAt(text, event.clientX, event.clientY));
  }, [textRef, moveTo]);

  const end = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (!active.current) return;
    active.current = false;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }, []);

  return { dragging, handlers: { onPointerDown, onPointerMove, onPointerUp: end, onPointerCancel: end } };
}
