import {
  renderPromptPlan,
  type ChatMessage,
  type PromptPlan
} from "./prompt-plan.js";
import type { TextPromptFormatV2 } from "./settings-v2-types.js";

/** Render one provider-neutral plan for a text-completion endpoint. */
export function renderTextPrompt(
  plan: PromptPlan,
  format: Exclude<TextPromptFormatV2, "server-template">
): string {
  return renderTextMessages(renderPromptPlan(plan), format);
}

/** Render the message projection used by request previews and token probes. */
export function renderTextMessages(
  messages: readonly ChatMessage[],
  format: Exclude<TextPromptFormatV2, "server-template">
): string {
  if (format === "chatml") {
    const rendered = messages.map((message, index) => {
      const finalAssistant = index === messages.length - 1
        && message.role === "assistant";
      return finalAssistant
        ? `<|im_start|>assistant\n${message.content}`
        : `<|im_start|>${message.role}\n${message.content}<|im_end|>\n`;
    }).join("");
    return messages.at(-1)?.role === "assistant"
      ? rendered
      : `${rendered}<|im_start|>assistant\n`;
  }

  const rendered = messages.map((message) => message.content).join("\n\n");
  return messages.at(-1)?.role === "assistant" ? rendered : `${rendered}\n\n`;
}
