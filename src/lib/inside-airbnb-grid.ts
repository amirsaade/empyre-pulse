/**
 * Gross figures for grid cells that a local Inside Airbnb dataset already covers.
 * Reads committed snapshots and the on-disk cache only. It does not download.
 *
 * Summary files have no bedroom column, so the configured bedroom count is
 * stored on the record while the sample is every listing of the requested room
 * type in the cell. Monthly and nights are the San Francisco model's annual
 * gross divided by 12, so they line up with Airbnb's monthly host estimate.
 */

import fs from "node:fs";
import path from "node:path";

import {
  GRID_STEP,
  POPULATED_RADIUS_KM,
  formatCellId,
  marketCities,
  orderCells,
  snapToGrid,
  type EuropeCell,
} from "./europe-grid";
import { MARKETS } from "./inside-airbnb";
import { estimateNightsBooked, median } from "./revenue";
import type { StoredRoomTypeCategory } from "./store";
import { DEFAULT_MODEL, ROOM_TYPES, type Market, type MarketDataset } from "./types";

const MIN_SAMPLES = 3;

const ROOM_LABEL: Record<StoredRoomTypeCategory, (typeof ROOM_TYPES)[number]> = {
  ENTIRE_HOME: "Entire home/apt",
  PRIVATE_ROOM: "Private room",
  SHARED_ROOM: "Shared room",
  HOTEL_ROOM: "Hotel room",
};

export type DerivedGross = {
  monthly: number;
  nightly: number;
  nights: number;
  samples: number;
};

type Bbox = { south: number; north: number; west: number; east: number };

export type LocalCoverage = {
  derivable: Map<string, DerivedGross>;
  coveredEmpty: Set<string>;
  /** Stable id of the local files that shaped cell order. */
  stamp: string;
};

export function localDecision(
  cell: EuropeCell,
  coverage: LocalCoverage,
): { kind: "derive"; gross: DerivedGross } | { kind: "covered-empty" } | { kind: "remote" } {
  const derived = coverage.derivable.get(cell.cellId);
  if (derived) return { kind: "derive", gross: derived };
  if (coverage.coveredEmpty.has(cell.cellId)) return { kind: "covered-empty" };
  return { kind: "remote" };
}

export function buildOrderedGrid(
  landCells: readonly EuropeCell[],
  currency: string,
  roomTypeCategory: StoredRoomTypeCategory,
): { cells: EuropeCell[]; coverage: LocalCoverage } {
  const wanted = currency.toUpperCase();
  const european = new Set(marketCities().map((city) => city.slug));
  const derivable = new Map<string, DerivedGross>();
  const bboxes: Bbox[] = [];
  const stampParts: string[] = [];

  for (const market of MARKETS) {
    if (!european.has(market.slug) || market.currency.toUpperCase() !== wanted) continue;
    const dataset = readLocalDataset(market);
    if (!dataset) continue;
    stampParts.push(`${market.slug}@${market.scrapedAt}`);
    const derived = deriveMarket(dataset, roomTypeCategory);
    if (derived.bbox) bboxes.push(derived.bbox);
    for (const [cellId, value] of derived.gross) {
      const existing = derivable.get(cellId);
      if (!existing || value.samples > existing.samples) derivable.set(cellId, value);
    }
  }

  const coveredEmpty = new Set<string>();
  for (const cell of landCells) {
    if (derivable.has(cell.cellId)) continue;
    if (bboxes.some((bbox) => contains(bbox, cell))) coveredEmpty.add(cell.cellId);
  }

  const coverage: LocalCoverage = {
    derivable,
    coveredEmpty,
    stamp: stampParts.length > 0 ? stampParts.sort().join("+") : "none",
  };

  const cells = landCells.map((cell) => {
    const derived = derivable.get(cell.cellId);
    if (derived) return { ...cell, priority: 0, listingCount: derived.samples };
    if (coveredEmpty.has(cell.cellId)) return { ...cell, priority: 1, listingCount: 0 };
    if (cell.cityDistanceKm <= POPULATED_RADIUS_KM) return { ...cell, priority: 2 };
    return { ...cell, priority: 3 };
  });

  return { cells: orderCells(cells), coverage };
}

function contains(bbox: Bbox, cell: EuropeCell): boolean {
  return (
    cell.latitude >= bbox.south &&
    cell.latitude <= bbox.north &&
    cell.longitude >= bbox.west &&
    cell.longitude <= bbox.east
  );
}

function readLocalDataset(market: Market): MarketDataset | null {
  const snapshot = path.join(process.cwd(), "data", "snapshots", `${market.slug}.json`);
  const cache = path.join(
    process.cwd(),
    ".cache",
    "markets",
    `${market.slug}-${market.scrapedAt}.json`,
  );
  const file = fs.existsSync(snapshot) ? snapshot : fs.existsSync(cache) ? cache : null;
  if (!file) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as MarketDataset;
    if (!parsed || parsed.count < 1 || !Array.isArray(parsed.lat)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function deriveMarket(
  dataset: MarketDataset,
  roomTypeCategory: StoredRoomTypeCategory,
): { gross: Map<string, DerivedGross>; bbox: Bbox | null } {
  const roomIdx = ROOM_TYPES.indexOf(ROOM_LABEL[roomTypeCategory]);
  const buckets = new Map<string, { prices: number[]; nights: number[]; monthly: number[] }>();
  let minLat = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  let minLng = Number.POSITIVE_INFINITY;
  let maxLng = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < dataset.count; i += 1) {
    const lat = dataset.lat[i];
    const lng = dataset.lng[i];
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
    minLng = Math.min(minLng, lng);
    maxLng = Math.max(maxLng, lng);
    if (dataset.roomType[i] !== roomIdx) continue;

    const cellId = formatCellId(snapToGrid(lat), snapToGrid(lng));
    const annualNights = estimateNightsBooked(
      dataset.reviewsLtm[i] ?? 0,
      dataset.minNights[i] ?? 1,
      DEFAULT_MODEL,
    );
    const bucket = buckets.get(cellId) ?? { prices: [], nights: [], monthly: [] };
    bucket.prices.push(dataset.price[i]);
    bucket.nights.push(annualNights / 12);
    bucket.monthly.push((annualNights * dataset.price[i]) / 12);
    buckets.set(cellId, bucket);
  }

  const gross = new Map<string, DerivedGross>();
  for (const [cellId, bucket] of buckets) {
    if (bucket.prices.length < MIN_SAMPLES) continue;
    const monthly = Math.round(median(bucket.monthly));
    const nightly = Math.round(median(bucket.prices));
    const nights = Math.round(median(bucket.nights) * 10) / 10;
    if (![monthly, nightly, nights].every((value) => Number.isFinite(value) && value >= 0)) continue;
    gross.set(cellId, { monthly, nightly, nights, samples: bucket.prices.length });
  }

  if (!Number.isFinite(minLat)) return { gross, bbox: null };
  const margin = GRID_STEP / 2;
  return {
    gross,
    bbox: {
      south: minLat - margin,
      north: maxLat + margin,
      west: minLng - margin,
      east: maxLng + margin,
    },
  };
}
