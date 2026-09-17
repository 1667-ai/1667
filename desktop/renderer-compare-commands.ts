/** Compare (⌥-click, D-05/D-23): opens a popover comparing an off-path
 * take's own line against the reader's current line. `getTakeLine` is a
 * read, not a mutation, so this drives the popover's own `read`/`error`
 * fields directly instead of going through `ctx.run`'s app-wide status —
 * and stores the result, or the error, only while the same compare popover
 * for the same take is still open, so a stale response from an abandoned
 * compare can never land on a popover the writer has since moved past. */
import { messageOf } from "./renderer-runtime.js";
import type { RendererCommandContext } from "./renderer-command-context.js";

export async function compareTake(ctx: RendererCommandContext, nodeId: string): Promise<void> {
  const story = ctx.story();
  if (story.path.some((node) => node.id === nodeId)) {
    ctx.setState({ status: "This take is already on your line", error: null });
    return;
  }
  ctx.setState({ popover: { kind: "compare", nodeId, read: null, error: null } });
  const stillOpen = (): boolean => {
    const popover = ctx.state().popover;
    return popover?.kind === "compare" && popover.nodeId === nodeId;
  };
  try {
    const read = await ctx.api().getTakeLine(story.id, nodeId);
    if (stillOpen()) ctx.setState({ popover: { kind: "compare", nodeId, read, error: null } });
  } catch (error) {
    if (stillOpen()) ctx.setState({ popover: { kind: "compare", nodeId, read: null, error: messageOf(error) } });
  }
}
