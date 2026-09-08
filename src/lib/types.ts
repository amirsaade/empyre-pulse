export type Market = {
  slug: string;
  city: string;
  region: string | null;
  country: string;
  /** ISO date of the Inside Airbnb scrape this data comes from. */
  scrapedAt: string;
  /** ISO 4217 code. Inside Airbnb reports prices in local currency. */
  currency: string;
  summaryUrl: string;
  neighbourhoodsUrl: string;
};

export const ROOM_TYPES = [
  "Entire home/apt",
  "Private room",
  "Shared room",
  "Hotel room",
] as const;

export type RoomType = (typeof ROOM_TYPES)[number];

/**
 * Columnar layout: every array has `count` entries and index `i` describes the
 * same listing across all of them. Keeps the payload roughly 3x smaller than an
 * array of objects and lets the map read it without reshaping.
 */
export type MarketDataset = {
  market: Market;
  count: number;
  /** Listings dropped for missing price or coordinates. */
  skipped: number;
  center: { longitude: number; latitude: number };
  neighbourhoods: string[];
  lat: number[];
  lng: number[];
  price: number[];
  minNights: number[];
  reviewsLtm: number[];
  reviewsTotal: number[];
  availability: number[];
  /** Index into ROOM_TYPES. */
  roomType: number[];
  /** Index into `neighbourhoods`. */
  neighbourhood: number[];
  /** How many listings the host runs in this market. */
  hostListings: number[];
};

export type ModelParams = {
  /** Share of stays that leave a review. Inside Airbnb's default is 0.5. */
  reviewRate: number;
  /** Floor for nights per booking when the listing has a 1-night minimum. */
  averageStay: number;
  /** Upper bound on occupancy, to stop review-heavy listings running away. */
  maxOccupancy: number;
};

export const DEFAULT_MODEL: ModelParams = {
  reviewRate: 0.5,
  averageStay: 3,
  maxOccupancy: 0.7,
};

export type Filters = {
  roomTypes: RoomType[];
  minPrice: number;
  maxPrice: number | null;
  /** Hide listings with no reviews in the last 12 months. */
  activeOnly: boolean;
  /** Only listings whose host runs this many or more listings in the market. */
  minHostListings: number;
};
