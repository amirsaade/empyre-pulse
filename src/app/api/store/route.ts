import { NextResponse } from "next/server";

import { readCursor, readEstimates, readRuns, summarizeRuns } from "@/lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Read-only view of the committed collect store. Cells are gross booking
 * figures. This route never calls Airbnb and never writes the store.
 */
export function GET() {
  try {
    const cells = readEstimates();
    return NextResponse.json(
      {
        cells,
        cellCount: cells.length,
        cursor: readCursor(),
        runLog: summarizeRuns(readRuns()),
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not read the collected store";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
