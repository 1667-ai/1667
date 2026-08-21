import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { canonicalJson } from "../server/canonical-json.js";
import {
  INITIAL_SETTINGS_DOCUMENT_V4,
  INITIAL_SETTINGS_STATE_V4,
  INITIAL_SETTINGS_DOCUMENT_V4_HASH,
  INITIAL_SETTINGS_STATE_V4_HASH
} from "../server/settings-v4-default.js";
import {
  formatSettingsDocumentV4,
  formatSettingsStateV4,
  hashSettingsDocumentV4,
  hashSettingsStateV4,
  parseSettingsDocumentV4Text,
  parseSettingsStateV4Text
} from "../server/settings-v4-codec.js";
import {
  parseSettingsStateSlotBytes,
  requireMutableSettingsStateSlot,
  settingsStateSlotV4ReadOnlyView
} from "../server/settings-state-slot.js";

test("schema 4 canonical vectors parse and round-trip", () => {
  assert.equal(hashSettingsDocumentV4(INITIAL_SETTINGS_DOCUMENT_V4), INITIAL_SETTINGS_DOCUMENT_V4_HASH);
  assert.equal(hashSettingsStateV4(INITIAL_SETTINGS_STATE_V4), INITIAL_SETTINGS_STATE_V4_HASH);
  assert.deepEqual(
    parseSettingsDocumentV4Text(formatSettingsDocumentV4(INITIAL_SETTINGS_DOCUMENT_V4)),
    INITIAL_SETTINGS_DOCUMENT_V4
  );
  assert.deepEqual(
    parseSettingsStateV4Text(formatSettingsStateV4(INITIAL_SETTINGS_STATE_V4)),
    INITIAL_SETTINGS_STATE_V4
  );
});

test("schema 4 requires the independent effort and thinking fields", () => {
  const raw = JSON.parse(formatSettingsDocumentV4(INITIAL_SETTINGS_DOCUMENT_V4)) as {
    profiles: Record<string, Record<string, unknown>>;
  };
  delete raw.profiles.default!.thinkingMode;
  assert.throws(
    () => parseSettingsDocumentV4Text(JSON.stringify(raw)),
    /thinkingMode/u
  );

  const legacy = JSON.parse(formatSettingsDocumentV4(INITIAL_SETTINGS_DOCUMENT_V4)) as {
    profiles: Record<string, Record<string, unknown>>;
  };
  legacy.profiles.default!.effort = "off";
  assert.throws(
    () => parseSettingsDocumentV4Text(JSON.stringify(legacy)),
    /effort/u
  );
});

function schema4DocumentWithReasoning(splitThinkTags: boolean): string {
  const raw = JSON.parse(formatSettingsDocumentV4(INITIAL_SETTINGS_DOCUMENT_V4)) as {
    connections: Record<string, Record<string, unknown>>;
    models: Record<string, { capabilities: Record<string, unknown> }>;
    profiles: Record<string, Record<string, unknown>>;
  };
  Object.assign(raw.connections["builtin:dry-run"]!, {
    baseUrl: "http://127.0.0.1:5000",
    preset: "koboldcpp",
    protocol: "text-completions",
    ...(splitThinkTags ? { splitThinkTags: true } : {})
  });
  raw.models["builtin:dry-run"]!.capabilities.reasoningContent = "unsupported";
  raw.profiles.default!.reasoning = "marker";
  return canonicalJson(raw);
}

test("schema 4 rejects reasoning display when effective content is unsupported", () => {
  assert.throws(
    () => parseSettingsDocumentV4Text(schema4DocumentWithReasoning(false)),
    /profile default sets reasoning on a model that returns none/u
  );
});

test("schema 4 accepts split think tags as effective reasoning content", () => {
  const document = parseSettingsDocumentV4Text(schema4DocumentWithReasoning(true));
  assert.equal(document.profiles.default?.reasoning, "marker");
  assert.equal(document.connections["builtin:dry-run"]?.splitThinkTags, true);
});

test("predecessor reads a schema 4 state without dropping thinking mode", () => {
  const bytes = Buffer.from(formatSettingsStateV4(INITIAL_SETTINGS_STATE_V4), "utf8");
  const slot = parseSettingsStateSlotBytes(bytes);
  assert.equal(slot.kind, "v4");
  assert.equal(
    settingsStateSlotV4ReadOnlyView(slot)?.documents["1"]?.profiles.default?.thinkingMode,
    "default"
  );
  assert.equal(
    settingsStateSlotV4ReadOnlyView(slot)?.documents["1"]?.profiles.default?.effort,
    "default"
  );
});

test("schema 4 slot parsing reports schema 4 validation errors", () => {
  const raw = JSON.parse(formatSettingsStateV4(INITIAL_SETTINGS_STATE_V4)) as {
    documents: Record<string, {
      profiles: Record<string, Record<string, unknown>>;
    }>;
  };
  delete raw.documents["1"]!.profiles.default!.thinkingMode;

  assert.throws(
    () => parseSettingsStateSlotBytes(Buffer.from(canonicalJson(raw), "utf8")),
    (error: unknown) => error instanceof Error
      && /thinkingMode/u.test(error.message)
      && !/schemaVersion must be 2/u.test(error.message)
  );
});

test("schema 4 mutation refusal leaves the state bytes identical", () => {
  const bytes = Buffer.from(formatSettingsStateV4(INITIAL_SETTINGS_STATE_V4), "utf8");
  const before = createHash("sha256").update(bytes).digest("hex");
  const slot = parseSettingsStateSlotBytes(bytes);
  assert.throws(
    () => requireMutableSettingsStateSlot(slot),
    (error: unknown) => error instanceof Error
      && "code" in error
      && error.code === "settings_requires_successor"
  );
  assert.equal(createHash("sha256").update(bytes).digest("hex"), before);
});
