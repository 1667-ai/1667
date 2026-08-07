import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";
import { exportGenerationProfile, importProfileExport } from "../server/import-profile-export.js";
import {
  MAX_PROFILE_TRANSFER_BYTES,
  MAX_SAMPLER_PRESET_BYTES,
  readProfileTransferFile
} from "../server/profile-transfer-decoder.js";
import { fitProfileToRoute } from "../shared/generation-profile-transfer.js";
import { openAiDocument } from "./generation-profile-transfer-fixtures.js";

test("Profile Export preserves Settings v2 whitespace names", () => {
  for (const name of ["   ", "  surrounding whitespace  "]) {
    const exportedDocument = {
      ...openAiDocument(),
      profiles: {
        default: { ...openAiDocument().profiles.default!, name }
      }
    };
    const candidate = importProfileExport(exportGenerationProfile(exportedDocument, "default").text);
    assert.equal(candidate.name, name);

    const fitted = fitProfileToRoute(openAiDocument(), "default", candidate);
    assert.equal(fitted.document.profiles.default?.name, name);
  }
});


test("Profile Export round trips behavior and omits connection data", () => {
  const fitted = fitProfileToRoute(openAiDocument(), "default", {
    name: "Shared",
    temperature: 0.91,
    maxOutputTokens: 321,
    tokenProbabilities: 3,
    sampling: { topP: 0.95, minP: 0.02 }
  });
  const exported = exportGenerationProfile(fitted.document, "default");
  assert.doesNotMatch(exported.text, /baseUrl|auth|headers|timeouts|secretId|route|remoteModelId/u);
  const protectedExport = exportGenerationProfile({
    ...fitted.document,
    connections: {
      ...fitted.document.connections,
      "builtin:dry-run": {
        ...fitted.document.connections["builtin:dry-run"]!,
        baseUrl: "https://private.example/v1",
        auth: { type: "bearer-stored", secretId: "private-secret-id" },
        headers: [{ name: "X-Private", value: { type: "env", env: "PRIVATE_HEADER" } }],
        timeouts: { responseHeaderMs: 111, firstTokenMs: 222, idleMs: 333, totalMs: 444 }
      }
    },
    models: {
      ...fitted.document.models,
      "builtin:dry-run": {
        ...fitted.document.models["builtin:dry-run"]!,
        remoteId: "private-deployment-7f3a"
      }
    }
  }, "default");
  assert.doesNotMatch(
    protectedExport.text,
    /private\.example|private-secret-id|PRIVATE_HEADER|444|private-deployment-7f3a/u
  );
  const roundTrip = fitProfileToRoute(openAiDocument(), "default", importProfileExport(exported.text));
  assert.deepEqual(roundTrip.document.profiles.default, fitted.document.profiles.default);
});

test("Profile Export omits vocabulary-specific raw logit bias and preserves text bias", () => {
  const withoutRawBias = exportGenerationProfile(openAiDocument(), "default");
  assert.doesNotMatch(withoutRawBias.fidelity.join("; "), /raw logit bias omitted/u);
  assert.match(
    withoutRawBias.fidelity.join("; "),
    /connection, credentials, and headers omitted; the file carries generation behavior only/u
  );

  const source = fitProfileToRoute(openAiDocument(), "default", {
    name: "Portable bias",
    sampling: {
      logitBias: { "123": -100 },
      phraseBias: [{ phrase: "harbor", weight: 2 }],
      bannedStrings: ["slop"]
    }
  });
  const exported = exportGenerationProfile(source.document, "default");
  const payload = JSON.parse(exported.text) as { sampling: Record<string, unknown> };
  assert.equal(payload.sampling.logitBias, undefined);
  assert.deepEqual(payload.sampling.phraseBias, [{ phrase: "harbor", weight: 2 }]);
  assert.deepEqual(payload.sampling.bannedStrings, ["slop"]);
  assert.match(exported.fidelity.join("; "), /raw logit bias omitted; token IDs require source tokenizer identity/u);

  const portable = importProfileExport(exported.text);
  assert.equal(portable.sampling?.logitBias, undefined);
  assert.deepEqual(portable.sampling?.phraseBias, [{ phrase: "harbor", weight: 2 }]);
  assert.deepEqual(portable.sampling?.bannedStrings, ["slop"]);

  const legacy = importProfileExport(JSON.stringify({
    profileExportVersion: 1,
    name: "Legacy raw IDs",
    generation: {},
    sampling: {
      logitBias: { "987": -100 },
      phraseBias: [{ phrase: "harbor", weight: 2 }]
    }
  }));
  assert.equal(legacy.sampling?.logitBias, undefined);
  assert.equal(legacy.omittedCount, 1);
  assert.match(legacy.fidelity?.join("; ") ?? "", /raw logit bias not imported; token IDs require source tokenizer identity/u);
  const imported = fitProfileToRoute(openAiDocument(), "default", legacy);
  assert.deepEqual(imported.document.profiles.default?.sampling?.logitBias, {});
  assert.deepEqual(imported.document.profiles.default?.sampling?.phraseBias, [{ phrase: "harbor", weight: 2 }]);
});

test("Profile Export transfers token probabilities and clears an omitted count", () => {
  const source = {
    ...openAiDocument(),
    profiles: {
      default: { ...openAiDocument().profiles.default!, tokenProbabilities: 4 }
    }
  };
  const exported = exportGenerationProfile(source, "default");
  assert.match(exported.text, /"tokenProbabilities":4/u);
  const fitted = fitProfileToRoute(openAiDocument(), "default", importProfileExport(exported.text));
  assert.equal(fitted.document.profiles.default?.tokenProbabilities, 4);
  assert.equal(fitted.importedCount, fitted.candidateCount);

  const withoutTokenProbabilities = exportGenerationProfile(openAiDocument(), "default");
  const recipient = {
    ...openAiDocument(),
    profiles: {
      default: { ...openAiDocument().profiles.default!, tokenProbabilities: 6 }
    }
  };
  const cleared = fitProfileToRoute(recipient, "default", importProfileExport(withoutTokenProbabilities.text));
  assert.equal(cleared.document.profiles.default?.tokenProbabilities, undefined);
});


test("Profile Export preserves dormant Mirostat tuning", () => {
  const source = fitProfileToRoute(openAiDocument(), "default", {
    name: "Dormant Mirostat",
    sampling: { mirostat: null, mirostatTau: 5, mirostatEta: 0.2 }
  });
  const exported = exportGenerationProfile(source.document, "default");
  assert.match(exported.text, /"mirostatTau":5/u);
  assert.match(exported.text, /"mirostatEta":0\.2/u);
  assert.doesNotMatch(exported.text, /"mirostat":/u);

  const imported = fitProfileToRoute(
    openAiDocument(),
    "default",
    importProfileExport(exported.text)
  );
  assert.equal(imported.document.profiles.default?.sampling?.mirostat, null);
  assert.equal(imported.document.profiles.default?.sampling?.mirostatTau, 5);
  assert.equal(imported.document.profiles.default?.sampling?.mirostatEta, 0.2);
  assert.equal(imported.importedCount, imported.candidateCount);
  assert.doesNotMatch(imported.fidelity.join("; "), /mirostat (tau|eta) not imported/u);
});


test("Profile Export reports token probabilities that the selected route cannot use", () => {
  const unsupported = {
    ...openAiDocument(),
    connections: {
      "builtin:dry-run": {
        ...openAiDocument().connections["builtin:dry-run"]!,
        protocol: "anthropic-messages" as const,
        preset: "anthropic" as const
      }
    }
  };
  const fitted = fitProfileToRoute(unsupported, "default", {
    name: "Alternatives",
    tokenProbabilities: 3
  });
  assert.equal(fitted.importedCount, 0);
  assert.equal(fitted.candidateCount, 1);
  assert.equal(fitted.document.profiles.default?.tokenProbabilities, undefined);
  assert.match(fitted.fidelity.join("; "), /token probabilities not imported; not supported by provider/u);
});

test("Profile Export rejects invalid or unknown sampling fields before fitting", () => {
  assert.throws(
    () => importProfileExport(JSON.stringify({
      profileExportVersion: 1,
      name: "Unsafe",
      generation: {},
      sampling: { topP: "high" }
    })),
    /Profile Export sampling\.topP must be a finite number/u
  );
  assert.throws(
    () => importProfileExport(JSON.stringify({
      profileExportVersion: 1,
      name: "Unsafe",
      generation: {},
      sampling: { unknownKnob: 1 }
    })),
    /Profile Export sampling has an unsupported field/u
  );
  assert.throws(
    () => importProfileExport(`{"profileExportVersion":1,"name":"bad\ud800","generation":{}}`),
    /Profile Export name has an unpaired Unicode surrogate/u
  );
  assert.throws(
    () => importProfileExport(JSON.stringify({
      profileExportVersion: 1,
      name: "Unsafe",
      generation: { tokenProbabilities: 21 }
    })),
    /Profile Export generation\.tokenProbabilities must be an integer in 1\.\.20/u
  );
  assert.deepEqual(
    importProfileExport(JSON.stringify({
      profileExportVersion: 1,
      name: "Legacy route data",
      route: { remoteModelId: "private" },
      generation: {}
    })),
    { name: "Legacy route data", tokenProbabilities: null, sampling: {} }
  );
});

test("Profile Export accepts a canonical sampling collection larger than the Sampler Preset limit", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "1667-profile-transfer-"));
  const file = path.join(directory, "large.profile.json");
  const phraseBias = Array.from({ length: 256 }, (_, index) => ({
    phrase: `${"😀".repeat(61)}${String(index).padStart(3, "0")}`,
    weight: 100
  }));
  const text = JSON.stringify({
    profileExportVersion: 1,
    name: "Large Profile Export",
    generation: {},
    sampling: { phraseBias }
  });
  try {
    assert.ok(Buffer.byteLength(text) > MAX_SAMPLER_PRESET_BYTES);
    assert.ok(Buffer.byteLength(text) <= MAX_PROFILE_TRANSFER_BYTES);
    await writeFile(file, text);

    const candidate = await readProfileTransferFile(file);
    assert.equal(candidate.name, "Large Profile Export");
    assert.equal(candidate.sampling?.phraseBias?.length, 256);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Profile transfer rejects a valid Sampler Preset above its format-specific limit", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "1667-profile-transfer-"));
  const file = path.join(directory, "large.preset");
  const text = JSON.stringify({
    presetVersion: 7,
    parameters: { padding: "x".repeat(MAX_SAMPLER_PRESET_BYTES) }
  });
  try {
    assert.ok(Buffer.byteLength(text) > MAX_SAMPLER_PRESET_BYTES);
    assert.ok(Buffer.byteLength(text) <= MAX_PROFILE_TRANSFER_BYTES);
    await writeFile(file, text);
    await assert.rejects(
      () => readProfileTransferFile(file),
      /Sampler Preset is larger than the 64KB import limit/u
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
