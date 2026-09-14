import type { StoryPathNode } from "../shared/types.js";
import type { RendererCommandContext } from "./renderer-command-context.js";
import { makeMutationId, type StreamMode, type TextSelection } from "./renderer-model.js";

export async function retakeLine(ctx: RendererCommandContext, node: StoryPathNode): Promise<void> {
  const instruction = await ctx.textDialog("Retake direction", node.instruction ?? "", "Write a new take from this part.");
  if (instruction === null) return;
  if (ctx.continueStory === undefined) {
    ctx.setState({ status: "Retake unavailable", error: "This desktop surface cannot start a retake." });
    return;
  }
  await ctx.continueStory("retake", instruction, { parentId: node.parentId ?? null });
}

export async function rewriteLine(ctx: RendererCommandContext, node: StoryPathNode, selection?: TextSelection): Promise<void> {
  const target = selection === undefined
    ? { start: 0, end: node.text.length, expected: node.text }
    : selection;
  if (target.start < 0 || target.end <= target.start || target.end > node.text.length
    || node.text.slice(target.start, target.end) !== target.expected) {
    ctx.setState({ status: "Selection changed", error: "Highlight the saved story text again." });
    return;
  }
  const instruction = await ctx.textDialog(
    selection === undefined ? "Rewrite direction" : "Rewrite selection",
    "",
    selection === undefined ? "Rewrite this part in place from the direction." : `Rewrite “${target.expected.slice(0, 120)}${target.expected.length > 120 ? "…" : ""}” in place.`
  );
  if (instruction === null) return;
  await rewrite(ctx, node, instruction, "in-place", "rewrite", target);
}

export async function summarizeLine(ctx: RendererCommandContext): Promise<void> {
  const story = ctx.story();
  const leaf = story.path.at(-1);
  if (leaf === undefined) return;
  await stream(ctx, "summary", "Summarizing the current line", async (controller, streamId) => {
    const result = await ctx.api().createSummaryTake(
      story.id,
      { nodeId: leaf.id },
      (text) => appendStream(ctx, { text: appendStreamText(ctx, text) }, streamId),
      controller.signal,
      { onReasoning: (delta) => appendStream(ctx, { reasoning: appendStreamText(ctx, delta.text, "reasoning") }, streamId) }
    );
    if (result === null) return false;
    if (ctx.state().stream?.id !== streamId || ctx.state().story?.id !== story.id) return false;
    // Adopt the latest visible payload before the follow-up switch so the next
    // mutation carries this window's version.
    const payload = await ctx.api().loadStory(story.id);
    if (ctx.state().stream?.id !== streamId || ctx.state().story?.id !== story.id) return false;
    await ctx.replaceStory(payload);
    const switched = await ctx.api().switchLine(story.id, result.nodeId, { stopAtNode: true });
    if (ctx.state().stream?.id !== streamId || ctx.state().story?.id !== story.id) return false;
    await ctx.replaceStory(switched);
    return true;
  }, { parentId: leaf.id });
}

async function rewrite(
  ctx: RendererCommandContext,
  node: StoryPathNode,
  instruction: string,
  destination: "in-place" | "take",
  kind: Extract<StreamMode, "retake" | "rewrite">,
  selection: TextSelection = { start: 0, end: node.text.length, expected: node.text }
): Promise<void> {
  const story = ctx.story();
  const attemptId = makeMutationId("rewrite-attempt");
  await stream(ctx, kind, kind === "retake" ? "Retaking this part" : "Rewriting this part", async (controller, streamId) => {
    const result = await ctx.api().rewriteNode(
      story.id,
      node.id,
      {
        start: selection.start,
        end: selection.end,
        instruction,
        expected: selection.expected,
        attemptId,
        destination
      },
      (text) => appendStream(ctx, { text: appendStreamText(ctx, text) }, streamId),
      controller.signal,
      undefined,
      { onStopped: (text) => appendStream(ctx, { stoppedText: appendStreamText(ctx, text, "stoppedText") }, streamId), onReasoning: (delta) => appendStream(ctx, { reasoning: appendStreamText(ctx, delta.text, "reasoning") }, streamId), onReasoningStopped: (text) => appendStream(ctx, { reasoning: appendStreamText(ctx, text, "reasoning") }, streamId) }
    );
    if (result === null) return false;
    if (ctx.state().stream?.id !== streamId || ctx.state().story?.id !== story.id) return false;
    const payload = await ctx.api().loadStory(story.id);
    if (ctx.state().stream?.id !== streamId || ctx.state().story?.id !== story.id) return false;
    await ctx.replaceStory(payload);
    return true;
  }, { targetNodeId: node.id, attemptId });
}

async function stream(
  ctx: RendererCommandContext,
  mode: StreamMode,
  status: string,
  work: (controller: AbortController, streamId: string) => Promise<boolean>,
  metadata: { readonly targetNodeId?: string; readonly parentId?: string | null; readonly attemptId?: string } = {}
): Promise<void> {
  const current = ctx.state().stream;
  if (current !== null) return;
  const stopped = ctx.state().stoppedGeneration;
  if (stopped !== null) {
    const summary = stopped.mode === "summary";
    ctx.setState({
      status: summary ? "Discard interrupted summary first" : "Review interrupted text first",
      error: summary
        ? "Discard the interrupted summary before starting another generation."
        : "Save or discard the interrupted generation before starting another one."
    });
    return;
  }
  const controller = new AbortController();
  const streamId = makeMutationId("stream");
  const generationId = makeMutationId("generation");
  ctx.setState({ stream: { id: streamId, mode, instruction: status, text: "", reasoning: "", stoppedText: "", controller, generationId, ...metadata }, status, error: null });
  try {
    const saved = await work(controller, streamId);
    if (!saved) {
      const current = ctx.state().stream;
      if (current !== null) {
        const partial = current.text + current.stoppedText;
        const settled = await settlePartialRewrite(ctx, current, partial);
        if (settled === "saved") return;
        const unavailable = settled === "unavailable";
        ctx.setState({ stream: null, stoppedGeneration: partial.trim().length === 0 ? null : {
          mode: current.mode,
          instruction: current.instruction,
          text: partial,
          ...(unavailable ? { saveable: false } : {}),
          ...(current.targetNodeId === undefined ? {} : { targetNodeId: current.targetNodeId }),
          ...(current.parentId === undefined ? {} : { parentId: current.parentId }),
          ...(unavailable || current.attemptId === undefined ? {} : { attemptId: current.attemptId }),
          ...(current.generationId === undefined ? {} : { generationId: current.generationId })
        }, status: partial.trim().length === 0
          ? "Stopped; no text was produced"
          : unavailable
            ? "Stopped rewrite kept for review"
          : current.mode === "summary"
            ? "Stopped summary kept for review"
            : "Stopped; save the streamed text when ready", error: unavailable
          ? "The Host no longer has this rewrite. Copy the retained text before you discard it."
          : current.mode === "summary" && partial.trim().length > 0
            ? "Interrupted summaries are not saved as story prose. Discard the summary before continuing."
            : null });
      }
      return;
    }
    ctx.setState({ stream: null, status: "Saved", error: null });
  } catch (error) {
    const current = ctx.state().stream;
    if (current === null) return;
    const partial = current.text + current.stoppedText;
    if (controller.signal.aborted) {
      const settled = await settlePartialRewrite(ctx, current, partial);
      if (settled === "saved") return;
      const unavailable = settled === "unavailable";
      ctx.setState({ stream: null, stoppedGeneration: partial.trim().length === 0 ? null : {
        mode: current.mode,
        instruction: current.instruction,
        text: partial,
        ...(unavailable ? { saveable: false } : {}),
        ...(current.targetNodeId === undefined ? {} : { targetNodeId: current.targetNodeId }),
        ...(current.parentId === undefined ? {} : { parentId: current.parentId }),
        ...(unavailable || current.attemptId === undefined ? {} : { attemptId: current.attemptId }),
        ...(current.generationId === undefined ? {} : { generationId: current.generationId })
      }, status: partial.trim().length === 0
        ? "Stopped; no text was produced"
        : unavailable
          ? "Stopped rewrite kept for review"
        : current.mode === "summary"
          ? "Stopped summary kept for review"
          : "Stopped; save the streamed text when ready", error: unavailable
        ? "The Host no longer has this rewrite. Copy the retained text before you discard it."
        : current.mode === "summary" && partial.trim().length > 0
          ? "Interrupted summaries are not saved as story prose. Discard the summary before continuing."
          : null });
    } else {
      ctx.setState({ stream: null, stoppedGeneration: partial.trim().length === 0 ? null : {
        mode: current.mode,
        instruction: current.instruction,
        text: partial,
        ...(current.targetNodeId === undefined ? {} : { targetNodeId: current.targetNodeId }),
        ...(current.parentId === undefined ? {} : { parentId: current.parentId }),
        ...(current.attemptId === undefined ? {} : { attemptId: current.attemptId }),
        ...(current.generationId === undefined ? {} : { generationId: current.generationId })
      }, status: partial.trim().length === 0
        ? "Generation failed"
        : current.mode === "summary"
          ? "Summary failed; review the partial summary"
          : "Generation failed; save the streamed text when ready", error: error instanceof Error ? error.message : String(error) });
    }
  }
}

type PartialRewriteSettlement = "saved" | "unavailable" | "retry";

async function settlePartialRewrite(ctx: RendererCommandContext, stream: NonNullable<import("./renderer-model.js").RendererState["stream"]>, partial: string): Promise<PartialRewriteSettlement> {
  if (partial.trim().length === 0 || stream.targetNodeId === undefined || stream.attemptId === undefined) return "retry";
  try {
    const digest = await rewriteStreamDigest(partial);
    const result = await ctx.api().commitPartialRewrite(ctx.story().id, stream.targetNodeId, digest, stream.attemptId);
    if (result === null) return "unavailable";
    await ctx.replaceStory(result.payload);
    ctx.setState({ stream: null, stoppedGeneration: null, status: "Interrupted text saved", error: null });
    return "saved";
  } catch {
    return "retry";
  }
}

function appendStream(ctx: RendererCommandContext, update: { text?: string; reasoning?: string; stoppedText?: string }, expectedId?: string): void {
  const current = ctx.state().stream;
  if (current === null || (expectedId !== undefined && current.id !== expectedId)) return;
  ctx.setState({ stream: { ...current, ...update } });
}

function appendStreamText(ctx: RendererCommandContext, text: string, field: "text" | "reasoning" | "stoppedText" = "text"): string {
  const current = ctx.state().stream;
  return current === null ? text : current[field] + text;
}

async function rewriteStreamDigest(text: string): Promise<string> {
  const input = new TextEncoder().encode(`1667-partial-rewrite\0${text}`);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", input);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
