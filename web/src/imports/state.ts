/**
 * File imports (#409 step 10i). The only state is the result dialog: what an
 * import added and what it left out (its Fidelity Report), and whether an
 * import is running. A story file makes a new story and opens it; a character
 * card or an archive adds Facts to the open story.
 */
export interface ImportReport {
  readonly heading: string;
  /** One line about the result, e.g. "3 Facts · 2 keyed · 1 always". */
  readonly summary: string;
  /** The Facts the import added (names), if it added Facts. */
  readonly facts: readonly string[];
  /** What the import left out or changed: the Fidelity Report lines. */
  readonly leftOut: readonly string[];
}

export interface ImportsState {
  readonly report: ImportReport | null;
  /** An import is reading its file or waiting for the backend. */
  readonly busy: boolean;
}

export function initialImportsState(): ImportsState {
  return { report: null, busy: false };
}
