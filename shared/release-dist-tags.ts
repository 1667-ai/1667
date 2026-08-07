/**
 * The npm dist-tag that each installation channel reads.
 *
 * `npm publish` writes the dist-tag inside its Trusted Publishing exchange, and
 * this project holds no credential that can move a dist-tag after publication.
 * The dist-tags a release writes are therefore the only dist-tags that stay
 * current: a prerelease writes `beta`, and every other release writes `latest`.
 *
 * No release writes a dist-tag with the name `stable`. A client that reads a
 * dist-tag with that name reads whatever a person set by hand, which is why the
 * stable channel reads `latest`. The publisher and the client both read this
 * map, so the two cannot disagree about the dist-tag for a channel.
 */
export const CHANNEL_DIST_TAG = Object.freeze({
  stable: "latest",
  beta: "beta"
} as const);

/** The channels an installation can follow. */
export type ReleaseChannel = keyof typeof CHANNEL_DIST_TAG;

/** The dist-tag to read for one channel. */
export function distTagForChannel<Channel extends ReleaseChannel>(
  channel: Channel
): (typeof CHANNEL_DIST_TAG)[Channel] {
  return CHANNEL_DIST_TAG[channel];
}
