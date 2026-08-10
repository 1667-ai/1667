import { AI_1667_PRODUCT_VERSION } from "../../shared/build-identity.js";
import { compareSemVer } from "../../shared/semver.js";
import { RELEASE_NOTES, type ReleaseNote } from "../../shared/release-notes.js";
import type { AppSource } from "./app.js";
import { loadConfigWithStatus, saveConfig, type ConfigLoadStatus, type ConfigPersistenceOptions } from "./config.js";
import { recordNotice } from "./notice-log.js";
import type { RuntimeState } from "./state.js";

export interface ReleaseAnnouncement {
  readonly toast: string;
  readonly body: string;
}

/**
 * What the config file means for this run.
 *
 * `announceRelease` stamps `lastRunVersion` on every interactive run, so any
 * build carrying this feature always leaves it set. A config file that
 * parses but carries no `lastRunVersion` can only have been written by a
 * build older than this feature: an upgrade from a version we cannot name.
 * A missing config file is a genuinely new install. A config file that
 * exists but could not be read or parsed is neither — see `announceRelease`,
 * which refuses to touch it.
 */
export type LastRun =
  | { readonly kind: "fresh" }
  | { readonly kind: "unknown" }
  | { readonly kind: "unreadable" }
  | { readonly kind: "version"; readonly version: string };

function classifyLastRun(status: ConfigLoadStatus, lastRunVersion: string | null): LastRun {
  if (status === "unreadable") return { kind: "unreadable" };
  if (status === "absent") return { kind: "fresh" };
  return lastRunVersion === null ? { kind: "unknown" } : { kind: "version", version: lastRunVersion };
}

/**
 * What to tell a writer about the build they just started, if anything. Pure
 * and side-effect free: `announceRelease` decides whether and how to show
 * the result, this only decides what it would say.
 *
 * `logKeyLive` says whether `!` opens the log in the mode the writer is in
 * right now (NAV and MAP; not COMPOSE, where `!` is a character) — the
 * wording names the real route rather than assuming one, so the caller
 * supplies it instead of this pure function reading `state.mode` itself.
 */
export function releaseAnnouncement(
  lastRun: LastRun,
  currentVersion: string,
  logKeyLive: boolean,
  notes: readonly ReleaseNote[] = RELEASE_NOTES
): ReleaseAnnouncement | null {
  if (lastRun.kind === "fresh" || lastRun.kind === "unreadable") return null;
  if (lastRun.kind === "unknown") return unknownUpgradeAnnouncement(currentVersion, logKeyLive, notes);

  // Covers both an exact repeat run and a downgrade or sideways move: either
  // way `compareSemVer(currentVersion, lastRun.version)` is `<= 0`.
  if (compareSemVer(currentVersion, lastRun.version) <= 0) return null;
  const selected = notes.filter((note) =>
    compareSemVer(note.version, lastRun.version) > 0
    && compareSemVer(note.version, currentVersion) <= 0);
  if (selected.length === 0) return null;

  return {
    toast: toastFor(currentVersion, logKeyLive),
    body: [
      `1667 ${currentVersion} · what changed since ${lastRun.version}`,
      ...selected.map(noteText)
    ].join("\n\n")
  };
}

/** An upgrade from a build that predates this feature. We do not know where
 *  this writer's build came from, so we do not guess a range — only the note
 *  for the exact version they landed on, if one exists. */
function unknownUpgradeAnnouncement(
  currentVersion: string,
  logKeyLive: boolean,
  notes: readonly ReleaseNote[]
): ReleaseAnnouncement | null {
  const match = notes.find((note) => note.version === currentVersion);
  if (match === undefined) return null;
  return {
    toast: toastFor(currentVersion, logKeyLive),
    body: [`1667 ${currentVersion} · what changed in this version`, noteText(match)].join("\n\n")
  };
}

function toastFor(currentVersion: string, logKeyLive: boolean): string {
  // `!` opens the log directly in NAV and MAP (reference-bindings.ts's
  // navOpenLog/mapOpenLog). COMPOSE reads `!` as a character in the draft
  // instead, so that variant names the route out first — the same
  // "esc then !" wording composer-chrome.ts's own NOTICE_OVERFLOW uses for
  // the identical problem. `announceRelease` only calls this from a freshly
  // opened session, whose composer is never fullscreen (see `createComposer`
  // in composer-model.ts), so one `esc` always reaches NAV —
  // `composeAction`'s cancel branch (story-actions.ts) only spends a first
  // `esc` closing fullscreen otherwise.
  return logKeyLive
    ? `Updated to ${currentVersion} · press ! for what changed`
    : `Updated to ${currentVersion} · esc then ! for what changed`;
}

function noteText(note: ReleaseNote): string {
  return `${note.version} — ${note.date}\n${note.body}`;
}

/**
 * Stamp the version this run used, and announce what changed since the
 * version this writer last ran, if there is anything to say. This is the one
 * seam that reads the config file, decides, stamps, and announces — kept
 * together so the read and the write that follows it can never drift out of
 * order across files.
 *
 * A demo source never touches disk and never speaks past the tour's own
 * script. `options` lets tests redirect the config file; production leaves
 * it at the default, the real config path.
 */
export function announceRelease(
  state: RuntimeState,
  source: AppSource,
  options: ConfigPersistenceOptions = {},
  notes: readonly ReleaseNote[] = RELEASE_NOTES
): void {
  if (source.demo) return;
  // Read fresh rather than trusting `source.config.lastRunVersion`: that
  // value already went through `loadConfig`, which collapses "absent" and
  // "unreadable" to the same silent defaults. Only a fresh read carries the
  // distinction `classifyLastRun` needs.
  const { status } = loadConfigWithStatus(options);
  const lastRun = classifyLastRun(status, source.config.lastRunVersion);
  if (lastRun.kind === "unreadable") {
    // A config we could not read is a config we must not overwrite: it may
    // be the writer's only copy of their settings, and it may still be
    // repairable by hand. Stamping here would persist `source.config`'s
    // already-defaulted values over it, turning a recoverable parse error
    // into a silent loss. Announce nothing either — there is nothing to
    // compare against with any confidence.
    return;
  }

  const currentVersion = AI_1667_PRODUCT_VERSION;
  const logKeyLive = state.mode === "NAV" || state.mode === "MAP";
  const announcement = releaseAnnouncement(lastRun, currentVersion, logKeyLive, notes);

  // Unconditional (for every case but `unreadable`, already returned above):
  // a version with no notes for this writer's range must still be recorded,
  // or every later launch of this same build would repeat the check forever.
  if (source.config.lastRunVersion !== currentVersion) {
    // Same mutation shape as story-actions.ts's toggle-rail action: update
    // both copies state and source share, then persist.
    source.config = { ...source.config, lastRunVersion: currentVersion };
    state.config = source.config;
    saveConfig(source.config, options);
  }

  if (announcement === null) return;
  // Never clobber a toast startup already raised for another reason.
  if (state.toast === null) state.toast = announcement.toast;
  // The toast holds a few rows; the announcement's full body does not. This
  // is the same split the archive-import fidelity report uses: the toast
  // headline, and the whole account written to the log directly.
  recordNotice(state.notices, "toast", announcement.body);
}
