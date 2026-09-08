// Regenerates src/data/markets.json from the Inside Airbnb "Get the Data" index.
// Run with: npm run build:catalog

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const INDEX_URL = "https://insideairbnb.com/get-the-data/";
const OUT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "data",
  "markets.json",
);

// Inside Airbnb reports `price` in each market's local currency and never states
// which one, so we derive it from the country segment of the download URL.
const CURRENCY_BY_COUNTRY = {
  argentina: "ARS",
  australia: "AUD",
  austria: "EUR",
  belgium: "EUR",
  belize: "BZD",
  brazil: "BRL",
  canada: "CAD",
  chile: "CLP",
  china: "CNY",
  colombia: "COP",
  croatia: "EUR",
  "czech-republic": "CZK",
  denmark: "DKK",
  france: "EUR",
  germany: "EUR",
  greece: "EUR",
  "hong-kong": "HKD",
  hungary: "HUF",
  iceland: "ISK",
  india: "INR",
  ireland: "EUR",
  israel: "ILS",
  italy: "EUR",
  japan: "JPY",
  malaysia: "MYR",
  malta: "EUR",
  mexico: "MXN",
  morocco: "MAD",
  "new-zealand": "NZD",
  norway: "NOK",
  poland: "PLN",
  portugal: "EUR",
  romania: "RON",
  singapore: "SGD",
  "south-africa": "ZAR",
  "south-korea": "KRW",
  spain: "EUR",
  sweden: "SEK",
  switzerland: "CHF",
  taiwan: "TWD",
  thailand: "THB",
  "the-netherlands": "EUR",
  turkey: "TRY",
  "united-kingdom": "GBP",
  "united-states": "USD",
  uruguay: "UYU",
};

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

function isoDate(text) {
  const m = /^(\d{1,2})\s+([A-Za-z]+),\s*(\d{4})$/.exec(text.trim());
  if (!m) return null;
  const month = MONTHS[m[2].toLowerCase()];
  if (!month) return null;
  return `${m[3]}-${String(month).padStart(2, "0")}-${String(m[1]).padStart(2, "0")}`;
}

function slugify(value) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

const html = await fetch(INDEX_URL, {
  headers: { "user-agent": "airbnb-earnings-heatmap/1.0 (open source; insideairbnb catalog)" },
}).then((res) => {
  if (!res.ok) throw new Error(`Inside Airbnb index returned ${res.status}`);
  return res.text();
});

// Each market is an <h3>City, Region, Country</h3> followed by an <h4>date</h4>
// and a table whose rows link to that scrape's files.
const sectionRe =
  /<h3>([^<]+)<\/h3>\s*<h4>([^<]*?)<span>([\s\S]*?)<\/h4>([\s\S]*?)<\/table>/g;

const markets = [];
const seen = new Set();

for (const match of html.matchAll(sectionRe)) {
  const heading = match[1].trim();
  const scrapedAt = isoDate(match[2]);
  const table = match[4];

  const summaryUrl = table.match(
    /https:\/\/data\.insideairbnb\.com\/[^"']*?\/visualisations\/listings\.csv/,
  )?.[0];
  if (!summaryUrl || !scrapedAt) continue;

  const [countrySlug] = new URL(decodeURIComponent(summaryUrl)).pathname
    .split("/")
    .filter(Boolean);

  const [city, ...rest] = heading.split(",").map((s) => s.trim());
  const region = rest.length > 1 ? rest[0] : null;
  const slug = slugify(`${city}-${region ?? rest[0] ?? countrySlug}`);
  if (seen.has(slug)) continue;
  seen.add(slug);

  markets.push({
    slug,
    city,
    region,
    country: rest.length ? rest[rest.length - 1] : countrySlug,
    scrapedAt,
    currency: CURRENCY_BY_COUNTRY[countrySlug] ?? "USD",
    summaryUrl,
    neighbourhoodsUrl: summaryUrl.replace("listings.csv", "neighbourhoods.geojson"),
  });
}

markets.sort((a, b) => a.city.localeCompare(b.city));

if (markets.length < 50) {
  throw new Error(`Only parsed ${markets.length} markets — the index layout probably changed.`);
}

await writeFile(OUT, `${JSON.stringify(markets, null, 2)}\n`, "utf8");
console.log(`Wrote ${markets.length} markets to ${path.relative(process.cwd(), OUT)}`);
