import { NextResponse } from "next/server";

import type { CollectedResponse, MapEstimate } from "@/lib/collected-view";
import { GRID_STEP } from "@/lib/europe-grid";
import {
  readCursor,
  readEstimates,
  STORED_ROOM_TYPE_CATEGORIES,
  summarizeRuns,
  type EstimateSource,
  type StoredRoomTypeCategory,
} from "@/lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Gross estimates already in the JSON store, one currency at a time.
 * This route does not call Airbnb and does not write the store.
 */
export function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const roomParam = params.get("roomType") ?? "ENTIRE_HOME";
  if (!STORED_ROOM_TYPE_CATEGORIES.includes(roomParam as StoredRoomTypeCategory)) {
    return NextResponse.json({ error: "Invalid room type" }, { status: 400 });
  }
  const roomType = roomParam as StoredRoomTypeCategory;

  const estimates = readEstimates();
  const byCurrency = new Map<string, number>();
  for (const estimate of estimates) {
    byCurrency.set(estimate.currency, (byCurrency.get(estimate.currency) ?? 0) + 1);
  }
  const currencies = [...byCurrency.entries()]
    .map(([currency, count]) => ({ currency, count }))
    .sort((a, b) => b.count - a.count || a.currency.localeCompare(b.currency));

  const requested = params.get("currency")?.trim().toUpperCase();
  const currency = requested || currencies[0]?.currency || "EUR";
  const matched = estimates.filter(
    (estimate) => estimate.currency === currency && estimate.roomTypeCategory === roomType,
  );

  const cells: MapEstimate[] = matched.map((estimate) => ({
    cellId: estimate.cellId,
    latitude: estimate.latitude,
    longitude: estimate.longitude,
    cellHeight: GRID_STEP,
    cellWidth: GRID_STEP,
    monthly: estimate.monthly,
    nightly: estimate.nightly,
    nights: estimate.nights,
    currency: estimate.currency,
    roomTypeCategory: estimate.roomTypeCategory,
    bedrooms: estimate.bedrooms,
    source: estimate.source,
    fetchedAt: estimate.fetchedAt,
  }));

  const counts = new Map<EstimateSource, number>();
  for (const cell of cells) counts.set(cell.source, (counts.get(cell.source) ?? 0) + 1);

  const cursor = readCursor();
  const runs = summarizeRuns();
  const progress =
    cursor || runs.runs > 0
      ? {
          nextIndex: cursor?.nextIndex ?? 0,
          total: cursor?.total ?? 0,
          stopReason: cursor?.stopReason ?? runs.lastStopReason,
          lastRunAt: runs.lastRunAt,
        }
      : null;

  const body: CollectedResponse = {
    revenueBasis: "gross",
    currency,
    roomType,
    cellDegrees: GRID_STEP,
    cells,
    currencies: currencies.length > 0 ? currencies : [{ currency, count: 0 }],
    counts: [...counts.entries()].map(([source, count]) => ({ source, count })),
    progress,
  };

  return NextResponse.json(body, {
    headers: { "cache-control": "no-store" },
  });
}
