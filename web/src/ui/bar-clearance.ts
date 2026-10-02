import { useCallback } from "react";

/**
 * The bottom bars (the story's composer bar, the Library's generation bar,
 * the unsaved bar on a connection screen) publish their height as
 * `--bar-height` on the root element, so the toasts (`styles/toast.css`)
 * sit just above the bar and never cover the composer. With no bar on
 * screen the property is removed and the toasts use their normal margin.
 */
const heights = new Map<Element, number>();

function publish(): void {
  const height = Math.max(0, ...heights.values());
  const root = document.documentElement.style;
  if (height > 0) root.setProperty("--bar-height", `${Math.ceil(height)}px`);
  else root.removeProperty("--bar-height");
}

/** A callback ref for one bottom bar's root element. */
export function useBarClearance(): (element: HTMLElement | null) => (() => void) | undefined {
  return useCallback((element: HTMLElement | null) => {
    if (element === null) return undefined;
    const observer = new ResizeObserver(() => {
      heights.set(element, element.getBoundingClientRect().height);
      publish();
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      heights.delete(element);
      publish();
    };
  }, []);
}
