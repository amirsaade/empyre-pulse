import type { MarketDataset, ModelParams } from "./types";

/**
 * The "San Francisco Model", the occupancy estimator Inside Airbnb publishes.
 *
 * Airbnb does not disclose bookings, so we work backwards from reviews: only a
 * fraction of stays leave one, so `reviews / reviewRate` approximates bookings.
 * Multiply by a typical stay length to get nights, cap occupancy so that
 * listings with unusual review volume cannot exceed a plausible ceiling, then
 * multiply by nightly price.
 *
 * This is an estimate of gross booking value, not take-home profit: it excludes
 * cleaning fees, Airbnb's host fee, seasonality and discounts.
 */
export function estimateNightsBooked(
  reviewsLtm: number,
  minNights: number,
  { reviewRate, averageStay, maxOccupancy }: ModelParams,
): number {
  const bookings = reviewsLtm / reviewRate;
  // Long-stay listings inflate nights fast, so treat a 30-night minimum as a
  // month-long booking at most rather than trusting extreme values.
  const nightsPerBooking = Math.min(Math.max(minNights, averageStay), 30);
  return Math.min(bookings * nightsPerBooking, 365 * maxOccupancy);
}

export function estimateAnnualRevenue(
  reviewsLtm: number,
  minNights: number,
  price: number,
  model: ModelParams,
): number {
  return estimateNightsBooked(reviewsLtm, minNights, model) * price;
}

/** Revenue for every listing in a dataset, in the dataset's own order. */
export function computeRevenue(
  dataset: MarketDataset,
  model: ModelParams,
): Float64Array {
  const out = new Float64Array(dataset.count);
  for (let i = 0; i < dataset.count; i++) {
    out[i] = estimateAnnualRevenue(
      dataset.reviewsLtm[i],
      dataset.minNights[i],
      dataset.price[i],
      model,
    );
  }
  return out;
}

export function median(values: number[] | Float64Array): number {
  if (values.length === 0) return 0;
  const sorted = Float64Array.from(values).sort();
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

export function percentile(sorted: Float64Array, p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[idx];
}
