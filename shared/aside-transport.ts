/**
 * Wire contracts for the take-anchored Aside session surface.
 *
 * The v1 document remains `{ notes }`. These v2 shapes are additive: a
 * caller can opt into a session read or ask by sending its anchor (and, for
 * an ask, its session id) while older callers keep the v1 contract.
 */
import type { StoryPayload } from "./types.js";
import type { AsideAnchor } from "./aside-session.js";

export interface AsideLegacyNote {
  readonly question: string;
  readonly answer: string;
}

export interface AsideLegacyReadResponse {
  readonly notes: readonly AsideLegacyNote[];
}

export interface AsideSessionTurnResponse {
  readonly q: string;
  readonly a: string;
  readonly thoughts?: string;
  readonly thoughtTokens?: number;
}

/** A session view with its durable index id attached for TUI navigation. */
export interface AsideSessionResponse {
  readonly schemaVersion: 2;
  readonly id: string;
  readonly anchor: AsideAnchor | null;
  readonly title: string;
  readonly turns: readonly AsideSessionTurnResponse[];
}

export interface AsidePresenceAnchorResponse {
  readonly partId: string;
  readonly takeId: string;
  readonly sessionCount: number;
  /** Display projections. They never identify a session or request target. */
  readonly partNumber?: number;
  readonly takeIndex?: number;
  readonly takeCount?: number;
}

/** The v2 GET response. Session text is scoped to the requested anchor. */
export interface AsideReadResponse {
  readonly schemaVersion: 2;
  readonly anchor: AsideAnchor | null;
  readonly sessions: readonly AsideSessionResponse[];
  readonly anchors: readonly AsidePresenceAnchorResponse[];
  readonly unanchoredCount: number;
}

/** Worker input and the HTTP query projection for one v2 Aside read. */
export interface AsideReadRequest {
  readonly storyId: string;
  readonly anchor?: AsideAnchor | null;
}

/** Worker input and HTTP SSE body for one v2 Aside ask. */
export interface AsideAskRequest {
  readonly storyId: string;
  readonly question: string;
  readonly anchor: AsideAnchor | null;
  readonly sessionId?: string;
}

/** Service projection after the story id has been selected by the route. */
export type AsideAskInput = Omit<AsideAskRequest, "storyId">;

/** Legacy ask input stays separate so the v1 endpoint keeps its old shape. */
export interface AsideLegacyAskRequest {
  readonly storyId: string;
  readonly question: string;
}

export type AsideAskRequestValue = AsideLegacyAskRequest | AsideAskRequest;

/** The v2 SSE terminal view. The refreshed payload is transport-local. */
export interface AsideAskResponse extends AsideSessionResponse {
  readonly payload?: StoryPayload;
}

/** Common target for a local verb on one v2 session. */
export interface AsideSessionTargetRequest {
  readonly storyId: string;
  readonly sessionId: string;
  readonly anchor: AsideAnchor | null;
}

/** Target plus the focused turn used by delete, reset, and retake. */
export interface AsideTurnMutationRequest extends AsideSessionTargetRequest {
  readonly turnIndex: number;
}

/** Operation discriminator on the shared v2 session endpoint. */
export type AsideSessionMutationOperation = "delete-turn" | "reset" | "clear";

/** Wire body for the shared local-verb endpoint. */
export type AsideSessionMutationRequest =
  | (AsideTurnMutationRequest & { readonly operation: "delete-turn" | "reset" })
  | (AsideSessionTargetRequest & { readonly operation: "clear" });

/** Service projection after the story id has been selected by the route. */
export type AsideSessionMutationInput = AsideSessionMutationRequest extends infer Request
  ? Request extends { readonly storyId: string }
    ? Omit<Request, "storyId">
    : never
  : never;

/** Canonical response for delete, reset, and clear. */
export interface AsideSessionMutationResponse extends AsideSessionResponse {
  readonly payload?: StoryPayload;
}

/** Retake the selected session's last answer. */
export interface AsideRetakeRequest extends AsideTurnMutationRequest {}

/** Service projection after the story id has been selected by the route. */
export type AsideRetakeInput = Omit<AsideRetakeRequest, "storyId">;

export type AsideResponseValue =
  | AsideLegacyReadResponse
  | AsideReadResponse
  | AsideSessionResponse;
