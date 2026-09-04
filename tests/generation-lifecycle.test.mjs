import assert from "node:assert/strict";
import test from "node:test";
import { createGenerationKeepAlive } from "../extension/generation-lifecycle.js";

test("a late canceled request cannot stop its replacement keep-alive", () => {
  const callbacks = new Map();
  const cleared = [];
  const pings = [];
  let nextTimerId = 1;
  const keepAlive = createGenerationKeepAlive({
    setTimer: (callback, delay) => {
      const timerId = nextTimerId++;
      callbacks.set(timerId, { callback, delay });
      return timerId;
    },
    clearTimer: (timerId) => cleared.push(timerId),
    ping: () => pings.push("ping")
  });

  keepAlive.start("old-request");
  keepAlive.start("new-request");
  assert.deepEqual(cleared, [1]);

  assert.equal(keepAlive.stop("old-request"), false);
  assert.deepEqual(cleared, [1]);
  callbacks.get(2).callback();
  assert.deepEqual(pings, ["ping"]);

  assert.equal(keepAlive.stop("new-request"), true);
  assert.deepEqual(cleared, [1, 2]);
  assert.equal(callbacks.get(2).delay, 15000);
});
