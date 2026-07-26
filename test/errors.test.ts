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

test("public errors normalize provider status identically for every transport", () => {
  assert.deepEqual(toPublicServiceError(new ProviderError("Unauthorized upstream", 401)), {
    code: "provider_failure", message: "Unauthorized upstream", status: 502
  });
  assert.deepEqual(toPublicServiceError(new ServiceError(409, "Changed")), {
    code: "conflict", message: "Changed", status: 409
  });
  assert.deepEqual(toPublicServiceError(new Error("secret")), {
    code: "internal", message: "Internal server error", status: 500
  });
  assert.deepEqual(
    classifyServiceError(new ServiceError(500, "private", "internal")),
    {
      publicError: {
        code: "internal", message: "Internal server error", status: 500
      },
      exposure: "private"
    }
  );
  assert.deepEqual(
    classifyServiceError(new ServiceError(500, "/private/data/path")),
    {
      publicError: {
        code: "internal", message: "Internal server error", status: 500
      },
      exposure: "private"
    }
  );
  assert.deepEqual(
    classifyServiceError(new PublicRuntimeError("safe startup detail")),
    {
      publicError: {
        code: "startup_failure", message: "safe startup detail", status: 500
      },
      exposure: "public"
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

test("private stored failures publish only persisted diagnostic references", () => {
  const root = new Error("private receipt detail");
  const pending = prepareServiceFailure(root);

  assert.deepEqual(pending.failure, {
    kind: "plain",
    code: "internal",
    message: "Internal server error",
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
    "Internal server error"
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

test("failure envelopes make internal privacy and codes type invariants", () => {
  assert.deepEqual(createFailureEnvelope({
    code: "internal",
    message: "Private path: /srv/1667/settings.json",
    status: 500
  }), {
    kind: "plain",
    code: "internal",
    message: "Internal server error",
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
    message: "Internal server error",
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
    message: "Internal server error",
    status: 500
  });
});
