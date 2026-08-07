import assert from "node:assert/strict";
import test from "node:test";
import {
  combineSamplingBiasSources,
  resolveSamplingLogitBias
} from "../server/sampling-phrase-bias.js";
import { validateSamplingRoute } from "../server/settings-v2-sampling-validation.js";
import { exportGenerationProfile, importProfileExport } from "../server/import-profile-export.js";
import { samplingBiasPresetRules } from "../shared/sampling-capabilities.js";
import { EMPTY_SAMPLING_V2, type SamplingPhraseBiasEntryV2 } from "../shared/settings-v2-types.js";
import { fitProfileToRoute } from "../shared/generation-profile-transfer.js";
import { openAiDocument } from "./generation-profile-transfer-fixtures.js";

test("Profile transfer enforces the deterministic raw logit-bias limit by target preset", () => {
  const entries = (count: number) => Object.fromEntries(
    Array.from({ length: count }, (_, index) => [String(index + 1), 1])
  );
  const officialOpenAi = {
    ...openAiDocument(),
    connections: {
      "builtin:dry-run": {
        ...openAiDocument().connections["builtin:dry-run"]!,
        preset: "openai" as const,
        baseUrl: "https://api.openai.com/v1"
      }
    },
    models: {
      "builtin:dry-run": {
        ...openAiDocument().models["builtin:dry-run"]!,
        remoteId: "gpt-4.1"
      }
    }
  };
  const source = fitProfileToRoute(officialOpenAi, "default", {
    name: "Raw bias",
    sampling: { topP: 0.9, logitBias: entries(17) }
  });
  const exported = exportGenerationProfile(source.document, "default");
  assert.equal(Object.keys(source.document.profiles.default?.sampling?.logitBias ?? {}).length, 17);
  assert.doesNotMatch(exported.text, /logitBias/u);

  const kobold = {
    ...openAiDocument(),
    connections: {
      "builtin:dry-run": {
        ...openAiDocument().connections["builtin:dry-run"]!,
        preset: "koboldcpp" as const
      }
    }
  };
  const dropped = fitProfileToRoute(kobold, "default", {
    name: "Raw bias",
    sampling: { topP: 0.9, logitBias: entries(17) }
  });
  const droppedProfile = dropped.document.profiles.default!;
  assert.equal(droppedProfile.sampling?.topP, 0.9);
  assert.deepEqual(droppedProfile.sampling?.logitBias, {});
  assert.equal(dropped.importedCount, dropped.candidateCount - 1);
  assert.match(
    dropped.fidelity.join("; "),
    /logit bias not imported; 17 entries exceed the 16-entry limit for preset koboldcpp/u
  );
  validateSamplingRoute(
    "default",
    droppedProfile,
    dropped.document.models[droppedProfile.modelId]!,
    dropped.document.connections[dropped.document.models[droppedProfile.modelId]!.connectionId]!
  );

  const accepted = fitProfileToRoute(kobold, "default", {
    name: "Raw bias",
    sampling: { topP: 0.9, logitBias: entries(16) }
  });
  const acceptedProfile = accepted.document.profiles.default!;
  assert.equal(Object.keys(acceptedProfile.sampling?.logitBias ?? {}).length, 16);
  assert.equal(accepted.importedCount, accepted.candidateCount);
  validateSamplingRoute(
    "default",
    acceptedProfile,
    accepted.document.models[acceptedProfile.modelId]!,
    accepted.document.connections[accepted.document.models[acceptedProfile.modelId]!.connectionId]!
  );
});

test("Profile transfer keeps text bias within the target resolved logit-bias limit", () => {
  const phraseBias: readonly SamplingPhraseBiasEntryV2[] = Array.from(
    { length: 17 },
    (_, index) => ({ phrase: `bias-${index}`, weight: 1 })
  );
  const sampling = { ...EMPTY_SAMPLING_V2, phraseBias };
  const tokenizer = (text: string) => ({
    kind: "single-token" as const,
    tokenId: Number(text.trim().split("-")[1]) + 1
  });
  const kobold = {
    ...openAiDocument(),
    connections: {
      "builtin:dry-run": {
        ...openAiDocument().connections["builtin:dry-run"]!,
        preset: "koboldcpp" as const
      }
    }
  };
  const overLimitResolution = resolveSamplingLogitBias(
    combineSamplingBiasSources(sampling),
    tokenizer,
    samplingBiasPresetRules("koboldcpp")
  );
  const unsafeProfile = { ...kobold.profiles.default!, sampling };
  assert.throws(
    () => validateSamplingRoute(
      "default",
      unsafeProfile,
      kobold.models["builtin:dry-run"]!,
      kobold.connections["builtin:dry-run"]!,
      overLimitResolution
    ),
    /resolves to 17 logit-bias entries, exceeding the 16-entry limit for preset koboldcpp/u
  );

  const overLimit = fitProfileToRoute(kobold, "default", {
    name: "Over limit text bias",
    sampling: { phraseBias }
  }, { samplingBiasResolution: overLimitResolution });
  assert.equal(overLimit.document.profiles.default?.sampling, undefined);
  assert.equal(overLimit.importedCount, 0);
  assert.equal(overLimit.candidateCount, 1);
  assert.match(
    overLimit.fidelity.join("; "),
    /phrase bias not imported; 17 resolved logit-bias entries exceed the 16-entry limit for preset koboldcpp/u
  );
  validateSamplingRoute(
    "default",
    overLimit.document.profiles.default!,
    overLimit.document.models[overLimit.document.profiles.default!.modelId]!,
    overLimit.document.connections[overLimit.document.models[overLimit.document.profiles.default!.modelId]!.connectionId]!
  );

  const nativeBans = Array.from({ length: 200 }, (_, index) => `native-ban-${index}`);
  const overLimitWithNativeBans = fitProfileToRoute(kobold, "default", {
    name: "Over limit text bias with native bans",
    sampling: { phraseBias, bannedStrings: nativeBans }
  }, { samplingBiasResolution: overLimitResolution });
  assert.deepEqual(overLimitWithNativeBans.document.profiles.default?.sampling?.phraseBias, []);
  assert.deepEqual(overLimitWithNativeBans.document.profiles.default?.sampling?.bannedStrings, nativeBans);
  assert.equal(overLimitWithNativeBans.importedCount, 1);
  assert.equal(overLimitWithNativeBans.candidateCount, 2);

  const safePhraseBias = phraseBias.slice(0, 4);
  const safe = fitProfileToRoute(kobold, "default", {
    name: "Safe text bias",
    sampling: { phraseBias: safePhraseBias }
  });
  assert.deepEqual(safe.document.profiles.default?.sampling?.phraseBias, safePhraseBias);
  const safeResolution = resolveSamplingLogitBias(
    combineSamplingBiasSources({ ...EMPTY_SAMPLING_V2, phraseBias: safePhraseBias }),
    tokenizer,
    samplingBiasPresetRules("koboldcpp")
  );
  validateSamplingRoute(
    "default",
    safe.document.profiles.default!,
    safe.document.models[safe.document.profiles.default!.modelId]!,
    safe.document.connections[safe.document.models[safe.document.profiles.default!.modelId]!.connectionId]!,
    safeResolution
  );

  const normal = fitProfileToRoute(openAiDocument(), "default", {
    name: "Normal preset text bias",
    sampling: { phraseBias }
  });
  assert.deepEqual(normal.document.profiles.default?.sampling?.phraseBias, phraseBias);
  const normalResolution = resolveSamplingLogitBias(
    combineSamplingBiasSources(sampling),
    tokenizer,
    samplingBiasPresetRules("llama-cpp")
  );
  validateSamplingRoute(
    "default",
    normal.document.profiles.default!,
    normal.document.models[normal.document.profiles.default!.modelId]!,
    normal.document.connections[normal.document.models[normal.document.profiles.default!.modelId]!.connectionId]!,
    normalResolution
  );
});

test("Profile transfer omits canonical text-bias rejections before fitting", () => {
  const rejectedSampling = {
    ...EMPTY_SAMPLING_V2,
    phraseBias: [
      { phrase: "unknown-token", weight: 1 },
      { phrase: "known-token", weight: 2 }
    ]
  };
  const rejectedResolution = resolveSamplingLogitBias(
    combineSamplingBiasSources(rejectedSampling),
    (text) => text.includes("unknown")
      ? { kind: "unencodable" as const }
      : { kind: "single-token" as const, tokenId: 2 },
    samplingBiasPresetRules("llama-cpp")
  );
  const rejected = fitProfileToRoute(openAiDocument(), "default", {
    name: "Rejected phrase",
    sampling: { phraseBias: rejectedSampling.phraseBias }
  }, { samplingBiasResolution: rejectedResolution });
  assert.deepEqual(rejected.document.profiles.default?.sampling?.phraseBias, [
    { phrase: "known-token", weight: 2 }
  ]);
  assert.equal(rejected.importedCount, 1);
  assert.equal(rejected.candidateCount, 1);
  assert.match(
    rejected.fidelity.join("; "),
    /phrase bias entry not imported; "unknown-token" has no exact token/u
  );
  validateSamplingRoute(
    "default",
    rejected.document.profiles.default!,
    rejected.document.models[rejected.document.profiles.default!.modelId]!,
    rejected.document.connections[rejected.document.models[rejected.document.profiles.default!.modelId]!.connectionId]!
  );

  const fullyRejectedSampling = {
    ...EMPTY_SAMPLING_V2,
    phraseBias: [
      { phrase: "unknown-one", weight: 1 },
      { phrase: "unknown-two", weight: 2 }
    ]
  };
  const fullyRejectedResolution = resolveSamplingLogitBias(
    combineSamplingBiasSources(fullyRejectedSampling),
    () => ({ kind: "unencodable" as const }),
    samplingBiasPresetRules("llama-cpp")
  );
  const fullyRejected = fitProfileToRoute(openAiDocument(), "default", {
    name: "Rejected phrase bias",
    sampling: { phraseBias: fullyRejectedSampling.phraseBias }
  }, { samplingBiasResolution: fullyRejectedResolution });
  assert.equal(fullyRejected.document.profiles.default?.sampling, undefined);
  assert.equal(fullyRejected.importedCount, 0);
  assert.equal(fullyRejected.candidateCount, 1);
  assert.match(
    fullyRejected.fidelity.join("; "),
    /phrase bias not imported; "unknown-one" has no exact token/u
  );
  assert.match(
    fullyRejected.fidelity.join("; "),
    /phrase bias not imported; "unknown-two" has no exact token/u
  );

  const rejectedBannedSampling = {
    ...EMPTY_SAMPLING_V2,
    bannedStrings: ["unknown banned string", "kept banned string"]
  };
  const rejectedBannedResolution = resolveSamplingLogitBias(
    combineSamplingBiasSources(rejectedBannedSampling),
    (text) => text.includes("unknown")
      ? { kind: "unencodable" as const }
      : { kind: "single-token" as const, tokenId: 3 },
    samplingBiasPresetRules("llama-cpp")
  );
  const rejectedBanned = fitProfileToRoute(openAiDocument(), "default", {
    name: "Rejected banned string",
    sampling: { bannedStrings: rejectedBannedSampling.bannedStrings }
  }, { samplingBiasResolution: rejectedBannedResolution });
  assert.deepEqual(rejectedBanned.document.profiles.default?.sampling?.bannedStrings, [
    "kept banned string"
  ]);
  assert.equal(rejectedBanned.importedCount, 1);
  assert.equal(rejectedBanned.candidateCount, 1);
  assert.match(
    rejectedBanned.fidelity.join("; "),
    /banned string not imported; "unknown banned string" has no exact token/u
  );
  validateSamplingRoute(
    "default",
    rejectedBanned.document.profiles.default!,
    rejectedBanned.document.models[rejectedBanned.document.profiles.default!.modelId]!,
    rejectedBanned.document.connections[rejectedBanned.document.models[rejectedBanned.document.profiles.default!.modelId]!.connectionId]!
  );

  const shadowedSampling = {
    ...EMPTY_SAMPLING_V2,
    logitBias: { "1": 1 },
    phraseBias: [
      { phrase: "shadowed", weight: 2 },
      { phrase: "kept", weight: 3 }
    ]
  };
  const shadowedResolution = resolveSamplingLogitBias(
    combineSamplingBiasSources(shadowedSampling),
    (text) => ({ kind: "single-token" as const, tokenId: text.includes("shadowed") ? 1 : 2 }),
    samplingBiasPresetRules("llama-cpp")
  );
  const shadowed = fitProfileToRoute(openAiDocument(), "default", {
    name: "Shadowed phrase",
    sampling: {
      logitBias: shadowedSampling.logitBias,
      phraseBias: shadowedSampling.phraseBias
    }
  }, { samplingBiasResolution: shadowedResolution });
  assert.deepEqual(shadowed.document.profiles.default?.sampling?.phraseBias, [
    { phrase: "kept", weight: 3 }
  ]);
  assert.deepEqual(shadowed.document.profiles.default?.sampling?.logitBias, { "1": 1 });
  assert.equal(shadowed.importedCount, 2);
  assert.equal(shadowed.candidateCount, 2);
  assert.match(
    shadowed.fidelity.join("; "),
    /phrase bias entry not imported; "shadowed" loses its bias/u
  );
  validateSamplingRoute(
    "default",
    shadowed.document.profiles.default!,
    shadowed.document.models[shadowed.document.profiles.default!.modelId]!,
    shadowed.document.connections[shadowed.document.models[shadowed.document.profiles.default!.modelId]!.connectionId]!
  );

  const nativeSampling = {
    ...EMPTY_SAMPLING_V2,
    logitBias: { "1": 1 },
    phraseBias: [{ phrase: "ember", weight: 1 }],
    bannedStrings: ["ember", "kept native ban"]
  };
  const nativeResolution = resolveSamplingLogitBias(
    combineSamplingBiasSources(nativeSampling),
    () => ({ kind: "single-token" as const, tokenId: 1 }),
    samplingBiasPresetRules("koboldcpp")
  );
  const kobold = {
    ...openAiDocument(),
    connections: {
      "builtin:dry-run": {
        ...openAiDocument().connections["builtin:dry-run"]!,
        preset: "koboldcpp" as const
      }
    }
  };
  const native = fitProfileToRoute(kobold, "default", {
    name: "Blocked native ban",
    sampling: {
      logitBias: nativeSampling.logitBias,
      phraseBias: nativeSampling.phraseBias,
      bannedStrings: nativeSampling.bannedStrings
    }
  }, { samplingBiasResolution: nativeResolution });
  assert.deepEqual(native.document.profiles.default?.sampling?.phraseBias, nativeSampling.phraseBias);
  assert.deepEqual(native.document.profiles.default?.sampling?.bannedStrings, ["kept native ban"]);
  assert.deepEqual(native.document.profiles.default?.sampling?.logitBias, nativeSampling.logitBias);
  assert.equal(native.importedCount, 3);
  assert.equal(native.candidateCount, 3);
  assert.match(
    native.fidelity.join("; "),
    /banned string not imported; "ember" conflicts with an explicit numeric logit-bias entry in the same scope/u
  );
  validateSamplingRoute(
    "default",
    native.document.profiles.default!,
    native.document.models[native.document.profiles.default!.modelId]!,
    native.document.connections[native.document.models[native.document.profiles.default!.modelId]!.connectionId]!
  );
});

test("Profile transfer invalidates stale bias resolution after omitting native bans", () => {
  const bannedStrings = Array.from({ length: 201 }, (_, index) => index === 0 ? "ember" : `ban-${index}`);
  const sampling = {
    ...EMPTY_SAMPLING_V2,
    phraseBias: [{ phrase: "ember", weight: 1 }],
    bannedStrings
  };
  const precomputedResolution = resolveSamplingLogitBias(
    combineSamplingBiasSources(sampling),
    () => ({ kind: "single-token" as const, tokenId: 1 }),
    samplingBiasPresetRules("koboldcpp")
  );
  const kobold = {
    ...openAiDocument(),
    connections: {
      "builtin:dry-run": {
        ...openAiDocument().connections["builtin:dry-run"]!,
        preset: "koboldcpp" as const
      }
    }
  };
  const fitted = fitProfileToRoute(kobold, "default", {
    name: "Native ban overflow",
    sampling: {
      phraseBias: sampling.phraseBias,
      bannedStrings: sampling.bannedStrings
    }
  }, { samplingBiasResolution: precomputedResolution });
  assert.deepEqual(fitted.document.profiles.default?.sampling?.phraseBias, sampling.phraseBias);
  assert.deepEqual(fitted.document.profiles.default?.sampling?.bannedStrings, []);
  assert.equal(fitted.importedCount, 1);
  assert.equal(fitted.candidateCount, 2);
  assert.match(
    fitted.fidelity.join("; "),
    /banned strings not imported; 201 entries exceed the 200-entry native banned-string limit for preset koboldcpp/u
  );
  assert.doesNotMatch(fitted.fidelity.join("; "), /phrase bias not imported/u);
  validateSamplingRoute(
    "default",
    fitted.document.profiles.default!,
    fitted.document.models[fitted.document.profiles.default!.modelId]!,
    fitted.document.connections[fitted.document.models[fitted.document.profiles.default!.modelId]!.connectionId]!
  );
});

test("Profile transfer applies the native banned-string limit only to KoboldCpp", () => {
  const entries = (count: number) => Array.from({ length: count }, (_, index) => `ban-${index}`);
  const profileExport = (bannedStrings: readonly string[]) => JSON.stringify({
    profileExportVersion: 1,
    name: "Native bans",
    generation: {},
    sampling: { bannedStrings }
  });
  const kobold = {
    ...openAiDocument(),
    connections: {
      "builtin:dry-run": {
        ...openAiDocument().connections["builtin:dry-run"]!,
        preset: "koboldcpp" as const
      }
    }
  };

  const accepted = fitProfileToRoute(kobold, "default", importProfileExport(profileExport(entries(200))));
  const acceptedProfile = accepted.document.profiles.default!;
  assert.equal(acceptedProfile.sampling?.bannedStrings.length, 200);
  assert.equal(accepted.importedCount, accepted.candidateCount);
  const acceptedResolution = resolveSamplingLogitBias(
    combineSamplingBiasSources(acceptedProfile.sampling!),
    () => { throw new Error("native banned strings do not tokenize"); },
    samplingBiasPresetRules("koboldcpp")
  );
  validateSamplingRoute(
    "default",
    acceptedProfile,
    accepted.document.models[acceptedProfile.modelId]!,
    accepted.document.connections[accepted.document.models[acceptedProfile.modelId]!.connectionId]!,
    acceptedResolution
  );

  const overLimitProfile = {
    ...acceptedProfile,
    sampling: { ...acceptedProfile.sampling!, bannedStrings: entries(201) }
  };
  const overLimitResolution = resolveSamplingLogitBias(
    combineSamplingBiasSources(overLimitProfile.sampling),
    () => { throw new Error("native banned strings do not tokenize"); },
    samplingBiasPresetRules("koboldcpp")
  );
  assert.throws(
    () => validateSamplingRoute(
      "default",
      overLimitProfile,
      accepted.document.models[overLimitProfile.modelId]!,
      accepted.document.connections[accepted.document.models[overLimitProfile.modelId]!.connectionId]!,
      overLimitResolution
    ),
    /resolves to 201 banned-string entries, exceeding the 200-entry limit/u
  );

  const dropped = fitProfileToRoute(kobold, "default", importProfileExport(profileExport(entries(201))));
  const droppedProfile = dropped.document.profiles.default!;
  assert.equal(droppedProfile.sampling, undefined);
  assert.equal(dropped.importedCount, dropped.candidateCount - 1);
  assert.match(
    dropped.fidelity.join("; "),
    /banned strings not imported; 201 entries exceed the 200-entry native banned-string limit for preset koboldcpp/u
  );
  validateSamplingRoute(
    "default",
    droppedProfile,
    dropped.document.models[droppedProfile.modelId]!,
    dropped.document.connections[dropped.document.models[droppedProfile.modelId]!.connectionId]!
  );

  const tokenized = fitProfileToRoute(
    openAiDocument(),
    "default",
    importProfileExport(profileExport(entries(50)))
  );
  assert.equal(tokenized.document.profiles.default?.sampling?.bannedStrings.length, 50);
  assert.equal(tokenized.importedCount, tokenized.candidateCount);
});
