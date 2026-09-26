import type { IncomingMessage } from "node:http";
import { ServiceError } from "../server/errors.js";
import { readJsonBody } from "../server/http.js";
import { isStoryId } from "../server/story-v5-strict.js";
import type { Route, RouteResponse } from "./web-server.js";

/** `GET /api/reading-positions` body cap and `PUT .../<storyId>` body cap —
 * a real client's body is a `{ partId }` object a few dozen bytes long. */
const MAX_READING_POSITION_BODY_BYTES = 1_024;
/** Matches `MAX_STORY_IDENTIFIER_CHARS` (server/story-v5-strict.ts) — a part
 * id is a node id, drawn from the same identifier space as a story id. */
const MAX_PART_ID_CHARS = 1_024;

/** `/api/reading-positions/<storyId>` — one PUT per story. */
const READING_POSITION_STORY_PATH = /^\/api\/reading-positions\/([^/]+)$/;

function jsonResponse(status: number, body: unknown): RouteResponse {
  return { status, contentType: "application/json; charset=utf-8", body: JSON.stringify(body) };
}

function hasJsonContentType(request: IncomingMessage): boolean {
  const raw = request.headers["content-type"];
  const header = Array.isArray(raw) ? raw[0] : raw;
  return header?.split(";")[0]?.trim().toLowerCase() === "application/json";
}

export const readingPositionsGetRoute: Route = {
  match: (pathname) => (pathname === "/api/reading-positions" ? {} : null),
  methods: new Set(["GET"]),
  requireBearer: true,
  handle: async (context) => jsonResponse(200, { positions: await context.readingPositions.load() })
};

/**
 * `PUT /api/reading-positions/<storyId>` body `{ partId: string | null }`
 * (`null` deletes). Every failure answers a small JSON error body rather
 * than throwing, so `handleRequest`'s catch-all stays reserved for a real
 * bug. Reads the body through `server/http.ts`'s `readJsonBody` — the same
 * helper every other JSON route on the real server uses, now that it drains
 * an oversized body to completion instead of throwing mid-read (the Bun
 * `node:http` quirk `readBoundedTextBody` used to work around here).
 */
export const readingPositionsPutRoute: Route = {
  match: (pathname) => {
    const match = READING_POSITION_STORY_PATH.exec(pathname);
    return match === null ? null : { storyId: match[1]! };
  },
  methods: new Set(["PUT"]),
  requireBearer: true,
  handle: async (context, request, params) => {
    let storyId: string;
    try {
      storyId = decodeURIComponent(params.storyId!);
    } catch {
      return jsonResponse(400, { error: "invalid story id" });
    }
    if (!isStoryId(storyId)) return jsonResponse(400, { error: "invalid story id" });
    if (!hasJsonContentType(request)) {
      return jsonResponse(415, { error: "Content-Type must be application/json" });
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = await readJsonBody(request, undefined, MAX_READING_POSITION_BODY_BYTES);
    } catch (error) {
      return jsonResponse(error instanceof ServiceError ? error.status : 500, { error: "invalid request body" });
    }
    if (!("partId" in parsed)) return jsonResponse(400, { error: "body must be { partId: string | null }" });
    const partId = parsed.partId;
    if (partId !== null && (typeof partId !== "string" || partId.length === 0 || partId.length > MAX_PART_ID_CHARS)) {
      return jsonResponse(400, { error: "partId must be a non-empty bounded string, or null" });
    }
    context.readingPositions.set(storyId, partId as string | null);
    return { status: 204, contentType: "application/json; charset=utf-8", body: "" };
  }
};
