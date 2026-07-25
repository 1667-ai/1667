import { createInterface } from "node:readline/promises";

export interface ProjectPromptStreams {
  readonly input: NodeJS.ReadStream;
  readonly output: NodeJS.WriteStream;
}

/**
 * ADR007 asks once, and only where a person can answer. A non-interactive
 * start refuses in one line instead of creating a project nobody asked for.
 */
export function canPromptForProject(streams: ProjectPromptStreams): boolean {
  return streams.input.isTTY === true && streams.output.isTTY === true;
}

export async function confirmProjectCreation(
  cwd: string,
  streams: ProjectPromptStreams
): Promise<boolean> {
  const readline = createInterface({
    input: streams.input,
    output: streams.output
  });
  try {
    const answer = await readline.question(`Create story project in ${cwd}? [Y/n] `);
    const normalized = answer.trim().toLowerCase();
    return normalized === "" || normalized === "y" || normalized === "yes";
  } finally {
    readline.close();
  }
}
