import type { RoomTypeCategory } from "./airbnb-estimate";
import type { StoredEstimate } from "./estimate-record";
import { UNSPECIFIED_BEDROOMS } from "./estimate-record";
import { estimateAnnualRevenue, estimateNightsBooked, median } from "./revenue";
import { DEFAULT_MODEL, type MarketDataset, type ModelParams } from "./types";
import { CELL_DEGREES, worldCellAt } from "./world-grid";

const ROOM_TO_CATEGORY: Record<number, RoomTypeCategory | undefined> = {
  0: "ENTIRE_HOME",
  1: "PRIVATE_ROOM",
};

/**
 * Rolls a market's listings into the world grid. Revenue is the San Francisco
 * Model's gross annual booking value divided by 12, so it can sit next to
 * Airbnb's own monthly gross figure. Shared rooms and hotel rooms are skipped:
 * the live endpoint only answers for entire homes and private rooms.
 */
export function aggregateMarketCells(
  dataset: MarketDataset,
  model: ModelParams = DEFAULT_MODEL,
  fetchedAt = new Date().toISOString(),
): StoredEstimate[] {
  type Bucket = {
    cellId: string;
    latitude: number;
    longitude: number;
    roomType: RoomTypeCategory;
    monthly: number[];
    nightly: number[];
    nights: number[];
  };

  const buckets = new Map<string, Bucket>();

  for (let i = 0; i < dataset.count; i++) {
    const roomType = ROOM_TO_CATEGORY[dataset.roomType[i]];
    if (!roomType) continue;

    const cell = worldCellAt(dataset.lat[i], dataset.lng[i]);
    const key = `${cell.id}|${roomType}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        cellId: cell.id,
        latitude: cell.latitude,
        longitude: cell.longitude,
        roomType,
        monthly: [],
        nightly: [],
        nights: [],
      };
      buckets.set(key, bucket);
    }

    const nightsYear = estimateNightsBooked(dataset.reviewsLtm[i], dataset.minNights[i], model);
    const annual = estimateAnnualRevenue(
      dataset.reviewsLtm[i],
      dataset.minNights[i],
      dataset.price[i],
      model,
    );
    bucket.monthly.push(annual / 12);
    bucket.nightly.push(dataset.price[i]);
    bucket.nights.push(nightsYear / 12);
  }

  const currency = dataset.market.currency.toUpperCase();
  const rows: StoredEstimate[] = [];
  for (const bucket of buckets.values()) {
    rows.push({
      cellId: bucket.cellId,
      latitude: bucket.latitude,
      longitude: bucket.longitude,
      cellHeight: CELL_DEGREES,
      cellWidth: CELL_DEGREES,
      monthly: median(bucket.monthly),
      nightly: median(bucket.nightly),
      nights: median(bucket.nights),
      currency,
      roomType: bucket.roomType,
      bedrooms: UNSPECIFIED_BEDROOMS,
      source: "inside-airbnb",
      fetchedAt,
      status: "estimate",
      sampleSize: bucket.monthly.length,
      marketSlug: dataset.market.slug,
    });
  }
  return rows;
}
