/**
 * Demo mode never loads the real WASM tokenizer — it stays out of the TUI's
 * render process even in the real backend (see shared/worker-protocol.ts for
 * why `tokenizeSamplingPhrase` still crosses the worker boundary there).
 * This fabricates plausible-looking token IDs from a phrase so the sampling
 * editor's preview has something to show while demoing offline; the numbers
 * are not real tokenizer output and must never reach a provider request.
 */
export function demoTokenIds(phrase: string): readonly number[] {
  return phrase
    .split(/\s+/u)
    .filter((word) => word.length > 0)
    .map((word) => {
      let hash = 0;
      for (let index = 0; index < word.length; index += 1) {
        hash = (Math.imul(hash, 31) + word.charCodeAt(index)) >>> 0;
      }
      return hash % 200_000;
    });
}
