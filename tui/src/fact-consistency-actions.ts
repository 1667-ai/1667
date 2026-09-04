import type {
  FactConsistencyPreflight,
  FactConsistencyRun,
  FactConsistencyFinding
} from "./fact-consistency-check.js";

export type FactConsistencySurface =
  | {
      readonly phase: "confirm";
      readonly preflight: FactConsistencyPreflight;
      /** Provider failure retained for a retry after the panel is hidden. */
      readonly failure?: string;
    }
  | {
      readonly phase: "running";
      readonly preflight: FactConsistencyPreflight;
    }
  | {
      readonly phase: "results";
      readonly preflight: FactConsistencyPreflight;
      readonly run: FactConsistencyRun;
      readonly cursor: number;
    };

export type FactConsistencyKey = "up" | "down" | "enter" | "escape";

export type FactConsistencyAction =
  | { readonly kind: "confirm" }
  | { readonly kind: "close" }
  | { readonly kind: "move"; readonly cursor: number }
  | { readonly kind: "open"; readonly partId: string }
  | { readonly kind: "none" };

export interface FactConsistencyTransition {
  readonly surface: FactConsistencySurface;
  readonly action: FactConsistencyAction;
}

export function confirmingFactConsistency(
  preflight: FactConsistencyPreflight,
  failure?: string
): FactConsistencySurface {
  return failure === undefined
    ? { phase: "confirm", preflight }
    : { phase: "confirm", preflight, failure };
}

export function runningFactConsistency(
  preflight: FactConsistencyPreflight
): FactConsistencySurface {
  return { phase: "running", preflight };
}

export function completedFactConsistency(
  preflight: FactConsistencyPreflight,
  run: FactConsistencyRun,
  cursor = 0
): FactConsistencySurface {
  return {
    phase: "results",
    preflight,
    run,
    cursor: boundedCursor(run.findings, cursor)
  };
}

/** Keyboard ownership for the isolated surface. Enter on a result returns
 * the owning part id; the caller decides how to focus that part. */
export function factConsistencyKeyAction(
  surface: FactConsistencySurface,
  key: FactConsistencyKey
): FactConsistencyTransition {
  if (key === "escape") return { surface, action: { kind: "close" } };
  if (surface.phase === "confirm" && key === "enter") {
    return { surface: runningFactConsistency(surface.preflight), action: { kind: "confirm" } };
  }
  if (surface.phase !== "results") return { surface, action: { kind: "none" } };
  if (key === "up" || key === "down") {
    const delta = key === "down" ? 1 : -1;
    const cursor = boundedCursor(surface.run.findings, surface.cursor + delta);
    return {
      surface: { ...surface, cursor },
      action: { kind: "move", cursor }
    };
  }
  if (key === "enter") {
    const finding = surface.run.findings[surface.cursor];
    return finding === undefined
      ? { surface, action: { kind: "none" } }
      : { surface, action: { kind: "open", partId: finding.partId } };
  }
  return { surface, action: { kind: "none" } };
}

export function selectedFactConsistencyFinding(
  run: FactConsistencyRun,
  cursor: number
): FactConsistencyFinding | null {
  return run.findings[boundedCursor(run.findings, cursor)] ?? null;
}

function boundedCursor(findings: readonly FactConsistencyFinding[], cursor: number): number {
  if (findings.length === 0) return 0;
  return Math.max(0, Math.min(findings.length - 1, cursor));
}
