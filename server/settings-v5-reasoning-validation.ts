import {
  GENERATION_EFFORT_V2_VALUES
} from "../shared/settings-v2-types.js";
import {
  GENERATION_EFFORT_V4_VALUES,
  THINKING_MODE_V4_VALUES
} from "../shared/settings-v4-types.js";
import type { GenerationReasoningV5 } from "../shared/settings-v5-reasoning.js";
import { SettingsFormatError } from "./settings-v2-scalars.js";
import { oneOf } from "./settings-v2-validation-values.js";
import { closedRecord, closedShape, literal } from "./story-wire-validation.js";

const LEGACY = closedShape(["kind", "effort"]);
const INDEPENDENT = closedShape(["kind", "effort", "thinkingMode"]);

export function parseGenerationReasoningV5(
  value: unknown,
  label: string
): GenerationReasoningV5 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SettingsFormatError(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  if (record.kind === "legacy") {
    const legacy = closedRecord(record, label, LEGACY);
    literal(legacy.kind, "legacy", `${label}.kind`);
    return {
      kind: "legacy",
      effort: oneOf(legacy.effort, GENERATION_EFFORT_V2_VALUES, `${label}.effort`)
    };
  }
  if (record.kind === "independent") {
    const independent = closedRecord(record, label, INDEPENDENT);
    literal(independent.kind, "independent", `${label}.kind`);
    return {
      kind: "independent",
      effort: oneOf(independent.effort, GENERATION_EFFORT_V4_VALUES, `${label}.effort`),
      thinkingMode: oneOf(
        independent.thinkingMode,
        THINKING_MODE_V4_VALUES,
        `${label}.thinkingMode`
      )
    };
  }
  throw new SettingsFormatError(`${label}.kind must be one of legacy | independent`);
}
