/** Browser entry points for the canonical shared wire parsers. */
export {
  parseTokenProbabilitiesWire as parseTokenProbabilitiesResponse
} from "../shared/token-probability-wire.js";
export {
  parseReasoningWire as parseReasoningResponse
} from "../shared/reasoning-wire.js";
export type { TokenProbabilityRecord } from "../shared/token-probabilities.js";
export type { ReasoningRecord } from "../shared/reasoning.js";
