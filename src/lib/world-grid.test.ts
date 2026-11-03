import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { aggregateMarketCells } from "./aggregate-market";
import type { MarketDataset } from "./types";
import {
  cellFromLatLng,
  cellId,
  emptyMask,
  isLand,
  loadWorldGrid,
  orderLandCells,
  reservedBy,
  setLand,
  worldCellAt,
} from "./world-grid";

describe("world grid", () => {
  it("keeps land, drops ocean, and resumes in the same order", () => {
    const mask = emptyMask();
    setLand(mask, 10, 10);
    setLand(mask, 11, 11);
    setLand(mask, 12, 12);
    const population = new Map<string, number>([
      [cellId(12, 12), 50],
      [cellId(10, 10), 5],
    ]);

    const ordered = orderLandCells(mask, population);
    assert.deepEqual(
      ordered.map((cell) => cell.id),
      [cellId(12, 12), cellId(10, 10), cellId(11, 11)],
    );
    assert.equal(isLand(mask, 0, 0), false);

    const cursor = 1;
    const resumed = ordered.slice(cursor);
    assert.equal(resumed[0]?.id, ordered[1]?.id);
    assert.equal(resumed.length, ordered.length - cursor);

    const head = ordered[0];
    assert.ok(head);
    assert.equal(
      reservedBy(head, [
        { slug: "near", latitude: head.latitude, longitude: head.longitude, radiusKm: 20 },
      ]),
      "near",
    );
    assert.equal(
      reservedBy(head, [
        { slug: "far", latitude: head.latitude + 20, longitude: head.longitude, radiusKm: 20 },
      ]),
      null,
    );
  });

  it("round-trips a coordinate to a stable cell id", () => {
    const cell = worldCellAt(48.86, 2.35);
    const again = cellFromLatLng(cell.latitude, cell.longitude);
    assert.equal(cellId(again.row, again.col), cell.id);
    assert.ok(Math.abs(cell.latitude - 48.86) < 1);
    assert.ok(Math.abs(cell.longitude - 2.35) < 1);
  });

  it("loads the committed mask with oceans removed and cities first", () => {
    const mask = new Uint8Array(readFileSync("data/grid/land-mask-1deg.bin"));
    const paris = cellFromLatLng(48.86, 2.35);
    const ocean = cellFromLatLng(0, -40);
    assert.equal(isLand(mask, paris.row, paris.col), true);
    assert.equal(isLand(mask, ocean.row, ocean.col), false);

    const grid = loadWorldGrid();
    assert.equal(grid.anchors.length, 123);
    assert.ok(grid.cells.length > 15_000);
    assert.equal(
      grid.cells.some((cell) => cell.id === cellId(ocean.row, ocean.col)),
      false,
    );

    const tokyo = worldCellAt(35.68, 139.69);
    const sahara = worldCellAt(23.5, 12.5);
    const tokyoIndex = grid.cells.findIndex((cell) => cell.id === tokyo.id);
    const saharaIndex = grid.cells.findIndex((cell) => cell.id === sahara.id);
    assert.ok(tokyoIndex >= 0);
    assert.ok(saharaIndex > tokyoIndex);
  });
});

describe("inside airbnb aggregation", () => {
  it("stores median gross monthly revenue per world cell", () => {
    const dataset: MarketDataset = {
      market: {
        slug: "test-market",
        city: "Test",
        region: null,
        country: "Testland",
        scrapedAt: "2026-01-01",
        currency: "eur",
        summaryUrl: "",
        neighbourhoodsUrl: "",
      },
      count: 4,
      skipped: 0,
      center: { latitude: 48.8, longitude: 2.3 },
      neighbourhoods: ["Centre"],
      lat: [48.86, 48.87, 48.86, 41.4],
      lng: [2.35, 2.36, 2.34, 2.17],
      price: [100, 200, 80, 90],
      minNights: [1, 1, 1, 2],
      reviewsLtm: [10, 0, 4, 6],
      reviewsTotal: [10, 0, 4, 6],
      availability: [100, 100, 100, 100],
      roomType: [0, 0, 2, 1],
      neighbourhood: [0, 0, 0, 0],
      hostListings: [1, 1, 1, 1],
    };

    const rows = aggregateMarketCells(dataset, undefined, "2026-06-01T00:00:00.000Z");
    const entire = rows.find((row) => row.roomType === "ENTIRE_HOME");
    const room = rows.find((row) => row.roomType === "PRIVATE_ROOM");
    assert.ok(entire);
    assert.ok(room);
    assert.equal(rows.length, 2);
    assert.equal(entire.currency, "EUR");
    assert.equal(entire.bedrooms, -1);
    assert.equal(entire.source, "inside-airbnb");
    assert.equal(entire.sampleSize, 2);
    // 10 reviews -> 20 bookings * 3 nights * $100 = $6000/year = $500/month.
    // 0 reviews -> $0/month and a $200 nightly rate. Median of the two.
    assert.equal(entire.monthly, 250);
    assert.equal(entire.nightly, 150);
    assert.equal(entire.status, "estimate");
    assert.equal(room.marketSlug, "test-market");
    assert.notEqual(room.cellId, entire.cellId);
  });
});
