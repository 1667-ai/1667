import {
  StrictJsonError,
  parseJsonRejectingDuplicateKeys as parseStrictJson
} from "../shared/strict-json.js";
import { StoryFormatError } from "./story-format-facts.js";

export function parseJsonRejectingDuplicateKeys(text: string, label: string): unknown {
  try {
    return parseStrictJson(text);
  } catch (error) {
    if (error instanceof StrictJsonError) {
      throw new StoryFormatError(
        `${label} is not valid strict JSON: ${error.message}`,
        { cause: error }
      );
    }
    throw new StoryFormatError(`${label} is not valid strict JSON`, { cause: error });
  }
}
