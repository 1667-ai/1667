import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import {
  canPromptForProject,
  confirmProjectCreation
} from "../src/project-prompt.js";

describe("absent project prompt", () => {
  test("asks only where a person can answer", () => {
    expect(canPromptForProject(streams({ input: true, output: true }))).toBeTrue();
    expect(canPromptForProject(streams({ input: false, output: true }))).toBeFalse();
    expect(canPromptForProject(streams({ input: true, output: false }))).toBeFalse();
  });

  test("accepts an empty answer and a yes, declines anything else", async () => {
    for (const [answer, expected] of [
      ["\n", true],
      ["y\n", true],
      ["Y\n", true],
      ["yes\n", true],
      ["n\n", false],
      ["no\n", false],
      ["later\n", false]
    ] as const) {
      const { input, output } = pipes();
      const asked = confirmProjectCreation("/writing/book", { input, output });
      input.write(answer);
      expect(await asked).toBe(expected);
      expect(written(output)).toContain("Create story project in /writing/book? [Y/n]");
    }
  });
});

function streams(
  tty: { input: boolean; output: boolean }
): { input: NodeJS.ReadStream; output: NodeJS.WriteStream } {
  return {
    input: { isTTY: tty.input } as NodeJS.ReadStream,
    output: { isTTY: tty.output } as NodeJS.WriteStream
  };
}

function pipes(): {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream & { chunks: string[] };
} {
  const input = new PassThrough() as unknown as NodeJS.ReadStream;
  const chunks: string[] = [];
  const stream = new PassThrough();
  stream.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));
  const output = Object.assign(stream, { chunks }) as unknown as
    NodeJS.WriteStream & { chunks: string[] };
  return { input, output };
}

function written(output: NodeJS.WriteStream & { chunks: string[] }): string {
  return output.chunks.join("");
}
