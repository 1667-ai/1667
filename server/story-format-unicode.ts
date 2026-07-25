import { StoryFormatError } from "./story-format-facts.js";
import { hasUnpairedSurrogate } from "../shared/unicode.js";

export { hasUnpairedSurrogate } from "../shared/unicode.js";

export function assertWellFormedUnicode(text: string): void {
  if (hasUnpairedSurrogate(text)) {
    throw new StoryFormatError("Story text contains an unpaired Unicode surrogate");
  }
}
