import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  SETTINGS_STATE_V2_FILE,
  SETTINGS_STATE_V2_NEXT_FILE
} from "../server/data-directory-format.js";
import {
  MUTATION_LEDGER_DIRECTORY,
  userMutationLedgerSegments
} from "../server/mutation-ledger-paths.js";
import { MutationLedgerStore } from "../server/mutation-ledger-store.js";
import { SettingsStore } from "../server/settings.js";
import {
  applyEffectiveGenerationSettings,
  effectiveGenerationView
} from "../server/settings-v2-conversion.js";
import {
  INITIAL_SETTINGS_DOCUMENT_V2,
  INITIAL_SETTINGS_STATE_V2
} from "../server/settings-v2-default.js";
import { completeSettingsMutation } from "../server/settings-v2-mutation.js";
import { SettingsV2Store } from "../server/settings-v2-store.js";
import {
  publishStagedSettingsState,
  stageSettingsState
} from "../server/settings-state-file.js";
import type {
  SettingsDocumentV2
} from "../shared/settings-v2-types.js";
import {
  FIXED_TIME,
  MUTATION_A,
  MUTATION_C,
  changedState,
  hasFsCode,
  hasServiceCode,
  initializedFormat2Directory,
  preparedFixture,
  saveCommand
} from "./settings-store-fixtures.js";

interface RuntimePrerequisiteCase {
  readonly suffix: string;
  readonly mutationId: typeof MUTATION_A;
  readonly document: SettingsDocumentV2;
  readonly message: RegExp;
}

test("direct saves reject selected-route runtime prerequisites before state or receipt mutation", async (t) => {
  const dataDir = await initializedFormat2Directory(t, "1667-settings-v2-runtime-save-");
  const store = new SettingsStore(dataDir, { now: () => FIXED_TIME });
  await store.init(2);
  const statePath = path.join(dataDir, SETTINGS_STATE_V2_FILE);
  const stateBefore = await readFile(statePath);

  for (const prerequisite of invalidRuntimePrerequisites()) {
    await assert.rejects(
      store.save(saveCommand(prerequisite.mutationId, 1, prerequisite.document)),
      (error) => hasServiceCode("invalid_request")(error)
        && error instanceof Error
        && prerequisite.message.test(error.message)
    );
    assert.deepEqual(await readFile(statePath), stateBefore);
    await assert.rejects(
      access(path.join(dataDir, SETTINGS_STATE_V2_NEXT_FILE)),
      hasFsCode("ENOENT")
    );
    await assert.rejects(
      access(path.join(
        dataDir,
        MUTATION_LEDGER_DIRECTORY,
        ...userMutationLedgerSegments("settings", prerequisite.mutationId)
      )),
      hasFsCode("ENOENT")
    );
  }
});

test("direct saves validate cache policy on utility and prose routes", async (t) => {
  const dataDir = await initializedFormat2Directory(
    t,
    "1667-settings-v2-cache-routes-"
  );
  const store = new SettingsStore(dataDir, { now: () => FIXED_TIME });
  await store.init(2);
  const initial = effectiveGenerationView(INITIAL_SETTINGS_DOCUMENT_V2);
  const document = applyEffectiveGenerationSettings(
    INITIAL_SETTINGS_DOCUMENT_V2,
    {
      ...initial,
      provider: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-5.6",
      apiKeyEnv: null
    }
  );
  const selected = document.profiles[document.routing.default]!;
  const invalidUtility: SettingsDocumentV2 = {
    ...document,
    profiles: {
      ...document.profiles,
      utility: {
        ...selected,
        name: "Utility",
        cachePolicy: "long"
      }
    },
    routing: {
      ...document.routing,
      utility: "utility"
    }
  };

  await assert.rejects(
    store.save(saveCommand(MUTATION_C, 1, invalidUtility)),
    /Long prompt-cache retention is unavailable/
  );
  assert.equal((await store.loadView()).stateGeneration, 1);
});

test("externally persisted invalid selected routes fail initialization and runtime readiness", async (t) => {
  for (const prerequisite of invalidRuntimePrerequisites()) {
    const dataDir = await initializedFormat2Directory(
      t,
      `1667-settings-v2-runtime-${prerequisite.suffix}-`
    );
    await persistCompletedActiveState(dataDir, prerequisite);

    const facade = new SettingsStore(dataDir);
    await assert.rejects(facade.init(2), prerequisite.message);
    await assert.rejects(
      new SettingsV2Store(dataDir).loadEffective(),
      prerequisite.message
    );
  }
});

function invalidRuntimePrerequisites(): readonly RuntimePrerequisiteCase[] {
  const initialEffective = effectiveGenerationView(INITIAL_SETTINGS_DOCUMENT_V2);
  const openAi = applyEffectiveGenerationSettings(
    INITIAL_SETTINGS_DOCUMENT_V2,
    {
      ...initialEffective,
      provider: "openai-compatible",
      baseUrl: "https://models.example/v1",
      model: "network-model",
      apiKeyEnv: null
    }
  );
  const selectedProfile = openAi.profiles[openAi.routing.default]!;
  const selectedModel = openAi.models[selectedProfile.modelId]!;
  const blankRemoteId: SettingsDocumentV2 = {
    ...openAi,
    models: {
      ...openAi.models,
      [selectedProfile.modelId]: {
        ...selectedModel,
        remoteId: " \t "
      }
    }
  };
  return [
    {
      suffix: "blank-model",
      mutationId: MUTATION_A,
      document: blankRemoteId,
      message: /nonblank model remote ID/
    }
  ];
}

async function persistCompletedActiveState(
  dataDir: string,
  prerequisite: RuntimePrerequisiteCase
): Promise<void> {
  const active = changedState(prerequisite.mutationId, prerequisite.document);
  const prepared = preparedFixture(
    prerequisite.mutationId,
    INITIAL_SETTINGS_STATE_V2,
    active
  );
  const ledger = new MutationLedgerStore(dataDir);
  await ledger.init();
  await ledger.writeUserRecord(prepared);
  await ledger.writeUserRecord(
    completeSettingsMutation(prepared, FIXED_TIME.toISOString())
  );
  await stageSettingsState(dataDir, active);
  await publishStagedSettingsState(dataDir);
}
