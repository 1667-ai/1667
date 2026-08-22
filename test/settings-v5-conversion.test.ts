import assert from "node:assert/strict";
import test from "node:test";
import { convertSettingsDocumentV2ToV3 } from "../server/settings-v3-conversion.js";
import {
  convertSettingsDocumentV2ToV5,
  convertSettingsDocumentV3ToV5,
  convertSettingsDocumentV4ToV5,
  convertSettingsStateV4ToV5
} from "../server/settings-v5-conversion.js";
import { INITIAL_SETTINGS_DOCUMENT_V2 } from "../server/settings-v2-default.js";
import { INITIAL_SETTINGS_DOCUMENT_V3 } from "../server/settings-v3-default.js";
import {
  INITIAL_SETTINGS_DOCUMENT_V4,
  INITIAL_SETTINGS_STATE_V4
} from "../server/settings-v4-default.js";
import {
  INITIAL_SETTINGS_DOCUMENT_V5,
  INITIAL_SETTINGS_STATE_V5
} from "../server/settings-v5-default.js";
import { formatSettingsDocumentV2 } from "../server/settings-v2-codec.js";
import { parseSettingsDocumentV2 } from "../server/settings-v2-codec.js";
import { DEFAULT_CONTINUE_DIRECTION } from "../shared/settings-v5-writing.js";

test("schema 2 conversion keeps legacy effort including off and adds writing defaults", () => {
  const converted = convertSettingsDocumentV2ToV5(INITIAL_SETTINGS_DOCUMENT_V2);
  assert.equal(converted.schemaVersion, 5);
  assert.deepEqual(converted.profiles.default?.generationReasoning, {
    kind: "legacy",
    effort: "default"
  });
  assert.equal(converted.models["builtin:dry-run"]?.capabilities.imageInput, "unsupported");
  assert.equal(converted.writing.defaultAuthorBrief, INITIAL_SETTINGS_DOCUMENT_V2.writing.defaultAuthorBrief);
  assert.equal(converted.writing.defaultContinueDirection, DEFAULT_CONTINUE_DIRECTION);
  assert.equal(converted.writing.rewriteGuidance, "");
  assert.equal(converted.writing.titleGuidance, "");
  assert.equal(converted.writing.summaryGuidance, "");
  assert.equal(converted.writing.asideGuidance, "");
});

test("schema 2 conversion maps dry-run imageInput unsupported and others unknown", () => {
  const openAi = JSON.parse(formatSettingsDocumentV2(INITIAL_SETTINGS_DOCUMENT_V2)) as {
    connections: Record<string, { protocol: string; preset: string; baseUrl: string | null }>;
    models: Record<string, { capabilities: Record<string, unknown> }>;
  };
  openAi.connections["builtin:dry-run"] = {
    ...openAi.connections["builtin:dry-run"]!,
    protocol: "openai-chat-completions",
    preset: "openai",
    baseUrl: "https://api.openai.com/v1"
  };
  const document = parseSettingsDocumentV2(openAi);
  const converted = convertSettingsDocumentV2ToV5(document);
  assert.equal(converted.models["builtin:dry-run"]?.capabilities.imageInput, "unknown");
});

test("schema 2 conversion preserves legacy effort off on a supporting model", () => {
  const raw = JSON.parse(formatSettingsDocumentV2(INITIAL_SETTINGS_DOCUMENT_V2)) as {
    connections: Record<string, Record<string, unknown>>;
    models: Record<string, { capabilities: Record<string, unknown> }>;
    profiles: Record<string, Record<string, unknown>>;
  };
  raw.connections["builtin:dry-run"] = {
    ...raw.connections["builtin:dry-run"]!,
    protocol: "openai-chat-completions",
    preset: "openai",
    baseUrl: "https://api.openai.com/v1"
  };
  raw.models["builtin:dry-run"]!.capabilities.reasoningEffort = "supported";
  raw.profiles.default!.effort = "off";
  const converted = convertSettingsDocumentV2ToV5(parseSettingsDocumentV2(raw));
  assert.deepEqual(converted.profiles.default?.generationReasoning, {
    kind: "legacy",
    effort: "off"
  });
});

test("schema 3 conversion keeps image capability and uses legacy reasoning", () => {
  const fromV2 = convertSettingsDocumentV2ToV3(INITIAL_SETTINGS_DOCUMENT_V2);
  const converted = convertSettingsDocumentV3ToV5(fromV2);
  assert.equal(converted.models["builtin:dry-run"]?.capabilities.imageInput, "unsupported");
  assert.deepEqual(converted.profiles.default?.generationReasoning, {
    kind: "legacy",
    effort: "default"
  });
  const native = convertSettingsDocumentV3ToV5(INITIAL_SETTINGS_DOCUMENT_V3);
  assert.deepEqual(
    native.profiles.default?.generationReasoning,
    { kind: "legacy", effort: "default" }
  );
});

test("schema 4 conversion uses independent reasoning and does not infer from equal scalars", () => {
  const converted = convertSettingsDocumentV4ToV5(INITIAL_SETTINGS_DOCUMENT_V4);
  assert.deepEqual(converted.profiles.default?.generationReasoning, {
    kind: "independent",
    effort: "default",
    thinkingMode: "default"
  });
  assert.notDeepEqual(
    converted.profiles.default?.generationReasoning,
    convertSettingsDocumentV2ToV5(INITIAL_SETTINGS_DOCUMENT_V2).profiles.default?.generationReasoning
  );
  assert.deepEqual(converted, INITIAL_SETTINGS_DOCUMENT_V5);
});

test("schema 4 initial state converts to the schema 5 initial state", () => {
  assert.deepEqual(convertSettingsStateV4ToV5(INITIAL_SETTINGS_STATE_V4), INITIAL_SETTINGS_STATE_V5);
});

test("schema 2 genesis document conversion is not the schema 5 initial vector", () => {
  const converted = convertSettingsDocumentV2ToV5(INITIAL_SETTINGS_DOCUMENT_V2);
  assert.notEqual(converted.profiles.default?.generationReasoning.kind, "independent");
  assert.notDeepEqual(converted, INITIAL_SETTINGS_DOCUMENT_V5);
});
