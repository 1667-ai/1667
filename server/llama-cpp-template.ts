import type { ChatMessage } from "../shared/prompt-plan.js";

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
    ...(continuesAssistant ? { continue_final_message: true } : {})
  };
}
