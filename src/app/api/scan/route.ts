import {
  ROOM_TYPE_CATEGORIES,
  coordQuery,
  fetchEstimateWithRetry,
  type RoomTypeCategory,
} from "@/lib/airbnb-estimate";
import {
  buildGrid,
  isValidBounds,
  type ScanEvent,
  type ScanRequest,
} from "@/lib/scan";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Airbnb tolerates this comfortably; going wider risks looking like an attack. */
const CONCURRENCY = 8;

function encodeEvent(event: ScanEvent): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(event)}\n`);
}

export async function POST(request: Request) {
  let body: ScanRequest;
  try {
    body = (await request.json()) as ScanRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { bounds, resolution, bedrooms, currency } = body;
  const roomTypeCategory = body.roomTypeCategory as RoomTypeCategory;

  if (!bounds || !isValidBounds(bounds)) {
    return Response.json({ error: "Invalid map bounds" }, { status: 400 });
  }
  if (!ROOM_TYPE_CATEGORIES.includes(roomTypeCategory)) {
    return Response.json({ error: "Invalid room type" }, { status: 400 });
  }
  if (!Number.isInteger(bedrooms) || bedrooms < 0 || bedrooms > 8) {
    return Response.json({ error: "Bedrooms must be between 0 and 8" }, { status: 400 });
  }

  const grid = buildGrid(bounds, Math.min(20, Math.max(4, Math.round(resolution || 8))));
  const startedAt = Date.now();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: ScanEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encodeEvent(event));
        } catch {
          closed = true;
        }
      };

      send({
        type: "meta",
        total: grid.points.length,
        rows: grid.rows,
        cols: grid.cols,
        cellHeight: grid.cellHeight,
        cellWidth: grid.cellWidth,
        currency: currency || "USD",
      });

      let filled = 0;
      let empty = 0;
      let failed = 0;
      let cursor = 0;

      const worker = async () => {
        while (cursor < grid.points.length) {
          if (request.signal.aborted) return;
          const point = grid.points[cursor++];

          try {
            const estimate = await fetchEstimateWithRetry(
              {
                searchQuery: coordQuery(point.latitude, point.longitude),
                roomTypeCategory,
                bedrooms,
                currency: currency || "USD",
              },
              3,
              request.signal,
            );

            if (!estimate) {
              empty++;
              send({ type: "empty", index: point.index });
              continue;
            }

            filled++;
            send({
              type: "cell",
              cell: {
                index: point.index,
                latitude: point.latitude,
                longitude: point.longitude,
                monthly: estimate.monthly,
                nightly: estimate.nightly,
                nights: estimate.nights,
              },
              comparables: estimate.comparables,
            });
          } catch (error) {
            if (request.signal.aborted) return;
            failed++;
            send({
              type: "error",
              index: point.index,
              message: error instanceof Error ? error.message : "Request failed",
            });
          }
        }
      };

      await Promise.all(Array.from({ length: CONCURRENCY }, worker));

      send({ type: "done", filled, empty, failed, elapsedMs: Date.now() - startedAt });
      if (!closed) controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
