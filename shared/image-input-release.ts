/**
 * The one switch that decides whether this build WRITES the successor story
 * and settings documents that Image Input needs.
 *
 * 1667 releases a schema in two steps. The first release learns to read and
 * validate the successor documents and refuses to mutate them. Only the next
 * release writes them. That order means the previous stable executable can
 * always open a data directory the newest one wrote, so a writer can go back
 * one version without losing a story.
 *
 * This release is the first step. It carries the whole Image Input
 * implementation and writes neither successor document. Every image entry
 * point stays closed while this constant is false.
 *
 * Deliberately not an environment variable. A writer who set one would produce
 * a document the previous stable executable cannot read, which is the exact
 * failure the two-step release exists to prevent. Tests that need the writing
 * behavior pass an explicit option to the store they build; see
 * `imageInputActivation` on the story and settings store options.
 */
export const IMAGE_INPUT_ACTIVATED = false;

/** Resolve the effective activation for one store. A caller that passes
 *  nothing gets the release default, so production wiring can never turn the
 *  successor writer on by accident. */
export function resolveImageInputActivation(option?: boolean): boolean {
  return option ?? IMAGE_INPUT_ACTIVATED;
}
