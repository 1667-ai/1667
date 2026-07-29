import {
  decodeHttpFailurePayload,
  diagnosticReferenceFromFailure,
  type CompatibleHttpFailureEnvelope
} from "./failure-envelope.js";

export class HttpOperationError extends Error {
  constructor(readonly failure: CompatibleHttpFailureEnvelope) {
    super(failure.message);
    this.name = "HttpOperationError";
  }

  get status(): number {
    return this.failure.status ?? 500;
  }

  get code(): string {
    return this.failure.code;
  }

  get diagnosticRef(): string | null {
    return diagnosticReferenceFromFailure(this.failure);
  }
}

export function httpOperationResponseError(
  response: Response,
  payload: Record<string, unknown>
): HttpOperationError {
  return new HttpOperationError(decodeHttpFailurePayload(
    payload,
    `1667 operation request failed (${response.status})`,
    response.status
  ));
}
