import type { ChatMessage } from "../shared/prompt-plan.js";

/** llama.cpp fields that keep a final assistant message open. */
export function llamaCppAssistantContinuationFields(
  continuesAssistant: boolean
): Record<string, unknown> {
  return continuesAssistant
    ? { add_generation_prompt: false, continue_final_message: true }
    : {};
}

/** Build one llama.cpp template request with explicit continuation semantics. */
export function llamaCppTemplateRequest(
  model: string,
  messages: readonly ChatMessage[]
): Record<string, unknown> {
  const route = model.length === 0 ? {} : { model };
  const continuesAssistant = messages.at(-1)?.role === "assistant";
  return {
    ...route,
    messages,
    add_generation_prompt: !continuesAssistant,
    ...llamaCppAssistantContinuationFields(continuesAssistant)
  };
}
