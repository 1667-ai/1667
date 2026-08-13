/**
 * The one switch that decides whether this build WRITES the Aside story
 * document field and opens every user-facing Aside entry point.
 *
 * 1667 releases a schema in two steps. A release learns to read and validate
 * a successor document and refuses to mutate it before any release writes
 * that document. That order means the previous stable executable can always
 * open a data directory the newest one wrote.
 *
 * This predecessor release reads the Aside successor STORY document but does
 * not write it. It also keeps `/aside`, the Command Palette entry, and the
 * askAside / clearAside / getAside surfaces closed. The successor release can
 * open all writes and entry points by changing this one constant.
 *
 * Deliberately not an environment variable. A writer who set one would produce
 * a document the previous stable executable cannot read.
 */
export const ASIDE_ACTIVATED = false;

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
