#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  openSync,
  closeSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync
} from "node:fs";
import { fileURLToPath } from "node:url";

const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_JOURNAL_BYTES = 1024 * 1024;
const MAX_TOOL_BYTES = 256 * 1024 * 1024;
const DIGEST = /^[0-9a-f]{64}$/u;
const runnerPath = realpathSync(fileURLToPath(import.meta.url));

const [mode, encoded] = process.argv.slice(2);
try {
  const config = parseConfig(encoded);
  if (mode === "supervise") supervise(config, encoded);
  else if (mode === "worker") work(config, encoded);
  else if (mode === "execute") execute(config);
  else throw new Error("npm child runner mode is invalid");
} catch (error) {
  process.stderr.write(`release-npm-child-runner: ${message(error)}\n`);
  process.exitCode = 1;
}

function supervise(config, encodedConfig) {
  requireIpc();
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error("npm child keeper requires a POSIX process group");
  }
  const worker = spawn(
    config.tool.node.path,
    [config.tool.runner.path, "worker", encodedConfig],
    {
      env: process.env,
      shell: false,
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      windowsHide: true
    }
  );
  let terminal = null;
  let settled = false;
  let termination = null;
  let killTimer;
  const deadline = setTimeout(
    () => terminate("independent"),
    config.independentTimeoutMs
  );
  worker.on("message", (value) => {
    try {
      requireMessage(value, config.nonce);
      if (value.type === "ready" || value.type === "runner-error") {
        process.send?.(value);
      } else if (value.type === "exit" && terminal === null) {
        terminal = value;
        process.send?.(value);
      } else {
        terminate("protocol");
      }
    } catch {
      terminate("protocol");
    }
  });
  worker.on("error", (error) => {
    process.send?.({ type: "runner-error", nonce: config.nonce, message: message(error) });
  });
  worker.once("close", () => {
    if (terminal === null && !settled) killOperationGroup();
  });
  process.on("message", (value) => {
    try {
      requireMessage(value, config.nonce);
    } catch {
      terminate("protocol");
      return;
    }
    if (value.type === "permit") {
      worker.send(value, sendError);
    } else if (value.type === "cancel") {
      terminate(value.reason === "timeout" ? "timeout" : "cancel");
    } else if (value.type === "terminal-recorded"
      && terminal !== null
      && value.pid === terminal.pid
      && !settled) {
      try {
        verifyTerminalRecord(config, terminal.pid);
      } catch {
        terminate("protocol");
        return;
      }
      settled = true;
      clearTimeout(deadline);
      if (killTimer !== undefined) clearTimeout(killTimer);
      process.send?.({
        type: "settled",
        pid: terminal.pid,
        nonce: config.nonce
      }, (error) => {
        if (error !== null) {
          killOperationGroup();
          return;
        }
        process.disconnect?.();
      });
    } else {
      terminate("protocol");
    }
  });
  process.on("disconnect", () => terminate("parent-disconnect"));

  function terminate(reason) {
    if (termination !== null || settled) return;
    termination = reason;
    if (worker.connected) {
      worker.send({
        type: "cancel",
        nonce: config.nonce,
        reason
      }, sendError);
    }
    killTimer = setTimeout(
      killOperationGroup,
      config.terminationGraceMs + 1_000
    );
  }

  function sendError(error) {
    if (error !== null) terminate("protocol");
  }

  function killOperationGroup() {
    process.kill(-process.pid, "SIGKILL");
  }
}

function work(config, encodedConfig) {
  requireIpc();
  const child = spawn(
    config.tool.node.path,
    [config.tool.runner.path, "execute", encodedConfig],
    {
      env: process.env,
      shell: false,
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      windowsHide: true
    }
  );
  let executorPid = null;
  let termination = null;
  let killTimer;
  child.on("message", (value) => {
    if (!objectMessage(value) || value.nonce !== config.nonce) {
      terminate("protocol");
      return;
    }
    if (value.type === "ready" && value.pid === child.pid
      && executorPid === null) {
      executorPid = value.pid;
      if (process.connected) {
        process.send?.({ type: "ready", pid: executorPid, nonce: config.nonce });
      }
    }
  });
  child.on("error", (error) => {
    if (process.connected) {
      process.send?.({
        type: "runner-error",
        nonce: config.nonce,
        message: message(error)
      });
    }
  });
  child.once("exit", (code, signal) => {
    if (killTimer !== undefined) clearTimeout(killTimer);
    if (process.connected) {
      process.send?.({
        type: "exit",
        pid: executorPid,
        nonce: config.nonce,
        code,
        signal,
        timedOut: termination === "timeout" || termination === "independent",
        independent: termination === "independent"
      });
      process.disconnect?.();
    }
  });
  process.on("message", (value) => {
    if (!objectMessage(value) || value.nonce !== config.nonce) {
      terminate("protocol");
    } else if (value.type === "permit") {
      child.send({ type: "permit", nonce: config.nonce });
    } else if (value.type === "cancel") {
      terminate(value.reason === "timeout" ? "timeout" : value.reason);
    }
  });
  process.on("disconnect", () => terminate("keeper-disconnect"));

  function terminate(reason) {
    if (termination !== null || child.exitCode !== null || child.signalCode !== null) return;
    termination = reason;
    child.kill("SIGTERM");
    killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, config.terminationGraceMs);
  }
}

function execute(config) {
  requireIpc();
  if (typeof process.execve !== "function") {
    throw new Error("npm child runner requires process.execve");
  }
  verifyTools(config);
  if (realpathSync(process.execPath) !== config.tool.node.path
    || runnerPath !== config.tool.runner.path) {
    throw new Error("npm child runner tool path changed");
  }
  process.send?.({ type: "ready", pid: process.pid, nonce: config.nonce });
  let permitted = false;
  process.once("message", (value) => {
    if (permitted || !objectMessage(value)
      || value.type !== "permit" || value.nonce !== config.nonce) {
      process.exitCode = 1;
      return;
    }
    permitted = true;
    verifyStartedRecord(config, process.pid);
    verifyTools(config, false);
    process.disconnect?.();
    process.execve(config.tool.node.path, config.npmCommand, process.env);
  });
  process.on("disconnect", () => {
    if (!permitted) process.exitCode = 1;
  });
}

function verifyStartedRecord(config, pid) {
  const stat = statSync(config.journalPath);
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_JOURNAL_BYTES) {
    throw new Error("npm child runner process journal is invalid");
  }
  const contents = readFileSync(config.journalPath, "utf8");
  if (!contents.endsWith("\n")) {
    throw new Error("npm child runner process journal has an incomplete record");
  }
  const lines = contents.slice(0, -1).split("\n");
  const record = lines.map((line) => JSON.parse(line)).findLast((value) => {
    return value?.record === "started"
      && value.pid === pid
      && value.nonce === config.nonce;
  });
  if (record === undefined
    || JSON.stringify(record.tool) !== JSON.stringify(config.tool)
    || JSON.stringify(record.arguments) !== JSON.stringify(config.arguments)
    || JSON.stringify(record.npmCommand) !== JSON.stringify(config.npmCommand)
    || !sameIdentity(record, config.identity)) {
    throw new Error("npm child runner has no durable start permission");
  }
}

function verifyTerminalRecord(config, pid) {
  const stat = statSync(config.journalPath);
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_JOURNAL_BYTES) {
    throw new Error("npm child keeper process journal is invalid");
  }
  const contents = readFileSync(config.journalPath, "utf8");
  if (!contents.endsWith("\n")) {
    throw new Error("npm child keeper process journal has an incomplete record");
  }
  const record = contents.slice(0, -1).split("\n")
    .map((line) => JSON.parse(line))
    .at(-1);
  if (record?.record !== "terminal"
    || record.pid !== pid
    || record.nonce !== config.nonce
    || !sameIdentity(record, config.identity)) {
    throw new Error("npm child keeper has no durable terminal record");
  }
}

function parseConfig(encoded) {
  if (typeof encoded !== "string" || encoded === ""
    || Buffer.byteLength(encoded) > MAX_CONFIG_BYTES * 2) {
    throw new Error("npm child runner config is invalid");
  }
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.length <= 0 || bytes.length > MAX_CONFIG_BYTES) {
    throw new Error("npm child runner config exceeds its bound");
  }
  const value = JSON.parse(bytes.toString("utf8"));
  if (!objectMessage(value) || !DIGEST.test(value.nonce)
    || typeof value.journalPath !== "string"
    || !Number.isSafeInteger(value.independentTimeoutMs)
    || value.independentTimeoutMs <= 0 || value.independentTimeoutMs > 300_000
    || !Number.isSafeInteger(value.terminationGraceMs)
    || value.terminationGraceMs <= 0 || value.terminationGraceMs > 30_000
    || !objectMessage(value.tool) || !objectMessage(value.identity)) {
    throw new Error("npm child runner config fields are invalid");
  }
  const arguments_ = stringArray(value.arguments, "arguments");
  const npmCommand = stringArray(value.npmCommand, "command");
  tool(value.tool.node);
  tool(value.tool.npmCli);
  tool(value.tool.runner);
  const expected = [
    value.tool.node.path,
    value.tool.npmCli.path,
    `--user-agent=1667-npm-operation-${value.nonce}`,
    ...arguments_
  ];
  if (npmCommand.length !== expected.length
    || npmCommand.some((part, index) => part !== expected[index])) {
    throw new Error("npm child runner command does not bind its nonce");
  }
  return value;
}

function stringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 128
    || value.some((part) => typeof part !== "string"
      || Buffer.byteLength(part) > 16 * 1024)) {
    throw new Error(`npm child runner ${label} is invalid`);
  }
  return value;
}

function verifyTools(config, includeNode = true) {
  const entries = includeNode
    ? [config.tool.node, config.tool.npmCli, config.tool.runner]
    : [config.tool.npmCli, config.tool.runner];
  for (const entry of entries) {
    if (hashFile(entry.path) !== entry.sha256) {
      throw new Error(`npm child runner tool digest changed for ${entry.path}`);
    }
  }
}

function tool(value) {
  if (!objectMessage(value) || typeof value.path !== "string"
    || typeof value.sha256 !== "string" || !DIGEST.test(value.sha256)
    || realpathSync(value.path) !== value.path) {
    throw new Error("npm child runner tool identity is invalid");
  }
}

function hashFile(file) {
  const stat = statSync(file);
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_TOOL_BYTES) {
    throw new Error(`npm child runner tool is invalid: ${file}`);
  }
  const descriptor = openSync(file, "r");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytes;
    while ((bytes = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

function sameIdentity(record, identity) {
  return ["runId", "runAttempt", "operation", "version", "sourceCommit"]
    .every((key) => record[key] === identity[key]);
}

function requireIpc() {
  if (typeof process.send !== "function" || !process.connected) {
    throw new Error("npm child runner requires an IPC parent");
  }
}

function requireMessage(value, nonce) {
  if (!objectMessage(value)
    || value.nonce !== nonce
    || typeof value.type !== "string") {
    throw new Error("npm child runner IPC identity changed");
  }
}

function objectMessage(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}
