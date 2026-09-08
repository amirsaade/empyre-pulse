import type { Comparable, RoomTypeCategory } from "./airbnb-estimate";

export type Bounds = {
  north: number;
  south: number;
  east: number;
  west: number;
};

export type ScanRequest = {
  bounds: Bounds;
  /** Cells along the longer axis; the other axis is derived to keep cells square. */
  resolution: number;
  roomTypeCategory: RoomTypeCategory;
  bedrooms: number;
  currency: string;
};

export type ScanCell = {
  index: number;
  latitude: number;
  longitude: number;
  monthly: number;
  nightly: number;
  nights: number;
};

export type ScanEvent =
  | {
      type: "meta";
      total: number;
      rows: number;
      cols: number;
      cellHeight: number;
      cellWidth: number;
      currency: string;
    }
  | { type: "cell"; cell: ScanCell; comparables: Comparable[] }
  | { type: "empty"; index: number }
  | { type: "error"; index: number; message: string }
  | { type: "done"; filled: number; empty: number; failed: number; elapsedMs: number };

/** Sampling every cell of a huge area would be slow and rude to Airbnb. */
export const MAX_CELLS = 400;
export const RESOLUTION_OPTIONS = [6, 8, 10, 12, 16] as const;

export type GridPoint = {
  index: number;
  latitude: number;
  longitude: number;
};

export type Grid = {
  points: GridPoint[];
  rows: number;
  cols: number;
  cellHeight: number;
  cellWidth: number;
};

/**
 * Splits `bounds` into cells that are roughly square on the ground. Longitude
 * degrees shrink with latitude, so the column count is scaled by cos(lat).
 */
export function buildGrid(bounds: Bounds, resolution: number): Grid {
  const latSpan = Math.abs(bounds.north - bounds.south);
  const lngSpan = Math.abs(bounds.east - bounds.west);
  const midLat = (bounds.north + bounds.south) / 2;
  const lngScale = Math.max(0.1, Math.cos((midLat * Math.PI) / 180));

  const heightKm = latSpan * 111;
  const widthKm = lngSpan * 111 * lngScale;

  let rows: number;
  let cols: number;
  if (heightKm >= widthKm) {
    rows = resolution;
    cols = Math.max(2, Math.round((resolution * widthKm) / Math.max(heightKm, 1e-6)));
  } else {
    cols = resolution;
    rows = Math.max(2, Math.round((resolution * heightKm) / Math.max(widthKm, 1e-6)));
  }

  while (rows * cols > MAX_CELLS) {
    if (rows >= cols) rows--;
    else cols--;
  }

  const cellHeight = latSpan / rows;
  const cellWidth = lngSpan / cols;
  const points: GridPoint[] = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      points.push({
        index: r * cols + c,
        latitude: bounds.south + cellHeight * (r + 0.5),
        longitude: bounds.west + cellWidth * (c + 0.5),
      });
    }
  }

  return { points, rows, cols, cellHeight, cellWidth };
}

export function isValidBounds(bounds: Bounds): boolean {
  return (
    Number.isFinite(bounds.north) &&
    Number.isFinite(bounds.south) &&
    Number.isFinite(bounds.east) &&
    Number.isFinite(bounds.west) &&
    bounds.north > bounds.south &&
    bounds.east > bounds.west &&
    bounds.north <= 85 &&
    bounds.south >= -85
  );
}

/** Grows a point into a box roughly `km` across, for "search a place" scans. */
export function boundsAround(latitude: number, longitude: number, km: number): Bounds {
  const dLat = km / 2 / 111;
  const dLng = km / 2 / (111 * Math.max(0.1, Math.cos((latitude * Math.PI) / 180)));
  return {
    north: latitude + dLat,
    south: latitude - dLat,
    east: longitude + dLng,
    west: longitude - dLng,
  };
}

/** Airbnb's suggested bounds hug the comparables, so pad them out a little. */
export function padBounds(bounds: Bounds, factor = 0.35, minKm = 4): Bounds {
  const latSpan = bounds.north - bounds.south;
  const lngSpan = bounds.east - bounds.west;
  const midLat = (bounds.north + bounds.south) / 2;

  const minLat = minKm / 111;
  const minLng = minKm / (111 * Math.max(0.1, Math.cos((midLat * Math.PI) / 180)));

  const padLat = Math.max((latSpan * factor) / 2, (minLat - latSpan) / 2, 0);
  const padLng = Math.max((lngSpan * factor) / 2, (minLng - lngSpan) / 2, 0);

  return {
    north: bounds.north + padLat,
    south: bounds.south - padLat,
    east: bounds.east + padLng,
    west: bounds.west - padLng,
  };
}
