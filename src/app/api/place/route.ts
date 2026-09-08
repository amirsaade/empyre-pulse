import { fetchEstimateWithRetry } from "@/lib/airbnb-estimate";
import { boundsAround, padBounds, type Bounds } from "@/lib/scan";

export const dynamic = "force-dynamic";

/**
 * Resolves a place name to a scan area. Airbnb's estimate response includes the
 * bounding box of the comparables it found, which is a better starting frame
 * than a generic geocoder: it lands on where the short-term rental supply
 * actually is.
 */
export async function GET(request: Request) {
  const query = new URL(request.url).searchParams.get("q")?.trim();
  if (!query) {
    return Response.json({ error: "Missing ?q=" }, { status: 400 });
  }

  const currency = new URL(request.url).searchParams.get("currency") ?? "USD";

  try {
    const estimate = await fetchEstimateWithRetry({
      searchQuery: query,
      roomTypeCategory: "ENTIRE_HOME",
      bedrooms: 2,
      currency,
    });

    if (!estimate) {
      return Response.json(
        { error: `Airbnb has no listing data for "${query}".` },
        { status: 404 },
      );
    }

    let bounds: Bounds | null = estimate.bounds ? padBounds(estimate.bounds) : null;

    // Sparse areas can return comparables without a bounding box; fall back to
    // a box centred on the average comparable position.
    if (!bounds && estimate.comparables.length > 0) {
      const lat =
        estimate.comparables.reduce((sum, c) => sum + c.latitude, 0) /
        estimate.comparables.length;
      const lng =
        estimate.comparables.reduce((sum, c) => sum + c.longitude, 0) /
        estimate.comparables.length;
      bounds = boundsAround(lat, lng, 12);
    }

    if (!bounds) {
      return Response.json(
        { error: `Could not work out a map area for "${query}".` },
        { status: 404 },
      );
    }

    return Response.json({
      name: estimate.locationName ?? query,
      description: estimate.description,
      bounds,
      headline: {
        monthly: estimate.monthly,
        nightly: estimate.nightly,
        nights: estimate.nights,
        currency: estimate.currency,
      },
    });
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Airbnb lookup failed",
      },
      { status: 502 },
    );
  }
}
