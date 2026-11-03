import { ROOM_TYPE_CATEGORIES, type RoomTypeCategory } from "@/lib/airbnb-estimate";
import type { CollectedResponse } from "@/lib/estimate-record";
import { getStore } from "@/lib/estimate-store";

export const dynamic = "force-dynamic";

/**
 * Gross estimates accumulated by live scans and `npm run collect`.
 * One currency at a time: figures are not converted.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const roomParam = params.get("roomType") ?? "ENTIRE_HOME";
  if (!ROOM_TYPE_CATEGORIES.includes(roomParam as RoomTypeCategory)) {
    return Response.json({ error: "Invalid room type" }, { status: 400 });
  }
  const roomType = roomParam as RoomTypeCategory;

  const store = getStore();
  const currencies = store.currencies();
  const requested = params.get("currency")?.toUpperCase();
  const currency = requested || currencies[0]?.currency || "USD";

  const body: CollectedResponse = {
    revenueBasis: "gross",
    currency,
    roomType,
    cells: store.mapCells(currency, roomType),
    currencies,
    counts: store.sourceCounts(currency, roomType),
    progress: store.latestProgress(),
  };

  return Response.json(body, {
    headers: { "cache-control": "no-store" },
  });
}
