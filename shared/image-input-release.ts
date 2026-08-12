/**
 * The one switch that decides whether this build WRITES the successor story
 * document that Image Input needs, and opens every user-facing image entry
 * point.
 *
 * 1667 releases a schema in two steps. A release learns to read and validate
 * a successor document and refuses to mutate it before any release writes
 * that document. That order means the previous stable executable can always
 * open a data directory the newest one wrote, so a writer can go back one
 * version without losing a story.
 *
 * This release writes the successor STORY document: a story upgrades the
 * moment it gains an Image Attachment, and every entry point that can
 * produce one (`attach image`, the attach panel, a clipboard image paste,
 * the staging and release routes, a Continue request naming a Draft Image)
 * is open while this constant is true.
 *
 * This release does NOT write the successor SETTINGS document. There is no
 * successor settings writer in this build at all, and no switch that could
 * turn one on: the gate that would enable a settings-schema-3 write can only
 * read a value from the schema-3 file already on disk, and that file can
 * only exist if the gate already fired, a closed loop no build could ever
 * satisfy honestly. The successor settings WRITER ships with the release
 * that can store a capability override, because only that release ever
 * holds the incoming value the decision needs.
 *
 * Deliberately not an environment variable. A writer who set one would produce
 * a document the previous stable executable cannot read, which is the exact
 * failure the two-step release exists to prevent. Tests that need the writing
 * behavior pass an explicit option to the store they build; see
 * `imageInputActivation` on `StoryStore`.
 */
export const IMAGE_INPUT_ACTIVATED = true;

/** Resolve the effective activation for one store. A caller that passes
 *  nothing gets the release default, so production wiring can never turn the
 *  successor writer on by accident. */
export function resolveImageInputActivation(option?: boolean): boolean {
  return option ?? IMAGE_INPUT_ACTIVATED;
}

/**
 * Whether a user-facing image entry point may run at all: the `attach
 * image` palette command, the attach panel, a clipboard image paste, the
 * staging and release HTTP routes and worker methods, and a Continue
 * request that names a Draft Image.
 *
 * Reads the same release switch as the document writers above, so a single
 * flip opens every entry point together. A caller that passes nothing gets
 * the release default, so production wiring can never open an entry point
 * by accident. A test that needs to exercise what is behind a closed entry
 * point passes an explicit option, the same way `resolveImageInputActivation`
 * tests do.
 */
export function imageInputEntryPointsOpen(option?: boolean): boolean {
  return option ?? IMAGE_INPUT_ACTIVATED;
}
