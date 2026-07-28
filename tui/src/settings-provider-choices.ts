import type {
  GenerationSettings,
  Provider
} from "../../shared/types.js";
import { ownedLoopbackHttpSupportedOn } from "../../shared/provider-transport-capability.js";

export type SettingsProviderChoiceId =
  | Provider
  | "lm-studio"
  | "ollama"
  | "llama-cpp"
  | "koboldcpp";

export interface SettingsProviderChoice {
  readonly id: SettingsProviderChoiceId;
  readonly label: string;
  readonly provider: Provider;
  readonly defaults: Pick<
    GenerationSettings,
    "baseUrl" | "model" | "apiKeyEnv" | "contextWindow"
  >;
  /** This choice's convenience URL can only be offered when the release target
   * can prove ownership of a plaintext loopback listener. */
  readonly plaintextDefaultRequiresOwnedLoopback?: true;
}

export const SETTINGS_PROVIDER_CHOICES: readonly SettingsProviderChoice[] = [
  {
    id: "dry-run",
    label: "dry-run",
    provider: "dry-run",
    defaults: {
      baseUrl: "",
      model: "",
      apiKeyEnv: null,
      contextWindow: 32_768
    }
  },
  {
    id: "openai-compatible",
    label: "OpenAI-compatible",
    provider: "openai-compatible",
    defaults: {
      baseUrl: "",
      model: "",
      apiKeyEnv: null,
      contextWindow: null
    }
  },
  {
    id: "lm-studio",
    label: "LM Studio",
    provider: "openai-compatible",
    plaintextDefaultRequiresOwnedLoopback: true,
    defaults: {
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "",
      apiKeyEnv: null,
      contextWindow: null
    }
  },
  {
    id: "ollama",
    label: "Ollama",
    provider: "openai-compatible",
    plaintextDefaultRequiresOwnedLoopback: true,
    defaults: {
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "llama3.2",
      apiKeyEnv: null,
      contextWindow: null
    }
  },
  {
    id: "llama-cpp",
    label: "llama.cpp",
    provider: "openai-compatible",
    plaintextDefaultRequiresOwnedLoopback: true,
    defaults: {
      baseUrl: "http://127.0.0.1:8080/v1",
      model: "",
      apiKeyEnv: null,
      contextWindow: null
    }
  },
  {
    id: "koboldcpp",
    label: "KoboldCpp",
    provider: "openai-compatible",
    plaintextDefaultRequiresOwnedLoopback: true,
    defaults: {
      baseUrl: "http://127.0.0.1:5001/v1",
      // KoboldCpp serves the model that the user loaded, and reports its
      // name. Seed no model ID. The old placeholder matched nothing in
      // `/models`, so `c` reported the model as missing.
      model: "",
      apiKeyEnv: null,
      contextWindow: null
    }
  },
  {
    id: "anthropic",
    label: "Anthropic",
    provider: "anthropic",
    defaults: {
      baseUrl: "https://api.anthropic.com",
      model: "",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      contextWindow: null
    }
  }
];

export function localProviderPresetsSupported(): boolean {
  return ownedLoopbackHttpSupportedOn(
    process.platform,
    typeof process.getuid === "function"
  );
}

export function selectableSettingsProviderChoices(
  localSupported = localProviderPresetsSupported()
): readonly SettingsProviderChoice[] {
  return SETTINGS_PROVIDER_CHOICES.filter(
    (choice) =>
      choice.plaintextDefaultRequiresOwnedLoopback !== true || localSupported
  );
}

export function settingsProviderChoice(
  settings: GenerationSettings
): SettingsProviderChoice {
  if (settings.provider !== "openai-compatible") {
    return SETTINGS_PROVIDER_CHOICES.find(
      (choice) => choice.id === settings.provider
    )!;
  }
  const port = loopbackPort(settings.baseUrl);
  const localId = port === "1234" ? "lm-studio"
    : port === "11434" ? "ollama"
      : port === "8080" ? "llama-cpp"
        : port === "5001" ? "koboldcpp"
          : null;
  return SETTINGS_PROVIDER_CHOICES.find(
    (choice) => choice.id === (localId ?? "openai-compatible")
  )!;
}

export function nextSettingsProviderChoice(
  settings: GenerationSettings,
  step: -1 | 1,
  localSupported = localProviderPresetsSupported()
): SettingsProviderChoice {
  const current = settingsProviderChoice(settings);
  const selectable = new Set(
    selectableSettingsProviderChoices(localSupported).map((choice) => choice.id)
  );
  const index = SETTINGS_PROVIDER_CHOICES.findIndex(
    (choice) => choice.id === current.id
  );
  for (let offset = 1; offset <= SETTINGS_PROVIDER_CHOICES.length; offset += 1) {
    const candidate = SETTINGS_PROVIDER_CHOICES[
      (index + step * offset + SETTINGS_PROVIDER_CHOICES.length * 2)
        % SETTINGS_PROVIDER_CHOICES.length
    ]!;
    if (selectable.has(candidate.id)) return candidate;
  }
  return current;
}

function loopbackPort(value: string): string | null {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return hostname === "localhost"
      || hostname === "::1"
      || hostname === "[::1]"
      || /^127(?:\.[0-9]{1,3}){3}$/u.test(hostname)
      ? url.port
      : null;
  } catch {
    return null;
  }
}
