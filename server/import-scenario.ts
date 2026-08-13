import { ServiceError } from "./errors.js";
import {
  MAX_IMPORT_BYTES,
  MAX_PARTS,
  MAX_TOTAL_CHARS,
  type ImportedPart
} from "./import-model.js";
import {
  extractAuthorsNote,
  extractFacts,
  importTitle,
  MAX_NOVELAI_JSON_VALUES,
  type NovelAiContainerImport
} from "./import-nai.js";
import { parseJsonRejectingDuplicateKeys } from "./strict-json.js";
import { hasUnpairedSurrogate } from "../shared/unicode.js";
import { countNoun } from "../shared/fidelity.js";

/** Scenario versions observed in NovelAI exports whose prompt/context shape
 * is still readable by this importer. Keep the set explicit so an unknown
 * future version is not treated as compatible by accident. */
export const SUPPORTED_NOVELAI_SCENARIO_VERSIONS = [0, 1, 3] as const;

export function partsFromNovelAiScenario(jsonText: string): NovelAiContainerImport {
  if (Buffer.byteLength(jsonText) > MAX_IMPORT_BYTES) {
    throw new ServiceError(413, "Request body too large");
  }
  if (jsonText.trim().length === 0) {
    throw new ServiceError(400, "Empty file");
  }

  let rawJson: unknown;
  try {
    rawJson = parseJsonRejectingDuplicateKeys(
      jsonText,
      "NovelAI scenario",
      { maxValues: MAX_NOVELAI_JSON_VALUES }
    );
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw new ServiceError(400, "Malformed JSON");
  }

  if (!isRecord(rawJson)) {
    throw new ServiceError(400, "Malformed JSON structure");
  }
  if (!isSupportedScenarioVersion(rawJson.scenarioVersion)) {
    throw new ServiceError(400, "Unsupported scenarioVersion");
  }

  const title = importTitle(rawJson.title);

  let parts: ImportedPart[] = [];
  if (typeof rawJson.prompt === "string" && rawJson.prompt.length > 0) {
    if (hasUnpairedSurrogate(rawJson.prompt)) {
      throw new ServiceError(400, "Prompt contains invalid Unicode");
    }
    parts = partsFromProse(rawJson.prompt);
  } else if (rawJson.prompt !== undefined && rawJson.prompt !== "") {
    throw new ServiceError(400, "Malformed prompt");
  }

  const fidelity: string[] = [];
  const facts = extractFacts(rawJson.context, rawJson.lorebook, fidelity);
  const authorsNote = extractAuthorsNote(rawJson.context, fidelity);

  fidelity.push(
    `${parts.length} prose ${countNoun(parts.length, "part")}`,
    "${…} placeholders kept literally",
    "description, placeholder metadata, tags, context defaults, bias groups, and generation settings omitted"
  );

  return {
    story: { title, parts },
    facts,
    authorsNote,
    fidelity
  };
}

function isSupportedScenarioVersion(
  value: unknown
): value is (typeof SUPPORTED_NOVELAI_SCENARIO_VERSIONS)[number] {
  return typeof value === "number"
    && SUPPORTED_NOVELAI_SCENARIO_VERSIONS.some((version) => version === value);
}

export function partsFromProse(text: string): ImportedPart[] {
  const norm = text.normalize("NFC").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (norm.length > MAX_TOTAL_CHARS) {
    throw importTextTooLarge();
  }

  const blocks = norm.split(/\n\s*\n/);
  const parts: ImportedPart[] = [];
  const createdAt = new Date().toISOString();
  let totalChars = 0;

  for (const block of blocks) {
    const trimmed = block.trim();
    if (trimmed.length === 0) continue;
    if (parts.length >= MAX_PARTS) {
      throw new ServiceError(
        400,
        `Scenario has more than ${MAX_PARTS} parts — too large to import`
      );
    }
    totalChars += trimmed.length;
    if (totalChars > MAX_TOTAL_CHARS) {
      throw importTextTooLarge();
    }
    parts.push({ instruction: "", text: trimmed, createdAt });
  }

  return parts;
}

function importTextTooLarge(): ServiceError {
  return new ServiceError(400, "Scenario expands to more text than can be imported");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
