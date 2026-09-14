/** One increment of model reasoning text, kept apart from generated prose. */
export interface ReasoningDelta {
  readonly text: string;
  /** Running token total for the complete reasoning stream. */
  readonly tokenCount: number;
}
