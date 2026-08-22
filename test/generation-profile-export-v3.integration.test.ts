import assert from "node:assert/strict";
import test from "node:test";
import {
  exportGenerationProfile,
  exportGenerationProfileV5,
  importProfileExport
} from "../server/import-profile-export.js";
import { convertSettingsDocumentV2ToV5, convertSettingsDocumentV4ToV5 } from "../server/settings-v5-conversion.js";
import { INITIAL_SETTINGS_DOCUMENT_V2 } from "../server/settings-v2-default.js";
import { INITIAL_SETTINGS_DOCUMENT_V4 } from "../server/settings-v4-default.js";
import { fitProfileToRoute } from "../shared/generation-profile-transfer.js";
import { openAiDocument } from "./generation-profile-transfer-fixtures.js";

test("legacy schema-5 profiles export as v1 with exact v2 bytes", () => {
  const v2 = INITIAL_SETTINGS_DOCUMENT_V2;
  const v2Export = exportGenerationProfile(v2, "default");
  const v5 = convertSettingsDocumentV2ToV5(v2);
  const v5Export = exportGenerationProfileV5(v5, "default");
  assert.equal(JSON.parse(v2Export.text).profileExportVersion, 1);
  assert.equal(v5Export.text, v2Export.text);
});

test("independent schema-5 profiles export as v3 including default/default", () => {
  const v5 = convertSettingsDocumentV4ToV5(INITIAL_SETTINGS_DOCUMENT_V4);
  const exported = exportGenerationProfileV5(v5, "default");
  const payload = JSON.parse(exported.text) as {
    profileExportVersion: number;
    generation: { effort?: string; thinkingMode?: string };
  };
  assert.equal(payload.profileExportVersion, 3);
  assert.equal(payload.generation.effort, "default");
  assert.equal(payload.generation.thinkingMode, "default");
  const candidate = importProfileExport(exported.text);
  assert.deepEqual(candidate.reasoning, {
    kind: "independent",
    effort: "default",
    thinkingMode: "default"
  });
  assert.equal(candidate.effort, undefined);
});

test("version-1 omitted effort leaves destination reasoning unchanged", () => {
  const source = {
    ...openAiDocument(),
    profiles: {
      default: { ...openAiDocument().profiles.default!, effort: "high" as const }
    }
  };
  const candidate = importProfileExport(JSON.stringify({
    profileExportVersion: 1,
    name: "No effort",
    generation: { temperature: 0.5 }
  }));
  assert.equal(candidate.effort, undefined);
  assert.equal(candidate.reasoning, undefined);
  const fitted = fitProfileToRoute(source, "default", candidate);
  assert.equal(fitted.document.profiles.default?.effort, "high");
});

test("version-3 independent reasoning is rejected atomically on a schema-2 destination", () => {
  const candidate = importProfileExport(JSON.stringify({
    profileExportVersion: 3,
    name: "Independent",
    generation: { effort: "high", thinkingMode: "on" }
  }));
  const fitted = fitProfileToRoute(openAiDocument(), "default", candidate);
  assert.equal(fitted.document.profiles.default?.effort, openAiDocument().profiles.default?.effort);
  assert.match(
    fitted.fidelity.join("; "),
    /independent reasoning not imported; destination profile cannot store Thinking Mode/u
  );
});

test("Profile Export version 3 requires both effort and thinkingMode", () => {
  assert.throws(
    () => importProfileExport(JSON.stringify({
      profileExportVersion: 3,
      name: "incomplete",
      generation: { effort: "high" }
    })),
    /must set effort and thinkingMode/u
  );
  assert.throws(
    () => importProfileExport(JSON.stringify({
      profileExportVersion: 1,
      name: "unsafe v1",
      generation: { thinkingMode: "on" }
    })),
    /unsupported field/u
  );
});
