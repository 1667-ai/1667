import { exactStringPattern } from "./story-wire-patterns.js";

export const TIME_MS_PATTERN_SOURCE = "[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z";
export const DECIMAL_20_PATTERN_SOURCE = "[0-9]{20}";
export const V6_MUTATION_ID_PATTERN_SOURCE = "m1\\.[0-9]{13}\\.[a-f0-9]{32}";

export const TIME_MS_PATTERN = exactStringPattern(TIME_MS_PATTERN_SOURCE);
export const DECIMAL_20_PATTERN = exactStringPattern(DECIMAL_20_PATTERN_SOURCE);
export const V6_MUTATION_ID_PATTERN = exactStringPattern(V6_MUTATION_ID_PATTERN_SOURCE);

export const UINT64_MAX_DECIMAL = "18446744073709551615";
export const UINT64_MAX = BigInt(UINT64_MAX_DECIMAL);
export const ZERO_20 = "00000000000000000000";
export const REVISION_ONE = "00000000000000000001";
