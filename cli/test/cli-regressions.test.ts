import { describe, expect, test } from "bun:test";
import path from "node:path";
import { InternalErrorReporter } from "../../server/internal-error-reporter.js";
import { PublicRuntimeError } from "../../server/errors.js";
import { errorFromFailureIncident } from "../../server/reported-service-error.js";
import {
  httpRecoveryWarning,
  parseArguments,
  resolveEmbeddedDataDirectory,
  storyFolderForBackend
} from "../src/main.js";
import { sanitizeLegacyServeFailure } from "../src/http-commands.js";

describe("review regressions", () => {
  test("legacy serve shows internal failures without a persisted log", async () => {
    const privateFailure = errorFromFailureIncident(
      await InternalErrorReporter.disabled().report(
        new Error("private /machine/path"),
        { service: "legacy-http" }
      )
    );

    const displayed = sanitizeLegacyServeFailure(privateFailure);

    expect(displayed.message).toBe("Error: private /machine/path");
    expect(displayed.cause).toBe(privateFailure);
  });

  test("legacy serve preserves actionable pre-listener failures", () => {
    const safeFailure = new PublicRuntimeError(
      "HTTP auth and legacy serve are unavailable on Windows"
    );

    const displayed = sanitizeLegacyServeFailure(safeFailure);

    expect(displayed.message).toBe(safeFailure.message);
    expect(displayed.cause).toBe(safeFailure);
  });

  test("HTTP recovery warnings retain compatible future codes", () => {
    const warning = httpRecoveryWarning({
      mutationId: "m1-future-warning",
      method: "createStory",
      storyId: null,
      code: "future_warning",
      message: "Future compatible warning",
      status: 409
    });

    expect(warning.error.code).toBe("future_warning");
    expect(warning.error.message).toBe("Future compatible warning");
    expect(warning.error.status).toBe(409);
  });

  test("supports equals forms and rejects prefixed typos", () => {
    const parsed = parseArguments(["--story=abc", "--url=http://127.0.0.1:9999", "--size=80x24", "--render-once"]);
    expect(parsed).toMatchObject({ storyId: "abc", url: "http://127.0.0.1:9999", width: 80, height: 24 });
    expect(() => parseArguments(["--storyy"])).toThrow("unknown option: --storyy");
    expect(parseArguments(["--embedded"])?.embedded).toBeTrue();
    expect(parseArguments(["--print-logs"])).toMatchObject({
      embedded: true,
      printLogs: true
    });
    expect(parseArguments(["--embedded", "--data=stories-v2"])?.dataDir).toBe("stories-v2");
    for (const option of [
      "--data",
      "--auth-file",
      "--story",
      "--size",
      "--keys"
    ]) {
      expect(() => parseArguments([option, ""])).toThrow("requires a non-option value");
      expect(() => parseArguments([option, "--diagnostic"]))
        .toThrow("requires a non-option value");
    }
    // --url is optional-valued: bare means "the server this project
    // published". An empty value is still a mistake.
    expect(parseArguments(["--url"])).toMatchObject({ url: null, embedded: false });
    expect(parseArguments(["--url", "--story", "abc"]))
      .toMatchObject({ url: null, embedded: false, storyId: "abc" });
    expect(() => parseArguments(["--url", ""])).toThrow("requires a non-option value");
    expect(() => parseArguments(["--url", "--auth-file", "/tmp/auth.json"]))
      .toThrow("--auth-file needs the --url it belongs to");
    expect(parseArguments([])?.embedded).toBeTrue();
    expect(parseArguments(["--url=http://127.0.0.1:9999"])?.embedded).toBeFalse();
    expect(() => parseArguments(["--url=http://localhost:9999"]))
      .toThrow("canonical numeric loopback");
    expect(() => parseArguments(["--embedded", "--url=http://localhost:9999"]))
      .toThrow("--embedded and --url cannot be used together");
    expect(parseArguments(["--data", "stories-v2"])?.embedded).toBeTrue();
    expect(() => parseArguments(["--demo", "--embedded", "--data", "stories-v2"]))
      .toThrow("--data cannot be used with --demo");
    expect(parseArguments(["--global"])).toMatchObject({
      embedded: true,
      global: true
    });
    expect(() => parseArguments(["--global", "--data", "book"]))
      .toThrow("--global and --data select different projects");
    expect(() => parseArguments(["--global", "--demo"]))
      .toThrow("--global cannot be used with --demo");
    expect(() => parseArguments(["--url=http://127.0.0.1:9999", "--global"]))
      .toThrow("--global requires the embedded backend");
    expect(() => parseArguments(["--url=http://127.0.0.1:9999", "--print-logs"]))
      .toThrow("--print-logs requires the embedded backend");
    expect(() => parseArguments(["--demo", "--print-logs"]))
      .toThrow("--print-logs requires the embedded backend");
    expect(parseArguments(["--diagnostic"])?.diagnostic).toBeTrue();
    expect(() => parseArguments([
      "--url=http://127.0.0.1:9999",
      "--diagnostic"
    ])).toThrow("--diagnostic requires the embedded backend");
  });

  test("keeps source defaults launch-relative and resolves explicit overrides", () => {
    const root = path.parse(process.cwd()).root;
    const cwd = path.join(root, "writing", "session");
    const shared = path.join(root, "shared", "1667");
    expect(resolveEmbeddedDataDirectory(null, cwd))
      .toBe(path.join(cwd, "data"));
    expect(resolveEmbeddedDataDirectory("../vault", cwd)).toBe(path.join(cwd, "..", "vault"));
    expect(resolveEmbeddedDataDirectory(shared, cwd)).toBe(shared);
  });

  test("shows a local story folder only for the embedded backend", () => {
    const home = path.join(path.parse(process.cwd()).root, "Users", "chris");
    const data = path.join(home, "server-data");
    expect(storyFolderForBackend(false, data, home)).toBe("");
    expect(storyFolderForBackend(true, data, home))
      .toBe(`~${path.sep}server-data${path.sep}stories`);
  });
});
