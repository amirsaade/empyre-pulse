import { NextResponse } from "next/server";

import { getMarket, loadDataset } from "@/lib/inside-airbnb";

export const dynamic = "force-dynamic";
// Downloading and parsing a large market can take a while on a cold cache.
export const maxDuration = 300;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const market = getMarket(slug);

  if (!market) {
    return NextResponse.json({ error: `Unknown market "${slug}"` }, { status: 404 });
  }

  try {
    const { dataset, source } = await loadDataset(market);
    return NextResponse.json(dataset, {
      headers: {
        "x-data-source": source,
        "cache-control": "public, max-age=3600",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      {
        error: `Could not load ${market.city} from Inside Airbnb. ${message}`,
      },
      { status: 502 },
    );
  }
}
