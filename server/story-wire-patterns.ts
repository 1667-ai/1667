/** ECMAScript `$` also matches before one final line terminator. Wire scalars
 * need a true end-of-string assertion in both runtime regexes and JSON Schema. */
export const EXACT_STRING_END_PATTERN_SOURCE = "(?![\\s\\S])";

export function exactStringPatternSource(body: string): string {
  return `^(?:${body})${EXACT_STRING_END_PATTERN_SOURCE}`;
}

export function exactStringPattern(body: string): RegExp {
  return new RegExp(exactStringPatternSource(body));
}
