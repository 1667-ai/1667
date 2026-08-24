import type {
  SettingsDocumentV2,
  SettingsRoutePurpose,
  SettingsStateV2
} from "../shared/settings-v2-types.js";
import {
  type SettingsDocumentV4,
  type SettingsStateV4
} from "../shared/settings-v4-types.js";
import {
  type SettingsDocumentV5,
  type SettingsStateV5
} from "../shared/settings-v5-types.js";
import { ServiceError } from "./errors.js";
import { readProviderSecrets } from "./provider-secret-store.js";
import type { SettingsRuntimeResolver } from "./settings-runtime-resolver.js";
import { readSettingsStateSlot } from "./settings-state-file.js";
import {
  settingsStateSlotImageInputCapability,
  settingsStateSlotReadOnlyView,
  type SettingsStateSlot
} from "./settings-state-slot.js";
import {
  activeSettingsDocument,
  assertRuntimeGenerationSettingsSupported,
  pendingSettingsDocument
} from "./settings-v2-runtime.js";
import { activeSettingsDocumentV4 } from "./settings-v4-state-validation.js";
import { activeSettingsDocumentV5 } from "./settings-v5-state-validation.js";
import { storedSecretIdsInDocument } from "./subscription-runtime.js";
import { activeWritingFromSlot } from "./settings-working-document.js";

export type SettingsRuntimeSnapshot = {
  readonly slot: Exclude<SettingsStateSlot, { kind: "v4" } | { kind: "v5" }>;
  readonly state: SettingsStateV2;
  readonly storedSecrets: Awaited<ReturnType<typeof readProviderSecrets>>;
} | {
  readonly slot: Extract<SettingsStateSlot, { kind: "v4" }>;
  readonly state: SettingsStateV4;
  readonly storedSecrets: Awaited<ReturnType<typeof readProviderSecrets>>;
} | {
  readonly slot: Extract<SettingsStateSlot, { kind: "v5" }>;
  readonly state: SettingsStateV5;
  readonly storedSecrets: Awaited<ReturnType<typeof readProviderSecrets>>;
};

function isV4Snapshot(
  snapshot: SettingsRuntimeSnapshot
): snapshot is Extract<SettingsRuntimeSnapshot, { slot: { kind: "v4" } }> {
  return snapshot.slot.kind === "v4";
}

function isV5Snapshot(
  snapshot: SettingsRuntimeSnapshot
): snapshot is Extract<SettingsRuntimeSnapshot, { slot: { kind: "v5" } }> {
  return snapshot.slot.kind === "v5";
}

export function settingsRuntimeSnapshotActiveDocument(
  snapshot: SettingsRuntimeSnapshot
): SettingsDocumentV2 | SettingsDocumentV4 | SettingsDocumentV5 {
  if (isV5Snapshot(snapshot)) return activeSettingsDocumentV5(snapshot.state);
  return isV4Snapshot(snapshot)
    ? activeSettingsDocumentV4(snapshot.state)
    : activeSettingsDocument(snapshot.state);
}

export function settingsRuntimeSnapshotPendingDocument(
  snapshot: SettingsRuntimeSnapshot
): SettingsDocumentV2 | SettingsDocumentV4 | SettingsDocumentV5 | undefined {
  if (snapshot.state.pendingRevision === null) return undefined;
  if (isV5Snapshot(snapshot) || isV4Snapshot(snapshot)) {
    return snapshot.state.documents[String(snapshot.state.pendingRevision)];
  }
  return pendingSettingsDocument(snapshot.state);
}

/** Read one coherent settings and credential snapshot for provider work. */
export async function readSettingsRuntimeSnapshot(
  dataDir: string,
  secretsDir: string
): Promise<SettingsRuntimeSnapshot> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 5));
    }
    const slot = await readSettingsStateSlot(dataDir);
    const storedSecrets = await readProviderSecrets(secretsDir);
    if (slot.kind === "v4") {
      const referenced = storedSecretIdsInDocument(activeSettingsDocumentV4(slot.state));
      if ([...referenced].every((secretId) => storedSecrets.has(secretId))) {
        return { slot, state: slot.state, storedSecrets };
      }
      continue;
    }
    if (slot.kind === "v5") {
      const referenced = storedSecretIdsInDocument(activeSettingsDocumentV5(slot.state));
      if ([...referenced].every((secretId) => storedSecrets.has(secretId))) {
        return { slot, state: slot.state, storedSecrets };
      }
      continue;
    }
    const state = settingsStateSlotReadOnlyView(slot);
    const referenced = storedSecretIdsInDocument(activeSettingsDocument(state));
    if ([...referenced].every((secretId) => storedSecrets.has(secretId))) {
      return { slot, state, storedSecrets };
    }
  }
  throw new ServiceError(
    503,
    "Settings changed repeatedly while reading provider credentials; retry."
  );
}

export function resolveSettingsRuntimeSnapshot(
  snapshot: SettingsRuntimeSnapshot,
  resolver: SettingsRuntimeResolver,
  purpose: SettingsRoutePurpose
) {
  if (isV5Snapshot(snapshot)) {
    const document = activeSettingsDocumentV5(snapshot.state);
    const runtime = resolver.resolveV5({
      document,
      purpose,
      storedSecrets: snapshot.storedSecrets
    });
    assertRuntimeGenerationSettingsSupported(runtime.settings);
    return {
      ...runtime,
      imageInputCapability: settingsStateSlotImageInputCapability(
        snapshot.slot,
        runtime.route.modelId
      ),
      writing: activeWritingFromSlot(snapshot.slot)
    };
  }
  if (isV4Snapshot(snapshot)) {
    const document = activeSettingsDocumentV4(snapshot.state);
    const runtime = resolver.resolveV4({
      document,
      purpose,
      storedSecrets: snapshot.storedSecrets
    });
    assertRuntimeGenerationSettingsSupported(runtime.settings);
    return {
      ...runtime,
      imageInputCapability: settingsStateSlotImageInputCapability(
        snapshot.slot,
        runtime.route.modelId
      ),
      writing: activeWritingFromSlot(snapshot.slot)
    };
  }
  const document = activeSettingsDocument(snapshot.state);
  const runtime = resolver.resolve({
    document,
    purpose,
    storedSecrets: snapshot.storedSecrets
  });
  assertRuntimeGenerationSettingsSupported(runtime.settings);
  return {
    ...runtime,
    imageInputCapability: settingsStateSlotImageInputCapability(
      snapshot.slot,
      runtime.route.modelId
    ),
    writing: activeWritingFromSlot(snapshot.slot)
  };
}
