import type { EstimateSource, StoredRoomTypeCategory } from "./store";

/** A stored gross cell the world map can paint. One currency, never converted. */
export type MapEstimate = {
  cellId: string;
  latitude: number;
  longitude: number;
  /** Degrees. The Europe collector samples a 0.5° cell. */
  cellHeight: number;
  cellWidth: number;
  /** Gross booking revenue for a month. */
  monthly: number;
  nightly: number;
  nights: number;
  currency: string;
  roomTypeCategory: StoredRoomTypeCategory;
  bedrooms: number;
  source: EstimateSource;
  fetchedAt: string;
};

export type CollectedProgress = {
  nextIndex: number;
  total: number;
  stopReason: string | null;
  lastRunAt: string | null;
};

export type CollectedResponse = {
  /** Every figure in `cells` is gross booking revenue, never host profit. */
  revenueBasis: "gross";
  currency: string;
  roomType: StoredRoomTypeCategory;
  cellDegrees: number;
  cells: MapEstimate[];
  currencies: { currency: string; count: number }[];
  counts: { source: EstimateSource; count: number }[];
  progress: CollectedProgress | null;
};
