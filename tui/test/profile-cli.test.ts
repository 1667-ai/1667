import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { basicSettingsFromDocument } from "../../shared/settings-basic-draft.js";
import { createDurableMutationId } from "../../shared/durable-mutation-id.js";
import type { SettingsMutationResult } from "../../shared/settings-v2-types.js";
import { INITIAL_SETTINGS_DOCUMENT_V2 } from "../../server/settings-v2-default.js";
import { initializeProject } from "../../server/project-discovery.js";
import {
  parseProfileCommand,
  runProfileCommand,
  type ProfileCommandDependencies
} from "../src/profile-cli.js";
import { createWorkerStoryApi } from "../src/worker-api.js";

const created: string[] = [];

afterEach(async () => {
  for (const directory of created.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

test("profile import duplicates its selected profile, reports fidelity, and keeps importing after a bad file", async () => {
  const root = await project();
  const bad = path.join(root, "bad.preset");
  const preset = path.join(root, "prose.preset");
  await writeFile(bad, "{", "utf8");
  await writeFile(preset, JSON.stringify({
    presetVersion: 7,
    name: "Travel prose",
    parameters: {
      temperature: 0.9,
      repetition_penalty: 1.2,
      order: [{ id: "temperature", enabled: true }, { id: "repetition_penalty", enabled: true }]
    }
  }), "utf8");
  const before = await settings(root);
  const output = collector();
  const errors = collector();

  const exitCode = await withExitCode(() => runProfileCommand(
    ["import", "--data", root, bad, preset], output.stream, errors.stream
  ));

  const after = await settings(root);
  expect(exitCode).toBe(1);
  expect(after.profiles.default).toEqual(before.profiles.default);
  expect(Object.values(after.profiles).some((profile) => profile.name === "Travel prose")).toBe(true);
  expect(output.text()).toContain(`${preset}: imported "Travel prose" as profile.1`);
  expect(errors.text()).toContain("repetition penalty not imported");
  expect(errors.text()).toContain(`${bad}:`);
});

test("profile import makes untrusted fidelity report text safe for the terminal", async () => {
  const root = await project();
  const preset = path.join(root, "unsafe.preset");
  await writeFile(preset, JSON.stringify({
    presetVersion: 7,
    name: "Unsafe",
    parameters: { "unknown\u202e\u009bparameter": 1 }
  }), "utf8");
  const errors = collector();

  await runProfileCommand(["import", "--data", root, preset], sink(), errors.stream);

  expect(errors.text()).toContain("▪");
  expect(errors.text()).not.toContain("\u202e");
  expect(errors.text()).not.toContain("\u009b");
});

test("profile import preserves whitespace Profile Export names and suffixes collisions", async () => {
  const root = await project();
  const whitespace = path.join(root, "whitespace.profile.json");
  const surrounding = path.join(root, "surrounding.profile.json");
  await writeFile(whitespace, JSON.stringify({
    profileExportVersion: 1, name: "   ", generation: {}, sampling: {}
  }), "utf8");
  await writeFile(surrounding, JSON.stringify({
    profileExportVersion: 1, name: "  surrounding whitespace  ", generation: {}, sampling: {}
  }), "utf8");

  await runProfileCommand(
    ["import", "--data", root, whitespace, whitespace, surrounding, surrounding],
    sink(), sink()
  );

  const document = await settings(root);
  expect(document.profiles["profile.1"]?.name).toBe("   ");
  expect(document.profiles["profile.2"]?.name).toBe("    2");
  expect(document.profiles["profile.3"]?.name).toBe("  surrounding whitespace  ");
  expect(document.profiles["profile.4"]?.name).toBe("  surrounding whitespace   2");
});

test("profile export round trips, omits secrets, and allocates or replaces files as requested", async () => {
  const root = await project();
  const first = collector();
  await runProfileCommand(["export", "--data", root], first.stream, sink());
  const files = (await readdir(root)).filter((file) => file.endsWith(".profile.json"));
  expect(files).toEqual(["Default.profile.json"]);
  const exported = await readFile(path.join(root, files[0]!), "utf8");
  expect(/auth|baseUrl|headers|timeouts|secretId/u.test(exported)).toBe(false);

  const importErrors = collector();
  await runProfileCommand(["import", "--data", root, path.join(root, files[0]!)], sink(), importErrors.stream);
  const imported = await settings(root);
  expect(importErrors.text()).toContain("no fidelity limitations reported");
  expect(Object.keys(imported.profiles)).toHaveLength(2);
  const roundTrip = imported.profiles["profile.1"];
  expect(roundTrip).toEqual({ ...imported.profiles.default!, name: "Default 2" });

  await runProfileCommand(["export", "--data", root], sink(), sink());
  expect((await readdir(root)).filter((file) => file.endsWith(".profile.json")).sort()).toEqual([
    "Default-2.profile.json", "Default.profile.json"
  ]);
  await runProfileCommand(["export", "--force", "--data", root], sink(), sink());
  expect((await readdir(root)).filter((file) => file.endsWith(".profile.json")).sort()).toEqual([
    "Default-2.profile.json", "Default.profile.json"
  ]);
});

test("profile export defaults to the canonical prose route", async () => {
  const root = await project();
  await addProseRoute(root);
  const output = collector();

  await runProfileCommand(["export", "--data", root], output.stream, sink());

  const exported = JSON.parse(await readFile(path.join(root, "Prose route.profile.json"), "utf8")) as {
    readonly name?: unknown;
  };
  expect(exported.name).toBe("Prose route");
});

test("profile commands resolve an inherited selector as a unique profile name", async () => {
  const root = await project();
  await addNamedProfile(root, "named", "toString");
  const output = collector();

  await runProfileCommand(["export", "--data", root, "--profile", "toString"], output.stream, sink());
  const file = path.join(root, "toString.profile.json");
  const exported = JSON.parse(await readFile(file, "utf8")) as { readonly name?: unknown };
  expect(exported.name).toBe("toString");

  await runProfileCommand(["import", "--data", root, "--profile", "toString", file], output.stream, sink());
  const document = await settings(root);
  expect(document.profiles.named?.name).toBe("toString");
  expect(document.profiles["profile.1"]?.name).toBe("toString 2");
  expect(output.text()).toContain('imported "toString 2" as profile.1');
});

test("profile import rejects --force", () => {
  expect(() => parseProfileCommand(["import", "--force", "prose.preset"]))
    .toThrow("--force applies only to profile export");
});

test("profile import reports a validation-failed save without claiming activation", async () => {
  const root = await project();
  const first = path.join(root, "first.preset");
  const second = path.join(root, "second.preset");
  await writeFile(first, JSON.stringify({ presetVersion: 7, name: "First", parameters: {} }), "utf8");
  await writeFile(second, JSON.stringify({ presetVersion: 7, name: "Second", parameters: {} }), "utf8");
  const output = collector();
  const errors = collector();

  const exitCode = await withExitCode(() => runProfileCommand(
    ["import", "--data", root, first, second], output.stream, errors.stream,
    profileCommandBackend({
      kind: "settings",
      settingsStateGeneration: 2,
      activeSettingsRevision: 1,
      pendingSettingsRevision: 2,
      activationOutcome: {
        transactionId: "m1.0000000000000.00000000000000000000000000000000",
        candidateRevision: 2,
        result: "validation-failed",
        errorCode: "credential_unresolved",
        atStateGeneration: 2
      }
    })
  ));

  expect(exitCode).toBe(1);
  expect(output.text()).not.toContain("imported");
  expect(errors.text()).toContain(`${first}: saved, not active · credential not found (env var or stored key)`);
  expect(errors.text()).toContain(`${second}: saved, not active · credential not found (env var or stored key)`);
});

test("profile import reports a pending activation without claiming success", async () => {
  const root = await project();
  const preset = path.join(root, "pending.preset");
  await writeFile(preset, JSON.stringify({ presetVersion: 7, name: "Pending", parameters: {} }), "utf8");
  const output = collector();

  const exitCode = await withExitCode(() => runProfileCommand(
    ["import", "--data", root, preset], output.stream, sink(),
    profileCommandBackend({
      kind: "settings",
      settingsStateGeneration: 2,
      activeSettingsRevision: 1,
      pendingSettingsRevision: 2,
      activationOutcome: null
    })
  ));

  expect(exitCode).toBe(0);
  expect(output.text()).toContain("imported \"Pending\" as profile.1 (0 of 0 parameters) · activation pending");
});

async function project(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "1667-profile-cli-"));
  created.push(root);
  await initializeProject(root);
  return root;
}

async function settings(root: string) {
  const backend = await createWorkerStoryApi({ dataDir: path.join(root, ".1667") });
  try {
    const view = await backend.api.getSettings();
    if (!view.editable) throw new Error("test project did not create format 2 settings");
    return view.document;
  } finally {
    await backend.dispose();
  }
}

async function addProseRoute(root: string): Promise<void> {
  await addNamedProfile(root, "prose", "Prose route", true);
}

async function addNamedProfile(
  root: string,
  profileId: string,
  name: string,
  prose = false
): Promise<void> {
  const backend = await createWorkerStoryApi({ dataDir: path.join(root, ".1667") });
  try {
    const view = await backend.api.getSettings();
    if (!view.editable) throw new Error("test project did not create format 2 settings");
    const defaultProfile = view.document.profiles.default;
    if (defaultProfile === undefined) throw new Error("test project did not create a default profile");
    const mutationId = createDurableMutationId();
    await backend.api.saveSettings({
      transportOperationId: `fixture:${mutationId}`,
      mutationId,
      expectedStateGeneration: view.stateGeneration,
      document: {
        ...view.document,
        profiles: {
          ...view.document.profiles,
          [profileId]: { ...defaultProfile, name }
        },
        routing: prose ? { ...view.document.routing, prose: profileId } : view.document.routing
      }
    });
  } finally {
    await backend.dispose();
  }
}

function profileCommandBackend(
  result: SettingsMutationResult
): ProfileCommandDependencies {
  const document = INITIAL_SETTINGS_DOCUMENT_V2;
  const effective = basicSettingsFromDocument(document);
  return {
    createBackend: async () => ({
      api: {
        getSettings: async () => ({
          dataFormat: 2 as const,
          editable: true as const,
          stateGeneration: 1,
          activeRevision: 1,
          pendingRevision: null,
          document,
          effective,
          effectiveProse: effective,
          lastActivationOutcome: null
        }),
        saveSettings: async () => result
      },
      dispose: async () => undefined
    })
  };
}

function collector(): { readonly stream: { write: (text: string) => boolean }; readonly text: () => string } {
  const parts: string[] = [];
  return {
    stream: { write: (text) => { parts.push(String(text)); return true; } },
    text: () => parts.join("")
  };
}

function sink(): { write: (text: string) => boolean } {
  return { write: () => true };
}

async function withExitCode(run: () => Promise<unknown>): Promise<number | string | undefined> {
  const before = process.exitCode ?? 0;
  process.exitCode = 0;
  try {
    await run();
    return process.exitCode;
  } finally {
    process.exitCode = before;
  }
}
