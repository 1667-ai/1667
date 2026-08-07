import type { ProfileTransferCandidate } from "./generation-profile-transfer.js";

/** Ordered source choices for Generation Profile import. */
export const STARTER_PROFILES = [
  { name: "conservative", temperature: 0.7, tokenProbabilities: null, sampling: { topP: 0.9 } },
  { name: "balanced", temperature: 0.85, tokenProbabilities: null, sampling: { topP: 0.95 } },
  { name: "adventurous prose", temperature: 1, tokenProbabilities: null, sampling: { topP: 0.98, minP: 0.03 } }
] as const satisfies readonly ProfileTransferCandidate[];
