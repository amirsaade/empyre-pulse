// Builds the committed world-grid inputs the collector walks.
//
//   npm run build:grid
//
// Sources (downloaded into .cache/world-grid-src, public domain):
//   - Natural Earth 110m land polygons
//   - GeoNames cities with population > 15,000
//
// Outputs:
//   data/grid/land-mask-1deg.bin     1° land bitset, bit (row * 360 + col)
//   data/grid/population-1deg.json   max population per land cell [row, col, pop]
//   data/grid/market-anchors.json    Inside Airbnb markets → reservation circles
//
// A cell is land if its center or an edge midpoint falls inside a land polygon,
// so coasts are kept and open ocean is dropped. Reservation circles are how the
// collector avoids calling Airbnb for a cell an unprocessed Inside Airbnb market
// is likely to cover. They are approximate; ingested listings are the real coverage.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const CACHE = path.join(ROOT, ".cache", "world-grid-src");
const OUT = path.join(ROOT, "data", "grid");
const ROWS = 180;
const COLS = 360;

const LAND_URL =
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_land.geojson";
const CITIES_URL = "https://download.geonames.org/export/dump/cities15000.zip";

const COUNTRY_ISO = {
  Argentina: "AR",
  Australia: "AU",
  Austria: "AT",
  Belgium: "BE",
  Belize: "BZ",
  Brazil: "BR",
  Canada: "CA",
  Chile: "CL",
  China: "CN",
  Colombia: "CO",
  "Czech Republic": "CZ",
  Denmark: "DK",
  France: "FR",
  Germany: "DE",
  Greece: "GR",
  Hungary: "HU",
  Ireland: "IE",
  ireland: "IE",
  Italy: "IT",
  Japan: "JP",
  Kenya: "KE",
  Latvia: "LV",
  Mexico: "MX",
  Norway: "NO",
  Portugal: "PT",
  Singapore: "SG",
  "South Africa": "ZA",
  Spain: "ES",
  Sweden: "SE",
  Switzerland: "CH",
  Taiwan: "TW",
  Thailand: "TH",
  "The Netherlands": "NL",
  Turkey: "TR",
  "United Kingdom": "GB",
  "United States": "US",
  malta: "MT",
  "new-zealand": "NZ",
};

/** Names that are regions or spellings GeoNames will not match directly. */
const NAME_ALIASES = {
  "New York City": ["New York City", "New York"],
  Bogotá: ["Bogota"],
  "São Paulo": ["Sao Paulo"],
  "Mexico City": ["Mexico City", "Ciudad de Mexico"],
  "The Hague": ["The Hague", "Den Haag", "s-Gravenhage"],
  "Hong Kong": ["Hong Kong"],
  "Twin Cities MSA": ["Minneapolis"],
  "Clark County": ["Las Vegas"],
  "Broward County": ["Fort Lauderdale"],
  "San Mateo County": ["San Mateo", "Daly City"],
  "Santa Clara County": ["San Jose"],
  "Santa Cruz County": ["Santa Cruz"],
  "Greater Manchester": ["Manchester"],
  Euskadi: ["Bilbao"],
  "Barwon South West": ["Geelong", "Warrnambool"],
  "Mid North Coast": ["Port Macquarie", "Coffs Harbour"],
  "Mornington Peninsula": ["Frankston"],
  "Northern Rivers": ["Lismore", "Byron Bay", "Grafton"],
  "Sunshine Coast": ["Caloundra", "Maroochydore"],
  "Barossa Valley": ["Gawler", "Nuriootpa"],
  "Pacific Grove": ["Monterey", "Pacific Grove"],
  "Pays Basque": ["Bayonne", "Biarritz"],
  "South Aegean": ["Rhodes", "Rodos"],
  Vaud: ["Lausanne"],
  Trentino: ["Trento"],
  Puglia: ["Bari"],
  Sicily: ["Palermo"],
  Crete: ["Irakleion", "Heraklion", "Iraklion"],
  Hawaii: ["Honolulu"],
  Ireland: ["Dublin"],
  "New Zealand": ["Auckland"],
  Tasmania: ["Hobart"],
  "Western Australia": ["Perth"],
  Malta: ["Valletta", "Birkirkara"],
  "New Brunswick": ["Moncton", "Fredericton"],
  "Rhode Island": ["Providence"],
  Mallorca: ["Palma"],
  Menorca: ["Mahon", "Mao"],
  Sevilla: ["Sevilla", "Seville"],
  Malaga: ["Malaga"],
  Zurich: ["Zurich"],
  "Quebec City": ["Quebec", "Quebec City"],
  "Cape Town": ["Cape Town"],
  "Rio de Janeiro": ["Rio de Janeiro"],
  Thessaloniki: ["Thessaloniki"],
  "Fort Worth": ["Fort Worth"],
  "Jersey City": ["Jersey City"],
  "Los Angeles": ["Los Angeles"],
  "San Francisco": ["San Francisco"],
  "San Diego": ["San Diego"],
};

/**
 * Large markets where a 120km city circle would leave covered land for Airbnb.
 * Coordinates are a rough center of the market, not necessarily its biggest city.
 */
const REGION_ANCHORS = {
  "new-zealand-new-zealand": { latitude: -41.2, longitude: 174.0, radiusKm: 1300 },
  "western-australia-western-australia": { latitude: -25.5, longitude: 122.5, radiusKm: 1500 },
  "hawaii-hawaii": { latitude: 20.6, longitude: -157.5, radiusKm: 600 },
  "ireland-ireland": { latitude: 53.3, longitude: -7.8, radiusKm: 300 },
  "tasmania-tasmania": { latitude: -42.0, longitude: 146.6, radiusKm: 280 },
  "sicily-sicilia": { latitude: 37.5, longitude: 14.2, radiusKm: 180 },
  "crete-crete": { latitude: 35.2, longitude: 24.9, radiusKm: 180 },
  "puglia-puglia": { latitude: 41.0, longitude: 16.5, radiusKm: 220 },
  "south-aegean-south-aegean": { latitude: 36.4, longitude: 25.5, radiusKm: 320 },
  "new-brunswick-new-brunswick": { latitude: 46.5, longitude: -66.2, radiusKm: 280 },
  "euskadi-euskadi": { latitude: 43.0, longitude: -2.6, radiusKm: 140 },
  "northern-rivers-new-south-wales": { latitude: -28.8, longitude: 153.3, radiusKm: 180 },
};

const DEFAULT_RADIUS_KM = 120;

function norm(value) {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function download(url, file) {
  const dest = path.join(CACHE, file);
  try {
    await readFile(dest);
    return dest;
  } catch {
    process.stdout.write(`Downloading ${url}\n`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} responded ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(dest, buf);
    return dest;
  }
}

function pointInRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersect = yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function bboxOfRing(ring) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

function preparePolygons(geojson) {
  const polygons = [];
  for (const feature of geojson.features) {
    const geometry = feature.geometry;
    const parts = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
    for (const rings of parts) {
      polygons.push({
        rings,
        bbox: bboxOfRing(rings[0]),
      });
    }
  }
  return polygons;
}

function onLand(polygons, lng, lat) {
  for (const polygon of polygons) {
    const box = polygon.bbox;
    if (lng < box.minX || lng > box.maxX || lat < box.minY || lat > box.maxY) continue;
    if (!pointInRing(lng, lat, polygon.rings[0])) continue;
    let hole = false;
    for (let h = 1; h < polygon.rings.length; h++) {
      if (pointInRing(lng, lat, polygon.rings[h])) {
        hole = true;
        break;
      }
    }
    if (!hole) return true;
  }
  return false;
}

function setBit(mask, row, col) {
  const i = row * COLS + col;
  mask[i >> 3] |= 1 << (i & 7);
}

function hasBit(mask, row, col) {
  const i = row * COLS + col;
  return (mask[i >> 3] & (1 << (i & 7))) !== 0;
}

async function loadCities(zipPath) {
  const { execFileSync } = await import("node:child_process");
  const text = execFileSync("unzip", ["-p", zipPath, "cities15000.txt"], {
    maxBuffer: 32 * 1024 * 1024,
  }).toString("utf8");

  /** @type {Map<string, Map<string, {name: string, latitude: number, longitude: number, population: number}>>} */
  const byCountry = new Map();
  const remember = (iso, name, city) => {
    const key = norm(name);
    if (!key) return;
    let bucket = byCountry.get(iso);
    if (!bucket) {
      bucket = new Map();
      byCountry.set(iso, bucket);
    }
    const existing = bucket.get(key);
    if (!existing || existing.population < city.population) bucket.set(key, city);
  };

  for (const line of text.split("\n")) {
    if (!line) continue;
    const col = line.split("\t");
    const city = {
      name: col[1],
      latitude: Number(col[4]),
      longitude: Number(col[5]),
      population: Number(col[14]) || 0,
    };
    const iso = col[8];
    remember(iso, col[1], city);
    remember(iso, col[2], city);
    if (col[3]) {
      for (const alt of col[3].split(",")) remember(iso, alt, city);
    }
  }
  return byCountry;
}

function countryIso(market) {
  if (market.city === "Hong Kong") return "HK";
  return COUNTRY_ISO[market.country] ?? null;
}

await mkdir(CACHE, { recursive: true });
await mkdir(OUT, { recursive: true });

const landPath = await download(LAND_URL, "ne_110m_land.geojson");
const citiesPath = await download(CITIES_URL, "cities15000.zip");
const land = JSON.parse(await readFile(landPath, "utf8"));
const polygons = preparePolygons(land);
const mask = Buffer.alloc(Math.ceil((ROWS * COLS) / 8));

let landCells = 0;
for (let row = 0; row < ROWS; row++) {
  for (let col = 0; col < COLS; col++) {
    const south = row - 90;
    const west = col - 180;
    const points = [
      [west + 0.5, south + 0.5],
      [west + 0.5, south + 0.08],
      [west + 0.5, south + 0.92],
      [west + 0.08, south + 0.5],
      [west + 0.92, south + 0.5],
    ];
    if (points.some(([lng, lat]) => onLand(polygons, lng, lat))) {
      setBit(mask, row, col);
      landCells++;
    }
  }
}

const cities = await loadCities(citiesPath);
const population = new Map();
for (const bucket of cities.values()) {
  for (const city of bucket.values()) {
    const row = Math.min(ROWS - 1, Math.max(0, Math.floor(city.latitude + 90)));
    const lng = Math.min(179.999, Math.max(-180, city.longitude));
    const col = Math.min(COLS - 1, Math.max(0, Math.floor(lng + 180)));
    if (!hasBit(mask, row, col)) continue;
    const key = `${row}:${col}`;
    population.set(key, Math.max(population.get(key) ?? 0, city.population));
  }
}

const markets = JSON.parse(await readFile(path.join(ROOT, "src", "data", "markets.json"), "utf8"));
const anchors = [];
const unmatched = [];

for (const market of markets) {
  const region = REGION_ANCHORS[market.slug];
  if (region) {
    anchors.push({
      slug: market.slug,
      latitude: region.latitude,
      longitude: region.longitude,
      radiusKm: region.radiusKm,
      matchedName: "region center",
    });
    continue;
  }

  const iso = countryIso(market);
  const bucket = iso ? cities.get(iso) : undefined;
  const aliases = NAME_ALIASES[market.city] ?? [market.city];
  let match = null;
  if (bucket) {
    for (const alias of [market.city, ...aliases]) {
      const found = bucket.get(norm(alias));
      if (found && (!match || found.population > match.population)) match = found;
    }
  }
  if (!match) {
    unmatched.push(`${market.slug} (${market.city}, ${market.country}, ${iso})`);
    continue;
  }
  anchors.push({
    slug: market.slug,
    latitude: match.latitude,
    longitude: match.longitude,
    radiusKm: DEFAULT_RADIUS_KM,
    matchedName: match.name,
  });
}

if (unmatched.length > 0) {
  console.error(`Unmatched markets (${unmatched.length}):`);
  for (const line of unmatched) console.error(`  ${line}`);
  process.exitCode = 1;
}

const popRows = [...population.entries()]
  .map(([key, pop]) => {
    const [row, col] = key.split(":").map(Number);
    return [row, col, pop];
  })
  .sort((a, b) => a[0] - b[0] || a[1] - b[1]);

await writeFile(path.join(OUT, "land-mask-1deg.bin"), mask);
await writeFile(path.join(OUT, "population-1deg.json"), JSON.stringify(popRows));
await writeFile(
  path.join(OUT, "market-anchors.json"),
  JSON.stringify(
    {
      defaultRadiusKm: DEFAULT_RADIUS_KM,
      note: "Approximate reservation circles. Ingested Inside Airbnb listings are the real coverage.",
      anchors,
    },
    null,
    2,
  ) + "\n",
);

console.log(
  `Land cells: ${landCells}. Populated cells: ${popRows.length}. Anchors: ${anchors.length}/${markets.length}.`,
);
