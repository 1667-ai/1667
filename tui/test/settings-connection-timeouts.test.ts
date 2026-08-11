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

    const cases = [
      { row: "timeout-headers", typed: "42", field: "responseHeaderMs", expectedMs: 42_000 },
      { row: "timeout-first-token", typed: "77", field: "firstTokenMs", expectedMs: 77_000 },
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
    await draftRow(press, state, "timeout-total", "600");
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

  test("a first-token value far past the derivation's own ceiling is a valid configured value, not flagged invalid", async () => {
    const { source, state, press } = settingsHarness();
    installNetworkSettings(source);
    await openSettings(press);
    // 20 minutes: past server/provider-first-token-deadline.ts's derivation
    // ceiling, which bounds only the automatic per-byte allowance a large
    // prompt earns, never a value a writer configures here directly. The
    // settings schema allows up to MAX_SETTINGS_TIMEOUT_MS (24 hours), so
    // this row's own bound must reach at least this far without marking the
    // value invalid or putting it out of arrow-step reach.
    await draftRow(press, state, "timeout-first-token", "1200");

    const document = state.settings!.draft.document!;
    const profileId = state.settings!.draft.selectedProfileId!;
    expect(
      resolveSettingsProfile(document, profileId).connection.timeouts.firstTokenMs
    ).toBe(1_200_000);

    const rows = settingsRows(state.settings!, state.config);
    const firstToken = rows.find((candidate) => candidate.id === "timeout-first-token");
    expect(firstToken?.invalid).toBe(undefined);
    expect(firstToken?.value).toContain("1,200s");
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
