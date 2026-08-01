import type { GenerationSettings, Provider } from "../shared/types.js";
import type {
  ProviderProbeDocumentTargetV2,
  SettingsDocumentV2,
  SettingsMutationResult,
  SettingsRoutePurpose,
  SettingsView
} from "../shared/settings-v2-types.js";
import type { DataDirectoryFormat } from "./data-directory-format.js";
import { ServiceError } from "./errors.js";
import { loadGenerationSettingsV1 } from "./settings-v1-store.js";
import {
  SettingsV2Store,
  type SettingsV2StoreOptions
} from "./settings-v2-store.js";
import { assertRuntimeGenerationSettingsSupported } from "./settings-v2-runtime.js";
import {
  LEGACY_PROMPT_CACHE_CONTEXT,
  type PromptCacheContext
} from "./provider-cache-policy.js";
import {
  attachProviderRuntime
} from "./provider-runtime.js";
import { requireSecretId } from "./settings-v2-scalars.js";
import { validateProviderSecretValue } from "../shared/provider-secret-value.js";

/** A probe resolves one route, so it needs one credential. The ceiling keeps a
 * malformed or hostile payload from turning a probe into bulk secret input. */
const MAX_PROVIDER_PROBE_SECRETS = 4;

export const DEFAULT_SYSTEM_PROMPT = [
  "You are a skilled fiction writer collaborating on a story.",
  "Continue the story according to the user's instruction. Write vivid, concrete prose in a consistent voice.",
  "Stay in the fiction: no summaries, no meta commentary, no questions to the reader.",
  "Write roughly 200-400 words per continuation unless the instruction asks otherwise, and end at a natural beat rather than a cliffhanger cut mid-sentence."
].join(" ");

const DEFAULTS: GenerationSettings = {
  provider: "dry-run",
  baseUrl: "",
  model: "",
  apiKeyEnv: null,
  temperature: 0.9,
  maxTokens: 1024,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  contextWindow: null
};

const PROVIDERS: readonly Provider[] = ["dry-run", "openai-compatible", "anthropic"];

/** Format 1 is the legacy read-only shape. Every later format keeps the same
 * v2 store; a new number fences what a directory may contain, not how it is
 * read. So the store's presence, not one exact number, is the discriminant. */
type InitializedSettingsStore =
  | { readonly dataFormat: 1 }
  | { readonly dataFormat: 2 | 3; readonly store: SettingsV2Store };

export interface LoadedGenerationSettings {
  readonly settings: GenerationSettings;
  readonly promptCache: PromptCacheContext;
}

export class SettingsStore {
  private initialized: InitializedSettingsStore | null = null;

  constructor(
    private readonly dir: string,
    private readonly options: SettingsV2StoreOptions = {}
  ) {}

  get dataFormat(): DataDirectoryFormat {
    if (this.initialized === null) throw new Error("Settings store is not initialized");
    return this.initialized.dataFormat;
  }

  async init(dataFormat: DataDirectoryFormat): Promise<void> {
    if (this.initialized !== null) {
      if (this.initialized.dataFormat !== dataFormat) {
        throw new Error("Settings data format changed after initialization");
      }
      return;
    }
    if (dataFormat === 1) {
      // Active settings authority resolves before service readiness;
      // malformed or unsafe v1 state is therefore startup-fatal.
      await loadGenerationSettingsV1(this.dir);
      this.initialized = { dataFormat: 1 };
    } else {
      const store = new SettingsV2Store(this.dir, this.options);
      await store.init();
      // Record the directory's own format, not the settings representation.
      // Hardcoding 2 here made the getter lie about a format-3 directory and
      // made a second, idempotent init(3) throw as if the format had changed.
      this.initialized = { dataFormat, store };
    }
  }

  async load(): Promise<GenerationSettings> {
    return (await this.loadGeneration()).settings;
  }

  async loadGeneration(
    purpose: SettingsRoutePurpose = "default"
  ): Promise<LoadedGenerationSettings> {
    const initialized = this.requireInitialized();
    if (initialized.dataFormat === 1) {
      return {
        settings: await loadGenerationSettingsV1(this.dir),
        promptCache: LEGACY_PROMPT_CACHE_CONTEXT
      };
    }
    const runtime = await initialized.store.loadRuntime(purpose);
    return {
      ...runtime,
      settings: attachProviderRuntime(
        runtime.settings,
        runtime.providerRuntime,
        true
      )
    };
  }

  async loadView(): Promise<SettingsView> {
    const initialized = this.requireInitialized();
    if (initialized.dataFormat !== 1) return await initialized.store.loadView();
    const effective = await loadGenerationSettingsV1(this.dir);
    return {
      dataFormat: 1,
      editable: false,
      stateGeneration: null,
      activeRevision: null,
      pendingRevision: null,
      document: null,
      effective,
      effectiveProse: effective,
      lastActivationOutcome: null
    };
  }

  async save(command: unknown): Promise<SettingsMutationResult> {
    return await this.requireEditable().save(command);
  }

  async discardPending(command: unknown): Promise<SettingsMutationResult> {
    return await this.requireEditable().discardPending(command);
  }

  async inspectMutationReceipt(mutationId: string) {
    const initialized = this.requireInitialized();
    return initialized.dataFormat !== 1
      ? await initialized.store.inspectMutationReceipt(mutationId)
      : null;
  }

  assertProviderRequestSupported(settings: GenerationSettings): void {
    const initialized = this.requireInitialized();
    if (initialized.dataFormat !== 1) {
      try {
        assertRuntimeGenerationSettingsSupported(settings);
      } catch (error) {
        if (error instanceof ServiceError) throw error;
        throw new ServiceError(
          400,
          error instanceof Error ? error.message : "Provider settings are unsupported.",
          "invalid_request"
        );
      }
    }
  }

  async assertProviderProbeSupported(
    settings: GenerationSettings
  ): Promise<GenerationSettings> {
    const initialized = this.requireInitialized();
    if (initialized.dataFormat === 1) {
      this.assertProviderRequestSupported(settings);
      return settings;
    }
    const matches = await initialized.store.loadMatchingProviderRuntimes(settings);
    const distinct = distinctProviderRuntimeMatches(matches);
    if (distinct.length > 1) {
      throw new ServiceError(
        409,
        "The probe target matches multiple active connections with distinct runtime policy.",
        "credential_test_requires_activation"
      );
    }
    const active = distinct[0];
    if (active !== undefined) {
      const attached = attachProviderRuntime(
        settings,
        active.providerRuntime,
        true
      );
      this.assertProviderRequestSupported(attached);
      return attached;
    }
    this.assertProviderRequestSupported(settings);
    if (settings.apiKeyEnv === null) return settings;
    throw new ServiceError(
      409,
      "A new or changed credential reference must be saved and activated before it can be tested.",
      "credential_test_requires_activation"
    );
  }

  async resolveProviderProbe(value: unknown): Promise<GenerationSettings> {
    const initialized = this.requireInitialized();
    const documentTarget = parseProviderProbeDocumentTarget(value);
    if (documentTarget === null) {
      return await this.assertProviderProbeSupported(normalizeForProbe(value));
    }
    if (initialized.dataFormat === 1) {
      throw new ServiceError(
        400,
        "Settings-document probe targets require data format 2.",
        "invalid_request"
      );
    }
    try {
      return await initialized.store.loadProviderProbeTarget(
        documentTarget.document,
        documentTarget.purpose,
        documentTarget.secrets
      );
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw new ServiceError(
        400,
        error instanceof Error ? error.message : "Provider probe target is invalid.",
        "invalid_request"
      );
    }
  }

  private requireEditable(): SettingsV2Store {
    const initialized = this.requireInitialized();
    if (initialized.dataFormat === 1) {
      throw new ServiceError(
        409,
        "Settings editing requires data format 2; this format-1 directory is read-only.",
        "settings_edit_requires_data_format_2"
      );
    }
    return initialized.store;
  }

  private requireInitialized(): InitializedSettingsStore {
    if (this.initialized === null) {
      throw new ServiceError(
        503,
        "Settings storage is not initialized.",
        "internal"
      );
    }
    return this.initialized;
  }
}

/** Validate an unsaved settings payload (Settings probes run before you save). */
export function normalizeForProbe(value: unknown): GenerationSettings {
  return normalize(value);
}

function parseProviderProbeDocumentTarget(
  value: unknown
): ProviderProbeDocumentTargetV2 | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (raw.kind !== "settings-document") return null;
  if (
    raw.purpose !== "default"
    && raw.purpose !== "prose"
    && raw.purpose !== "utility"
  ) {
    throw new ServiceError(
      400,
      "Provider probe purpose is invalid.",
      "invalid_request"
    );
  }
  return {
    kind: "settings-document",
    document: raw.document as SettingsDocumentV2,
    purpose: raw.purpose,
    ...(raw.secrets === undefined
      ? {}
      : { secrets: parseProviderProbeSecrets(raw.secrets) })
  };
}

/** Key material a probe carries for a credential the editor has not saved yet.
 * It is validated exactly like a stored secret so a probe cannot smuggle a
 * value the secret store would reject, and it is bounded because a probe
 * resolves one route: a large map is a mistake, not a use case. */
function parseProviderProbeSecrets(
  value: unknown
): Readonly<Record<string, string>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ServiceError(
      400,
      "Provider probe secrets must be an object.",
      "invalid_request"
    );
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_PROVIDER_PROBE_SECRETS) {
    throw new ServiceError(
      400,
      `A provider probe carries at most ${MAX_PROVIDER_PROBE_SECRETS} secrets.`,
      "invalid_request"
    );
  }
  const result: Record<string, string> = {};
  for (const [secretId, secret] of entries) {
    try {
      requireSecretId(secretId, "Provider probe secret ID");
      result[secretId] = validateProviderSecretValue(secret);
    } catch (error) {
      throw new ServiceError(
        400,
        error instanceof Error ? error.message : "Provider probe secret is invalid.",
        "invalid_request"
      );
    }
  }
  return result;
}

function normalize(value: unknown): GenerationSettings {
  const raw = (value !== null && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const provider = PROVIDERS.includes(raw.provider as Provider) ? (raw.provider as Provider) : DEFAULTS.provider;
  return {
    provider,
    baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl.trim() : DEFAULTS.baseUrl,
    model: typeof raw.model === "string" ? raw.model.trim() : DEFAULTS.model,
    apiKeyEnv: typeof raw.apiKeyEnv === "string" && raw.apiKeyEnv.trim().length > 0 ? raw.apiKeyEnv.trim() : null,
    temperature: typeof raw.temperature === "number" && Number.isFinite(raw.temperature) ? raw.temperature : null,
    maxTokens: typeof raw.maxTokens === "number" && Number.isInteger(raw.maxTokens) && raw.maxTokens > 0 ? raw.maxTokens : DEFAULTS.maxTokens,
    systemPrompt: typeof raw.systemPrompt === "string" && raw.systemPrompt.trim().length > 0 ? raw.systemPrompt : DEFAULT_SYSTEM_PROMPT,
    contextWindow:
      typeof raw.contextWindow === "number" && Number.isInteger(raw.contextWindow) && raw.contextWindow > 0
        ? raw.contextWindow
        : null
  };
}

function distinctProviderRuntimeMatches<T extends {
  readonly providerRuntime: object;
}>(matches: readonly T[]): readonly T[] {
  const seen = new Set<string>();
  return matches.filter((match) => {
    const key = JSON.stringify(match.providerRuntime);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
