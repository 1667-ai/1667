import { describe, expect, test } from "bun:test";
import { resolveSettingsProfile } from "../../shared/settings-route.js";
import type { SaveSettingsCommand } from "../../shared/settings-v2-types.js";
import { settingsRows } from "../src/settings-overlay-model.js";
import {
  draftRow,
  key,
  openSettings,
  selectRow,
  settingsHarness
} from "./settings-test-harness.js";
import {
  installNetworkSettings,
  savedResult,
  savedView
} from "./settings-profiles-test-helpers.js";

/** Issue #127: the four ConnectionTimeoutsV2 fields (headers, first token,
 *  idle, total) become editable Settings rows. Every value already exists in
 *  the settings document, so editing adds no new stored field — these tests
 *  check the round trip, not a new shape. */
describe("connection timeout settings rows (issue #127)", () => {
  test("editing each connection timeout round-trips through the document, in milliseconds", async () => {
    const { source, state, press } = settingsHarness();
    installNetworkSettings(source);
    await openSettings(press);

    const cases = [
      { row: "timeout-headers", typed: "42", field: "responseHeaderMs", expectedMs: 42_000 },
      { row: "timeout-first-token", typed: "77", field: "firstTokenMs", expectedMs: 77_000 },
      { row: "timeout-idle", typed: "15", field: "idleMs", expectedMs: 15_000 },
      { row: "timeout-total", typed: "10", field: "totalMs", expectedMs: 600_000 }
    ] as const;

    for (const { row, typed, field, expectedMs } of cases) {
      await draftRow(press, state, row, typed);
      const document = state.settings!.draft.document!;
      const profileId = state.settings!.draft.selectedProfileId!;
      const timeouts = resolveSettingsProfile(document, profileId).connection.timeouts;
      expect(timeouts[field]).toBe(expectedMs);
    }
  });

  test("the four edited timeouts survive a save round trip", async () => {
    const { source, state, press } = settingsHarness();
    const current = installNetworkSettings(source);
    const commands: SaveSettingsCommand[] = [];
    source.api.saveSettings = async (command) => {
      commands.push(command);
      const saved = savedView(current, command.document);
      source.settingsView = saved;
      return savedResult(saved);
    };
    source.api.getSettings = async () => source.settingsView;

    await openSettings(press);
    await draftRow(press, state, "timeout-headers", "42");
    await draftRow(press, state, "timeout-first-token", "77");
    await draftRow(press, state, "timeout-idle", "15");
    await draftRow(press, state, "timeout-total", "10");
    await press(key("s"));

    expect(commands).toHaveLength(1);
    const document = commands[0]!.document;
    const profileId = state.settings!.draft.selectedProfileId!;
    const timeouts = resolveSettingsProfile(document, profileId).connection.timeouts;
    expect(timeouts).toEqual({
      responseHeaderMs: 42_000,
      firstTokenMs: 77_000,
      idleMs: 15_000,
      totalMs: 600_000
    });
  });

  test("arrows step the idle timeout by 5 seconds", async () => {
    const { source, state, press } = settingsHarness();
    installNetworkSettings(source);
    await openSettings(press);
    await selectRow(press, state, "timeout-idle");
    const before = resolveSettingsProfile(
      state.settings!.draft.document!,
      state.settings!.draft.selectedProfileId!
    ).connection.timeouts.idleMs;

    await press(key("right"));

    const after = resolveSettingsProfile(
      state.settings!.draft.document!,
      state.settings!.draft.selectedProfileId!
    ).connection.timeouts.idleMs;
    expect(after).toBe(before + 5_000);
  });

  test("the first-token row's hint says a large prompt extends it automatically", async () => {
    const { state, press } = settingsHarness();
    await openSettings(press);
    const rows = settingsRows(state.settings!, state.config);
    const firstToken = rows.find((candidate) => candidate.id === "timeout-first-token");
    expect(firstToken?.hint).toContain("large prompt");
    expect(firstToken?.hint).toContain("automatically");
  });
});
