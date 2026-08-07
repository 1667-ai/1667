import { INITIAL_SETTINGS_DOCUMENT_V2 } from "../server/settings-v2-default.js";

export function openAiDocument() {
  return {
    ...INITIAL_SETTINGS_DOCUMENT_V2,
    connections: {
      "builtin:dry-run": {
        ...INITIAL_SETTINGS_DOCUMENT_V2.connections["builtin:dry-run"]!,
        protocol: "openai-chat-completions" as const,
        preset: "llama-cpp" as const
      }
    },
    models: {
      "builtin:dry-run": {
        ...INITIAL_SETTINGS_DOCUMENT_V2.models["builtin:dry-run"]!,
        remoteId: "local-model"
      }
    }
  };
}

