const compactCache = new Map<string, Intl.NumberFormat>();
const exactCache = new Map<string, Intl.NumberFormat>();

function formatter(cache: Map<string, Intl.NumberFormat>, key: string, make: () => Intl.NumberFormat) {
  let cached = cache.get(key);
  if (!cached) {
    cached = make();
    cache.set(key, cached);
  }
  return cached;
}

/** "$48K" — for dense labels like map legends and stat tiles. */
export function formatCompactMoney(value: number, currency: string): string {
  return formatter(compactCache, currency, () =>
    new Intl.NumberFormat("en", {
      style: "currency",
      currency,
      notation: "compact",
      maximumFractionDigits: 1,
    }),
  ).format(value);
}

/** "$48,320" — for tooltips and tables where precision reads better. */
export function formatMoney(value: number, currency: string): string {
  return formatter(exactCache, currency, () =>
    new Intl.NumberFormat("en", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }),
  ).format(value);
}

export function formatCount(value: number): string {
  return new Intl.NumberFormat("en").format(Math.round(value));
}

export function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function formatScrapeDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}
