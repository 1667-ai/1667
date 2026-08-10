import { describe, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import {
  canPromptForProject,
  confirmProjectCreation,
  promptVaultPassword
} from "../src/project-prompt.js";
import { readVaultPassphrase } from "../src/vault-passphrase.js";

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

  test("reads a hidden Vault Password and restores a paused terminal stream", async () => {
    const { input, output, rawModes, paused } = rawPipes();
    const asked = promptVaultPassword({ input, output });
    input.write(Buffer.from("passé\bword\n", "utf8"));
    expect(await asked).toBe("password");
    expect(rawModes).toEqual([true, false]);
    expect(paused()).toBe(1);
    expect(input.readableFlowing).toBeFalse();
    expect(written(output)).toBe("Vault Password: \n");
  });

  test("cancelling a Vault Password restores raw mode and a paused stream", async () => {
    const { input, output, rawModes, paused } = rawPipes();
    const asked = promptVaultPassword({ input, output });
    input.write(Buffer.from([3]));
    await assert.rejects(asked, /prompt cancelled/);
    expect(rawModes).toEqual([true, false]);
    expect(paused()).toBe(1);
    expect(input.readableFlowing).toBeFalse();
  });

  test("an input error restores raw mode and a paused stream", async () => {
    const { input, output, rawModes, paused } = rawPipes();
    const asked = promptVaultPassword({ input, output });
    input.emit("error", new Error("terminal input failed"));
    await assert.rejects(asked, /terminal input failed/);
    expect(rawModes).toEqual([true, false]);
    expect(paused()).toBe(1);
    expect(input.readableFlowing).toBeFalse();
  });

  test("an input end restores raw mode and a paused stream once", async () => {
    const { input, output, rawModes, paused } = rawPipes();
    const asked = promptVaultPassword({ input, output });
    input.end();
    await assert.rejects(asked, /prompt input ended/);
    expect(rawModes).toEqual([true, false]);
    expect(paused()).toBe(1);
    expect(input.readableFlowing).toBeFalse();
    expect(written(output)).toBe("Vault Password: \n");
  });

  test("an input close restores raw mode and a paused stream", async () => {
    const { input, output, rawModes, paused } = rawPipes();
    const asked = promptVaultPassword({ input, output });
    input.emit("close");
    await assert.rejects(asked, /prompt input closed/);
    expect(rawModes).toEqual([true, false]);
    expect(paused()).toBe(1);
    expect(input.readableFlowing).toBeFalse();
    expect(written(output)).toBe("Vault Password: \n");
  });

  test("Ctrl-D stops a Vault Password prompt without double cleanup", async () => {
    const { input, output, rawModes, paused } = rawPipes();
    const asked = promptVaultPassword({ input, output });
    input.write(Buffer.from([4]));
    input.emit("close");
    await assert.rejects(asked, /prompt input ended/);
    expect(rawModes).toEqual([true, false]);
    expect(paused()).toBe(1);
    expect(input.readableFlowing).toBeFalse();
    expect(written(output)).toBe("Vault Password: \n");
  });

  test("leaves an already flowing terminal stream flowing", async () => {
    const { input, rawModes, paused, output } = rawPipes({ flowing: true });
    const asked = promptVaultPassword({ input, output });
    input.write("password\n");
    expect(await asked).toBe("password");
    expect(rawModes).toEqual([true, false]);
    expect(paused()).toBe(0);
    expect(input.readableFlowing).toBeTrue();
  });

  test("confirmation mismatch restores both prompt stream lifecycles", async () => {
    const { input, output, rawModes, paused } = rawPipes();
    const asked = readVaultPassphrase({
      passphraseFile: null,
      dataDirectory: "/writing/.1667",
      confirm: true,
      input,
      output
    });
    input.write("first\n");
    await waitFor(() => rawModes.length === 3);
    input.write("second\n");
    await assert.rejects(asked, /entries do not match/);
    expect(rawModes).toEqual([true, false, true, false]);
    expect(paused()).toBe(2);
    expect(input.readableFlowing).toBeFalse();
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

function rawPipes(options: { flowing?: boolean } = {}): {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream & { chunks: string[] };
  rawModes: boolean[];
  paused(): number;
} {
  const { input, output } = pipes();
  const rawModes: boolean[] = [];
  let pauseCalls = 0;
  const pause = input.pause.bind(input);
  const resume = input.resume.bind(input);
  Object.assign(input, {
    isTTY: true,
    setRawMode: (value: boolean) => { rawModes.push(value); },
    pause: () => { pauseCalls += 1; return pause(); },
    resume: () => resume()
  });
  Object.assign(output, { isTTY: true });
  if (options.flowing === true) input.resume();
  return {
    input,
    output,
    rawModes,
    paused: () => pauseCalls,
  };
}

async function waitFor(condition: () => boolean): Promise<void> {
  while (!condition()) await new Promise((resolve) => setTimeout(resolve, 0));
}
