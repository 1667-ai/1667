import path from "node:path";
import type { SettingsStateV2 } from "../shared/settings-v2-types.js";
import {
  publishDataDirectoryFormat2Marker,
  stageDataDirectoryFormat2Marker
} from "./data-directory-format-upgrade.js";
import { ServiceError } from "./errors.js";
import { MutationLedgerStore } from "./mutation-ledger-store.js";
import type {
  Fm1Key,
  SettingsFormatMigrationV1SourceTag
} from "./mutation-ledger-types.js";
import {
  settingsFormatMigrationV1Identity
} from "./settings-format-migration-identity.js";
import {
  completeSettingsFormatMigrationV1Receipt,
  prepareSettingsFormatMigrationV1Receipt,
  requireMatchingSettingsFormatMigrationV1Receipt
} from "./settings-format-migration-receipt.js";
import { settingsFormatMigrationV1State } from "./settings-format-migration-state.js";
import {
  assertGenerationSettingsV1SourceUnchanged,
  loadGenerationSettingsV1Source,
  readGenerationSettingsV1SourceSnapshot
} from "./settings-v1-store.js";
import {
  hashSettingsStateV2,
  parseSettingsStateV2Bytes
} from "./settings-v2-codec.js";
import { MAX_SETTINGS_STATE_BYTES } from "./settings-v2-scalars.js";
import {
  readOptionalMutableSettingsAuthority,
  readOptionalSettingsFile
} from "./settings-file-io.js";
import {
  discardStagedSettingsState,
  publishStagedSettingsState,
  readSettingsState,
  stageSettingsState
} from "./settings-state-file.js";
import {
  SETTINGS_STATE_V2_FILE,
  SETTINGS_STATE_V2_NEXT_FILE
} from "./data-directory-layout.js";

type StepHook = () => void | Promise<void>;
type DataDirectoryFence = () => void | Promise<void>;

export interface SettingsFormatMigrationV1Hooks {
  readonly afterSourceRecovery?: StepHook;
  readonly afterStateStaged?: StepHook;
  readonly afterPreparedReceipt?: StepHook;
  readonly afterStatePublished?: StepHook;
  readonly afterCompletedReceipt?: StepHook;
  readonly afterMarkerStaged?: StepHook;
  readonly afterMarkerPublished?: StepHook;
}

export interface SettingsFormatMigrationV1Options {
  readonly ledger?: MutationLedgerStore;
  readonly now?: () => Date;
  readonly hooks?: SettingsFormatMigrationV1Hooks;
}

export interface SettingsFormatMigrationV1Result {
  readonly key: Fm1Key;
  readonly sourceTag: SettingsFormatMigrationV1SourceTag;
  readonly canonicalV1Hash: string;
  readonly stateHash: string;
}

/**
 * Release B's one-shot settings transaction. The caller must retain the
 * current owner-marker data lock for the entire call.
 */
export async function migrateSettingsFormatV1ToV2UnderLock(
  dataDir: string,
  options: SettingsFormatMigrationV1Options,
  assertDataDirectory: DataDirectoryFence
): Promise<SettingsFormatMigrationV1Result> {
  let residue = await fenced(
    assertDataDirectory,
    () => readMigrationStateResidue(dataDir)
  );
  const source = await fenced(
    assertDataDirectory,
    () => residue.current === null && residue.next === null
      ? loadGenerationSettingsV1Source(dataDir)
      : readGenerationSettingsV1SourceSnapshot(dataDir)
  );
  await runHook(options.hooks?.afterSourceRecovery, assertDataDirectory);

  const identity = settingsFormatMigrationV1Identity(
    source.sourceTag,
    source.canonicalV1Hash
  );
  const expectedState = settingsFormatMigrationV1State(source.settings, identity.key);
  const stateHash = hashSettingsStateV2(expectedState);
  const ledger = options.ledger ?? new MutationLedgerStore(dataDir);
  const now = options.now ?? (() => new Date());

  requireExpectedState(residue.current, expectedState, "current");
  requireExpectedState(residue.next, expectedState, "next");

  const receipt = await fenced(
    assertDataDirectory,
    () => ledger.loadFormatMigrationReceipt(identity.key)
  );
  if (receipt.completed !== null && residue.current === null) {
    throw corruptMigration("completed receipt exists without committed settings state");
  }

  let prepared = receipt.prepared;
  if (prepared !== null) {
    requireMatchingSettingsFormatMigrationV1Receipt(prepared, {
      sourceTag: identity.sourceTag,
      canonicalV1Hash: identity.canonicalV1Hash,
      newStateHash: stateHash
    });
  } else if (residue.current !== null) {
    throw corruptMigration("committed settings state has no prepared receipt");
  }

  if (residue.current === null && residue.next === null) {
    await fenced(
      assertDataDirectory,
      () => stageSettingsState(dataDir, expectedState)
    );
    await runHook(options.hooks?.afterStateStaged, assertDataDirectory);
    residue = { current: null, next: expectedState };
  }

  await fenced(assertDataDirectory, () => ledger.init());
  if (prepared === null) {
    const preparedRecord = prepareSettingsFormatMigrationV1Receipt({
      sourceTag: identity.sourceTag,
      canonicalV1Hash: identity.canonicalV1Hash,
      newStateHash: stateHash,
      preparedAt: now().toISOString()
    });
    prepared = preparedRecord;
    await fenced(
      assertDataDirectory,
      () => ledger.writeFormatMigrationRecord(preparedRecord)
    );
    await runHook(options.hooks?.afterPreparedReceipt, assertDataDirectory);
  }

  if (residue.current === null) {
    await fenced(assertDataDirectory, () => publishStagedSettingsState(dataDir));
    await runHook(options.hooks?.afterStatePublished, assertDataDirectory);
    residue = { current: expectedState, next: null };
  }
  requireExpectedState(
    await fenced(assertDataDirectory, () => readSettingsState(dataDir)),
    expectedState,
    "published"
  );

  if (receipt.completed === null) {
    await fenced(
      assertDataDirectory,
      () => ledger.writeFormatMigrationRecord(
        completeSettingsFormatMigrationV1Receipt(prepared, now().toISOString())
      )
    );
    await runHook(options.hooks?.afterCompletedReceipt, assertDataDirectory);
  }
  if (residue.next !== null) {
    await fenced(assertDataDirectory, () => discardStagedSettingsState(dataDir));
  }

  await fenced(assertDataDirectory, () => stageDataDirectoryFormat2Marker(dataDir));
  await runHook(options.hooks?.afterMarkerStaged, assertDataDirectory);
  await fenced(
    assertDataDirectory,
    () => assertGenerationSettingsV1SourceUnchanged(dataDir, source)
  );
  await fenced(assertDataDirectory, () => publishDataDirectoryFormat2Marker(dataDir));
  await runHook(options.hooks?.afterMarkerPublished, assertDataDirectory);

  return Object.freeze({
    key: identity.key,
    sourceTag: identity.sourceTag,
    canonicalV1Hash: identity.canonicalV1Hash,
    stateHash
  });
}

interface MigrationStateResidue {
  readonly current: SettingsStateV2 | null;
  readonly next: SettingsStateV2 | null;
}

async function readMigrationStateResidue(dataDir: string): Promise<MigrationStateResidue> {
  const [currentBytes, nextBytes] = await Promise.all([
    readOptionalMutableSettingsAuthority(
      path.join(dataDir, SETTINGS_STATE_V2_FILE),
      MAX_SETTINGS_STATE_BYTES
    ),
    readOptionalSettingsFile(
      path.join(dataDir, SETTINGS_STATE_V2_NEXT_FILE),
      MAX_SETTINGS_STATE_BYTES
    )
  ]);
  return {
    current: currentBytes === null ? null : parseSettingsStateV2Bytes(currentBytes),
    next: nextBytes === null ? null : parseSettingsStateV2Bytes(nextBytes)
  };
}

function requireExpectedState(
  actual: SettingsStateV2 | null,
  expected: SettingsStateV2,
  label: string
): void {
  if (actual === null) return;
  if (hashSettingsStateV2(actual) !== hashSettingsStateV2(expected)) {
    throw new ServiceError(
      409,
      `Settings format migration ${label} state belongs to different source input.`,
      "idempotency_conflict"
    );
  }
}

function corruptMigration(detail: string): ServiceError {
  return new ServiceError(
    500,
    `Settings format migration evidence is corrupt: ${detail}`,
    "internal"
  );
}

async function fenced<T>(
  assertDataDirectory: DataDirectoryFence,
  operation: () => Promise<T>
): Promise<T> {
  await assertDataDirectory();
  const result = await operation();
  await assertDataDirectory();
  return result;
}

async function runHook(
  hook: StepHook | undefined,
  assertDataDirectory: DataDirectoryFence
): Promise<void> {
  await hook?.();
  await assertDataDirectory();
}
