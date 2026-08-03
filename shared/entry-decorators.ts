/** Read the leading `@@decorator` lines from a lorebook or character-book
 * entry's `content` and return the content without them.
 *
 * A decorator is a line starting with `@@`; the run of them ends at the
 * first line that does not start with `@@`, and the newline after that run
 * is trimmed too. This is the Character Card V3 spec's Decorators section,
 * which SillyTavern World Info also honours for `@@activate` and
 * `@@dont_activate`. Reading a decorator only removes it from the text; it
 * does not act on any decorator's meaning, which is each caller's own to
 * decide. */
export function readLeadingDecorators(content: string): {
  readonly decorators: readonly string[];
  readonly content: string;
} {
  const lines = content.split("\n");
  const decorators: string[] = [];
  let index = 0;
  while (index < lines.length && lines[index]!.startsWith("@@")) {
    decorators.push(lines[index]!.replace(/\r$/u, ""));
    index += 1;
  }
  return { decorators, content: lines.slice(index).join("\n") };
}
