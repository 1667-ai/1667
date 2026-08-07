import assert from "node:assert/strict";
import test from "node:test";
import { importNovelAiSamplerPreset } from "../server/import-nai-preset.js";
import { validateSamplingRoute } from "../server/settings-v2-sampling-validation.js";
import { fitProfileToRoute } from "../shared/generation-profile-transfer.js";
import { openAiDocument } from "./generation-profile-transfer-fixtures.js";

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

