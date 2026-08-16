import assert from "node:assert/strict";
import test from "node:test";
import {
  createFailureEnvelope,
  decodeFailureEnvelope,
  diagnosticReferenceFromFailure,
  failureMessageFields,
  failureWireFields,
  httpFailurePayload
} from "../shared/failure-envelope.js";
import { createDiagnosticReference } from "../server/diagnostic-reference.js";
import {
  DiagnosticServiceError,
  GenerationResultError,
  ProviderError,
  PublicRuntimeError,
  ServiceError
} from "../server/errors.js";
import {
  errorFromFailureIncident,
  loggedFailureIncident,
  ReportedServiceError,
  unreportedFailureIncident
} from "../server/reported-service-error.js";
import {
  classifyServiceError,
  internalErrorReference,
  prepareServiceFailure,
  restoreStoredServiceFailure,
  toPublicServiceError
} from "../server/service-error-policy.js";
import { hasUnpairedSurrogate } from "../shared/unicode.js";

test("public errors normalize provider status identically for every transport", () => {
  assert.deepEqual(toPublicServiceError(new ProviderError("Unauthorized upstream", 401)), {
    code: "provider_failure", message: "Unauthorized upstream", status: 502
  });
  assert.deepEqual(toPublicServiceError(new ServiceError(409, "Changed")), {
    code: "conflict", message: "Changed", status: 409
  });
  assert.deepEqual(toPublicServiceError(new Error("secret")), {
    code: "internal", message: "Error: secret", status: 500
  });
  assert.deepEqual(
    classifyServiceError(new ServiceError(500, "private", "internal")),
    {
      publicError: {
        code: "internal", message: "ServiceError: private", status: 500
      },
      diagnostic: "required"
    }
  );
  assert.deepEqual(
    classifyServiceError(new ServiceError(500, "/private/data/path")),
    {
      publicError: {
        code: "internal", message: "ServiceError: /private/data/path", status: 500
      },
      diagnostic: "required"
    }
  );
  assert.deepEqual(
    classifyServiceError(new PublicRuntimeError("safe startup detail")),
    {
      publicError: {
        code: "startup_failure", message: "safe startup detail", status: 500
      },
      diagnostic: "none"
    }
  );
  assert.equal(
    new GenerationResultError(409, "Generation conflicted").code,
    "conflict"
  );
  assert.equal(
    new GenerationResultError(502, "Provider result failed").code,
    "provider_failure"
  );
});

test("internal errors expose a bounded cause chain without provider bodies", () => {
  const responseSecret = "provider-response-secret";
  const provider = new ProviderError(
    `Provider response contained ${responseSecret}`,
    502,
    responseSecret
  );
  const root = new Error("local operation failed", { cause: provider });

  const publicError = toPublicServiceError(root);

  assert.equal(publicError.code, "internal");
  assert.match(
    publicError.message,
    /Error: local operation failed; caused by ProviderError: Provider request failed with HTTP status 502/
  );
  assert.doesNotMatch(publicError.message, new RegExp(responseSecret));
  assert.doesNotMatch(publicError.message, /\bat\s+\S+/);
  assert.ok(publicError.message.length <= 1_024);
});

test("diagnostic service errors keep their diagnostic cause out of messages", () => {
  const secret = "credential=private-provider-key";
  const error = new DiagnosticServiceError(
    500,
    "The operation failed",
    "internal",
    new Error(secret)
  );

  assert.deepEqual(classifyServiceError(error), {
    publicError: {
      code: "internal",
      message: "The operation failed",
      status: 500
    },
    diagnostic: "required"
  });
  assert.deepEqual(prepareServiceFailure(error).failure, {
    kind: "plain",
    code: "internal",
    message: "The operation failed",
    status: 500
  });
  assert.doesNotMatch(toPublicServiceError(error).message, new RegExp(secret));
});

test("aggregate errors expose each useful failure without serializer details", () => {
  const first = new Error("startup failed");
  const aggregate = new AggregateError(
    [first, new Error("cleanup failed")],
    "startup and cleanup failed",
    { cause: first }
  );

  const message = toPublicServiceError(aggregate).message;

  assert.match(message, /AggregateError: startup and cleanup failed/);
  assert.match(message, /Error: startup failed/);
  assert.match(message, /Error: cleanup failed/);
  assert.doesNotMatch(message, /CircularErrorReference|already serialized/);
});

test("public diagnostics reserve traversal capacity for the primary cause", () => {
  const noisyBranches = Array.from({ length: 8 }, (_, index) =>
    new Error(`branch ${index}`, {
      cause: new Error(`branch ${index} cause`, {
        cause: new Error(`branch ${index} tail`)
      })
    }));
  const aggregate = new AggregateError(noisyBranches, "many failures", {
    cause: new Error("primary cause")
  });

  const message = toPublicServiceError(aggregate).message;

  assert.match(message, /caused by Error: primary cause/);
  assert.doesNotMatch(message, /caused by TruncatedErrorGraph/);
});

test("an error named CircularErrorReference remains visible", () => {
  const named = new Error("real failure");
  named.name = "CircularErrorReference";

  const message = toPublicServiceError(new AggregateError([
    named,
    new Error("later failure")
  ], "aggregate failed", { cause: named })).message;

  assert.match(message, /CircularErrorReference: real failure/);
  assert.match(message, /Error: later failure/);
  assert.doesNotMatch(message, /already serialized/);
});

test("internal error truncation preserves complete Unicode scalars", () => {
  const message = toPublicServiceError(
    new Error(`${"x".repeat(1_015)}😀tail`)
  ).message;

  assert.equal(hasUnpairedSurrogate(message), false);
  assert.ok(message.endsWith("…"));
  assert.doesNotMatch(message, /�/u);
});

test("internal stored failures publish only persisted diagnostic references", () => {
  const root = new Error("private receipt detail");
  const pending = prepareServiceFailure(root);

  assert.deepEqual(pending.failure, {
    kind: "plain",
    code: "internal",
    message: "Error: private receipt detail",
    status: 500
  });
  const pendingError = errorFromFailureIncident(pending);
  assert.equal(internalErrorReference(pendingError), null);
  assert.ok(pendingError instanceof ReportedServiceError);
  assert.equal(pendingError.cause, root);

  const reference = createDiagnosticReference();
  const reportedFailure = createFailureEnvelope(
    toPublicServiceError(root),
    reference
  );
  assert.equal(reportedFailure.kind, "diagnostic");
  if (reportedFailure.kind !== "diagnostic") {
    throw new Error("Expected diagnostic failure");
  }
  const reported = new ReportedServiceError(
    loggedFailureIncident(
      unreportedFailureIncident(
        createFailureEnvelope(toPublicServiceError(root)),
        root,
        root
      ),
      reference
    )
  );
  const prepared = prepareServiceFailure(reported);
  assert.equal(
    diagnosticReferenceFromFailure(prepared.failure),
    reference
  );

  const restored = restoreStoredServiceFailure(prepared.failure);
  assert.equal(
    internalErrorReference(restored),
    diagnosticReferenceFromFailure(prepared.failure)
  );
  assert.equal(
    (restored as Error).message,
    "Error: private receipt detail"
  );
});

test("all private failures use one explicit typed service error", () => {
  const root = Object.freeze(new Error("frozen private failure"));

  const prepared = prepareServiceFailure(root);
  const preparedError = errorFromFailureIncident(prepared);

  assert.ok(preparedError instanceof Error);
  assert.notEqual(preparedError, root);
  assert.equal(preparedError.cause, root);
  assert.equal(Object.isFrozen(prepared), true);
  assert.equal(Object.isFrozen(preparedError), true);

  const thrownUndefined = prepareServiceFailure(undefined);
  const thrownUndefinedError = errorFromFailureIncident(thrownUndefined);
  assert.ok(thrownUndefinedError instanceof ReportedServiceError);
  assert.equal(
    Object.prototype.hasOwnProperty.call(thrownUndefinedError, "cause"),
    true
  );
  assert.equal(thrownUndefinedError.cause, undefined);
});

test("plain stored internal failures remain unavailable on replay", () => {
  const restored = restoreStoredServiceFailure({
    kind: "plain",
    code: "internal",
    message: "Internal server error",
    status: 500
  });

  assert.ok(restored instanceof ReportedServiceError);
  assert.equal(Object.isFrozen(restored), true);
  assert.equal(internalErrorReference(restored), null);
});

test("failure envelope bounds messages without changing public semantics", () => {
  const failure = createFailureEnvelope({
    code: "not_found",
    message: "x".repeat(5_000),
    status: 404
  });

  assert.equal(failure.kind, "plain");
  assert.equal(failure.code, "not_found");
  assert.equal(failure.status, 404);
  assert.equal(failure.message.length, 4_096);
});

test("failure envelopes own every backwards-compatible wire projection", () => {
  const failure = createFailureEnvelope({
    code: "internal",
    message: "Internal server error",
    status: 500
  }, "err_deadbeefdeadbeefdeadbeef");

  assert.deepEqual(failureWireFields(failure), {
    code: "internal",
    message: "Internal server error",
    status: 500,
    diagnosticRef: "err_deadbeefdeadbeefdeadbeef"
  });
  assert.deepEqual(httpFailurePayload(failure), {
    error: "Internal server error",
    code: "internal",
    diagnosticRef: "err_deadbeefdeadbeefdeadbeef"
  });
  assert.deepEqual(failureMessageFields(failure), {
    message: "Internal server error",
    diagnosticRef: "err_deadbeefdeadbeefdeadbeef"
  });
  assert.deepEqual(
    failureWireFields(createFailureEnvelope({
      code: "conflict",
      message: "Changed",
      status: 409
    })),
    {
      code: "conflict",
      message: "Changed",
      status: 409
    }
  );
});

test("failure envelopes normalize invalid HTTP statuses to an internal 500", () => {
  for (const status of [Number.NaN, 99, 600, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(createFailureEnvelope({
      code: "conflict",
      message: "Invalid transport status",
      status
    }), {
      kind: "plain",
      code: "internal",
      message: "Internal server error",
      status: 500
    });
  }
});

test("failure envelopes preserve bounded internal diagnostics", () => {
  assert.deepEqual(createFailureEnvelope({
    code: "internal",
    message: "Private path: /srv/1667/settings.json",
    status: 500
  }), {
    kind: "plain",
    code: "internal",
    message: "Private path: /srv/1667/settings.json",
    status: 500
  });
  assert.deepEqual(decodeFailureEnvelope({
    kind: "plain",
    code: "internal",
    message: "Private tagged path: /srv/1667/settings.json",
    status: 500
  }), {
    kind: "plain",
    code: "internal",
    message: "Private tagged path: /srv/1667/settings.json",
    status: 500
  });
  assert.deepEqual(decodeFailureEnvelope({
    kind: "plain",
    code: "future_private_code",
    message: "Unclassified future failure",
    status: 409
  }), {
    kind: "plain",
    code: "internal",
    message: "Internal server error",
    status: 500
  });
});

test("failure decoding reconstructs only exact frozen envelopes", () => {
  const wire = {
    kind: "plain",
    code: "conflict",
    message: "Conflict",
    status: 409
  } as const;
  const decoded = decodeFailureEnvelope(wire);

  assert.notEqual(decoded, wire);
  assert.equal(Object.isFrozen(decoded), true);
  assert.deepEqual(decoded, wire);
  assert.equal(decodeFailureEnvelope({
    ...wire,
    stack: "private stack"
  }), null);
});

test("failure decoder rejects malformed discriminated envelopes", () => {
  assert.equal(decodeFailureEnvelope({
    kind: "diagnostic",
    code: "internal",
    message: "Internal server error",
    status: 500
  }), null);
  assert.equal(decodeFailureEnvelope({
    kind: "plain",
    code: "internal",
    message: "Internal server error",
    status: 500,
    diagnosticRef: "err_deadbeefdeadbeefdeadbeef"
  }), null);
  assert.equal(decodeFailureEnvelope({
    code: "",
    message: "Missing code",
    status: 500
  }), null);
  const legacyLongFailure = decodeFailureEnvelope({
    code: "conflict",
    message: "x".repeat(4_097),
    status: 409
  });
  assert.equal(legacyLongFailure?.message.length, 4_096);
  assert.equal(legacyLongFailure?.code, "conflict");
  assert.equal(decodeFailureEnvelope({
    kind: "plain",
    code: "internal",
    message: "x".repeat(4_097),
    status: 500
  }), null);
  assert.equal(decodeFailureEnvelope({
    code: "conflict",
    message: "Invalid legacy transport status",
    status: 600
  }), null);
  assert.deepEqual(decodeFailureEnvelope({
    code: "internal",
    message: "Private legacy path: /srv/1667/settings.json",
    status: 500
  }), {
    kind: "plain",
    code: "internal",
    message: "Private legacy path: /srv/1667/settings.json",
    status: 500
  });
});
