import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { exportGenerationProfile, importProfileExport } from "../../server/import-profile-export.js";
import type { SaveSettingsCommand } from "../../shared/settings-v2-types.js";
import { applyProfileTransfer } from "../src/profile-transfer-apply.js";
import { profileTransferAction } from "../src/profile-transfer-actions.js";
import { PROFILE_TRANSFER_SOURCES } from "../src/screens/profile-transfer-panel.js";
import { openSettingsPasteTarget } from "../src/settings-prompt-editor.js";
import {
  deferred,
  installSave,
  key,
  openSettings,
  selectRow,
  settingsHarness
} from "./settings-test-harness.js";
import { pasteInto, resolveKey } from "../src/keys.js";

describe("Generation Profile transfer", () => {
  test("imports a Starter Profile into the draft and saves only on s", async () => {
    const { source, state, press } = settingsHarness();
    const commands: SaveSettingsCommand[] = [];
    installSave(source, commands);

    await openSettings(press);
    await selectRow(press, state, "profile");
    await press(key("i"));
    expect(state.mode).toBe("SETTINGS");
    expect(state.settings?.profileTransfer?.phase).toBe("source");
    expect(PROFILE_TRANSFER_SOURCES).toEqual([
      "conservative", "balanced", "adventurous prose", "read a file…"
    ]);
    await press(key("return"));
    expect(state.settings?.draft.document?.profiles["profile.1"]?.name).toBe("conservative");
    await press(key("escape"));
    expect(commands).toHaveLength(0);

    await openSettings(press);
    await selectRow(press, state, "profile");
    await press(key("i"));
    await press(key("return"));
    await press(key("s"));
    expect(commands).toHaveLength(1);
    expect(commands[0]!.document.profiles["profile.1"]?.name).toBe("conservative");
  });

  test("import names ignore the duplicate placeholder but retain real collisions", () => {
    const { source } = settingsHarness();
    if (!source.settingsView.editable) throw new Error("editable settings missing");
    const document = source.settingsView.document;
    const imported = applyProfileTransfer(document, "default", { name: "Default copy" });
    if ("error" in imported) throw new Error(imported.error);
    expect(imported.document.profiles[imported.profileId]!.name).toBe("Default copy");

    const retained = {
      ...document,
      profiles: {
        ...document.profiles,
        retained: { ...document.profiles.default!, name: "Default copy" }
      }
    };
    const collided = applyProfileTransfer(retained, "default", { name: "Default copy" });
    if ("error" in collided) throw new Error(collided.error);
    expect(collided.document.profiles[collided.profileId]!.name).toBe("Default copy 2");
  });

  test("Profile Export imports preserve valid whitespace names and suffix only collisions", () => {
    const { source } = settingsHarness();
    if (!source.settingsView.editable) throw new Error("editable settings missing");
    const document = source.settingsView.document;
    for (const name of ["   ", "  surrounding whitespace  "]) {
      const exportedDocument = {
        ...document,
        profiles: { ...document.profiles, default: { ...document.profiles.default!, name } }
      };
      const candidate = importProfileExport(exportGenerationProfile(exportedDocument, "default").text);
      const imported = applyProfileTransfer(document, "default", candidate);
      if ("error" in imported) throw new Error(imported.error);
      expect(imported.document.profiles[imported.profileId]!.name).toBe(name);
    }

    const name = "  surrounding whitespace  ";
    const collidingDocument = {
      ...document,
      profiles: {
        ...document.profiles,
        retained: { ...document.profiles.default!, name }
      }
    };
    const collided = applyProfileTransfer(collidingDocument, "default", { name });
    if ("error" in collided) throw new Error(collided.error);
    expect(collided.document.profiles[collided.profileId]!.name).toBe("  surrounding whitespace   2");
  });

  test("Generation Profile file keyboard edits clear stale errors and candidates", async () => {
    const { state, press } = settingsHarness();
    const prompt = await openFilePrompt(state, press);
    prompt.path = "/tmp/stale";
    prompt.error = "stale error";
    prompt.candidates = ["/tmp/stale.preset"];

    await press(key("x"));
    expect(prompt.path).toBe("/tmp/stalex");
    expect(prompt.error).toBe(null);
    expect(prompt.candidates).toEqual([]);

    prompt.error = "stale error";
    prompt.candidates = ["/tmp/stale.preset"];
    await press(key("backspace"));
    expect(prompt.path).toBe("/tmp/stale");
    expect(prompt.error).toBe(null);
    expect(prompt.candidates).toEqual([]);
  });

  test("native Settings paste belongs to the transfer prompt and leaves no edit", async () => {
    const { source, state, press } = settingsHarness();
    const commands: SaveSettingsCommand[] = [];
    installSave(source, commands);
    const prompt = await openFilePrompt(state, press);
    const overlay = state.settings;
    if (overlay === null) throw new Error("settings overlay missing");

    expect(openSettingsPasteTarget(state)).toBe(null);
    expect(pasteInto(state, "/tmp/native.preset")).toBeTrue();
    expect(prompt.path).toBe("/tmp/native.preset");
    expect(overlay.edit).toBe(null);

    await profileTransferAction(
      { action: "apply-profile-transfer" },
      state,
      overlay,
      { readFile: async () => ({ name: "Native" }) }
    );
    expect(overlay.profileTransfer).toBe(null);
    expect(overlay.edit).toBe(null);
    await press(key("s"));
    expect(commands).toHaveLength(1);
  });

  test("Generation Profile file prompt routes Ctrl and Cmd V through the clipboard", async () => {
    const { state, press } = settingsHarness();
    const prompt = await openFilePrompt(state, press);
    const overlay = state.settings;
    if (overlay === null) throw new Error("settings overlay missing");
    prompt.error = "stale error";
    prompt.candidates = ["/tmp/stale.preset"];
    const clipboard = ["/tmp/ctrl\u0007\nprofile.preset", "/cmd.profile.json"];
    const readClipboard = async () => clipboard.shift() ?? null;

    const ctrlPaste = resolveKey(
      key("v", { ctrl: true }),
      "SETTINGS",
      { settingsProfileTransfer: "file" }
    );
    expect(ctrlPaste).toEqual({ action: "paste-clipboard" });
    await profileTransferAction(ctrlPaste, state, overlay, { readClipboard });
    expect(prompt.path).toBe("/tmp/ctrl profile.preset");
    expect(prompt.error).toBe(null);
    expect(prompt.candidates).toEqual([]);

    const cmdPaste = resolveKey(
      key("v", { super: true }),
      "SETTINGS",
      { settingsProfileTransfer: "file" }
    );
    expect(cmdPaste).toEqual({ action: "paste-clipboard" });
    await profileTransferAction(cmdPaste, state, overlay, { readClipboard });
    expect(prompt.path).toBe("/tmp/ctrl profile.preset/cmd.profile.json");
  });

  test("transfer applies a draft-only Starter Profile while generation is active", async () => {
    const { source, state, press } = settingsHarness();
    const commands: SaveSettingsCommand[] = [];
    installSave(source, commands);
    await openSettings(press);
    await selectRow(press, state, "profile");
    state.abort = {
      kind: "generation",
      controller: new AbortController(),
      stopInteractionVersion: null
    };

    await press(key("i"));
    await press(key("return"));
    expect(state.settings?.draft.document?.profiles["profile.1"]?.name).toBe("conservative");
    expect(commands).toHaveLength(0);
    await press(key("s"));
    expect(commands).toHaveLength(0);
    expect(state.toast).toBe("stream running · esc stops it first");
  });

  test("a stale file read cannot modify a reopened Generation Profile import prompt", async () => {
    const { state, press } = settingsHarness();
    const original = await openFilePrompt(state, press);
    const overlay = state.settings;
    if (overlay === null) throw new Error("settings overlay missing");
    original.path = "/tmp/stale.preset";
    const read = deferred<{ readonly name: string; readonly temperature: number }>();
    const applying = profileTransferAction(
      { action: "apply-profile-transfer" },
      state,
      overlay,
      { readFile: async () => await read.promise }
    );
    await Promise.resolve();

    await press(key("escape"));
    await press(key("i"));
    const reopened = state.settings?.profileTransfer;
    if (reopened === null || reopened === undefined) throw new Error("reopened profile transfer prompt missing");
    read.resolve({ name: "Stale", temperature: 0.4 });
    await applying;

    expect(state.settings?.profileTransfer).toBe(reopened);
    expect(reopened.error).toBe(null);
    expect(Object.keys(state.settings?.draft.document?.profiles ?? {})).toEqual(["default"]);
  });

  test("a stale file read error cannot overwrite a reopened Generation Profile import prompt", async () => {
    const { state, press } = settingsHarness();
    const original = await openFilePrompt(state, press);
    const overlay = state.settings;
    if (overlay === null) throw new Error("settings overlay missing");
    original.path = "/tmp/stale.preset";
    let reject!: (error: Error) => void;
    const read = new Promise<{ readonly name: string }>((_resolve, rejectPromise) => {
      reject = rejectPromise;
    });
    const applying = profileTransferAction(
      { action: "apply-profile-transfer" },
      state,
      overlay,
      { readFile: async () => await read }
    );
    await Promise.resolve();

    await press(key("escape"));
    await press(key("i"));
    const reopened = state.settings?.profileTransfer;
    if (reopened === null || reopened === undefined) throw new Error("reopened profile transfer prompt missing");
    reject(new Error("late read failure"));
    await applying;

    expect(state.settings?.profileTransfer).toBe(reopened);
    expect(reopened.error).toBe(null);
  });

  test("a file read cannot apply after its path changes in the same prompt", async () => {
    const { state, press } = settingsHarness();
    const prompt = await openFilePrompt(state, press);
    const overlay = state.settings;
    if (overlay === null) throw new Error("settings overlay missing");
    prompt.path = "/tmp/old.preset";
    const read = deferred<{ readonly name: string; readonly temperature: number }>();
    const applying = profileTransferAction(
      { action: "apply-profile-transfer" },
      state,
      overlay,
      { readFile: async () => await read.promise }
    );
    await Promise.resolve();

    await press(key("x"));
    read.resolve({ name: "Stale", temperature: 0.4 });
    await applying;

    expect(state.settings?.profileTransfer).toBe(prompt);
    expect(prompt.path).toBe("/tmp/old.presetx");
    expect(prompt.error).toBe(null);
    expect(Object.keys(state.settings?.draft.document?.profiles ?? {})).toEqual(["default"]);
  });

  test("a file read error cannot attach after its path changes in the same prompt", async () => {
    const { state, press } = settingsHarness();
    const prompt = await openFilePrompt(state, press);
    const overlay = state.settings;
    if (overlay === null) throw new Error("settings overlay missing");
    prompt.path = "/tmp/old.preset";
    let reject!: (error: Error) => void;
    const read = new Promise<{ readonly name: string }>((_resolve, rejectPromise) => {
      reject = rejectPromise;
    });
    const applying = profileTransferAction(
      { action: "apply-profile-transfer" },
      state,
      overlay,
      { readFile: async () => await read }
    );
    await Promise.resolve();

    await press(key("x"));
    reject(new Error("late read failure"));
    await applying;

    expect(state.settings?.profileTransfer).toBe(prompt);
    expect(prompt.path).toBe("/tmp/old.presetx");
    expect(prompt.error).toBe(null);
  });

  test("import revokes armed Settings overwrite consent before its first save", async () => {
    const { source, state, press } = settingsHarness();
    const commands: SaveSettingsCommand[] = [];
    source.api.saveSettings = async (command) => {
      commands.push(command);
      throw new Error("the first save must only re-arm the conflict");
    };

    await openSettings(press);
    await selectRow(press, state, "profile");
    await press(key("i"));
    if (state.settings === null) throw new Error("editable settings missing");
    state.settings.deleteArmedProfileId = "default";
    state.settings.result = { state: "ready", message: "old check" };
    state.settings.conflict = { message: "Settings changed", armed: true };

    await press(key("return"));
    expect(state.settings?.deleteArmedProfileId).toBe(null);
    expect(state.settings?.result).toBe(null);
    expect(state.settings?.conflict?.armed).toBeFalse();

    await press(key("s"));
    expect(commands).toHaveLength(0);
    expect(state.settings?.conflict?.armed).toBeTrue();
    expect(state.toast).toBe("Settings changed · s again overwrites");
  });

  test("palette exports a Generation Profile and reports format and write failures", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "1667-profile-export-"));
    try {
      const successful = settingsHarness();
      if (!successful.source.settingsView.editable) throw new Error("editable settings missing");
      const document = successful.source.settingsView.document;
      successful.source.settingsView = {
        ...successful.source.settingsView,
        document: {
          ...document,
          profiles: {
            ...document.profiles,
            prose: { ...document.profiles.default!, name: "Prose route" }
          },
          routing: { ...document.routing, prose: "prose" }
        }
      };
      successful.source.exportDirectory = directory;
      await runPaletteCommand(successful.press, "export generation profile");

      expect(successful.state.toast).toContain("connection data omitted");
      expect(successful.state.notices.entries.some((entry) =>
        entry.text.includes("exported Generation Profile") && entry.text.includes("connection, credentials, and headers omitted")
      )).toBe(true);
      const archive = JSON.parse(await readFile(path.join(directory, "Prose route.profile.json"), "utf8")) as {
        readonly profileExportVersion?: unknown;
        readonly name?: unknown;
      };
      expect(archive.profileExportVersion).toBe(1);
      expect(archive.name).toBe("Prose route");

      const legacy = settingsHarness();
      legacy.source.settingsView = {
        dataFormat: 1,
        editable: false,
        stateGeneration: null,
        activeRevision: null,
        pendingRevision: null,
        document: null,
        effective: legacy.source.settings,
        effectiveProse: legacy.source.settings,
        lastActivationOutcome: null
      };
      await runPaletteCommand(legacy.press, "export generation profile");
      expect(legacy.state.toast).toBe("Generation Profiles require settings format 2");

      const failed = settingsHarness();
      const target = path.join(directory, "not-a-directory");
      await writeFile(target, "not a directory");
      failed.source.exportDirectory = target;
      await runPaletteCommand(failed.press, "export generation profile");
      expect(failed.state.toast).toContain("could not export Generation Profile ·");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

async function openFilePrompt(
  state: ReturnType<typeof settingsHarness>["state"],
  press: ReturnType<typeof settingsHarness>["press"]
) {
  await openSettings(press);
  await selectRow(press, state, "profile");
  await press(key("i"));
  for (let index = 0; index < PROFILE_TRANSFER_SOURCES.length - 1; index += 1) {
    await press(key("down"));
  }
  await press(key("return"));
  const prompt = state.settings?.profileTransfer;
  if (prompt === null || prompt === undefined || prompt.phase !== "file") {
    throw new Error("file profile transfer prompt missing");
  }
  return prompt;
}

async function runPaletteCommand(
  press: ReturnType<typeof settingsHarness>["press"],
  command: string
): Promise<void> {
  await press(key(":"));
  for (const character of command) await press(key(character));
  await press(key("return", { sequence: "\r" }));
}
