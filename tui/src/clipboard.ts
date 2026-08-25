import { execFile, spawn } from "node:child_process";
import {
  MAX_SOURCE_IMAGE_BYTES,
  SOURCE_IMAGE_MEDIA_TYPES,
  type SourceImageMediaType
} from "../../shared/image-attachment.js";
import { readClipboardImageMacOS } from "./clipboard-macos.js";
import { isWslHost, readClipboardImageWindows } from "./clipboard-windows.js";
import { imageClipboardEntryPointOpen } from "../../shared/image-input-release.js";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const CLIPBOARD_TIMEOUT_MS = 1_000;
const CLIPBOARD_MAX_BYTES = 16 * 1024 * 1024;

export type CopyOutcome = "osc52" | "command" | "internal" | "unavailable";

/** What a clipboard read can answer. Negotiated before any text fallback:
 *  Wayland lists offered types, X11 reads TARGETS, macOS and Windows/WSL
 *  each run a bounded platform helper — see `selectOfferedImageMediaType`
 *  and the platform-specific readers below. */
export type ClipboardContent =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: SourceImageMediaType; bytes: Uint8Array };

interface RememberedCopy {
  content: ClipboardContent;
  platformConfirmed: boolean;
}

export class SessionClipboard {
  private copy: RememberedCopy | null = null;

  remember(text: string): void {
    this.copy = { content: { type: "text", text }, platformConfirmed: false };
  }

  confirmPlatformWrite(): void {
    if (this.copy !== null) this.copy.platformConfirmed = true;
  }

  beforePlatformRead(remote: boolean): { handled: boolean; content: ClipboardContent | null } {
    return remote || this.copy?.platformConfirmed === false
      ? { handled: true, content: this.copy?.content ?? null }
      : { handled: false, content: null };
  }

  fallback(): ClipboardContent | null {
    return this.copy?.content ?? null;
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

/** Read the clipboard for an explicit Ctrl+V or the `attach image`
 *  command's implicit paste-first affordance. Bracketed terminal paste
 *  still enters through OpenTUI's paste event, which is always text — see
 *  `keys.ts`'s `pasteInto`.
 *
 * When the clipboard image release switch is open, this function negotiates
 * a type before it falls back to text. On Wayland it lists the offered types.
 * On X11 it reads `TARGETS`. On macOS and Windows/WSL, a bounded platform
 * helper answers directly. Every image path bounds bytes before this function
 * constructs the `Uint8Array` that it returns. See each platform reader's
 * doc comment.
 *
 * The story composer's own paste path (`compose-clipboard.ts`) and the
 * shared composer-backed field paste path (`composer-surface-action.ts`)
 * are the two callers that read this union directly. Every other
 * composer-backed surface (settings values, Sampling fields, Generation
 * Profile import, a rename field) is plain text and reads `readFromClipboard`
 * below instead, unchanged from before Image Input existed. */
export async function readClipboardContent(
  imageClipboardOpen: boolean = imageClipboardEntryPointOpen()
): Promise<ClipboardContent | null> {
  // Platform readers address the host running 1667, not the terminal
  // client's clipboard. Remote sessions use the remembered in-app copy.
  const remembered = sessionClipboard.beforePlatformRead(isRemoteSession());
  if (remembered.handled) return remembered.content;
  if (imageClipboardOpen) {
    const image = await readClipboardImage(process.platform);
    if (image !== null) return image;
  }
  for (const command of clipboardReadCommands(process.platform)) {
    const text = await readClipboardCommand(command);
    if (text !== null) return { type: "text", text };
  }
  return sessionClipboard.fallback();
}

/** Text-only reader every composer-backed field outside the story composer
 *  already used before Image Input, kept byte-for-byte in its old contract
 *  so none of those callers has to widen its own type to a union it never
 *  needed. An image on the clipboard answers null here, exactly like an
 *  unreadable clipboard did before this module could tell the two apart. */
export async function readFromClipboard(): Promise<string | null> {
  const content = await readClipboardContent();
  return content?.type === "text" ? content.text : null;
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

/** Wayland's type-listing command: `wl-paste --list-types` prints one
 *  offered MIME type per line. X11's is `xclip -t TARGETS`. Both feed
 *  `selectOfferedImageMediaType` before either platform reads the bytes. */
export function clipboardImageListCommand(platform: NodeJS.Platform): readonly string[] | null {
  if (platform === "darwin" || platform === "win32") return null;
  return ["wl-paste", "--list-types"];
}

export function x11ClipboardTargetsCommand(): readonly string[] {
  return ["xclip", "-selection", "clipboard", "-t", "TARGETS", "-o"];
}

export function wlPasteImageCommand(mediaType: SourceImageMediaType): readonly string[] {
  return ["wl-paste", "--no-newline", "--type", mediaType];
}

export function xclipImageCommand(mediaType: SourceImageMediaType): readonly string[] {
  return ["xclip", "-selection", "clipboard", "-t", mediaType, "-o"];
}

/** The first Source Image media type both this build accepts and the
 *  clipboard actually offers, in `SOURCE_IMAGE_MEDIA_TYPES` order — a fixed,
 *  deterministic preference rather than whichever line came first. */
export function selectOfferedImageMediaType(
  offered: readonly string[]
): SourceImageMediaType | null {
  const set = new Set(offered.map((line) => line.trim().toLowerCase()));
  return SOURCE_IMAGE_MEDIA_TYPES.find((mediaType) => set.has(mediaType)) ?? null;
}

async function readClipboardImage(platform: NodeJS.Platform): Promise<ClipboardContent | null> {
  if (platform === "darwin") return await readClipboardImageMacOS();
  if (platform === "win32") return await readClipboardImageWindows();
  if (platform === "linux" && isWslHost()) return await readClipboardImageWindows();
  const wayland = await readClipboardImageWayland();
  if (wayland !== null) return wayland;
  return await readClipboardImageX11();
}

async function readClipboardImageWayland(): Promise<ClipboardContent | null> {
  const listed = await readClipboardCommand(clipboardImageListCommand("linux")!);
  if (listed === null) return null;
  const mediaType = selectOfferedImageMediaType(listed.split("\n"));
  if (mediaType === null) return null;
  const bytes = await readClipboardCommandBuffer(wlPasteImageCommand(mediaType), MAX_SOURCE_IMAGE_BYTES);
  return bytes === null ? null : { type: "image", mediaType, bytes };
}

async function readClipboardImageX11(): Promise<ClipboardContent | null> {
  const listed = await readClipboardCommand(x11ClipboardTargetsCommand());
  if (listed === null) return null;
  const mediaType = selectOfferedImageMediaType(listed.split("\n"));
  if (mediaType === null) return null;
  const bytes = await readClipboardCommandBuffer(xclipImageCommand(mediaType), MAX_SOURCE_IMAGE_BYTES);
  return bytes === null ? null : { type: "image", mediaType, bytes };
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

/** The buffer-returning sibling of `readClipboardCommand`: `maxBytes + 1`
 *  bounds the read before any `Uint8Array` exists. Node kills the child and
 *  reports an error the instant stdout would exceed that ceiling, so the
 *  callback here never sees an oversized buffer to wrap — it sees `null`. */
export function readClipboardCommandBuffer(
  command: readonly string[],
  maxBytes: number,
  timeoutMs = CLIPBOARD_TIMEOUT_MS
): Promise<Uint8Array | null> {
  const executable = command[0];
  if (executable === undefined) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(executable, command.slice(1), {
      encoding: "buffer",
      maxBuffer: maxBytes + 1,
      timeout: timeoutMs,
      windowsHide: true
    }, (error, stdout) => {
      if (error !== null || stdout.byteLength === 0 || stdout.byteLength > maxBytes) {
        resolve(null);
        return;
      }
      resolve(stdout);
    });
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
