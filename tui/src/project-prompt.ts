import { createInterface } from "node:readline/promises";

export interface ProjectPromptStreams {
  readonly input: NodeJS.ReadStream;
  readonly output: NodeJS.WriteStream;
}

/**
 * 1667 asks once, and only where a person can answer. A non-interactive
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

/** Read one Vault Password without echoing its characters to the terminal. */
export async function promptVaultPassword(
  streams: ProjectPromptStreams,
  prompt = "Vault Password: "
): Promise<string> {
  if (!canPromptForProject(streams) || streams.input.setRawMode === undefined) {
    throw new Error("Vault Password requires a TTY");
  }
  streams.output.write(prompt);
  streams.input.setRawMode(true);
  // A CLI can receive a paused stdin from its caller. We need flowing input
  // for the hidden prompt, but must return that stream to its prior state.
  const resumedPausedStream = streams.input.readableFlowing !== true;
  return await new Promise<string>((resolve, reject) => {
    let value = "";
    let settled = false;
    const decoder = new TextDecoder("utf-8", { fatal: false });
    let pending: number[] = [];
    const appendPending = () => {
      if (pending.length === 0) return;
      value += decoder.decode(Uint8Array.from(pending), { stream: true });
      pending = [];
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      streams.input.off("data", onData);
      streams.input.off("error", onError);
      streams.input.off("end", onEnd);
      streams.input.off("close", onClose);
      streams.input.setRawMode?.(false);
      if (resumedPausedStream) streams.input.pause();
      streams.output.write("\n");
      if (error === undefined) resolve(value);
      else reject(error);
    };
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 3) {
          appendPending();
          return finish(new Error("Vault Password prompt cancelled"));
        }
        if (byte === 4) {
          appendPending();
          return finish(new Error("Vault Password prompt input ended"));
        }
        if (byte === 13 || byte === 10) {
          appendPending();
          return finish();
        }
        if (byte === 127 || byte === 8) {
          appendPending();
          value = Array.from(value).slice(0, -1).join("");
          continue;
        }
        if (byte >= 32) pending.push(byte);
      }
      appendPending();
    };
    const onError = (error: Error) => finish(error);
    const onEnd = () => finish(new Error("Vault Password prompt input ended"));
    const onClose = () => finish(new Error("Vault Password prompt input closed"));
    streams.input.on("data", onData);
    streams.input.once("error", onError);
    streams.input.once("end", onEnd);
    streams.input.once("close", onClose);
    if (resumedPausedStream) streams.input.resume();
  });
}
