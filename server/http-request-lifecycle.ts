import type { IncomingMessage, ServerResponse } from "node:http";
import {
  httpFailurePayload,
  type FailureEnvelope
} from "../shared/failure-envelope.js";
import { sendJson } from "./http.js";
import type { InternalErrorReporter } from "./internal-error-reporter.js";
import type { RequestDrain } from "./request-drain.js";
import { prepareServiceFailure } from "./service-error-policy.js";

interface HttpRequestExecution {
  readonly requests: RequestDrain;
  readonly errorReporter: InternalErrorReporter;
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly handle: () => Promise<void>;
}

/** Keeps diagnostic reporting inside the drained request while adapting both
 * handler failures and shutdown admission failures to one HTTP response. */
export async function executeHttpRequest(
  execution: HttpRequestExecution
): Promise<void> {
  try {
    await execution.requests.run(async () => {
      try {
        await execution.handle();
      } catch (error) {
        const reported = await execution.errorReporter.report(error, {
          service: "http-server",
          operation: `${execution.request.method ?? "GET"} `
            + `${execution.request.url ?? "/"}`
        });
        sendHttpFailure(execution.response, reported.failure);
      }
    });
  } catch (error) {
    sendHttpFailure(
      execution.response,
      prepareServiceFailure(error).failure
    );
  }
}

function sendHttpFailure(
  response: ServerResponse,
  failure: FailureEnvelope
): void {
  if (response.headersSent) {
    if (!response.writableEnded) response.end();
    return;
  }
  if (failure.status === 401 || failure.status === 403) {
    response.setHeader("connection", "close");
  }
  sendJson(
    response,
    failure.status ?? 500,
    httpFailurePayload(failure)
  );
}
