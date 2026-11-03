import { readFileSync } from "node:fs";
import path from "node:path";

/** Fixed on purpose: changing it would orphan every stored cell id. */
export const CELL_DEGREES = 1;
export const MASK_ROWS = 180;
export const MASK_COLS = 360;
export const MASK_BYTES = Math.ceil((MASK_ROWS * MASK_COLS) / 8);

export type WorldCell = {
  id: string;
  row: number;
  col: number;
  latitude: number;
  longitude: number;
};

export type MarketAnchor = {
  slug: string;
  latitude: number;
  longitude: number;
  radiusKm: number;
};

export function cellIndex(row: number, col: number): number {
  return row * MASK_COLS + col;
}

export function cellId(row: number, col: number): string {
  return `g1:${row}:${col}`;
}

export function cellCenter(row: number, col: number): { latitude: number; longitude: number } {
  return {
    latitude: row - 90 + CELL_DEGREES / 2,
    longitude: col - 180 + CELL_DEGREES / 2,
  };
}

export function cellFromLatLng(latitude: number, longitude: number): { row: number; col: number } {
  const row = Math.min(MASK_ROWS - 1, Math.max(0, Math.floor(latitude + 90)));
  const lng = Math.min(180 - 1e-9, Math.max(-180, longitude));
  const col = Math.min(MASK_COLS - 1, Math.max(0, Math.floor(lng + 180)));
  return { row, col };
}

export function worldCellAt(latitude: number, longitude: number): WorldCell {
  const { row, col } = cellFromLatLng(latitude, longitude);
  const center = cellCenter(row, col);
  return { id: cellId(row, col), row, col, ...center };
}

export function emptyMask(): Uint8Array {
  return new Uint8Array(MASK_BYTES);
}

export function setLand(mask: Uint8Array, row: number, col: number): void {
  const i = cellIndex(row, col);
  mask[i >> 3] |= 1 << (i & 7);
}

export function isLand(mask: Uint8Array, row: number, col: number): boolean {
  if (row < 0 || col < 0 || row >= MASK_ROWS || col >= MASK_COLS) return false;
  const i = cellIndex(row, col);
  return (mask[i >> 3] & (1 << (i & 7))) !== 0;
}

export function populationMap(entries: ReadonlyArray<readonly [number, number, number]>): Map<string, number> {
  const map = new Map<string, number>();
  for (const [row, col, pop] of entries) {
    const id = cellId(row, col);
    map.set(id, Math.max(map.get(id) ?? 0, pop));
  }
  return map;
}

/**
 * Land cells only, populated ones first (highest population), then a stable
 * north-to-south sweep. Oceans are absent, so the walk never requests them.
 */
export function orderLandCells(mask: Uint8Array, population: Map<string, number>): WorldCell[] {
  const cells: WorldCell[] = [];
  for (let row = 0; row < MASK_ROWS; row++) {
    for (let col = 0; col < MASK_COLS; col++) {
      if (!isLand(mask, row, col)) continue;
      const id = cellId(row, col);
      const center = cellCenter(row, col);
      cells.push({ id, row, col, latitude: center.latitude, longitude: center.longitude });
    }
  }

  cells.sort((a, b) => {
    const byPop = (population.get(b.id) ?? 0) - (population.get(a.id) ?? 0);
    if (byPop !== 0) return byPop;
    if (a.row !== b.row) return a.row - b.row;
    return a.col - b.col;
  });
  return cells;
}

export function haversineKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Slug of a not-yet-ingested market whose reservation circle contains the cell. */
export function reservedBy(cell: WorldCell, anchors: readonly MarketAnchor[]): string | null {
  for (const anchor of anchors) {
    if (haversineKm(cell.latitude, cell.longitude, anchor.latitude, anchor.longitude) <= anchor.radiusKm) {
      return anchor.slug;
    }
  }
  return null;
}

export function loadWorldGrid(root = process.cwd()): { cells: WorldCell[]; anchors: MarketAnchor[] } {
  const mask = new Uint8Array(readFileSync(path.join(root, "data", "grid", "land-mask-1deg.bin")));
  if (mask.length !== MASK_BYTES) {
    throw new Error(`Land mask is ${mask.length} bytes, expected ${MASK_BYTES}`);
  }
  const pops = JSON.parse(
    readFileSync(path.join(root, "data", "grid", "population-1deg.json"), "utf8"),
  ) as [number, number, number][];
  const file = JSON.parse(
    readFileSync(path.join(root, "data", "grid", "market-anchors.json"), "utf8"),
  ) as { anchors: MarketAnchor[] };
  return {
    cells: orderLandCells(mask, populationMap(pops)),
    anchors: file.anchors,
  };
}
