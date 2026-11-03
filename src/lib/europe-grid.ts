/**
 * Europe at 0.5°: land cells only. Oceans are not part of the sweep.
 *
 * The land mask is Natural Earth 1:110m (public domain), bundled in
 * src/data/europe-land.json. No geocoding service is called.
 */

import landJson from "@/data/europe-land.json";
import citiesJson from "@/data/europe-market-cities.json";

export const GRID_STEP = 0.5;
export const EUROPE_BOUNDS = {
  south: 34,
  north: 72,
  west: -25,
  east: 40,
} as const;

/** A cell this close to an Inside Airbnb market city is treated as populated. */
export const POPULATED_RADIUS_KM = 80;

export type EuropeCell = {
  cellId: string;
  latitude: number;
  longitude: number;
  /**
   * 0 = local Inside Airbnb listings, 1 = inside a local market with no
   * usable sample, 2 = near a catalogued market city, 3 = other land.
   */
  priority: number;
  listingCount: number;
  cityDistanceKm: number;
};

export type MarketCity = {
  slug: string;
  city: string;
  latitude: number;
  longitude: number;
};

type Ring = number[][];
type Polygon = Ring[];

type PreparedPolygon = {
  rings: Polygon;
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
};

const cities = citiesJson as MarketCity[];
const prepared = preparePolygons((landJson as { polygons: Polygon[] }).polygons);

export function marketCities(): readonly MarketCity[] {
  return cities;
}

export function formatCoord(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return (rounded === 0 ? 0 : rounded).toFixed(1);
}

export function formatCellId(latitude: number, longitude: number): string {
  return `${formatCoord(latitude)},${formatCoord(longitude)}`;
}

/** Nearest 0.5° grid center. */
export function snapToGrid(value: number): number {
  return Math.round(value * 2) / 2;
}

export function pointInLand(longitude: number, latitude: number): boolean {
  for (const polygon of prepared) {
    if (
      longitude < polygon.minLng ||
      longitude > polygon.maxLng ||
      latitude < polygon.minLat ||
      latitude > polygon.maxLat
    ) {
      continue;
    }
    if (!pointInRing(longitude, latitude, polygon.rings[0])) continue;
    let inHole = false;
    for (let hole = 1; hole < polygon.rings.length; hole += 1) {
      if (pointInRing(longitude, latitude, polygon.rings[hole])) {
        inHole = true;
        break;
      }
    }
    if (!inHole) return true;
  }
  return false;
}

export function cellIsLand(latitude: number, longitude: number): boolean {
  if (pointInLand(longitude, latitude)) return true;
  const offset = GRID_STEP * 0.4;
  return (
    pointInLand(longitude + offset, latitude) ||
    pointInLand(longitude - offset, latitude) ||
    pointInLand(longitude, latitude + offset) ||
    pointInLand(longitude, latitude - offset)
  );
}

export type EuropeGrid = {
  candidates: number;
  cells: EuropeCell[];
};

/** Land cells in geographic order. Coverage priority is applied separately. */
export function buildLandGrid(): EuropeGrid {
  const cells: EuropeCell[] = [];
  let candidates = 0;
  for (
    let latitude = EUROPE_BOUNDS.south + GRID_STEP;
    latitude < EUROPE_BOUNDS.north;
    latitude += GRID_STEP
  ) {
    for (
      let longitude = EUROPE_BOUNDS.west + GRID_STEP;
      longitude < EUROPE_BOUNDS.east;
      longitude += GRID_STEP
    ) {
      candidates += 1;
      const lat = snapToGrid(latitude);
      const lng = snapToGrid(longitude);
      if (!cellIsLand(lat, lng)) continue;
      cells.push({
        cellId: formatCellId(lat, lng),
        latitude: lat,
        longitude: lng,
        priority: 3,
        listingCount: 0,
        cityDistanceKm: nearestCityKm(lat, lng),
      });
    }
  }
  return { candidates, cells };
}

export function orderCells(cells: readonly EuropeCell[]): EuropeCell[] {
  return [...cells].sort(
    (a, b) =>
      a.priority - b.priority ||
      b.listingCount - a.listingCount ||
      a.cityDistanceKm - b.cityDistanceKm ||
      a.cellId.localeCompare(b.cellId),
  );
}

function nearestCityKm(latitude: number, longitude: number): number {
  let best = Number.POSITIVE_INFINITY;
  for (const city of cities) {
    const distance = haversineKm(latitude, longitude, city.latitude, city.longitude);
    if (distance < best) best = distance;
  }
  return best;
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

function preparePolygons(polygons: Polygon[]): PreparedPolygon[] {
  return polygons.map((rings) => {
    let minLng = Number.POSITIVE_INFINITY;
    let minLat = Number.POSITIVE_INFINITY;
    let maxLng = Number.NEGATIVE_INFINITY;
    let maxLat = Number.NEGATIVE_INFINITY;
    for (const [lng, lat] of rings[0]) {
      minLng = Math.min(minLng, lng);
      maxLng = Math.max(maxLng, lng);
      minLat = Math.min(minLat, lat);
      maxLat = Math.max(maxLat, lat);
    }
    return { rings, minLng, minLat, maxLng, maxLat };
  });
}

function pointInRing(longitude: number, latitude: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const crosses = yi > latitude !== yj > latitude;
    if (!crosses) continue;
    const xCross = ((xj - xi) * (latitude - yi)) / (yj - yi) + xi;
    if (longitude < xCross) inside = !inside;
  }
  return inside;
}
