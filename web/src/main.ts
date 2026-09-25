/**
 * `1667 web` step 2 (#409): a plain-DOM test page over the full browser
 * `StoryApi`, so the owner can drive a real story from a browser tab before
 * step 3 replaces this file with the Vite + React shell. No framework, no
 * build-time data — everything here comes from `/api/status` and the
 * WebSocket bridge, the same way step 3's real page will have to.
 */
import { connectWebBridge } from "../../client/web-bridge-connect.js";
import type { WebBridgeTransport } from "../../client/web-bridge-transport.js";
import { storyApiFromWorkerTransport } from "../../client/worker-story-api.js";
import type { StoryApi } from "../../client/api.js";
import { WORKER_PROTOCOL_VERSION } from "../../shared/worker-protocol.js";
import type { BridgeRecoveryWarning } from "../../shared/web-bridge-protocol.js";
import type { StoryPayload, StorySummary } from "../../shared/types.js";

const app = document.getElementById("app")!;

function showLocked(): void {
  app.textContent = "";
  const message = document.createElement("p");
  message.textContent = "Open the address that 1667 web printed in the terminal.";
  app.appendChild(message);
}

interface Elements {
  readonly status: HTMLElement;
  readonly recovery: HTMLElement;
  readonly storyList: HTMLElement;
  readonly newTitle: HTMLInputElement;
  readonly createButton: HTMLButtonElement;
  readonly storySection: HTMLElement;
  readonly storyTitle: HTMLElement;
  readonly storyText: HTMLElement;
  readonly instruction: HTMLTextAreaElement;
  readonly continueButton: HTMLButtonElement;
  readonly stopButton: HTMLButtonElement;
  readonly streamPreview: HTMLElement;
}

function buildShell(): Elements {
  app.textContent = "";
  const header = document.createElement("header");
  const heading = document.createElement("h1");
  heading.textContent = "1667 web";
  const status = document.createElement("div");
  status.id = "status";
  const recovery = document.createElement("div");
  recovery.id = "recovery";
  header.append(heading, status, recovery);

  const library = document.createElement("section");
  const libraryHeading = document.createElement("h2");
  libraryHeading.textContent = "Library";
  const newTitle = document.createElement("input");
  newTitle.type = "text";
  newTitle.placeholder = "New story title";
  const createButton = document.createElement("button");
  createButton.type = "button";
  createButton.textContent = "Create";
  const storyList = document.createElement("ul");
  library.append(libraryHeading, newTitle, createButton, storyList);

  const storySection = document.createElement("section");
  storySection.hidden = true;
  const storyTitle = document.createElement("h2");
  const storyText = document.createElement("pre");
  const instruction = document.createElement("textarea");
  instruction.placeholder = "Instruction";
  const continueButton = document.createElement("button");
  continueButton.type = "button";
  continueButton.textContent = "Continue";
  const stopButton = document.createElement("button");
  stopButton.type = "button";
  stopButton.textContent = "Stop";
  stopButton.hidden = true;
  const streamPreview = document.createElement("pre");
  storySection.append(
    storyTitle, storyText, instruction, continueButton, stopButton, streamPreview
  );

  const main = document.createElement("main");
  main.append(library, storySection);
  app.append(header, main);

  return {
    status, recovery, storyList, newTitle, createButton,
    storySection, storyTitle, storyText,
    instruction, continueButton, stopButton, streamPreview
  };
}

function setStatus(
  elements: Elements,
  fields: { project?: string; version?: string; connection?: string; workerProtocolVersion?: number }
): void {
  const current = statusFields.get(elements) ?? {};
  const merged = { ...current, ...fields };
  statusFields.set(elements, merged);
  elements.status.textContent = [
    merged.project === undefined ? null : `Project: ${merged.project}`,
    merged.version === undefined ? null : `Version: ${merged.version}`,
    merged.connection === undefined ? null : `Connection: ${merged.connection}`,
    merged.workerProtocolVersion === undefined
      ? null
      : `Worker protocol: ${merged.workerProtocolVersion}`
  ].filter((line): line is string => line !== null).join(" · ");
}
const statusFields = new WeakMap<Elements, Record<string, string | number>>();

function renderRecoveryWarnings(
  elements: Elements,
  warnings: readonly BridgeRecoveryWarning[],
  onDismiss: (mutationId: string) => void
): void {
  elements.recovery.textContent = "";
  if (warnings.length === 0) return;
  const heading = document.createElement("p");
  heading.textContent = `${warnings.length} recovery warning${warnings.length === 1 ? "" : "s"}:`;
  elements.recovery.appendChild(heading);
  const list = document.createElement("ul");
  for (const warning of warnings) {
    const item = document.createElement("li");
    const text = document.createElement("span");
    text.textContent = `${warning.method} (${warning.resolution}): ${warning.error.message}`;
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.textContent = "Dismiss";
    dismiss.addEventListener("click", () => {
      onDismiss(warning.mutationId);
    });
    item.append(text, dismiss);
    list.appendChild(item);
  }
  elements.recovery.appendChild(list);
}

async function renderLibrary(elements: Elements, api: StoryApi, open: (id: string) => void): Promise<void> {
  const stories = await api.listStories();
  elements.storyList.textContent = "";
  for (const summary of stories) {
    elements.storyList.appendChild(storyListItem(summary, open));
  }
}

function storyListItem(summary: StorySummary, open: (id: string) => void): HTMLLIElement {
  const item = document.createElement("li");
  const link = document.createElement("button");
  link.type = "button";
  link.textContent = `${summary.title} — updated ${summary.updatedAt}`;
  link.addEventListener("click", () => open(summary.id));
  item.appendChild(link);
  return item;
}

function activePathText(payload: StoryPayload): string {
  return payload.path.map((node) => node.text).join("");
}

async function main(): Promise<void> {
  const elements = buildShell();
  setStatus(elements, { connection: "connecting" });

  // `transport` does not exist yet when `connectWebBridge` needs this
  // callback, but `onRecoveryWarnings` only ever fires for a frame after
  // `hello` — never before `transport` below is assigned — so the closure
  // can read it lazily with no special handling.
  const dismissWarning = (mutationId: string): void => {
    void transport.dismissArchivedMutation(mutationId);
  };
  const outcome = await connectWebBridge({
    location,
    storage: sessionStorage,
    clearTokenFragment: () => history.replaceState(null, "", location.pathname + location.search),
    fetch,
    WebSocket,
    onRecoveryWarnings: (warnings) => renderRecoveryWarnings(elements, warnings, dismissWarning),
    onClose: (error) => setStatus(elements, { connection: `closed: ${error.message}` })
  });
  if (outcome.kind === "locked") {
    showLocked();
    return;
  }
  if (outcome.kind === "failed") {
    setStatus(elements, { connection: `failed: ${outcome.error.message}` });
    return;
  }
  const transport: WebBridgeTransport = outcome.transport;
  setStatus(elements, { project: outcome.status.project, version: outcome.status.version });
  // `hello`'s own snapshot arrives on the outcome, not through
  // `onRecoveryWarnings` — that fires only for a later frame.
  renderRecoveryWarnings(elements, outcome.recoveryWarnings, dismissWarning);
  setStatus(elements, { connection: "connected", workerProtocolVersion: WORKER_PROTOCOL_VERSION });

  const api = storyApiFromWorkerTransport(transport);
  let currentStory: StoryPayload | null = null;
  let activeAbort: AbortController | null = null;

  const openStory = async (id: string): Promise<void> => {
    currentStory = await api.loadStory(id);
    elements.storySection.hidden = false;
    elements.storyTitle.textContent = currentStory.title;
    elements.storyText.textContent = activePathText(currentStory);
    elements.streamPreview.textContent = "";
  };

  elements.createButton.addEventListener("click", () => {
    void (async () => {
      const title = elements.newTitle.value.trim();
      const created = await api.createStory(title.length === 0 ? undefined : title);
      elements.newTitle.value = "";
      await renderLibrary(elements, api, (id) => void openStory(id));
      await openStory(created.id);
    })();
  });

  elements.continueButton.addEventListener("click", () => {
    void (async () => {
      if (currentStory === null || activeAbort !== null) return;
      const instruction = elements.instruction.value;
      const lastNodeId = currentStory.path.at(-1)?.id ?? null;
      const controller = new AbortController();
      activeAbort = controller;
      elements.continueButton.hidden = true;
      elements.stopButton.hidden = false;
      elements.streamPreview.textContent = "";
      try {
        await api.continueStory(
          currentStory.id,
          instruction,
          crypto.randomUUID(),
          { parentId: lastNodeId },
          (text) => { elements.streamPreview.textContent += text; },
          controller.signal,
          {
            onStopped: (text) => { elements.streamPreview.textContent += text; }
          }
        );
      } finally {
        activeAbort = null;
        elements.continueButton.hidden = false;
        elements.stopButton.hidden = true;
        elements.instruction.value = "";
        const stoppedText = elements.streamPreview.textContent;
        await openStory(currentStory!.id);
        // Saving a stopped generation's text is step 5 of #409; until then,
        // keep it on screen so Stop visibly did something.
        if (controller.signal.aborted && stoppedText !== "") {
          elements.streamPreview.textContent =
            `Stopped. This text is not saved yet:\n${stoppedText}`;
        }
      }
    })();
  });

  elements.stopButton.addEventListener("click", () => {
    activeAbort?.abort();
  });

  await renderLibrary(elements, api, (id) => void openStory(id));
}

void main();
