import type { StoryApi } from "../client/api.js";
import { resolveAuthorBrief } from "../shared/author-brief.js";
import { resolveAuthorsNoteDepth } from "../shared/authors-note.js";
import { continuationPlan, supportsAssistantPrefill } from "../shared/continuation-plan.js";
import { previewFixedContextAdmission } from "../shared/fact-admission.js";
import { activeBudgetedFacts } from "../shared/fact-selection.js";
import { estimateImageTokens, resolveImageInputCapability } from "../shared/image-input-capabilities.js";
import { renderPromptPlan, type ChatMessage } from "../shared/prompt-plan.js";
import { estimateTokens } from "../shared/tokens.js";
import { isChapterSummaryNodeStub, type StoryPayload } from "../shared/types.js";
import { resolveContinueRequestDirection } from "../shared/writing-prompt-runtime.js";
import { effectiveFocusedPartId, type RendererState, type StreamMode } from "./renderer-model.js";

export interface RendererContext {
  readonly messages: readonly ChatMessage[];
  readonly promptTokens: number;
  readonly grade: "exact" | "near-exact" | "estimate";
  readonly contextWindow: number | null;
  readonly responseTokens: number;
  readonly imageTokens: number;
  readonly imagesUnknown: boolean;
  readonly keptFacts: number;
  readonly droppedFacts: number;
}

type ContextInput = Pick<RendererState,
  "story" | "settings" | "composerMode" | "drafts" | "draftImages" | "stream" | "focusedPartId">;

/** Match the Host's effective append target before building a continuation.
 * `fromSeam` mirrors the TUI's `continuationIntent`: continuing from a part
 * other than the leaf is always a new branch under that part, never an
 * append onto the leaf's own text. */
export function shouldAppendRendererContinuation(
  story: Pick<StoryPayload, "path" | "chapterBreaks">,
  mode: StreamMode,
  instruction: string,
  hasDraftImages: boolean,
  fromSeam: boolean
): boolean {
  const leaf = story.path.at(-1);
  return mode === "continue"
    && !fromSeam
    && leaf !== undefined
    && instruction.trim().length === 0
    && leaf.role !== "summary"
    && !hasDraftImages
    && !story.chapterBreaks.some((chapterBreak) => chapterBreak.parentPartId === leaf.id);
}

/** Use the same prompt assembly and Fact admission as the real request. */
export function projectRendererContext(input: ContextInput): RendererContext | null {
  const { story, settings } = input;
  if (story === null || settings === null) return null;
  const active = settings.effectiveProse;
  const requestedInstruction = (input.drafts.composer ?? "").trim();
  const leaf = story.path.at(-1);
  const focusedId = effectiveFocusedPartId(input, story);
  const fromSeam = leaf !== undefined && focusedId !== null && focusedId !== leaf.id;
  const append = shouldAppendRendererContinuation(
    // "write" never streams, so it never appends; treat it like "direct" for
    // this projection, which only distinguishes "continue" from everything else.
    story, input.composerMode === "write" ? "direct" : input.composerMode, requestedInstruction, input.draftImages.length > 0, fromSeam
  );
  const instruction = resolveContinueRequestDirection(
    requestedInstruction, settings.activeWriting, append
  );
  const nodes = story.nodes.filter(isChapterSummaryNodeStub);
  // At a seam, the context (and the request itself) ends at the focused
  // part, matching `continuationIntent`'s `contextParts`.
  const focusedIndex = fromSeam ? story.path.findIndex((node) => node.id === focusedId) : -1;
  const contextParts = fromSeam && focusedIndex >= 0 ? story.path.slice(0, focusedIndex + 1) : story.path;
  const selected = activeBudgetedFacts(story, {
    contextParts, chapterBreaks: story.chapterBreaks, nodes, instruction
  });
  const images = input.draftImages.map((image) => image.attachment);
  const build = (facts: string | null) => continuationPlan(
    resolveAuthorBrief(story.authorBrief, active.systemPrompt), facts,
    story.authorsNote === undefined ? null
      : { text: story.authorsNote, depth: resolveAuthorsNoteDepth(story.authorsNoteDepth) },
    contextParts, instruction, append, supportsAssistantPrefill(active), null,
    story.chapterBreaks, nodes, images,
    settings.effectiveProseContinuationPromptLayout ?? "compatibility"
  );
  // Images are not present in the text-only token-count response. Add their
  // known estimate separately and never label that combined total exact.
  const initial = build(null);
  let imageTokens = 0;
  let imagesUnknown = false;
  for (const turn of initial.prompt.turns) {
    for (const block of turn.blocks) {
      if (block.kind !== "image") continue;
      const capability = ["anthropic-messages", "openai-chat-completions"] as const;
      const resolved = capability.map((protocol) => resolveImageInputCapability({
        protocol, remoteModelId: active.model
      })).find((result) => result.support === "supported");
      if (resolved?.support === "supported") {
        imageTokens += estimateImageTokens(resolved.strategy, block.image.width, block.image.height);
      } else imagesUnknown = true;
    }
  }
  const { plan, admission } = previewFixedContextAdmission(
    active, selected.kept, story.authorsNote ?? null, build, imageTokens
  );
  const messages = renderPromptPlan(plan.prompt);
  return {
    messages,
    promptTokens: messages.reduce((sum, message) => sum + estimateTokens(message.content) + 4, 0) + imageTokens,
    grade: "estimate", contextWindow: active.contextWindow, responseTokens: active.maxTokens,
    imageTokens, imagesUnknown,
    keptFacts: admission.facts.length,
    droppedFacts: selected.dropped.length + admission.dropped.length
  };
}

/** Count after typing stops; a late response cannot describe a newer draft. */
export class RendererContextController {
  private previous: readonly unknown[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private controller: AbortController | null = null;
  private sequence = 0;

  constructor(private readonly publish: (context: RendererContext | null) => void) {}

  notify(input: ContextInput, api: StoryApi | null): void {
    const identity = [input.story, input.settings, input.composerMode,
      input.drafts.composer ?? "", input.draftImages, input.stream !== null, input.focusedPartId, api];
    if (identity.every((value, index) => value === this.previous[index])) return;
    this.previous = identity;
    this.cancel();
    const sequence = this.sequence;
    // Assemble the full story only after typing stops. A draft update must not
    // rebuild a novel-length prompt or replace the focused field on each key.
    this.timer = setTimeout(() => { void this.refresh(input, api, sequence); }, 250);
  }

  private async refresh(input: ContextInput, api: StoryApi | null, sequence: number): Promise<void> {
    if (sequence !== this.sequence) return;
    let context: RendererContext | null;
    try { context = projectRendererContext(input); }
    catch { context = null; }
    this.publish(context);
    if (context === null || api === null || input.stream !== null) return;
    const projection = context;
    if (projection.messages.reduce((sum, message) => sum + message.content.length, 0) > 400_000) return;
    const count = async (): Promise<void> => {
      if (sequence !== this.sequence) return;
      this.controller = new AbortController();
      try {
        const result = await api.countPromptTokens(projection.messages, this.controller.signal);
        if (sequence !== this.sequence || result.kind !== "counted") return;
        this.publish({
          ...projection,
          promptTokens: result.total + projection.imageTokens,
          grade: projection.imageTokens > 0 || projection.imagesUnknown ? "estimate" : result.grade
        });
        if (result.source !== "bundled-openai") {
          this.timer = setTimeout(() => {
            if (sequence !== this.sequence) return;
            this.publish(projection);
            void count();
          }, 30_000);
        }
      } catch {
        // The estimate remains usable when token counting is unavailable.
      }
    };
    await count();
  }

  dispose(): void {
    this.previous = [];
    this.cancel();
  }

  private cancel(): void {
    this.sequence += 1;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.controller?.abort();
    this.controller = null;
  }
}

export function renderRequestContext(context: RendererContext | null): HTMLElement {
  const card = element("section", "rail-card request-context-card");
  card.append(element("div", "rail-card-heading", "Next request"));
  if (context === null) {
    card.append(element("p", "meter-caption", "Loading the saved story and active settings…"));
    return card;
  }
  const prefix = context.grade === "exact" ? "" : "~";
  const total = context.promptTokens + context.responseTokens;
  const over = context.contextWindow !== null && total > context.contextWindow;
  card.append(
    metric("Prompt", `${prefix}${context.promptTokens.toLocaleString()} tokens`),
    metric("Response reserve", `${context.responseTokens.toLocaleString()} tokens`),
    metric("Facts", `${context.keptFacts} included · ${context.droppedFacts} dropped`)
  );
  if (context.imageTokens > 0 || context.imagesUnknown) {
    card.append(metric("Image estimate", context.imagesUnknown ? "unknown"
      : `~${context.imageTokens.toLocaleString()} tokens`));
  }
  if (context.contextWindow === null) {
    card.append(element("p", "meter-caption", "Context window unknown. Set it in Settings."));
  } else if (context.imagesUnknown) {
    card.append(element("p", "meter-caption", "Image token cost unknown. The total is incomplete."));
  } else {
    const meter = element("div", `context-meter${over ? " over" : ""}`);
    const fill = element("span", "context-meter-fill");
    fill.style.width = `${Math.min(100, 100 * total / context.contextWindow)}%`;
    meter.append(fill);
    meter.setAttribute("role", "meter");
    meter.setAttribute("aria-label", "Prompt and response reserve");
    meter.setAttribute("aria-valuenow", String(total));
    meter.setAttribute("aria-valuemax", String(context.contextWindow));
    card.append(meter, element("p", "meter-caption", over
      ? `${(total - context.contextWindow).toLocaleString()} tokens over the context window`
      : `${(context.contextWindow - total).toLocaleString()} tokens free`));
  }
  const details = element("details", "request-details") as HTMLDetailsElement;
  details.dataset.preserve = "next-request";
  details.tabIndex = 0;
  details.append(element("summary", "", "View next request"),
    element("p", "meter-caption", "Saved story, active settings, and the current direction. Unsaved story edits are excluded."));
  let rendered = false;
  details.addEventListener("toggle", () => {
    if (!details.open || rendered) return;
    rendered = true;
    for (const message of context.messages) {
      const row = element("section", "request-message");
      row.append(element("strong", "", message.role), element("pre", "request-message-text", message.content));
      details.append(row);
    }
  });
  card.append(details);
  return card;
}

function element(tag: string, className: string, text?: string): HTMLElement {
  const value = document.createElement(tag);
  value.className = className;
  if (text !== undefined) value.textContent = text;
  return value;
}

function metric(label: string, value: string): HTMLElement {
  const row = element("div", "metric-row");
  row.append(element("span", "", label), element("span", "", value));
  return row;
}
