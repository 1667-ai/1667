import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";
import { INITIAL_SETTINGS_DOCUMENT_V2 } from "../server/settings-v2-default.js";
import { effectiveGenerationSettings } from "../server/settings-v2-conversion.js";
import {
  combineSamplingBiasSources,
  resolveSamplingLogitBias
} from "../server/sampling-phrase-bias.js";
import { validateSamplingRoute } from "../server/settings-v2-sampling-validation.js";
import { exportGenerationProfile, importProfileExport } from "../server/import-profile-export.js";
import { importNovelAiSamplerPreset } from "../server/import-nai-preset.js";
import {
  MAX_PROFILE_TRANSFER_BYTES,
  MAX_SAMPLER_PRESET_BYTES,
  readProfileTransferFile
} from "../server/profile-transfer-decoder.js";
import { samplingBiasPresetRules } from "../shared/sampling-capabilities.js";
import { EMPTY_SAMPLING_V2, type SamplingPhraseBiasEntryV2 } from "../shared/settings-v2-types.js";
import {
  generationEffortAvailabilityForTarget,
  generationEffortChoicesForTarget
} from "../shared/generation-effort-capabilities.js";
import { fitProfileToRoute } from "../shared/generation-profile-transfer.js";

function openAiDocument() {
  return {
    ...INITIAL_SETTINGS_DOCUMENT_V2,
    connections: {
      "builtin:dry-run": {
        ...INITIAL_SETTINGS_DOCUMENT_V2.connections["builtin:dry-run"]!,
        protocol: "openai-chat-completions" as const,
        preset: "llama-cpp" as const
      }
    },
    models: {
      "builtin:dry-run": {
        ...INITIAL_SETTINGS_DOCUMENT_V2.models["builtin:dry-run"]!,
        remoteId: "local-model"
      }
    }
  };
}

test("Sampler Preset uses order, protects foreign token IDs, and fits the selected route", () => {
  const candidate = importNovelAiSamplerPreset(JSON.stringify({
    presetVersion: 7,
    name: "Dragonfruit",
    parameters: {
      temperature: 1.2,
      top_p: 0.92,
      top_k: 0,
      min_p: 0.04,
      repetition_penalty: 3.25,
      repetition_penalty_frequency: 4,
      bad_words_ids: [[1, 2]],
      order: [
        { id: "temperature", enabled: true },
        { id: "top_p", enabled: true },
        { id: "min_p", enabled: false }
      ]
    }
  }));
  const fitted = fitProfileToRoute(openAiDocument(), "default", candidate);
  const profile = fitted.document.profiles.default!;
  assert.equal(profile.name, "Dragonfruit");
  assert.equal(profile.temperature, 1.2);
  assert.equal(profile.sampling?.topP, 0.92);
  assert.equal(profile.sampling?.topK, null);
  assert.equal(profile.sampling?.minP, null);
  assert.equal(profile.sampling?.frequencyPenalty, 2);
  assert.equal(fitted.importedCount, 3);
  assert.equal(fitted.candidateCount, 6);
  assert.match(fitted.fidelity.join("; "), /NovelAI token-ID parameters not imported/u);
  assert.match(fitted.fidelity.join("; "), /min p disabled/u);
  assert.match(fitted.fidelity.join("; "), /sampler order not imported; target order applies/u);
  validateSamplingRoute(
    "default",
    profile,
    fitted.document.models[profile.modelId]!,
    fitted.document.connections[fitted.document.models[profile.modelId]!.connectionId]!
  );
});

test("Sampler Preset v3 numeric order enables only its listed samplers", () => {
  const candidate = importNovelAiSamplerPreset(JSON.stringify({
    presetVersion: 3,
    name: "Numeric order",
    parameters: {
      temperature: 0.7,
      top_k: 40,
      top_p: 0.9,
      min_p: 0.08,
      tail_free_sampling: 0.95,
      top_a: 0.04,
      repetition_penalty_frequency: 0.3,
      repetition_penalty_presence: 0.2,
      mirostat: true,
      mirostat_tau: 5,
      mirostat_lr: 0.1,
      order: [0, 10]
    }
  }));

  assert.equal(candidate.temperature, 0.7);
  assert.deepEqual(candidate.sampling, {
    minP: 0.08,
    frequencyPenalty: 0.3,
    presencePenalty: 0.2
  });
  assert.match(candidate.fidelity?.join("; ") ?? "", /top p disabled in the Sampler Preset skipped/u);
  assert.match(candidate.fidelity?.join("; ") ?? "", /top k disabled in the Sampler Preset skipped/u);
  assert.equal(candidate.omittedCount, 1);
  assert.match(candidate.fidelity?.join("; ") ?? "", /sampler order not imported; target order applies/u);

  const fitted = fitProfileToRoute(openAiDocument(), "default", candidate);
  assert.equal(fitted.document.profiles.default?.temperature, 0.7);
  assert.equal(fitted.document.profiles.default?.sampling?.minP, 0.08);
  assert.equal(fitted.document.profiles.default?.sampling?.frequencyPenalty, 0.3);
  assert.equal(fitted.document.profiles.default?.sampling?.presencePenalty, 0.2);
  assert.equal(fitted.document.profiles.default?.sampling?.topP, null);
  assert.equal(fitted.document.profiles.default?.sampling?.topK, null);
});

test("Sampler Preset numeric order ignores unknown sampler IDs", () => {
  const candidate = importNovelAiSamplerPreset(JSON.stringify({
    presetVersion: 3,
    parameters: {
      temperature: 0.7,
      top_p: 0.9,
      order: [0, 99]
    }
  }));

  assert.equal(candidate.temperature, 0.7);
  assert.equal(candidate.sampling?.topP, undefined);
  assert.equal(candidate.omittedCount, 1);
  assert.match(candidate.fidelity?.join("; ") ?? "", /sampler ID 99 not imported; it is unknown/u);
});

test("Sampler Preset reports sampler order only when two known samplers are active", () => {
  const objectOrder = importNovelAiSamplerPreset(JSON.stringify({
    presetVersion: 7,
    parameters: {
      temperature: 0.7,
      top_p: 0.9,
      min_p: 0.1,
      order: [
        { id: "temperature", enabled: true },
        { id: "top_p", enabled: true },
        { id: "min_p", enabled: false }
      ]
    }
  }));
  assert.equal(objectOrder.omittedCount, 1);
  assert.equal(
    objectOrder.fidelity?.filter((message) => message === "sampler order not imported; target order applies").length,
    1
  );

  const oneActive = importNovelAiSamplerPreset(JSON.stringify({
    presetVersion: 7,
    parameters: {
      temperature: 0.7,
      order: [{ id: "temperature", enabled: true }]
    }
  }));
  assert.equal(oneActive.omittedCount, 0);
  assert.doesNotMatch(oneActive.fidelity?.join("; ") ?? "", /sampler order not imported/u);
});

test("Sampler Preset rejects malformed numeric orders without enabling stored samplers", () => {
  for (const order of [
    [0, { id: "top_p", enabled: true }],
    [0, 1.5]
  ]) {
    assert.throws(
      () => importNovelAiSamplerPreset(JSON.stringify({
        presetVersion: 3,
        parameters: { top_p: 0.9, top_k: 40, order }
      })),
      /Sampler Preset has an invalid order/u
    );
  }
});

test("Sampler Preset object order keeps unlisted samplers enabled", () => {
  const candidate = importNovelAiSamplerPreset(JSON.stringify({
    presetVersion: 7,
    parameters: {
      temperature: 0.7,
      top_k: 40,
      top_p: 0.9,
      order: [{ id: "top_p", enabled: false }]
    }
  }));

  assert.equal(candidate.temperature, 0.7);
  assert.equal(candidate.sampling?.topK, 40);
  assert.equal(candidate.sampling?.topP, undefined);
  assert.match(candidate.fidelity?.join("; ") ?? "", /top p disabled in the Sampler Preset skipped/u);
});

test("Sampler Preset counts active omissions and ignores envelope metadata", () => {
  const candidate = importNovelAiSamplerPreset(JSON.stringify({
    presetVersion: 7,
    name: "Real field names",
    parameters: {
      textGenerationSettingsVersion: 3,
      top_a: 0.2,
      tail_free_sampling: 0.8,
      cfg_scale: 1,
      phrase_rep_pen: "off",
      bad_words_ids: [],
      order: [
        { id: "top_a", enabled: false },
        { id: "tfs", enabled: true },
        { id: "cfg", enabled: false }
      ]
    }
  }));
  const fitted = fitProfileToRoute(openAiDocument(), "default", candidate);
  assert.equal(candidate.omittedCount, 1);
  assert.equal(fitted.importedCount, 0);
  assert.equal(fitted.candidateCount, 1);
  assert.match(fitted.fidelity.join("; "), /tail free sampling not imported/u);
  assert.doesNotMatch(fitted.fidelity.join("; "), /textGenerationSettingsVersion|top a|cfg scale|phrase rep pen|token-ID/u);
});

test("Sampler Preset reports a malformed Mirostat learning rate", () => {
  const candidate = importNovelAiSamplerPreset(JSON.stringify({
    presetVersion: 7,
    parameters: {
      mirostat: true,
      mirostat_tau: 5,
      mirostat_lr: "fast",
      order: [{ id: "mirostat", enabled: true }]
    }
  }));
  const fitted = fitProfileToRoute(openAiDocument(), "default", candidate);
  assert.equal(fitted.importedCount, 2);
  assert.equal(fitted.candidateCount, 3);
  assert.match(fitted.fidelity.join("; "), /mirostat learning rate not imported/u);
});

test("Sampler Preset normalizes invalid names before the profile draft", () => {
  const blank = importNovelAiSamplerPreset(JSON.stringify({ presetVersion: 7, name: "  ", parameters: {} }));
  const long = importNovelAiSamplerPreset(JSON.stringify({ presetVersion: 7, name: "a".repeat(300), parameters: {} }));
  const malformed = importNovelAiSamplerPreset(`{"presetVersion":7,"name":"bad\ud800","parameters":{}}`);
  assert.equal(blank.name, "Imported Sampler Preset");
  assert.equal(malformed.name, "Imported Sampler Preset");
  assert.equal([...long.name].length, 256);
});

test("Sampler Preset clears a selected temperature when order disables it", () => {
  const candidate = importNovelAiSamplerPreset(JSON.stringify({
    presetVersion: 7,
    parameters: {
      temperature: 1.2,
      order: [{ id: "temperature", enabled: false }]
    }
  }));
  const base = {
    ...openAiDocument(),
    profiles: {
      default: { ...openAiDocument().profiles.default!, temperature: 0.75 }
    }
  };
  const fitted = fitProfileToRoute(base, "default", candidate);
  assert.equal(candidate.temperature, null);
  assert.equal(fitted.document.profiles.default?.temperature, null);
  assert.equal(fitted.importedCount, 1);
  assert.equal(fitted.candidateCount, 1);
  assert.match(fitted.fidelity.join("; "), /temperature disabled in the Sampler Preset skipped/u);
});

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

test("Profile transfer resolves prompt caching by exact route and policy", () => {
  const official = {
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
        remoteId: "gpt-5.6",
        capabilities: {
          ...openAiDocument().models["builtin:dry-run"]!.capabilities,
          promptCaching: "unknown" as const
        }
      }
    }
  };
  const automatic = fitProfileToRoute(official, "default", {
    name: "Exact OpenAI",
    cachePolicy: "auto"
  });
  assert.equal(automatic.document.profiles.default?.cachePolicy, "auto");
  assert.equal(automatic.importedCount, 1);
  assert.equal(automatic.candidateCount, 1);

  const long = fitProfileToRoute(official, "default", {
    name: "Unsupported long cache",
    cachePolicy: "long"
  });
  assert.equal(long.document.profiles.default?.cachePolicy, "off");
  assert.equal(long.importedCount, 0);
  assert.equal(long.candidateCount, 1);
  assert.match(long.fidelity.join("; "), /cache policy not imported; No long cache\./u);
});

test("Profile transfer rejects Anthropic effort off through the exact route", () => {
  const anthropic = {
    ...openAiDocument(),
    connections: {
      "builtin:dry-run": {
        ...openAiDocument().connections["builtin:dry-run"]!,
        protocol: "anthropic-messages" as const,
        preset: "anthropic" as const,
        baseUrl: "https://api.anthropic.com"
      }
    },
    models: {
      "builtin:dry-run": {
        ...openAiDocument().models["builtin:dry-run"]!,
        capabilities: {
          ...openAiDocument().models["builtin:dry-run"]!.capabilities,
          reasoningEffort: "supported" as const
        }
      }
    },
    profiles: {
      default: { ...openAiDocument().profiles.default!, effort: "medium" as const }
    }
  };
  const fitted = fitProfileToRoute(anthropic, "default", {
    name: "No off",
    effort: "off"
  });
  assert.equal(fitted.document.profiles.default?.effort, "medium");
  assert.equal(fitted.importedCount, 0);
  assert.equal(fitted.candidateCount, 1);
  assert.match(
    fitted.fidelity.join("; "),
    /reasoning effort not imported; Anthropic does not support generation effort set to off/u
  );
  const target = { protocol: "anthropic-messages" as const, reasoningEffort: "supported" as const };
  assert.deepEqual(generationEffortChoicesForTarget(target), ["default", "low", "medium", "high"]);
  assert.deepEqual(generationEffortAvailabilityForTarget(target, "off"), {
    kind: "unavailable",
    code: "anthropic-off",
    reason: "Anthropic does not support generation effort set to off"
  });
  assert.throws(
    () => effectiveGenerationSettings({
      ...anthropic,
      profiles: {
        ...anthropic.profiles,
        default: { ...anthropic.profiles.default!, effort: "off" }
      }
    }),
    /Anthropic does not support generation effort set to off\./u
  );
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

test("Profile transfer omits Mirostat when the selected route cannot use it", () => {
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
  const anthropic = {
    ...openAiDocument(),
    connections: {
      "builtin:dry-run": {
        ...openAiDocument().connections["builtin:dry-run"]!,
        protocol: "anthropic-messages" as const,
        preset: "anthropic" as const,
        baseUrl: "https://api.anthropic.com"
      }
    }
  };
  for (const target of [officialOpenAi, anthropic]) {
    const fitted = fitProfileToRoute(target, "default", {
      name: "Unsupported Mirostat",
      sampling: { mirostat: 2, mirostatTau: 5, mirostatEta: 0.2 }
    });
    const profile = fitted.document.profiles.default!;
    assert.equal(profile.sampling, undefined);
    assert.equal(fitted.importedCount, 0);
    assert.equal(fitted.candidateCount, 3);
    assert.match(fitted.fidelity.join("; "), /mirostat not imported/u);
    validateSamplingRoute(
      "default",
      profile,
      fitted.document.models[profile.modelId]!,
      fitted.document.connections[fitted.document.models[profile.modelId]!.connectionId]!
    );
    assert.doesNotThrow(() => effectiveGenerationSettings(fitted.document));
  }
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

test("Profile transfer caps maximum output with the runtime model limit policy", () => {
  const candidate = { name: "Bounded", maxOutputTokens: 2_048 };
  const override = {
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
        remoteId: "gpt-4.1",
        discovered: { maxOutputTokens: 1_024 },
        overrides: { maxOutputTokens: 512 }
      }
    }
  };
  const overrideFit = fitProfileToRoute(override, "default", candidate);
  assert.equal(overrideFit.document.profiles.default?.maxOutputTokens, 512);
  assert.equal(effectiveGenerationSettings(overrideFit.document).maxTokens, 512);
  assert.deepEqual(overrideFit.fidelity, ["maximum output clamped to 512"]);

  const discovered = {
    ...override,
    models: {
      "builtin:dry-run": {
        ...override.models["builtin:dry-run"]!,
        overrides: {}
      }
    }
  };
  const discoveredFit = fitProfileToRoute(discovered, "default", candidate);
  assert.equal(discoveredFit.document.profiles.default?.maxOutputTokens, 1_024);
  assert.equal(effectiveGenerationSettings(discoveredFit.document).maxTokens, 1_024);
  assert.deepEqual(discoveredFit.fidelity, ["maximum output clamped to 1024"]);

  const unknown = {
    ...discovered,
    models: {
      "builtin:dry-run": {
        ...discovered.models["builtin:dry-run"]!,
        discovered: {}
      }
    }
  };
  const unknownFit = fitProfileToRoute(unknown, "default", candidate);
  assert.equal(unknownFit.document.profiles.default?.maxOutputTokens, 2_048);
  assert.equal(effectiveGenerationSettings(unknownFit.document).maxTokens, 2_048);
  assert.deepEqual(unknownFit.fidelity, []);

  const runtimeMetadata = { runtime: { maxOutputTokens: 640 }, builtin: { maxOutputTokens: 320 } };
  const runtimeFit = fitProfileToRoute(unknown, "default", candidate, {
    modelMetadata: runtimeMetadata
  });
  assert.equal(runtimeFit.document.profiles.default?.maxOutputTokens, 640);
  assert.equal(effectiveGenerationSettings(runtimeFit.document, "default", runtimeMetadata).maxTokens, 640);
  assert.deepEqual(runtimeFit.fidelity, ["maximum output clamped to 640"]);

  const builtinMetadata = { builtin: { maxOutputTokens: 320 } };
  const builtinFit = fitProfileToRoute(unknown, "default", candidate, {
    modelMetadata: builtinMetadata
  });
  assert.equal(builtinFit.document.profiles.default?.maxOutputTokens, 320);
  assert.equal(effectiveGenerationSettings(builtinFit.document, "default", builtinMetadata).maxTokens, 320);
  assert.deepEqual(builtinFit.fidelity, ["maximum output clamped to 320"]);
});

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
    phraseBias: [{ phrase: "unknown-token", weight: 1 }]
  };
  const rejectedResolution = resolveSamplingLogitBias(
    combineSamplingBiasSources(rejectedSampling),
    () => ({ kind: "unencodable" as const }),
    samplingBiasPresetRules("llama-cpp")
  );
  const rejected = fitProfileToRoute(openAiDocument(), "default", {
    name: "Rejected phrase",
    sampling: { phraseBias: rejectedSampling.phraseBias }
  }, { samplingBiasResolution: rejectedResolution });
  assert.equal(rejected.document.profiles.default?.sampling, undefined);
  assert.equal(rejected.importedCount, 0);
  assert.equal(rejected.candidateCount, 1);
  assert.match(
    rejected.fidelity.join("; "),
    /phrase bias not imported; "unknown-token" has no exact token/u
  );
  validateSamplingRoute(
    "default",
    rejected.document.profiles.default!,
    rejected.document.models[rejected.document.profiles.default!.modelId]!,
    rejected.document.connections[rejected.document.models[rejected.document.profiles.default!.modelId]!.connectionId]!
  );

  const nativeSampling = {
    ...EMPTY_SAMPLING_V2,
    logitBias: { "1": 1 },
    phraseBias: [{ phrase: "ember", weight: 1 }],
    bannedStrings: ["ember"]
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
  assert.deepEqual(native.document.profiles.default?.sampling?.bannedStrings, []);
  assert.deepEqual(native.document.profiles.default?.sampling?.logitBias, nativeSampling.logitBias);
  assert.equal(native.importedCount, 2);
  assert.equal(native.candidateCount, 3);
  assert.match(
    native.fidelity.join("; "),
    /banned strings not imported; "ember" conflicts with an explicit numeric logit-bias entry in the same scope/u
  );
  validateSamplingRoute(
    "default",
    native.document.profiles.default!,
    native.document.models[native.document.profiles.default!.modelId]!,
    native.document.connections[native.document.models[native.document.profiles.default!.modelId]!.connectionId]!
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
