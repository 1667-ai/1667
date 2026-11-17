import { isStoryPage, openStoryPage } from "../app/router.js";
import { runBusyToast } from "../app/run-lock.js";
import { registerCommands, type CommandContext } from "../palette/registry.js";

/** A loaded story page whose line has a part and no take switch pending (the
 * page continues the line end it opens on), on a server that can preview,
 * and no run in any story. */
function canSteer(context: CommandContext): boolean {
  const { route, story, connection } = context.state;
  if (!isStoryPage(route) || story.kind !== "loaded" || story.payload.id !== route.id || story.switching !== null) return false;
  if (story.payload.path.length === 0 || connection.kind !== "connected") return false;
  return connection.api.previewContinuation !== undefined && runBusyToast(context.state, route.id) === null;
}

registerCommands([
  {
    id: "steer",
    title: "steer",
    description: "scrub a live continuation and keep what you like",
    section: "story",
    available: canSteer,
    run: (context) => {
      const { route } = context.state;
      if (route.kind === "story") openStoryPage(route.id, { kind: "steer" });
    }
  }
]);
