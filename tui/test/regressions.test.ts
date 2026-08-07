import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import path from "node:path";
import { lineName } from "../../shared/story-model.js";
import { countWords } from "../../shared/story-text.js";
import { estimateTokens } from "../../shared/tokens.js";
import { InternalErrorReporter } from "../../server/internal-error-reporter.js";
import { PublicRuntimeError } from "../../server/errors.js";
import { errorFromFailureIncident } from "../../server/reported-service-error.js";
import { createDemoController, demoAppSource } from "../src/demo.js";
import { STARTER_OPENING_STORY_ID } from "../../shared/starter-vault.js";
import { handleKey, initialState } from "../src/app.js";
import { createComposer } from "../src/composer-model.js";
import { resolveKey } from "../src/keys.js";
import {
  httpRecoveryWarning,
  parseArguments,
  resolveEmbeddedDataDirectory,
  storyFolderForBackend
} from "../src/main.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { plainLine, visibleWidth } from "../src/screens/story/frame.js";
import { createWrapCache } from "../src/wrap.js";
import { adoptStoryState } from "../src/story-adoption.js";
import type { RuntimeState, StreamView } from "../src/state.js";
import { createStoryViewModel, lastPartRowIndex, rowIndexForNode } from "../src/model.js";
import { sanitizeLegacyServeFailure } from "../src/http-commands.js";

const demo = createDemoController();
const STREAM_STARTED_AT = "2026-07-22T00:00:00.000Z";
const baseState: RuntimeState = {
  ...initialState(demoAppSource(), false),
  payload: demo.payload(),
  focusIndex: 9,
  stream: null
};

function key(name: string, sequence: string, shift = false): KeyEvent {
  return { name, sequence, shift, ctrl: false, meta: false } as KeyEvent;
}

describe("review regressions", () => {
  test("legacy serve sanitizes private failures without a persisted log", async () => {
    const privateFailure = errorFromFailureIncident(
      await InternalErrorReporter.disabled().report(
        new Error("private /machine/path"),
        { service: "legacy-http" }
      )
    );

    const displayed = sanitizeLegacyServeFailure(privateFailure);

    expect(displayed.message).toBe("Internal server error");
    expect(displayed.message).not.toContain("/machine/path");
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

  test("viewport follows focus instead of staying pinned to the leaf", () => {
    const frame = renderStoryScreen(baseState, { width: 80, height: 24 }).lines;
    expect(frame.map(plainLine).join("\n")).toContain("§ ch one summary");
  });

  test("g reaches part 1 and renders its opening words", async () => {
    const state = {
      ...baseState,
      undo: [],
      history: [],
      historyIndex: 0,
      abort: null,
      quitArmed: false
    };
    await handleKey(
      key("g", "g"),
      state,
      demoAppSource(),
      createWrapCache(),
      () => {},
      async () => {},
      () => {}
    );
    const frame = renderStoryScreen(state, { width: 80, height: 24 }).lines;
    const rendered = frame.map(plainLine).join("\n");
    expect(state.focusIndex).toBe(0);
    expect(rendered).toContain("Maren lit the last lamp before the storm found Sorrow Cliff.");
  });

  test("free viewport scroll shows content above the focused part", () => {
    const scrolled = { ...baseState, focusIndex: 12, viewScroll: 0 };
    const frame = renderStoryScreen(scrolled, { width: 80, height: 24 }).lines;
    expect(frame.map(plainLine).join("\n")).toContain("Maren lit the last lamp");
  });

  test("free viewport scroll keeps NAV toasts visible without moving the page", () => {
    const scrolled = { ...baseState, focusIndex: 12, viewScroll: 0, toast: "facts rail · off" };
    const frame = renderStoryScreen(scrolled, { width: 80, height: 24 }).lines;
    const rendered = frame.map(plainLine).join("\n");

    expect(rendered).toContain("Maren lit the last lamp");
    expect(rendered).toContain("›  facts rail · off");
    expect(rendered.match(/facts rail · off/g)).toHaveLength(1);
  });

  test("NAV toasts take the footer line while the viewport follows focus", () => {
    // A toast used to print under the focused part whenever the viewport was
    // following it: a message about the app, set inside the manuscript, two
    // lines of reflowed prose to fit, landing somewhere new each time focus
    // moved. It belongs on one line, and always the same one.
    const following = {
      ...baseState,
      focusIndex: 12,
      viewScroll: null,
      viewScrollDelta: 0,
      toast: "facts rail · off"
    };
    const lines = renderStoryScreen(following, { width: 80, height: 24 }).lines.map(plainLine);
    const rendered = lines.join("\n");

    expect(rendered).toContain("›  facts rail · off");
    expect(rendered.match(/facts rail · off/g)).toHaveLength(1);
    // Second from the bottom: the footer line, with the status bar under it.
    expect(lines.findIndex((line) => line.includes("facts rail · off"))).toBe(lines.length - 2);
  });

  test("pending free-scroll intent places NAV toasts in the stable footer", () => {
    const scrolled = {
      ...baseState,
      focusIndex: 12,
      viewScroll: null,
      viewScrollDelta: -8,
      toast: "facts rail · off"
    };
    const rendered = renderStoryScreen(scrolled, { width: 80, height: 24 }).lines.map(plainLine).join("\n");

    expect(rendered).toContain("›  facts rail · off");
    expect(rendered.match(/facts rail · off/g)).toHaveLength(1);
  });

  test("transient fullscreen surfaces preserve pending story scroll intent", () => {
    const leaf = baseState.payload.path.at(-1)!;
    const map = renderStoryScreen({
      ...baseState,
      mode: "MAP",
      viewScrollDelta: 6,
      map: {
        view: "path",
        pathCursorId: leaf.id,
        treeCursorId: leaf.id,
        rowIds: [],
        pathShowAllTakes: true,
        showSketches: false,
        openedColdFolds: new Set(),
        massSort: "size"
      }
    }, { width: 80, height: 24 });
    const composer = renderStoryScreen({
      ...baseState,
      mode: "COMPOSE",
      viewScrollDelta: 6,
      composer: { ...createComposer(), fullscreen: true }
    }, { width: 80, height: 24 });
    const editor = renderStoryScreen({
      ...baseState,
      mode: "EDITOR",
      viewScrollDelta: 6,
      editor: {
        kind: "document",
        target: {
          kind: "part",
          node: leaf,
          pathIndex: baseState.payload.path.length - 1,
          savedNode: null
        },
        composer: createComposer(leaf.text),
        initial: leaf.text,
        title: "edit part",
        placeholder: "",
        returnMode: "NAV",
        conflict: null
      }
    }, { width: 80, height: 24 });

    expect([
      map.derived.viewScrollDelta,
      composer.derived.viewScrollDelta,
      editor.derived.viewScrollDelta
    ]).toEqual([6, 6, 6]);
  });

  test("free viewport scroll keeps tag prompt errors visible", () => {
    const scrolled = {
      ...baseState,
      focusIndex: 12,
      viewScroll: 0,
      mode: "TAG" as const,
      tag: {
        nodeId: baseState.payload.path.at(-1)!.id,
        name: "",
        statusIndex: 0,
        choosingStatus: false,
        existing: false,
        returnMode: "NAV" as const
      },
      toast: "tag name required"
    };
    const rendered = renderStoryScreen(scrolled, { width: 80, height: 24 }).lines.map(plainLine).join("\n");

    expect(rendered).toContain("Maren lit the last lamp");
    expect(rendered).toContain("tag name required");
    expect(rendered.match(/tag name required/g)).toHaveLength(1);
  });

  test("MAP tag prompt names the unset choice at both target sizes", async () => {
    const leafId = baseState.payload.path.at(-1)!.id;
    const state: RuntimeState = {
      ...baseState,
      mode: "TAG",
      map: {
        view: "path",
        pathCursorId: leafId,
        pathShowAllTakes: true,
        treeCursorId: leafId,
        rowIds: [],
        showSketches: false,
        openedColdFolds: new Set(),
        massSort: "size"
      },
      tag: {
        nodeId: leafId,
        name: "storm line",
        statusIndex: 0,
        choosingStatus: true,
        existing: false,
        returnMode: "MAP"
      }
    };

    for (const [width, height] of [[80, 24], [120, 36]] as const) {
      const rendered = renderStoryScreen(state, { width, height }).lines.map(plainLine).join("\n");
      expect(rendered).toContain("‹ none ›");
    }

    await handleKey(
      key("right", "\u001b[C"), state, demoAppSource(), createWrapCache(),
      () => {}, async () => {}, () => {}
    );
    expect(state.tag?.statusIndex).toBe(1);
    for (const [width, height] of [[80, 24], [120, 36]] as const) {
      const rendered = renderStoryScreen(state, { width, height }).lines.map(plainLine).join("\n");
      expect(rendered).toContain("‹ Canon ›");
    }
  });

  test("long tag names keep their tail and cursor at both origins and target sizes", () => {
    const leafId = baseState.payload.path.at(-1)!.id;
    const name = `forgotten-${"x".repeat(100)}-visible-tail`;
    const tag = {
      nodeId: leafId,
      name,
      statusIndex: 0,
      choosingStatus: false,
      existing: false
    };
    const map = {
      view: "path" as const,
      pathCursorId: leafId,
      pathShowAllTakes: true,
      treeCursorId: leafId,
      rowIds: [],
      showSketches: false,
      openedColdFolds: new Set<string>(),
      massSort: "size" as const
    };

    for (const [width, height] of [[80, 24], [120, 36]] as const) {
      const inline = renderStoryScreen({
        ...baseState,
        mode: "TAG",
        tag: { ...tag, returnMode: "NAV" }
      }, { width, height });
      const inlineName = inline.lines.find((line) => plainLine(line).includes("› tag"))!;
      expect(plainLine(inlineName)).toContain("…");
      expect(plainLine(inlineName)).toContain("-visible-tail");
      expect(inlineName.some((part) => part.text === "█" && part.role === "focus / accent")).toBeTrue();

      const mapped = renderStoryScreen({
        ...baseState,
        mode: "TAG",
        map,
        tag: { ...tag, returnMode: "MAP" }
      }, { width, height });
      const mapName = mapped.lines.find((line) => plainLine(line).includes("Name"))!;
      expect(plainLine(mapName)).toContain("…");
      expect(plainLine(mapName)).toContain("-visible-tail");
      expect(mapName.some((part) => part.text === " " && part.background === "focus / accent")).toBeTrue();
    }
  });

  test("backend work stays visible without replacing the honest request meter", () => {
    const working = {
      ...baseState,
      backendTask: {
        id: 1,
        kind: "action" as const,
        label: "stalled mutation",
        storyId: baseState.payload.id
      }
    };
    const wide = plainLine(renderStoryScreen(working, { width: 120, height: 36 }).lines.at(-1)!);
    expect(wide).toContain("working · stalled mutation");

    const compact = plainLine(renderStoryScreen(working, { width: 80, height: 24 }).lines.at(-1)!);
    expect(compact).toContain("working · stalled mutation");
    expect(compact).toContain("next ");
    expect(compact.slice(compact.indexOf("next"))).not.toContain("…");
  });

  test("stream growth crossing wrap boundaries invalidates viewport measurement", () => {
    const cache = createWrapCache<"human" | "streaming">();
    const leaf = baseState.payload.path.at(-1)!;
    renderStoryScreen(baseState, { width: 80, height: 24, wrapCache: cache });
    const focusIndex = rowIndexForNode(createStoryViewModel(baseState.payload), leaf.id);
    const frame = renderStoryScreen({
      ...baseState,
      focusIndex,
      stream: {
        targetId: leaf.id,
        parentId: leaf.parentId,
        append: true,
        startedAt: STREAM_STARTED_AT,
        instruction: "",
        text: `${" streamword".repeat(200)} finalstreamtoken`
      }
    }, { width: 80, height: 24, wrapCache: cache });

    expect(frame.lines.map(plainLine).join("\n")).toContain("finalstreamtoken");
  });

  test("stream growth does not pull the viewport away after live navigation", async () => {
    const leaf = baseState.payload.path.at(-1)!;
    const view = createStoryViewModel(baseState.payload);
    const state = {
      ...baseState,
      focusIndex: rowIndexForNode(view, leaf.id),
      stream: {
        targetId: leaf.id,
        parentId: leaf.parentId,
        append: true,
        startedAt: STREAM_STARTED_AT,
        instruction: "",
        text: `${" streamword".repeat(200)} finalstreamtoken`
      },
      undo: [],
      history: [],
      historyIndex: 0,
      abort: null,
      quitArmed: false
    } as RuntimeState;

    await handleKey(
      key("up", "\u001b[A"),
      state,
      demoAppSource(),
      createWrapCache(),
      () => {},
      async () => {},
      () => {}
    );

    const frame = renderStoryScreen(state, { width: 80, height: 24 });
    const rendered = frame.lines.map(plainLine).join("\n");
    expect(state.focusIndex).toBe(rowIndexForNode(createStoryViewModel(state.payload), "p12"));
    expect(rendered).toContain("He did not move toward the stairs");
    expect(rendered).not.toContain("finalstreamtoken");
  });

  test("pending retake status uses the canonical dense-sibling identity", () => {
    const stream: StreamView = {
      targetId: "pending-retake",
      parentId: "p11",
      append: false,
      startedAt: STREAM_STARTED_AT,
      instruction: "retake the confrontation",
      text: "A newly claimed line",
      partNumber: 12
    };
    const view = createStoryViewModel(baseState.payload, stream);
    const state: RuntimeState = {
      ...baseState,
      stream,
      focusIndex: rowIndexForNode(view, stream.targetId)
    };

    const frame = renderStoryScreen(state, { width: 120, height: 36 });

    expect(plainLine(frame.lines.at(-1)!)).toContain("part 12/12 · take 6/6");
    expect(frame.lines.map(plainLine).join("\n")).toContain("A newly claimed line");
  });

  test("story and MAP share the projected stream line identity", () => {
    const leaf = baseState.payload.path.at(-1)!;
    const cases = [
      {
        targetId: "identity-direct",
        parentId: "p7",
        instruction: "turn toward the flooded road",
        text: "Fresh direct line",
        partNumber: 8,
        tagged: false
      },
      {
        targetId: "identity-retake",
        parentId: "p11",
        instruction: "make the compass choose again",
        text: "Fresh retake line",
        partNumber: 12,
        tagged: false
      },
      {
        targetId: "identity-tagged-child",
        parentId: leaf.id,
        instruction: "continue the named line",
        text: "Fresh named continuation",
        tagged: true
      }
    ] as const;

    for (const item of cases) {
      const stream: StreamView = {
        targetId: item.targetId,
        parentId: item.parentId,
        append: false,
        startedAt: STREAM_STARTED_AT,
        instruction: item.instruction,
        text: item.text,
        ...("partNumber" in item ? { partNumber: item.partNumber } : {})
      };
      const view = createStoryViewModel(baseState.payload, stream);
      const expectedIdentity = lineName(view.visiblePayload, stream.targetId);
      const state: RuntimeState = {
        ...baseState,
        stream,
        focusIndex: rowIndexForNode(view, stream.targetId)
      };
      const storyStatus = plainLine(renderStoryScreen(state, { width: 120, height: 36 }).lines.at(-1)!);
      const mapped: RuntimeState = {
        ...state,
        mode: "MAP",
        map: {
          view: "path",
          pathCursorId: stream.targetId,
          pathShowAllTakes: true,
          treeCursorId: stream.targetId,
          rowIds: [],
          showSketches: false,
          openedColdFolds: new Set(),
          massSort: "size"
        }
      };
      const mapStatus = plainLine(renderStoryScreen(mapped, { width: 120, height: 36 }).lines.at(-1)!);

      expect(view.visiblePayload.path.at(-1)?.id).toBe(stream.targetId);
      // A tag is the only line identity these bars print. Both must read it
      // from the projected leaf, and both must stay silent about an untagged
      // line rather than naming the one the stream replaced.
      expect(storyStatus.includes(expectedIdentity)).toBe(item.tagged);
      expect(mapStatus.includes(expectedIdentity)).toBe(item.tagged);
      expect(storyStatus.includes("canon-storm")).toBe(item.tagged);
      expect(mapStatus.includes("canon-storm")).toBe(item.tagged);
    }
  });

  test("renders appended stream bytes once with canonical totals and fresh styling", () => {
    const leaf = baseState.payload.path.at(-1)!;
    const marker = "APPEND_ONCE_MARKER";
    const stream: StreamView = {
      targetId: leaf.id,
      parentId: leaf.parentId,
      append: true,
      startedAt: STREAM_STARTED_AT,
      instruction: "continue",
      text: ` ${marker} arrives now`
    };
    const view = createStoryViewModel(baseState.payload, stream);
    const state: RuntimeState = {
      ...baseState,
      stream,
      focusIndex: rowIndexForNode(view, leaf.id)
    };

    const frame = renderStoryScreen(state, { width: 120, height: 36 });
    const rendered = frame.lines.map(plainLine).join("\n");
    const markerSegments = frame.lines.flat().filter((segment) => segment.text.includes(marker));

    expect(rendered.match(new RegExp(marker, "g"))).toHaveLength(1);
    expect(markerSegments).toHaveLength(1);
    expect(markerSegments[0]?.role).toBe("streaming");
    expect(plainLine(frame.lines.at(-1)!)).toContain(`${view.totalWords.toLocaleString("en-US")} words`);
  });

  test("keeps an append style seam outside a combined grapheme", () => {
    const payload = structuredClone(baseState.payload);
    const leaf = payload.path.at(-1)!;
    const settledText = `${"a".repeat(70)}👩`;
    leaf.text = settledText;
    leaf.attribution = {
      source: "human",
      ranges: [{ start: 70, end: settledText.length }]
    };
    const stub = payload.nodes.find((node) => node.id === leaf.id)!;
    stub.preview = settledText;
    stub.words = countWords(settledText);
    stub.tokens = estimateTokens(leaf.instruction) + estimateTokens(settledText);
    const stream: StreamView = {
      targetId: leaf.id,
      parentId: leaf.parentId,
      append: true,
      startedAt: STREAM_STARTED_AT,
      instruction: "continue",
      text: "\u200d🔬"
    };
    const view = createStoryViewModel(payload, stream);
    const state: RuntimeState = {
      ...baseState,
      payload,
      stream,
      showInstructions: false,
      focusIndex: rowIndexForNode(view, leaf.id)
    };

    for (const [width, height] of [[80, 24], [136, 36]] as const) {
      const frame = renderStoryScreen(state, { width, height, wrapCache: createWrapCache() });
      const line = frame.lines.find((candidate) => plainLine(candidate).includes("👩‍🔬"));
      expect(line).toBeDefined();
      const rendered = plainLine(line!);
      const streaming = line!.filter((segment) => segment.role === "streaming")
        .map((segment) => segment.text).join("");

      expect(rendered).toContain("👩‍🔬▏");
      expect(rendered.split("👩‍🔬")).toHaveLength(2);
      expect(streaming).toContain("👩‍🔬");
      expect(line!.some((segment) => segment.role === "human edit" && segment.text.includes("👩")))
        .toBeFalse();
      expect(line!.reduce((sum, segment) => sum + visibleWidth(segment.text), 0)).toBe(width);
      expect(visibleWidth(rendered)).toBe(width);
    }
  });

  test("renders the stop affordance before a pending take has substantive text", () => {
    const leaf = baseState.payload.path.at(-1)!;
    const stream: StreamView = {
      targetId: "pending-empty-take",
      parentId: leaf.id,
      append: false,
      startedAt: STREAM_STARTED_AT,
      instruction: "continue",
      text: " \n\t "
    };
    const view = createStoryViewModel(baseState.payload, stream);
    const state: RuntimeState = {
      ...baseState,
      stream,
      focusIndex: rowIndexForNode(view, stream.targetId)
    };

    const rendered = renderStoryScreen(state, { width: 120, height: 36 }).lines.map(plainLine).join("\n");

    expect(view.activeLeafId).toBe(stream.targetId);
    expect(rendered).toContain("writing");
    expect(rendered).toContain("esc stops");
    expect(rendered).toContain("▏");
  });

  test("resolves shifted G terminal variants to the leaf", () => {
    expect(resolveKey(key("g", "G", true), "NAV").action).toBe("leaf");
    expect(resolveKey(key("G", "G"), "NAV").action).toBe("leaf");
    expect(resolveKey(key("g", "G"), "NAV").action).toBe("leaf");
    expect(resolveKey(key("g", "g"), "NAV").action).toBe("top");
  });

  test("multiline compose input stays inside its fixed viewport", () => {
    const frame = renderStoryScreen({
      ...baseState,
      mode: "COMPOSE",
      composer: createComposer(`first line\n${"x".repeat(100)}`)
    }, { width: 80, height: 24 }).lines;
    expect(frame).toHaveLength(24);
    expect(frame.every((line) => !plainLine(line).includes("\n"))).toBeTrue();
    expect(plainLine(frame.at(-1)!)).toContain("COMPOSE");
    expect(plainLine(frame.at(-2)!)).toContain("⇧enter newline");
    expect(plainLine(frame.at(-3)!)).toContain("…");
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

  test("story adoption clears interaction state frozen against the old payload", () => {
    const retakeComposer = createComposer("stale retake prompt");
    const state = {
      ...baseState,
      mode: "COMPOSE",
      composer: retakeComposer,
      undo: [],
      history: ["stale instruction"],
      historyIndex: 1,
      historyDraft: "stale draft",
      retakePrompt: {
        nodeId: "p12",
        intent: { kind: "retake" as const },
        composer: retakeComposer,
        composerScrollTop: 0,
        returnState: {
          composer: createComposer("older Direct draft"),
          composerScrollTop: 2,
          historyIndex: 1,
          historyDraft: "older scratch",
          historyWasLive: true
        }
      },
      abort: null,
      quitArmed: true,
      map: {
        view: "tree",
        pathCursorId: "old-map-node",
        pathShowAllTakes: true,
        treeCursorId: "old-map-node",
        rowIds: ["old-map-node"],
        showSketches: false,
        openedColdFolds: new Set(["old-fold"]),
        massSort: "size"
      },
      library: { stories: [], cursor: 0, query: "old", prompt: null },
      commands: {
        query: "old", cursor: 0, selectedId: null, view: "commands" as const,
        returnMode: "NAV" as const
      }
    } as RuntimeState;
    const replacement = { ...demo.payload(), id: "replacement-story" };

    adoptStoryState(state, replacement, createWrapCache());

    expect(state.payload.id).toBe("replacement-story");
    expect(state.mode).toBe("NAV");
    expect(state.composer).toEqual(createComposer());
    expect(state.retakePrompt).toBe(null);
    expect(state.history).toEqual([]);
    expect(state.historyDraft).toBe(null);
    expect(state.library).toBe(null);
    expect(state.commands).toBe(null);
    expect(state.map).toBe(null);
    expect(state.expandedPromptIds).toEqual(new Set());
    expect(state.quitArmed).toBeFalse();
  });
});

describe("where a story opens", () => {
  const asStory = (id: string, readingPartId?: string) => {
    const source = demoAppSource();
    return {
      ...source,
      demo: false,
      payload: { ...source.payload, id },
      readingPositions: readingPartId === undefined
        ? {}
        : { [id]: readingPartId }
    };
  };

  test("an unread tour opens at its first part, not its last", () => {
    // No local reading position: the tour id alone sends the reader to the start.
    const source = asStory(STARTER_OPENING_STORY_ID);
    expect(initialState(source, false).focusIndex).toBe(0);
  });

  test("a stored reading position reopens the part the reader left", () => {
    const source = demoAppSource();
    const mid = source.payload.path[Math.floor(source.payload.path.length / 2)]!;
    const withPosition = asStory(source.payload.id, mid.id);
    const view = createStoryViewModel(withPosition.payload);
    expect(initialState(withPosition, false).focusIndex)
      .toBe(rowIndexForNode(view, mid.id));
  });

  test("a pruned reading position falls back without special tour counting", () => {
    const source = asStory(STARTER_OPENING_STORY_ID, "missing-part-id");
    expect(initialState(source, false).focusIndex).toBe(0);
    const other = asStory("2f5d8c31-7a44-4e19-b6d2-8c3f1e50a97b", "missing-part-id");
    expect(initialState(other, false).focusIndex)
      .toBe(lastPartRowIndex(createStoryViewModel(other.payload)));
  });

  test("every other story without a position opens at the end of its line", () => {
    const other = asStory("2f5d8c31-7a44-4e19-b6d2-8c3f1e50a97b");
    expect(initialState(other, false).focusIndex)
      .toBe(lastPartRowIndex(createStoryViewModel(other.payload)));
  });
});
