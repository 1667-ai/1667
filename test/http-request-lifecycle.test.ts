import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { executeHttpRequest } from "../server/http-request-lifecycle.js";
import { InternalErrorReporter } from "../server/internal-error-reporter.js";
import { RequestDrain } from "../server/request-drain.js";

test("shutdown admission returns a resource-busy response", async () => {
  const requests = new RequestDrain();
  requests.beginShutdown();
  let handled = false;
  const server = createServer((request, response) => {
    void executeHttpRequest({
      requests,
      errorReporter: InternalErrorReporter.disabled(),
      request,
      response,
      handle: async () => {
        handled = true;
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Test listener did not expose a TCP address");
    }
    const response = await fetch(`http://127.0.0.1:${address.port}/late`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: "Story service is shutting down",
      code: "resource_busy"
    });
    assert.equal(handled, false);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    });
  }
});
