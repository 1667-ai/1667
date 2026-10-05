/** Starts a lazy view's download ahead of its first use. A view registers
 * itself by name; the action code, which cannot import a view, asks by name. */
const preloads = new Map<string, () => void>();

export function registerPreload(name: string, start: () => void): void {
  preloads.set(name, start);
}

export function preload(name: string): void {
  preloads.get(name)?.();
}

/** Starts these downloads when the browser is idle: the views a writer opens
 * with a key, so the first press finds them already there. Returns a canceller. */
export function preloadWhenIdle(names: readonly string[]): () => void {
  const start = (): void => { for (const name of names) preload(name); };
  if (typeof requestIdleCallback === "function") {
    const id = requestIdleCallback(start, { timeout: 4_000 });
    return () => cancelIdleCallback(id);
  }
  const timer = setTimeout(start, 2_000);
  return () => clearTimeout(timer);
}
