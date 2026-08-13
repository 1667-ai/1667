/**
 * Parse Direct-composer Aside shortcuts.
 *
 * `/aside` opens Aside empty.
 * `/aside <question>` opens Aside and sends the question.
 * `//aside` remains normal Direct input (leading double slash).
 */
export type AsideComposerParse =
  | { kind: "none" }
  | { kind: "open" }
  | { kind: "open-and-ask"; question: string };

export function parseAsideComposerInput(raw: string): AsideComposerParse {
  // Double-slash keeps the literal text as Direct input.
  if (raw.startsWith("//aside")) return { kind: "none" };
  if (raw === "/aside" || raw === "/aside\n") return { kind: "open" };
  if (!raw.startsWith("/aside")) return { kind: "none" };
  // Require a space (or newline) after the command so `/asideways` is not a match.
  if (raw[6] !== " " && raw[6] !== "\n" && raw[6] !== "\t") return { kind: "none" };
  const question = raw.slice(6).trim();
  if (question.length === 0) return { kind: "open" };
  return { kind: "open-and-ask", question };
}
