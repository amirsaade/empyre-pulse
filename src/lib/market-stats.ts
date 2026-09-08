import { estimateNightsBooked } from "./revenue";
import type { MarketDataset, ModelParams, RoomType } from "./types";
import { ROOM_TYPES } from "./types";

export type MarketFilters = {
  roomType: RoomType | "all";
  activeOnly: boolean;
  minPrice: number;
};

export type ListingPoint = {
  longitude: number;
  latitude: number;
  revenue: number;
  price: number;
  nights: number;
  neighbourhood: string;
  roomType: RoomType;
};

export type NeighbourhoodStat = {
  name: string;
  listings: number;
  medianRevenue: number;
  medianPrice: number;
  medianOccupancy: number;
};

export type MarketSummary = {
  points: ListingPoint[];
  totalRevenue: number;
  medianRevenue: number;
  medianPrice: number;
  neighbourhoods: NeighbourhoodStat[];
};

function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Applies filters and the revenue model in one pass, and rolls the survivors up
 * by neighbourhood. Medians rather than means throughout: a handful of luxury
 * listings otherwise drag a whole neighbourhood's figure upwards.
 */
export function summarizeMarket(
  dataset: MarketDataset,
  model: ModelParams,
  filters: MarketFilters,
): MarketSummary {
  const points: ListingPoint[] = [];
  const revenues: number[] = [];
  const prices: number[] = [];
  const byNeighbourhood = new Map<number, { revenue: number[]; price: number[]; occupancy: number[] }>();
  let totalRevenue = 0;

  const wantedRoomType =
    filters.roomType === "all" ? -1 : ROOM_TYPES.indexOf(filters.roomType);

  for (let i = 0; i < dataset.count; i++) {
    if (wantedRoomType >= 0 && dataset.roomType[i] !== wantedRoomType) continue;
    if (dataset.price[i] < filters.minPrice) continue;
    if (filters.activeOnly && dataset.reviewsLtm[i] <= 0) continue;

    const nights = estimateNightsBooked(dataset.reviewsLtm[i], dataset.minNights[i], model);
    const revenue = nights * dataset.price[i];

    points.push({
      longitude: dataset.lng[i],
      latitude: dataset.lat[i],
      revenue,
      price: dataset.price[i],
      nights,
      neighbourhood: dataset.neighbourhoods[dataset.neighbourhood[i]] ?? "Unknown",
      roomType: ROOM_TYPES[dataset.roomType[i]] ?? ROOM_TYPES[0],
    });

    revenues.push(revenue);
    prices.push(dataset.price[i]);
    totalRevenue += revenue;

    const key = dataset.neighbourhood[i];
    let bucket = byNeighbourhood.get(key);
    if (!bucket) {
      bucket = { revenue: [], price: [], occupancy: [] };
      byNeighbourhood.set(key, bucket);
    }
    bucket.revenue.push(revenue);
    bucket.price.push(dataset.price[i]);
    bucket.occupancy.push(nights / 365);
  }

  const neighbourhoods: NeighbourhoodStat[] = [];
  for (const [key, bucket] of byNeighbourhood) {
    // A couple of listings is not a market signal, it is noise.
    if (bucket.revenue.length < 3) continue;
    neighbourhoods.push({
      name: dataset.neighbourhoods[key] ?? "Unknown",
      listings: bucket.revenue.length,
      medianRevenue: medianOf(bucket.revenue),
      medianPrice: medianOf(bucket.price),
      medianOccupancy: medianOf(bucket.occupancy),
    });
  }
  neighbourhoods.sort((a, b) => b.medianRevenue - a.medianRevenue);

  return {
    points,
    totalRevenue,
    medianRevenue: medianOf(revenues),
    medianPrice: medianOf(prices),
    neighbourhoods,
  };
}
