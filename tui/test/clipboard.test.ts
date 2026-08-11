import { describe, expect, test } from "bun:test";
import {
  clipboardImageListCommand,
  clipboardReadCommands,
  clipboardWriteCommands,
  isRemoteSession,
  readClipboardCommand,
  readClipboardCommandBuffer,
  selectOfferedImageMediaType,
  SessionClipboard,
  wlPasteImageCommand,
  x11ClipboardTargetsCommand,
  xclipImageCommand
} from "../src/clipboard.js";

describe("clipboard commands", () => {
  test("Windows reads write the clipboard directly without pipeline newlines", () => {
    const command = clipboardReadCommands("win32")[0]!;
    expect(command.join(" ")).toContain("[Console]::Out.Write");
    expect(command.join(" ")).toContain("UTF8Encoding");
  });

  test("Wayland reads suppress wl-paste's synthetic newline", () => {
    expect(clipboardReadCommands("linux")[0]).toContain("--no-newline");
  });

  test("packaged macOS builds use absolute clipboard helper paths", () => {
    expect(clipboardReadCommands("darwin")[0]?.[0]).toBe("/usr/bin/pbpaste");
    expect(clipboardWriteCommands("darwin")[0]?.[0]).toBe("/usr/bin/pbcopy");
  });

  test("an unconfirmed terminal copy remains readable inside the app", () => {
    const clipboard = new SessionClipboard();
    clipboard.remember("selected prose");

    expect(clipboard.beforePlatformRead(false)).toEqual({
      handled: true,
      content: { type: "text", text: "selected prose" }
    });
    expect(clipboard.beforePlatformRead(true)).toEqual({
      handled: true,
      content: { type: "text", text: "selected prose" }
    });

    clipboard.confirmPlatformWrite();
    expect(clipboard.beforePlatformRead(false)).toEqual({ handled: false, content: null });
    expect(clipboard.fallback()).toEqual({ type: "text", text: "selected prose" });
  });

  test("SSH sessions do not treat the remote host clipboard as local", () => {
    expect(isRemoteSession({ SSH_CONNECTION: "client 1 server 2" })).toBeTrue();
    expect(isRemoteSession({ SSH_CLIENT: "client 1 2" })).toBeTrue();
    expect(isRemoteSession({ SSH_TTY: "/dev/pts/1" })).toBeTrue();
    expect(isRemoteSession({})).toBeFalse();
  });

  test("reader output stays exact and stalled providers time out", async () => {
    expect(await readClipboardCommand([
      process.execPath, "-e", "process.stdout.write('exact')"
    ])).toBe("exact");

    const started = Date.now();
    expect(await readClipboardCommand([
      process.execPath, "-e", "setTimeout(() => {}, 10_000)"
    ], 25)).toBe(null);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("clipboard image type negotiation", () => {
  test("Wayland lists offered types before reading any bytes", () => {
    expect(clipboardImageListCommand("linux")).toEqual(["wl-paste", "--list-types"]);
    expect(clipboardImageListCommand("darwin")).toBe(null);
    expect(clipboardImageListCommand("win32")).toBe(null);
  });

  test("X11 reads TARGETS the same way", () => {
    expect(x11ClipboardTargetsCommand()).toEqual(["xclip", "-selection", "clipboard", "-t", "TARGETS", "-o"]);
  });

  test("the image read commands name the exact negotiated type", () => {
    expect(wlPasteImageCommand("image/png")).toEqual(["wl-paste", "--no-newline", "--type", "image/png"]);
    expect(xclipImageCommand("image/jpeg"))
      .toEqual(["xclip", "-selection", "clipboard", "-t", "image/jpeg", "-o"]);
  });

  test("selects PNG, JPEG, or WebP in a fixed order, never an unaccepted type", () => {
    expect(selectOfferedImageMediaType(["text/plain", "image/jpeg", "image/png"])).toBe("image/png");
    expect(selectOfferedImageMediaType(["TARGETS", "image/jpeg"])).toBe("image/jpeg");
    expect(selectOfferedImageMediaType(["image/webp"])).toBe("image/webp");
    expect(selectOfferedImageMediaType(["text/plain", "text/html"])).toBe(null);
    expect(selectOfferedImageMediaType(["image/tiff", "image/bmp"])).toBe(null);
    expect(selectOfferedImageMediaType([])).toBe(null);
  });
});

describe("bounded clipboard buffer reads", () => {
  test("returns the exact bytes a provider writes", async () => {
    const bytes = await readClipboardCommandBuffer([
      process.execPath, "-e", "process.stdout.write(Buffer.from([1, 2, 3, 4]))"
    ], 1_024);
    expect(bytes).not.toBe(null);
    expect(Array.from(bytes!)).toEqual([1, 2, 3, 4]);
  });

  test("refuses output over the bound before any Uint8Array is built", async () => {
    // The provider writes one byte more than the bound; execFile's own
    // maxBuffer (set to bound + 1) kills it before this ever reads the
    // whole thing back, so the result is null, not a truncated array.
    const bytes = await readClipboardCommandBuffer([
      process.execPath, "-e", "process.stdout.write(Buffer.alloc(10))"
    ], 4);
    expect(bytes).toBe(null);
  });

  test("empty output is treated as no image, not a zero-byte one", async () => {
    const bytes = await readClipboardCommandBuffer([
      process.execPath, "-e", "process.stdout.write('')"
    ], 1_024);
    expect(bytes).toBe(null);
  });

  test("a stalled provider times out to null", async () => {
    const started = Date.now();
    const bytes = await readClipboardCommandBuffer([
      process.execPath, "-e", "setTimeout(() => {}, 10_000)"
    ], 1_024, 25);
    expect(bytes).toBe(null);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
