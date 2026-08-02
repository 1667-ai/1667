import type { CardImportPlan } from "../../shared/card-import.js";
import { terminalLineText } from "../../shared/terminal-text.js";

export type { CardImportPlan } from "../../shared/card-import.js";

/** Describe the plan for a toast or another concise status line. */
export function describeCardImport(plan: CardImportPlan): string {
  const count = `${plan.facts.length} fact${plan.facts.length === 1 ? "" : "s"}`;
  const used = joinWords(plan.used);
  const skipped = plan.skipped.length === 0
    ? ""
    : ` · ${joinWords(plan.skipped)} ${plan.skipped.length === 1 ? "was" : "were"} empty`;
  // The name is card content, and this string is drawn in a terminal.
  return `${count} for "${terminalLineText(plan.name)}" · ${used}${skipped}`;
}

function joinWords(values: readonly string[]): string {
  if (values.length === 0) return "no fields";
  if (values.length === 1) return values[0]!;
  return `${values.slice(0, -1).join(", ")} and ${values[values.length - 1]!}`;
}
