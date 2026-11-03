/**
 * Client for Airbnb's `GetHostEstimateData` GraphQL operation — the query that
 * powers the "how much could you earn?" figure on airbnb.com/host/homes.
 *
 * It is undocumented but unauthenticated: the only credential is the public web
 * API key that ships in Airbnb's own front-end bundle. Two properties make it
 * usable as a heatmap source:
 *
 *  1. `location.searchQuery` accepts a raw "lat,lng" string, so we can sample an
 *     arbitrary coordinate grid instead of being limited to named places.
 *  2. Every response also carries ~20 nearby comparable listings with their own
 *     coordinates and nightly prices.
 *
 * Being undocumented, it can change without notice. Everything here degrades to
 * a null cell rather than throwing, so one bad point never fails a whole scan.
 */

export const AIRBNB_API_KEY = "d306zoyjsyarp7ifhu67rjxn52tv0t20";
export const HOST_ESTIMATE_HASH =
  "a929d4d832695d0dc9344afb283387ecc8140f6e58b5a1949051898afe6e1167";

export const ROOM_TYPE_CATEGORIES = ["ENTIRE_HOME", "PRIVATE_ROOM"] as const;
export type RoomTypeCategory = (typeof ROOM_TYPE_CATEGORIES)[number];

export type EstimateQuery = {
  /** Either a place name ("Lisbon") or a "lat,lng" pair. */
  searchQuery: string;
  roomTypeCategory: RoomTypeCategory;
  bedrooms: number;
  currency: string;
};

export type Comparable = {
  id: string;
  latitude: number;
  longitude: number;
  nightly: number;
  title: string;
  rating: number | null;
  reviews: number;
  superhost: boolean;
  url: string;
};

export type Estimate = {
  /** Average monthly earnings Airbnb reports for the area. */
  monthly: number;
  nightly: number;
  /** Nights booked per month for homes available all month. */
  nights: number;
  currency: string;
  /** Airbnb's own wording, e.g. "19 similar listings in Poprad". */
  description: string | null;
  locationName: string | null;
  comparables: Comparable[];
  bounds: {
    north: number;
    south: number;
    east: number;
    west: number;
  } | null;
};

/** Airbnb returns display strings like "€1,234" or "¥292,115 JPY". */
function parseAmount(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = value.replace(/\s/g, "").match(/-?[\d,.]+/);
  if (!match) return null;
  const raw = match[0];

  // Distinguish "1.234,56" (European) from "1,234.56" (English). We request
  // locale=en, so a comma is a thousands separator unless it is the only
  // separator and trails exactly two digits.
  const normalized = /,\d{1,2}$/.test(raw)
    ? raw.replace(/\./g, "").replace(",", ".")
    : raw.replace(/,/g, "");

  const num = Number(normalized);
  return Number.isFinite(num) ? num : null;
}

function buildUrl(query: EstimateQuery): URL {
  const variables = {
    durationGranularity: ["MONTHLY"],
    source: "HOST_LANDING_PAGE",
    location: { searchQuery: query.searchQuery },
    roomTypeCategory: query.roomTypeCategory,
    bedroom: query.bedrooms,
    fetchDebugInfo: false,
  };

  const url = new URL(
    `https://www.airbnb.com/api/v3/GetHostEstimateData/${HOST_ESTIMATE_HASH}`,
  );
  url.searchParams.set("operationName", "GetHostEstimateData");
  url.searchParams.set("locale", "en");
  url.searchParams.set("currency", query.currency);
  url.searchParams.set("variables", JSON.stringify(variables));
  url.searchParams.set(
    "extensions",
    JSON.stringify({
      persistedQuery: { version: 1, sha256Hash: HOST_ESTIMATE_HASH },
    }),
  );
  return url;
}

type RawScreen = {
  header?: {
    sections?: { value?: string }[];
  };
  description?: string | null;
  locationDetails?: { fullAddress?: string; shortName?: string } | null;
  mapMarkers?: {
    coordinate?: { latitude?: number; longitude?: number };
    listingCard?: {
      id?: string;
      amount?: number;
      title?: string;
      avgRating?: number | null;
      numReviews?: number;
      isSuperhost?: boolean;
      pdpUrl?: string;
    };
  }[];
  suggestedMapBounds?: {
    northeast?: { latitude?: number; longitude?: number };
    southwest?: { latitude?: number; longitude?: number };
  } | null;
};

function toEstimate(screen: RawScreen, currency: string): Estimate | null {
  const sections = screen.header?.sections ?? [];
  const monthly = parseAmount(sections[0]?.value);
  const nightly = parseAmount(sections[1]?.value);
  const nights = parseAmount(sections[2]?.value);

  // Areas with no comparable supply (open water, farmland) come back as a
  // well-formed response with empty sections.
  if (monthly === null || nightly === null) return null;

  const comparables: Comparable[] = [];
  for (const marker of screen.mapMarkers ?? []) {
    const card = marker.listingCard;
    const lat = marker.coordinate?.latitude;
    const lng = marker.coordinate?.longitude;
    if (!card?.id || typeof lat !== "number" || typeof lng !== "number") continue;
    if (typeof card.amount !== "number") continue;

    comparables.push({
      id: card.id,
      latitude: lat,
      longitude: lng,
      nightly: card.amount,
      title: card.title ?? "Airbnb listing",
      rating: typeof card.avgRating === "number" ? card.avgRating : null,
      reviews: card.numReviews ?? 0,
      superhost: Boolean(card.isSuperhost),
      url: card.pdpUrl ? `https://www.airbnb.com${card.pdpUrl}` : "https://www.airbnb.com",
    });
  }

  const ne = screen.suggestedMapBounds?.northeast;
  const sw = screen.suggestedMapBounds?.southwest;
  const bounds =
    typeof ne?.latitude === "number" &&
    typeof ne?.longitude === "number" &&
    typeof sw?.latitude === "number" &&
    typeof sw?.longitude === "number"
      ? { north: ne.latitude, east: ne.longitude, south: sw.latitude, west: sw.longitude }
      : null;

  return {
    monthly,
    nightly,
    nights: nights ?? 0,
    currency,
    description: screen.description ?? null,
    locationName: screen.locationDetails?.fullAddress ?? screen.locationDetails?.shortName ?? null,
    comparables,
    bounds,
  };
}

export class AirbnbHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Airbnb responded ${status}`);
    this.name = "AirbnbHttpError";
    this.status = status;
  }
}

export async function fetchEstimate(
  query: EstimateQuery,
  signal?: AbortSignal,
): Promise<Estimate | null> {
  const res = await fetch(buildUrl(query), {
    headers: {
      "X-Airbnb-API-Key": AIRBNB_API_KEY,
      accept: "*/*",
      "accept-language": "en-US,en;q=0.9",
    },
    signal,
  });

  if (!res.ok) throw new AirbnbHttpError(res.status);

  const json = (await res.json()) as {
    errors?: unknown[];
    data?: { presentation?: { hostEstimate?: { hostEstimateScreen?: RawScreen } } };
  };

  if (json.errors?.length) {
    throw new Error(`Airbnb GraphQL error: ${JSON.stringify(json.errors).slice(0, 200)}`);
  }

  const screen = json.data?.presentation?.hostEstimate?.hostEstimateScreen;
  return screen ? toEstimate(screen, query.currency) : null;
}

export function coordQuery(lat: number, lng: number): string {
  return `${lat.toFixed(4)},${lng.toFixed(4)}`;
}

/** Retries transient failures; a null result is a valid "no supply here". */
export async function fetchEstimateWithRetry(
  query: EstimateQuery,
  attempts = 3,
  signal?: AbortSignal,
): Promise<Estimate | null> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fetchEstimate(query, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** attempt));
    }
  }
  throw lastError;
}
