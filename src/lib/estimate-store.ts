import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SqlValue } from "node:sqlite";

import type { RoomTypeCategory } from "./airbnb-estimate";
import type {
  CollectorProgress,
  EstimateSource,
  MapEstimate,
  StoredEstimate,
} from "./estimate-record";
import { CELL_DEGREES } from "./world-grid";

export function queryKey(roomType: string, bedrooms: number, currency: string): string {
  return `${roomType}|${bedrooms}|${currency.toUpperCase()}`;
}

export function defaultStorePath(root = process.cwd()): string {
  return path.join(root, "data", "collected", "estimates.sqlite");
}

type IngestedMarket = {
  slug: string;
  fetchedAt: string;
  cellsWritten: number;
  origin: string;
  failures: number;
  status: "ok" | "failed" | "skipped";
};

type ProgressRow = Omit<CollectorProgress, "deferred"> & { deferredIndexes: number[] };

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function rowOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/**
 * Local SQLite file of gross estimates. One file, no server, no credentials.
 * Node's built-in driver keeps this off the dependency tree; it needs Node 22.
 */
export class EstimateStore {
  private readonly db: DatabaseSync;

  constructor(file = defaultStorePath()) {
    mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS estimates (
        cell_id TEXT NOT NULL,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        cell_height REAL NOT NULL,
        cell_width REAL NOT NULL,
        monthly REAL,
        nightly REAL,
        nights REAL,
        currency TEXT NOT NULL,
        room_type TEXT NOT NULL,
        bedrooms INTEGER NOT NULL,
        source TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        status TEXT NOT NULL,
        sample_size INTEGER,
        market_slug TEXT,
        PRIMARY KEY (cell_id, room_type, bedrooms, currency, source)
      );

      CREATE INDEX IF NOT EXISTS estimates_map
        ON estimates (currency, room_type, status);
      CREATE INDEX IF NOT EXISTS estimates_market
        ON estimates (source, market_slug);

      CREATE TABLE IF NOT EXISTS progress (
        query_key TEXT PRIMARY KEY,
        grid_cursor INTEGER NOT NULL,
        grid_length INTEGER NOT NULL,
        cell_degrees REAL NOT NULL,
        last_run_at TEXT,
        last_stop_reason TEXT,
        last_stop_detail TEXT,
        last_airbnb_requests INTEGER NOT NULL,
        total_airbnb_requests INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS deferred_cells (
        query_key TEXT NOT NULL,
        cell_index INTEGER NOT NULL,
        ordinal INTEGER NOT NULL,
        PRIMARY KEY (query_key, cell_index)
      );

      CREATE TABLE IF NOT EXISTS ingested_markets (
        slug TEXT PRIMARY KEY,
        fetched_at TEXT NOT NULL,
        cells_written INTEGER NOT NULL,
        origin TEXT NOT NULL,
        failures INTEGER NOT NULL,
        status TEXT NOT NULL
      );
    `);
  }

  upsert(record: StoredEstimate): void {
    this.db
      .prepare(
        `INSERT INTO estimates (
           cell_id, latitude, longitude, cell_height, cell_width,
           monthly, nightly, nights, currency, room_type, bedrooms,
           source, fetched_at, status, sample_size, market_slug
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(cell_id, room_type, bedrooms, currency, source) DO UPDATE SET
           latitude = excluded.latitude,
           longitude = excluded.longitude,
           cell_height = excluded.cell_height,
           cell_width = excluded.cell_width,
           monthly = excluded.monthly,
           nightly = excluded.nightly,
           nights = excluded.nights,
           fetched_at = excluded.fetched_at,
           status = excluded.status,
           sample_size = excluded.sample_size,
           market_slug = excluded.market_slug`,
      )
      .run(...this.recordParams(record));
  }

  /** Replace every Inside Airbnb cell for one market. Listings move between scrapes. */
  replaceMarket(slug: string, records: StoredEstimate[]): void {
    const remove = this.db.prepare(
      `DELETE FROM estimates WHERE source = 'inside-airbnb' AND market_slug = ?`,
    );
    const insert = this.db.prepare(
      `INSERT INTO estimates (
         cell_id, latitude, longitude, cell_height, cell_width,
         monthly, nightly, nights, currency, room_type, bedrooms,
         source, fetched_at, status, sample_size, market_slug
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    this.db.exec("BEGIN");
    try {
      remove.run(slug);
      for (const record of records) insert.run(...this.recordParams(record));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  airbnbFetchedAt(
    cellId: string,
    roomType: RoomTypeCategory,
    bedrooms: number,
    currency: string,
  ): string | null {
    const row = rowOf(
      this.db
        .prepare(
          `SELECT fetched_at FROM estimates
           WHERE cell_id = ? AND room_type = ? AND bedrooms = ? AND currency = ?
             AND source = 'GetHostEstimateData'`,
        )
        .get(cellId, roomType, bedrooms, currency.toUpperCase()),
    );
    return text(row?.fetched_at);
  }

  /** Fresh Inside Airbnb gross figure for this cell and room type, any currency. */
  insideFetchedAt(cellId: string, roomType: RoomTypeCategory): string | null {
    const row = rowOf(
      this.db
        .prepare(
          `SELECT fetched_at FROM estimates
           WHERE cell_id = ? AND room_type = ? AND source = 'inside-airbnb'
             AND status = 'estimate'
           ORDER BY fetched_at DESC
           LIMIT 1`,
        )
        .get(cellId, roomType),
    );
    return text(row?.fetched_at);
  }

  getMarket(slug: string): IngestedMarket | null {
    const row = rowOf(
      this.db.prepare(`SELECT * FROM ingested_markets WHERE slug = ?`).get(slug),
    );
    if (!row) return null;
    const status = text(row.status);
    if (status !== "ok" && status !== "failed" && status !== "skipped") return null;
    return {
      slug,
      fetchedAt: text(row.fetched_at) ?? "",
      cellsWritten: num(row.cells_written),
      origin: text(row.origin) ?? "",
      failures: num(row.failures),
      status,
    };
  }

  recordMarket(market: IngestedMarket): void {
    this.db
      .prepare(
        `INSERT INTO ingested_markets (slug, fetched_at, cells_written, origin, failures, status)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(slug) DO UPDATE SET
           fetched_at = excluded.fetched_at,
           cells_written = excluded.cells_written,
           origin = excluded.origin,
           failures = excluded.failures,
           status = excluded.status`,
      )
      .run(
        market.slug,
        market.fetchedAt,
        market.cellsWritten,
        market.origin,
        market.failures,
        market.status,
      );
  }

  /** Bump the failure count. Three failures and the market stops blocking the walk. */
  recordMarketFailure(slug: string, limit: number): number {
    const existing = this.getMarket(slug);
    const failures = (existing?.failures ?? 0) + 1;
    this.recordMarket({
      slug,
      fetchedAt: existing?.fetchedAt ?? new Date().toISOString(),
      cellsWritten: existing?.cellsWritten ?? 0,
      origin: existing?.origin ?? "network",
      failures,
      status: failures >= limit ? "skipped" : "failed",
    });
    return failures;
  }

  getProgress(key: string): ProgressRow | null {
    const row = rowOf(this.db.prepare(`SELECT * FROM progress WHERE query_key = ?`).get(key));
    if (!row) return null;
    const indexes = this.db
      .prepare(
        `SELECT cell_index FROM deferred_cells WHERE query_key = ? ORDER BY ordinal`,
      )
      .all(key)
      .map((item) => num(rowOf(item)?.cell_index));
    return {
      queryKey: key,
      gridCursor: num(row.grid_cursor),
      gridLength: num(row.grid_length),
      cellDegrees: num(row.cell_degrees, CELL_DEGREES),
      lastRunAt: text(row.last_run_at),
      lastStopReason: text(row.last_stop_reason),
      lastStopDetail: text(row.last_stop_detail),
      lastAirbnbRequests: num(row.last_airbnb_requests),
      totalAirbnbRequests: num(row.total_airbnb_requests),
      updatedAt: text(row.updated_at) ?? "",
      deferredIndexes: indexes,
    };
  }

  latestProgress(): CollectorProgress | null {
    const row = rowOf(
      this.db.prepare(`SELECT query_key FROM progress ORDER BY updated_at DESC LIMIT 1`).get(),
    );
    const key = text(row?.query_key);
    if (!key) return null;
    const progress = this.getProgress(key);
    if (!progress) return null;
    return {
      queryKey: progress.queryKey,
      gridCursor: progress.gridCursor,
      gridLength: progress.gridLength,
      cellDegrees: progress.cellDegrees,
      lastRunAt: progress.lastRunAt,
      lastStopReason: progress.lastStopReason,
      lastStopDetail: progress.lastStopDetail,
      lastAirbnbRequests: progress.lastAirbnbRequests,
      totalAirbnbRequests: progress.totalAirbnbRequests,
      deferred: progress.deferredIndexes.length,
      updatedAt: progress.updatedAt,
    };
  }

  saveRun(
    progress: Omit<CollectorProgress, "deferred">,
    deferredIndexes: readonly number[],
  ): void {
    const insert = this.db.prepare(
      `INSERT INTO progress (
         query_key, grid_cursor, grid_length, cell_degrees, last_run_at,
         last_stop_reason, last_stop_detail, last_airbnb_requests,
         total_airbnb_requests, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(query_key) DO UPDATE SET
         grid_cursor = excluded.grid_cursor,
         grid_length = excluded.grid_length,
         cell_degrees = excluded.cell_degrees,
         last_run_at = excluded.last_run_at,
         last_stop_reason = excluded.last_stop_reason,
         last_stop_detail = excluded.last_stop_detail,
         last_airbnb_requests = excluded.last_airbnb_requests,
         total_airbnb_requests = excluded.total_airbnb_requests,
         updated_at = excluded.updated_at`,
    );
    const clear = this.db.prepare(`DELETE FROM deferred_cells WHERE query_key = ?`);
    const add = this.db.prepare(
      `INSERT INTO deferred_cells (query_key, cell_index, ordinal) VALUES (?, ?, ?)`,
    );

    this.db.exec("BEGIN");
    try {
      insert.run(
        progress.queryKey,
        progress.gridCursor,
        progress.gridLength,
        progress.cellDegrees,
        progress.lastRunAt,
        progress.lastStopReason,
        progress.lastStopDetail,
        progress.lastAirbnbRequests,
        progress.totalAirbnbRequests,
        progress.updatedAt,
      );
      clear.run(progress.queryKey);
      deferredIndexes.forEach((index, ordinal) => add.run(progress.queryKey, index, ordinal));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  currencies(): { currency: string; count: number }[] {
    return this.db
      .prepare(
        `SELECT currency, COUNT(*) AS n FROM estimates
         WHERE status = 'estimate' AND monthly IS NOT NULL
         GROUP BY currency
         ORDER BY n DESC, currency`,
      )
      .all()
      .map((item) => {
        const row = rowOf(item);
        return { currency: text(row?.currency) ?? "USD", count: num(row?.n) };
      });
  }

  sourceCounts(currency: string, roomType: string): { source: EstimateSource; count: number }[] {
    return this.db
      .prepare(
        `SELECT source, COUNT(*) AS n FROM estimates
         WHERE status = 'estimate' AND monthly IS NOT NULL
           AND currency = ? AND room_type = ?
         GROUP BY source`,
      )
      .all(currency.toUpperCase(), roomType)
      .flatMap((item) => {
        const row = rowOf(item);
        const source = text(row?.source);
        if (source !== "inside-airbnb" && source !== "GetHostEstimateData") return [];
        return [{ source, count: num(row?.n) }];
      });
  }

  /**
   * Cells to draw. One polygon per cell id: an Inside Airbnb figure wins over
   * a GetHostEstimateData sample of the same cell when both are in this currency.
   */
  mapCells(currency: string, roomType: string): MapEstimate[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM estimates
         WHERE status = 'estimate' AND monthly IS NOT NULL
           AND currency = ? AND room_type = ?`,
      )
      .all(currency.toUpperCase(), roomType);

    const byCell = new Map<string, MapEstimate>();
    for (const item of rows) {
      const mapped = this.toMap(item);
      if (!mapped) continue;
      const existing = byCell.get(mapped.cellId);
      if (!existing || prefer(mapped, existing)) byCell.set(mapped.cellId, mapped);
    }

    return [...byCell.values()].sort((a, b) => {
      const area = b.cellHeight * b.cellWidth - a.cellHeight * a.cellWidth;
      if (area !== 0) return area;
      return b.monthly - a.monthly;
    });
  }

  close(): void {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.db.close();
  }

  private recordParams(record: StoredEstimate): SqlValue[] {
    return [
      record.cellId,
      record.latitude,
      record.longitude,
      record.cellHeight,
      record.cellWidth,
      record.monthly,
      record.nightly,
      record.nights,
      record.currency.toUpperCase(),
      record.roomType,
      record.bedrooms,
      record.source,
      record.fetchedAt,
      record.status,
      record.sampleSize,
      record.marketSlug,
    ];
  }

  private toMap(value: unknown): MapEstimate | null {
    const row = rowOf(value);
    if (!row) return null;
    const monthly = numOrNull(row.monthly);
    const nightly = numOrNull(row.nightly);
    const nights = numOrNull(row.nights);
    const source = text(row.source);
    const roomType = text(row.room_type);
    if (
      monthly === null ||
      nightly === null ||
      nights === null ||
      (source !== "inside-airbnb" && source !== "GetHostEstimateData") ||
      (roomType !== "ENTIRE_HOME" && roomType !== "PRIVATE_ROOM")
    ) {
      return null;
    }
    return {
      cellId: text(row.cell_id) ?? "",
      latitude: num(row.latitude),
      longitude: num(row.longitude),
      cellHeight: num(row.cell_height),
      cellWidth: num(row.cell_width),
      monthly,
      nightly,
      nights,
      currency: text(row.currency) ?? "USD",
      roomType,
      bedrooms: num(row.bedrooms),
      source,
      fetchedAt: text(row.fetched_at) ?? "",
      sampleSize: numOrNull(row.sample_size),
      marketSlug: text(row.market_slug),
    };
  }
}

function prefer(next: MapEstimate, current: MapEstimate): boolean {
  if (next.source === "inside-airbnb" && current.source !== "inside-airbnb") return true;
  if (current.source === "inside-airbnb") return false;
  return next.fetchedAt > current.fetchedAt;
}

const globalStore = globalThis as unknown as { __empyreEstimateStore?: EstimateStore };

export function getStore(): EstimateStore {
  if (!globalStore.__empyreEstimateStore) {
    globalStore.__empyreEstimateStore = new EstimateStore();
  }
  return globalStore.__empyreEstimateStore;
}

/** Live scans keep the 400-cell / concurrency-8 cap. Persistence must not change that. */
export function persistScanEstimate(input: {
  latitude: number;
  longitude: number;
  cellHeight: number;
  cellWidth: number;
  monthly: number;
  nightly: number;
  nights: number;
  currency: string;
  roomType: RoomTypeCategory;
  bedrooms: number;
}): void {
  try {
    getStore().upsert({
      cellId: `scan:${input.latitude.toFixed(4)}:${input.longitude.toFixed(4)}`,
      latitude: input.latitude,
      longitude: input.longitude,
      cellHeight: input.cellHeight,
      cellWidth: input.cellWidth,
      monthly: input.monthly,
      nightly: input.nightly,
      nights: input.nights,
      currency: input.currency,
      roomType: input.roomType,
      bedrooms: input.bedrooms,
      source: "GetHostEstimateData",
      fetchedAt: new Date().toISOString(),
      status: "estimate",
      sampleSize: null,
      marketSlug: null,
    });
  } catch (error) {
    console.error(
      "Could not persist scan estimate",
      error instanceof Error ? error.message : error,
    );
  }
}
