import { compareSemVer } from "../../shared/semver.js";
import { RELEASE_NOTES, type ReleaseNote } from "../../shared/release-notes.js";

export interface ReleaseAnnouncement {
  readonly toast: string;
  readonly body: string;
}

/**
 * What to tell a writer about the build they just started, if anything. Pure
 * and side-effect free: the caller decides whether and how to show the
 * result (see `app.ts`), this only decides what it would say.
 *
 * Returns null for a first run (`lastRunVersion` is null — a new writer must
 * not be shown a history of changes they never lived through), a repeat run,
 * a downgrade or sideways move, or an upgrade whose range has no release
 * note to show.
 *
 * Otherwise selects every note strictly newer than `lastRunVersion` and no
 * newer than `currentVersion`, newest first, and builds a short toast plus
 * the full text for the log.
 */
export function releaseAnnouncement(
  lastRunVersion: string | null,
  currentVersion: string,
  notes: readonly ReleaseNote[] = RELEASE_NOTES
): ReleaseAnnouncement | null {
  if (lastRunVersion === null) return null;
  // Covers both an exact repeat run and a downgrade or sideways move: either
  // way `compareSemVer(currentVersion, lastRunVersion)` is `<= 0`.
  if (compareSemVer(currentVersion, lastRunVersion) <= 0) return null;

  const selected = notes.filter((note) =>
    compareSemVer(note.version, lastRunVersion) > 0
    && compareSemVer(note.version, currentVersion) <= 0);
  if (selected.length === 0) return null;

  // The log opens with `!` (see reference-bindings.ts), so the toast names
  // that key rather than describing what it does.
  const toast = `Updated to ${currentVersion} · press ! for what changed`;
  const body = [
    `1667 ${currentVersion} · what changed since ${lastRunVersion}`,
    ...selected.map((note) => `${note.version} — ${note.date}\n${note.body}`)
  ].join("\n\n");
  return { toast, body };
}
