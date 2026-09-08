import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import marketsJson from "@/data/markets.json";
import { parseCsv } from "./csv";
import { ROOM_TYPES, type Market, type MarketDataset } from "./types";

export const MARKETS = marketsJson as Market[];

const MARKETS_BY_SLUG = new Map(MARKETS.map((m) => [m.slug, m]));

export function getMarket(slug: string): Market | undefined {
  return MARKETS_BY_SLUG.get(slug);
}

/** Datasets are large and immutable per scrape, so keep them off the hot path. */
const CACHE_DIR = path.join(process.cwd(), ".cache", "markets");
const memoryCache = new Map<string, MarketDataset>();

function cachePath(market: Market) {
  return path.join(CACHE_DIR, `${market.slug}-${market.scrapedAt}.json`);
}

/** Snapshots committed to the repo so the app works with no network. */
function snapshotPath(market: Market) {
  return path.join(process.cwd(), "data", "snapshots", `${market.slug}.json`);
}

function num(value: string | undefined): number {
  if (!value) return Number.NaN;
  // Some locales export prices as "1.234,00"; the summary CSVs use plain
  // numbers but may still carry currency symbols or thousands separators.
  const cleaned = value.replace(/[^0-9.\-]/g, "");
  return cleaned === "" ? Number.NaN : Number(cleaned);
}

export function buildDataset(market: Market, csv: string): MarketDataset {
  const rows = parseCsv(csv);
  if (rows.length < 2) throw new Error("Empty listings CSV");

  const header = rows[0].map((h) => h.trim());
  const col = (name: string) => header.indexOf(name);

  const iLat = col("latitude");
  const iLng = col("longitude");
  const iPrice = col("price");
  const iMinNights = col("minimum_nights");
  const iReviewsLtm = col("number_of_reviews_ltm");
  const iReviewsTotal = col("number_of_reviews");
  const iAvailability = col("availability_365");
  const iRoomType = col("room_type");
  const iNeighbourhood = col("neighbourhood");
  const iHostListings = col("calculated_host_listings_count");

  if (iLat < 0 || iLng < 0 || iPrice < 0) {
    throw new Error("Unexpected CSV columns from Inside Airbnb");
  }

  const neighbourhoods: string[] = [];
  const neighbourhoodIndex = new Map<string, number>();

  const dataset: MarketDataset = {
    market,
    count: 0,
    skipped: 0,
    center: { longitude: 0, latitude: 0 },
    neighbourhoods,
    lat: [],
    lng: [],
    price: [],
    minNights: [],
    reviewsLtm: [],
    reviewsTotal: [],
    availability: [],
    roomType: [],
    neighbourhood: [],
    hostListings: [],
  };

  let latSum = 0;
  let lngSum = 0;

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.length <= iPrice) continue;

    const lat = num(row[iLat]);
    const lng = num(row[iLng]);
    const price = num(row[iPrice]);

    // A missing price means the listing had no availability when scraped, so
    // there is nothing to estimate earnings from.
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(price) || price <= 0) {
      dataset.skipped++;
      continue;
    }

    const name = (iNeighbourhood >= 0 ? row[iNeighbourhood] : "")?.trim() || "Unknown";
    let nIdx = neighbourhoodIndex.get(name);
    if (nIdx === undefined) {
      nIdx = neighbourhoods.push(name) - 1;
      neighbourhoodIndex.set(name, nIdx);
    }

    const roomTypeIdx = ROOM_TYPES.indexOf(
      (row[iRoomType]?.trim() ?? "") as (typeof ROOM_TYPES)[number],
    );

    dataset.lat.push(Math.round(lat * 1e5) / 1e5);
    dataset.lng.push(Math.round(lng * 1e5) / 1e5);
    dataset.price.push(Math.round(price));
    dataset.minNights.push(Math.max(1, num(row[iMinNights]) || 1));
    dataset.reviewsLtm.push(Math.max(0, num(row[iReviewsLtm]) || 0));
    dataset.reviewsTotal.push(Math.max(0, num(row[iReviewsTotal]) || 0));
    dataset.availability.push(Math.max(0, num(row[iAvailability]) || 0));
    dataset.roomType.push(roomTypeIdx < 0 ? 0 : roomTypeIdx);
    dataset.neighbourhood.push(nIdx);
    dataset.hostListings.push(Math.max(1, num(row[iHostListings]) || 1));

    latSum += lat;
    lngSum += lng;
    dataset.count++;
  }

  if (dataset.count === 0) throw new Error("No usable listings in CSV");

  dataset.center = {
    latitude: latSum / dataset.count,
    longitude: lngSum / dataset.count,
  };

  return dataset;
}

async function readJsonIfPresent(file: string): Promise<MarketDataset | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as MarketDataset;
  } catch {
    return null;
  }
}

export async function loadDataset(market: Market): Promise<{
  dataset: MarketDataset;
  source: "memory" | "cache" | "network" | "snapshot";
}> {
  const cached = memoryCache.get(market.slug);
  if (cached) return { dataset: cached, source: "memory" };

  const onDisk = await readJsonIfPresent(cachePath(market));
  if (onDisk) {
    memoryCache.set(market.slug, onDisk);
    return { dataset: onDisk, source: "cache" };
  }

  try {
    const res = await fetch(market.summaryUrl, {
      headers: {
        "user-agent":
          "airbnb-earnings-heatmap/1.0 (open source; https://insideairbnb.com data)",
      },
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`Inside Airbnb responded ${res.status}`);

    const dataset = buildDataset(market, await res.text());
    memoryCache.set(market.slug, dataset);

    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(cachePath(market), JSON.stringify(dataset), "utf8");

    return { dataset, source: "network" };
  } catch (error) {
    const snapshot = await readJsonIfPresent(snapshotPath(market));
    if (snapshot) {
      memoryCache.set(market.slug, snapshot);
      return { dataset: snapshot, source: "snapshot" };
    }
    throw error;
  }
}
