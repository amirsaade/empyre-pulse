import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_BUDGET,
  DEFAULT_DELAY_MS,
  MIN_DELAY_MS,
  assertBudget,
  assertPoliteDelay,
  cellAction,
  errorGapMs,
  finishWalk,
  httpStopReason,
  initialWalk,
  isFresh,
  reduceVisit,
  spacingMs,
} from "./collect-policy";

describe("collector throttle", () => {
  it("never spaces requests closer than the base delay", () => {
    assert.equal(MIN_DELAY_MS, 5_000);
    assert.equal(DEFAULT_DELAY_MS, 5_000);
    assert.equal(spacingMs(5_000, 2_500, 0), 5_000);
    assert.equal(spacingMs(5_000, 2_500, 1), 7_500);
    assert.equal(spacingMs(5_000, 2_500, 0.5), 6_250);
    assert.ok(spacingMs(5_000, 0, 1) >= MIN_DELAY_MS);
  });

  it("refuses a base delay under five seconds or a huge budget", () => {
    assert.throws(() => assertPoliteDelay(4_999));
    assert.equal(assertPoliteDelay(5_000), 5_000);
    assert.throws(() => assertBudget(121));
    assert.throws(() => assertBudget(1.5));
    assert.equal(assertBudget(DEFAULT_BUDGET), 24);
    assert.equal(assertBudget(0), 0);
  });

  it("backs off exponentially and stops on 429, 403, or an error spike", () => {
    assert.equal(errorGapMs(5_000, 2_500, 1, 0), 5_000);
    assert.equal(errorGapMs(5_000, 2_500, 2, 0), 10_000);
    assert.equal(errorGapMs(5_000, 2_500, 3, 1), 30_000);
    assert.equal(httpStopReason(429), "http_429");
    assert.equal(httpStopReason(403), "http_403");
    assert.equal(httpStopReason(500), null);
    assert.equal(httpStopReason(null), null);

    let state = initialWalk({
      length: 6,
      budget: 10,
      cursor: 0,
      deferred: [],
      spikeThreshold: 3,
    });
    state = reduceVisit(state, 0, "error", false);
    state = reduceVisit(state, 1, "error", false);
    assert.equal(state.stop, null);
    assert.equal(state.consecutiveErrors, 2);
    state = reduceVisit(state, 2, "error", false);
    assert.equal(state.stop, "error_spike");
    assert.equal(state.used, 3);
    assert.equal(state.deferred[0], 2);
    assert.deepEqual(state.deferred, [2, 0, 1]);

    const blocked = reduceVisit(
      initialWalk({ length: 4, budget: 10, cursor: 0, deferred: [9], spikeThreshold: 3 }),
      1,
      "http_429",
      false,
    );
    assert.equal(blocked.stop, "http_429");
    assert.equal(blocked.cursor, 2);
    assert.equal(blocked.deferred[0], 1);
    assert.ok(blocked.deferred.includes(9));

    const forbidden = reduceVisit(
      initialWalk({ length: 2, budget: 10, cursor: 0, deferred: [], spikeThreshold: 3 }),
      0,
      "http_403",
      false,
    );
    assert.equal(forbidden.stop, "http_403");
    assert.equal(forbidden.used, 1);
  });
});

describe("collector resume", () => {
  it("skips fresh cells, defers reserved ones, and continues from the cursor", () => {
    assert.equal(cellAction({ fresh: true, reserved: true }), "skip-fresh");
    assert.equal(cellAction({ fresh: false, reserved: true }), "defer-reserved");
    assert.equal(cellAction({ fresh: false, reserved: false }), "fetch");

    let state = initialWalk({
      length: 5,
      budget: 10,
      cursor: 0,
      deferred: [],
      spikeThreshold: 3,
    });
    state = reduceVisit(state, 0, "defer-reserved", false);
    state = reduceVisit(state, 1, "skip-fresh", false);
    state = reduceVisit(state, 2, "stored", false);
    assert.equal(state.cursor, 3);
    assert.deepEqual(state.deferred, [0]);
    assert.equal(state.used, 1);
    assert.equal(state.consecutiveErrors, 0);

    state = reduceVisit(state, 3, "http_429", false);
    assert.equal(state.stop, "http_429");
    assert.equal(state.deferred[0], 3);

    const resumed = initialWalk({
      length: 5,
      budget: 10,
      cursor: state.cursor,
      deferred: state.deferred,
      spikeThreshold: 3,
    });
    assert.equal(resumed.cursor, 4);
    assert.equal(resumed.deferred[0], 3);
    assert.ok(resumed.deferred.includes(0));

    const done = finishWalk({ ...resumed, cursor: 5, deferred: [] });
    assert.equal(done.stop, "complete");
    const waiting = finishWalk({ ...resumed, cursor: 5, deferred: [0] });
    assert.equal(waiting.stop, "awaiting-markets");
  });

  it("treats a stored cell as fresh only inside the window", () => {
    const now = Date.parse("2026-06-01T00:00:00Z");
    const day = 24 * 60 * 60 * 1000;
    assert.equal(isFresh("2026-05-20T00:00:00Z", now, 30 * day), true);
    assert.equal(isFresh("2026-04-01T00:00:00Z", now, 30 * day), false);
    assert.equal(isFresh("not-a-date", now, 30 * day), false);
  });

  it("stops once the request budget is spent and leaves the cursor on the next cell", () => {
    let state = initialWalk({
      length: 4,
      budget: 1,
      cursor: 0,
      deferred: [],
      spikeThreshold: 3,
    });
    state = reduceVisit(state, 0, "stored", false);
    assert.equal(state.stop, "budget");
    assert.equal(state.cursor, 1);
    assert.equal(state.used, 1);
  });
});
