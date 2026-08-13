/**
 * The one switch that decides whether this build WRITES the Aside story
 * document field and opens every user-facing Aside entry point.
 *
 * 1667 releases a schema in two steps. Version 0.9.4-rc.4 learned to read and
 * validate the successor document and refused to mutate it. This release can
 * now write that document and open every Aside entry point.
 *
 * Deliberately not an environment variable. A build must not write successor
 * data before its predecessor release can read it.
 */
export const ASIDE_ACTIVATED = true;

/** Resolve the effective activation for one store. A caller that passes
 *  nothing gets the release default. */
export function resolveAsideActivation(option?: boolean): boolean {
  return option ?? ASIDE_ACTIVATED;
}

/**
 * Whether a user-facing Aside entry point may run at all: `/aside`, the
 * Command Palette entry, askAside, clearAside, and getAside routes.
 */
export function asideEntryPointsOpen(option?: boolean): boolean {
  return option ?? ASIDE_ACTIVATED;
}
