import type { FactConsistencyRun } from "../../../shared/fact-consistency-contract.js";
import { factName } from "../../../shared/fact-view.js";
import { pathTo } from "../../../shared/story-tree.js";
import type { StoryPayload } from "../../../shared/types.js";

/** Where a finding's part is now: on the line being read, on another line the
 * check had selected, or gone (replaced, deleted, or its text no longer holds
 * the quote). The same three states the TUI uses. */
export type FindingStatus = "current" | "off-line" | "stale";

export interface FindingRow {
  readonly key: string;
  readonly factName: string;
  readonly quote: string;
  readonly statement: string;
  readonly partId: string;
  /** The part's place on the line being read, or `null` when it is not on it. */
  readonly partNumber: number | null;
  readonly status: FindingStatus;
}

function statusOf(
  payload: StoryPayload,
  takeId: string,
  quote: string,
  selectedAtRun: boolean | undefined
): FindingStatus {
  const take = payload.nodes.find((node) => node.id === takeId);
  if (take === undefined || take.role === "summary") return "stale";
  const onLine = payload.path.find((node) => node.id === takeId);
  const text = onLine?.text ?? take.text;
  if (text !== undefined && !text.includes(quote)) return "stale";
  if (onLine !== undefined) return "current";
  return selectedAtRun === false ? "off-line" : "stale";
}

/** The findings of a run, in the order the check found them. */
export function findingRows(run: FactConsistencyRun, payload: StoryPayload): readonly FindingRow[] {
  const rows: FindingRow[] = [];
  const tree = { nodes: payload.nodes, activeRootId: payload.activeRootId };
  for (const part of run.parts) {
    const pathIds = pathTo(tree, part.takeId).map((node) => node.id);
    const index = payload.path.findIndex((node) => node.id === part.takeId);
    part.findings.forEach((finding, number) => {
      const fact = payload.facts.find((candidate) => candidate.id === finding.fact_id);
      rows.push({
        key: `${part.takeId}:${finding.fact_id}:${number}`,
        factName: fact === undefined ? "Unknown Fact" : factName(fact, pathIds),
        quote: finding.quote,
        statement: finding.statement,
        partId: part.takeId,
        partNumber: index < 0 ? null : index + 1,
        status: statusOf(payload, part.takeId, finding.quote, part.selectedAtRun)
      });
    });
  }
  return rows;
}

/** The one line under the findings: what the run left out. */
export function runSummary(run: FactConsistencyRun): string {
  const unchecked = run.parts.filter((part) => part.uncheckedReason !== undefined).length;
  const checked = run.parts.length - unchecked;
  const bits = [`${checked} ${checked === 1 ? "part" : "parts"} checked`];
  if (unchecked > 0) bits.push(`${unchecked} unchecked`);
  if (run.droppedFindings > 0) bits.push(`${run.droppedFindings} rejected`);
  return bits.join(" · ");
}
