import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AI_1667_PRODUCT_VERSION } from "../../shared/build-identity.js";
import type { ReleaseNote } from "../../shared/release-notes.js";
import { applyReleaseAnnouncement, initialState } from "../src/app.js";
import { loadConfig, normalizeUserConfig, saveConfig } from "../src/config.js";
import { demoAppSource } from "../src/demo.js";
import { recordSessionNotices } from "../src/notice-log.js";
import { releaseAnnouncement } from "../src/release-announcement.js";

// A fixed fixture, independent of the real CHANGELOG.md, so this suite
// does not drift when the changelog gains entries. Newest first, matching
// the invariant `shared/release-notes.ts` guarantees.
const NOTES: readonly ReleaseNote[] = [
  { version: "1.3.0", date: "2026-03-01", body: "third note body" },
  { version: "1.2.0", date: "2026-02-01", body: "second note body" },
  { version: "1.1.0", date: "2026-01-01", body: "first note body" }
];

describe("releaseAnnouncement (pure)", () => {
  test("a first run (lastRunVersion null) announces nothing", () => {
    expect(releaseAnnouncement(null, "1.3.0", NOTES)).toBeNull();
  });

  test("a repeat run at the same version announces nothing", () => {
    expect(releaseAnnouncement("1.3.0", "1.3.0", NOTES)).toBeNull();
  });

  test("a downgrade announces nothing", () => {
    expect(releaseAnnouncement("1.3.0", "1.2.0", NOTES)).toBeNull();
  });

  test("an upgrade whose range has no matching notes announces nothing", () => {
    expect(releaseAnnouncement("1.3.0", "1.4.0", NOTES)).toBeNull();
  });

  test("an upgrade spanning several notes selects every one, newest first", () => {
    const announcement = releaseAnnouncement("1.0.0", "1.3.0", NOTES);
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
    const announcement = releaseAnnouncement("1.1.0", "1.2.5", NOTES);
    expect(announcement).not.toBeNull();
    expect(announcement!.body).toContain("second note body");
    expect(announcement!.body).not.toContain("first note body");
    expect(announcement!.body).not.toContain("third note body");
  });
});

describe("applyReleaseAnnouncement (wiring)", () => {
  // Stamping a real upgrade calls the real saveConfig, which writes to
  // $XDG_CONFIG_HOME/1667/config.json with no override. Sandbox that into a
  // scratch directory for the duration of each test in this block, so a
  // real run of this suite never touches a developer's actual config.
  let root: string;
  let originalXdgConfigHome: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "1667-release-announcement-"));
    originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = root;
  });

  afterEach(async () => {
    if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    await rm(root, { recursive: true, force: true });
  });

  test("an upgrade with notes raises the toast and puts the full body in the log", () => {
    const announcement = releaseAnnouncement("0.0.1", AI_1667_PRODUCT_VERSION, [
      { version: AI_1667_PRODUCT_VERSION, date: "2026-08-10", body: "current release body" },
      { version: "0.0.5", date: "2026-07-01", body: "intervening release body" }
    ]);
    expect(announcement).not.toBeNull();

    const base = demoAppSource();
    const source = { ...base, demo: false,
      config: { ...base.config, lastRunVersion: "0.0.1" },
      releaseAnnouncement: announcement };
    const state = initialState(source, false);
    expect(state.toast).toBeNull();

    applyReleaseAnnouncement(state, source);

    expect(state.toast).toBe(announcement!.toast);
    // Simulate the repaint that runs right after this call in `runInteractive`,
    // the same way the archive-import fidelity report test does.
    recordSessionNotices(state);
    const texts = state.notices.entries.map((entry) => String(entry.text));
    // Newest first: the toast headline lands above the full body it points to.
    expect(texts[0]).toBe(announcement!.toast);
    expect(texts[1]).toBe(announcement!.body);
    expect(texts[1]).toContain("current release body");
    expect(texts[1]).toContain("intervening release body");

    expect(source.config.lastRunVersion).toBe(AI_1667_PRODUCT_VERSION);
  });

  test("an upgrade whose range has no matching notes still stamps lastRunVersion", () => {
    const base = demoAppSource();
    const source = { ...base, demo: false,
      config: { ...base.config, lastRunVersion: "0.0.1" },
      releaseAnnouncement: releaseAnnouncement("0.0.1", AI_1667_PRODUCT_VERSION, []) };
    expect(source.releaseAnnouncement).toBeNull();
    const state = initialState(source, false);

    applyReleaseAnnouncement(state, source);

    expect(state.toast).toBeNull();
    expect(state.notices.entries).toHaveLength(0);
    expect(source.config.lastRunVersion).toBe(AI_1667_PRODUCT_VERSION);

    // The stamp is durable, not just an in-memory mutation.
    const persisted = loadConfig();
    expect(persisted.lastRunVersion).toBe(AI_1667_PRODUCT_VERSION);
  });

  test("a demo source neither stamps nor announces", () => {
    const announcement = releaseAnnouncement("0.0.1", AI_1667_PRODUCT_VERSION, [
      { version: AI_1667_PRODUCT_VERSION, date: "2026-08-10", body: "current release body" }
    ]);
    const base = demoAppSource();
    const source = { ...base,
      config: { ...base.config, lastRunVersion: "0.0.1" },
      releaseAnnouncement: announcement };
    expect(source.demo).toBe(true);
    const state = initialState(source, false);

    applyReleaseAnnouncement(state, source);

    expect(state.toast).toBeNull();
    expect(state.notices.entries).toHaveLength(0);
    expect(source.config.lastRunVersion).toBe("0.0.1");
  });
});

describe("the stamp makes the announcement one-shot", () => {
  test("after an announcing run, the config on disk carries the new lastRunVersion, "
    + "so a second run of the same build announces nothing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "1667-release-announcement-config-"));
    try {
      const file = path.join(root, "config.json");
      saveConfig(normalizeUserConfig({ lastRunVersion: "1.0.0" }), { file });

      const firstRun = loadConfig({ file });
      expect(firstRun.lastRunVersion).toBe("1.0.0");
      const firstAnnouncement = releaseAnnouncement(firstRun.lastRunVersion, "1.3.0", NOTES);
      expect(firstAnnouncement).not.toBeNull();

      // The same unconditional stamp `applyReleaseAnnouncement` performs.
      saveConfig({ ...firstRun, lastRunVersion: "1.3.0" }, { file });

      const secondRun = loadConfig({ file });
      expect(secondRun.lastRunVersion).toBe("1.3.0");
      expect(releaseAnnouncement(secondRun.lastRunVersion, "1.3.0", NOTES)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
