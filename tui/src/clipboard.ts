import { execFile, spawn } from "node:child_process";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const CLIPBOARD_TIMEOUT_MS = 1_000;
const CLIPBOARD_MAX_BYTES = 16 * 1024 * 1024;

export type CopyOutcome = "osc52" | "command" | "internal" | "unavailable";

interface RememberedCopy {
  text: string;
  platformConfirmed: boolean;
}

export class SessionClipboard {
  private copy: RememberedCopy | null = null;

  remember(text: string): void {
    this.copy = { text, platformConfirmed: false };
  }

  confirmPlatformWrite(): void {
    if (this.copy !== null) this.copy.platformConfirmed = true;
  }

  beforePlatformRead(remote: boolean): { handled: boolean; text: string | null } {
    return remote || this.copy?.platformConfirmed === false
      ? { handled: true, text: this.copy?.text ?? null }
      : { handled: false, text: null };
  }

  fallback(): string | null {
    return this.copy?.text ?? null;
  }
}

const sessionClipboard = new SessionClipboard();

/** Prefer an acknowledged local platform write. OSC 52 reaches a terminal
 * clipboard across SSH/tmux; the session buffer backs both paths. */
export async function copyToClipboard(
  text: string
): Promise<CopyOutcome> {
  sessionClipboard.remember(text);
  const localClipboard = !isRemoteSession();
  if (localClipboard && await runClipboardCommand(text)) {
    sessionClipboard.confirmPlatformWrite();
    return "command";
  }
  const payload = Buffer.from(text, "utf8").toString("base64");
  if (process.stdout.isTTY) {
    const inner = `${ESC}]52;c;${payload}${BEL}`;
    // tmux swallows OSC unless the sequence is wrapped for passthrough.
    const wrapped = process.env.TMUX === undefined
      ? inner
      : `${ESC}Ptmux;${inner.split(ESC).join(ESC + ESC)}${ESC}\\`;
    process.stdout.write(wrapped);
    return "osc52";
  }
  // Keep an in-process fallback even when the terminal cannot expose a host
  // clipboard. Copying story prose into an editor must remain deterministic.
  return "internal";
}

/** Read text for an explicit Ctrl+V. Bracketed terminal paste still enters
 * through OpenTUI's paste event; this covers terminals that send the chord. */
export async function readFromClipboard(): Promise<string | null> {
  // Platform readers address the host running 1667, not the terminal
  // client's clipboard. Remote sessions use the remembered in-app copy.
  const remembered = sessionClipboard.beforePlatformRead(isRemoteSession());
  if (remembered.handled) return remembered.text;
  for (const command of clipboardReadCommands(process.platform)) {
    const text = await readClipboardCommand(command);
    if (text !== null) return text;
  }
  return sessionClipboard.fallback();
}

/** Host clipboard commands cannot acknowledge the terminal client's clipboard
 * across SSH. OSC 52 still reaches it, but remains intentionally unconfirmed. */
export function isRemoteSession(environment: NodeJS.ProcessEnv = process.env): boolean {
  return ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"]
    .some((name) => (environment[name]?.length ?? 0) > 0);
}

export function clipboardReadCommands(platform: NodeJS.Platform): readonly (readonly string[])[] {
  return platform === "darwin"
    ? [["/usr/bin/pbpaste"]]
    : platform === "win32"
      ? [[
        "powershell.exe", "-NonInteractive", "-NoProfile", "-Command",
        "$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); "
          + "[Console]::Out.Write([string](Get-Clipboard -Raw))"
      ]]
      : [
        ["wl-paste", "--no-newline", "--type", "text"],
        ["xclip", "-selection", "clipboard", "-out"],
        ["xsel", "--clipboard", "--output"]
      ];
}

export function clipboardWriteCommands(platform: NodeJS.Platform): readonly (readonly string[])[] {
  return platform === "darwin"
    ? [["/usr/bin/pbcopy"]]
    : platform === "win32"
      ? [[
        "powershell.exe", "-NonInteractive", "-NoProfile", "-Command",
        "[Console]::InputEncoding = [Text.UTF8Encoding]::new($false); "
          + "Set-Clipboard -Value ([Console]::In.ReadToEnd())"
      ]]
      : [["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]];
}

/** Execute clipboard readers off the input thread and kill stalled providers. */
export function readClipboardCommand(
  command: readonly string[],
  timeoutMs = CLIPBOARD_TIMEOUT_MS
): Promise<string | null> {
  const executable = command[0];
  if (executable === undefined) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(executable, command.slice(1), {
      encoding: "utf8",
      maxBuffer: CLIPBOARD_MAX_BYTES,
      timeout: timeoutMs,
      windowsHide: true
    }, (error, stdout) => resolve(error === null ? stdout : null));
  });
}

async function runClipboardCommand(text: string): Promise<boolean> {
  for (const command of clipboardWriteCommands(process.platform)) {
    if (await writeClipboardCommand(command, text)) return true;
  }
  return false;
}

function writeClipboardCommand(command: readonly string[], text: string): Promise<boolean> {
  const executable = command[0];
  if (executable === undefined) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (success: boolean) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolve(success);
    };
    const child = spawn(executable, command.slice(1), {
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true
    });
    child.once("error", () => finish(false));
    child.once("exit", (code) => finish(code === 0));
    child.stdin.on("error", () => { /* exit/error owns the result */ });
    child.stdin.end(text, "utf8");
    timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish(false);
    }, CLIPBOARD_TIMEOUT_MS);
  });
}
