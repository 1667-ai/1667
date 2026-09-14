import { TAG_STATUSES, type Tag, type TagStatus } from "../shared/types.js";
import type { RendererCommandContext } from "./renderer-command-context.js";

/** Edit or remove any Story tag, including tags outside the active path. */
export async function manageTags(ctx: RendererCommandContext): Promise<void> {
  const story = ctx.story();
  if (story.tags.length === 0) {
    ctx.setState({ status: "No line tags", error: null });
    return;
  }
  const options = story.tags.map(tagOption);
  const selected = await ctx.choiceDialog("Story tags", options, options[0]!);
  if (selected === null) return;
  const tag = story.tags[options.indexOf(selected)];
  if (tag === undefined) return;
  const action = await ctx.choiceDialog("Tag action", ["Edit tag", "Remove tag"], "Edit tag");
  if (action === null) return;
  if (action === "Remove tag") {
    if (!await ctx.confirmDialog("Remove line tag", `Remove tag “${tag.name}”?`)) return;
    await ctx.run("Removing line tag", async () => {
      await ctx.replaceStory(await ctx.api().deleteBookmark(story.id, tag.nodeId));
      ctx.setState({ status: "Line tag removed" });
    });
    return;
  }
  await editTag(ctx, tag);
}

async function editTag(ctx: RendererCommandContext, tag: Tag): Promise<void> {
  const story = ctx.story();
  const name = (await ctx.textDialog("Line tag name", tag.name))?.trim();
  if (name === undefined || name.length === 0) return;
  const chosenStatus = await ctx.choiceDialog("Line tag status", TAG_STATUSES, tag.status || "Draft");
  if (chosenStatus === null) return;
  const status = chosenStatus.trim();
  if (!(TAG_STATUSES as readonly string[]).includes(status)) {
    ctx.setState({ status: "Invalid tag status", error: "Use Canon, Alt, Draft, Discarded, Summary, or an empty status." });
    return;
  }
  await ctx.run("Saving line tag", async () => {
    await ctx.replaceStory(await ctx.api().putBookmark(story.id, tag.nodeId, name, status as TagStatus));
    ctx.setState({ status: `Tagged line “${name}”` });
  });
}

function tagOption(tag: Tag): string {
  return `${tag.name} · ${tag.status || "tag"} · ${tag.nodeId.slice(0, 8)}`;
}
