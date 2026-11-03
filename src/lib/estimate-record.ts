import type { RoomTypeCategory } from "./airbnb-estimate";

/** Where a stored gross estimate came from. */
export const ESTIMATE_SOURCES = ["inside-airbnb", "GetHostEstimateData"] as const;
export type EstimateSource = (typeof ESTIMATE_SOURCES)[number];

/**
 * Bedroom count the query asked for. Inside Airbnb listings have no bedroom
 * column, so those rows use -1 ("not split by bedrooms").
 */
export const UNSPECIFIED_BEDROOMS = -1;

export type StoredEstimate = {
  cellId: string;
  latitude: number;
  longitude: number;
  /** Degrees, so the world view can draw the cell that was actually sampled. */
  cellHeight: number;
  cellWidth: number;
  /** Gross booking revenue for a month. Null when the source had no supply. */
  monthly: number | null;
  /** Gross nightly rate behind `monthly`. */
  nightly: number | null;
  /** Nights booked per month behind `monthly`. */
  nights: number | null;
  currency: string;
  roomType: RoomTypeCategory;
  bedrooms: number;
  source: EstimateSource;
  fetchedAt: string;
  status: "estimate" | "empty";
  sampleSize: number | null;
  marketSlug: string | null;
};

/** A cell the world map can paint. Always a gross figure, never a net one. */
export type MapEstimate = {
  cellId: string;
  latitude: number;
  longitude: number;
  cellHeight: number;
  cellWidth: number;
  monthly: number;
  nightly: number;
  nights: number;
  currency: string;
  roomType: RoomTypeCategory;
  bedrooms: number;
  source: EstimateSource;
  fetchedAt: string;
  sampleSize: number | null;
  marketSlug: string | null;
};

export type CollectorProgress = {
  queryKey: string;
  gridCursor: number;
  gridLength: number;
  cellDegrees: number;
  lastRunAt: string | null;
  lastStopReason: string | null;
  lastStopDetail: string | null;
  lastAirbnbRequests: number;
  totalAirbnbRequests: number;
  deferred: number;
  updatedAt: string;
};

export type CollectedResponse = {
  /** Every figure in `cells` is gross booking revenue, never host profit. */
  revenueBasis: "gross";
  currency: string;
  roomType: RoomTypeCategory;
  cells: MapEstimate[];
  currencies: { currency: string; count: number }[];
  counts: { source: EstimateSource; count: number }[];
  progress: CollectorProgress | null;
};
