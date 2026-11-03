import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { AirbnbRequestError, type Estimate } from "./airbnb-estimate";
import { runCollector } from "./collector";
import { EstimateStore } from "./estimate-store";
import type { Market } from "./types";
import type { WorldCell } from "./world-grid";

const NOW = Date.parse("2026-06-01T00:00:00.000Z");

const ESTIMATE: Estimate = {
  monthly: 3200,
  nightly: 180,
  nights: 12,
  currency: "USD",
  description: null,
  locationName: null,
  comparables: [],
  bounds: null,
};

const CELLS: WorldCell[] = [
  { id: "g1:100:10", row: 100, col: 10, latitude: 10.5, longitude: -169.5 },
  { id: "g1:100:11", row: 100, col: 11, latitude: 10.5, longitude: -168.5 },
  { id: "g1:100:12", row: 100, col: 12, latitude: 10.5, longitude: -167.5 },
  { id: "g1:100:13", row: 100, col: 13, latitude: 10.5, longitude: -166.5 },
];

const RESERVED: Market = {
  slug: "reserved-ville",
  city: "Reserved",
  region: null,
  country: "Nowhere",
  scrapedAt: "2026-01-01",
  currency: "USD",
  summaryUrl: "https://example.invalid/listings.csv",
  neighbourhoodsUrl: "https://example.invalid/neighbourhoods.geojson",
};

function storePath(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "empyre-collect-")), "estimates.sqlite");
}

function harness(file: string) {
  const calls: string[] = [];
  const gaps: number[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  return {
    calls,
    gaps,
    maxInFlight: () => maxInFlight,
    options: {
      storePath: file,
      cells: CELLS,
      anchors: [] as { slug: string; latitude: number; longitude: number; radiusKm: number }[],
      markets: [] as Market[],
      marketsPerRun: 0,
      budget: 3,
      delayMs: 5_000,
      jitterMs: 2_500,
      freshDays: 30,
      spikeThreshold: 3,
      randomImpl: () => 0,
      now: () => NOW,
      log: () => {},
      sleepImpl: async (ms: number) => {
        gaps.push(ms);
      },
      fetchImpl: async (query: { searchQuery: string }) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        calls.push(query.searchQuery);
        await Promise.resolve();
        inFlight -= 1;
        return ESTIMATE;
      },
    },
  };
}

describe("collector run", () => {
  it("waits between requests and keeps a single request in flight", async () => {
    const run = harness(storePath());
    const summary = await runCollector({
      ...run.options,
      fetchImpl: run.options.fetchImpl,
    });

    assert.equal(summary.airbnbRequests, 3);
    assert.equal(summary.stop, "budget");
    assert.deepEqual(run.gaps, [5_000, 5_000]);
    assert.equal(run.maxInFlight(), 1);
    assert.equal(run.calls.length, 3);
    assert.equal(summary.cursor, 3);
  });

  it("does not refetch a fresh cell on the next run", async () => {
    const file = storePath();
    const first = harness(file);
    await runCollector({ ...first.options, budget: 1 });
    assert.deepEqual(first.calls, ["10.5000,-169.5000"]);

    const second = harness(file);
    const summary = await runCollector({ ...second.options, budget: 1 });
    assert.deepEqual(second.calls, ["10.5000,-168.5000"]);
    assert.equal(summary.cursor, 2);
    assert.equal(second.gaps.length, 0);
  });

  it("stops on the first 429 and will not resume until acknowledged", async () => {
    const file = storePath();
    let calls = 0;
    const stopped = await runCollector({
      ...harness(file).options,
      budget: 5,
      fetchImpl: async () => {
        calls += 1;
        throw new AirbnbRequestError("Airbnb responded 429", 429);
      },
    });
    assert.equal(calls, 1);
    assert.equal(stopped.stop, "http_429");
    assert.equal(stopped.deferred, 1);

    const refused = await runCollector({
      ...harness(file).options,
      fetchImpl: async () => {
        calls += 1;
        return ESTIMATE;
      },
    });
    assert.equal(refused.refused, true);
    assert.equal(calls, 1);

    const resumed = await runCollector({
      ...harness(file).options,
      budget: 1,
      acknowledgeStop: true,
      fetchImpl: async () => {
        calls += 1;
        return ESTIMATE;
      },
    });
    assert.equal(resumed.refused, false);
    assert.equal(calls, 2);
    assert.equal(resumed.airbnbRequests, 1);
  });

  it("backs off and stops the run on an error spike", async () => {
    const run = harness(storePath());
    const summary = await runCollector({
      ...run.options,
      fetchImpl: async () => {
        throw new Error("socket hang up");
      },
    });
    assert.equal(summary.stop, "error_spike");
    assert.equal(summary.airbnbRequests, 3);
    assert.deepEqual(run.gaps, [5_000, 10_000]);
  });

  it("defers cells reserved for Inside Airbnb and skips cells it already covers", async () => {
    const file = storePath();
    const anchor = {
      slug: RESERVED.slug,
      latitude: CELLS[0].latitude,
      longitude: CELLS[0].longitude,
      radiusKm: 50,
    };
    const reserved = harness(file);
    const summary = await runCollector({
      ...reserved.options,
      budget: 1,
      markets: [RESERVED],
      anchors: [anchor],
    });
    assert.deepEqual(reserved.calls, ["10.5000,-168.5000"]);
    assert.equal(summary.deferred, 1);

    const seeded = new EstimateStore(file);
    seeded.upsert({
      cellId: CELLS[2].id,
      latitude: CELLS[2].latitude,
      longitude: CELLS[2].longitude,
      cellHeight: 1,
      cellWidth: 1,
      monthly: 900,
      nightly: 80,
      nights: 8,
      currency: "EUR",
      roomType: "ENTIRE_HOME",
      bedrooms: -1,
      source: "inside-airbnb",
      fetchedAt: new Date(NOW).toISOString(),
      status: "estimate",
      sampleSize: 4,
      marketSlug: "already-covered",
    });
    seeded.close();

    const next = harness(file);
    await runCollector({
      ...next.options,
      budget: 2,
      markets: [RESERVED],
      anchors: [anchor],
    });
    // Cell 0 stays reserved, cell 1 is fresh from the previous run, cell 2 is
    // covered by Inside Airbnb in another currency, so the next call is cell 3.
    assert.deepEqual(next.calls, ["10.5000,-166.5000"]);
  });

  it("refuses to start when the delay would be impolite", async () => {
    let calls = 0;
    await assert.rejects(() =>
      runCollector({
        ...harness(storePath()).options,
        delayMs: 1_000,
        fetchImpl: async () => {
          calls += 1;
          return ESTIMATE;
        },
      }),
    );
    assert.equal(calls, 0);
  });
});
