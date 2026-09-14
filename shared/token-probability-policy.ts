/** Bounds shared by settings validation and token-probability codecs. */
export const MAX_TOKEN_PROBABILITY_STEPS = 8_192;
/** OpenAI's documented `top_logprobs` ceiling. */
export const MAX_ALTERNATIVE_TOKENS = 20;
export const MAX_TOKEN_PROBABILITY_TEXT_CHARS = 256;
export const MAX_TOKEN_PROBABILITY_BYTES = 4 * 1024 * 1024;
