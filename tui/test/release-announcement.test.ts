import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AI_1667_PRODUCT_VERSION } from "../../shared/build-identity.js";
import type { ReleaseNote } from "../../shared/release-notes.js";
import { initialState } from "../src/app.js";
import {
  loadConfig,
  loadConfigWithStatus,
  normalizeUserConfig,
  saveConfig
} from "../src/config.js";
import { demoAppSource } from "../src/demo.js";
import { recordSessionNotices } from "../src/notice-log.js";
import { announceRelease, releaseAnnouncement, type LastRun } from "../src/release-announcement.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { frameText } from "../src/screens/story/frame.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

async function scratchConfigFile(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "1667-release-announcement-"));
  roots.push(root);
  return path.join(root, "config.json");
}

// A fixed fixture, independent of the real CHANGELOG.md, so this suite does
// not drift when the changelog gains entries. Newest first, matching the
// invariant `shared/release-notes.ts` guarantees.
const NOTES: readonly ReleaseNote[] = [
  { version: "1.3.0", date: "2026-03-01", body: "third note body" },
  { version: "1.2.0", date: "2026-02-01", body: "second note body" },
  { version: "1.1.0", date: "2026-01-01", body: "first note body" }
];

const FRESH: LastRun = { kind: "fresh" };
const UNKNOWN: LastRun = { kind: "unknown" };
const UNREADABLE: LastRun = { kind: "unreadable" };
const atVersion = (version: string): LastRun => ({ kind: "version", version });
/** `!` opens the log in NAV/MAP; the pure tests that are not specifically
 *  about wording use this so the toast shape stays out of the way. */
const LOG_KEY_LIVE = true;

// `announceRelease` always reads the real running build's version, so its
// fixtures bracket the real `AI_1667_PRODUCT_VERSION` rather than an
// arbitrary one.
const WIRING_NOTES: readonly ReleaseNote[] = [
  { version: AI_1667_PRODUCT_VERSION, date: "2026-08-10", body: "current release body" },
  { version: "0.0.5", date: "2026-07-01", body: "intervening release body" }
];
const EXPECTED_TOAST = `Updated to ${AI_1667_PRODUCT_VERSION} · press ! for what changed`;
const EXPECTED_COMPOSE_TOAST = `Updated to ${AI_1667_PRODUCT_VERSION} · esc then ! for what changed`;
// `announceRelease` defaults `packaged` to the real build identity, which
// under `bun test` is always "source" (see shared/build-identity.ts) — a
// source build never stamps or announces. Every wiring test below drives
// the packaged path explicitly instead.
const PACKAGED = true;

function wiringSource(file: string, demo = false) {
  const base = demoAppSource();
  return { ...base, demo, config: loadConfig({ file }) };
}

describe("releaseAnnouncement (pure)", () => {
  test("a first run (fresh install) announces nothing", () => {
    expect(releaseAnnouncement(FRESH, "1.3.0", LOG_KEY_LIVE, NOTES)).toBeNull();
  });

  test("an unreadable config announces nothing — there is nothing to compare against safely", () => {
    expect(releaseAnnouncement(UNREADABLE, "1.3.0", LOG_KEY_LIVE, NOTES)).toBeNull();
  });

  test("a repeat run at the same version announces nothing", () => {
    expect(releaseAnnouncement(atVersion("1.3.0"), "1.3.0", LOG_KEY_LIVE, NOTES)).toBeNull();
  });

  test("a downgrade announces nothing", () => {
    expect(releaseAnnouncement(atVersion("1.3.0"), "1.2.0", LOG_KEY_LIVE, NOTES)).toBeNull();
  });

  test("an upgrade whose range has no matching notes announces nothing", () => {
    expect(releaseAnnouncement(atVersion("1.3.0"), "1.4.0", LOG_KEY_LIVE, NOTES)).toBeNull();
  });

  test("an upgrade spanning several notes selects every one, newest first", () => {
    const announcement = releaseAnnouncement(atVersion("1.0.0"), "1.3.0", LOG_KEY_LIVE, NOTES);
    expect(announcement).not.toBeNull();
    expect(announcement!.toast).toBe("Updated to 1.3.0 · press ! for what changed");
    expect(announcement!.body).toContain("1667 1.3.0 · what changed since 1.0.0");
    // Every intervening release's body must survive into the log text.
    expect(announcement!.body).toContain("third note body");
    expect(announcement!.body).toContain("second note body");
    expect(announcement!.body).toContain("first note body");
    // Newest first.
    expect(announcement!.body.indexOf("third note body"))
      .toBeLessThan(announcement!.body.indexOf("first note body"));
  });

  test("an upgrade selects only notes inside (lastRunVersion, currentVersion]", () => {
    const announcement = releaseAnnouncement(atVersion("1.1.0"), "1.2.5", LOG_KEY_LIVE, NOTES);
    expect(announcement).not.toBeNull();
    expect(announcement!.body).toContain("second note body");
    expect(announcement!.body).not.toContain("first note body");
    expect(announcement!.body).not.toContain("third note body");
  });

  describe("an upgrade from a build older than this feature (unknown)", () => {
    test("announces only the note for the exact version landed on, not a guessed range", () => {
      const announcement = releaseAnnouncement(UNKNOWN, "1.2.0", LOG_KEY_LIVE, NOTES);
      expect(announcement).not.toBeNull();
      // The toast stays exactly the same shape as the known-version case.
      expect(announcement!.toast).toBe("Updated to 1.2.0 · press ! for what changed");
      expect(announcement!.body).toContain("1667 1.2.0 · what changed in this version");
      expect(announcement!.body).not.toContain("what changed since");
      expect(announcement!.body).toContain("second note body");
      expect(announcement!.body).not.toContain("first note body");
      expect(announcement!.body).not.toContain("third note body");
    });

    test("announces nothing when no note matches the current version exactly", () => {
      expect(releaseAnnouncement(UNKNOWN, "1.2.5", LOG_KEY_LIVE, NOTES)).toBeNull();
    });
  });

  describe("the toast names the real route to the log", () => {
    test("names ! directly when the log key is live (NAV/MAP)", () => {
      const announcement = releaseAnnouncement(atVersion("1.0.0"), "1.3.0", true, NOTES);
      expect(announcement!.toast).toBe("Updated to 1.3.0 · press ! for what changed");
    });

    test("names esc first when the log key is not live (COMPOSE, where ! is a character)", () => {
      const announcement = releaseAnnouncement(atVersion("1.0.0"), "1.3.0", false, NOTES);
      expect(announcement!.toast).toBe("Updated to 1.3.0 · esc then ! for what changed");
    });
  });
});

describe("announceRelease (wiring)", () => {
  test("an upgrade with notes raises the toast and puts the full body in the log", async () => {
    const file = await scratchConfigFile();
    saveConfig(normalizeUserConfig({ lastRunVersion: "0.0.1" }), { file });
    const source = wiringSource(file);
    const state = initialState(source, false);
    expect(state.toast).toBeNull();

    announceRelease(state, source, { file }, WIRING_NOTES, PACKAGED);

    expect(state.toast).toBe(EXPECTED_TOAST);
    // Simulate the repaint that runs right after this call in
    // `runInteractive`, the same way the archive-import fidelity report
    // test does.
    recordSessionNotices(state);
    // Exactly one entry: the toast headline is deliberately not recorded a
    // second time (`announceRelease` marks it already-seen). It carries
    // nothing the body doesn't already say, and a second entry would land
    // above the body and steal focus onto a sentence that only repeats the
    // toast the writer already read.
    expect(state.notices.entries).toHaveLength(1);
    const [body] = state.notices.entries;
    expect(body!.text).toContain("current release body");
    expect(body!.text).toContain("intervening release body");

    expect(source.config.lastRunVersion).toBe(AI_1667_PRODUCT_VERSION);
    expect(loadConfig({ file }).lastRunVersion).toBe(AI_1667_PRODUCT_VERSION);
  });

  // Regression: `saveConfig` swallows a read-only or full config directory
  // rather than throwing. Before this fix, `announceRelease` announced
  // anyway, breaking the one-shot promise: the next launch reads the same
  // unstamped file and announces again, forever.
  test("does not announce when the stamp fails to persist", async () => {
    const file = await scratchConfigFile();
    saveConfig(normalizeUserConfig({ lastRunVersion: "0.0.1" }), { file });
    const source = wiringSource(file);
    const state = initialState(source, false);

    announceRelease(state, source, {
      file,
      // config.ts's crash-injection seam, the same one config.test.ts uses,
      // firing after the durable temp write but before the rename that
      // would make it visible — a stand-in for a read-only or full
      // directory, without needing real filesystem permissions in a test.
      afterTemporaryFileSync: () => {
        throw new Error("simulated write failure");
      }
    }, WIRING_NOTES, PACKAGED);

    expect(state.toast).toBeNull();
    expect(state.notices.entries).toHaveLength(0);
    // The file on disk keeps the old version: the write never landed.
    expect(loadConfig({ file }).lastRunVersion).toBe("0.0.1");
    // In memory, too — we do not claim a stamp that did not persist.
    expect(source.config.lastRunVersion).toBe("0.0.1");
  });

  test("an upgrade whose range has no matching notes still stamps lastRunVersion", async () => {
    const file = await scratchConfigFile();
    saveConfig(normalizeUserConfig({ lastRunVersion: "0.0.1" }), { file });
    const source = wiringSource(file);
    const state = initialState(source, false);

    announceRelease(state, source, { file }, [], PACKAGED);

    expect(state.toast).toBeNull();
    expect(state.notices.entries).toHaveLength(0);
    expect(source.config.lastRunVersion).toBe(AI_1667_PRODUCT_VERSION);
    expect(loadConfig({ file }).lastRunVersion).toBe(AI_1667_PRODUCT_VERSION);
  });

  // Regression: a source build takes its version from package.json, which
  // routinely names a version with no release note yet (the maintainer runs
  // the source build routinely). Without this gate, that run would stamp
  // the unreleased version as seen, burning the real release's one
  // announcement before it even ships.
  test("a non-packaged (source) build neither stamps nor announces", async () => {
    const file = await scratchConfigFile();
    saveConfig(normalizeUserConfig({ lastRunVersion: "0.0.1" }), { file });
    const source = wiringSource(file);
    const state = initialState(source, false);

    // No `packaged` override: exercises the real default, which follows the
    // real build identity. `bun test` runs from source, so this is exactly
    // the case the gate exists for — the same as running `bun test` or
    // `bun src/standalone.ts` in this repo right now.
    announceRelease(state, source, { file }, WIRING_NOTES);

    expect(state.toast).toBeNull();
    expect(state.notices.entries).toHaveLength(0);
    // Neither the disk nor memory is touched.
    expect(loadConfig({ file }).lastRunVersion).toBe("0.0.1");
    expect(source.config.lastRunVersion).toBe("0.0.1");
  });

  // Regression: `stamped` started `true` whenever the disk already carried
  // `currentVersion`, and the in-memory sync lived only inside the branch
  // that ran a fresh write — so an already-current stamp (a concurrent
  // process, or an earlier phase of this same startup) was never adopted
  // into `source.config`/`state.config`. The next ordinary save that
  // session made would then write the stale in-memory version back over
  // the correct one on disk.
  test("a stamp already current on disk before this run is still adopted in memory", async () => {
    const file = await scratchConfigFile();
    // Simulate a concurrent process (or an earlier phase of this same
    // startup) having already stamped the current version, before this
    // call's own fresh read.
    saveConfig(normalizeUserConfig({ lastRunVersion: AI_1667_PRODUCT_VERSION }), { file });

    // This source's own in-memory snapshot predates that stamp, as if
    // main.ts's startup load ran before the concurrent write landed.
    const base = demoAppSource();
    const source = { ...base, demo: false, config: { ...base.config, lastRunVersion: "0.0.1" } };
    const state = initialState(source, false);

    announceRelease(state, source, { file }, WIRING_NOTES, PACKAGED);

    // Adopted in memory even though this call itself never wrote anything —
    // the disk was already correct when it read.
    expect(source.config.lastRunVersion).toBe(AI_1667_PRODUCT_VERSION);
    expect(state.config.lastRunVersion).toBe(AI_1667_PRODUCT_VERSION);

    // Proves it matters: an ordinary later save this session makes (a theme
    // change, a facts-rail toggle, recordHumanWords) must not revert the
    // file to the stale version this session started with.
    saveConfig(source.config, { file });
    expect(loadConfig({ file }).lastRunVersion).toBe(AI_1667_PRODUCT_VERSION);
  });

  test("a demo source neither stamps nor announces, and never touches disk", async () => {
    const file = await scratchConfigFile();
    // No config file exists yet: a demo run must not create one either.
    const source = wiringSource(file, true);
    source.config = { ...source.config, lastRunVersion: "0.0.1" };
    expect(source.demo).toBe(true);
    const state = initialState(source, false);

    announceRelease(state, source, { file }, WIRING_NOTES, PACKAGED);

    expect(state.toast).toBeNull();
    expect(state.notices.entries).toHaveLength(0);
    expect(source.config.lastRunVersion).toBe("0.0.1");
    expect(loadConfigWithStatus({ file }).status).toBe("absent");
  });

  test("a genuinely fresh install (no config file at all) announces nothing", async () => {
    const file = await scratchConfigFile();
    expect(loadConfigWithStatus({ file }).status).toBe("absent");
    const source = wiringSource(file);
    expect(source.config.lastRunVersion).toBeNull();
    const state = initialState(source, false);

    announceRelease(state, source, { file }, WIRING_NOTES, PACKAGED);

    expect(state.toast).toBeNull();
    expect(state.notices.entries).toHaveLength(0);
    // Still stamps: the next launch of this same build must not repeat the
    // check forever.
    expect(loadConfig({ file }).lastRunVersion).toBe(AI_1667_PRODUCT_VERSION);
  });

  // Regression: the bug this whole finding exists for. A config file written
  // by a build older than this feature has no `lastRunVersion` key, which
  // reads identically to a fresh install unless the file's own existence is
  // consulted too.
  test("an existing installation without lastRunVersion is treated as an upgrade, "
    + "not a fresh install", async () => {
    const file = await scratchConfigFile();
    // What every pre-feature build wrote: a config file with no
    // `lastRunVersion` key at all.
    saveConfig(normalizeUserConfig({ theme: "bond" }), { file });
    expect(loadConfigWithStatus({ file }).status).toBe("loaded");
    expect(loadConfig({ file }).lastRunVersion).toBeNull();

    const source = wiringSource(file);
    const state = initialState(source, false);

    announceRelease(state, source, { file }, WIRING_NOTES, PACKAGED);

    // Not silence: an existing installation gets the note for the exact
    // version it landed on, per the "unknown" case.
    expect(state.toast).toBe(EXPECTED_TOAST);
    recordSessionNotices(state);
    const texts = state.notices.entries.map((entry) => String(entry.text));
    expect(texts.some((text) => text.includes("current release body"))).toBe(true);
    // The unknown case never claims a range it does not know.
    expect(texts.some((text) => text.includes("what changed since"))).toBe(false);
    expect(loadConfig({ file }).lastRunVersion).toBe(AI_1667_PRODUCT_VERSION);
  });

  // Regression: the data-loss bug. Before this fix, `announceRelease` read
  // every load failure — missing file, unreadable file, malformed JSON —
  // as the same silent defaults, then stamped over whatever was on disk.
  // A hand-editing mistake (here, a trailing comma) must survive untouched:
  // the file is the writer's only copy of their settings, and it is still
  // repairable by hand as long as nothing overwrites it first.
  test("a malformed config.json survives announceRelease byte-for-byte, and nothing is announced", async () => {
    const file = await scratchConfigFile();
    const malformed = '{\n  "theme": "bond",\n}\n'; // trailing comma: invalid JSON
    await writeFile(file, malformed, "utf8");
    const before = await readFile(file, "utf8");
    expect(loadConfigWithStatus({ file }).status).toBe("unreadable");

    const source = wiringSource(file);
    const state = initialState(source, false);

    announceRelease(state, source, { file }, WIRING_NOTES, PACKAGED);

    expect(state.toast).toBeNull();
    expect(state.notices.entries).toHaveLength(0);
    const after = await readFile(file, "utf8");
    expect(after).toBe(before);
    // The status stays "unreadable": the file was never touched, let alone
    // stamped with a version that would make the next run call it "unknown".
    expect(loadConfigWithStatus({ file }).status).toBe("unreadable");
  });

  test("the toast names esc first when the writer started in COMPOSE, where ! types a character", async () => {
    const file = await scratchConfigFile();
    saveConfig(normalizeUserConfig({ lastRunVersion: "0.0.1" }), { file });
    const source = wiringSource(file);
    const state = initialState(source, false);
    state.mode = "COMPOSE";

    announceRelease(state, source, { file }, WIRING_NOTES, PACKAGED);

    expect(state.toast).toBe(EXPECTED_COMPOSE_TOAST);
  });

  // Regression: `~/.config/1667/config.json` is machine-global, not
  // per-project. A second 1667 process running a different project can
  // write to it between this process's own startup load and this call.
  // The stamp must land on top of that write, not revert it by persisting
  // the stale startup snapshot.
  test("stamping lastRunVersion does not revert a setting a concurrent process just wrote", async () => {
    const file = await scratchConfigFile();
    saveConfig(normalizeUserConfig({ lastRunVersion: "0.0.1", theme: "lantern" }), { file });
    // This process's own startup load — the snapshot `source.config` holds
    // for the rest of the session.
    const source = wiringSource(file);
    const state = initialState(source, false);
    expect(source.config.theme).toBe("lantern");

    // A second process, running a different project, changes a setting
    // after that load but before this process reaches announceRelease.
    saveConfig(normalizeUserConfig({ lastRunVersion: "0.0.1", theme: "bond" }), { file });

    announceRelease(state, source, { file }, WIRING_NOTES, PACKAGED);

    const persisted = loadConfig({ file });
    // The concurrent write survives...
    expect(persisted.theme).toBe("bond");
    // ...and the stamp still lands on top of it.
    expect(persisted.lastRunVersion).toBe(AI_1667_PRODUCT_VERSION);

    // In memory, only lastRunVersion changes: this session already rendered
    // its first frame from the "lantern" snapshot, and adopting "bond" here
    // would swap the live theme underneath it.
    expect(source.config.theme).toBe("lantern");
    expect(source.config.lastRunVersion).toBe(AI_1667_PRODUCT_VERSION);
  });
});

describe("the stamp makes the announcement one-shot", () => {
  test("after an announcing run, the config on disk carries the new lastRunVersion, "
    + "so a second run of the same build announces nothing", async () => {
    const file = await scratchConfigFile();
    saveConfig(normalizeUserConfig({ lastRunVersion: "0.0.1" }), { file });

    // Drive the real path once.
    const firstSource = wiringSource(file);
    const firstState = initialState(firstSource, false);
    announceRelease(firstState, firstSource, { file }, WIRING_NOTES, PACKAGED);
    expect(firstState.toast).toBe(EXPECTED_TOAST);

    // Drive it again, from a fresh state and a fresh read of exactly what
    // the first run persisted — not a hand-rolled copy of the stamp.
    const secondSource = wiringSource(file);
    expect(secondSource.config.lastRunVersion).toBe(AI_1667_PRODUCT_VERSION);
    const secondState = initialState(secondSource, false);
    announceRelease(secondState, secondSource, { file }, WIRING_NOTES, PACKAGED);

    expect(secondState.toast).toBeNull();
    expect(secondState.notices.entries).toHaveLength(0);
  });
});

describe("the announcement reaches a rendered frame", () => {
  test("an announcing run's toast appears in the rendered story screen", async () => {
    const file = await scratchConfigFile();
    saveConfig(normalizeUserConfig({ lastRunVersion: "0.0.1" }), { file });
    const source = wiringSource(file);
    const state = initialState(source, false);

    announceRelease(state, source, { file }, WIRING_NOTES, PACKAGED);
    expect(state.toast).toBe(EXPECTED_TOAST);

    const rendered = frameText(renderStoryScreen(state, {
      width: 120, height: 36, wrapCache: createWrapCache<ProseStyle>()
    }).lines);

    expect(rendered).toContain(`Updated to ${AI_1667_PRODUCT_VERSION}`);
    expect(rendered).toContain("press ! for what changed");
  });

  // Regression: the toast promises "press ! for what changed". Before this
  // fix, the log's own repaint re-recorded the toast headline as a second,
  // newer entry and focused that instead — so pressing `!` expanded the
  // sentence the writer had already read, with the actual notes collapsed
  // one row below. Asserted against the rendered frame, not the entries
  // array: the entries array is what let the earlier version of this test
  // believe the bug was the intended behavior.
  test("opening the log after an announcing run focuses the release notes, not the toast headline", async () => {
    const file = await scratchConfigFile();
    saveConfig(normalizeUserConfig({ lastRunVersion: "0.0.1" }), { file });
    const source = wiringSource(file);
    const state = initialState(source, false);

    announceRelease(state, source, { file }, WIRING_NOTES, PACKAGED);
    expect(state.toast).toBe(EXPECTED_TOAST);
    // The repaint that runs right after this call in `runInteractive`.
    recordSessionNotices(state);

    state.mode = "LOG";
    const rendered = frameText(renderStoryScreen(state, {
      width: 120, height: 36, wrapCache: createWrapCache<ProseStyle>()
    }).lines);

    // The one notice in the session is the release notes, expanded and
    // focused — not a second entry that only repeats the toast sentence.
    expect(rendered).toContain("1 notice this session");
    expect(rendered).toContain("current release body");
    expect(rendered).toContain("intervening release body");
    expect(rendered).not.toContain(EXPECTED_TOAST);
  });

  // The regression finding #2 exists for: a release-note body is routinely
  // longer than one screen (the real 0.1.2 section alone is about 200 lines),
  // so proving the toast renders is not proof the body is actually readable.
  // This opens the real log the toast points to and scrolls it, the same way
  // a writer would, to reach a marker planted at the very end of a real
  // announcement body built by `announceRelease` itself — not a synthetic
  // fixture standing in for it.
  test("the full announcement body is readable through the log, including past the first screen", async () => {
    const file = await scratchConfigFile();
    saveConfig(normalizeUserConfig({ lastRunVersion: "0.0.1" }), { file });
    const source = wiringSource(file);
    const state = initialState(source, false);

    const longBody = Array.from({ length: 1500 }, (_, index) => `w${index}`).join(" ")
      + " LASTROWMARKER";
    announceRelease(state, source, { file }, [
      { version: AI_1667_PRODUCT_VERSION, date: "2026-08-10", body: longBody }
    ], PACKAGED);
    expect(state.toast).toBe(EXPECTED_TOAST);
    // `announceRelease` already wrote the full body directly via
    // `recordNotice`, with the cursor on it. Not calling `recordSessionNotices`
    // here keeps that the only entry, so the cursor stays on the long notice
    // this test means to scroll — the toast-headline entry it would add on
    // top is exactly what the other wiring test above already covers.
    state.mode = "LOG";
    const opened = frameText(renderStoryScreen(state, {
      width: 120, height: 36, wrapCache: createWrapCache<ProseStyle>()
    }).lines);
    expect(opened).toContain("w0 ");
    expect(opened).not.toContain("LASTROWMARKER");

    // Far more rows than the body actually has, matching how
    // notice-log.test.ts drives the same clamp through the real key
    // resolver: proves the offset stops at the notice's last row instead of
    // needing an exact row count here.
    state.notices.scrollOffset = 100;
    const scrolled = frameText(renderStoryScreen(state, {
      width: 120, height: 36, wrapCache: createWrapCache<ProseStyle>()
    }).lines);
    expect(scrolled).toContain("LASTROWMARKER");
  });
});
