import assert from "node:assert/strict";
import test from "node:test";
import type { UpdateNoticeApi } from "../client/update-notice-api.js";
import type { UpdateNoticeStatus } from "../shared/update-notice.js";
import { normalizeUpdateNoticeStatus } from "../shared/update-notice.js";
import { initialAppState, type AppState } from "../web/src/app/state.js";
import { createStore, type Store } from "../web/src/app/store.js";
import { watchUpdateNotice, updateNoticeKey } from "../web/src/app/update-notice.js";

/**
 * The web UI's half of the `1667 web` update notice (#409): the page reads
 * `/api/status`, and the background update check settles about a second
 * after `1667 web` starts — later when the registry is slow — so the read
 * has to happen again while the answer is still outstanding. The real store,
 * the real `pushToast`, and the real notice log; only the HTTP read and the
 * clock are fakes, the way `tui/test/background-update-check.test.ts` fakes
 * `schedule`/`cancel` rather than waiting on a timer.
 *
 * These are the ways this can fail, which is what each case below holds to:
 *
 *  1. It reads once and stops, so the notice that arrives a second later is
 *     never shown — a toast that almost never appears.
 *  2. It reads for ever, so a session with no update pays an endless stream
 *     of requests.
 *  3. It reads at all when the server already said there is no check to wait
 *     for (`updates.mode: "off"`, or a platform with no published release).
 *  4. It shows the same notice twice — once per read, or again after a
 *     Reconnect starts a second watch.
 *  5. It keeps reading after the page disposed it, so `<StrictMode>`'s double
 *     effect leaves two watches and a timer fires into a dead connection.
 *  6. It turns a failed read into a message, when a failed update check must
 *     stay silent.
 *  7. It shows a notice the server never sent, from a malformed field.
 */

function newStore(): Store<AppState> {
  return createStore(initialAppState({ kind: "library" }, null, "ink"));
}

/** A fake `schedule`/`cancel` pair: records each delay and fires the pending
 * callback only when a case asks it to. */
function fakeClock() {
  const delays: number[] = [];
  let pending: (() => void) | null = null;
  let canceled = 0;
  return {
    delays,
    canceled: () => canceled,
    schedule: (callback: () => void, delayMs: number) => {
      delays.push(delayMs);
      pending = callback;
      return delays.length as unknown as ReturnType<typeof setTimeout>;
    },
    cancel: () => { canceled += 1; pending = null; },
    pendingCount: () => (pending === null ? 0 : 1),
    /** Fires the pending timer and lets the read it starts settle. */
    tick: async () => {
      const callback = pending;
      pending = null;
      callback?.();
      await Promise.resolve();
      await Promise.resolve();
    }
  };
}

function apiAnswering(answers: readonly UpdateNoticeStatus[]): {
  readonly api: UpdateNoticeApi;
  reads(): number;
} {
  let reads = 0;
  return {
    api: {
      load: async () => {
        const answer = answers[Math.min(reads, answers.length - 1)]!;
        reads += 1;
        return answer;
      }
    },
    reads: () => reads
  };
}

function failingApi(): { readonly api: UpdateNoticeApi; reads(): number } {
  let reads = 0;
  return {
    api: {
      load: async () => {
        reads += 1;
        throw new Error("1667 web: GET /api/status returned 401");
      }
    },
    reads: () => reads
  };
}

const PENDING: UpdateNoticeStatus = { pending: true, notice: null };
const SETTLED: UpdateNoticeStatus = { pending: false, notice: null };
const NOTICE = "1667 0.12.0 available";

test("case 1: a notice that only a later read carries still reaches the reader", async () => {
  const store = newStore();
  const clock = fakeClock();
  const answers = apiAnswering([PENDING, PENDING, { pending: false, notice: NOTICE }]);
  const stop = watchUpdateNotice({
    store, api: answers.api, initial: PENDING,
    schedule: clock.schedule, cancel: clock.cancel
  });

  assert.equal(store.get().toasts.length, 0, "nothing is shown before an answer arrives");
  await clock.tick();
  await clock.tick();
  await clock.tick();

  assert.equal(answers.reads(), 3);
  assert.deepEqual(store.get().toasts.map((toast) => toast.message), [NOTICE]);
  assert.deepEqual(
    store.get().notices.map((notice) => [notice.channel, notice.text, notice.key]),
    [["toast", NOTICE, updateNoticeKey(NOTICE)]]
  );
  stop();
});

test("case 2: the reads are bounded, and stop for the rest of the session", async () => {
  const store = newStore();
  const clock = fakeClock();
  const answers = apiAnswering([PENDING]);
  const stop = watchUpdateNotice({
    store, api: answers.api, initial: PENDING,
    schedule: clock.schedule, cancel: clock.cancel
  });

  // Keep firing well past the budget. The watch must run out on its own.
  for (let fired = 0; fired < 20; fired += 1) await clock.tick();

  assert.equal(answers.reads(), 6, "six reads, then silence");
  assert.equal(clock.pendingCount(), 0, "no timer is left armed");
  assert.deepEqual(clock.delays, [5_000, 5_000, 5_000, 5_000, 5_000, 5_000]);
  assert.equal(store.get().toasts.length, 0);
  stop();
});

test("case 3: a settled answer asks for nothing — no check is running", async () => {
  const store = newStore();
  const clock = fakeClock();
  const answers = apiAnswering([PENDING]);
  const stop = watchUpdateNotice({
    store, api: answers.api, initial: SETTLED,
    schedule: clock.schedule, cancel: clock.cancel
  });

  assert.equal(answers.reads(), 0);
  assert.equal(clock.pendingCount(), 0, "`updates.mode: \"off\"` costs no request at all");
  assert.equal(store.get().toasts.length, 0);
  stop();
});

test("case 3b: a notice the connect-time read already carried needs no request", () => {
  const store = newStore();
  const clock = fakeClock();
  const answers = apiAnswering([PENDING]);
  const stop = watchUpdateNotice({
    store, api: answers.api, initial: { pending: false, notice: NOTICE },
    schedule: clock.schedule, cancel: clock.cancel
  });

  assert.equal(answers.reads(), 0, "the shared 24-hour cache answers before the page connects");
  assert.deepEqual(store.get().toasts.map((toast) => toast.message), [NOTICE]);
  stop();
});

test("case 4: one notice shows once, however often it is read or re-watched", async () => {
  const store = newStore();
  const first = fakeClock();
  const stopFirst = watchUpdateNotice({
    store, api: apiAnswering([{ pending: false, notice: NOTICE }]).api, initial: PENDING,
    schedule: first.schedule, cancel: first.cancel
  });
  await first.tick();
  assert.equal(store.get().toasts.length, 1);
  stopFirst();

  // A Reconnect starts a second watch against the same still-outdated server.
  const second = fakeClock();
  const stopSecond = watchUpdateNotice({
    store, api: apiAnswering([{ pending: false, notice: NOTICE }]).api, initial: PENDING,
    schedule: second.schedule, cancel: second.cancel
  });
  await second.tick();

  assert.deepEqual(store.get().toasts.map((toast) => toast.message), [NOTICE]);
  assert.equal(
    store.get().notices.filter((notice) => notice.key === updateNoticeKey(NOTICE)).length,
    1,
    "the notice log keeps one entry, the way it keeps one per recovery warning"
  );
  stopSecond();
});

test("case 5: disposing ends the watch — no later read, no later notice", async () => {
  const store = newStore();
  const clock = fakeClock();
  const answers = apiAnswering([{ pending: false, notice: NOTICE }]);
  const stop = watchUpdateNotice({
    store, api: answers.api, initial: PENDING,
    schedule: clock.schedule, cancel: clock.cancel
  });

  stop();
  assert.equal(clock.canceled(), 1, "the armed timer is canceled");
  await clock.tick();

  assert.equal(answers.reads(), 0);
  assert.equal(store.get().toasts.length, 0);
});

test("case 6: a failed read is silent", async () => {
  const store = newStore();
  const clock = fakeClock();
  const failing = failingApi();
  const stop = watchUpdateNotice({
    store, api: failing.api, initial: PENDING,
    schedule: clock.schedule, cancel: clock.cancel
  });

  await clock.tick();

  assert.equal(failing.reads(), 1);
  assert.equal(store.get().toasts.length, 0, "a failed update check never reaches the reader");
  assert.equal(store.get().notices.length, 0);
  assert.equal(clock.pendingCount(), 0);
  stop();
});

test("case 7: only a notice the server actually sent is shown", () => {
  for (const malformed of [undefined, null, "1667 9.9.9 available", 42, [], { notice: 7 }, { notice: "" }]) {
    assert.deepEqual(
      normalizeUpdateNoticeStatus(malformed),
      { pending: false, notice: null },
      `read as no notice: ${JSON.stringify(malformed) ?? "undefined"}`
    );
  }
  // `pending` is only ever a reason to read again, never a message.
  assert.deepEqual(
    normalizeUpdateNoticeStatus({ pending: true, notice: null }),
    { pending: true, notice: null }
  );
  // A notice settles the answer, so it never also asks for another read.
  assert.deepEqual(
    normalizeUpdateNoticeStatus({ pending: true, notice: NOTICE }),
    { pending: false, notice: NOTICE }
  );
});

test("case 7b: a malformed connect-time status is read, not shown", async () => {
  const store = newStore();
  const clock = fakeClock();
  const answers = apiAnswering([SETTLED]);
  // `client/web-bridge-connect.ts` casts the status body rather than reading
  // it field by field, so whatever `/api/status` sent arrives here as it is.
  const stop = watchUpdateNotice({
    store, api: answers.api, initial: "1667 9.9.9 available",
    schedule: clock.schedule, cancel: clock.cancel
  });

  assert.equal(store.get().toasts.length, 0, "a string is not a notice");
  assert.equal(clock.pendingCount(), 0, "and it is not a reason to read again");
  assert.equal(answers.reads(), 0);
  stop();
});

test("a status field this server does not carry is asked about once, then left alone", async () => {
  const store = newStore();
  const clock = fakeClock();
  const answers = apiAnswering([SETTLED]);
  const stop = watchUpdateNotice({
    store, api: answers.api, schedule: clock.schedule, cancel: clock.cancel
  });

  await clock.tick();
  for (let fired = 0; fired < 5; fired += 1) await clock.tick();

  assert.equal(answers.reads(), 1);
  assert.equal(store.get().toasts.length, 0);
  stop();
});
