import { countO200kPromptTextTokens } from "../../server/openai-prompt-tokenizer.js";

const vectors: ReadonlyArray<readonly [string, number]> = [
  ["hello world", 2],
  ["The lantern is blue.", 5]
];

for (const [text, expected] of vectors) {
  const observed = countO200kPromptTextTokens([text]);
  if (observed !== expected) {
    throw new Error(`Compiled o200k tokenizer returned ${observed}; expected ${expected}`);
  }
}
