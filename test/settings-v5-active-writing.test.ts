import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { decodeSettingsViewResponse } from "../shared/settings-response-decoder.js";
import {
  DEFAULT_AUTHOR_BRIEF,
  DEFAULT_WRITING_PROMPT_SETTINGS,
  writingPromptSettingsFromAuthorBrief
} from "../shared/settings-v5-writing.js";
import { SETTINGS_STATE_V2_FILE } from "../server/data-directory-layout.js";
import { createSettingsRuntimeResolver } from "../server/settings-runtime-resolver.js";
import { INITIAL_SETTINGS_STATE_V2 } from "../server/settings-v2-default.js";
import { formatSettingsStateV2 } from "../server/settings-v2-codec.js";
import { reduceSettingsStateV2 } from "../server/settings-v2-reducer.js";
import {
  formatSettingsStateV3,
  parseSettingsDocumentV3
} from "../server/settings-v3-codec.js";
import {
  INITIAL_SETTINGS_DOCUMENT_V3,
  INITIAL_SETTINGS_STATE_V3
} from "../server/settings-v3-default.js";
import { reduceSettingsStateV3 } from "../server/settings-v3-reducer.js";
import {
  formatSettingsStateV4,
  parseSettingsDocumentV4
} from "../server/settings-v4-codec.js";
import {
  INITIAL_SETTINGS_DOCUMENT_V4,
  INITIAL_SETTINGS_STATE_V4
} from "../server/settings-v4-default.js";
import { reduceSettingsStateV4 } from "../server/settings-v4-reducer.js";
import {
  formatSettingsStateV5,
  parseSettingsDocumentV5
} from "../server/settings-v5-codec.js";
import {
  INITIAL_SETTINGS_DOCUMENT_V5,
  INITIAL_SETTINGS_STATE_V5
} from "../server/settings-v5-default.js";
import { reduceSettingsStateV5 } from "../server/settings-v5-reducer.js";
import { readSettingsView } from "../server/settings-v2-view-read.js";
import { createSubscriptionRuntime } from "../server/subscription-runtime.js";
import {
  credentialedDocument,
  initializedFormat2Directory,
  MUTATION_A
} from "./settings-store-fixtures.js";

const PENDING_BRIEF = "Pending candidate brief.";
const PENDING_ENV = "AI_1667_ACTIVE_WRITING_PENDING_KEY";
type SchemaVersion = 2 | 3 | 4 | 5;

test("the production settings view reads active writing across schema 2-5", async (t) => {
  for (const schema of [2, 3, 4, 5] as const) {
    await t.test(`schema-${schema}`, async (sub) => {
      const dataDir = await initializedFormat2Directory(
        sub,
        `1667-active-writing-schema-${schema}-`
      );
      await writeStagedState(dataDir, schema);
      const view = await loadView(dataDir);

      assert.equal(view.pendingRevision, 2);
      assert.equal(view.document?.writing.defaultAuthorBrief, PENDING_BRIEF);
      assert.equal(view.effective.provider, "dry-run");
      assert.deepEqual(
        view.activeWriting,
        schema === 5
          ? DEFAULT_WRITING_PROMPT_SETTINGS
          : writingPromptSettingsFromAuthorBrief(DEFAULT_AUTHOR_BRIEF)
      );
    });
  }
});

test("settings view decoder requires closed activeWriting from the production view", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-active-writing-decoder-");
  await writeStagedState(dataDir, 5);
  const view = await loadView(dataDir);
  const decoded = decodeSettingsViewResponse(
    JSON.parse(JSON.stringify(view)),
    parseSettingsDocumentV5
  );
  assert.deepEqual(decoded.activeWriting, view.activeWriting);
  assert.equal(decoded.document?.schemaVersion, 5);
  const { activeWriting: _activeWriting, ...without } = view;
  assert.throws(
    () => decodeSettingsViewResponse(without, parseSettingsDocumentV5),
    /settings view/u
  );
});

async function loadView(dataDir: string) {
  const runtimeResolver = createSettingsRuntimeResolver({
    environment: {},
    subscription: createSubscriptionRuntime(dataDir)
  });
  return await readSettingsView(dataDir, runtimeResolver.credentials, runtimeResolver);
}

async function writeStagedState(dataDir: string, schema: SchemaVersion): Promise<void> {
  const pointer = {
    receiptKind: "user" as const,
    mutationId: MUTATION_A,
    phase: "prepared" as const
  };
  switch (schema) {
    case 2: {
      const state = reduceSettingsStateV2(INITIAL_SETTINGS_STATE_V2, {
        kind: "save-document",
        document: pendingDocumentV2(),
        lastTransaction: pointer
      });
      await writeFile(
        path.join(dataDir, SETTINGS_STATE_V2_FILE),
        formatSettingsStateV2(state),
        { mode: 0o600 }
      );
      return;
    }
    case 3: {
      const state = reduceSettingsStateV3(INITIAL_SETTINGS_STATE_V3, {
        kind: "save-document",
        document: pendingDocumentV3(),
        lastTransaction: pointer
      });
      await writeFile(
        path.join(dataDir, SETTINGS_STATE_V2_FILE),
        formatSettingsStateV3(state),
        { mode: 0o600 }
      );
      return;
    }
    case 4: {
      const state = reduceSettingsStateV4(INITIAL_SETTINGS_STATE_V4, {
        kind: "save-document",
        document: pendingDocumentV4(),
        lastTransaction: pointer
      });
      await writeFile(
        path.join(dataDir, SETTINGS_STATE_V2_FILE),
        formatSettingsStateV4(state),
        { mode: 0o600 }
      );
      return;
    }
    case 5: {
      const state = reduceSettingsStateV5(INITIAL_SETTINGS_STATE_V5, {
        kind: "save-document",
        document: pendingDocumentV5(),
        lastTransaction: pointer
      });
      await writeFile(
        path.join(dataDir, SETTINGS_STATE_V2_FILE),
        formatSettingsStateV5(state),
        { mode: 0o600 }
      );
      return;
    }
  }
}

function pendingDocumentV2() {
  return {
    ...credentialedDocument(PENDING_ENV),
    writing: { defaultAuthorBrief: PENDING_BRIEF }
  };
}

function pendingDocumentV3() {
  const connection = INITIAL_SETTINGS_DOCUMENT_V3.connections["builtin:dry-run"]!;
  return parseSettingsDocumentV3({
    ...INITIAL_SETTINGS_DOCUMENT_V3,
    connections: {
      ...INITIAL_SETTINGS_DOCUMENT_V3.connections,
      "builtin:dry-run": {
        ...connection,
        preset: "openai",
        protocol: "openai-chat-completions",
        baseUrl: "https://api.openai.com/v1",
        auth: { type: "bearer-env", env: PENDING_ENV }
      }
    },
    writing: { defaultAuthorBrief: PENDING_BRIEF }
  });
}

function pendingDocumentV4() {
  const connection = INITIAL_SETTINGS_DOCUMENT_V4.connections["builtin:dry-run"]!;
  return parseSettingsDocumentV4({
    ...INITIAL_SETTINGS_DOCUMENT_V4,
    connections: {
      ...INITIAL_SETTINGS_DOCUMENT_V4.connections,
      "builtin:dry-run": {
        ...connection,
        preset: "openai",
        protocol: "openai-chat-completions",
        baseUrl: "https://api.openai.com/v1",
        auth: { type: "bearer-env", env: PENDING_ENV }
      }
    },
    writing: { defaultAuthorBrief: PENDING_BRIEF }
  });
}

function pendingDocumentV5() {
  const connection = INITIAL_SETTINGS_DOCUMENT_V5.connections["builtin:dry-run"]!;
  return parseSettingsDocumentV5({
    ...INITIAL_SETTINGS_DOCUMENT_V5,
    connections: {
      ...INITIAL_SETTINGS_DOCUMENT_V5.connections,
      "builtin:dry-run": {
        ...connection,
        preset: "openai",
        protocol: "openai-chat-completions",
        baseUrl: "https://api.openai.com/v1",
        auth: { type: "bearer-env", env: PENDING_ENV }
      }
    },
    writing: {
      ...INITIAL_SETTINGS_DOCUMENT_V5.writing,
      defaultAuthorBrief: PENDING_BRIEF
    }
  });
}
