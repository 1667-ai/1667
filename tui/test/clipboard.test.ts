import { describe, expect, test } from "bun:test";
import {
  clipboardReadCommands,
  clipboardWriteCommands,
  isRemoteSession,
  readClipboardCommand,
  SessionClipboard
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
      text: "selected prose"
    });
    expect(clipboard.beforePlatformRead(true)).toEqual({
      handled: true,
      text: "selected prose"
    });

    clipboard.confirmPlatformWrite();
    expect(clipboard.beforePlatformRead(false)).toEqual({ handled: false, text: null });
    expect(clipboard.fallback()).toBe("selected prose");
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
