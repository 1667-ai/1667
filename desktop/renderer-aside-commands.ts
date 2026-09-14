import type { AsideAskResponse, AsideReadResponse, AsideSessionResponse } from "../shared/aside-transport.js";
import type { AsideAnchor } from "../shared/aside-session.js";
import type { StoryPayload } from "../shared/types.js";
import type { AsideState } from "./renderer-model.js";
import {
  ASIDE_CURRENT_KEY,
  ASIDE_UNANCHORED_KEY,
  asideAnchorKey
} from "./renderer-model.js";
import type { RendererCommandContext } from "./renderer-command-context.js";

let asideLoadSequence = 0;

export function emptyAsideState(): AsideState {
  return {
    question: "",
    answer: "",
    notes: [],
    busy: false,
    sessions: [],
    anchors: [],
    unanchoredCount: 0,
    selectedSessionId: null,
    anchor: null,
    bucket: "current",
    v2: false
  };
}

export function asideAnchorForStory(story: StoryPayload): AsideAnchor | null {
  const leaf = story.path.at(-1);
  return leaf === undefined ? null : { partId: leaf.id, takeId: leaf.id };
}

export async function loadAside(
  ctx: RendererCommandContext,
  story: StoryPayload,
  requestedAnchor?: AsideAnchor | null
): Promise<void> {
  const sequence = ++asideLoadSequence;
  const api = ctx.api();
  const anchor = requestedAnchor === undefined ? asideAnchorForStory(story) : requestedAnchor;
  const originAside = ctx.state().aside;
  const isFresh = (): boolean => {
    if (sequence !== asideLoadSequence || ctx.state().story?.id !== story.id || ctx.state().aside !== originAside) return false;
    try {
      return ctx.api() === api;
    } catch {
      return false;
    }
  };
  try {
    if (api.getAsideV2 !== undefined) {
      const response = await api.getAsideV2({ storyId: story.id, anchor });
      if (!isFresh()) return;
      if (response !== null) {
        ctx.setState({ aside: asideStateFromResponse(response, anchor, asideBucketForStory(story, anchor)) });
        return;
      }
    }
    const legacy = await api.getAside(story.id);
    if (!isFresh()) return;
    const last = legacy.notes.at(-1);
    ctx.setState({ aside: {
      ...emptyAsideState(),
      notes: legacy.notes,
      question: last?.question ?? "",
      answer: last?.answer ?? "",
      bucket: asideBucketForStory(story, anchor)
    } });
  } catch (error) {
    if (isFresh()) ctx.setState({ status: "Aside unavailable", error: errorMessage(error) });
  }
}

export async function askAside(ctx: RendererCommandContext, question: string): Promise<void> {
  const api = ctx.api();
  const story = ctx.story();
  const trimmed = question.trim();
  if (trimmed.length === 0 || ctx.state().aside.busy) return;
  ctx.getAsideController()?.abort();
  const controller = new AbortController();
  ctx.setAsideController(controller);
  ctx.setState({ aside: { ...ctx.state().aside, question: trimmed, answer: "", busy: true }, status: "Aside is thinking…" });
  try {
    const aside = ctx.state().aside;
    if (aside.v2 && api.askAsideV2 !== undefined) {
      const result = await api.askAsideV2(
        {
          storyId: story.id,
          question: trimmed,
          anchor: aside.anchor,
          ...(aside.selectedSessionId === null ? {} : { sessionId: aside.selectedSessionId })
        },
        (text) => {
          if (ctx.state().story?.id === story.id) ctx.setState({ aside: { ...ctx.state().aside, answer: ctx.state().aside.answer + text, busy: true } });
        },
        undefined,
        controller.signal
      );
      if (result !== null) applyAsideSessionResponse(ctx, result, story, trimmed, question);
      else ctx.setState({ aside: { ...ctx.state().aside, busy: false }, status: "Aside stopped" });
    } else {
      const result = await api.askAside(
        story.id,
        trimmed,
        (text) => {
          if (ctx.state().story?.id === story.id) ctx.setState({ aside: { ...ctx.state().aside, answer: ctx.state().aside.answer + text, busy: true } });
        },
        controller.signal
      );
      if (result !== null) {
        if (ctx.state().story?.id !== story.id) return;
        ctx.setState({
          aside: { ...ctx.state().aside, question: trimmed, answer: result.notes.at(-1)?.answer ?? ctx.state().aside.answer, notes: result.notes, busy: false },
          status: "Aside saved"
        });
        if (result.payload !== undefined) ctx.setState({ story: result.payload });
        clearSubmittedAsideQuestionDraft(ctx, question);
      } else if (ctx.state().story?.id === story.id) {
        ctx.setState({ aside: { ...ctx.state().aside, busy: false }, status: "Aside stopped" });
      }
    }
  } catch (error) {
    if (ctx.state().story?.id === story.id) {
      ctx.setState({ aside: { ...ctx.state().aside, busy: false }, error: errorMessage(error), status: "Aside failed" });
    }
  } finally {
    if (ctx.getAsideController() === controller) ctx.setAsideController(null);
  }
}

export function selectAsideSession(ctx: RendererCommandContext, sessionId: string): void {
  if (sessionId.length === 0) {
    const currentAnchor = asideAnchorForStory(ctx.story());
    const aside = ctx.state().aside;
    const sameBucket = (currentAnchor === null && aside.anchor === null)
      || (currentAnchor !== null && aside.anchor !== null
        && asideAnchorKey(currentAnchor) === asideAnchorKey(aside.anchor));
    ctx.setState({ aside: {
      ...aside,
      selectedSessionId: null,
      question: "",
      answer: "",
      anchor: currentAnchor,
      sessions: sameBucket ? aside.sessions : [],
      bucket: currentAnchor === null ? "unanchored" : "current"
    } });
    ctx.setDraft("aside-question", undefined);
    return;
  }
  const session = ctx.state().aside.sessions.find((candidate) => candidate.id === sessionId);
  if (session === undefined) return;
  const last = session.turns.at(-1);
  ctx.setState({ aside: {
    ...ctx.state().aside,
    selectedSessionId: session.id,
    anchor: session.anchor,
    bucket: asideBucketForStory(ctx.story(), session.anchor),
    question: last?.q ?? "",
    answer: last?.a ?? ""
  } });
  ctx.setDraft("aside-question", undefined);
}

export async function selectAsideAnchor(ctx: RendererCommandContext, key: string): Promise<void> {
  const story = ctx.story();
  const aside = ctx.state().aside;
  const anchor = key === ASIDE_CURRENT_KEY
    ? asideAnchorForStory(story)
    : key === ASIDE_UNANCHORED_KEY
      ? null
      : (() => {
        const entry = aside.anchors.find((candidate) => asideAnchorKey(candidate) === key);
        return entry === undefined ? undefined : { partId: entry.partId, takeId: entry.takeId };
      })();
  if (anchor === undefined) return;
  await loadAside(ctx, story, anchor);
}

export function stopAside(ctx: RendererCommandContext): void {
  const controller = ctx.getAsideController();
  if (controller === null || controller.signal.aborted) return;
  controller.abort();
  ctx.setState({ aside: { ...ctx.state().aside, busy: false }, status: "Stopping Aside…" });
}

export async function clearAside(ctx: RendererCommandContext): Promise<void> {
  const api = ctx.api();
  const story = ctx.story();
  await ctx.run("Clearing Aside", async () => {
    await ctx.replaceStory(await api.clearAside(story.id));
    ctx.setState({ aside: emptyAsideState() });
    ctx.setDraft("aside-question", undefined);
  });
}

export async function clearAsideSession(ctx: RendererCommandContext): Promise<void> {
  const api = ctx.api();
  const story = ctx.story();
  const sessionId = ctx.state().aside.selectedSessionId;
  if (!ctx.state().aside.v2 || sessionId === null || api.clearAsideSession === undefined) return;
  await ctx.run("Clearing Aside session", async () => {
    const response = await api.clearAsideSession!({ storyId: story.id, sessionId, anchor: ctx.state().aside.anchor });
    applyAsideSessionResponse(ctx, response, story, "");
    ctx.setState({ status: "Aside session cleared" });
  });
}

export async function resetAside(ctx: RendererCommandContext, turnIndex: number): Promise<void> {
  const api = ctx.api();
  const story = ctx.story();
  const sessionId = ctx.state().aside.selectedSessionId;
  if (!ctx.state().aside.v2 || sessionId === null || api.resetAside === undefined) return;
  if (!await ctx.confirmDialog("Reset Aside session", "Remove this Aside turn and every later turn?")) return;
  await ctx.run("Resetting Aside session", async () => {
    const response = await api.resetAside!({ storyId: story.id, sessionId, turnIndex, anchor: ctx.state().aside.anchor });
    applyAsideSessionResponse(ctx, response, story, "");
    ctx.setState({ status: "Aside session reset" });
  });
}

export async function deleteAsideTurn(ctx: RendererCommandContext, turnIndex: number): Promise<void> {
  const api = ctx.api();
  const story = ctx.story();
  const sessionId = ctx.state().aside.selectedSessionId;
  if (!ctx.state().aside.v2 || sessionId === null || api.deleteAsideTurn === undefined) return;
  if (!await ctx.confirmDialog("Delete Aside turn", "Delete this Aside turn?")) return;
  await ctx.run("Deleting Aside turn", async () => {
    const response = await api.deleteAsideTurn!({ storyId: story.id, sessionId, turnIndex, anchor: ctx.state().aside.anchor });
    applyAsideSessionResponse(ctx, response, story, "");
    ctx.setState({ status: "Aside turn deleted" });
  });
}

export async function retakeAside(ctx: RendererCommandContext, turnIndex: number): Promise<void> {
  const api = ctx.api();
  const story = ctx.story();
  const sessionId = ctx.state().aside.selectedSessionId;
  const session = ctx.state().aside.sessions.find((candidate) => candidate.id === sessionId);
  const turn = session?.turns[turnIndex];
  if (!ctx.state().aside.v2 || sessionId === null || turn === undefined || api.retakeAside === undefined) return;
  const controller = new AbortController();
  ctx.getAsideController()?.abort();
  ctx.setAsideController(controller);
  ctx.setState({ aside: { ...ctx.state().aside, question: turn.q, answer: "", busy: true }, status: "Retaking Aside answer…" });
  try {
    const result = await api.retakeAside!({ storyId: story.id, sessionId, turnIndex, anchor: ctx.state().aside.anchor }, (text) => {
      if (ctx.state().story?.id === story.id) ctx.setState({ aside: { ...ctx.state().aside, answer: ctx.state().aside.answer + text, busy: true } });
    }, undefined, controller.signal);
    if (result !== null) applyAsideSessionResponse(ctx, result, story, turn.q);
    else if (ctx.state().story?.id === story.id) {
      ctx.setState({ aside: { ...ctx.state().aside, busy: false }, status: "Aside stopped" });
    }
  } catch (error) {
    if (ctx.state().story?.id === story.id) {
      ctx.setState({ aside: { ...ctx.state().aside, busy: false }, error: errorMessage(error), status: "Aside retake failed" });
    }
  } finally {
    if (ctx.getAsideController() === controller) ctx.setAsideController(null);
  }
}

function applyAsideSessionResponse(
  ctx: RendererCommandContext,
  response: AsideAskResponse | AsideSessionResponse,
  story: StoryPayload,
  questionFallback: string,
  submittedQuestion?: string
): void {
  if (ctx.state().story?.id !== story.id) return;
  const current = ctx.state().aside;
  const sessions = current.sessions.some((session) => session.id === response.id)
    ? current.sessions.map((session) => session.id === response.id ? response : session)
    : [...current.sessions, response];
  const last = response.turns.at(-1);
  const presence = "payload" in response ? response.payload?.asidePresence : undefined;
  ctx.setState({
    story: ("payload" in response ? response.payload : undefined) ?? ctx.state().story,
    aside: {
      ...current,
      sessions,
      ...(presence === undefined ? {} : {
        anchors: presence.anchors,
        unanchoredCount: presence.unanchoredCount
      }),
      selectedSessionId: response.id,
      anchor: response.anchor,
      bucket: asideBucketForStory(story, response.anchor),
      question: last?.q ?? questionFallback,
      answer: last?.a ?? "",
      busy: false,
      v2: true
    },
    status: "Aside saved"
  });
  if (submittedQuestion === undefined) ctx.setDraft("aside-question", undefined);
  else clearSubmittedAsideQuestionDraft(ctx, submittedQuestion);
}

function clearSubmittedAsideQuestionDraft(ctx: RendererCommandContext, submittedQuestion: string): void {
  if (ctx.state().drafts["aside-question"] === submittedQuestion) {
    ctx.setDraft("aside-question", undefined);
  }
}

function asideStateFromResponse(
  response: AsideReadResponse,
  fallbackAnchor: AsideAnchor | null,
  bucket: AsideState["bucket"]
): AsideState {
  const selected = response.sessions[0];
  const last = selected?.turns.at(-1);
  return {
    question: last?.q ?? "",
    answer: last?.a ?? "",
    notes: [],
    busy: false,
    sessions: response.sessions,
    anchors: response.anchors,
    unanchoredCount: response.unanchoredCount,
    selectedSessionId: selected?.id ?? null,
    anchor: response.anchor ?? fallbackAnchor,
    bucket,
    v2: true
  };
}

function asideBucketForStory(story: StoryPayload, anchor: AsideAnchor | null): AsideState["bucket"] {
  if (anchor === null) return "unanchored";
  const current = asideAnchorForStory(story);
  return current !== null && asideAnchorKey(current) === asideAnchorKey(anchor)
    ? "current"
    : "historical";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
