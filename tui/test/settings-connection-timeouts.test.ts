import { describe, expect, test } from "bun:test";
import { resolveSettingsProfile } from "../../shared/settings-route.js";
import type { SaveSettingsCommand } from "../../shared/settings-v2-types.js";
import { settingsRows } from "../src/settings-overlay-model.js";
import { settingsTextDraftForDocument } from "../src/settings-text.js";
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
    state.settings!.viewMode = "advanced";

    const cases = [
      { row: "timeout-headers", typed: "42", field: "responseHeaderMs", expectedMs: 42_000 },
      { row: "timeout-idle", typed: "15", field: "idleMs", expectedMs: 15_000 },
      { row: "timeout-total", typed: "600", field: "totalMs", expectedMs: 600_000 }
    ] as const;

    for (const { row, typed, field, expectedMs } of cases) {
      await draftRow(press, state, row, typed);
      const document = state.settings!.draft.document!;
      const profileId = state.settings!.draft.selectedProfileId!;
      const timeouts = resolveSettingsProfile(document, profileId).connection.timeouts;
      expect(timeouts[field]).toBe(expectedMs);
    }
  });

  test("the three edited timeouts survive a save round trip, leaving first token alone", async () => {
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
    state.settings!.viewMode = "advanced";
    const installedFirstTokenMs = resolveSettingsProfile(
      state.settings!.draft.document!,
      state.settings!.draft.selectedProfileId!
    ).connection.timeouts.firstTokenMs;
    await draftRow(press, state, "timeout-headers", "42");
    await draftRow(press, state, "timeout-idle", "15");
    await draftRow(press, state, "timeout-total", "600");
    await press(key("s"));

    expect(commands).toHaveLength(1);
    const document = commands[0]!.document;
    const profileId = state.settings!.draft.selectedProfileId!;
    const timeouts = resolveSettingsProfile(document, profileId).connection.timeouts;
    expect(timeouts).toEqual({
      responseHeaderMs: 42_000,
      // Untouched: no row edits it, and the runtime never reads it.
      firstTokenMs: installedFirstTokenMs,
      idleMs: 15_000,
      totalMs: 600_000
    });
  });

  test("arrows step the idle timeout by 5 seconds", async () => {
    const { source, state, press } = settingsHarness();
    installNetworkSettings(source);
    await openSettings(press);
    state.settings!.viewMode = "advanced";
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

  test("no row is offered for the first-token deadline, which cannot affect a request", async () => {
    // server/provider-sse.ts waits for the first token until the total
    // deadline, and the total timer starts earlier, so a configured
    // firstTokenMs can never change a request. A row for it would save
    // successfully and do nothing.
    const { state, press } = settingsHarness();
    await openSettings(press);
    state.settings!.viewMode = "advanced";
    const ids = settingsRows(state.settings!, state.config).map((row) => row.id);
    expect(ids).not.toContain("timeout-first-token");
    expect(ids).toContain("timeout-headers");
    expect(ids).toContain("timeout-idle");
    expect(ids).toContain("timeout-total");
  });

  // Every timeout shares one schema ceiling, so every row has to reach it.
  // Fixing only the row a review happened to name would leave the same defect
  // on the other three: a hand-edited 20 minute header wait, or a 4 hour
  // total, is a valid settings document that Settings must not report as past
  // a maximum. The track bound above each of these stays deliberately narrow
  // so stepping is usable; it is not the limit.
  const PAST_TRACK_BUT_VALID = [
    { row: "timeout-headers" as const, typed: "1200", field: "responseHeaderMs" as const, ms: 1_200_000 },
    { row: "timeout-idle" as const, typed: "1200", field: "idleMs" as const, ms: 1_200_000 },
    { row: "timeout-total" as const, typed: "14400", field: "totalMs" as const, ms: 14_400_000 }
  ];

  for (const { row, typed, field, ms } of PAST_TRACK_BUT_VALID) {
    test(`a ${row} value past its track but inside the schema is not flagged invalid`, async () => {
      const { source, state, press } = settingsHarness();
      installNetworkSettings(source);
      await openSettings(press);
      state.settings!.viewMode = "advanced";
      await draftRow(press, state, row, typed);

      const document = state.settings!.draft.document!;
      const profileId = state.settings!.draft.selectedProfileId!;
      expect(
        resolveSettingsProfile(document, profileId).connection.timeouts[field]
      ).toBe(ms);
      expect(settingsRows(state.settings!, state.config)
        .find((candidate) => candidate.id === row)?.invalid).toBe(undefined);
    });

    test(`a ${row} value past its track still steps instead of stalling on it`, async () => {
      // A value the row accepts has to be reachable and movable. Stepping
      // bounded by the track would clamp a valid persisted setting back down
      // to a limit that is only a visual.
      const { source, state, press } = settingsHarness();
      installNetworkSettings(source);
      await openSettings(press);
      state.settings!.viewMode = "advanced";
      await draftRow(press, state, row, typed);
      await selectRow(press, state, row);
      await press(key("right"));

      const document = state.settings!.draft.document!;
      const profileId = state.settings!.draft.selectedProfileId!;
      const stepped = resolveSettingsProfile(document, profileId).connection.timeouts[field];
      expect(stepped).toBeGreaterThan(ms);
    });
  }

  test("a fractional value can be typed even when the row currently holds a whole one", async () => {
    // What a row accepts must not depend on what it currently holds. Deriving
    // the typed precision from the stored value made a row showing `120s`
    // refuse `1.5` outright, so a writer could never reach a sub-second
    // deadline the document accepts.
    const { source, state, press } = settingsHarness();
    installNetworkSettings(source);
    await openSettings(press);
    state.settings!.viewMode = "advanced";
    await draftRow(press, state, "timeout-headers", "1.5");

    const document = state.settings!.draft.document!;
    const profileId = state.settings!.draft.selectedProfileId!;
    expect(
      resolveSettingsProfile(document, profileId).connection.timeouts.responseHeaderMs
    ).toBe(1_500);
    expect(settingsRows(state.settings!, state.config)
      .find((candidate) => candidate.id === "timeout-headers")?.invalid).toBe(undefined);
  });

  test("a hand-edited timeout that is not a whole second shows the value the runtime will use", async () => {
    // Stored values are whole milliseconds and need not land on a second.
    // This one cannot be typed into the row — the editor holds the row's
    // current precision — but it is a valid settings.json, which is exactly
    // how the documentation says to reach these values. Rendering 1,500 ms as
    // `2s` would have Settings report a deadline the runtime does not use.
    const { source, state, press } = settingsHarness();
    installNetworkSettings(source);
    await openSettings(press);
    state.settings!.viewMode = "advanced";

    const overlay = state.settings!;
    const document = overlay.draft.document!;
    const profileId = overlay.draft.selectedProfileId!;
    const connectionId = resolveSettingsProfile(document, profileId).model.connectionId;
    const connection = document.connections[connectionId]!;
    overlay.draft = settingsTextDraftForDocument({
      ...document,
      connections: {
        ...document.connections,
        [connectionId]: {
          ...connection,
          timeouts: { ...connection.timeouts, responseHeaderMs: 1_500 }
        }
      }
    }, profileId);

    expect(settingsRows(state.settings!, state.config)
      .find((candidate) => candidate.id === "timeout-headers")?.value).toContain("1.5s");
  });
});
