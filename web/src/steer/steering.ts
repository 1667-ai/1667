/**
 * What leads a continuation, beyond the story itself. It is empty in step 1.
 * Later steps add attention locks and future knobs here; `steeringInstruction`
 * then renders them into the instruction of the preview request.
 */
export type Steering = Readonly<Record<never, never>>;

export const NO_STEERING: Steering = {};

export function steeringInstruction(_steering: Steering): string {
  return "";
}
