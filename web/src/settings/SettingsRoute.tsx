import { useEffect, useState } from "react";
import { useAppContext } from "../app/context.js";
import { CHUNK_FAILED_TEXT, CHUNK_LOADING_TEXT, lazyView } from "../ui/LazyView.js";

const SettingsPage = lazyView(() => import("./SettingsPage.js"), "SettingsPage");

/** The settings page. Its code, the page and its actions, downloads together
 * and the page renders only when both are there, so every settings action
 * answers at once and none is queued. */
export function SettingsRoute({ onOpenSidebar }: { readonly onOpenSidebar: () => void }) {
  const { actions } = useAppContext();
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setState("loading");
    SettingsPage.preload();
    actions.settings.load().then(
      () => { if (live) setState("ready"); },
      () => { if (live) setState("failed"); }
    );
    return () => { live = false; };
  }, [actions, attempt]);

  if (state === "ready") return <SettingsPage onOpenSidebar={onOpenSidebar} />;
  if (state === "loading") return <p className="story-empty">{CHUNK_LOADING_TEXT}</p>;
  return (
    <div role="alert" className="chunk-error">
      <p>{CHUNK_FAILED_TEXT}</p>
      <button type="button" className="btn" onClick={() => setAttempt((count) => count + 1)}>Retry</button>
    </div>
  );
}
