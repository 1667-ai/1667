import assert from "node:assert/strict";
import test from "node:test";
import {
  NpmChildCallbackLifecycle,
  NpmChildStateUncertainError
} from "../scripts/release-npm-child-lifecycle.js";

test("callback lifecycle accepts only one valid durable ready transition", () => {
  for (const pid of [null, 0, -1, 1.5, "1"]) {
    assert.throws(
      () => new NpmChildCallbackLifecycle().ready(pid),
      /invalid ready message/u
    );
  }
  const lifecycle = new NpmChildCallbackLifecycle();
  assert.equal(lifecycle.ready(17), 17);
  assert.throws(() => lifecycle.ready(17), /invalid ready message/u);
});

test("write deadline requires durable ready and starts only once", () => {
  const early = new NpmChildCallbackLifecycle();
  assert.throws(
    () => early.writeDeadlineStarted(),
    /before durable ready/u
  );

  const lifecycle = new NpmChildCallbackLifecycle();
  lifecycle.ready(17);
  lifecycle.writeDeadlineStarted();
  assert.throws(
    () => lifecycle.writeDeadlineStarted(),
    /before durable ready/u
  );
});

test("terminal transition requires the permitted executor identity", () => {
  const early = new NpmChildCallbackLifecycle();
  assert.throws(
    () => early.terminal(17),
    /exit identity changed/u
  );

  const lifecycle = permittedLifecycle(17);
  assert.throws(
    () => lifecycle.terminal(18),
    /exit identity changed/u
  );
  assert.deepEqual(lifecycle.terminal(17), {
    pid: 17,
    runnerError: undefined
  });
  assert.throws(
    () => lifecycle.terminal(17),
    /exit identity changed/u
  );
});

test("terminal record can settle only one pending terminal", () => {
  const early = permittedLifecycle(17);
  assert.throws(
    () => early.terminalRecorded(),
    /terminal record transition is invalid/u
  );

  const lifecycle = permittedLifecycle(17);
  lifecycle.terminal(17);
  lifecycle.terminalRecorded();
  assert.throws(
    () => lifecycle.terminalRecorded(),
    /terminal record transition is invalid/u
  );
  assert.notEqual(
    lifecycle.beginUncertainty(new Error("before keeper acknowledgment")),
    null
  );

  const acknowledged = permittedLifecycle(17);
  acknowledged.terminal(17);
  acknowledged.terminalRecorded();
  acknowledged.keeperSettled(17);
  assert.equal(acknowledged.beginUncertainty(new Error("late")), null);
  assert.throws(
    () => acknowledged.keeperSettled(17),
    /keeper settlement identity changed/u
  );
});

test("runner failure remains the cause of a failed terminal", () => {
  const first = new Error("first runner failure");
  const last = new Error("last runner failure");
  const lifecycle = new NpmChildCallbackLifecycle();
  lifecycle.runnerFailed(first);
  lifecycle.ready(17);
  lifecycle.runnerFailed(last);
  lifecycle.writeDeadlineStarted();
  assert.equal(lifecycle.terminal(17).runnerError, last);
});

test("uncertainty starts once and termination settles once", () => {
  const lifecycle = new NpmChildCallbackLifecycle();
  const uncertainty = lifecycle.beginUncertainty(new Error("protocol"));
  assert.ok(uncertainty?.error instanceof NpmChildStateUncertainError);
  assert.equal(uncertainty.pid, null);
  assert.equal(
    lifecycle.beginUncertainty(new Error("duplicate")),
    null
  );
  assert.equal(lifecycle.supervisorClosed(), null);
  assert.equal(lifecycle.isSupervisorClosed(), true);
  lifecycle.terminationSettled();
  assert.throws(
    () => lifecycle.terminationSettled(),
    /termination transition is invalid/u
  );
});

test("supervisor failure rejects startup or terminates a permitted child", () => {
  const starting = new NpmChildCallbackLifecycle();
  const rejected = starting.supervisorFailed(new Error("spawn"));
  assert.equal(rejected.kind, "reject-start");
  assert.match(
    rejected.kind === "reject-start" ? rejected.error.message : "",
    /did not start/u
  );

  const running = permittedLifecycle(17);
  const terminated = running.supervisorFailed(new Error("transport"));
  assert.equal(terminated.kind, "terminate");
  assert.equal(
    terminated.kind === "terminate"
      ? terminated.uncertainty.pid
      : null,
    17
  );
});

test("supervisor close records closure before termination proof", () => {
  const lifecycle = permittedLifecycle(17);
  lifecycle.runnerFailed(new Error("runner failed"));
  const uncertainty = lifecycle.supervisorClosed();
  assert.equal(uncertainty?.pid, 17);
  assert.match(
    String(uncertainty?.error.cause),
    /exited without a terminal record/u
  );
  assert.equal(lifecycle.isSupervisorClosed(), true);
});

function permittedLifecycle(pid: number): NpmChildCallbackLifecycle {
  const lifecycle = new NpmChildCallbackLifecycle();
  lifecycle.ready(pid);
  lifecycle.writeDeadlineStarted();
  return lifecycle;
}
