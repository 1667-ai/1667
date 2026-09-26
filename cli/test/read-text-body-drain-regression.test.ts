import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { ServiceError } from "../../server/errors.js";
import { readTextBody } from "../../server/http.js";

/**
 * Regression test for a Bun 1.3.14 `node:http` bug `server/http.ts`'s
 * `readTextBody` used to trip over: throwing out of a
 * `for await (const chunk of request)` loop (the natural way to reject an
 * oversized body) and then writing an error response corrupted the reply
 * into a bare 200 with an empty body, rather than the intended status.
 * Verified absent under real Node with the same server code; this suite
 * only ever runs under Bun (`cli/`'s own `bun test`), which is also where
 * every packaged `1667`/`1667 web` actually serves this route from, so this
 * is the one place that can catch a return of the bug.
 */
test("readTextBody answers a clean 413 for an oversized body, and the "
  + "connection still serves a normal request afterward", async () => {
  const server = createServer((request, response) => {
    void (async () => {
      try {
        const text = await readTextBody(request, 1_024);
        response.writeHead(200, { "content-type": "text/plain" });
        response.end(`ok:${text.length}`);
      } catch (error) {
        const status = error instanceof ServiceError ? error.status : 500;
        response.writeHead(status, { "content-type": "text/plain" });
        response.end("rejected");
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  const origin = `http://127.0.0.1:${address.port}`;

  try {
    const oversized = await fetch(origin, { method: "PUT", body: "x".repeat(5_000) });
    expect(oversized.status).toBe(413);
    expect(await oversized.text()).toBe("rejected");

    // The connection (and the server generally) must still work normally —
    // the bug this guards against corrupted every reply that followed a
    // throw, not just the rejected one.
    const ok = await fetch(origin, { method: "PUT", body: "hello" });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("ok:5");
  } finally {
    server.close();
  }
}, 15_000);
