import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AI_1667_PRODUCT_VERSION } from "../../shared/build-identity.js";
import type { ReleaseNote } from "../../shared/release-notes.js";
import { initialState } from "../src/app.js";
import {
  configFileExists,
  loadConfig,
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
const atVersion = (version: string): LastRun => ({ kind: "version", version });

// `announceRelease` always reads the real running build's version, so its
// fixtures bracket the real `AI_1667_PRODUCT_VERSION` rather than an
// arbitrary one.
const WIRING_NOTES: readonly ReleaseNote[] = [
  { version: AI_1667_PRODUCT_VERSION, date: "2026-08-10", body: "current release body" },
  { version: "0.0.5", date: "2026-07-01", body: "intervening release body" }
];
const EXPECTED_TOAST = `Updated to ${AI_1667_PRODUCT_VERSION} · press ! for what changed`;

function wiringSource(file: string, demo = false) {
  const base = demoAppSource();
  return { ...base, demo, config: loadConfig({ file }) };
}

describe("releaseAnnouncement (pure)", () => {
  test("a first run (fresh install) announces nothing", () => {
    expect(releaseAnnouncement(FRESH, "1.3.0", NOTES)).toBeNull();
  });

  test("a repeat run at the same version announces nothing", () => {
    expect(releaseAnnouncement(atVersion("1.3.0"), "1.3.0", NOTES)).toBeNull();
  });

  test("a downgrade announces nothing", () => {
    expect(releaseAnnouncement(atVersion("1.3.0"), "1.2.0", NOTES)).toBeNull();
  });

  test("an upgrade whose range has no matching notes announces nothing", () => {
    expect(releaseAnnouncement(atVersion("1.3.0"), "1.4.0", NOTES)).toBeNull();
  });

  test("an upgrade spanning several notes selects every one, newest first", () => {
    const announcement = releaseAnnouncement(atVersion("1.0.0"), "1.3.0", NOTES);
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
    const announcement = releaseAnnouncement(atVersion("1.1.0"), "1.2.5", NOTES);
    expect(announcement).not.toBeNull();
    expect(announcement!.body).toContain("second note body");
    expect(announcement!.body).not.toContain("first note body");
    expect(announcement!.body).not.toContain("third note body");
  });

  describe("an upgrade from a build older than this feature (unknown)", () => {
    test("announces only the note for the exact version landed on, not a guessed range", () => {
      const announcement = releaseAnnouncement(UNKNOWN, "1.2.0", NOTES);
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
      expect(releaseAnnouncement(UNKNOWN, "1.2.5", NOTES)).toBeNull();
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

    announceRelease(state, source, { file }, WIRING_NOTES);

    expect(state.toast).toBe(EXPECTED_TOAST);
    // Simulate the repaint that runs right after this call in
    // `runInteractive`, the same way the archive-import fidelity report
    // test does.
    recordSessionNotices(state);
    const texts = state.notices.entries.map((entry) => String(entry.text));
    // Newest first: the toast headline lands above the full body it points to.
    expect(texts[0]).toBe(EXPECTED_TOAST);
    expect(texts[1]).toContain("current release body");
    expect(texts[1]).toContain("intervening release body");

    expect(source.config.lastRunVersion).toBe(AI_1667_PRODUCT_VERSION);
    expect(loadConfig({ file }).lastRunVersion).toBe(AI_1667_PRODUCT_VERSION);
  });

  test("an upgrade whose range has no matching notes still stamps lastRunVersion", async () => {
    const file = await scratchConfigFile();
    saveConfig(normalizeUserConfig({ lastRunVersion: "0.0.1" }), { file });
    const source = wiringSource(file);
    const state = initialState(source, false);

    announceRelease(state, source, { file }, []);

    expect(state.toast).toBeNull();
    expect(state.notices.entries).toHaveLength(0);
    expect(source.config.lastRunVersion).toBe(AI_1667_PRODUCT_VERSION);
    expect(loadConfig({ file }).lastRunVersion).toBe(AI_1667_PRODUCT_VERSION);
  });

  test("a demo source neither stamps nor announces, and never touches disk", async () => {
    const file = await scratchConfigFile();
    // No config file exists yet: a demo run must not create one either.
    const source = wiringSource(file, true);
    source.config = { ...source.config, lastRunVersion: "0.0.1" };
    expect(source.demo).toBe(true);
    const state = initialState(source, false);

    announceRelease(state, source, { file }, WIRING_NOTES);

    expect(state.toast).toBeNull();
    expect(state.notices.entries).toHaveLength(0);
    expect(source.config.lastRunVersion).toBe("0.0.1");
    expect(configFileExists({ file })).toBe(false);
  });

  test("a genuinely fresh install (no config file at all) announces nothing", async () => {
    const file = await scratchConfigFile();
    expect(configFileExists({ file })).toBe(false);
    const source = wiringSource(file);
    expect(source.config.lastRunVersion).toBeNull();
    const state = initialState(source, false);

    announceRelease(state, source, { file }, WIRING_NOTES);

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
    expect(configFileExists({ file })).toBe(true);
    expect(loadConfig({ file }).lastRunVersion).toBeNull();

    const source = wiringSource(file);
    const state = initialState(source, false);

    announceRelease(state, source, { file }, WIRING_NOTES);

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
});

describe("the stamp makes the announcement one-shot", () => {
  test("after an announcing run, the config on disk carries the new lastRunVersion, "
    + "so a second run of the same build announces nothing", async () => {
    const file = await scratchConfigFile();
    saveConfig(normalizeUserConfig({ lastRunVersion: "0.0.1" }), { file });

    // Drive the real path once.
    const firstSource = wiringSource(file);
    const firstState = initialState(firstSource, false);
    announceRelease(firstState, firstSource, { file }, WIRING_NOTES);
    expect(firstState.toast).toBe(EXPECTED_TOAST);

    // Drive it again, from a fresh state and a fresh read of exactly what
    // the first run persisted — not a hand-rolled copy of the stamp.
    const secondSource = wiringSource(file);
    expect(secondSource.config.lastRunVersion).toBe(AI_1667_PRODUCT_VERSION);
    const secondState = initialState(secondSource, false);
    announceRelease(secondState, secondSource, { file }, WIRING_NOTES);

    expect(secondState.toast).toBeNull();
    expect(secondState.notices.entries).toHaveLength(0);
  });
});

describe("the toast reaches a rendered frame", () => {
  test("an announcing run's toast appears in the rendered story screen", async () => {
    const file = await scratchConfigFile();
    saveConfig(normalizeUserConfig({ lastRunVersion: "0.0.1" }), { file });
    const source = wiringSource(file);
    const state = initialState(source, false);

    announceRelease(state, source, { file }, WIRING_NOTES);
    expect(state.toast).toBe(EXPECTED_TOAST);

    const rendered = frameText(renderStoryScreen(state, {
      width: 120, height: 36, wrapCache: createWrapCache<ProseStyle>()
    }).lines);

    expect(rendered).toContain(`Updated to ${AI_1667_PRODUCT_VERSION}`);
    expect(rendered).toContain("press ! for what changed");
  });
});
